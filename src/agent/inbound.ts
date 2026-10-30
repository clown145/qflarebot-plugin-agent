/**
 * 入站适配：把 QFlareBot 的 `Session` 归一化成插件内部的 `InboundMessage`。
 *
 * 这一层是**替代** serverless-agent 的 `src/adapters/`（5,741 行）的地方。
 * 那边要为 QQ/Telegram/WeCom/WeixinOC 各写一套 normalize + 验签 + 出站；
 * 这里 QFlareBot 已经把 QQ 平台的事做完了（验签、事件标准化、msg_seq 配额、
 * 引用、撤回、键盘），插件只需要读 `session` 的字段。
 *
 * 所以这层只有几十行，而不是几千行——这是选插件形态最大的收益之一。
 */
import type { Session } from '@qqbot/sdk'
import type { InboundMessage, MessageAttachment, ReplyScene } from '../types.js'

/** 只处理真正带内容的文本消息；事件类（入群、按钮）走各自的处理器 */
export function isTextMessage(session: Session): boolean {
  return Boolean(session.content?.trim()) || (session.attachments?.length ?? 0) > 0
}

export function toInboundMessage(session: Session, isolateSessions = false): InboundMessage {
  const attachments: MessageAttachment[] = (session.attachments ?? []).map((attachment) => ({
    type: classifyAttachment(attachment.contentType, attachment.filename),
    url: attachment.url,
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    ...(attachment.filename ? { filename: attachment.filename } : {}),
  }))

  return {
    conversation: conversationKey(session, isolateSessions),
    userId: session.userId,
    userName: session.userName ?? '',
    text: session.content ?? '',
    displayText: session.displayContent ?? session.content ?? '',
    attachments,
    // 被动回复凭据：msg_id 优先，没有的话用 event_id（事件类）
    ...(session.messageId ? { passiveMessageId: session.messageId } : {}),
    ...(session.memberRole ? { memberRole: session.memberRole } : {}),
    scene: toReplyScene(session.scene),
    targetId: session.targetId,
    receivedAt: Date.now(),
  }
}

/**
 * 会话键。
 *
 * 默认**群聊按群**（整个群共享一段历史，和人类在群里聊天的直觉一致）；
 * 单聊按用户；频道按频道。
 *
 * ## 隔离模式（`isolate_sessions`）
 *
 * 打开后，群聊的键会拼上发信人，变成「每个人一段独立历史」。
 * 对标 AstrBot 的 `platform_settings.unique_session`
 * （`waking_check/stage.py:88-92`，它拼 `sender_id + group_id`）。
 *
 * **只影响群聊**：单聊本来就一人一 DO，再拼一次是废话；
 * 频道（`guild`）是公开帖，语义更接近群，同样按开关处理。
 *
 * ## 切换的代价（重要）
 *
 * 键变了，DO 里那批历史就**查不到了** —— 等于所有人重新开始。
 * 不做迁移：迁移要把 N 个人的历史拆开，而旧历史里根本分不出哪句是谁说的
 * （之前压根没存 userId）。所以切换前要在页面上明确告诉用户。
 *
 * @param isolate 是否按成员隔离。缺省 false = 原来「一群一会话」的行为
 */
export function conversationKey(session: Session, isolate = false): string {
  // 只有「多人共享」的场景才需要隔离判断
  const shareable = session.scene === 'group' || session.scene === 'guild'
  const suffix = isolate && shareable && session.userId ? `:${session.userId}` : ''

  switch (session.scene) {
    case 'group':
      return `group:${session.targetId}${suffix}`
    case 'c2c':
      return `c2c:${session.targetId}`
    case 'guild':
      return `guild:${session.targetId}${suffix}`
    case 'guild_dm':
      return `guild_dm:${session.targetId}`
    default:
      return `unknown:${session.targetId}`
  }
}

function toReplyScene(scene: Session['scene']): ReplyScene {
  switch (scene) {
    case 'group':
    case 'c2c':
    case 'guild':
    case 'guild_dm':
      return scene
    default:
      return 'unknown'
  }
}

function classifyAttachment(contentType?: string, filename?: string): MessageAttachment['type'] {
  const type = (contentType ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  if (type) return 'file'

  // 没有 contentType 时按扩展名猜。QQ 的图片消息有时不带 content-type
  const ext = filename?.toLowerCase().split('.').pop()
  if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image'
  return 'unknown'
}
