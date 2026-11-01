import type { PluginDB } from '@qqbot/sdk'

export interface RecoveryEntry { conversation: string; token: string; registered_at: number; due_at: number }

// 登记与 DO 入队跨存储，空扫描必须给正在入队的执行者留下窗口。
const ADMISSION_GRACE_MS = 120_000

/** 必须先登记再入队，避免执行者在 submit 后中断而留下不可发现的 DO。 */
export async function trackRecovery(db: PluginDB, conversation: string, legacy = false): Promise<void> {
  await db.run(
    `INSERT INTO {recovery} (conversation, token, registered_at, due_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation) DO ${legacy ? 'NOTHING' : 'UPDATE SET token = excluded.token, registered_at = excluded.registered_at, due_at = excluded.due_at'}`,
    conversation, crypto.randomUUID(), Date.now(), Date.now(),
  )
}

export async function dueRecovery(db: PluginDB, now: number): Promise<RecoveryEntry[]> {
  return db.all<RecoveryEntry>(
    `SELECT conversation, token, registered_at, due_at FROM {recovery} WHERE due_at <= ? ORDER BY due_at, conversation LIMIT 50`, now,
  )
}

/** CAS 防止旧扫描者删除/延后刚有新消息的会话。 */
export async function finishRecovery(db: PluginDB, entry: RecoveryEntry, nextAt: number | null): Promise<void> {
  if (nextAt === null && Date.now() < entry.registered_at + ADMISSION_GRACE_MS) {
    nextAt = entry.registered_at + ADMISSION_GRACE_MS
  }
  if (nextAt === null) {
    await db.run(`DELETE FROM {recovery} WHERE conversation = ? AND token = ?`, entry.conversation, entry.token)
  } else {
    await db.run(`UPDATE {recovery} SET due_at = ? WHERE conversation = ? AND token = ?`, nextAt, entry.conversation, entry.token)
  }
}
