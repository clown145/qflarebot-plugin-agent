import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from './store/sqlite-test-db.js'
import { trackRecovery } from './store/recovery.js'
import type { PluginDB } from '@qqbot/sdk'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })

/**
 * cron（`tick`）的行为与成本。
 *
 * 这个文件刻意用 `vi.resetModules()` + 动态 import 取插件：`pruneThrottle` 是模块级状态，
 * 不重置的话测试结果会取决于执行顺序（上一版就是靠隐式的先后关系才勉强通过）。
 *
 * 覆盖三件事：
 * 1. 空闲时不碰 DO（每分钟对每个会话唤醒一次 = 每天 28,800 次 GB-秒，纯浪费）；
 * 2. 审计清理**真的会跑**（上一版节流顺序写反，一次都没跑过）；
 * 3. 到期任务**提交即推进**，不重复执行（上一版「跑成功才推进」会让同一条提醒跑两遍）。
 */

type CronHandler = (input: { ctx: unknown; job: string; scheduledAt: number }) => Promise<void>

/** 每个测试都拿一份全新的模块实例，模块级节流状态从 0 开始 */
async function freshCronHandler(): Promise<CronHandler> {
  vi.resetModules()
  const mod = await import('./index.js')
  const cron = (mod.default as unknown as Record<string, unknown>)['cron'] as Record<
    string,
    { handler: CronHandler }
  >
  const handler = cron['tick']?.handler
  if (!handler) throw new Error('没有 tick 定时任务')
  return handler
}

interface ScheduleRow {
  id: string
  conversation: string
  scene: string
  target_id: string
  prompt: string
  due_at: number
  repeat_seconds: number | null
  status: string
  created_by: string
  created_at: number
  last_run_at: number | null
}

function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 's1',
    conversation: 'group:g1',
    scene: 'group',
    target_id: 'g1',
    prompt: '提醒',
    due_at: Date.now() - 1_000,
    repeat_seconds: null,
    status: 'active',
    created_by: 'u1',
    created_at: Date.now(),
    last_run_at: null,
    ...overrides,
  }
}

/** 记录所有调用，用来断言「空闲时没碰 DO」「审计清理真的发出 DELETE」 */
function mockCtx(
  options: {
    dueSchedules?: ScheduleRow[]
    enableSchedule?: boolean
    enableAudit?: boolean
    conversations?: string[]
    /** submit 是否抢到执行权 */
    acquired?: boolean
    /** sweep 返回的滞留 run（模拟「执行者被掐断后 cron 恢复」） */
    stalled?: { runId: string; message: unknown } | null
  } = {},
) {
  const store = createTestDb()
  cleanup.push(() => store.close())
  const calls = {
    kvGet: 0,
    kvPut: 0,
    dbAll: 0,
    scheduleQueries: 0,
    dbRun: [] as string[],
    durableGet: 0,
    sweep: 0,
    submit: 0,
    serviceCalls: 0,
    executedRuns: [] as string[],
  }

  const config = {
    ...defaultConfigFields(),
    enable_schedule: options.enableSchedule ?? false,
    enable_audit: options.enableAudit ?? false,
  }

  const submitResult = options.acquired
    ? { acquired: true, runId: 'run-submit', message: undefined }
    : { acquired: false }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    config,
    kv: {
      async get() {
        calls.kvGet += 1
        return null
      },
      async getJSON(key: string) {
        calls.kvGet += 1
        return key === 'conversations' ? (options.conversations ?? []) : null
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
      async all(sql: string, ...params: unknown[]) {
        calls.dbAll += 1
        if (sql.includes('{recovery}')) return store.db.all(sql, ...params)
        if (sql.includes('{schedules}')) calls.scheduleQueries++
        return options.dueSchedules ?? []
      },
      async run(sql: string, ...params: unknown[]) {
        calls.dbRun.push(sql)
        if (sql.includes('{recovery}')) return store.db.run(sql, ...params)
        return { changes: 1 }
      },
      async first() {
        return null
      },
    },
    durable: {
      get() {
        calls.durableGet += 1
        return {
          async submit(message: unknown) {
            calls.submit += 1
            return { ...submitResult, ...(options.acquired ? { message } : {}) }
          },
          async sweep() {
            calls.sweep += 1
            const stalled = options.stalled
            return {
              claimed: stalled
                ? { acquired: true, runId: stalled.runId, message: stalled.message }
                : { acquired: false },
              pruned: 0,
            }
          },
          async release() {
            return { acquired: false }
          },
          async retryLater() {
            return { acquired: false }
          },
          async history() {
            return []
          },
          async reset() {},
          async nextWakeAt() { return null },
          async suspend() {},
        }
      },
    },
    service() {
      calls.serviceCalls += 1
      return {
        listModels: async () => [],
        resolve: async () => null,
        chat: async () => ({ text: '', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }),
        ping: async () => ({ ok: true }),
        stream: async function* () {},
      }
    },
    waitUntil() {},
  }

  return { ctx, calls }
}

