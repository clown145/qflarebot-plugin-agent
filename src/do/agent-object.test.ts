import { describe, expect, it } from 'vitest'
import { PluginDurableObject } from '@qqbot/sdk'
import { Agent, LEASE_MS, MAX_ATTEMPTS } from './agent-object.js'
import type { HistoryRow } from './agent-object.js'
import type { InboundMessage } from '../types.js'

/**
 * Agent 的双段式调度核心。
 *
 * DO 由平台构造，测试里直接 new 不了（基类要求作用域工厂）。
 * 这里用 `Object.create` 绕过构造器，只注入它真正用到的东西：
 * `this.ctx.storage`（内存实现）。这样测的是调度逻辑本身，不是平台行为。
 */

/** 内存版 DurableObjectStorage，只实现 Agent 用到的方法 */
function memoryStorage() {
  const map = new Map<string, unknown>()
  return {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined
    },
    async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrEntries === 'string') {
        map.set(keyOrEntries, value)
      } else {
        for (const [k, v] of Object.entries(keyOrEntries)) map.set(k, v)
      }
    },
    async delete(keyOrKeys: string | string[]) {
      for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) map.delete(k)
      return true
    },
    async list<T>(options: { prefix?: string; limit?: number } = {}) {
      const prefix = options.prefix ?? ''
      const entries = [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort((a, b) => a[0].localeCompare(b[0]))
      const limited = options.limit ? entries.slice(0, options.limit) : entries
      return new Map(limited) as Map<string, T>
    },
  }
}

function makeObject() {
  const storage = memoryStorage()
  const obj = Object.create(Agent.prototype) as Agent
  // 只注入 ctx.storage —— Agent 里没有别的地方碰 this.ctx
  ;(obj as unknown as { ctx: { storage: unknown } }).ctx = { storage }
  return { obj, storage }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    conversation: 'group:g1',
    userId: 'u1',
    userName: '小明',
    text: '你好',
    displayText: '你好',
    attachments: [],
    scene: 'group',
    targetId: 'g1',
    receivedAt: Date.now(),
    ...overrides,
  }
}

function historyRow(role: 'user' | 'assistant', content: string): HistoryRow {
  return { role, content, toolCallsJson: null, createdAt: Date.now() }
}

describe('Agent.submit', () => {
  it('第一个 submit 抢到执行权', async () => {
    const { obj } = makeObject()
    const result = await obj.submit(message())
    expect(result.acquired).toBe(true)
    expect(result.runId).toBeTruthy()
    expect(result.message?.text).toBe('你好')
  })

  it('第二个 submit 抢不到，进队列（这是串行化的关键）', async () => {
    const { obj, storage } = makeObject()
    await obj.submit(message({ text: '第一条' }))
    const second = await obj.submit(message({ text: '第二条' }))

    expect(second.acquired).toBe(false)
    // 第二条留在队列里，等 cron 捡
    const queue = await storage.list({ prefix: 'queue:' })
    expect(queue.size).toBe(1)
  })

  it('抢不到时给出 retryAfterMs，调用方知道等多久', async () => {
    const { obj } = makeObject()
    await obj.submit(message())
    const second = await obj.submit(message())
    expect(second.retryAfterMs).toBeGreaterThan(0)
    expect(second.retryAfterMs).toBeLessThanOrEqual(LEASE_MS)
  })
})

