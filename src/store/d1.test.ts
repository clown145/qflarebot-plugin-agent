import { describe, expect, it } from 'vitest'
import type { PluginDB } from '@qqbot/sdk'
import {
  advanceSchedule,
  cancelSchedule,
  listDueSchedules,
  nextDueAt,
  listAllSchedules,
  listSchedules,
  listToolAudit,
  pruneToolAudit,
} from './d1.js'
import type { ScheduleRow } from './d1.js'
import { createTestDb } from './sqlite-test-db.js'

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

/**
 * `advanceSchedule` 的死循环防御。
 *
 * 原实现是 `while (nextDue <= ranAt) nextDue += repeat_seconds * 1000`。
 * `repeat_seconds = 0` / `0.001` 时步长为 0 或极小 → **真死循环**（不是慢，是永不退出，
 * 事件循环被占死、连测试超时定时器都跑不了）。它不是理论问题：
 * `schedule.create` 的 `minimum: 60` 只是给模型看的，旧版本无任何运行时校验，
 * 这些坏值已经躺在线上 D1 里了——修好写入入口修不了已有数据。
 *
 * 所以先测**纯函数** `nextDueAt`（直接证明不循环、结果正确），
 * 再测 `advanceSchedule` 对坏行的处理（标 done，而不是抛错或挂死）。
 */
describe('nextDueAt（推进算法，纯函数）', () => {
  it('间隔合法且尚未到点：推进一个间隔', () => {
    expect(nextDueAt(1_000_000, 60, 1_000_000)).toBe(1_060_000)
    expect(nextDueAt(1_000_000, 60, 1_000_000 - 5000)).toBe(1_060_000)
  })

  it('已过期半个周期：仍推进到下一个整周期', () => {
    expect(nextDueAt(1_000_000, 60, 1_030_000)).toBe(1_060_000)
  })

  it('已过期一个半周期：跳过中间的，落到再下一个（不补跑）', () => {
    expect(nextDueAt(1_000_000, 60, 1_090_000)).toBe(1_120_000)
  })

  it('离线一年 + 60 秒间隔：一次算术算出结果，不迭代 52 万次', () => {
    const due = 1_000_000
    const ranAt = due + 365 * 24 * 3600 * 1000
    const started = performance.now()
    const next = nextDueAt(due, 60, ranAt)
    // O(1)：真按 while 累加的话这条会挂死
    expect(performance.now() - started).toBeLessThan(50)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(ranAt)
    expect(next! - ranAt).toBeLessThanOrEqual(60_000)
  })

  it('结果永远严格大于 ranAt（否则 cron 会立刻再跑一次）', () => {
    for (const ranAt of [0, 1, 59_999, 60_000, 60_001, 123_456_789]) {
      for (const repeat of [60, 61, 3600, 86400]) {
        const next = nextDueAt(0, repeat, ranAt)
        expect(next).not.toBeNull()
        expect(next!).toBeGreaterThan(ranAt)
      }
    }
  })

  it('repeat_seconds 为 0 / 负数 / 非有限数 / 过小时返回 null（调用方标 done）', () => {
    const now = Date.now()
    const bad = [0, -60, -0.001, 0.001, 1e-6, 1e-9, 0.5, 59, Number.NaN, Number.POSITIVE_INFINITY]
    for (const value of bad) {
      // 死循环防护的核心断言：这些值一律不进入推进，直接返回 null。
      // 其中 <= 2.4e-7 的时间戳 ULP 场景会让 `nextDue += step` 成为**恒等操作**，
      // 原实现里那是真·无限循环；0.001 / 1e-6 则是 6 万 / 6000 万次迭代的实质挂死。
      expect(nextDueAt(now - 1000, value, now), `repeat=${value}`).toBeNull()
    }
    expect(nextDueAt(now, null, now)).toBeNull()
    expect(nextDueAt(now, undefined, now)).toBeNull()
  })

  it('最小合法值 60 秒可用', () => {
    expect(nextDueAt(0, 60, 0)).toBe(60_000)
  })
})

describe('advanceSchedule 对库里坏行的处理', () => {
  it('repeat_seconds = 0 的坏行标 done，不挂死（有超时保护）', async () => {
    const { db, calls } = recordingDb()
    const now = Date.now()
    const finished = await Promise.race([
      advanceSchedule(db, scheduleRow({ due_at: now - 1000, repeat_seconds: 0 }), now).then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ])
    expect(finished).toBe('done')
    expect(calls[0]?.sql).toContain("status = 'done'")
  })

  it('负数 / 极小正数也标 done', async () => {
    const now = Date.now()
    for (const bad of [-60, 0.001]) {
      const { db, calls } = recordingDb()
      await advanceSchedule(db, scheduleRow({ due_at: now - 1000, repeat_seconds: bad }), now)
      expect(calls[0]?.sql).toContain("status = 'done'")
    }
  })

  it('合法间隔照常推进 due_at', async () => {
    const { db, calls } = recordingDb()
    const due = 1_000_000
    await advanceSchedule(db, scheduleRow({ due_at: due, repeat_seconds: 3600 }), due + 10_000)
    expect(calls[0]?.sql).toContain('UPDATE {schedules} SET due_at = ?')
    expect(calls[0]?.params[0]).toBe(due + 3_600_000)
  })
})

