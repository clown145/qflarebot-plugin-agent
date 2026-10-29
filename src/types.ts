/**
 * 与 @qqbot/sdk 无关的插件内部类型。
 *
 * 这里的形状刻意对齐 serverless-agent 的 `InternalMessage` / `ModelMessage`，
 * 因为 agent loop、工具协议、上下文装配都是从那边搬过来的——照搬协议而不是重写，
 * 迁移成本才只落在存储与出站这两处（见 README 的「从 serverless-agent 搬了什么」）。
 */

/** 会话标识。QFlareBot 的 session 已经给了 scene + targetId，这里只做一层归一化 */
export type ConversationKey = string

/** 归一化后的入站消息：平台差异在入站适配里消化掉，loop 只看这个 */
export interface InboundMessage {
  /** 会话键，同一个会话的 run 串行处理 */
  conversation: ConversationKey
  /** 用户 openid */
  userId: string
  /** 用户显示名，可能为空 */
  userName: string
  /** 去 @ 后的正文 */
  text: string
  /** 展示用正文（保留其他人的 @，见 session.displayContent） */
  displayText: string
  /** 附件（图片等），已转成模型能吃的形状 */
  attachments: MessageAttachment[]
  /** 被动回复凭据：QQ 的 msg_id，群聊 5 分钟 / 单聊 60 分钟内可用来回复 */
  passiveMessageId?: string
  /** 被动回复凭据：event_id（按钮回调、入群等事件走这个） */
  passiveEventId?: string
  /** 回复目标 */
  scene: ReplyScene
  targetId: string
  /** 发起人的群角色。决定工具的默认权限级别（见 permissions/default-policy.ts） */
  memberRole?: 'owner' | 'admin' | 'member' | 'unknown'
  /** 入站时间 */
  receivedAt: number
}

export type ReplyScene = 'group' | 'c2c' | 'guild' | 'guild_dm' | 'unknown'

export interface MessageAttachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'unknown'
  url?: string
  contentType?: string
  filename?: string
  /** 图片的内联数据（已 base64），供多模态模型直接吃 */
  dataBase64?: string
}

/** 模型消息。对齐 serverless-agent 的 ModelMessage，也贴近 plugin-llm 的 ChatMessage */
export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ModelContent }
  | {
      role: 'assistant'
      content?: string
      toolCalls?: ModelToolCall[]
      reasoning?: string
    }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string }

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; data?: string; mediaType?: string }

export type ModelContent = string | ModelContentPart[]

export interface ModelToolCall {
  id: string
  name: string
  /** 统一成对象；plugin-llm 的 ToolCall.arguments 是 JSON 字符串，边界上做一次转换 */
  arguments: Record<string, unknown>
}

export interface ModelTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 一次模型调用的结果 */
export interface ModelResponse {
  content?: string
  toolCalls: ModelToolCall[]
  reasoning?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

/** run 的终态 */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * 历史里的工具调用记录。
 *
 * 为什么存成「扁平的一行」而不是还原成 assistant + tool 两条消息：
 * DO storage 里历史是**按条数配额**的（MAX_HISTORY_ROWS），
 * 一次工具调用若拆成两行会double 消耗配额。合成一行既省配额，
 * 又足够让模型知道「上一轮我调过什么工具、拿到什么结果」。
 */
export interface HistoryToolTrace {
  name: string
  /** 入参 JSON（已截断，见 run.ts） */
  args: string
  /** 结果摘要（已截断） */
  result: string
  status: string
}

export interface RunRecord {
  id: string
  conversation: ConversationKey
  status: RunStatus
  /** 认领时间戳（毫秒）。用来做 lease 超时回收 */
  lockedUntil?: number
  attempts: number
  createdAt: number
  updatedAt: number
  /** 入站消息（JSON） */
  inputJson: string
  /** 已经跑了多少步，防止失控 */
  steps: number
  error?: string
}
