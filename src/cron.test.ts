import { describe, expect, it, vi } from 'vitest'
import plugin from './index.js'
import { defaultConfig } from './config/index.js'

/**
 * cron 的空闲成本。
 *
 * 上一版每分钟做这些事，即使队列全空：
 *   1. 读 KV 的 conversations 列表
 *   2. 对**每个会话**调一次 DO poll()
 *
 * 20 个会话就是每天 28,800 次 DO 唤醒。DO 按 GB-秒计费，空转唤醒纯浪费。
 * 现在：没有到期的定时任务、也没有待跑 run 时，一次 D1 查询就退出。
 */

type CronHandler = (input: { ctx: unknown; job: string; scheduledAt: number }) => Promise<void>

function cronHandler(): CronHandler {
  const cron = plugin.cron as Record<string, { handler: CronHandler }>
  const handler = cron['tick']?.handler
  if (!handler) throw new Error('没有 tick 定时任务')
  return handler
}

/** 记录所有调用，用来断言「空闲时没碰 DO」 */
function mockCtx(options: {
  dueSchedules?: unknown[]
  enableSchedule?: boolean
  conversations?: string[]
} = {}) {
  const calls = {
    kvGet: 0,
    kvPut: 0,
    dbAll: 0,
    durableGet: 0,
    serviceCalls: 0,
  }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    config: {
      ...defaultConfig,
      enable_schedule: options.enableSchedule ?? false,
    },
    kv: {
      async get(key: string) {
        calls.kvGet += 1
        return null
      },
      async getJSON(key: string) {
        calls.kvGet += 1
        if (key === 'conversations') return options.conversations ?? []
        return null
      },
      async put() {
        calls.kvPut += 1
      },
      async delete() {},
      async list() {
        return []
      },
    },
    db: {
      async all() {
        calls.dbAll += 1
        return options.dueSchedules ?? []
      },
      async run() {
        return { changes: 0 }
      },
      async first() {
        return null
      },
    },
    durable: {
      get() {
        calls.durableGet += 1
        return {
          poll: async () => ({ acquired: false }),
          submit: async () => ({ acquired: false }),
          prune: async () => 0,
          release: async () => {},
          retryLater: async () => {},
          history: async () => [],
          reset: async () => {},
        }
      },
    },
    service() {
      calls.serviceCalls += 1
      return {
        listModels: async () => [],
        resolve: async () => null,
        chat: async () => ({}),
        ping: async () => ({ ok: true }),
      }
    },
    waitUntil() {},
  }

  return { ctx, calls }
}

describe('cron 空闲时不浪费额度', () => {
  it('没有定时任务、没有待跑 run 时，一次 DO 都不调', async () => {
    const { ctx, calls } = mockCtx({ enableSchedule: false })
    await cronHandler()({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.durableGet).toBe(0)
  })

  it('enable_schedule 关掉时不查 D1 的 schedules 表', async () => {
    const { ctx, calls } = mockCtx({ enableSchedule: false })
    await cronHandler()({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.dbAll).toBe(0)
  })

  it('enable_schedule 打开但没到期任务时，只查一次 D1 就退出', async () => {
    const { ctx, calls } = mockCtx({ enableSchedule: true, dueSchedules: [] })
    await cronHandler()({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.dbAll).toBe(1)
    expect(calls.durableGet).toBe(0)
  })

  it('cron 不再轮询消息队列（队列由 release 链式处理）', async () => {
    const { ctx, calls } = mockCtx({
      enableSchedule: false,
      conversations: ['group:g1', 'c2c:u1'],
    })

    await cronHandler()({ ctx, job: 'tick', scheduledAt: Date.now() })

    // 即使有已知会话，cron 也不该去 poll——那是事件处理器的活
    expect(calls.durableGet).toBe(0)
  })

  it('清理到期时才会碰 DO（每 10 分钟一次）', async () => {
    const { ctx, calls } = mockCtx({
      enableSchedule: false,
      conversations: ['group:g1', 'c2c:u1'],
    })

    // 第一次 tick：节流状态初始为 0，会触发清理
    await cronHandler()({ ctx, job: 'tick', scheduledAt: Date.now() })
    const afterFirst = calls.durableGet

    // 第二次 tick：节流未到期，不碰 DO
    await cronHandler()({ ctx, job: 'tick', scheduledAt: Date.now() })
    expect(calls.durableGet).toBe(afterFirst)
  })

  it('有到期定时任务时才会跑 fireDueSchedules', async () => {
    const { ctx, calls } = mockCtx({
      enableSchedule: true,
      dueSchedules: [
        {
          id: 's1',
          conversation: 'group:g1',
          scene: 'group',
          target_id: 'g1',
          prompt: '提醒',
          due_at: Date.now() - 1000,
          repeat_seconds: null,
          status: 'active',
          created_by: 'u1',
          created_at: Date.now(),
          last_run_at: null,
        },
      ],
    })
    await cronHandler()({ ctx, job: 'tick', scheduledAt: Date.now() })

    // 到期的任务会被 submit（走 durable.get）
    expect(calls.durableGet).toBeGreaterThan(0)
  })
})