/**
 * 上面的用例都是「断言 SQL 字符串」，证明不了**真实 SQL 上的状态变化**。
 * 这一段换成真实 SQLite（`node:sqlite`），验的是「跑完之后库里的行到底变成什么样」：
 * 乐观锁是否真的只让一个推进成功、标 done 之后是否真的不再被到期扫描扫到。
 *
 * 这正是 vfs 那边的教训：只断言 SQL 文本，`LIKE` 少个 ESCAPE、`INSERT` 少一列
 * 都测不出来（那边的手写假件甚至自己实现了正确行为）。
 */
describe('advanceSchedule 在真实 SQLite 上的状态变化', () => {
  function seed(t: ReturnType<typeof createTestDb>, row: Partial<{ id: string; due_at: number; repeat_seconds: number | null }>): void {
    t.raw
      .prepare(
        `INSERT INTO p_agent_schedules
           (id, conversation, scene, target_id, prompt, due_at, repeat_seconds, status, created_by, created_at)
         VALUES (?, 'group:g1', 'group', 'g1', '提醒', ?, ?, 'active', 'u1', 1)`,
      )
      .run(row.id ?? 's1', row.due_at ?? Date.now(), row.repeat_seconds ?? null)
  }

  function readRow(t: ReturnType<typeof createTestDb>, id: string): ScheduleRow {
    return t.raw.prepare(t.scope(`SELECT * FROM {schedules} WHERE id = ?`)).get(id) as unknown as ScheduleRow
  }

  it('一次性任务推进后 status 变成 done，且不再被到期扫描扫到', async () => {
    const t = createTestDb()
    const now = Date.now()
    seed(t, { id: 'once', due_at: now - 1000, repeat_seconds: null })

    // 到期扫描能扫到它
    expect((await listDueSchedules(t.db, now)).map((r) => r.id)).toContain('once')

    const row = readRow(t, 'once')
    await advanceSchedule(t.db, row, now)

    expect(readRow(t, 'once').status).toBe('done')
    // 关键：标 done 之后不再触发，否则会无限重复提醒
    expect((await listDueSchedules(t.db, now)).map((r) => r.id)).not.toContain('once')
    t.close()
  })

  it('重复任务推进后 due_at 落到将来，且仍在 active 里', async () => {
    const t = createTestDb()
    const now = Date.now()
    seed(t, { id: 'rep', due_at: now - 3 * 3600_000, repeat_seconds: 3600 })

    await advanceSchedule(t.db, readRow(t, 'rep'), now)

    const after = readRow(t, 'rep')
    expect(after.status).toBe('active')
    expect(after.due_at).toBeGreaterThan(now)
    expect(after.due_at - now).toBeLessThanOrEqual(3600_000)
    expect(after.last_run_at).toBe(now)
    t.close()
  })

  it('乐观锁真的生效：同一个 active 行被推进两次，第二次的 WHERE 匹配不到行', async () => {
    const t = createTestDb()
    const now = Date.now()
    seed(t, { id: 'once2', due_at: now - 1000, repeat_seconds: null })
    const row = readRow(t, 'once2')

    // 两个 cron 并发：都持有同一份 row 快照
    await advanceSchedule(t.db, row, now)
    const first = readRow(t, 'once2')
    // 第二次推进（用旧快照）：WHERE id = ? AND status = 'active' 此时匹配不到
    await advanceSchedule(t.db, row, now + 5000)

    const second = readRow(t, 'once2')
    // last_run_at 不该被第二次覆盖——说明 UPDATE 确实没命中
    expect(second.last_run_at).toBe(first.last_run_at)
    expect(second.status).toBe('done')
    t.close()
  })

  it('库里的坏行（repeat_seconds = 1e-9）被推进后标 done，cron 不再挂死', async () => {
    const t = createTestDb()
    const now = Date.now()
    // 1e-9 秒 = 1e-6 ms 的步长，远小于时间戳量级的 double ULP（≈0.000244 ms）：
    // 原实现里 `nextDue += step` 完全不改变数值 → **真·无限循环**，测试直接挂死
    seed(t, { id: 'bad', due_at: now - 60_000, repeat_seconds: 1e-9 })

    // 先确认它确实会被扫到（这就是线上会把 cron 拖死的那一行）
    expect((await listDueSchedules(t.db, now)).map((r) => r.id)).toContain('bad')

    // 有超时保护：真死循环时这条会超时失败，而不是把整个测试文件挂住
    await Promise.race([
      advanceSchedule(t.db, readRow(t, 'bad'), now),
      new Promise((_, reject) => setTimeout(() => reject(new Error('advanceSchedule 死循环')), 3000)),
    ])

    expect(readRow(t, 'bad').status).toBe('done')
    expect((await listDueSchedules(t.db, now)).map((r) => r.id)).not.toContain('bad')
    t.close()
  })

  it('整数秒间隔不会因浮点误差算出「不在将来」的 due_at（否则 cron 会连环触发）', async () => {
    const t = createTestDb()
    seed(t, { id: 'fp', due_at: 0, repeat_seconds: 60 })
    // 取一些容易踩浮点边界的 ranAt
    for (const ranAt of [59_999, 60_000, 60_001, 119_999, 120_000]) {
      await advanceSchedule(t.db, readRow(t, 'fp'), ranAt)
      expect(readRow(t, 'fp').due_at).toBeGreaterThan(ranAt)
    }
    t.close()
  })
})