describe('Agent.poll（cron 兜底）', () => {
  it('没活干时返回 acquired: false', async () => {
    const { obj } = makeObject()
    const result = await obj.poll()
    expect(result.acquired).toBe(false)
    expect(result.runId).toBeUndefined()
  })

  it('release 之后直接返回队列里的下一个（不必等 cron 轮询）', async () => {
    const { obj } = makeObject()
    await obj.submit(message({ text: '第一条' }))
    await obj.submit(message({ text: '第二条' })) // 进队列

    const locked = await (obj as unknown as { ctx: { storage: { get(k: string): Promise<{ runId: string } | undefined> } } }).ctx.storage.get('lock')
    // release 的返回值就是下一个认领到的 run
    const next = await obj.release(locked!.runId, { ok: true })

    expect(next.acquired).toBe(true)
    expect(next.message?.text).toBe('第二条')
  })

  it('FIFO：同一毫秒入队时也按入队顺序（靠单调序号，不靠时间戳）', async () => {
    const { obj } = makeObject()
    // A 抢到锁，B、C 进队列（锁被 A 占着，所以后两条都进队列）
    await obj.submit(message({ text: 'A' }))
    await obj.submit(message({ text: 'B' }))
    await obj.submit(message({ text: 'C' }))

    const lock = await (obj as unknown as { ctx: { storage: { get(k: string): Promise<{ runId: string } | undefined> } } }).ctx.storage.get('lock')

    // release(A) 顺手认领 B，release(B) 再认领 C —— 顺序必须是 B 再 C
    const first = await obj.release(lock!.runId, { ok: true })
    expect(first.message?.text).toBe('B')

    const second = await obj.release(first.runId!, { ok: true })
    expect(second.message?.text).toBe('C')

    // 队列空了
    const third = await obj.release(second.runId!, { ok: true })
    expect(third.acquired).toBe(false)
  })

  it('租约过期后能接管上一个执行者没跑完的 run', async () => {
    const { obj, storage } = makeObject()
    const submitted = await obj.submit(message({ text: '卡住的' }))
    expect(submitted.acquired).toBe(true)

    // 把锁改成已过期，模拟执行者挂了
    await storage.put('lock', { runId: submitted.runId!, expiresAt: Date.now() - 1000 })

    const taken = await obj.poll()
    expect(taken.acquired).toBe(true)
    expect(taken.runId).toBe(submitted.runId)
  })

  it('超过 MAX_ATTEMPTS 的 run 标成 failed，不再重试', async () => {
    const { obj, storage } = makeObject()
    const submitted = await obj.submit(message())
    const run = await storage.get<Record<string, unknown>>(`run:${submitted.runId}`)
    // 手动把尝试次数拉满
    await storage.put(`run:${submitted.runId}`, { ...run, attempts: MAX_ATTEMPTS, status: 'pending' })
    await storage.put('lock', { runId: 'nonexistent', expiresAt: Date.now() - 1 })
    await storage.put(`queue:${String(Date.now()).padStart(16, '0')}:x`, submitted.runId)

    await obj.poll()
    const after = await storage.get<{ status: string; error?: string }>(`run:${submitted.runId}`)
    expect(after?.status).toBe('failed')
    expect(after?.error).toContain('重试次数')
  })
})

describe('Agent.release', () => {
  it('标记完成、释放锁、写历史', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())

    await obj.release(runId!, {
      ok: true,
      history: [historyRow('user', '你好'), historyRow('assistant', '你好呀')],
    })

    const run = await storage.get<{ status: string }>(`run:${runId}`)
    expect(run?.status).toBe('completed')
    expect(await storage.get('lock')).toBeUndefined()

    const history = await obj.history(10)
    expect(history).toHaveLength(2)
    expect(history[1]?.content).toBe('你好呀')
  })

  it('失败时记错误信息', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, { ok: false, error: '模型超时' })

    const run = await storage.get<{ status: string; error?: string }>(`run:${runId}`)
    expect(run?.status).toBe('failed')
    expect(run?.error).toBe('模型超时')
  })

  it('失败时不写历史（避免把错误文案记成对话）', async () => {
    const { obj } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, { ok: false, error: '失败' })
    expect(await obj.history(10)).toEqual([])
  })
})

describe('Agent.retryLater', () => {
  it('把 run 退回 pending 并重新入队', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.retryLater(runId!, '限流')

    const run = await storage.get<{ status: string; error?: string }>(`run:${runId}`)
    expect(run?.status).toBe('pending')
    expect(run?.error).toBe('限流')

    const queue = await storage.list({ prefix: 'queue:' })
    expect(queue.size).toBe(1)
    expect(await storage.get('lock')).toBeUndefined()
  })

  it('retryLater 不立刻重新认领（否则限流时会无限重试）', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message({ text: '重试我' }))
    const next = await obj.retryLater(runId!, '限流')

    expect(next.acquired).toBe(false)
    // run 退回 pending，等 cron 或下一次用户消息触发
    const run = await storage.get<{ status: string }>(`run:${runId}`)
    expect(run?.status).toBe('pending')
  })
})

