import { describe, expect, it } from 'vitest'
import { createScheduleTools, parseAbsoluteTime, zonedTimeToEpoch } from './schedule.js'

describe('parseAbsoluteTime', () => {
  it('带时区偏移的 ISO 8601 直接解析', () => {
    const ms = parseAbsoluteTime('2026-10-29T09:00:00+08:00', 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('Z 结尾的 ISO 按 UTC 解析', () => {
    const ms = parseAbsoluteTime('2026-10-29T01:00:00Z', 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('不带时区的 "YYYY-MM-DD HH:mm" 按配置时区解释', () => {
    const ms = parseAbsoluteTime('2026-10-29 09:00', 'Asia/Shanghai')
    // 北京时间 9 点 = UTC 1 点
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('同一个墙上时间在不同时区解析成不同时刻', () => {
    const shanghai = parseAbsoluteTime('2026-10-29 09:00', 'Asia/Shanghai')
    const utc = parseAbsoluteTime('2026-10-29 09:00', 'UTC')
    expect(shanghai).not.toBe(utc)
    // 上海比 UTC 早 8 小时
    expect(utc! - shanghai!).toBe(8 * 3600 * 1000)
  })

  it('支持 T 分隔符', () => {
    const withSpace = parseAbsoluteTime('2026-10-29 09:00', 'Asia/Shanghai')
    const withT = parseAbsoluteTime('2026-10-29T09:00', 'Asia/Shanghai')
    expect(withT).toBe(withSpace)
  })

  it('支持带秒', () => {
    const ms = parseAbsoluteTime('2026-10-29 09:00:30', 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 30))
  })

  it('非法输入返回 null', () => {
    expect(parseAbsoluteTime('明天早上', 'Asia/Shanghai')).toBeNull()
    expect(parseAbsoluteTime('', 'Asia/Shanghai')).toBeNull()
  })

  it('时区非法时不崩，按 UTC 解释', () => {
    const ms = parseAbsoluteTime('2026-10-29 09:00', 'Not/AZone')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 9, 0, 0))
  })
})

describe('zonedTimeToEpoch', () => {
  it('北京时间 9 点换算成 UTC 1 点', () => {
    const ms = zonedTimeToEpoch(2026, 10, 29, 9, 0, 0, 'Asia/Shanghai')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 1, 0, 0))
  })

  it('UTC 时区不偏移', () => {
    const ms = zonedTimeToEpoch(2026, 10, 29, 9, 0, 0, 'UTC')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 9, 0, 0))
  })

  it('跨日边界正确（洛杉矶比 UTC 晚 7 小时，夏令时）', () => {
    // 2026-10-29 洛杉矶是 PDT（UTC-7）
    const ms = zonedTimeToEpoch(2026, 10, 29, 9, 0, 0, 'America/Los_Angeles')
    expect(ms).toBe(Date.UTC(2026, 9, 29, 16, 0, 0))
  })
})

/**
 * `schedule.create` 的**运行时**校验。
 *
 * inputSchema 的 `minimum: 60` 只是给模型看的提示：全仓没有 JSON Schema 校验器，
 * 模型照样能传 0 / -60 / 0.001。而 repeat_seconds 极小时 `advanceSchedule` 的
 * 推进循环会真死循环（实测 500 万次未退出），一次 cron 拖死整个 invocation 里
 * 所有插件的定时任务。所以必须在 execute 里自己拦。
 */
describe('schedule.create 的 repeat_seconds 运行时校验', () => {
  const baseContext = {
    conversationId: 'group:g1',
    actorId: 'u1',
    actorRole: 'member' as const,
    scene: 'group',
    targetId: 'g1',
    runId: 'run-1',
    stepId: 'step-1',
    toolCallId: 'c1',
    timezone: 'Asia/Shanghai',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }

  /** 记录写入的 db。校验失败时不该有任何写入 */
  function recordingDb(): {
    db: {
      run: (sql: string, ...params: unknown[]) => Promise<{ changes: number }>
      all: () => Promise<never[]>
      first: () => Promise<null>
      exec: () => Promise<void>
      table: (n: string) => string
    }
    rows: unknown[][]
  } {
    const rows: unknown[][] = []
    return {
      rows,
      db: {
        async run(_sql: string, ...params: unknown[]) {
          rows.push(params)
          return { changes: 1 }
        },
        async all() {
          return []
        },
        async first() {
          return null
        },
        async exec() {},
        table: (n: string) => `p_agent_${n}`,
      },
    }
  }

  function createTool() {
    const tool = createScheduleTools().find((t) => t.definition.name === 'schedule.create')
    if (!tool) throw new Error('没找到 schedule.create')
    return tool
  }

  async function runCreate(input: Record<string, unknown>) {
    const { db, rows } = recordingDb()
    const tool = createTool()
    const result = await tool.execute({
      ...baseContext,
      db: db as unknown as Parameters<typeof tool.execute>[0]['db'],
      input,
    })
    return { result, rows }
  }

  it('重复间隔少于 60 秒被拒绝，且不写库', async () => {
    const { result, rows } = await runCreate({ delay_seconds: 600, prompt: '提醒', repeat_seconds: 30 })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
    expect(result.error?.message).toContain('60')
    expect(rows).toEqual([])
  })

  it('repeat_seconds = 0 被拒绝（旧版会接受，然后推进时死循环）', async () => {
    const { result, rows } = await runCreate({ delay_seconds: 600, prompt: '提醒', repeat_seconds: 0 })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
    expect(rows).toEqual([])
  })

  it('负数的 repeat_seconds 被拒绝', async () => {
    const { result } = await runCreate({ delay_seconds: 600, prompt: '提醒', repeat_seconds: -60 })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
  })

  it('小数秒被拒绝（不是整数秒）', async () => {
    const { result } = await runCreate({ delay_seconds: 600, prompt: '提醒', repeat_seconds: 60.5 })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
    expect(result.error?.message).toContain('整数')
  })

  it('Infinity / NaN 被拒绝', async () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const { result } = await runCreate({ delay_seconds: 600, prompt: '提醒', repeat_seconds: value })
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('bad_request')
    }
  })

  it('超过一年的重复间隔被拒绝', async () => {
    const { result } = await runCreate({
      delay_seconds: 600,
      prompt: '提醒',
      repeat_seconds: 366 * 24 * 3600,
    })
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
  })

  it('合法的 60 秒通过，并写进库', async () => {
    const { result, rows } = await runCreate({ delay_seconds: 600, prompt: '提醒', repeat_seconds: 60 })
    expect(result.status).toBe('success')
    expect(rows).toHaveLength(1)
    // createSchedule 的参数顺序：id, conversation, scene, targetId, prompt, dueAt, repeatSeconds, ...
    expect(rows[0]?.[6]).toBe(60)
    expect((result.output as { repeatSeconds: number }).repeatSeconds).toBe(60)
  })

  it('不传 repeat_seconds 的一次性任务照常创建', async () => {
    const { result, rows } = await runCreate({ delay_seconds: 600, prompt: '提醒' })
    expect(result.status).toBe('success')
    expect(rows[0]?.[6]).toBeNull()
  })
})
