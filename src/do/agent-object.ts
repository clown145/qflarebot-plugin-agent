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
 * **每条消息完全不碰 D1 额度**。
 *
 * ## 串行化语义
 *
 * 同一个会话同一时刻只有一个执行者：`acquire()` 抢到租约才能跑，跑完 `release()`。
 * 抢不到的进 `pending` 队列，由 cron 兜底捡起来。
 */

import { PluginDurableObject } from '@qqbot/sdk'
import type { InboundMessage, RunRecord } from '../types.js'

/** 租约时长。执行者挂了之后，租约到期可以被别人接管 */
export const LEASE_MS = 90_000

/** 一次 run 最多尝试几次 */
export const MAX_ATTEMPTS = 3

/** 会话历史最多留多少条（超出时从旧的开始删，防止 DO storage 无限增长） */
const MAX_HISTORY_ROWS = 60

export interface HistoryRow {
  role: 'user' | 'assistant'
  content: string
  /** assistant 消息带的工具调用（JSON 字符串），回放历史时要还原 */
  toolCallsJson: string | null
  createdAt: number
}

export interface AcquireResult {
  /** 是否抢到执行权 */
  acquired: boolean
  runId?: string
  /** 抢到时带出的入站消息，省一次读 */
  message?: InboundMessage
  /** 没抢到时：当前租约还有多久过期（毫秒），用来决定 cron 什么时候再来 */
  retryAfterMs?: number
}

export class AgentObject extends PluginDurableObject {
  // ------------------------------------------------------------ 入队与认领

  /**
   * 入队一个 run 并尝试立刻认领。
   *
   * 返回 `acquired: true` 表示调用方拿到了执行权，应当马上跑 loop；
   * `acquired: false` 表示这个会话已经有人在跑，run 进了队列，等 cron 兜底。
   */
  async submit(message: InboundMessage): Promise<AcquireResult> {
    const now = Date.now()
    const runId = crypto.randomUUID()

    const run: RunRecord = {
      id: runId,
      conversation: message.conversation,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      inputJson: JSON.stringify(message),
      steps: 0,
    }

    await this.ctx.storage.put(`run:${runId}`, run)
    await this.ctx.storage.put(queueKey(await nextSequence(this.ctx.storage), runId), runId)

    return this.claim(now)
  }

  /**
   * cron 兜底：捡一个待跑的 run 并认领。
   *
   * 返回 `null` 表示没活干（或都被别人占着）。
   */
  async poll(): Promise<AcquireResult> {
    return this.claim(Date.now())
  }