describe('Agent.history', () => {
  it('按时间顺序返回，limit 取最近的', async () => {
    const { obj } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, {
      ok: true,
      history: Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `第${i}条`,
        toolCallsJson: null,
        createdAt: Date.now() + i,
      })),
    })

    const all = await obj.history(100)
    expect(all).toHaveLength(10)
    expect(all[0]?.content).toBe('第0条')

    const recent = await obj.history(3)
    expect(recent).toHaveLength(3)
    expect(recent[2]?.content).toBe('第9条')
  })

  // 上限从 60 提到 120：60 会让 `history_limit` 配到 61–100 时静默失效
  // （配置说 100 条，DO 只留 60 条，且没有任何地方报错）。上限必须 >= 100。
  it('超过 120 条时裁掉最旧的（DO storage 没有 TTL）', async () => {
    const { obj } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, {
      ok: true,
      history: Array.from({ length: 130 }, (_, i) => ({
        role: 'user' as const,
        content: `第${i}条`,
        toolCallsJson: null,
        createdAt: Date.now() + i,
      })),
    })

    const all = await obj.history(1000)
    expect(all).toHaveLength(120)
    // 保留的是最新的 120 条
    expect(all.at(-1)?.content).toBe('第129条')
  })
})

describe('Agent.reset', () => {
  it('清空历史但不动 run', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, { ok: true, history: [historyRow('user', '旧对话')] })

    await obj.reset()

    expect(await obj.history(10)).toEqual([])
    // run 记录还在（reset 只管对话记忆）
    expect(await storage.get(`run:${runId}`)).toBeDefined()
  })
})

describe('Agent.stats', () => {
  it('返回历史条数、队列长度、是否有锁', async () => {
    const { obj } = makeObject()
    await obj.submit(message())
    await obj.submit(message()) // 进队列

    const stats = await obj.stats()
    expect(stats.history).toBe(0)
    expect(stats.pending).toBe(1)
    expect(stats.locked).toBe(true)
  })
})

describe('Agent.prune', () => {
  it('清掉超期的终态 run，保留未完成的', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, { ok: true })

    // 手动把 updatedAt 改成很久以前
    const run = await storage.get<Record<string, unknown>>(`run:${runId}`)
    await storage.put(`run:${runId}`, { ...run, updatedAt: Date.now() - 3600_000 })

    const removed = await obj.prune(600_000)
    expect(removed).toBe(1)
    expect(await storage.get(`run:${runId}`)).toBeUndefined()
  })

  it('未到期的终态 run 不动', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, { ok: true })

    expect(await obj.prune(600_000)).toBe(0)
    expect(await storage.get(`run:${runId}`)).toBeDefined()
  })

  it('pending / running 的 run 永远不清（否则任务丢失）', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())
    const run = await storage.get<Record<string, unknown>>(`run:${runId}`)
    await storage.put(`run:${runId}`, { ...run, status: 'running', updatedAt: Date.now() - 3600_000 })

    expect(await obj.prune(1)).toBe(0)
    expect(await storage.get(`run:${runId}`)).toBeDefined()
  })
})

/**
 * `sweep()`：cron 的 10 分钟清理轮用的单次 RPC（认领滞留 run + 清终态 run）。
 *
 * 这是执行者被掐断（事件 30 秒硬窗、CPU 1102）后**唯一**的恢复路径：
 * `release()` 永远跑不到，租约过期后没人认领，队列里的消息会永久停滞。
 */
