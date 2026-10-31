/**
 * 列迁移测试。**跑真实 SQLite**（`node:sqlite`），因为要验证的正是 SQL 语义：
 * `SELECT <col> … LIMIT 0` 在缺列时到底报什么、`ALTER TABLE ADD COLUMN` 在列已存在时
 * 到底报什么。假 db 上这两条都可以随便编，测不出任何东西。
 *
 * 另外有一条**契约测试**直接扫 `COLUMN_MIGRATIONS`：新增的列必须同时出现在
 * `schema.ts` 的建表语句里（新库靠建表、老库靠迁移，两边不能漂）。
 */
import { describe, expect, it } from 'vitest'
import type { PluginDB } from '@qqbot/sdk'
import { scopeSql, flattenForExec, tablePrefix } from '@qqbot/sdk/sqlScope'
import { DatabaseSync } from 'node:sqlite'
import { COLUMN_MIGRATIONS, ensureColumnMigrations, type MigrationLogger } from './migrate.js'
import { SCHEMA_STATEMENTS } from './schema.js'
import { createTestDb } from './sqlite-test-db.js'

function recordingLogger(): MigrationLogger & { warns: string[]; infos: string[] } {
  const warns: string[] = []
  const infos: string[] = []
  return {
    warns,
    infos,
    warn(message: string) {
      warns.push(message)
    },
    info(message: string) {
      infos.push(message)
    },
  }
}

/**
 * 造一个「老库」：`{tool_settings}` 只有 v0.1.0 的三列，没有 `config_json`。
 *
 * 这正是线上老部署的形状——建表语句早就在库里躺着了，`CREATE TABLE IF NOT EXISTS`
 * 再跑一百遍也不会给它加列。
 */
function createLegacyDb(): ReturnType<typeof createTestDb> {
  const t = createTestDb({ schema: 'none' })
  t.raw.exec(
    flattenForExec(
      scopeSql(
        `CREATE TABLE IF NOT EXISTS {tool_settings} (
           id TEXT PRIMARY KEY,
           disabled_json TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         ) WITHOUT ROWID`,
        t.prefix,
      ),
    ),
  )
  return t
}