  /**
   * 认领：先看有没有过期租约（前一个执行者挂了），再按 FIFO 取 pending。
   */
  private async claim(now: number): Promise<AcquireResult> {
    const lock = await this.ctx.storage.get<{ runId: string; expiresAt: number }>('lock')

    if (lock && lock.expiresAt > now) {
      return { acquired: false, retryAfterMs: lock.expiresAt - now }
    }

    // 租约过期：把那个 run 退回 pending（尝试次数已经在上次认领时加过）
    if (lock) {
      const stale = await this.ctx.storage.get<RunRecord>(`run:${lock.runId}`)
      if (stale && stale.status === 'running') {
        await this.ctx.storage.put(`run:${stale.id}`, {
          ...stale,
          status: 'pending',
          lockedUntil: undefined,
          updatedAt: now,
        } satisfies RunRecord)
        await this.ctx.storage.put(
          queueKey(await nextSequence(this.ctx.storage), stale.id),
          stale.id,
        )
      }
      await this.ctx.storage.delete('lock')
    }

    const queue = await this.ctx.storage.list<string>({ prefix: 'queue:', limit: 20 })
    if (queue.size === 0) return { acquired: false }

    for (const [key, runId] of [...queue.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const run = await this.ctx.storage.get<RunRecord>(`run:${runId}`)
      await this.ctx.storage.delete(key)

      if (!run || run.status !== 'pending') continue

      if (run.attempts >= MAX_ATTEMPTS) {
        await this.ctx.storage.put(`run:${run.id}`, {
          ...run,
          status: 'failed',
          error: `超过最大重试次数（${MAX_ATTEMPTS}）`,
          updatedAt: now,
        } satisfies RunRecord)
        continue
      }

      const claimed: RunRecord = {
        ...run,
        status: 'running',
        attempts: run.attempts + 1,
        lockedUntil: now + LEASE_MS,
        updatedAt: now,
      }
      await this.ctx.storage.put(`run:${run.id}`, claimed)
      await this.ctx.storage.put('lock', { runId: run.id, expiresAt: now + LEASE_MS })

      return {
        acquired: true,
        runId: run.id,
        message: JSON.parse(run.inputJson) as InboundMessage,
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
    result: { ok: boolean; error?: string; history?: HistoryRow[] },
  ): Promise<void> {
    const now = Date.now()
    const run = await this.ctx.storage.get<RunRecord>(`run:${runId}`)

    if (run) {
      await this.ctx.storage.put(`run:${runId}`, {
        ...run,
        status: result.ok ? 'completed' : 'failed',
        error: result.error,
        lockedUntil: undefined,
        updatedAt: now,
      } satisfies RunRecord)
    }

    if (result.history?.length) {
      await this.appendHistory(result.history)
    }

    await this.ctx.storage.delete('lock')
  }

  /**
   * 把 run 退回队列（可重试的错误，比如上游 429）。
   *
   * 与 `release` 的区别：不写历史、状态回 pending、保留 attempts 计数。
   */
  async retryLater(runId: string, reason: string): Promise<void> {
    const now = Date.now()
    const run = await this.ctx.storage.get<RunRecord>(`run:${runId}`)

    if (run) {
      await this.ctx.storage.put(`run:${runId}`, {
        ...run,
        status: 'pending',
        error: reason,
        lockedUntil: undefined,
        updatedAt: now,
      } satisfies RunRecord)
      await this.ctx.storage.put(queueKey(await nextSequence(this.ctx.storage), run.id), run.id)
    }

    await this.ctx.storage.delete('lock')
  }

  // ------------------------------------------------------------ 历史

  async history(limit: number): Promise<HistoryRow[]> {
    const all = await this.ctx.storage.list<HistoryRow>({ prefix: 'msg:' })
    const rows = [...all.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v)
    return rows.slice(-limit)
  }

  /** 清空会话历史（`/agent reset`） */
  async reset(): Promise<void> {
    const all = await this.ctx.storage.list({ prefix: 'msg:' })
    if (all.size) await this.ctx.storage.delete([...all.keys()])
  }

  /** 会话概览，管理页展示用 */
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
  private async appendHistory(rows: HistoryRow[]): Promise<void> {
    const puts: Record<string, HistoryRow> = {}
    // 用单调序号而不是 createdAt 做排序键：同一次 release 写入的多条消息
    // 时间戳可能相同（都取 Date.now()），字典序会退化成比较随机 UUID，顺序就乱了
    let sequence = (await this.ctx.storage.get<number>('meta:msgSeq')) ?? 0
    for (const row of rows) {
      sequence += 1
      puts[`msg:${String(sequence).padStart(16, '0')}`] = row
    }
    await this.ctx.storage.put('meta:msgSeq', sequence)
    await this.ctx.storage.put(puts)

    const all = await this.ctx.storage.list<HistoryRow>({ prefix: 'msg:' })
    if (all.size <= MAX_HISTORY_ROWS) return

    const keys = [...all.keys()].sort()
    const excess = keys.slice(0, all.size - MAX_HISTORY_ROWS)
    if (excess.length) await this.ctx.storage.delete(excess)
  }

  // ------------------------------------------------------------ 清理

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
        if (run.status !== 'completed' && run.status !== 'failed') return false
        return run.updatedAt < cutoff
      })
      .map(([key]) => key)
    if (stale.length) await this.ctx.storage.delete(stale)
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
async function nextSequence(storage: DurableObjectStorage): Promise<number> {
  const current = (await storage.get<number>('meta:queueSeq')) ?? 0
  const next = current + 1
  await storage.put('meta:queueSeq', next)
  return next
}
