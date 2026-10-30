import { describe, expect, it, vi } from 'vitest'
import { ensureColumns, type RequiredColumn } from './migrate.js'
import type { Logger, PluginDB } from '@qqbot/sdk'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const column: RequiredColumn = {
  table: 'tool_settings',
  column: 'config_json',
  ddl: "ALTER TABLE {tool_settings} ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'",
}

/** 假 db：`have` 里的列视为已存在 */
function fakeDb(have: string[], options: { failAlter?: string; tableMissing?: boolean } = {}) {
  const executed: string[] = []
  const db = {
    async all(sql: string) {
      if (sql.startsWith('PRAGMA table_info')) {
        return options.tableMissing ? [] : have.map((name) => ({ name }))
      }
      return []
    },
    async exec(sql: string) {
      executed.push(sql)
      if (options.failAlter) throw new Error(options.failAlter)
    },
    table: (n: string) => `p_agent_${n}`,
  } as unknown as PluginDB
  return { db, executed }
}

describe('ensureColumns', () => {
  it('缺列时执行 ALTER TABLE', async () => {
    const { db, executed } = fakeDb(['id', 'disabled_json', 'updated_at'])
    await ensureColumns({ db, logger }, [column])
    expect(executed).toEqual([column.ddl])
  })

  it('列已存在时什么都不做（新装用户走这条路）', async () => {
    const { db, executed } = fakeDb(['id', 'disabled_json', 'config_json', 'updated_at'])
    await ensureColumns({ db, logger }, [column])
    expect(executed).toEqual([])
  })

  it('表还不存在时跳过（建表语句会负责）', async () => {
    const { db, executed } = fakeDb([], { tableMissing: true })
    await ensureColumns({ db, logger }, [column])
    expect(executed).toEqual([])
  })

  it('并发冷启动撞 duplicate column 不算失败，不告警', async () => {
    const { db } = fakeDb(['id'], { failAlter: 'duplicate column name: config_json' })
    const warn = vi.fn()
    await ensureColumns({ db, logger: { ...logger, warn } }, [column])
    expect(warn).not.toHaveBeenCalled()
  })

  it('其他错误只告警，不抛出（不能因为补列失败让插件不可用）', async () => {
    const { db } = fakeDb(['id'], { failAlter: 'database is locked' })
    const warn = vi.fn()
    await expect(ensureColumns({ db, logger: { ...logger, warn } }, [column])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('补列失败', expect.objectContaining({ column: 'config_json' }))
  })

  it('PRAGMA 返回非数组时跳过，不崩', async () => {
    const db = {
      async all() { return undefined },
      async exec() { throw new Error('不该执行') },
      table: (n: string) => n,
    } as unknown as PluginDB
    await expect(ensureColumns({ db, logger }, [column])).resolves.toBeUndefined()
  })
})
