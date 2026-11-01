/**
 * 模型调用 → 工具执行 → 回填结果。模型与工具前后保存检查点，跨执行预算接续。
 * 已完成的工具不重做；中断时结果未知的写操作停止自动恢复，只读操作允许重试。
 * 循环结构参考 serverless-agent；平台调度、持久化与租约由本插件负责。
 */
import type { Logger } from '@qqbot/sdk'
import { callLLM, LLMCallError, type LLMCallOptions } from '../llm/client.js'
import { compactMessages, estimateMessagesTokens } from './context-size.js'
import type { SummaryInput } from '../do/agent-object.js'
import type { LLMService } from '../llm/contract.js'
import type { HistoryToolTrace, HistoryUserInput, ModelMessage, ModelResponse, ModelToolCall } from '../types.js'
import { executeAgentToolCall } from './tool-executor.js'
import type { ToolRegistry, ToolExecuteInput } from '../tools/registry.js'
import { toModelTools } from '../tools/registry.js'

export interface LoopCheckpoint {
  /** 保留实际输入，恢复完成后仍按首次正文写历史。 */
  historyInput?: HistoryUserInput
  toolBindings?: Record<string, { id: string; revision: string }>
  version: 1
  model?: string
  modelRetries?: number
  messages: ModelMessage[]
  steps: number
  usedToolCalls: number
  repliedByTool: boolean
  usage: { inputTokens: number; outputTokens: number }
  compactedRounds: number
  droppedForSummary: SummaryInput[]
  contextTokens: number
  toolTraces: HistoryToolTrace[]
  outbound: import('../tools/types.js').OutboundMedia[]
  pending: ModelToolCall[]
  inFlight?: { id: string; name: string; sideEffect: string }
  result?: LoopResult
  /** 发送前登记，避免平台中断后再次发送同一条消息。 */
  delivery?: { media: number; text: boolean }
}

export class LoopYieldError extends Error {
  constructor() { super('本次执行预算已用完，已保存进度等待接续'); this.name = 'LoopYieldError' }
}

export interface LoopOptions {
  checkpoint?: LoopCheckpoint | null
  onCheckpoint?: (checkpoint: LoopCheckpoint) => Promise<void>
  deadline?: number
  llm: LLMService
  registry: ToolRegistry
  logger: Logger
  model: string
  messages: ModelMessage[]
  maxModelSteps: number
  maxToolCalls: number
  requestTimeoutMs: number
  /** 工具执行上下文（不含 input / toolCallId，那两项由 executor 补） */
  toolContext: Omit<ToolExecuteInput, 'input' | 'toolCallId'>
  /** 每步回调，用于可观测 */
  onStep?: (step: number) => Promise<void>
  /**
   * 取消信号。`/stop` 与 `reset` 走这条路。
   *
   * 跨 isolate 的取消没法直接传对象（DO 与 Worker 是两个 isolate），
   * 所以实际是**两级**：
   * 1. 本层每步开始前调一次 `isCancelled()`（轮询 DO storage 里的 run 状态）；
   * 2. 调用方另有一个轮询器，发现取消后 `signal.abort()`，
   *    让**正在飞的**那次模型调用立刻断开——否则用户按 `/stop` 还得等模型吐完。
   */
  signal?: AbortSignal
  /** 判据：这个 run 是否已被取消（每步开头问一次）。返回不可用时按「未取消」处理 */
  isCancelled?: () => Promise<boolean>
  /**
   * 单次模型调用的重试配置。
   *
   * **重试必须在这一层做，不能重跑整个 loop**：loop 跑过一步之后，
   * 之前执行过的工具已经产生了副作用（`schedule.create` 已经 INSERT 过一行），
   * 整个 loop 重来会让副作用执行两次。而这里重试的只是**那一次模型调用**，
   * 消息数组与工具执行状态原地不动。
   */
  retry?: {
    /** 额外重试几次。固定 1 次：两次都失败说明不是瞬时抖动 */
    times: number
    /** 重试前的等待。测试传 0 */
    delayMs: number
  }
  /**
   * 上下文压缩配置。**每个模型步之前**都会检查一次（对标 AstrBot
   * 的 `tool_loop_agent_runner.py` —— 它也是在每次 provider 调用前压，而不是每 run 一次）。
   *
   * 为什么必须在循环**内部**压：一轮 run 里工具可以来回收很多次，
   * 工具结果不断堆进 messages，只在开头压一次等于没压。
   */
  compaction?: {
    mode: 'off' | 'truncate'
    maxTokens: number
  }
}

