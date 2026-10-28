/**
 * 工具注册表。照搬 serverless-agent 的 `src/tools/registry/tool-registry.ts`（181 行）。
 *
 * ## 执行顺序（与原文一致）
 *
 * ```text
 * 查工具 → 平台可用性 → 权限判定 → 记录调用 → 需要确认？
 *   ├─ 是 → 返回 needs_confirmation（模型据此问用户）
 *   └─ 否 → 执行 → 记录结果 → 审计 → 返回
 * ```
 *
 * ## 相对原文的减法
 *
 * 原文每次调用写 D1 三处（`tool_calls` 记录 + 完成态 + `audit_logs`）。
 * 按免费版 10 万行/日、一次 run 3 次工具调用算只够 1 万次对话，而且这是
 * 全机器人共享的额度。这里：
 *
 * - **审计做成开关**（`enable_audit`，默认关），打开才写 `{tool_audit}`。
 * - **不写 `tool_calls` 记录表**——工具调用的可观测性走 `ctx.logger`，
 *   真要排障再开审计。
 * - **二次确认不落 `pending_actions` 表**——那套依赖 Queues。改成返回给模型，
 *   由模型向用户要确认（见 `permissions/policy.ts` 的注释）。
 */
import type { Logger, PluginDB } from '@qqbot/sdk'
import { evaluateToolPermission } from '../permissions/policy.js'
import type {
  RegisteredTool,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from './types.js'

export type { RegisteredTool, ToolResult } from './types.js'

export type ToolRegistry = {
  execute(name: string, input: ToolExecuteInput): Promise<ToolResult>
  get(name: string): RegisteredTool | undefined
  list(): RegisteredTool[]
}

export interface ToolExecuteInput {
  db: PluginDB
  logger: Logger
  conversationId: string
  actorId: string
  actorRole?: 'owner' | 'admin' | 'member' | 'unknown'
  scene: string
  targetId: string
  runId: string
  stepId: string
  toolCallId: string
  input: unknown
  timezone: string
  allowDangerous?: boolean
  /** 审计回调；不传就不记 */
  onAudit?: (entry: {
    toolName: string
    status: string
    inputJson: string
    outputJson?: string
    errorCode?: string
    durationMs: number
  }) => Promise<void>
}

export function createToolRegistry(tools: RegisteredTool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]))

  return {
    get: (name) => byName.get(name),
    list: () => tools,

    execute: async (name, input) => {
      const tool = byName.get(name)
      if (!tool) {
        return failed('unknown_tool', `未知工具：${name}`, false)
      }

      const startedAt = Date.now()
      const context: ToolExecutionContext = {
        db: input.db,
        logger: input.logger,
        conversationId: input.conversationId,
        actorId: input.actorId,
        actorRole: input.actorRole,
        scene: input.scene,
        targetId: input.targetId,
        runId: input.runId,
        stepId: input.stepId,
        toolCallId: input.toolCallId,
        input: input.input,
        timezone: input.timezone,
        allowDangerous: input.allowDangerous,
      }

      // 1. 权限判定
      const decision = await evaluateToolPermission(tool.definition, context)

      if (decision.needsConfirmation) {
        const reason = decision.reason ?? '需要确认'
        await input.onAudit?.({
          toolName: name,
          status: 'needs_confirmation',
          inputJson: safeJson(input.input),
          errorCode: 'needs_confirmation',
          durationMs: Date.now() - startedAt,
        })
        return {
          status: 'needs_confirmation',
          error: { code: 'needs_confirmation', message: reason, retryable: false },
        }
      }

      if (!decision.allowed) {
        const reason = decision.reason ?? '权限不足'
        input.logger.warn('工具权限不足', {
          tool: name,
          reason,
          sources: decision.policySources,
        })
        await input.onAudit?.({
          toolName: name,
          status: 'permission_denied',
          inputJson: safeJson(input.input),
          errorCode: 'permission_denied',
          durationMs: Date.now() - startedAt,
        })
        return {
          status: 'permission_denied',
          error: { code: 'permission_denied', message: reason, retryable: false },
        }
      }

      // 2. 执行
      const result = await executeToolSafely(tool, context, input.logger)
      const durationMs = Date.now() - startedAt

      await input.onAudit?.({
        toolName: name,
        status: result.status,
        inputJson: safeJson(input.input),
        outputJson: result.output !== undefined ? safeJson(result.output).slice(0, 2000) : undefined,
        errorCode: result.error?.code,
        durationMs,
      })

      return result
    },
  }
}

/**
 * 执行工具并兜住异常。
 *
 * 与原文的差异：多了一层超时。原文把 timeout 交给工具自己（`definition.timeoutMs`），
 * 但工具不守时会把整个 run 挂住——而 run 挂住会占着 DO 的租约，
 * 直到 90 秒租约到期才被回收。这里主动 race 一下。
 */
async function executeToolSafely(
  tool: RegisteredTool,
  context: ToolExecutionContext,
  logger: Logger,
): Promise<ToolResult> {
  try {
    return await withTimeout(
      tool.execute(context),
      tool.definition.timeoutMs,
      `工具 ${tool.definition.name} 执行超时（${tool.definition.timeoutMs}ms）`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '工具执行失败'
    logger.error('工具执行异常', { tool: tool.definition.name, error: message })
    return failed('tool_execution_error', message, true)
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

/** 序列化入参，循环引用等异常时退回占位串，不让审计把主流程带崩 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
}

function failed(code: string, message: string, retryable: boolean): ToolResult {
  return { status: 'failed', error: { code, message, retryable } }
}

/** 把工具定义转成模型能吃的形状。照搬原文 `createModelTools` */
export function toModelTools(tools: RegisteredTool[]) {
  return tools.map((tool) => ({
    name: tool.definition.name,
    description: tool.definition.description,
    parameters: tool.definition.inputSchema,
  }))
}

/** 工具结果转成模型能读的文本。照搬原文 `stringifyToolResult` */
export function stringifyToolResult(result: ToolResult): string {
  if (result.status === 'success') {
    if (result.output === undefined) return 'ok'
    return typeof result.output === 'string' ? result.output : safeJson(result.output)
  }
  const error = result.error
  return safeJson({
    status: result.status,
    code: error?.code ?? 'error',
    message: error?.message ?? '工具执行失败',
  })
}

/** 从工具定义取 `preventsFinalResponse`。照搬原文，替代我原来靠名字前缀猜的做法 */
export function preventsFinalResponse(tool: ToolDefinition | undefined): boolean {
  return tool?.behavior?.preventsFinalResponse === true
}
