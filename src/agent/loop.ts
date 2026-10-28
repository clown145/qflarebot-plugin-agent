/**
 * agent loop：模型调用 → 工具执行 → 结果回填 → 再调用，直到模型给出最终答复。
 *
 * 结构照搬 serverless-agent 的 `src/core/agent-tool-loop.ts`（182 行），
 * 保留它的两个关键约束：
 *
 * 1. **步数上限**（`maxModelSteps`）：失控的 loop 会烧光 DO 时长与 token。
 * 2. **工具调用上限**（`maxToolCalls`）：防止模型在一步里并发几十个工具。
 *
 * 相对原实现简化掉的：run_steps 逐步落库（改 logger）、pending action 确认流
 * （QFlareBot 的按钮回调更适合做这个，但本期没做）、多 provider 切换
 * （交给 plugin-llm 的模型别名）。
 */
import type { LLMService } from '../llm/contract.js'
import { callLLM, LLMCallError } from '../llm/client.js'
import type { Logger } from '@qqbot/sdk'
import type { ModelMessage, ModelToolCall } from '../types.js'
import type { ToolRegistry, ToolResult } from '../tools/registry.js'
import { stringifyToolResult } from '../tools/registry.js'

export interface LoopOptions {
  llm: LLMService
  registry: ToolRegistry
  logger: Logger
  model: string
  messages: ModelMessage[]
  maxModelSteps: number
  maxToolCalls: number
  requestTimeoutMs: number
  /** 工具执行上下文工厂 */
  toolContext: (toolName: string) => Parameters<ToolRegistry['execute']>[2]
  /** 每步回调，用于可观测与限额 */
  onStep?: (step: number) => Promise<void>
  /** 每次工具调用后回调，用于审计 */
  onToolCall?: (input: {
    name: string
    args: Record<string, unknown>
    result: ToolResult
    durationMs: number
  }) => Promise<void>
}

export interface LoopResult {
  /** 最终文本。模型没给文本但有工具已经发过消息时为 undefined */
  reply?: string
  /** 是否已经有工具（如 messaging）把消息发出去了 */
  repliedByTool: boolean
  steps: number
  toolCalls: number
  usage: { inputTokens: number; outputTokens: number }
}

export class LoopLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoopLimitError'
  }
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    llm,
    registry,
    logger,
    model,
    maxModelSteps,
    maxToolCalls,
    requestTimeoutMs,
    toolContext,
  } = options

  const messages = [...options.messages]
  const tools = registry.toModelTools()

  let steps = 0
  let toolCallCount = 0
  let repliedByTool = false
  let inputTokens = 0
  let outputTokens = 0

  for (let step = 0; step < maxModelSteps; step += 1) {
    steps = step + 1
    await options.onStep?.(steps)

    const response = await callLLM(llm, {
      model,
      messages,
      ...(tools.length ? { tools } : {}),
      timeoutMs: requestTimeoutMs,
    })

    inputTokens += response.usage?.inputTokens ?? 0
    outputTokens += response.usage?.outputTokens ?? 0

    logger.debug('模型返回', {
      step: steps,
      toolCalls: response.toolCalls.length,
      hasContent: Boolean(response.content),
    })

    // 没有工具调用 = 模型给出最终答复，loop 结束
    if (response.toolCalls.length === 0) {
      return {
        ...(response.content ? { reply: response.content } : {}),
        repliedByTool,
        steps,
        toolCalls: toolCallCount,
        usage: { inputTokens, outputTokens },
      }
    }

    // 把 assistant 的工具调用意图写回消息，模型下一轮才能看到自己调了什么
    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      toolCalls: response.toolCalls,
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    })

    for (const toolCall of response.toolCalls) {
      if (toolCallCount >= maxToolCalls) {
        throw new LoopLimitError(
          `单次对话最多调用 ${maxToolCalls} 次工具，已经用完。可以让我少做几步，或者把任务拆开。`,
        )
      }
      toolCallCount += 1

      const result = await executeOne(toolCall, registry, toolContext, logger, options.onToolCall)

      // 工具自己发了消息（messaging 类）就记下来，避免 loop 结束时重复补一条
      if (isRepliedByTool(toolCall.name, result)) repliedByTool = true

      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: stringifyToolResult(result),
      })
    }
  }

  throw new LoopLimitError(
    `一次对话最多推理 ${maxModelSteps} 步，已经用完。可以让我少做几步，或者把任务拆开。`,
  )
}

async function executeOne(
  toolCall: ModelToolCall,
  registry: ToolRegistry,
  toolContext: LoopOptions['toolContext'],
  logger: Logger,
  onToolCall: LoopOptions['onToolCall'],
): Promise<ToolResult> {
  const startedAt = Date.now()
  let result: ToolResult

  try {
    result = await registry.execute(toolCall.name, toolCall.arguments, toolContext(toolCall.name))
  } catch (error) {
    // registry.execute 内部已经兜了异常，这里是最后一道
    const message = error instanceof Error ? error.message : String(error)
    result = { status: 'failed', error: { code: 'tool_error', message, retryable: false } }
  }

  const durationMs = Date.now() - startedAt
  logger.info('工具执行', {
    tool: toolCall.name,
    status: result.status,
    durationMs,
    ...(result.error ? { error: result.error.code } : {}),
  })

  await onToolCall?.({
    name: toolCall.name,
    args: toolCall.arguments,
    result,
    durationMs,
  })

  return result
}

/**
 * 判断这次工具调用是否已经把消息发给了用户。
 *
 * 目前只有 messaging 系列会；将来加别的"有副作用的回复类工具"要在这里登记。
 * 漏了的话表现是用户收到两条一样的回复。
 */
function isRepliedByTool(name: string, result: ToolResult): boolean {
  if (result.status !== 'success') return false
  return name.startsWith('messaging.') || name === 'vfs.command'
}

/** 把 LLM 错误翻译成给用户看的文案。区分"能重试"和"重试也没用" */
export function describeLoopError(error: unknown): { text: string; retryable: boolean } {
  if (error instanceof LoopLimitError) {
    return { text: error.message, retryable: false }
  }
  if (error instanceof LLMCallError) {
    if (error.code === 'rate_limit') {
      return { text: '模型服务正在限流，稍后再试一下。', retryable: true }
    }
    if (error.code === 'timeout') {
      return { text: '模型响应超时了，稍后再试。', retryable: true }
    }
    if (error.code === 'auth') {
      return { text: '模型服务的 API Key 有问题，请在「LLM 接口」插件页面检查配置。', retryable: false }
    }
    if (error.code === 'unknown_model') {
      return { text: '配置的模型别名不存在，请在插件设置里检查「模型别名」。', retryable: false }
    }
    return { text: `模型调用失败：${error.message}`, retryable: error.retryable }
  }

  const message = error instanceof Error ? error.message : String(error)
  return { text: `处理失败：${message}`, retryable: false }
}
