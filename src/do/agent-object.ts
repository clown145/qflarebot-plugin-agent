/**
 * 每个会话一个 Durable Object：**只做会话串行化、run 队列与会话历史**。
 *
 * ## 为什么 DO 不跑 agent loop
 *
 * 写这一版时先试过「DO 里跑 loop」的方案，行不通，原因有两层：
 *
 * 1. **DO 是独立 isolate**。Worker 侧无法把执行函数注入进去——`setExecutor()` 那种写法
 *    只在同一个 isolate 内有效，而 DO 实例活在另一个 isolate 里，跨不过去。
 * 2. **DO 里拿不到 `ctx.service()`**。`DurableContext` 只有 `{plugin, logger, kv, db, r2, api}`，
 *    没有 `service`。而 agent loop 要调 plugin-llm 的 `llm` 服务——那是 `PluginContext` 才有的能力。
 *
 * 所以分工是：
 *
 * - **DO（这里）**：串行化锁、run 队列、会话历史。全是持久化状态，不需要外部能力。
 * - **Worker 处理器 / cron**：真正跑 loop。两处都有完整的 `ctx`（含 `service` 与 `api`）。
 *
 * ## 为什么用 DO 而不是 D1 队列
 *
 * 用 D1 的 CAS（`UPDATE ... WHERE locked_until < ?`）也能做串行化，但额度消耗是灾难性的：
 * 每次认领、每次状态推进、每次读历史都要打 D1，而 D1 免费版只有 10 万行写/日、
 * 且是全机器人所有插件共享的池子。
 *
 * DO 按 **GB-秒**计费（128 MB × 墙上时间）：一次 8 秒的对话 ≈ 1 GB-s，
 * 免费版 13,000 GB-s/日能撑上万次。状态放 DO 的 SQLite storage 后，
 * 逐步状态不占 D1 额度；跨会话恢复索引单独登记到 D1。
 *
 * ## 串行化语义
 *
 * 同一个会话同一时刻只有一个执行者：`acquire()` 抢到租约才能跑，跑完 `release()`。
 * 抢不到的进 `pending` 队列，由 cron 兜底捡起来。
 */

import { PluginDurableObject } from '@qqbot/sdk'
import type { StoredSummary } from '../agent/context-size.js'
import type { InboundMessage, MessageAttachment, RunRecord, RunStatus } from '../types.js'
import { readValue, writeValue, deleteValue, type Storage } from './large-value.js'
import { historySummary } from '../agent/history.js'
import type { LoopCheckpoint } from '../agent/loop.js'

/**
 * 待摘要的一条消息。
 *
 * 不用 `ModelMessage`：那个类型来自 Worker 侧的 agent 模块，DO 只该存纯数据，
 * 而且 `ModelContent` 的联合类型（含图片 base64）塞进 DO storage 会白白撑大体积。
 * 摘要只需要 role 与文本。
 */
export interface SummaryInput {
  id?: string
  role: 'user' | 'assistant'
  content: string
}

export interface SummaryBatch {
  messages: SummaryInput[]
  coveredMessages: number
  token?: string
  expiresAt?: number
}

/** 租约时长。执行者挂了之后，租约到期可以被别人接管 */
export const LEASE_MS = 90_000

/** 一次 run 最多尝试几次 */
export const MAX_ATTEMPTS = 3

/**
 * 会话历史最多留多少条（超出时从旧的开始删，防止 DO storage 无限增长）。
 *
 * **必须 >= `history_limit` 的配置上限**（`config/index.ts` 里是 100），否则
 * 用户把「会话历史条数」调大就是静默失效——改之前是 60 条，配置调到 61–100 时
 * 表里只剩 60 条，而且没有任何地方会报错。`history()` 只按 `limit` 取最近的 N 条，
 * 被裁掉的那部分**永远补不回来**，等于用户改了设置却不生效。
 *
 * 也不能删掉这个上限：DO storage 没有 TTL，一个长期活跃的群会把历史攒到无限大。
 * 所以取 120 = 配置上限 100 + 20 条余量：余量是为了让「配置刚上调、旧行还没被
 * 下一次写入裁掉」的窗口期里仍有富余，不用每次调大限额都先写满一轮才够用。
 *
 * 改这两个值时要一起改：`config/index.ts` 的 `history_limit.maximum`。
 */
const MAX_HISTORY_ROWS = 120

