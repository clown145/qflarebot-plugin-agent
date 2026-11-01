import type { HistoryRow, SummaryInput } from '../do/agent-object.js'

/** 不向模型公开原始 openid 时，仍保留稳定的说话人标签。 */
export function speakerLabel(userId: string, userName = '', exposeId = false): string {
  let hash = 2166136261
  for (const char of userId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const member = `成员-${(hash >>> 0).toString(16)}`
  const identity = exposeId ? `${member}，openid: ${userId}` : member
  return `${userName || '(无昵称)'}（${identity}）`
}

export function historySummary(row: HistoryRow): SummaryInput {
  const speaker = row.userId ? `说话人：${speakerLabel(row.userId, row.userName)}\n` : ''
  const images = row.attachments?.filter(a => a.type === 'image').length ?? 0
  return {
    ...(row.id ? { id: row.id } : {}),
    role: row.role,
    content: `${speaker}${row.content}${images ? `\n[附带 ${images} 张图片]` : ''}`,
  }
}
