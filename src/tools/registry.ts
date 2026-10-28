/**
 * 工具注册表。协议照搬 serverless-agent 的 `ToolDefinition` / `ToolResult`。
 *
 * ## 相对 serverless-agent 做了哪些减法
 *
 * 原实现每次工具调用要写 D1 三处：`tool_calls` 记录 + 完成态更新 + `audit_logs`。
 * 按免费版 10 万行/日、一次 run 3 次工具调用算，只够 1 万次对话，而且这是
 * 全机器人共享的额度。所以这里：
 *
 * - 审计改成**可选**（`enable_audit`，默认关），打开才写 D1。
 * - 不做 `run_steps` 逐步记录，排障走 `ctx.logger`。
 * - 权限从 6 级 + scope 简化成 3 档（对齐 QFlareBot 的 `PermissionTier`）。
 *
 * 工具本身的实现（http / web / time / search）是照搬的，只换了存储调用。
 */
import type { Logger, PluginDB } from '@qqbot/sdk'
import type { ModelTool } from '../types.js'

/** 工具副作用等级。决定是否需要用户确认 */
export type SideEffect = 'none' | 'workspace_write' | 'external_write' | 'dangerous'

export type ToolResultStatus = 'success' | 'failed' | 'permission_denied' | 'needs_confirmation'

export interface ToolResult {
  status: ToolResultStatus
  output?: unknown
  error?: { code: string; message: string; retryable: boolean }
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema */
  parameters: Record<string, unknown>
  sideEffect: SideEffect
  /** 单次执行超时（毫秒） */
  timeoutMs: number
  /**
   * 是否默认启用。`enable_tools` 是总开关，这里是分开关：
   * 例如 vfs 工具要求 `enable_vfs`，schedule 要求 `enable_schedule`。
   */
  requires?: 'vfs' | 'schedule' | 'mcp'
}

export interface ToolExecutionContext {
  db: PluginDB
  logger: Logger
  /** 会话标识，工具可能需要（比如 schedule 记录是谁建的） */
  conversation: string
  userId: string
  /** 回复目标，messaging 类工具用 */
  scene: string
  targetId: string
  runId: string
  /** 时区，time 工具用 */
  timezone: string
  /** 让工具把"这个 run 已经发过消息了"告诉 loop（避免 loop 再补一条最终回复） */
  markReplied: () => void
}

export type ToolExecutor = (input: unknown, context: ToolExecutionContext) => Promise<ToolResult>

export interface RegisteredTool {
  definition: ToolDefinition
  execute: ToolExecutor
}

export interface ToolRegistry {
  list(): RegisteredTool[]
  get(name: string): RegisteredTool | undefined
  /** 转成模型能吃的形状 */
  toModelTools(): ModelTool[]
  execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult>
}

export interface RegistryOptions {
  /** 启用的可选工具组 */
  enabled?: Set<'vfs' | 'schedule' | 'mcp'>
}

export function createToolRegistry(
  tools: RegisteredTool[],
  options: RegistryOptions = {},
): ToolRegistry {
  const enabled = options.enabled ?? new Set()
  const byName = new Map<string, RegisteredTool>()

  for (const tool of tools) {
    const requires = tool.definition.requires
    if (requires && !enabled.has(requires)) continue
    byName.set(tool.definition.name, tool)
  }

  return {
    list: () => [...byName.values()],
    get: (name) => byName.get(name),
    toModelTools: () =>
      [...byName.values()].map((tool) => ({
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.parameters,
      })),

    execute: async (name, input, context) => {
      const tool = byName.get(name)
      if (!tool) {
        return {
          status: 'failed',
          error: { code: 'unknown_tool', message: `未知工具：${name}`, retryable: false },
        }
      }

      // 超时保护：工具自己也可能不守时，这里兜一层
      try {
        return await withTimeout(
          tool.execute(input, context),
          tool.definition.timeoutMs,
          `工具 ${name} 执行超时（${tool.definition.timeoutMs}ms）`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          status: 'failed',
          error: { code: 'tool_error', message, retryable: false },
        }
      }
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 工具结果转成模型能读的文本。对齐 serverless-agent 的 stringifyToolResult */
export function stringifyToolResult(result: ToolResult): string {
  if (result.status === 'success') {
    if (result.output === undefined) return 'ok'
    return typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
  }
  const error = result.error
  return JSON.stringify({
    status: result.status,
    code: error?.code ?? 'error',
    message: error?.message ?? '工具执行失败',
  })
}
