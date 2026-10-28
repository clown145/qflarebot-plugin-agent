/**
 * 上下文装配：会话历史 + 系统提示词 + 本轮输入 → 模型消息数组。
 *
 * 照搬 serverless-agent 的 `src/core/agent-context.ts`（171 行，零存储耦合），
 * 但砍掉了它那套 skill 机制（`src/skills/` 721 行）——QFlareBot 的"插件"是部署单元，
 * 没有"模型在运行时改写工作区文档"这个概念，语义对不上。
 *
 * 保留的核心是**历史回放的两个细节**，这两点漏了会明显影响体验：
 * 1. 历史里的 assistant 消息如果带工具调用，必须连 tool_calls 一起回放，
 *    否则模型看到自己"说过"工具结果却没有调用记录，会困惑。
 * 2. 当前这条用户消息不能重复——历史里已经有它了。
 */
import type { HistoryRow } from '../do/agent-object.js'
import type { InboundMessage, ModelContent, ModelContentPart, ModelMessage, ModelToolCall } from '../types.js'
import { DEFAULT_SYSTEM_PROMPT } from '../config/index.js'

export interface ContextOptions {
  systemPrompt?: string
  timezone: string
  /** 历史条数上限 */
  historyLimit: number
  /** 模型是否支持图片输入 */
  supportsVision: boolean
}

export function buildMessages(
  message: InboundMessage,
  history: HistoryRow[],
  options: ContextOptions,
): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: 'system', content: buildSystemPrompt(options.systemPrompt, options.timezone, message) },
  ]

  // 历史：只取最近 N 条。条数越多越贵，history_limit 默认 20
  const recent = options.historyLimit > 0 ? history.slice(-options.historyLimit) : []
  for (const row of recent) {
    messages.push(toModelMessage(row))
  }

  messages.push({ role: 'user', content: buildUserContent(message, options.supportsVision) })
  return messages
}

function buildSystemPrompt(
  configured: string | undefined,
  timezone: string,
  message: InboundMessage,
): string {
  const base = configured?.trim() || DEFAULT_SYSTEM_PROMPT
  const now = new Date()

  // 模型没有时钟，把当前时间和时区写进提示词，比让它每轮调 time.now 便宜
  let localTime = now.toISOString()
  try {
    localTime = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(now)
  } catch {
    // 时区配错时退回 ISO，不影响对话
  }

  return [
    base,
    '',
    '## 当前环境',
    `- 现在时间：${localTime}（时区 ${timezone}）`,
    `- 当前会话：${message.scene === 'c2c' ? '单聊' : '群聊'}`,
    message.userName ? `- 正在和你说话的人：${message.userName}` : '',
    '',
    '回复要求：纯文本，不要用 Markdown 语法（QQ 不渲染），不要输出思考过程。',
  ]
    .filter(Boolean)
    .join('\n')
}

function toModelMessage(row: HistoryRow): ModelMessage {
  if (row.role === 'assistant') {
    const toolCalls = parseToolCalls(row.toolCallsJson)
    return {
      role: 'assistant',
      content: row.content,
      ...(toolCalls.length ? { toolCalls } : {}),
    }
  }
  return { role: 'user', content: row.content }
}

function parseToolCalls(json: string | null): ModelToolCall[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? (parsed as ModelToolCall[]) : []
  } catch {
    // 历史里的坏数据不该让整个对话失败
    return []
  }
}

function buildUserContent(message: InboundMessage, supportsVision: boolean): ModelContent {
  const images = message.attachments.filter((a) => a.type === 'image')

  // 没有图片，或者模型不吃图片：退回纯文本，把图片地址写进正文
  if (images.length === 0 || !supportsVision) {
    const imageNote = images.length
      ? `\n\n（用户发了 ${images.length} 张图片，但当前模型不支持图片输入：${images.map((i) => i.url ?? '').join(' ')}）`
      : ''
    return `${message.text}${imageNote}`
  }

  const parts: ModelContentPart[] = []
  if (message.text) parts.push({ type: 'text', text: message.text })
  for (const image of images) {
    if (image.dataBase64) {
      parts.push({
        type: 'image',
        data: image.dataBase64,
        ...(image.contentType ? { mediaType: image.contentType } : {}),
      })
    } else if (image.url) {
      parts.push({ type: 'image', url: image.url })
    }
  }
  return parts.length ? parts : message.text
}

/** 把本轮对话转成要写进历史的行 */
export function toHistoryRows(
  userText: string,
  assistantText: string,
  assistantToolCalls: ModelToolCall[],
): HistoryRow[] {
  const now = Date.now()
  return [
    { role: 'user', content: userText, toolCallsJson: null, createdAt: now },
    {
      role: 'assistant',
      content: assistantText,
      toolCallsJson: assistantToolCalls.length ? JSON.stringify(assistantToolCalls) : null,
      createdAt: now + 1,
    },
  ]
}
