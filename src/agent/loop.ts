/**
 * agent loop：模型调用 → 工具执行 → 结果回填 → 再调用，直到模型给出最终答复。
 *
 * 结构照搬 serverless-agent 的 `src/core/agent-tool-loop.ts`（182 行）。
 * 原文的骨架：
 *
 * ```text
 * for (let index = 0; index < maxModelSteps; index++) {
 *   response = provider.complete(...)
 *   if (no toolCalls) { finishRun(); return }
 *   messages.push(assistant + toolCalls)
 *   for (toolCall of response.toolCalls) {
 *     if (!reserveToolCall(limit)) { failRun(); return }
 *     execution = executeAgentToolCall(...)
 *     sentMessageTool ||= execution.sentMessage
 *     messages.push(execution.resultMessage)
 *   }
 * }
 * failRun('maximum model reasoning steps exceeded')
 * ```
 *
 * 逐条对齐了这个骨架，包括：
 * - **两个独立的限额**：模型步数 + 工具调用数，各自的计数与错误文案分开
 * - **`sentMessageTool` 累加**：工具发过消息就不再补最终回复
 * - **超过步数上限时抛错**，而不是静默返回空
 *
 * 相对原文的差异：
 * - 原文每步写 `run_steps` 到 D1（`recordModelStep` / `recordToolRequestedStep` /
 *   `recordToolCompletedStep`），这里改成 `logger` + 可选的 `onStep` 回调。
 *   按免费版 10 万行/日算，逐步落库只够 5,000 次对话。
 * - 原文的 `waiting_for_device`（RayNeo 设备异步回传）没有搬——那是私有硬件协议。
 * - 原文从 `context.provider` 拿模型，这里走 plugin-llm 的 `llm` 服务。
 */
import type { Logger } from '@qqbot/sdk'
import { callLLM, LLMCallError, type LLMCallOptions } from '../llm/client.js'
import { compactMessages, estimateMessagesTokens } from './context-size.js'
import type { SummaryInput } from '../do/agent-object.js'
import type { LLMService } from '../llm/contract.js'
import type { HistoryToolTrace, ModelMessage, ModelResponse } from '../types.js'
import { executeAgentToolCall } from './tool-executor.js'
import type { ToolRegistry, ToolExecuteInput } from '../tools/registry.js'
import { toModelTools } from '../tools/registry.js'

