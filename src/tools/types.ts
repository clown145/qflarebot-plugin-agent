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

export interface ToolResult {
  status: ToolResultStatus
  output?: unknown
  error?: {
    code: string
    message: string
    retryable: boolean
  }
}

export type ToolExecutor = (context: ToolExecutionContext) => Promise<ToolResult>

export interface RegisteredTool {
  definition: ToolDefinition
  source: ToolSource
  execute: ToolExecutor
}
