/**
 * 一次工具调用的执行。照搬 serverless-agent 的 `src/core/agent-tool-executor.ts`（138 行）。
 *
 * 原文在这里做三件事，我都保留了：
 * 1. **白名单检查**（`allowedToolNames`）：模型可能编出不存在的工具名，
 *    或者调用被当前 skill 禁掉的工具。原文先查白名单再执行。
 * 2. **工具结果消息**：把 `ToolResult` 转成 `role: 'tool'` 的消息回填给模型。
 * 3. **`preventsFinalResponse`**：工具自己发了消息时标记 `sentMessage`，
 *    loop 结束时不再补一条。原文靠工具定义里的 `behavior.preventsFinalResponse`，
 *    我上一版靠名字前缀猜（`name.startsWith('messaging.')`），是错的。
 *
 * 原文的 skill 相关逻辑（`validateSkillToolCall`）没有搬——QFlareBot 没有 skill 机制。
 * 原文的 run-step 落库改成 logger（见 `loop.ts` 的注释）。
 */
import type { Logger } from '@qqbot/sdk'
import type { ToolRegistry, ToolExecuteInput } from '../tools/registry.js'
import { preventsFinalResponse, stringifyToolResult } from '../tools/registry.js'
import type { ModelMessage, ModelToolCall } from '../types.js'
import type { ToolResult } from '../tools/types.js'

export interface ToolExecution {
  result: ToolResult
  /** 回填给模型的消息 */
  resultMessage: ModelMessage
  /** 工具是否已经自己把结果发给用户了 */
  sentMessage: boolean
}

export async function executeAgentToolCall(input: {
  registry: ToolRegistry
  toolCall: ModelToolCall
  /** 本轮允许的工具名。模型编出来的名字会在这里被拦下 */
  allowedToolNames: Set<string>
  /** 除 input 外的执行上下文 */
  context: Omit<ToolExecuteInput, 'input' | 'toolCallId'>
  logger: Logger
}): Promise<ToolExecution> {
  const { registry, toolCall, allowedToolNames, context, logger } = input

  // 1. 白名单：模型可能调用不存在的工具，或调用本轮没开放的
  if (!allowedToolNames.has(toolCall.name)) {
    const result = disallowedToolResult(toolCall.name)
    logger.warn('模型调用了未开放的工具', { tool: toolCall.name })
    return {
      result,
      resultMessage: toToolResultMessage(toolCall, result),
      sentMessage: false,
    }
  }

  // 2. 执行
  const result = await registry.execute(toolCall.name, {
    ...context,
    toolCallId: toolCall.id,
    input: toolCall.arguments,
  })

  // 3. 工具自己发了消息就标记，避免 loop 结束时重复发
  const sentMessage =
    result.status === 'success' && preventsFinalResponse(registry.get(toolCall.name)?.definition)

  return {
    result,
    resultMessage: toToolResultMessage(toolCall, result),
    sentMessage,
  }
}

function disallowedToolResult(toolName: string): ToolResult {
  return {
    status: 'permission_denied',
    error: {
      code: 'tool_not_allowed',
      message: `工具 ${toolName} 不在本轮可用的工具里`,
      retryable: false,
    },
  }
}

/** 照搬原文 `createToolResultMessage` */
function toToolResultMessage(toolCall: ModelToolCall, result: ToolResult): ModelMessage {
  return {
    role: 'tool',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: stringifyToolResult(result),
  }
}