describe('Agent.sweep', () => {
  it('一次调用同时认领滞留 run 与清理终态 run', async () => {
    const { obj, storage } = makeObject()

    // 1) 先造一个超期的终态 run（先做，避免它的 submit 抢到下面那个滞留 run）
    const done = await obj.submit(message({ text: '已完成的下一条' }))
    await obj.release(done.runId!, { ok: true })
    const doneSettled = await storage.get<Record<string, unknown>>(`run:${done.runId}`)
    await storage.put(`run:${done.runId}`, { ...doneSettled, updatedAt: Date.now() - 3600_000 })

    // 2) 再造一个「执行者挂了」的 run：running + 租约已过期 + 队列里没人管
    const stalled = await obj.submit(message({ text: '被忘记的消息' }))
    expect(stalled.acquired).toBe(true)
    const stalledRun = await storage.get<Record<string, unknown>>(`run:${stalled.runId}`)
    await storage.put(`run:${stalled.runId}`, {
      ...stalledRun,
      status: 'running',
      lockedUntil: Date.now() - 1_000,
    })
    await storage.put('lock', { runId: stalled.runId, expiresAt: Date.now() - 1_000 })

    const result = await obj.sweep(600_000)

    // 滞留的 run 被认领回来，消息跟着回来
    expect(result.claimed.acquired).toBe(true)
    expect(result.claimed.runId).toBe(stalled.runId)
    expect(result.claimed.message?.text).toBe('被忘记的消息')
    // 终态 run 同时被清掉
    expect(result.pruned).toBe(1)
  })

  it('没有滞留 run 时只是清理，不误认领已完成的东西', async () => {
    const { obj } = makeObject()
    const result = await obj.sweep(600_000)
    expect(result.claimed.acquired).toBe(false)
    expect(result.pruned).toBe(0)
  })
})

/**
 * `/agent reset` 的语义：**打断正在跑的 run + 清队列 + 清历史**。
 *
 * AstrBot 的 `/reset` 先 `stop_all(umo)` 再清历史。不打断的话，正在跑的 run
 * 跑完照样 release() 把这一轮写回历史，用户看到「已清空」之后聊一句、
 * 上下文却还在；队列里的旧消息也会在清空后继续执行。
 */
describe('Agent.reset', () => {
  it('清空历史', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, { ok: true, history: [historyRow('user', '你好'), historyRow('assistant', '在')] })
    expect((await obj.history(10)).length).toBe(2)

    await obj.reset()
    expect(await obj.history(10)).toEqual([])
    expect(storage.map.size).toBeGreaterThan(0) // 存储本身还在，只是历史没了
  })

  it('打断正在跑的 run：被取消的 run 不再写回历史', async () => {
    const { obj, storage } = makeObject()
    const { runId } = await obj.submit(message())

    // 模拟「reset 时这个 run 还在跑」：把它标成 cancelled
    await obj.reset()
    const run = await storage.get<Record<string, unknown>>(`run:${runId}`)
    expect(run?.['status']).toBe('cancelled')

    // 跑完后照常 release（真实执行者是异步的，它并不知道被取消了）
    await obj.release(runId!, { ok: true, history: [historyRow('user', '旧问题'), historyRow('assistant', '旧回答')] })

    // 关键：历史不该被写回去
    expect(await obj.history(10)).toEqual([])
  })

  it('清空待跑队列：清空后不再执行排着的消息', async () => {
    const { obj, storage } = makeObject()
    // 第一个抢到执行权，第二个进队列
    const first = await obj.submit(message({ text: '第一条' }))
    const second = await obj.submit(message({ text: '第二条' }))
    expect(first.acquired).toBe(true)
    expect(second.acquired).toBe(false)

    await obj.reset()

    // 队列空了，pending 的 run 也不见了（不会在清空之后突然冒出一条回复）
    const queued = await storage.list({ prefix: 'queue:' })
    expect(queued.size).toBe(0)
    const runs = await storage.list<Record<string, unknown>>({ prefix: 'run:' })
    for (const [, run] of runs) {
      expect(['cancelled', 'running']).toContain(run['status'])
    }
  })

  it('没有正在跑的 run 时也能安全清空', async () => {
    const { obj } = makeObject()
    await obj.reset()
    expect(await obj.history(10)).toEqual([])
  })
})

/**
 * stop：只打断当前回答，不清历史。
 *
 * 对标 AstrBot 的 `/stop`（`active_event_registry.stop_all()`）。
 * 与 `reset()` 的区别是**记忆保不保留** —— 用户说「别说了」时
 * 不该被迫丢掉之前聊的全部内容。
 */
