/**
 * plugin-llm 的 `llm` 服务契约（本地声明）。
 *
 * **为什么不 import `qflarebot-plugin-llm`**：那个插件的 README 明确写了
 * 「这个文件只导出类型；外部插件不能安装本包，按 README 的声明片段结构对齐即可」。
 * 插件之间通过 `ctx.service('llm')` 拿运行时对象，类型靠各自声明对齐——
 * 这样两个插件可以独立发布、独立升级，不需要互为依赖。
 *
 * 契约版本 1。形状一旦变会换服务名（`llm2`），所以这里写死 1 是安全的。
 * 改这个文件前先看 https://github.com/clown145/qflarebot-plugin-llm 的 src/contract.ts。
 */

export type LLMCapability = 'text' | 'image' | 'audio' | 'tools' | 'json' | 'reasoning'

export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url?: string; data?: string; media_type?: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'audio'; url?: string; data?: string; media_type?: string; format?: string }
  | { type: 'file'; url?: string; data?: string; media_type?: string; filename?: string }

export type LLMMessageContent = string | LLMContentPart[]

export interface LLMToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface LLMToolCall {
  id: string
  name: string
  /** JSON 字符串。OpenAI 原样，Anthropic 的 input 对象序列化 */
  arguments: string
}

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: LLMMessageContent
  tool_calls?: LLMToolCall[]
  tool_call_id?: string
  is_error?: boolean
  /** 推理内容只作本地记录，回传会被静默忽略 */
  reasoning?: string
}

export type LLMToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface LLMChatRequest {
  /** 模型别名；省略时用插件配置里的默认模型 */
  model?: string
  messages: LLMChatMessage[]
  tools?: LLMToolDefinition[]
  tool_choice?: LLMToolChoice
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
  json?: boolean
  timeout_ms?: number
  signal?: AbortSignal
  extra_body?: Record<string, unknown>
}

export interface LLMUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export interface LLMChatResult {
  text: string
  reasoning?: string
  tool_calls?: LLMToolCall[]
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'
  alias: string
  provider: string
  model: string
  usage?: LLMUsage
  latency_ms: number
}

export interface LLMModelInfo {
  alias: string
  provider: string
  model: string
  capabilities: LLMCapability[]
  context_window?: number
  max_output_tokens?: number
}

export interface LLMResolvedModel extends LLMModelInfo {
  provider_name: string
}

export interface LLMPingResult {
  ok: boolean
  latency_ms: number
  alias?: string
  provider?: string
  model?: string
  text?: string
  usage?: LLMUsage
  error?: string
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'reasoning_delta' | 'tool_call_delta' | 'done'
  // 具体字段见 plugin-llm 的 contract.ts；本插件只用非流式 chat，这里留最小定义
  text?: string
  result?: LLMChatResult
}

/** `ctx.service<LLMService>('llm')` 拿到的对象 */
export interface LLMService {
  readonly contractVersion: 1
  listModels(): Promise<LLMModelInfo[]>
  resolve(alias?: string): Promise<LLMResolvedModel>
  chat(req: LLMChatRequest): Promise<LLMChatResult>
  stream(req: LLMChatRequest): AsyncIterable<LLMStreamEvent>
  ping(opts?: { alias?: string; provider?: string }): Promise<LLMPingResult>
}

/** plugin-llm 抛的错带 code。跨插件调用不要依赖 instanceof，看 code */
export type LLMErrorCode =
  | 'config'
  | 'unknown_model'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'upstream'
  | 'bad_request'
  | 'bad_response'
  | 'unsupported'