export interface HistoryRow {
  id?: string
  userId?: string
  userName?: string
  messageId?: string
  attachments?: MessageAttachment[]
  role: 'user' | 'assistant'
  content: string
  /** assistant 的原始推理内容；可选以兼容已有历史，回填时保留空字符串。 */
  reasoning?: string
  /** assistant 消息带的工具调用（JSON 字符串），回放历史时要还原 */
  toolCallsJson: string | null
  createdAt: number
}

export interface AcquireResult {
  /** 是否抢到执行权 */
  acquired: boolean
  runId?: string
  leaseId?: string
  /** 抢到时带出的入站消息，省一次读 */
  message?: InboundMessage
  /** 没抢到时：当前租约还有多久过期（毫秒），用来决定 cron 什么时候再来 */
  retryAfterMs?: number
  /**
   * 被频率限制拒绝。调用方应告知用户，而不是静默丢弃。
   *
   * 只在 `submit()` 里出现（`claim()` 内部使用时不产生这个字段）。
   */
  rateLimited?: { retryAfterMs: number }
}

/**
 * 频率限制的固定窗口。
 *
 * 对标 AstrBot 的 `RateLimitStage`（`rate_limit_check/stage.py:43-89`）：
 * 按会话、按时间窗口滚动计数，超限就拒绝。
 *
 * ## 为什么不放 KV / D1
 *
 * 这是**每条消息都要读写一次**的热路径。免费版 KV 写只有 1,000 次/日、
 * D1 写 10 万行/日（全机器人共享），把热路径放上去会直接打满额度。
 * DO storage 按 GB-秒计费，而这里本来每条消息就要唤醒 DO 一次，
 * 计数只是顺带读写的一个小 key —— **零额外额度**。
 *
 * ## 为什么是「固定窗口」而不是滑动窗口
 *
 * 滑动窗口要存时间戳数组，读写量随次数增长；固定窗口只存一个计数 + 窗口起点。
 * AstrBot 用的是 deque + 逐个清理过期时间戳，那在常驻进程里无所谓，
 * 在这里是每条消息一次额外读。
 */
interface RateWindow {
  /** 窗口起点（毫秒，已按窗口长度取整） */
  windowStart: number
  /** 本窗口内已消耗的次数 */
  count: number
}

export interface RateLimitConfig {
  /** 每分钟最多几次；0 = 不限 */
  perMinute: number
}

export class Agent extends PluginDurableObject {
  // ------------------------------------------------------------ 入队与认领