function columnsOf(t: ReturnType<typeof createTestDb>, table: string): string[] {
  // 测试自己看结构可以用 PRAGMA（框架的禁令只作用于 ctx.db，这里直接走原生句柄）
  return (t.raw.prepare(`PRAGMA table_info(p_agent_${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  )
}

describe('ensureColumnMigrations（真实 SQLite）', () => {
  it('老库缺 config_json 时能补上，且补完可读可写', async () => {
    const t = createLegacyDb()
    expect(columnsOf(t, 'tool_settings')).toEqual(['id', 'disabled_json', 'updated_at'])

    const logger = recordingLogger()
    const result = await ensureColumnMigrations(t.db, logger)

    expect(result.added).toContain('tool_settings.config_json')
    expect(columnsOf(t, 'tool_settings')).toContain('config_json')

    // 补完的列真能用：写一行再读回来
    await t.db.run(
      `INSERT INTO {tool_settings} (id, disabled_json, config_json, updated_at) VALUES (?, ?, ?, ?)`,
      'default',
      '[]',
      JSON.stringify({ 'search.web': { apiKey: 'k' } }),
      1,
    )
    const row = await t.db.first<{ config_json: string }>(
      `SELECT config_json FROM {tool_settings} WHERE id = ?`,
      'default',
    )
    expect(JSON.parse(row!.config_json)).toEqual({ 'search.web': { apiKey: 'k' } })
    t.close()
  })

  it('老库已有的行拿到默认值 {}，不必回填', async () => {
    const t = createLegacyDb()
    // 老数据：v0.1.0 写的行
    t.raw.exec(
      `INSERT INTO p_agent_tool_settings (id, disabled_json, updated_at) VALUES ('default', '["a"]', 1)`,
    )

    await ensureColumnMigrations(t.db, recordingLogger())

    const row = await t.db.first<{ disabled_json: string; config_json: string }>(
      `SELECT disabled_json, config_json FROM {tool_settings} WHERE id = ?`,
      'default',
    )
    expect(row?.disabled_json).toBe('["a"]')
    expect(row?.config_json).toBe('{}')
    t.close()
  })

  it('列已存在时不重复 ADD COLUMN，也不报错', async () => {
    const t = createTestDb() // full schema：config_json 已经在建表语句里
    const logger = recordingLogger()

    const result = await ensureColumnMigrations(t.db, logger)

    expect(result.added).toEqual([])
    expect(result.present).toContain('tool_settings.config_json')
    expect(result.failed).toEqual([])
    expect(logger.warns).toEqual([])
    t.close()
  })

  it('并发补列：别人抢先补上（duplicate column）算成功，不算失败', async () => {
    const t = createLegacyDb()
    const logger = recordingLogger()
    const db = t.db

    // 两个 isolate 同时探测到缺列 → 都去 ALTER。这里用一个包装器模拟
    // 「探测通过之后、ALTER 之前，另一个 isolate 把列补好了」
    const racingDb: Pick<PluginDB, 'all' | 'run'> = {
      all: (sql, ...params) => db.all(sql, ...params),
      async run(sql, ...params) {
        if (sql.includes('ALTER TABLE')) {
          // 抢先者：用原生句柄直接补上，于是我们的 ALTER 会撞 duplicate column
          t.raw.exec(`ALTER TABLE p_agent_tool_settings ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'`)
        }
        return db.run(sql, ...params)
      },
    }

    const result = await ensureColumnMigrations(racingDb, logger)

    expect(result.added).toEqual([])
    expect(result.present).toContain('tool_settings.config_json')
    expect(result.failed).toEqual([])
    expect(logger.warns).toEqual([])
    t.close()
  })

  it('探测遇到「没有这个表」时只 warn 不抛，也不去 ALTER', async () => {
    const t = createTestDb({ schema: 'none' }) // 空库：表根本不存在
    const logger = recordingLogger()

    const result = await ensureColumnMigrations(t.db, logger)

    expect(result.failed).toContain('tool_settings.config_json')
    expect(result.added).toEqual([])
    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toContain('探测失败')
    t.close()
  })

  it('ALTER 本身失败（非 duplicate）时只 warn 不抛', async () => {
    const t = createLegacyDb()
    const logger = recordingLogger()

    // 只读库会拒绝 ALTER，这里用一个必定报错的 db 模拟 D1 抖动
    const db: Pick<PluginDB, 'all' | 'run'> = {
      all: (sql, ...params) => t.db.all(sql, ...params),
      async run() {
        throw new Error('D1_ERROR: internal error while executing query')
      },
    }

    const result = await ensureColumnMigrations(db, logger)

    expect(result.failed).toContain('tool_settings.config_json')
    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toContain('补列失败')
    t.close()
  })

  it('PRAGMA 在插件 SQL 上被框架拒绝——这就是不用它探测列的原因', async () => {
    const t = createTestDb()
    // ctx.db 这一层会过 scopeSql；PRAGMA 直接抛错。保留这条用例，
    // 防止以后有人把实现改回 PRAGMA table_info
    await expect(t.db.all('PRAGMA table_info({tool_settings})')).rejects.toThrow('PRAGMA')
    t.close()
  })

  it('迁移是幂等的：连跑两次第二次什么都不做', async () => {
    const t = createLegacyDb()
    const first = await ensureColumnMigrations(t.db, recordingLogger())
    const second = await ensureColumnMigrations(t.db, recordingLogger())

    expect(first.added).toEqual(['tool_settings.config_json'])
    expect(second.added).toEqual([])
    expect(second.present).toContain('tool_settings.config_json')
    expect(columnsOf(t, 'tool_settings').filter((name) => name === 'config_json')).toHaveLength(1)
    t.close()
  })

  it('表名/列名不是合法标识符时跳过，不把字符串拼进 SQL', async () => {
    const t = createTestDb()
    const logger = recordingLogger()
    const result = await ensureColumnMigrations(t.db, logger, [
      { table: 'tool_settings; DROP TABLE x', column: 'evil', definition: 'TEXT' },
    ])
    expect(result.failed).toHaveLength(1)
    expect(logger.warns[0]).toContain('不合法')
    t.close()
  })

  it('可以注入自定义迁移清单（表结构不同的插件复用同一套逻辑）', async () => {
    const t = createTestDb({ schema: 'none' })
    t.raw.exec('CREATE TABLE p_agent_custom (id TEXT PRIMARY KEY) WITHOUT ROWID')

    const result = await ensureColumnMigrations(
      t.db,
      recordingLogger(),
      [{ table: 'custom', column: 'note', definition: `TEXT NOT NULL DEFAULT ''` }],
    )

    expect(result.added).toEqual(['custom.note'])
    expect(
      (t.raw.prepare('PRAGMA table_info(p_agent_custom)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(['id', 'note'])
    t.close()
  })
})

/**
 * 契约测试：迁移清单与建表语句不能漂。
 *
 * 为什么值得单独测：新库走建表、老库走迁移，两条路径一旦不一致，
 * 新装用户一切正常、升级用户莫名 500——而且只在线上老部署上复现。
 */
describe('COLUMN_MIGRATIONS 与 SCHEMA_STATEMENTS 的一致性', () => {
  it('每条迁移的列都出现在对应表的建表语句里', () => {
    for (const migration of COLUMN_MIGRATIONS) {
      const ddl = SCHEMA_STATEMENTS.find((statement) =>
        statement.includes(`{${migration.table}}`),
      )
      expect(ddl, `schema.ts 里没有 {${migration.table}} 的建表语句`).toBeDefined()
      expect(ddl).toContain(migration.column)
    }
  })

  it('至少覆盖了 config_json（老库 500 的那一列）', () => {
    expect(COLUMN_MIGRATIONS).toContainEqual(
      expect.objectContaining({ table: 'tool_settings', column: 'config_json' }),
    )
  })

  it('迁移清单满足 SQLite ADD COLUMN 的限制：不带 PRIMARY KEY / UNIQUE，NOT NULL 有默认值', () => {
    for (const migration of COLUMN_MIGRATIONS) {
      const definition = migration.definition.toUpperCase()
      expect(definition, `${migration.table}.${migration.column} 不能用 PRIMARY KEY`).not.toContain(
        'PRIMARY KEY',
      )
      expect(definition, `${migration.table}.${migration.column} 不能用 UNIQUE`).not.toContain('UNIQUE')
      if (definition.includes('NOT NULL')) {
        expect(
          definition,
          `${migration.table}.${migration.column} 带 NOT NULL 时必须给默认值`,
        ).toContain('DEFAULT')
      }
    }
  })

  it('原始建表语句里 config_json 带 DEFAULT，新库同样拿到空配置', () => {
    const ddl = SCHEMA_STATEMENTS.find((statement) => statement.includes('{tool_settings}')) ?? ''
    expect(ddl).toContain('config_json')
    // 新库靠建表语句的 DEFAULT；老库靠迁移清单的 DEFAULT。两处语义必须一致
    expect(ddl).toContain(`DEFAULT '{}'`)
  })
})

describe('config_json 默认值语义', () => {
  it('建表语句与迁移清单给的是同一个默认值 {}', async () => {
    const t = createTestDb()
    t.raw.exec(
      `INSERT INTO p_agent_tool_settings (id, disabled_json, updated_at) VALUES ('default', '[]', 1)`,
    )
    const fresh = await t.db.first<{ config_json: string }>(
      `SELECT config_json FROM {tool_settings} WHERE id = ?`,
      'default',
    )
    expect(fresh?.config_json).toBe('{}')
    t.close()

    const legacy = createLegacyDb()
    legacy.raw.exec(
      `INSERT INTO p_agent_tool_settings (id, disabled_json, updated_at) VALUES ('default', '[]', 1)`,
    )
    await ensureColumnMigrations(legacy.db, recordingLogger())
    const migrated = await legacy.db.first<{ config_json: string }>(
      `SELECT config_json FROM {tool_settings} WHERE id = ?`,
      'default',
    )
    expect(migrated?.config_json).toBe('{}')
    legacy.close()
  })
})

/**
 * 端到端：插件的 `onBoot` 钩子（升级路径）真的会把老库的列补上。
 *
 * 这一层测的是**接线**：`ensureSchema()` 里建表之后有没有真的调用迁移。
 * 只测 `ensureColumnMigrations` 本身的话，「忘了在 ensureSchema 里调用它」
 * 这个最容易犯的错完全测不出来（表建好了、迁移没跑、线上照样 500）。
 *
 * 用真实 `plugin.hooks.onBoot` + 真实 SQLite，不 mock 任何东西。
 * @vitest-environment node 由本文件顶部的 node:sqlite 使用自动满足
 * （vitest 默认即 node 环境，这里显式写上是为了将来若切 jsdom 时不至于静默坏掉）。
 */
describe('插件 onBoot 的升级路径（端到端）', () => {
  it('老库跑一遍 onBoot 后 config_json 被补上，且 getToolSettings 不再报错', async () => {
    const t = createLegacyDb()
    const logger = recordingLogger()

    // 老库现状：缺 config_json，读设置会抛 no such column
    await expect(
      t.db.first(`SELECT disabled_json, config_json FROM {tool_settings} WHERE id = ?`, 'default'),
    ).rejects.toThrow(/no such column/i)

    // 跑插件的 onBoot（内部就是 ensureSchema：建表 + 补列）
    const plugin = (await import('../index.js')).default
    const ctx = {
      db: t.db,
      logger,
      config: plugin.defaultConfig,
    } as unknown as MigrationContext
    await runOnBoot(plugin, ctx)

    // 补列之后同一句 SQL 能跑通
    expect(columnsOf(t, 'tool_settings')).toContain('config_json')
    const row = await t.db.first(`SELECT disabled_json, config_json FROM {tool_settings} WHERE id = ?`, 'default')
    expect(row).toBeNull() // 老库里从来没有这一行（读不存在 → 返回 null，而不是抛错）

    // 写入路径也通了：这正是「保存搜索 Key 500」的那个动作
    await t.db.run(
      `INSERT INTO {tool_settings} (id, disabled_json, config_json, updated_at) VALUES (?, ?, ?, ?)`,
      'default',
      '[]',
      JSON.stringify({ 'search.web': { apiKey: 'k' } }),
      1,
    )
    const written = await t.db.first<{ config_json: string }>(
      `SELECT config_json FROM {tool_settings} WHERE id = ?`,
      'default',
    )
    expect(JSON.parse(written!.config_json)).toEqual({ 'search.web': { apiKey: 'k' } })
    t.close()
  })

  it('新库（全表已建）跑 onBoot 不报错、不重复加列', async () => {
    const t = createTestDb()
    const logger = recordingLogger()
    const plugin = (await import('../index.js')).default
    const ctx = {
      db: t.db,
      logger,
      config: plugin.defaultConfig,
    } as unknown as MigrationContext

    await runOnBoot(plugin, ctx)
    await runOnBoot(plugin, ctx) // 模拟冷启动重跑

    expect(columnsOf(t, 'tool_settings').filter((name) => name === 'config_json')).toHaveLength(1)
    expect(logger.warns).toEqual([])
    t.close()
  })
})

/** onBoot 需要的 ctx 形状（只取迁移用到的那两样，避免测试依赖整个 PluginContext） */
type MigrationContext = {
  db: ReturnType<typeof createTestDb>['db']
  logger: MigrationLogger
  config: unknown
}

/** 调插件真实的 onBoot 钩子。显式判空，让「钩子被删了」变成一条清晰的失败而不是 as any */
async function runOnBoot(
  plugin: Awaited<typeof import('../index.js')>['default'],
  ctx: MigrationContext,
): Promise<void> {
  const onBoot = plugin.hooks?.onBoot
  if (!onBoot) throw new Error('插件的 hooks.onBoot 不见了——升级路径失去兜底')
  await onBoot(ctx as never)
}