describe('stop 与 reset 的语义区分', () => {
  it('没有正在跑的 run 时 stop 返回 false（不报错）', async () => {
    const { obj } = makeObject()
    expect(await obj.stop()).toEqual({ stopped: false })
  })

  it('stop 打断 run 但不删历史', async () => {
    const { obj } = makeObject()
    // 先跑一轮，留下历史
    const first = await obj.submit(message())
    await obj.release(first.runId!, {
      ok: true,
      history: [
        { role: 'user', content: '第一句', createdAt: Date.now(), toolCallsJson: null },
        { role: 'assistant', content: '第一答', createdAt: Date.now(), toolCallsJson: null },
      ],
    })
    const before = await obj.history(50)
    expect(before.length).toBeGreaterThan(0)

    // 再提交一个，然后 stop
    const second = await obj.submit(message())
    expect(second.acquired).toBe(true)
    const result = await obj.stop()
    expect(result.stopped).toBe(true)

    // 历史还在（这是 stop 与 reset 的核心区别）
    expect((await obj.history(50)).length).toBe(before.length)
  })

  it('reset 会清历史（对比 stop）', async () => {
    const { obj } = makeObject()
    const run = await obj.submit(message())
    await obj.release(run.runId!, {
      ok: true,
      history: [{ role: 'user', content: 'x', createdAt: Date.now(), toolCallsJson: null }],
    })
    expect((await obj.history(50)).length).toBeGreaterThan(0)

    await obj.reset()
    expect((await obj.history(50)).length).toBe(0)
  })

  it('被打断的 run 不写历史（cancelled 的 release 被跳过）', async () => {
    const { obj } = makeObject()
    const run = await obj.submit(message())
    await obj.stop()
    // 模拟 run 跑完后才调 release —— 它应该看到 cancelled 而不写历史
    await obj.release(run.runId!, {
      ok: true,
      history: [{ role: 'user', content: '不该被记住', createdAt: Date.now(), toolCallsJson: null }],
    })
    expect(await obj.history(50)).toHaveLength(0)
  })
})

describe('摘要存储（summary 压缩模式）', () => {
  it('没有摘要时 summary() 返回 null', async () => {
    const { obj } = makeObject()
    expect(await obj.summary()).toBeNull()
  })

  it('stage 之后 takePending 能取到，且取走即清空', async () => {
    const { obj } = makeObject()
    await obj.stageSummary([{ role: 'user', content: '你好' }], 1)

    const first = await obj.takePendingSummary()
    expect(first?.messages).toHaveLength(1)
    expect(first?.coveredMessages).toBe(1)

    // 再取一次是空的：防两个执行者同时摘要同一批
    expect(await obj.takePendingSummary()).toBeNull()
  })

  it('多次 stage 会合并而不是覆盖，保持时间顺序', async () => {
    const { obj } = makeObject()
    await obj.stageSummary([{ role: 'user', content: '第一轮' }], 1)
    await obj.stageSummary([{ role: 'user', content: '第二轮' }], 1)

    const pending = await obj.takePendingSummary()
    expect(pending?.messages.map((m) => m.content)).toEqual(['第一轮', '第二轮'])
    expect(pending?.coveredMessages).toBe(2)
  })

  it('restorePendingSummary 把失败的内容放回去，且排在更旧的批次之前', async () => {
    const { obj } = makeObject()
    await obj.stageSummary([{ role: 'user', content: '较新的' }], 1)
    await obj.restorePendingSummary({ messages: [{ role: 'user', content: '更旧的' }], coveredMessages: 1 })

    const pending = await obj.takePendingSummary()
    expect(pending?.messages.map((m) => m.content)).toEqual(['更旧的', '较新的'])
    expect(pending?.coveredMessages).toBe(2)
  })

  it('saveSummary 之后再 summary() 能读到', async () => {
    const { obj } = makeObject()
    await obj.saveSummary({ content: '摘要正文', generatedAt: 123, coveredMessages: 5 })
    const stored = await obj.summary()
    expect(stored?.content).toBe('摘要正文')
    expect(stored?.coveredMessages).toBe(5)
  })

  it('reset 连摘要一起清掉（否则「清空记忆」之后还带着旧摘要）', async () => {
    const { obj } = makeObject()
    await obj.saveSummary({ content: '旧摘要', generatedAt: 1, coveredMessages: 3 })
    await obj.stageSummary([{ role: 'user', content: '待摘要' }], 1)

    await obj.reset()

    expect(await obj.summary()).toBeNull()
    expect(await obj.takePendingSummary()).toBeNull()
  })
})