  /**
   * 入队一个 run 并尝试立刻认领。
   *
   * 返回 `acquired: true` 表示调用方拿到了执行权，应执行返回的 message（可能是更早入队的消息）；
   * `acquired: false` 表示这个会话已经有人在跑，run 进了队列，等 cron 兜底。
   */
  async submit(message: InboundMessage, rateLimit?: RateLimitConfig): Promise<AcquireResult> {
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now()

      // 频率限制在入队**之前**判定：被限的 run 不该进队列，
      // 否则用户等一会儿会突然收到一批过期回复。
      if (rateLimit && rateLimit.perMinute > 0) {
        const limited = await this.consumeRateWindow(now, rateLimit.perMinute, storage)
        if (limited) return limited
      }

      const runId = crypto.randomUUID()

      const run: RunRecord = {
        id: runId,
        conversation: message.conversation,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        inputJson: JSON.stringify(message).length <= 16_384 ? JSON.stringify(message) : '',
        steps: 0,
      }

      if (!run.inputJson) {
        await writeValue(storage, `input:${runId}`, message)
      }
      await storage.put(`run:${runId}`, run)
      await storage.put(queueKey(await nextSequence(storage), runId), runId)

      return this.claim(now, storage)
    })
  }

  /**
   * cron 兜底：捡一个待跑的 run 并认领。
   *
   * 返回 `null` 表示没活干（或都被别人占着）。
   */
  async poll(): Promise<AcquireResult> {
    return this.ctx.storage.transaction(async storage => {
      return this.claim(Date.now(), storage)
    })
  }

  /**
   * 消耗一次频率窗口配额。
   *
   * 返回 `null` = 放行；返回非 null = 被限，直接作为 `submit()` 的结果返回。
   *
   * 窗口按「分钟」对齐（`floor(now / 60000)`），所以窗口边界是墙钟整分钟，
   * 不是「用户第一次发消息起算的 60 秒」。这是固定窗口的固有特性：
   * 最坏情况用户可以在窗口交界处短时间内连发 2×N 次。对「防刷屏」这个目的足够，
   * 而滑动窗口要多存 N 个时间戳，不值得。
   */
  private async consumeRateWindow(
    now: number,
    perMinute: number,
    storage: Storage,
  ): Promise<AcquireResult | null> {
    const WINDOW_MS = 60_000
    const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS
    const stored = await storage.get<RateWindow>('rate')

    // 换窗口了就重置。旧窗口的计数没有保留价值——
    // 固定窗口不需要历史，这也是它比滑动窗口省的地方
    const current: RateWindow =
      stored && stored.windowStart === windowStart
        ? stored
        : { windowStart, count: 0 }

    if (current.count >= perMinute) {
      return {
        acquired: false,
        rateLimited: { retryAfterMs: windowStart + WINDOW_MS - now },
      }
    }

    // 计数写回。注意这是**每次 submit 一次写**，但 DO storage 的写不进 D1/KV 额度，
    // 且本来 claim() 就要写 lock/run/queue，这里只是多一个 key
    await storage.put('rate', { windowStart, count: current.count + 1 } satisfies RateWindow)
    return null
  }

  /**
   * 认领：先看有没有过期租约（前一个执行者挂了），再按 FIFO 取 pending。
   */
  private async claim(now: number, storage: Storage = this.ctx.storage): Promise<AcquireResult> {
    const lock = await storage.get<{ runId: string; expiresAt: number }>('lock')

    if (lock && lock.expiresAt > now) {
      return { acquired: false, retryAfterMs: lock.expiresAt - now }
    }

    // 租约过期：把那个 run 退回 pending（尝试次数已经在上次认领时加过）
    if (lock) {
      const stale = await storage.get<RunRecord>(`run:${lock.runId}`)
      if (stale && stale.status === 'running') {
        await storage.put(`run:${stale.id}`, {
          ...stale,
          status: 'pending',
          lockedUntil: undefined,
          updatedAt: now,
        } satisfies RunRecord)
        await storage.put(
          `queue:0000000000000000:${stale.id}`,
          stale.id,
        )
      }
      await storage.delete('lock')
    }

    const queue = await storage.list<string>({ prefix: 'queue:', limit: 20 })
    if (queue.size === 0) return { acquired: false }

    for (const [key, runId] of [...queue.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const run = await storage.get<RunRecord>(`run:${runId}`)
      await storage.delete(key)

      if (!run || run.status !== 'pending') continue

      if (run.attempts >= MAX_ATTEMPTS) {
        await storage.put(`run:${run.id}`, {
          ...run,
          status: 'failed',
          error: `超过最大重试次数（${MAX_ATTEMPTS}）`,
          updatedAt: now,
        } satisfies RunRecord)
        continue
      }

      const leaseId = crypto.randomUUID()
      const claimed: RunRecord = {
        ...run,
        status: 'running',
        attempts: run.attempts + 1,
        leaseId,
        lockedUntil: now + LEASE_MS,
        updatedAt: now,
      }
      await storage.put(`run:${run.id}`, claimed)
      await storage.put('lock', { runId: run.id, leaseId, expiresAt: now + LEASE_MS })

      return {
        acquired: true,
        runId: run.id,
        leaseId,
        message: run.inputJson ? JSON.parse(run.inputJson) as InboundMessage : await readValue<InboundMessage>(storage, `input:${run.id}`),
      }
    }

    return { acquired: false }
  }

  // ------------------------------------------------------------ 执行完的收尾

  /**
   * 释放执行权并记录结果。
   *
   * `history` 是这一轮产生的对话消息，一次性写进去（不逐条打往返）。
   */
  async release(
    runId: string,
    result: { ok: boolean; error?: string; history?: HistoryRow[]; claimNext?: boolean; leaseId?: string },
  ): Promise<AcquireResult> {
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now()
      const run = await storage.get<RunRecord>(`run:${runId}`)

      // 被取消的 run **保留 cancelled 状态**。
      //
      // 执行流被 `/stop` 打断后仍会走一次 `release()` 收尾（否则锁永远不释放）。
      // 如果这里无条件改写成 failed/completed，那个「用户主动取消」的事实就丢了：
      // 排障时看起来像一次执行失败，`prune` 的 cancelled 分支也永远走不到。
      if (result.leaseId && run?.leaseId !== result.leaseId) return { acquired: false }
      if (run?.status === 'completed' || run?.status === 'failed') return { acquired: false }
      const cancelled = run?.status === 'cancelled'
      if (run) {
        await storage.put(`run:${runId}`, {
          ...run,
          status: cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed',
          error: result.error,
          lockedUntil: undefined,
          updatedAt: now,
        } satisfies RunRecord)
      }

      // 被 `/agent reset` / `/stop` 取消的 run 不写历史：用户明确清了记忆，
      // 这一轮是旧上下文的产物。队列里被取消的 run 同样不再执行（claim 只认 pending）。
      if (!cancelled && result.history?.length) {
        await this.appendHistory(result.history, storage)
      }

      // **只删自己的锁**。
      //
      // 以前无条件 `delete('lock')`：执行者 A 的租约过期后 B 接手同一个 run（甚至
      // 新 run）拿到了锁，A 跑完收尾时把 B 的锁删掉——于是同会话可以并发执行，
      // 串行化保证直接失效，用户收到两条回复且历史交错。
      await this.releaseLockIfOwned(runId, storage)

      // 队列里还有活就立刻认领下一个并返回给调用方——调用方（事件处理器）
      // 可以接着跑，不必等 cron。
      //
      // 这是「不需要定期唤醒」的关键：上一版跑完就撒手，队列里的 run 只能靠
      // cron 每分钟轮询捡，而 DO 按 GB-秒计费，空转唤醒是纯浪费。
      // 调用方没有继续执行的预算时，下一条保持 pending，不能先认领再丢下。
      return result.claimNext === false ? { acquired: false } : this.claim(now, storage)
    })
  }

  /**
   * 续租：把锁与 run 的 `lockedUntil/expiresAt` 往后推一个 `LEASE_MS`。
   *
   * 为什么必须做：单次 run 的最坏耗时是 `max_model_steps`（默认 8）×
   * `request_timeout_ms`（默认 20 秒）= 160 秒，而 `LEASE_MS` 只有 90 秒。
   * 也就是说**正常的长回答必然超租约**：锁过期 → `claim()` 认为执行者死了 →
   * 把同一个 run 退回 pending 并重新认领 → 两个执行者跑同一轮，
   * 用户收到两条回复、历史写两遍。
   *
   * 返回 false 表示锁已经不属于这个 run（被 reset / 被他人接管），
   * 调用方必须停止执行，避免与新的租约持有者重复操作。
   */
  async renewLease(runId: string, leaseId?: string): Promise<boolean> {
    return this.ctx.storage.transaction(async storage => {
      const lock = await storage.get<{ runId: string; leaseId?: string; expiresAt: number }>('lock')
      if (!lock || lock.runId !== runId || (leaseId && lock.leaseId !== leaseId)) return false

      const now = Date.now()
      const expiresAt = now + LEASE_MS
      const run = await storage.get<RunRecord>(`run:${runId}`)
      // run 已不在 running（被取消/被清理）时只续锁没有意义，如实返回 false
      if (!run || run.status !== 'running') return false
      await storage.put('lock', { ...lock, expiresAt })
      await storage.put(`run:${runId}`, {
        ...run,
        lockedUntil: expiresAt,
        updatedAt: now,
      } satisfies RunRecord)
      return true
    })
  }

  /**
   * 读一个 run 的状态。执行流用它做**跨 isolate 的取消判定**
   * （`/stop` 打在 DO 里，跑 loop 的 Worker 只能按步轮询这里）。
   *
   * run 不存在（已被 prune 掉）返回 null，调用方按「未取消」处理。
   */
  async runStatus(runId: string): Promise<RunStatus | null> {
    const run = await this.ctx.storage.get<RunRecord>(`run:${runId}`)
    return run?.status ?? null
  }

  /**
   * 只在自己持有锁时删锁。
   *
   * 竞态的形态：执行者 A 的租约过期 → B 认领下一个 run 并写入自己的锁 →
   * A 这时才跑完收尾。无条件删锁会让 B 的锁消失，同会话立刻可以并发执行。
   */
  private async releaseLockIfOwned(runId: string, storage: Storage = this.ctx.storage): Promise<void> {
    const lock = await storage.get<{ runId: string }>('lock')
    if (!lock) return
    if (lock.runId !== runId) return
    await storage.delete('lock')
  }

  /**
   * 把尚未开始执行的 run 退回队列（例如 llm 服务尚不可用）。
   * 已执行过模型/工具的 run 不能用它整轮重试，以免重复副作用。
   *
   * 与 `release` 的区别：不写历史、状态回 pending、保留 attempts 计数。
   */
  async retryLater(runId: string, reason: string): Promise<AcquireResult> {
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now()
      const run = await storage.get<RunRecord>(`run:${runId}`)

      if (run) {
        await storage.put(`run:${runId}`, {
          ...run,
          status: 'pending',
          error: reason,
          lockedUntil: undefined,
          updatedAt: now,
        } satisfies RunRecord)
        await storage.put(queueKey(await nextSequence(storage), run.id), run.id)
      }

      await this.releaseLockIfOwned(runId, storage)

      // **不立刻重新认领**：退回的 run 会马上被捡回来，等于无限重试，
      // 而上游限流这类错误需要等一会儿再试。交给 cron 或下一次用户消息触发。
      return { acquired: false }
    })
  }

  // ------------------------------------------------------------ 历史

  async history(limit: number, summarize?: boolean): Promise<HistoryRow[]> {
    return this.ctx.storage.transaction(async storage => {
      if (summarize !== undefined) await storage.put('meta:summarize', summarize)
      const all = await storage.list({ prefix: 'msg:' })
      const summary = await storage.get<StoredSummary>('summary')
      const keys = [...all.keys()].sort().filter(key => !summarize || !summary?.coveredThrough || key > summary.coveredThrough)
      const keep = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0
      let split = Math.max(0, keys.length - keep)
      // 条数上限可能切在一轮中间。把孤立的 assistant 一起交给摘要，
      // 避免后面的 fixMessages 丢掉它、摘要游标又越过这条记录。
      if (summarize) {
        while (split < keys.length) {
          const first = await readValue<HistoryRow>(storage, keys[split]!)
          if (first?.role !== 'assistant') break
          split++
        }
      }
      if (summarize) {
        const dropped: SummaryInput[] = []
        const stagedThrough = await storage.get<string>('summary:stagedThrough')
        for (const key of keys.slice(0, split)) {
          if (stagedThrough && key <= stagedThrough) continue
          const row = await readValue<HistoryRow>(storage, key)
          if (row) dropped.push(historySummary({ ...row, id: key }))
        }
        await this.stageSummaryInStorage(storage, dropped)
      }
      // 只还原需要的行；被裁掉的图片不应全部驻留在 Worker 内存里。
      const rows: HistoryRow[] = []
      for (const key of keys.slice(split)) {
        const row = await readValue<HistoryRow>(storage, key)
        if (row) rows.push({ ...row, id: key })
      }
      return rows
    })
  }

  /**
   * 清空会话（`/agent reset`）。
   *
   * 三件事一起做，缺一个就不是「清空」：
   *
   * 1. **打断正在跑的 run**：AstrBot 的 `/reset` 会先 `stop_all(umo)` 再清历史。
   *    不打断的话，那个 run 跑完照样 `release()` 把这一轮写回历史，记忆又长回来——
   *    用户看到「已清空」之后聊一句，上下文却还在。
   * 2. **清空待跑队列**：队列里的都是「清空前」发出的消息，清空之后不该再执行
   *    （否则用户清完记忆，几秒后又收到一条回复，内容还是按旧上下文生成的）。
   * 3. 最后才删历史。
   */
  async reset(): Promise<void> {
    return this.ctx.storage.transaction(async storage => {
      // 1) 打断：把正在跑的那个 run 标成已取消，`release()` 见到 cancelled 就跳过写历史
      const lock = await storage.get<{ runId: string }>('lock')
      if (lock) {
        const run = await storage.get<RunRecord>(`run:${lock.runId}`)
        if (run && run.status === 'running') {
          await storage.put(`run:${lock.runId}`, {
            ...run,
            status: 'cancelled',
            lockedUntil: undefined,
            updatedAt: Date.now(),
          } satisfies RunRecord)
        }
        await storage.delete('lock')
      }

      // 2) 清队列
      const queued = await storage.list<string>({ prefix: 'queue:' })
      for (const key of queued.keys()) await storage.delete(key)
      // 队列里对应的 run 记录也标成取消，避免留下 pending 的孤儿
      const runs = await storage.list<RunRecord>({ prefix: 'run:' })
      const cancelled: Record<string, RunRecord> = {}
      for (const [key, run] of runs) {
        if (run.status === 'pending') {
          cancelled[key] = { ...run, status: 'cancelled', updatedAt: Date.now() }
        }
      }
      for (const [key, run] of Object.entries(cancelled)) await storage.put(key, run)

      // 3) 删历史
      const all = await storage.list({ prefix: 'msg:' })
      for (const key of all.keys()) await deleteValue(storage, key)

      // 4) 摘要也一起清。不清的话 `/reset` 之后第一句话就带着旧记忆，
      //    比完全不支持摘要更糟——用户以为清空、实际没清。
      await storage.delete('summary')
      await deleteValue(storage, 'summary:pending')
      await deleteValue(storage, 'summary:inflight')
      await storage.delete('summary:stagedThrough')
      for (const key of (await storage.list({ prefix: 'checkpoint:' })).keys()) await deleteValue(storage, key)
    })
  }

  // ------------------------------------------------------------ 摘要（summary 压缩模式）

  /**
   * 取会话摘要。没有就返回 null。
   *
   * 单独一个键而不是塞进历史：摘要是**低频变化、每轮都要读**的数据，
   * 和历史行的生命周期不同（历史会被 `history_limit` 截断，摘要不该跟着被截）。
   */
  async summary(): Promise<StoredSummary | null> {
    return (await this.ctx.storage.get<StoredSummary>('summary')) ?? null
  }

  /**
   * 登记「这批轮次被丢掉了，等摘要」。
   *
   * 由 loop 在压缩发生后调用。**只登记、不生成**——生成摘要要调模型，
   * 而 loop 跑在 30 秒事件预算里，插一次模型调用很可能把预算吃光，
   * 用户就什么都收不到了。所以真正的生成交给 cron（没有事件预算）。
   *
   * 合并而非覆盖：同一会话可能在摘要生成前又压缩了两次，
   * 把待摘要的旧轮**接在前面**，保证时间顺序不乱。
   */
  async stageSummary(messages: SummaryInput[], _coveredMessages: number, owner?: { runId: string; leaseId?: string }): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      if (owner) {
        const run = await storage.get<RunRecord>(`run:${owner.runId}`)
        if (!run || run.status !== 'running' || (owner.leaseId && run.leaseId !== owner.leaseId)) return
      }
      await this.stageSummaryInStorage(storage, messages)
    })
  }

  private async stageSummaryInStorage(storage: Storage, messages: SummaryInput[]): Promise<void> {
    const through = await storage.get<string>('summary:stagedThrough')
    const fresh = messages.filter(m => !m.id || !through || m.id > through)
    if (!fresh.length) return
    const existing = await readValue<SummaryBatch>(storage, 'summary:pending')
    const merged = [...(existing?.messages ?? []), ...fresh]
    await writeValue(storage, 'summary:pending', { messages: merged, coveredMessages: merged.length })
    const ids = fresh.flatMap(m => m.id ? [m.id] : []).sort()
    if (ids.length) await storage.put('summary:stagedThrough', ids[ids.length - 1]!)
  }

  /** 领取后保留原批次；执行者中断时租约到期可重新领取。 */
  async takePendingSummary(): Promise<SummaryBatch | null> {
    return this.ctx.storage.transaction(async storage => {
      const inflight = await readValue<SummaryBatch>(storage, 'summary:inflight')
      if (inflight && (inflight.expiresAt ?? 0) > Date.now()) return null
      let batch = inflight
      if (!batch) {
        const pending = await readValue<SummaryBatch>(storage, 'summary:pending')
        if (!pending?.messages.length) return null
        // 每批最多 40 条，避免等待摘要的积压一次塞满模型上下文。
        const messages = pending.messages.slice(0, 40)
        batch = { messages, coveredMessages: messages.length }
        const remaining = pending.messages.slice(messages.length)
        if (remaining.length) await writeValue(storage, 'summary:pending', { messages: remaining, coveredMessages: remaining.length })
        else await deleteValue(storage, 'summary:pending')
      }
      batch = { ...batch, token: crypto.randomUUID(), expiresAt: Date.now() + LEASE_MS }
      await writeValue(storage, 'summary:inflight', batch)
      return batch
    })
  }

  /** 带领取令牌提交，reset 或另一个执行者接管后旧摘要不得写回。 */
  async saveSummary(summary: StoredSummary, batch?: SummaryBatch): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      if (batch?.token) {
        const current = await readValue<SummaryBatch>(storage, 'summary:inflight')
        if (current?.token !== batch.token) return
      }
      await storage.put('summary', summary)
      if (batch?.token) await deleteValue(storage, 'summary:inflight')
    })
  }

  async restorePendingSummary(batch: SummaryBatch): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      if (batch.token) {
        const current = await readValue<SummaryBatch>(storage, 'summary:inflight')
        if (current?.token !== batch.token) return
        await deleteValue(storage, 'summary:inflight')
      }
      const existing = await readValue<SummaryBatch>(storage, 'summary:pending')
      const messages = [...batch.messages, ...(existing?.messages ?? [])]
      await writeValue(storage, 'summary:pending', { messages, coveredMessages: messages.length })
    })
  }

  async nextWakeAt(retentionMs: number): Promise<number | null> {
    const runs = [...(await this.ctx.storage.list<RunRecord>({ prefix: 'run:' })).values()]
    if (runs.some(r => r.status === 'pending' || r.status === 'running') ||
        await this.ctx.storage.get('summary:pending') || await this.ctx.storage.get('summary:inflight')) return Date.now() + 60_000
    return runs.length ? Math.max(Date.now() + 1_000, Math.min(...runs.map(r => r.updatedAt + retentionMs + 1))) : null
  }

  async checkpoint(runId: string): Promise<LoopCheckpoint | null> {
    return this.ctx.storage.transaction(async storage => (await readValue<LoopCheckpoint>(storage, `checkpoint:${runId}`)) ?? null)
  }

  async saveCheckpoint(runId: string, checkpoint: LoopCheckpoint, leaseId?: string): Promise<boolean> {
    return this.ctx.storage.transaction(async storage => {
      const run = await storage.get<RunRecord>(`run:${runId}`)
      if (!run || run.status !== 'running' || (leaseId && run.leaseId !== leaseId)) return false
      await writeValue(storage, `checkpoint:${runId}`, checkpoint)
      return true
    })
  }

  async ownsLease(runId: string, leaseId: string): Promise<boolean> {
    const lock = await this.ctx.storage.get<{ runId: string; leaseId?: string; expiresAt: number }>('lock')
    const run = await this.ctx.storage.get<RunRecord>(`run:${runId}`)
    return lock?.runId === runId && lock.leaseId === leaseId && lock.expiresAt > Date.now() && run?.status === 'running'
  }

  /** 主动让出预算不算执行失败；同一个 run 继续，不能落到后来的消息后面。 */
  async suspend(runId: string, leaseId?: string): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      const run = await storage.get<RunRecord>(`run:${runId}`)
      if (!run || run.status !== 'running' || (leaseId && run.leaseId !== leaseId)) return
      await storage.put(`run:${runId}`, { ...run, status: 'pending', attempts: Math.max(0, run.attempts - 1), lockedUntil: undefined, updatedAt: Date.now() })
      await storage.put(`queue:0000000000000000:${runId}`, runId)
      const lock = await storage.get<{ runId: string; leaseId?: string }>('lock')
      if (lock?.runId === runId && (!leaseId || lock.leaseId === leaseId)) await storage.delete('lock')
    })
  }

  /** 会话概览，管理页展示用 */
  /**
   * 只打断正在跑的 run，**不清历史**。
   *
   * 与 `reset()` 的区别：
   * - `reset()`：打断 + 清空历史 + 清队列（「重新开始」）
   * - `stop()`：只打断当前这次回答（「别说了」），记忆保留
   *
   * AstrBot 的 `/stop` 就是这个语义（`active_event_registry.stop_all()`），
   * 它和 `/reset` 是两个命令 —— 用户想「打断这句」时不该被迫丢掉全部记忆。
   *
   * 实现上只把 run 标成 `cancelled`：
   * - 执行流每步轮询 `runStatus()`，看到 cancelled 就停（**这是本条的关键**：
   *   以前只改状态、没人读，`/stop` 形同虚设，用户按下后仍然会收到完整回答）；
   * - `release()` 见到 cancelled 就跳过写历史，所以被打断的那次回答不会污染记忆。
   *
   * 锁不存在时也扫一遍 running 的 run：锁可能因为租约过期被别人摘掉，
   * 而那个 run 仍在跑（比如跨事件预算的那条执行链）。只认锁会让 `/stop` 偶发无效。
   */
  async stop(): Promise<{ stopped: boolean }> {
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now()

      const stopRun = async (runId: string): Promise<boolean> => {
        const key = `run:${runId}`
        const run = await storage.get<RunRecord>(key)
        if (!run || (run.status !== 'running' && !(run.status === 'pending' && await storage.get(`checkpoint:${runId}`)))) return false
        await storage.put(key, {
          ...run,
          status: 'cancelled',
          updatedAt: now,
        } satisfies RunRecord)
        return true
      }

      const lock = await storage.get<{ runId: string }>('lock')
      if (lock && (await stopRun(lock.runId))) return { stopped: true }

      // 兜底：没有锁（或锁指向的 run 已经不在 running）时，扫一遍 run 记录。
      // 数量很小：终态 run 会被 prune 掉，同一会话同时最多一两个 running。
      const runs = await storage.list<RunRecord>({ prefix: 'run:' })
      for (const run of runs.values()) {
        if ((run.status === 'running' || run.status === 'pending') && (await stopRun(run.id))) return { stopped: true }
      }

      return { stopped: false }
    })
  }

  async stats(): Promise<{ history: number; pending: number; locked: boolean }> {
    const [history, pending, lock] = await Promise.all([
      this.ctx.storage.list({ prefix: 'msg:' }),
      this.ctx.storage.list({ prefix: 'queue:' }),
      this.ctx.storage.get<{ expiresAt: number }>('lock'),
    ])
    return {
      history: history.size,
      pending: pending.size,
      locked: Boolean(lock && lock.expiresAt > Date.now()),
    }
  }

  /**
   * 追加历史，并在超出上限时裁掉最旧的。
   *
   * 裁剪放在写入路径上（而不是 cron），是因为 DO storage 没有 TTL；
   * 一个长期活跃的群会把历史攒到无限大。每次写最多删几条，成本可预测。
   */
  private async appendHistory(rows: HistoryRow[], storage: Storage): Promise<void> {
    let sequence = (await storage.get<number>('meta:msgSeq')) ?? 0
    for (const row of rows) {
      sequence++
      const key = `msg:${String(sequence).padStart(16, '0')}`
      await writeValue(storage, key, row)
    }
    await storage.put('meta:msgSeq', sequence)
    const keys = [...(await storage.list({ prefix: 'msg:' })).keys()].sort()
    const excess = keys.slice(0, Math.max(0, keys.length - MAX_HISTORY_ROWS))
    const summarize = await storage.get<boolean>('meta:summarize')
    for (const key of excess) {
      const row = await readValue<HistoryRow>(storage, key)
      if (summarize && row) await this.stageSummaryInStorage(storage, [historySummary({ ...row, id: key })])
      await deleteValue(storage, key)
    }
  }

  // ------------------------------------------------------------ 清理与恢复

  /**
   * cron 对到期会话的恢复扫描：**一次 RPC 做完「认领滞留 run」与「清理终态 run」**。
   *
   * 合成一次是因为两边都要按会话遍历：分两次调用等于把 DO 唤醒数翻倍，
   * 而 DO 按 GB-秒计费（免费版 13,000 GB-s/日）。
   *
   * 认领为什么要在这里做：执行者被掐断（事件 30 秒硬窗、CPU 1102）时
   * `release()` 永远跑不到，租约 90 秒后过期却没人来拿。只靠「下一条消息进来
   * 时顺带认领」在冷会话里等于永远不恢复，排队消息就永久停滞。
   */
  async sweep(olderThanMs: number): Promise<{ claimed: AcquireResult; pruned: number }> {
    const claimed = await this.poll()
    const pruned = await this.prune(olderThanMs)
    return { claimed, pruned }
  }

  /**
   * 清理终态 run。由 cron 调用。
   *
   * 保留一小段时间是为了让事件处理器能查到结果（它可能在 run 跑完后才回来查）。
   */
  async prune(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs
    const all = await this.ctx.storage.list<RunRecord>({ prefix: 'run:' })
    const stale = [...all.entries()]
      .filter(([, run]) => {
        // 终态有 4 个（见 types.ts 的 RunStatus）：pending / running 还要继续跑，
        // completed / failed / cancelled 都已经结束。
        //
        // cancelled 以前漏了：用户每按一次 `/stop` 或 `/agent reset` 就永久留一条
        // run 记录，DO storage 只增不减（它没有 TTL）。
        if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') {
          return false
        }
        return run.updatedAt < cutoff
      })
      .map(([key]) => key)
    for (const key of stale) {
      const runId = key.slice(4)
      await this.ctx.storage.transaction(async storage => {
        await deleteValue(storage, `checkpoint:${runId}`)
        await deleteValue(storage, `input:${runId}`)
        await storage.delete(key)
      })
    }
    return stale.length
  }
}

/**
 * 队列键：单调递增序号补零 + runId，字典序即 FIFO。
 *
 * **不能用时间戳**：同一毫秒入队的多个 run 会拿到相同的时间戳前缀，
 * 排序就退化成比较 runId（随机 UUID），FIFO 直接失效——同一毫秒内
 * 连发两条消息时顺序会乱。序号由 DO storage 里的计数器分配，
 * DO 单实例串行，所以天然单调。
 */
function queueKey(sequence: number, runId: string): string {
  return `queue:${String(sequence).padStart(16, '0')}:${runId}`
}

/** 取下一个队列序号。DO 单实例内 `put` 串行，所以读-加-写不会竞争 */
async function nextSequence(storage: Storage): Promise<number> {
  const current = (await storage.get<number>('meta:queueSeq')) ?? 0
  const next = current + 1
  await storage.put('meta:queueSeq', next)
  return next
}