export interface LoopResult {
  /** 最终文本。模型没给文本但工具已经发过消息时为 undefined */
  reply?: string
  /** 最终回答的推理字段，保存到历史以支持后续用户轮次的 reasoning_content 回填。 */
  reasoning?: string
  /** 是否已经有工具把消息发出去了 */
  repliedByTool: boolean
  steps: number
  toolCalls: number
  usage: { inputTokens: number; outputTokens: number }
  /** 本次 run 里压缩丢掉的轮数（0 = 没压）。排障用 */
  compactedRounds: number
  /**
   * 被压缩丢掉的轮次正文（只含 user / assistant，按时间顺序）。
   *
   * `summary` 模式拿它生成摘要，由调用方（run.ts）交给 DO 暂存。
   * `truncate` / `off` 模式下调用方不看它，这里也就不会有内容。
   */
  droppedForSummary: SummaryInput[]
  /** 最后一次模型调用后的上下文 token 估算，用于观察长会话是否逼近上限 */
  contextTokens: number
  /**
   * 本次 run 调用过的工具摘要。
   *
   * 用途是**写进会话历史**，让模型下一轮知道「我上次调过什么、拿到什么」。
   * 以前历史里只存纯文本，模型看不到自己的工具调用 → 容易重复调同一个工具。
   *
   * 只存截断后的摘要，不存完整结果：历史按条数占 DO storage 配额，
   * 完整结果（可能几十 KB）会把配额吃光。
   */
  toolTraces: HistoryToolTrace[]
  /**
   * 本次 run 里工具产出的、要发给用户的富媒体。
   *
   * 收集起来由调用方（run.ts）在回复阶段发出：工具自己拿不到 session，
   * 而「发消息」这件事属于回复通道的职责。
   */
  outbound: import('../tools/types.js').OutboundMedia[]
}

/** 步数或工具数用尽。照搬原文的 LoopLimitError 语义 */
export class LoopLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoopLimitError'
  }
}

/**
 * run 被用户取消（`/stop` 或 `/agent reset`）。
 *
 * 单独一个错误类而不是返回空结果：调用方（run.ts）需要区分
 * 「模型答完了」与「用户喊停」——后者的语义是**不回复、不写历史**。
 */
export class LoopCancelledError extends Error {
  constructor(message = '这轮回答已被用户取消') {
    super(message)
    this.name = 'LoopCancelledError'
  }
}

/**
 * 判断这次错误能不能重试。与 `describeLoopError` 同一套判据，
 * 但只关心「值不值得再来一次」。
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof LLMCallError) return error.retryable
  return false
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 单次模型调用的重试包装。
 *
 * **这是本文件最要紧的一处语义**：重试的是「这一次模型调用」，
 * 不是整个 loop。旧实现把重试放在 `run.ts` 外面、重跑 `runLoopOnce`，
 * 于是第一步已经 `schedule.create` 过（DML 已落库）之后，第二步 429
 * 会让整个 loop 从头再来一遍——工具副作用执行两次。
 *
 * 这里消息数组、工具执行状态、已累计的 usage 全部原地保留，
 * 失败的只有这一次 HTTP 调用。
 */
async function callLLMWithRetry(
  llm: LLMService,
  request: LLMCallOptions,
  retry: LoopOptions['retry'],
  logger: Logger,
  step: number,
  checkCancelled: () => Promise<void>,
  checkBudget: (delayMs?: number) => void,
  retriesUsed: number,
  saveRetry: (attempt: number) => Promise<void>,
): Promise<ModelResponse> {
  const attempts = Math.max(0, Math.trunc(retry?.times ?? 0))
  const delayMs = retry?.delayMs ?? 0

  for (let attempt = retriesUsed; ; attempt += 1) {
    // 重试等待期间也可能被 /stop；不要再发下一次模型请求。
    if (attempt > 0) await checkCancelled()
    checkBudget()
    try {
      return await callLLM(llm, request)
    } catch (error) {
      // abort 与「上游返回错误」要分开：用户按了 /stop 之后 LLM 层会抛一个
      // 带 code='aborted' 的错误，它落到普通错误路径会变成一条「模型调用失败」
      // 的回复——而用户说的正是「别说了」。这里把它归一成取消语义。
      if (request.signal?.aborted) throw new LoopCancelledError()
      if (attempt >= attempts || !isRetryableError(error)) throw error
      await saveRetry(attempt + 1)
      checkBudget(delayMs)
      const described = error instanceof LLMCallError ? error.message : String(error)
      logger.warn('模型调用可重试错误，重试这一次调用', {
        step,
        attempt: attempt + 1,
        delayMs,
        error: described,
      })
      await sleep(delayMs)
    }
  }
}

