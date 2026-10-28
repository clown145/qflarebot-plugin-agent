/**
 * D1 侧的数据访问：定时任务、审计、统计。
 *
 * 对话历史与 run 队列**不在这里**——它们在 Durable Object 的 SQLite storage 里
 * （见 src/do/agent-object.ts），这样每条消息都不碰 D1 额度。
 */
import type { PluginDB } from '@qqbot/sdk'
import type { ReplyScene } from '../types.js'

export interface ScheduleRow {
  id: string
  conversation: string
  scene: ReplyScene
  target_id: string
  prompt: string
  due_at: number
  repeat_seconds: number | null
  status: string
  created_by: string
  created_at: number
  last_run_at: number | null
}

export async function createSchedule(
  db: PluginDB,
  input: {
    id: string
    conversation: string
    scene: ReplyScene
    targetId: string
    prompt: string
    dueAt: number
    repeatSeconds?: number
    createdBy: string
  },
): Promise<void> {
  await db.run(
    `INSERT INTO {schedules}
       (id, conversation, scene, target_id, prompt, due_at, repeat_seconds, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    input.id,
    input.conversation,
    input.scene,
    input.targetId,
    input.prompt,
    input.dueAt,
    input.repeatSeconds ?? null,
    input.createdBy,
    Date.now(),
  )
}

/** 取到期的任务。cron 里调用，一次取少量，避免长事务占满 CPU */
export async function listDueSchedules(
  db: PluginDB,
  now: number,
  limit = 5,
): Promise<ScheduleRow[]> {
  return db.all<ScheduleRow>(
    `SELECT * FROM {schedules}
     WHERE status = 'active' AND due_at <= ?
     ORDER BY due_at ASC
     LIMIT ?`,
    now,
    limit,
  )
}

export async function listSchedules(
  db: PluginDB,
  conversation: string,
  limit = 20,
): Promise<ScheduleRow[]> {
  return db.all<ScheduleRow>(
    `SELECT * FROM {schedules}
     WHERE conversation = ? AND status = 'active'
     ORDER BY due_at ASC
     LIMIT ?`,
    conversation,
    limit,
  )
}

/**
 * 列出**所有会话**的活动定时任务。管理页用。
 *
 * 注意与 `listSchedules` 的区别：那个按会话过滤（给模型看「我这个会话有哪些提醒」），
 * 这个跨会话（给管理页看「整个机器人有哪些提醒」）。上一版管理页误用了前者并传了
 * 空字符串，结果永远是空列表。
 */
export async function listAllSchedules(db: PluginDB, limit = 50): Promise<ScheduleRow[]> {
  return db.all<ScheduleRow>(
    `SELECT * FROM {schedules}
     WHERE status = 'active'
     ORDER BY due_at ASC
     LIMIT ?`,
    limit,
  )
}

/**
 * 任务跑完后的推进。
 *
 * 单次任务标成 done；重复任务把 due_at 往后推。
 * 这里用 `WHERE status = 'active'` 做一层乐观锁：cron 有并发时只有一个能推进成功，
 * 避免同一个任务被跑两次。
 */
export async function advanceSchedule(
  db: PluginDB,
  row: ScheduleRow,
  ranAt: number,
): Promise<void> {
  if (row.repeat_seconds && row.repeat_seconds > 0) {
    // 跳过已经错过的周期：机器人离线一段时间后，重复任务不该补跑几十次
    let nextDue = row.due_at + row.repeat_seconds * 1000
    while (nextDue <= ranAt) nextDue += row.repeat_seconds * 1000
    await db.run(
      `UPDATE {schedules} SET due_at = ?, last_run_at = ?
       WHERE id = ? AND status = 'active'`,
      nextDue,
      ranAt,
      row.id,
    )
    return
  }

  await db.run(
    `UPDATE {schedules} SET status = 'done', last_run_at = ?
     WHERE id = ? AND status = 'active'`,
    ranAt,
    row.id,
  )
}

export async function cancelSchedule(db: PluginDB, id: string, conversation: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE {schedules} SET status = 'cancelled'
     WHERE id = ? AND conversation = ? AND status = 'active'`,
    id,
    conversation,
  )
  return res.changes > 0
}

/** 审计：默认关。打开后每次工具调用一行 */
export async function recordToolAudit(
  db: PluginDB,
  input: {
    id: string
    conversation: string
    runId: string
    toolName: string
    argsJson: string
    resultJson?: string
    status: string
    durationMs?: number
  },
): Promise<void> {
  await db.run(
    `INSERT INTO {tool_audit}
       (id, conversation, run_id, tool_name, args_json, result_json, status, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.conversation,
    input.runId,
    input.toolName,
    input.argsJson,
    input.resultJson ?? null,
    input.status,
    input.durationMs ?? null,
    Date.now(),
  )
}

/**
 * 统计：一天一行，用 UPSERT 累加。
 *
 * 按 QFlareBot 文档「D1 写入怎么算」，UPSERT 改同一行含索引列算 2 行。
 * 一次对话只写 1–2 次（结束时汇总），写入量与消息数脱钩。
 */
export async function bumpDailyStats(
  db: PluginDB,
  day: string,
  delta: { runs?: number; failed?: number; toolCalls?: number; inputTokens?: number; outputTokens?: number },
): Promise<void> {
  await db.run(
    `INSERT INTO {daily_stats} (day, runs, failed, tool_calls, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       runs = runs + excluded.runs,
       failed = failed + excluded.failed,
       tool_calls = tool_calls + excluded.tool_calls,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
    day,
    delta.runs ?? 0,
    delta.failed ?? 0,
    delta.toolCalls ?? 0,
    delta.inputTokens ?? 0,
    delta.outputTokens ?? 0,
  )
}

export interface DailyStatsRow {
  day: string
  runs: number
  failed: number
  tool_calls: number
  input_tokens: number
  output_tokens: number
}

export async function listDailyStats(db: PluginDB, limit = 14): Promise<DailyStatsRow[]> {
  return db.all<DailyStatsRow>(
    `SELECT * FROM {daily_stats} ORDER BY day DESC LIMIT ?`,
    limit,
  )
}

export interface ToolAuditRow {
  id: string
  conversation: string
  run_id: string
  tool_name: string
  args_json: string
  result_json: string | null
  status: string
  duration_ms: number | null
  created_at: number
}

/** 最近的工具调用记录。管理页用，只在 enable_audit 打开时有数据 */
export async function listToolAudit(db: PluginDB, limit = 30): Promise<ToolAuditRow[]> {
  return db.all<ToolAuditRow>(
    `SELECT * FROM {tool_audit} ORDER BY created_at DESC LIMIT ?`,
    limit,
  )
}

/** 清理过期审计行。cron 里顺手做，用节流避免每次都 DELETE（删除也算写入） */
export async function pruneToolAudit(db: PluginDB, olderThan: number): Promise<number> {
  const res = await db.run(`DELETE FROM {tool_audit} WHERE created_at < ?`, olderThan)
  return res.changes
}