// 只取 plugin 需要的几个配置字段；单独抽出来是为了让 mockCtx 的签名保持短
function defaultConfigFields() {
  return {
    model: 'chat',
    system_prompt: '',
    max_model_steps: 1,
    max_tool_calls: 1,
    history_limit: 0,
    request_timeout_ms: 1_000,
    enable_tools: false,
    enable_vfs: false,
    show_typing: false,
    timezone: 'Asia/Shanghai',
  }
}

describe('cron 空闲时不浪费额度', () => {
  it('每分钟恢复持久索引里的会话，不依赖最近会话列表或十分钟清理节流', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await handler({ ctx, job: 'tick', scheduledAt: now })
    for (let i = 0; i < 25; i++) await trackRecovery(ctx.db as unknown as PluginDB, `group:${i}`)
    now += 60_000
    await handler({ ctx, job: 'tick', scheduledAt: now })
    expect(calls.sweep).toBe(25)
  })
  it('没有定时任务、没有已知会话时，一次 DO 都不调', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx({ enableSchedule: false })
    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.durableGet).toBe(0)
    expect(calls.sweep).toBe(0)
  })

  it('enable_schedule 关掉时不查 D1 的 schedules 表', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx({ enableSchedule: false })
    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.scheduleQueries).toBe(0)
  })

  it('enable_schedule 打开但没到期任务时，只查一次 schedules，不唤醒 DO', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx({ enableSchedule: true, dueSchedules: [] })
    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.scheduleQueries).toBe(1)
    expect(calls.durableGet).toBe(0)
  })

  it('升级时迁移旧会话，清理完成后不反复唤醒空闲 DO', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx({
      enableSchedule: false,
      conversations: ['group:g1', 'c2c:u1'],
    })

    // 第一轮：节流从 0 开始，会做清理轮 → 两个会话各一次 sweep
    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })
    expect(calls.sweep).toBe(2)

    // 紧接着的第二轮：节流未到期，不碰 DO
    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })
    expect(calls.sweep).toBe(2)
  })

  it('清理轮会认领滞留的 run 并继续执行（执行者被掐断后的恢复路径）', async () => {
    const handler = await freshCronHandler()
    const stalledMessage = {
      conversation: 'group:g1',
      userId: 'u1',
      userName: '小明',
      text: '在吗',
      displayText: '在吗',
      attachments: [],
      scene: 'group',
      targetId: 'g1',
      receivedAt: Date.now(),
    }
    const { ctx, calls } = mockCtx({
      conversations: ['group:g1'],
      stalled: { runId: 'run-orphan', message: stalledMessage },
    })

    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    // 恢复路径：sweep 返回的 run 会被真正跑一遍（config.enable_tools=false，
    // 所以 loop 只会调一次模型；service 返回空文本，不产生回复）
    expect(calls.sweep).toBe(1)
    expect(calls.serviceCalls).toBeGreaterThan(0)
  })
})

describe('cron 的写入纪律', () => {
  it('审计清理真的会跑（上一版节流顺序写反，一次都没跑过）', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx({ enableAudit: true })

    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    // 清理轮里必须出现一条针对 {tool_audit} 的 DELETE
    expect(calls.dbRun.some((sql) => sql.includes('{tool_audit}') && sql.includes('DELETE'))).toBe(true)
  })

  it('关掉 enable_audit 时不做审计清理（默认省额度）', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx({ enableAudit: false })

    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.dbRun.some((sql) => sql.includes('{tool_audit}'))).toBe(false)
  })
})

describe('定时任务的执行语义', () => {
  it('提交即推进：没抢到执行权也要推进 due_at，否则下一分钟会再提交一份', async () => {
    const handler = await freshCronHandler()
    const { ctx, calls } = mockCtx({
      enableSchedule: true,
      dueSchedules: [scheduleRow()],
      acquired: false, // 会话正忙 / 队列排不上
    })

    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(calls.submit).toBe(1)
    const advanced = calls.dbRun.filter((sql) => sql.includes('{schedules}') && sql.includes('UPDATE'))
    expect(advanced.length).toBe(1)
  })

  it('定时任务以 scheduler 身份执行，不吃「陌生人」的权限', async () => {
    const handler = await freshCronHandler()
    let submitted: { userId?: string; memberRole?: string } | undefined
    const { ctx } = mockCtx({ enableSchedule: true, dueSchedules: [scheduleRow()] })

    // 拦下 submit 的入参，检查身份
    const durable = (ctx as { durable: { get: () => Record<string, unknown> } }).durable
    const originalGet = durable.get
    durable.get = () => {
      const stub = originalGet() as { submit: (m: unknown) => Promise<unknown>; sweep: () => Promise<unknown> }
      return {
        ...stub,
        async submit(message: unknown) {
          submitted = message as { userId?: string }
          return { acquired: false }
        },
        async sweep() {
          return { claimed: { acquired: false }, pruned: 0 }
        },
      }
    }

    await handler({ ctx, job: 'tick', scheduledAt: Date.now() })

    expect(submitted?.userId).toBe('scheduler')
  })
})
