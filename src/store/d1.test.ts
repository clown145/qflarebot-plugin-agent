import { describe, expect, it } from 'vitest'
import type { PluginDB } from '@qqbot/sdk'
import {
  advanceSchedule,
  cancelSchedule,
  listAllSchedules,
  listSchedules,
  listToolAudit,
  pruneToolAudit,
} from './d1.js'
import type { ScheduleRow } from './d1.js'

/** 记录 SQL 与参数的假 db */
function recordingDb(rows: unknown[] = []): { db: PluginDB; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    async run(sql: string, ...params: unknown[]) {
      calls.push({ sql, params })
      return { changes: 1 }
    },
    async all(sql: string, ...params: unknown[]) {
      calls.push({ sql, params })
      return rows
    },
    async first() {
      return null
    },
    async exec() {},
    table: (n: string) => `p_agent_${n}`,
  } as unknown as PluginDB
  return { db, calls }
}

function scheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 's1',
    conversation: 'group:g1',
    scene: 'group',
    target_id: 'g1',
    prompt: '提醒喝水',
    due_at: Date.now() + 60_000,
    repeat_seconds: null,
    status: 'active',
    created_by: 'u1',
    created_at: Date.now(),
    last_run_at: null,
    ...overrides,
  }
}

describe('listSchedules（按会话）', () => {
  it('SQL 里带 conversation 过滤', async () => {
    const { db, calls } = recordingDb([])
    await listSchedules(db, 'group:g1', 10)
    expect(calls[0]?.sql).toContain('WHERE conversation = ?')
    expect(calls[0]?.params).toEqual(['group:g1', 10])
  })

  it('只取 active 的，按到期时间升序', async () => {
    const { db, calls } = recordingDb([])
    await listSchedules(db, 'group:g1')
    expect(calls[0]?.sql).toContain("status = 'active'")
    expect(calls[0]?.sql).toContain('ORDER BY due_at ASC')
  })
})

describe('listAllSchedules（跨会话，管理页用）', () => {
  it('不带 conversation 过滤——这正是上一版管理页的 bug', async () => {
    const { db, calls } = recordingDb([])
    await listAllSchedules(db, 50)
    expect(calls[0]?.sql).not.toContain('conversation = ?')
    expect(calls[0]?.sql).toContain("status = 'active'")
    expect(calls[0]?.params).toEqual([50])
  })

  it('能返回多个会话的任务', async () => {
    const rows = [
      scheduleRow({ id: 'a', conversation: 'group:g1' }),
      scheduleRow({ id: 'b', conversation: 'c2c:u1' }),
    ]
    const { db } = recordingDb(rows)
    const result = await listAllSchedules(db)
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.conversation)).toEqual(['group:g1', 'c2c:u1'])
  })
})

describe('advanceSchedule', () => {
  it('一次性任务标成 done', async () => {
    const { db, calls } = recordingDb()
    await advanceSchedule(db, scheduleRow({ repeat_seconds: null }), Date.now())
    expect(calls[0]?.sql).toContain("status = 'done'")
  })

  it('重复任务把 due_at 往后推', async () => {
    const now = Date.now()
    const row = scheduleRow({ due_at: now, repeat_seconds: 3600 })
    const { db, calls } = recordingDb()
    await advanceSchedule(db, row, now)
    expect(calls[0]?.sql).toContain('UPDATE {schedules} SET due_at = ?')
    // 新的 due_at 应该在将来
    const nextDue = calls[0]?.params[0] as number
    expect(nextDue).toBeGreaterThan(now)
  })

  it('跳过已经错过的周期：离线一天后不该补跑几十次', async () => {
    const dayAgo = Date.now() - 24 * 3600 * 1000
    // 每小时一次，上次应该在 24 小时前
    const row = scheduleRow({ due_at: dayAgo, repeat_seconds: 3600 })
    const now = Date.now()
    const { db, calls } = recordingDb()
    await advanceSchedule(db, row, now)

    const nextDue = calls[0]?.params[0] as number
    // 只推进到「未来最近的一次」，不是逐次补齐。
    // 边界：正好落在整点上时差值可以等于一个间隔，所以用 <=
    expect(nextDue).toBeGreaterThan(now)
    expect(nextDue - now).toBeLessThanOrEqual(3600 * 1000)
  })

  it('带 status 条件做乐观锁，cron 并发时只有一个能推进', async () => {
    const { db, calls } = recordingDb()
    await advanceSchedule(db, scheduleRow(), Date.now())
    expect(calls[0]?.sql).toContain("status = 'active'")
  })
})

describe('cancelSchedule', () => {
  it('只取消本会话的任务（不能跨会话删别人的）', async () => {
    const { db, calls } = recordingDb()
    await cancelSchedule(db, 's1', 'group:g1')
    expect(calls[0]?.sql).toContain('conversation = ?')
    expect(calls[0]?.params).toEqual(['s1', 'group:g1'])
  })

  it('changes 为 0 时返回 false', async () => {
    const db = {
      async run() {
        return { changes: 0 }
      },
    } as unknown as PluginDB
    expect(await cancelSchedule(db, 'nope', 'group:g1')).toBe(false)
  })
})

describe('listToolAudit', () => {
  it('按时间倒序，取最近 N 条', async () => {
    const { db, calls } = recordingDb([])
    await listToolAudit(db, 30)
    expect(calls[0]?.sql).toContain('ORDER BY created_at DESC')
    expect(calls[0]?.params).toEqual([30])
  })
})

describe('pruneToolAudit', () => {
  it('删除早于阈值的记录并返回删除行数', async () => {
    const { db, calls } = recordingDb()
    const removed = await pruneToolAudit(db, Date.now() - 86400_000)
    expect(calls[0]?.sql).toContain('DELETE FROM {tool_audit}')
    expect(removed).toBe(1)
  })
})