export interface LoopOptions {
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
 * 工具调用限额。照搬原文 `tool-call-limit.ts`（26 行）——
 * 原文把这个状态做成独立模块，因为「预留」和「检查」是两步：
 * 先 reserve，成功了才执行。这里保留同样的语义。
 */
interface ToolCallLimitState {
  maxToolCallsPerRun: number
  usedToolCalls: number
}

function createToolCallLimitState(maxToolCallsPerRun: number): ToolCallLimitState {
  return { maxToolCallsPerRun, usedToolCalls: 0 }
}

function reserveToolCall(state: ToolCallLimitState): boolean {
  if (state.usedToolCalls >= state.maxToolCallsPerRun) return false
  state.usedToolCalls += 1
  return true
}

function toolCallLimitExceededMessage(state: ToolCallLimitState): string {
  return `单次对话最多调用 ${state.maxToolCallsPerRun} 次工具，已经用完。可以让我少做几步，或者把任务拆开。`
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
): Promise<ModelResponse> {
  const attempts = Math.max(0, Math.trunc(retry?.times ?? 0))
  const delayMs = retry?.delayMs ?? 0

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callLLM(llm, request)
    } catch (error) {
      // abort 与「上游返回错误」要分开：用户按了 /stop 之后 LLM 层会抛一个
      // 带 code='aborted' 的错误，它落到普通错误路径会变成一条「模型调用失败」
      // 的回复——而用户说的正是「别说了」。这里把它归一成取消语义。
      if (request.signal?.aborted) throw new LoopCancelledError()
      if (attempt >= attempts || !isRetryableError(error)) throw error
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
async function throwIfCancelled(options: LoopOptions): Promise<void> {
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

  const messages = [...options.messages]
  const tools = toModelTools(registry.list())
  const allowedToolNames = new Set(tools.map((t) => t.name))
  const toolCallLimit = createToolCallLimitState(options.maxToolCalls)

  let steps = 0
  let repliedByTool = false
  let inputTokens = 0
  let outputTokens = 0
  let compactedRounds = 0
  // 被压缩丢掉的轮次（摊平成文本），交给调用方去生成摘要。
  // 这里只收集不处理：生成摘要要调模型，而 loop 跑在 30 秒事件预算里。
  const droppedForSummary: SummaryInput[] = []
  let contextTokens = 0
  const toolTraces: HistoryToolTrace[] = []
  const outbound: import('../tools/types.js').OutboundMedia[] = []

  for (let index = 0; index < maxModelSteps; index += 1) {
    steps = index + 1
    await options.onStep?.(steps)

    // 取消检查放在**每步开头**（onStep 之后、模型调用之前）：
    // 用户按 `/stop` 时，执行流可能正停在两次模型调用之间等工具结果，
    // 没有这一步检查它就会继续把剩下的步数跑完，用户等来的是一条完整的回答。
    //
    // 这里是**第二级**取消判定：跨 isolate 传不了对象，所以每步问一次 DO
    // storage 里这个 run 的状态。`signal` 那一级负责打断正在飞的模型调用。
    await throwIfCancelled(options)

    // 每步之前压一次。工具结果会不断堆进 messages，只在装配时压一次等于没压。
    //
    // system 消息单独拎出来算 token：它每轮都在，但不能被丢。
    const compaction = options.compaction
    if (compaction && compaction.mode !== 'off') {
      const systemMessages = messages.filter((m) => m.role === 'system')
      const systemTokens = estimateMessagesTokens(systemMessages)
      const nonSystem = messages.filter((m) => m.role !== 'system')
      const compacted = compactMessages(nonSystem, {
        maxTokens: compaction.maxTokens,
        systemTokens,
      })
      // 两种情况都要把压缩结果写回 messages：
      // 1) 丢了整轮（droppedRounds > 0）——消息数组变了；
      // 2) 没丢轮、但把单轮里的超大工具结果截断了（truncatedToolResults > 0）——
      //    消息条数不变、内容变了。
      // 只判断丢轮的话，「同一轮工具循环里截断大结果」算出来却写不回去，
      // 端到端等于没生效。
      //
      const truncatedToolResults = compacted.truncatedToolResults
      if (compacted.droppedRounds > 0 || truncatedToolResults > 0) {
        compactedRounds += compacted.droppedRounds
        // 只留 user / assistant 的文本：tool 结果可能几十 KB，
        // 存进 DO 的待摘要槽会白白撑大体积，摘要也不需要逐字复述它。
        for (const message of compacted.droppedMessages) {
          if (message.role === 'tool' || message.role === 'system') continue
          const content = typeof message.content === 'string' ? message.content : ''
          if (content.trim()) droppedForSummary.push({ role: message.role, content })
        }
        // 就地替换：保持 system 在前
        messages.length = 0
        messages.push(...systemMessages, ...compacted.messages)
        logger.info('上下文已压缩', {
          droppedRounds: compacted.droppedRounds,
          truncatedToolResults,
          tokensBefore: compacted.tokensBefore,
          tokensAfter: compacted.tokensAfter,
        })
      }
      contextTokens = compacted.tokensAfter + systemTokens
    } else {
      contextTokens = estimateMessagesTokens(messages.filter((m) => m.role !== 'system'))
    }

    const response = await callLLMWithRetry(
      llm,
      {
        model,
        messages,
        ...(tools.length ? { tools } : {}),
        timeoutMs: requestTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.retry,
      logger,
      steps,
    )

    inputTokens += response.usage?.inputTokens ?? 0
    outputTokens += response.usage?.outputTokens ?? 0

    // 记录模型步（原文 recordModelStep）
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
        toolCalls: toolCallLimit.usedToolCalls,
        usage: { inputTokens, outputTokens },
        compactedRounds,
        droppedForSummary,
        contextTokens,
        toolTraces,
        outbound,
      }
    }

    // 把 assistant 的工具调用意图写回消息（原文 messages.push({role:'assistant', toolCalls}))
    messages.push({
      role: 'assistant',
      content: response.content ?? '',
      toolCalls: response.toolCalls,
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    })

    for (const toolCall of response.toolCalls) {
      // 先预留再执行（原文 reserveToolCall 的语义）
      if (!reserveToolCall(toolCallLimit)) {
        throw new LoopLimitError(toolCallLimitExceededMessage(toolCallLimit))
      }

      const execution = await executeAgentToolCall({
        registry,
        toolCall,
        allowedToolNames,
        context: toolContext,
        logger,
      })

      repliedByTool = repliedByTool || execution.sentMessage

      // 工具产出要发给用户的富媒体（图片/文件），收集起来交给回复通道
      if (execution.result.outbound) {
        outbound.push(execution.result.outbound)
        // 已经发了媒体，就不再补一条纯文本回复
        repliedByTool = true
      }

      // 记一条摘要进历史（截断，避免把 DO storage 配额吃光）
      toolTraces.push(toToolTrace(toolCall.name, toolCall.arguments, execution.result))

      // 工具结果回填给模型
      messages.push(execution.resultMessage)
    }
  }

  throw new LoopLimitError(
    `一次对话最多推理 ${maxModelSteps} 步，已经用完。可以让我少做几步，或者把任务拆开。`,
  )
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
