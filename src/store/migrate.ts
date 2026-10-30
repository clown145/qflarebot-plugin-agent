/**
 * 补列迁移：把「表已存在但缺列」的老库补齐。
 *
 * ## 为什么需要它
 *
 * 建表全部用 `CREATE TABLE IF NOT EXISTS`，它只保证**表存在**，管不了**表上有没有新列**。
 * 老部署里那张表早就建好了，语句会被直接跳过，后来新增的列永远不会出现。
 * 症状是「表明明存在，写入却报 `no such column`」——比 `no such table` 更难查，
 * 因为按「表在不在」排查永远看不出问题。
 *
 * ## 本插件踩过的实例
 *
 * `tool_settings` 后来加了 `config_json`（存搜索 Key 等每工具配置）。schema 里写着
 * `DEFAULT '{}'`，注释还写「老库升级时不必回填，ADD COLUMN 带默认值是 O(1)」——
 * **但代码里根本没有 ADD COLUMN**。于是老部署一保存工具配置就 500
 * （框架把它包成「插件路由执行失败」），而新装用户完全正常。
 *
 * ## 为什么用 PRAGMA 先查再补
 *
 * 不写成「执行 ALTER 再吞异常」：那样会把锁超时、真的 SQL 错误一起吞掉，
 * 问题只会更隐蔽。先用 `PRAGMA table_info` 看列在不在，再决定要不要 ALTER。
 *
 * `ADD COLUMN` 带常量默认值在 SQLite 里是 O(1)（只改元数据、不重写行），
 * 所以在有数据的表上也能直接加。
 */
import type { Logger, PluginContext } from '@qqbot/sdk'

/** 后加的列：老库需要补上，新库由建表语句带出来 */
export interface RequiredColumn {
  /** 不带前缀的表名，运行时按 `p_<plugin>_` 展开 */
  table: string
  column: string
  /** 补列用的 DDL，里头的 `{table}` 占位符由调用方展开 */
  ddl: string
}

export const REQUIRED_COLUMNS: RequiredColumn[] = [
  {
    table: 'tool_settings',
    column: 'config_json',
    ddl: "ALTER TABLE {tool_settings} ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'",
  },
]

/** `ensureColumns` 用到的能力（抽出来是为了能用假 db 测） */
export interface ColumnMigrationDb {
  all(sql: string): Promise<unknown>
  exec(sql: string): Promise<unknown>
  table(name: string): string
}

/**
 * 补齐缺失的列。**不抛错**：补列失败不该让整个插件不可用，
 * 真正用到那一列的路径会报出更具体的错误。
 */
export async function ensureColumns(
  ctx: Pick<PluginContext<unknown>, 'db' | 'logger'>,
  required: readonly RequiredColumn[] = REQUIRED_COLUMNS,
): Promise<void> {
  for (const item of required) {
    try {
      const table = ctx.db.table(item.table)
      const rows = (await ctx.db.all(`PRAGMA table_info(${table})`)) as Array<{ name?: unknown }>
      // PRAGMA 返回空 = 表还不存在：建表语句会负责，没什么可补的
      if (!Array.isArray(rows) || !rows.length) continue
      if (rows.some((row) => row?.name === item.column)) continue
      await ctx.db.exec(item.ddl)
      ctx.logger.info('已补齐缺失的列', { table: item.table, column: item.column })
    } catch (error) {
      // 两个 isolate 同时冷启动会一起补同一列，后到的撞 duplicate column——
      // 列已经在了，不算失败（框架的 manifestStore 同样这么处理）
      const message = error instanceof Error ? error.message : String(error)
      if (/duplicate column/i.test(message)) continue
      ctx.logger.warn('补列失败', { table: item.table, column: item.column, error: message })
    }
  }
}

/** 测试用：只看某一个 Logger 的告警，避免测试里要造完整 PluginContext */
export function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}
