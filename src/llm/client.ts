/**
 * 把 plugin-llm 的 `llm` 服务适配成 loop 需要的形状。
 *
 * ## 为什么中间隔一层
 *
 * plugin-llm 的契约（`ChatRequest` / `ChatResult`）和 serverless-agent 的
 * `ModelRequest` / `ModelResponse` 形状不同，主要差三处：
 *
 * 1. **工具调用的 arguments**：plugin-llm 用 JSON 字符串（对齐 OpenAI），
 *    loop 里用对象。边界上做一次 parse，失败就当成空对象并把原始串塞进错误。
 * 2. **推理内容与签名**：原样保留并回填下一轮工具调用。
 * 3. **usage 字段名**：plugin-llm 是 snake_case（`input_tokens`）。
 *
 * 隔离这一层的另一个好处：将来 llm 服务换版本（比如 `llm2`），只改这里。
 */
import type { LLMService } from './contract.js'
import type { ModelMessage, ModelResponse, ModelTool, ModelToolCall } from '../types.js'

export interface LLMCallOptions {
  model: string
  messages: ModelMessage[]
  tools?: ModelTool[]
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** plugin-llm 抛的错带 code，这里原样保留，让上层能按 code 决定要不要重试 */
export class LLMCallError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(message: string, code: string) {
    super(message)
    this.name = 'LLMCallError'
    this.code = code
    // 429 / 5xx / 网络错误值得重试；认证、参数、未知模型重试没用
    this.retryable = code === 'rate_limit' || code === 'network' || code === 'upstream' || code === 'timeout'
  }
}

/**
 * 把内部 ModelMessage 转成 plugin-llm 的 ChatMessage。
 *
 * 注意 tool 消息：plugin-llm 要 `tool_call_id`，且 assistant 消息里的 tool_calls
 * 必须原样回传（否则上游不知道这个 tool 结果是回应哪次调用的）。
 */
function toChatMessages(messages: ModelMessage[]) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool' as const,
        content: message.content,
        tool_call_id: message.toolCallId,
      }
    }

    if (message.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: message.content ?? '',
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              })),
            }
          : {}),
        ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
        ...(message.thoughtSignatures ? { thought_signatures: message.thoughtSignatures } : {}),
        ...(message.reasoningSignatures ? { reasoning_signatures: message.reasoningSignatures } : {}),
      }
    }

    if (message.role === 'system') {
      return { role: 'system' as const, content: message.content }
    }

    // user：字符串直接传；片段数组要转成 plugin-llm 的 ContentPart
    if (typeof message.content === 'string') {
      return { role: 'user' as const, content: message.content }
    }
    return {
      role: 'user' as const,
      content: message.content.map((part) =>
        part.type === 'text'
          ? { type: 'text' as const, text: part.text }
          : {
              type: 'image' as const,
              ...(part.url ? { url: part.url } : {}),
              ...(part.data ? { data: part.data } : {}),
              ...(part.mediaType ? { media_type: part.mediaType } : {}),
            },
      ),
    }
  })
}

function toModelTool(tool: ModelTool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

/**
 * 解析工具调用参数。
 *
 * 上游偶尔会返回空串或坏 JSON（尤其流式拼装时）。这种情况不能整个 run 失败——
 * 把参数当成空对象，让工具自己报"缺少参数"，比直接崩掉好排查。
 */
function parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    throw new LLMCallError(`工具 ${toolName} 的参数不是合法 JSON`, 'bad_response')
  }
}

export async function callLLM(llm: LLMService, options: LLMCallOptions): Promise<ModelResponse> {
  const request = {
    model: options.model,
    messages: toChatMessages(options.messages),
    ...(options.tools?.length ? { tools: options.tools.map(toModelTool) } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  }

  let result
  try {
    result = await llm.chat(request)
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'upstream'
    const message = error instanceof Error ? error.message : String(error)
    throw new LLMCallError(message, code)
  }

  const toolCalls: ModelToolCall[] = (result.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.name,
    arguments: parseToolArguments(call.arguments, call.name),
  }))

  return {
    ...(result.text ? { content: result.text } : {}),
    toolCalls,
    ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
    ...(result.thought_signatures ? { thoughtSignatures: result.thought_signatures } : {}),
    ...(result.reasoning_signatures ? { reasoningSignatures: result.reasoning_signatures } : {}),
    ...(result.usage
      ? {
          usage: {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
            totalTokens: result.usage.total_tokens,
          },
        }
      : {}),
  }
}
