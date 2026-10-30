/**
 * 工具定义与执行上下文。照搬 serverless-agent 的 `src/tools/types.ts`。
 *
 * 相对原文的改动只有一处：`env: Env` 换成插件自己的 `ToolExecutionContext` 字段
 * （`db` / `logger` / 会话信息），因为 QFlareBot 不给插件裸 binding。
 */
import type { Logger, PluginDB } from '@qqbot/sdk'

/** JSON Schema 对象 */
export type JsonSchema = Record<string, unknown>

/**
 * 权限级别。数字越大越宽松：
 * 1 = 陌生人 / 2 = 普通成员 / 3 = 定时任务 / 4 = 群主与管理员 / 5 = 需要二次确认
 */
export type PermissionLevel = 0 | 1 | 2 | 3 | 4 | 5

export interface PermissionRequirement {
  level: PermissionLevel
  /** 需要的能力集合，如 `message:send`、`workspace:write` */
  scopes: string[]
  confirmationRequired?: boolean
}

/** 工具的副作用等级。决定是否需要用户确认 */
export type ToolSideEffect = 'none' | 'workspace_write' | 'external_write' | 'dangerous'

export type ToolSourceType = 'builtin' | 'mcp' | 'plugin'

export interface ToolSource {
  type: ToolSourceType
  id: string
  name: string
}

/** 工具行为提示 */
export interface ToolExecutionBehavior {
  /**
   * 这个工具自己会把结果发给用户（比如发消息），loop 结束时不必再补一条。
   * 照搬原文的 `preventsFinalResponse` —— 之前我自己写的 `isRepliedByTool`
   * 靠工具名前缀猜，是错的：应该由工具自己声明。
   */
  preventsFinalResponse?: boolean
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * 工具自己的配置项声明。**由工具自己提供**，管理页据此自动生成表单。
 *
 * 为什么让工具声明而不是在页面里写死：配置项属于工具。写死在页面里意味着
 * 「加一个需要 api key 的工具」要同时改工具、页面、插件配置三处，
 * 而且用户会在「对话行为」页看到一个不知道自己属于谁的神秘输入框
 * （search_api_key 就是上一版的反面教材）。
 */
export interface ToolConfigField {
  /** 存储键，如 `apiKey` */
  key: string
  /** 显示名，如「Tavily API Key」 */
  label: string
  /** 一句话说明它从哪来、填了会怎样 */
  hint?: string
  /** 输入框类型。`secret` 用密码框显示 */
  type?: 'text' | 'secret' | 'url'
  /** 占位提示 */
  placeholder?: string
  /** 是否必填。必填且为空时管理页会提示，工具本身也应优雅降级 */
  required?: boolean
}

export interface ToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations?: ToolAnnotations
  behavior?: ToolExecutionBehavior
  permission: PermissionRequirement
  sideEffect: ToolSideEffect
  timeoutMs: number
  /**
   * 这个工具需要在管理页填写哪些配置。空/不填 = 不需要配置，
   * 页面就不给它显示「配置」按钮。
   */
  configFields?: ToolConfigField[]
}

/** 工具执行时能拿到的上下文。对应原文的 ToolExecutionContext */
export interface ToolExecutionContext {
  db: PluginDB
  logger: Logger
  /** 会话标识（群 openid / 用户 openid） */
  conversationId: string
  /** 发起人的平台 id */
  actorId: string
  /** 发起人的群角色，决定默认权限级别 */
  actorRole?: 'owner' | 'admin' | 'member' | 'unknown'
  scene: string
  targetId: string
  runId: string
  stepId: string
  toolCallId: string
  /** 工具入参 */
  input: unknown
  /** 时区，time 工具用 */
  timezone: string
  /** 允许执行 dangerous 工具（用户已确认过） */
  allowDangerous?: boolean
}

export type ToolResultStatus =
  | 'success'
  | 'failed'
  | 'permission_denied'
  | 'needs_confirmation'
  | 'timeout'

/**
 * 工具想让机器人**发出去**的富媒体。
 *
 * 为什么需要它：宿主 `session.reply` 支持图片和文件（`{ image }` / `{ media }`），
 * 但插件的回复通道一直只发纯文本 —— 模型抓到一张图、生成一个文件，
 * 都只能把 URL 塞进正文让用户自己点。有了这个，工具可以直接「把结果发出去」。
 */
export interface OutboundMedia {
  type: 'image' | 'file' | 'voice' | 'video'
  /** 由平台拉取。QQ 的图片 CDN 地址可直接用 */
  url?: string
  /** 直传。小图/小文件用；大文件请用 url（base64 会撑大 1/3 且吃 CPU） */
  base64?: string
  /** 文件名，`file` 类型会显示在聊天里 */
  filename?: string
  /** 可选的说明文字，会和媒体一起发出 */
  caption?: string
}

export interface ToolResult {
  status: ToolResultStatus
  output?: unknown
  error?: {
    code: string
    message: string
    retryable: boolean
  }
  /**
   * 这个工具的产出要作为一条富媒体消息发给用户。
   *
   * 与 `behavior.preventsFinalResponse` 配合：带了 outbound 的工具发完之后，
   * loop 不再补一条纯文本回复（否则用户会收到「图 + 一句重复的话」）。
   */
  outbound?: OutboundMedia
}

export type ToolExecutor = (context: ToolExecutionContext) => Promise<ToolResult>

export interface RegisteredTool {
  definition: ToolDefinition
  source: ToolSource
  execute: ToolExecutor
}
