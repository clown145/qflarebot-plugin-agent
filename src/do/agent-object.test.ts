import { describe, expect, it } from 'vitest'
import { PluginDurableObject } from '@qqbot/sdk'
import { AgentObject, LEASE_MS, MAX_ATTEMPTS } from './agent-object.js'
import type { HistoryRow } from './agent-object.js'
import type { InboundMessage } from '../types.js'

/**
 * AgentObject 的双段式调度核心。
 *
 * DO 由平台构造，测试里直接 new 不了（基类要求作用域工厂）。
 * 这里用 `Object.create` 绕过构造器，只注入它真正用到的东西：
 * `this.ctx.storage`（内存实现）。这样测的是调度逻辑本身，不是平台行为。
 */

/** 内存版 DurableObjectStorage，只实现 AgentObject 用到的方法 */
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
  const obj = Object.create(AgentObject.prototype) as AgentObject
  // 只注入 ctx.storage —— AgentObject 里没有别的地方碰 this.ctx
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

describe('AgentObject.submit', () => {
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

describe('AgentObject.poll（cron 兜底）', () => {
  it('没活干时返回 acquired: false', async () => {
    const { obj } = makeObject()
    const result = await obj.poll()
    expect(result.acquired).toBe(false)
    expect(result.runId).toBeUndefined()
  })

  it('队列里有 run 时能捡起来', async () => {
    const { obj } = makeObject()
    await obj.submit(message({ text: '第一条' }))
    await obj.submit(message({ text: '第二条' })) // 进队列

    // 模拟第一个 run 跑完释放锁
    const first = await obj.poll()
    expect(first.acquired).toBe(false) // 锁还在

    // 这里不 release，直接等租约过期不现实，改用 release 模拟
    const locked = await (obj as unknown as { ctx: { storage: { get(k: string): Promise<{ runId: string } | undefined> } } }).ctx.storage.get('lock')
    await obj.release(locked!.runId, { ok: true })

    const second = await obj.poll()
    expect(second.acquired).toBe(true)
    expect(second.message?.text).toBe('第二条')
  })

  it('FIFO：同一毫秒入队时也按入队顺序（靠单调序号，不靠时间戳）', async () => {
    const { obj } = makeObject()
    // 第一条抢到锁，后面两条进队列
    await obj.submit(message({ text: 'A' }))
    await obj.submit(message({ text: 'B' }))
    await obj.submit(message({ text: 'C' }))

    // 释放 A 的锁，让队列里的 B、C 能被捡
    const lock = await (obj as unknown as { ctx: { storage: { get(k: string): Promise<{ runId: string } | undefined> } } }).ctx.storage.get('lock')
    await obj.release(lock!.runId, { ok: true })

    const first = await obj.poll()
    expect(first.message?.text).toBe('B')
    await obj.release(first.runId!, { ok: true })

    const second = await obj.poll()
    expect(second.message?.text).toBe('C')
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

describe('AgentObject.release', () => {
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

describe('AgentObject.retryLater', () => {
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

  it('退回后能被 poll 重新捡起来', async () => {
    const { obj } = makeObject()
    const { runId } = await obj.submit(message({ text: '重试我' }))
    await obj.retryLater(runId!, '限流')

    const taken = await obj.poll()
    expect(taken.acquired).toBe(true)
    expect(taken.message?.text).toBe('重试我')
  })
})

describe('AgentObject.history', () => {
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

  it('超过 60 条时裁掉最旧的（DO storage 没有 TTL）', async () => {
    const { obj } = makeObject()
    const { runId } = await obj.submit(message())
    await obj.release(runId!, {
      ok: true,
      history: Array.from({ length: 70 }, (_, i) => ({
        role: 'user' as const,
        content: `第${i}条`,
        toolCallsJson: null,
        createdAt: Date.now() + i,
      })),
    })

    const all = await obj.history(1000)
    expect(all).toHaveLength(60)
    // 保留的是最新的 60 条
    expect(all.at(-1)?.content).toBe('第69条')
  })
})

describe('AgentObject.reset', () => {
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

describe('AgentObject.stats', () => {
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

describe('AgentObject.prune', () => {
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