/**
 * 取消判定的两个来源合在一起：
 * 1. 本地 AbortSignal（同 isolate 内可以直接 abort）；
 * 2. 调用方给的 `isCancelled()`（跨 isolate 时轮询 DO storage 里的 run 状态）。
 *
 * 判定失败（DO 抖动）按「未取消」处理：一次 storage 读失败不该误杀正常对话。
 */
export async function throwIfCancelled(
  options: Pick<LoopOptions, 'signal' | 'isCancelled' | 'logger'>,
): Promise<void> {
  if (options.signal?.aborted) throw new LoopCancelledError()
  if (!options.isCancelled) return
  try {
    if (await options.isCancelled()) throw new LoopCancelledError()
  } catch (error) {
    if (error instanceof LoopCancelledError) throw error
    options.logger.warn('取消状态检查失败，按未取消继续', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const { llm, registry, logger, model, maxModelSteps, requestTimeoutMs, toolContext } = options
  const state: LoopCheckpoint = options.checkpoint ? structuredClone(options.checkpoint) : {
    version: 1, model, messages: [...options.messages], steps: 0, usedToolCalls: 0,
    repliedByTool: false, usage: { inputTokens: 0, outputTokens: 0 },
    compactedRounds: 0, droppedForSummary: [], contextTokens: 0,
    toolTraces: [], outbound: [], pending: [],
  }
  const bindings = Object.fromEntries(registry.list().flatMap(t => t.definition.binding ? [[t.definition.name, t.definition.binding]] : []))
  state.toolBindings ??= options.checkpoint ? {} : bindings
  const tools = toModelTools(registry.list().filter(t => !t.definition.binding || state.toolBindings?.[t.definition.name]?.revision === t.definition.binding.revision))
  const allowedToolNames = new Set(tools.map(t => t.name))
  const persist = async () => { await options.onCheckpoint?.(state) }
  const budget = (operationMs: number) => {
    if (options.deadline !== undefined && Date.now() + operationMs + 1_500 > options.deadline) throw new LoopYieldError()
  }
  // 在第一次网络请求之前也保存，硬中断后沿用同一份上下文。
  await persist()

  while (true) {
    await throwIfCancelled(options)
    if (state.result) return state.result

    // 模型响应先持久化，再逐个执行工具；恢复时跳过已有结果的工具。
    while (state.pending.length) {
      const toolCall = state.pending[0]!
      await throwIfCancelled(options)
      const tool = registry.get(toolCall.name)
      if (state.inFlight && state.inFlight.sideEffect !== 'none') {
        throw new LoopLimitError(`上次执行工具 ${state.inFlight.name} 时被中断，结果尚未确认。为避免重复操作，已停止自动重试，请先核对操作结果。`)
      }
      const pinned = state.toolBindings[toolCall.name]
      if (pinned && (!tool?.definition.binding || pinned.id !== tool.definition.binding.id || pinned.revision !== tool.definition.binding.revision)) {
        throw new LoopLimitError(`工具 ${pinned.id} 已停用、权限变化或版本更新，已停止这次调用，请重新发起任务。`)
      }
      budget(tool?.definition.timeoutMs ?? 1_000)
      if (!state.inFlight) {
        if (state.usedToolCalls >= options.maxToolCalls) {
          throw new LoopLimitError(`单次对话最多调用 ${options.maxToolCalls} 次工具，已经用完。可以让我少做几步，或者把任务拆开。`)
        }
        state.usedToolCalls++
        state.inFlight = { id: toolCall.id, name: toolCall.name, sideEffect: tool?.definition.sideEffect ?? 'none' }
        await persist()
      }
      const execution = await executeAgentToolCall({ registry, toolCall, allowedToolNames, context: { ...toolContext, stepId: String(state.steps), signal: options.signal, deadline: options.deadline }, logger })
      if (execution.result.status === 'unknown') {
        await persist()
        throw new LoopLimitError(`工具 ${toolCall.name} 的操作结果尚未确认，已停止自动重试，请先核对结果。`)
      }
      state.repliedByTool ||= execution.sentMessage
      if (execution.result.outbound) {
        state.outbound.push(execution.result.outbound)
        state.repliedByTool = true
      }
      if (execution.result.artifacts?.length) state.outbound.push(...execution.result.artifacts)
      state.toolTraces.push(toToolTrace(toolCall.name, toolCall.arguments, execution.result))
      state.messages.push(execution.resultMessage)
      state.pending.shift()
      delete state.inFlight
      await persist()
      await throwIfCancelled(options)
    }

    if (state.steps >= maxModelSteps) {
      throw new LoopLimitError(`一次对话最多推理 ${maxModelSteps} 步，已经用完。可以让我少做几步，或者把任务拆开。`)
    }
    budget(requestTimeoutMs)
    await options.onStep?.(state.steps + 1)
    await throwIfCancelled(options)
    const compaction = options.compaction
    if (compaction && compaction.mode !== 'off') {
      const system = state.messages.filter(m => m.role === 'system')
      const systemTokens = estimateMessagesTokens(system)
      const compacted = compactMessages(state.messages.filter(m => m.role !== 'system'), { maxTokens: compaction.maxTokens, systemTokens })
      if (compacted.droppedRounds || compacted.truncatedToolResults) {
        state.compactedRounds += compacted.droppedRounds
        for (const message of compacted.droppedMessages) {
          if (message.role === 'tool' || message.role === 'system') continue
          const content = typeof message.content === 'string' ? message.content :
            (message.content ?? []).map(p => p.type === 'text' ? p.text : '[图片]').join('\n')
          if (content.trim()) state.droppedForSummary.push({ role: message.role, content, ...(message.historyId ? { id: message.historyId } : {}) })
        }
        state.messages = [...system, ...compacted.messages]
        logger.info('上下文已压缩', { droppedRounds: compacted.droppedRounds, tokensBefore: compacted.tokensBefore, tokensAfter: compacted.tokensAfter })
      }
      state.contextTokens = compacted.tokensAfter + systemTokens
    } else state.contextTokens = estimateMessagesTokens(state.messages)
    await persist()
    const response = await callLLMWithRetry(llm, {
      model: state.model ?? model, messages: state.messages, ...(tools.length ? { tools } : {}),
      timeoutMs: requestTimeoutMs, ...(options.signal ? { signal: options.signal } : {}),
    }, options.retry, logger, state.steps + 1, () => throwIfCancelled(options),
    (delayMs = 0) => budget(requestTimeoutMs + delayMs), state.modelRetries ?? 0,
    async attempt => { state.modelRetries = attempt; await persist() })
    await throwIfCancelled(options)
    delete state.modelRetries
    state.steps++
    state.usage.inputTokens += response.usage?.inputTokens ?? 0
    state.usage.outputTokens += response.usage?.outputTokens ?? 0
    logger.debug('模型返回', { step: state.steps, toolCalls: response.toolCalls.length, hasContent: Boolean(response.content) })
    if (!response.toolCalls.length) {
      state.result = {
        ...(response.content ? { reply: response.content } : {}),
        ...(response.reasoning !== undefined ? { reasoning: response.reasoning } : {}),
        repliedByTool: state.repliedByTool, steps: state.steps, toolCalls: state.usedToolCalls,
        usage: state.usage, compactedRounds: state.compactedRounds,
        droppedForSummary: state.droppedForSummary, contextTokens: state.contextTokens,
        toolTraces: state.toolTraces, outbound: state.outbound,
      }
    } else {
      state.messages.push({ role: 'assistant', content: response.content ?? '', toolCalls: response.toolCalls,
        ...(response.reasoning !== undefined ? { reasoning: response.reasoning } : {}),
        ...(response.thoughtSignatures ? { thoughtSignatures: response.thoughtSignatures } : {}),
        ...(response.reasoningSignatures ? { reasoningSignatures: response.reasoningSignatures } : {}),
      })
      state.pending = [...response.toolCalls]
    }
    await persist()
  }
}

/**
 * 把一次工具调用压成一条可存历史的摘要。
 *
 * 为什么截断到 200 字符：历史在 DO storage 里按条数占配额，
 * 一次 `web.fetch_page` 就可能返回几万字符。存全文会让 DO storage 迅速膨胀，
 * 而模型真正需要知道的是「调过什么、大概拿到什么」。
 */
function toToolTrace(
  name: string,
  args: Record<string, unknown>,
  result: import('../tools/types.js').ToolResult,
): HistoryToolTrace {
  const clip = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}…` : text)
  let resultText: string
  if (result.status === 'success') {
    resultText = clip(safeJson(result.output))
  } else {
    resultText = `失败：${clip(result.error?.message ?? result.status)}`
  }

  return {
    name,
    args: clip(safeJson(args)),
    result: resultText,
    status: result.status,
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 把 LLM 错误翻译成给用户看的文案。区分「能重试」和「重试也没用」 */
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
      return {
        text: '模型服务的 API Key 有问题，请在「LLM 接口」插件页面检查配置。',
        retryable: false,
      }
    }
    if (error.code === 'unknown_model') {
      return { text: '配置的模型别名不存在，请在插件设置里检查「模型别名」。', retryable: false }
    }
    return { text: `模型调用失败：${error.message}`, retryable: error.retryable }
  }

  const message = error instanceof Error ? error.message : String(error)
  return { text: `处理失败：${message}`, retryable: false }
}
