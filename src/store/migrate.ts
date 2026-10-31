/**
 * 列迁移：给**老库**补上后来新增的列。
 *
 * ## 为什么需要它
 *
 * `SCHEMA_STATEMENTS` 全是 `CREATE TABLE IF NOT EXISTS`，它只能建**缺失的表**，
 * 建不了**表里缺失的列**：老部署里 `{tool_settings}` 已经是三列的形状，
 * 再跑一遍建表语句只会命中 IF NOT EXISTS 直接跳过。于是上一版升级上来后：
 *
 * - 读设置 → `D1_ERROR: no such column: config_json`
 * - 写设置 → `table p_agent_tool_settings has no column named config_json`
 *
 * 两者都是 500，**保存搜索 Key 直接失败**。
 *
 * ## 为什么不能用 PRAGMA
 *
 * 直觉写法是 `PRAGMA table_info({tool_settings})` 看列。但框架的
 * `packages/sdk/src/sqlScope.ts` 把 `PRAGMA` 放进了 `BANNED` 集合
 * （插件不该窥探整库结构），插件执行它**直接抛错**——实测：
 *
 * ```text
 * 插件 SQL 不允许使用 PRAGMA——插件只能操作自己的表，请用 {表名} 占位（框架会补上插件前缀）
 * ```
 *
 * 所以探测改用一条必然失败的 SELECT：`SELECT <col> FROM {table} LIMIT 0`。
 * 列存在时它返回 0 行、什么都不做；列不存在时 SQLite 报 `no such column`。
 * 这条语句天然幂等、不写库、不占写入额度。
 *
 * ## 并发
 *
 * cron、onBoot、onInstall 可能在不同 isolate 里同时跑。两个 isolate 都探测到
 * 缺列 → 都去 ALTER → 第二个拿到 `duplicate column name`。这不是错误，
 * 恰恰说明列已经被别人补好了，**必须当作成功吞掉**，否则每次冷启动都要打一条
 * 假报错，运维会以为迁移一直失败。
 *
 * 其余错误（表不存在、D1 抖动）只 `warn` 不抛：迁移失败不该让插件装不上、
 * 也不该让 onBoot 抛错把整个插件启动流程打断——大不了这一版功能报 500，
 * 但其它功能照常。
 */
import type { PluginDB } from '@qqbot/sdk'

/** 迁移只需要 warn/info，不依赖完整 Logger（测试里传个皮包对象就够） */
export interface MigrationLogger {
  warn(message: string, data?: unknown): void
  info?(message: string, data?: unknown): void
}

/** 一条「后来新增的列」。`definition` 必须与 `schema.ts` 建表语句里的写法一致 */
export interface ColumnMigration {
  /** 表名，不带花括号（迁移时拼成 `{表名}` 交给框架展开） */
  table: string
  column: string
  /**
   * 列定义，如 `TEXT NOT NULL DEFAULT '{}'`。
   *
   * SQLite 的 `ALTER TABLE ADD COLUMN` 有几条硬限制：不能加 PRIMARY KEY / UNIQUE；
   * 带 `NOT NULL` 时必须给非 NULL 默认值。所以这里只能放「可安全追加」的定义。
   */
  definition: string
}

/**
 * 全部已发布的列迁移。**加列时在这里追加一条**，别只改建表语句——
 * 建表语句只对新库生效，老库读不到新列。
 *
 * 顺序无关（每条都是独立的探测 + 补列），但建议按表分组、保持稳定，
 * 方便比对历史。
 */
export const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  // v0.2.0：工具自己的配置（搜索 Key 等）从配置文件搬进 D1 的这一列。
  // 默认值 '{}' 让老库的行自动获得一个空配置，不必回填。
  { table: 'tool_settings', column: 'config_json', definition: `TEXT NOT NULL DEFAULT '{}'` },
]

/** 补列结果。测试与日志用 */
export interface MigrationResult {
  /** 这次真的补上的列（`表.列`） */
  added: string[]
  /** 探测发现已存在的列（`表.列`） */
  present: string[]
  /** 补列失败、只打了 warn 的列（`表.列`） */
  failed: string[]
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 给老库补列。**永不抛错**（除了程序自身的编码错误）。
 *
 * @param db 插件的 `ctx.db`（`{表名}` 占位由框架展开）
 * @param logger 只用来 warn/info
 * @param migrations 默认 `COLUMN_MIGRATIONS`，测试可注入
 */
export async function ensureColumnMigrations(
  db: Pick<PluginDB, 'all' | 'run'>,
  logger: MigrationLogger,
  migrations: readonly ColumnMigration[] = COLUMN_MIGRATIONS,
): Promise<MigrationResult> {
  const result: MigrationResult = { added: [], present: [], failed: [] }

  for (const migration of migrations) {
    const label = `${migration.table}.${migration.column}`

    // 定义是我们自己写死的常量，不是用户输入；但拼进 SQL 前仍校验一次标识符，
    // 避免以后有人从配置里读进来时无意中开出一个注入点
    if (!IDENTIFIER.test(migration.table) || !IDENTIFIER.test(migration.column)) {
      logger.warn('列迁移的表名/列名不合法，已跳过', { migration })
      result.failed.push(label)
      continue
    }

    const table = `{${migration.table}}`

    // ---- 1) 探测：列存在时返回 0 行；不存在时 SQLite 报 no such column ----
    try {
      await db.all(`SELECT ${migration.column} FROM ${table} LIMIT 0`)
      result.present.push(label)
      continue
    } catch (error) {
      if (!isMissingColumnError(error)) {
        // 表不存在 / D1 抖动：不是「缺列」，补列也会失败，直接放过
        logger.warn('列迁移探测失败，已跳过', { column: label, error: describe(error) })
        result.failed.push(label)
        continue
      }
    }

    // ---- 2) 补列 ----
    try {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${migration.column} ${migration.definition}`)
      result.added.push(label)
      logger.info?.('已补齐缺失的列', { column: label })
    } catch (error) {
      if (isDuplicateColumnError(error)) {
        // 并发场景：另一个 isolate 刚刚抢先补上了。这不是失败
        result.present.push(label)
        continue
      }
      logger.warn('补列失败，已跳过', { column: label, error: describe(error) })
      result.failed.push(label)
    }
  }

  return result
}

/** SQLite / D1 的缺列错误：`no such column: x`（D1 前面会带 `D1_ERROR: `） */
function isMissingColumnError(error: unknown): boolean {
  return /no such column/i.test(messageOf(error))
}

/** SQLite / D1 的重复列错误：`duplicate column name: x` */
function isDuplicateColumnError(error: unknown): boolean {
  return /duplicate column name/i.test(messageOf(error))
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

/** 日志里只留一句可读的话，别把整个 Error 对象塞进去（含堆栈，噪音大） */
function describe(error: unknown): string {
  return messageOf(error)
}
