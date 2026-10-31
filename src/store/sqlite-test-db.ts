/**
 * 测试专用：用 Node 22 内置的 `node:sqlite` 造一个**真实 SQL 语义**的 `PluginDB`。
 *
 * ## 为什么必须用真实 SQLite
 *
 * 本仓库以前的存储层测试用手写内存假件（`memoryDb()`），假件**自己实现了
 * "应该有的行为"**：它自己按 `path.slice(0, lastIndexOf('/'))` 算 parent、
 * 自己把 `LIKE '%x%'` 转成 `startsWith()`。于是：
 *
 * - VFS 的 `INSERT` 从来没写 `parent` 列 —— 假件自己算出来的，测试全绿；
 * - `remove('/my_notes')` 的 `LIKE` 没转义 —— 假件把 `%` 去掉做前缀比较，
 *   真实 SQLite 里 `_` 是通配符，会误伤 `/myxnotes/b.md`，测试也全绿。
 *
 * 换句话说：**假件把 bug 消化掉了**。换成真实 SQL 后这两条立刻暴露。
 *
 * ## 与线上的一致性
 *
 * 适配器复刻 `packages/runtime/src/scoped.ts` 的 `createScopedDB`：
 * `exec` 走 `scopeSql` + `flattenForExec`，`run/all/first` 走 `scopeSql`。
 * 所以测试里写 `{表名}` 占位、被框架禁掉的 `PRAGMA`、引号内换行等规则
 * 都和线上完全一样——本地跑不通的 SQL，线上一样跑不通。
 *
 * `node:sqlite` 是实验 API，但它是 Node 内置的，**不引入任何新依赖**；
 * 类型声明见 `src/store/node-sqlite.d.ts`。
 */
import { DatabaseSync } from 'node:sqlite'
import type { DBStatement, DBBatchResult, PluginDB } from '@qqbot/sdk'
import { flattenForExec, scopeSql, tablePrefix } from '@qqbot/sdk/sqlScope'
import { SCHEMA_STATEMENTS } from './schema.js'

export interface SqliteTestDb {
  /** 交给被测代码的句柄。SQL 规则与线上一致（占位符展开、PRAGMA 被拒等） */
  db: PluginDB
  /** 原生句柄，测试要直接检查库里的行时用（同样要自己过 scopeSql） */
  raw: DatabaseSync
  /** 插件名对应的表前缀，比如 `p_agent_` */
  prefix: string
  /** 执行过的 SQL（展开后的），用来断言 "有没有写 ESCAPE" 这类语句级事实 */
  sqlLog: string[]
  /** 把插件 SQL 展开成真实表名（测试直接查表时用） */
  scope(sql: string): string
  close(): void
}

export interface SqliteTestDbOptions {
  /** 插件名，决定表前缀。默认 `agent`（与 manifest 一致） */
  plugin?: string
  /**
   * `full`（默认）= 建全部表；`none` = 空库，测试自己造表（模拟老库）。
   */
  schema?: 'full' | 'none'
}

export function createTestDb(options: SqliteTestDbOptions = {}): SqliteTestDb {
  const raw = new DatabaseSync(':memory:')
  const prefix = tablePrefix(options.plugin ?? 'agent')
  const sqlLog: string[] = []

  const scopeOnly = (sql: string): string => scopeSql(sql, prefix)
  const scoped = (sql: string): string => {
    const out = scopeOnly(sql)
    sqlLog.push(out)
    return out
  }

  const db: PluginDB = {
    table: (name: string) => `${prefix}${name}`,

    async exec(sql: string) {
      const flat = flattenForExec(scoped(sql))
      if (flat.trim()) raw.exec(flat)
    },

    async run(sql: string, ...params: unknown[]) {
      const statement = raw.prepare(scoped(sql))
      const result = statement.run(...(params as never[]))
      return { changes: Number(result.changes) }
    },

    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      const statement = raw.prepare(scoped(sql))
      const rows = statement.all(...(params as never[])) as Record<string, unknown>[]
      // node:sqlite 返回的是 null 原型对象，展开成普通对象，断言失败时的 diff 才读得懂
      return rows.map((row) => ({ ...row })) as T[]
    },

    async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      const statement = raw.prepare(scoped(sql))
      const row = statement.get(...(params as never[])) as Record<string, unknown> | undefined
      return row ? ({ ...row } as T) : null
    },

    async batch<T = Record<string, unknown>>(statements: readonly DBStatement[]) {
      if (!statements.length) return []
      // 照线上语义：整批一个事务，任何一条失败整批回滚
      raw.exec('BEGIN')
      try {
        const results: Array<DBBatchResult<T>> = statements.map((statement) => {
          const prepared = raw.prepare(scoped(statement.sql))
          const result = prepared.run(...((statement.params ?? []) as never[]))
          return { changes: Number(result.changes), results: [] as T[] }
        })
        raw.exec('COMMIT')
        return results
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
    },
  }

  if ((options.schema ?? 'full') === 'full') {
    for (const statement of SCHEMA_STATEMENTS) {
      raw.exec(flattenForExec(scopeSql(statement, prefix)))
    }
  }

  return {
    db,
    raw,
    prefix,
    sqlLog,
    scope: scopeOnly,
    close: () => raw.close(),
  }
}
