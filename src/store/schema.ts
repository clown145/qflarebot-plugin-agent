/**
 * D1 表结构。
 *
 * **为什么只有这三张表**：serverless-agent 每跑一次 run 要往 D1 写 ~20 行
 * （run_steps 逐步记录 + tool_calls + audit_logs），按免费版 10 万行/日算只够
 * 5,000 次对话，而且这还是全机器人所有插件共享的池子。所以这里做了三处减法：
 *
 * 1. **对话历史与 run 状态放 Durable Object 的 SQLite storage**，不占 D1。
 *    DO storage 按 GB-月计费，一次对话的历史远小于 1 GB。
 * 2. **不做 run_steps 逐步记录**。排障走 ctx.logger → Workers Logs。
 * 3. **工具调用审计做成开关**（enable_audit，默认关）。
 *
 * 于是 D1 只在「需要跨会话全局查询」时才用：定时任务、统计、可选的审计。
 *
 * 表名用 `{表名}` 占位，框架展开成 `p_agent_<表名>`（见 QFlareBot 插件指南第 6 节）。
 */

export const SCHEMA_STATEMENTS = [
  // 动态定时任务：模型通过 schedule.create 工具建的提醒
  `CREATE TABLE IF NOT EXISTS {schedules} (
     id TEXT PRIMARY KEY,
     conversation TEXT NOT NULL,
     scene TEXT NOT NULL,
     target_id TEXT NOT NULL,
     prompt TEXT NOT NULL,
     due_at INTEGER NOT NULL,
     repeat_seconds INTEGER,
     status TEXT NOT NULL DEFAULT 'active',
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_run_at INTEGER
   ) WITHOUT ROWID`,

  // 到期扫描走这个索引；status 放在前面是因为绝大多数行都是 active
  `CREATE INDEX IF NOT EXISTS {schedules_due} ON {schedules}(status, due_at)`,

  // 工具调用审计（可选，enable_audit 打开才写）
  `CREATE TABLE IF NOT EXISTS {tool_audit} (
     id TEXT PRIMARY KEY,
     conversation TEXT NOT NULL,
     run_id TEXT NOT NULL,
     tool_name TEXT NOT NULL,
     args_json TEXT NOT NULL,
     result_json TEXT,
     status TEXT NOT NULL,
     duration_ms INTEGER,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS {tool_audit_time} ON {tool_audit}(created_at)`,

  // 虚拟工作区：元数据在 D1，内容小的也在 D1、大的走 R2
  // 照搬 serverless-agent 的 vfs_entries，但砍掉 revisions（每个版本都是额外写入）
  `CREATE TABLE IF NOT EXISTS {vfs_entries} (
     path TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     parent TEXT NOT NULL DEFAULT '/',
     kind TEXT NOT NULL,
     size INTEGER NOT NULL DEFAULT 0,
     r2_key TEXT,
     content TEXT,
     updated_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS {vfs_parent} ON {vfs_entries}(parent)`,

  // 权限策略表。照搬 serverless-agent 的 permission_policies：
  // 按 subject 叠加，只能放宽不能收紧（见 permissions/policy-resolver.ts）
  `CREATE TABLE IF NOT EXISTS {policies} (
     id TEXT PRIMARY KEY,
     subject_type TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     max_level INTEGER NOT NULL,
     scopes_json TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID`,

  `CREATE INDEX IF NOT EXISTS {policies_subject} ON {policies}(subject_type, subject_id)`,

  // 轻量统计，用于管理页展示「今天跑了多少次」。一天一行，写入量与消息数脱钩
  `CREATE TABLE IF NOT EXISTS {daily_stats} (
     day TEXT PRIMARY KEY,
     runs INTEGER NOT NULL DEFAULT 0,
     failed INTEGER NOT NULL DEFAULT 0,
     tool_calls INTEGER NOT NULL DEFAULT 0,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0
   ) WITHOUT ROWID`,
] as const
