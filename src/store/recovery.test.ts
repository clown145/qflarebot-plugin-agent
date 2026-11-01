import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from './sqlite-test-db.js'
import { dueRecovery, finishRecovery, trackRecovery } from './recovery.js'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
function setup() {
  const store = createTestDb()
  cleanup.push(() => store.close())
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  return { db: store.db, advance: (ms: number) => { now += ms } }
}

describe('持久恢复索引', () => {
  it('超过 20 个会话仍可恢复，分批扫描不会饿死后面的会话', async () => {
    const { db } = setup()
    for (let i = 0; i < 65; i++) await trackRecovery(db, `group:${i.toString().padStart(2, '0')}`)
    const first = await dueRecovery(db, Date.now())
    expect(first).toHaveLength(50)
    for (const entry of first) await finishRecovery(db, entry, Date.now() + 60_000)
    const second = await dueRecovery(db, Date.now())
    expect(second).toHaveLength(15)
    expect(new Set([...first, ...second].map(row => row.conversation)).size).toBe(65)
  })

  it('扫描期间的新消息不会被旧扫描者删除或延后，旧 KV 迁移不覆盖新登记', async () => {
    const { db, advance } = setup()
    await trackRecovery(db, 'group:g')
    const [old] = await dueRecovery(db, Date.now())
    advance(180_000)
    await trackRecovery(db, 'group:g')
    const [fresh] = await dueRecovery(db, Date.now())
    await finishRecovery(db, old!, null)
    await finishRecovery(db, old!, Date.now() + 600_000)
    await trackRecovery(db, 'group:g', true)
    expect(await dueRecovery(db, Date.now())).toEqual([fresh])
  })

  it('登记后尚未入队时的空扫描保留恢复入口，宽限期后清掉真正空闲的会话', async () => {
    const { db, advance } = setup()
    await trackRecovery(db, 'group:g')
    const [entry] = await dueRecovery(db, Date.now())
    await finishRecovery(db, entry!, null)
    expect(await dueRecovery(db, Date.now())).toEqual([])
    advance(120_000)
    const [retry] = await dueRecovery(db, Date.now())
    expect(retry?.conversation).toBe('group:g')
    await finishRecovery(db, retry!, null)
    expect(await dueRecovery(db, Date.now() + 86400_000)).toEqual([])
  })
})
