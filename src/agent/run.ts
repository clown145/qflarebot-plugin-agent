import { isToolDisabled, filterAllowedTools } from '../tools/catalog.js'
/**
 * 一次 run 的执行编排：装上下文 → 跑 loop → 回复 → 收尾。
 *
 * 两条路径共用这一个函数：
 * - **事件处理器**：拿到执行权就同步跑（受软预算约束），用户感知是"秒回"。
 * - **cron**：兜底捡队列里的 run，以及触发到期的定时任务。
 *
 * 这是双段式调度的关键：不是两套逻辑，是同一个函数的两个调用点。
 */
import type { Logger, PluginContext, ScopedR2, ToolInvocation } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import type { HistoryRow, SummaryInput } from '../do/agent-object.js'
import type { InboundMessage, RunStatus } from '../types.js'
import type { LLMService } from '../llm/contract.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { RegisteredTool } from '../tools/types.js'
import { buildMessages } from './context.js'
import { withQuotedText } from './inbound.js'
import {
  describeLoopError,
  LoopCancelledError,
  LoopYieldError,
  type LoopCheckpoint,
  runAgentLoop,
  throwIfCancelled,
  type LoopResult,
} from './loop.js'
import type { StoredSummary } from './context-size.js'
import { createToolRegistry } from '../tools/registry.js'
import { createTimeTool } from '../tools/time.js'
import { createHttpTool } from '../tools/http.js'
import { createWebTool } from '../tools/web.js'
import { createSearchTools } from '../tools/search.js'
import { createScheduleTools } from '../tools/schedule.js'
import { createVfsTools } from '../tools/vfs/tools.js'
import { bumpDailyStats, getToolSettings, recordToolAudit } from '../store/d1.js'
import { getPersonaBinding, resolvePersona } from '../persona.js'
import { resolveConfig } from '../effective-config.js'
import { BLOCKED_REPLY, checkContent, parseKeywords } from './safety.js'
import { getSkill, listSkills, type LoadedSkill, type SkillCatalogItem } from '../skills/store.js'
import { parseSkillCommand } from '../skills/context.js'
import { buildFragmentBlock, listActiveFragments } from '../prompt-fragments.js'
import { loadFrameworkTools } from './plugin-tool-adapter.js'

/** release / retryLater 之后可能返回「队列里下一个已认领的 run」 */
export interface NextRun {
  acquired: boolean
  runId?: string
  leaseId?: string
  message?: InboundMessage
}

export interface AgentStub {
  history(limit: number, summarize?: boolean): Promise<HistoryRow[]>
  checkpoint?(runId: string): Promise<LoopCheckpoint | null>
  saveCheckpoint?(runId: string, checkpoint: LoopCheckpoint, leaseId?: string): Promise<boolean>
  suspend?(runId: string, leaseId?: string): Promise<void>
  ownsLease?(runId: string, leaseId: string): Promise<boolean>
  release(
    runId: string,
    result: { ok: boolean; error?: string; history?: HistoryRow[]; claimNext?: boolean; leaseId?: string },
  ): Promise<NextRun>
  retryLater(runId: string, reason: string): Promise<NextRun>
  /** 登记待摘要的轮次（`summary` 模式用；其他模式不调） */
  stageSummary(messages: SummaryInput[], coveredMessages: number, owner?: { runId: string; leaseId?: string }): Promise<void>
  /** 读取会话摘要（`summary` 模式用） */
  summary(): Promise<StoredSummary | null>
  /**
   * 读这个 run 的当前状态。**取消判定的跨 isolate 通道**：
   * `/stop` 打在 DO 上（另一个 isolate），执行流只能靠轮询这里知道。
   *
   * 可选：老的 stub / 测试替身没有它时，按「未取消」处理（不检查）。
   */
  runStatus?(runId: string): Promise<RunStatus | null>
  /**
   * 续租。每步之前调一次，把 `lock.expiresAt` 往后推。
   *
   * 不续租的话，单次 run 的最坏耗时（8 步 × 20 秒 = 160 秒）必然超过
   * `LEASE_MS`（90 秒），另一个执行者会在锁过期后接手同一个 run，用户收到两条回复。
   *
   * 可选：没有它时不续租（测试替身用）。
   */
  renewLease?(runId: string, leaseId?: string): Promise<boolean>
}

export interface ReplyFn {
  (text: string): Promise<boolean>
  /**
   * 发一条富媒体（图片/文件）。
   *
   * 单独一个方法而不是给 `text` 加重载：调用点一眼能看出「这条是在发图」，
   * 而且媒体失败时的降级策略与纯文本不同（见 replyWithMedia 的实现）。
   */
  media?(item: import('../tools/types.js').OutboundMedia): Promise<boolean>
}

export interface RunDeps {
  deadline?: number
  leaseId?: string
  ctx: PluginContext<AgentConfig>
  logger: Logger
  config: AgentConfig
  llm: LLMService
  agent: AgentStub
  reply: ReplyFn
  /** 用户是否已经明确确认过危险操作（本轮生效） */
  allowDangerous?: boolean
  /** 可重试错误的等待时间。测试传 0 */
  retryDelayMs?: number
  /** 收尾时是否还有预算执行下一条；没有预算时让队列保持 pending。 */
  shouldClaimNext?: () => boolean
}

/** run 的结果。模型重试在 loop 内完成，已开始执行的 run 不再整轮入队。 */
export interface RunOutcome {
  suspended?: boolean
  ok: boolean
  retryable: boolean
  /** 已经发过回复 */
  replied: boolean
  /** 队列里顺手认领到的下一个 run。调用方可以接着跑，不必等 cron */
  next?: NextRun
}

/**
 * 可重试错误的重试间隔。429 通常几秒恢复，等太久会吃满 30 秒事件预算。
 * 测试里通过 RunDeps.retryDelayMs 传 0，避免真的等 3 秒。
 */
const RETRY_DELAY_MS = 3_000

/**
 * 装上下文、建工具集、跑一轮 loop。
 *
 * **这个函数整体只跑一次**（旧版外层 `runWithRetry` 会在 429 时把它整个重跑，
 * 于是已经执行过的工具会重复产生副作用——见 executeRun 的注释）。
 * 现在可重试的错误在 loop 内部的单次模型调用上重试，这里不再被重入。
 */
async function runLoopOnce(input: {
  ctx: PluginContext<AgentConfig>
  logger: Logger
  config: AgentConfig
  llm: LLMService
  agent: AgentStub
  message: InboundMessage
  runId: string
  checkpoint?: LoopCheckpoint | null
  onCheckpoint?: (checkpoint: LoopCheckpoint) => Promise<void>
  deadline?: number
  leaseId?: string
  allowDangerous?: boolean
  /** 取消信号（本地一级） */
  signal?: AbortSignal
  /** 重试配置（下沉到单次模型调用） */
  retry?: { times: number; delayMs: number }
}): Promise<LoopResult> {
  const { ctx, logger, config, llm, agent, message, runId } = input

  const history = input.checkpoint ? [] : await agent.history(config.history_limit, config.context_compression === 'summary')
  // 摘要只在 summary 模式下读；读失败退回「没有摘要」——
  // 压缩仍然由 truncate 兜底，不该因为一次 DO 抖动就中断整轮对话
  const summary =
    !input.checkpoint && config.context_compression === 'summary'
      ? await (agent.summary?.() ?? Promise.resolve(null)).catch(() => null)
      : null
  const model = input.checkpoint?.model ?? config.model
  const modelInfo = await safeResolveModel(llm, model, logger)

  // 人格：会话绑定 > 配置默认人格 > system_prompt。读失败不该让整轮对话失败
  // （绑定表是 D1，抖动时退回 system_prompt 即可）
  const bound = await getPersonaBinding(ctx.db, message.conversation).catch(() => undefined)
  const persona = resolvePersona(config, bound)
  if (persona.name) logger.debug('使用人格', { conversation: message.conversation, persona: persona.name })

  // R2 探测放在这里（而不是 buildRegistry 里）是因为它是异步的，而 buildRegistry
  // 被设计成同步、好测。探测结果在 isolate 内缓存，正常对话不会多出往返。
  const r2Ready = config.enable_tools && config.enable_vfs ? await hasR2(ctx) : false

  // 工具栏开关：读取失败时保留内置工具的默认行为，插件工具保持关闭。
  const toolSettings = await getToolSettings(ctx.db).catch(() => undefined)

  // 人格的工具白名单与全局开关**叠加**：先按人格收窄，再减掉全局关掉的。
  //
  // 两者都表达「不给模型用」，但来源不同：人格白名单是**按角色**收窄
  // （客服人格不该能发 HTTP），全局开关是**按运维**收窄。
  // 叠加是安全的：都是减少，不会互相抵消。
  //
  // 注意 `allowedTools === undefined` 表示不限（老配置没这个字段），
  // 而 `[]` 表示「什么都不能用」——这两者含义相反，不能糊成一样。
  const disabled = new Set(toolSettings?.disabled ?? [])
  const registry = await buildRegistry(
    ctx,
    config,
    r2Ready,
    disabled,
    persona.allowedTools,
    toolSettings?.config ?? {},
    message.toolInvocation ?? null,
    new Set(toolSettings?.enabled ?? []),
  )

  // 技能：**渐进披露**。
  //
  // 每轮只带目录（≤40 行 `id: 描述`，固定的小开销），
  // 完整正文只在用户显式 `/skill <id> <任务>` 激活时才注入（用到才付的大开销）。
  // 读失败同样不该中断对话——技能是增强，不是必需品。
  let skillCatalog: SkillCatalogItem[] = []
  let activeSkill: LoadedSkill | undefined
  let effectiveMessage = message
  if (config.enable_skills) {
    skillCatalog = await listSkills(ctx.db).catch(() => [])

    // 人格的可见技能白名单（AstrBot Persona.skills）。
    // `undefined` = 不限；数组（含空）才过滤 —— 两者含义相反，不能写成 `?? []`。
    //
    // 只过滤目录不够：用户仍可能手动 `/skill <id>` 激活一个被挡掉的技能，
    // 所以**激活路径也要判**。否则白名单只是「不显示」，不是「不能用」。
    const visibleSkill = (id: string): boolean =>
      persona.allowedSkills === undefined || persona.allowedSkills.includes(id)

    if (persona.allowedSkills !== undefined) {
      skillCatalog = skillCatalog.filter((skill) => visibleSkill(skill.id))
    }

    const activated = parseSkillCommand(message.text)
    if (activated) {
      if (!visibleSkill(activated.skillId)) {
        // 明确告知而不是静默当普通消息：用户以为激活了、实际没有，
        // 后面的回答会完全跑偏，比直接说清楚更糟。
        logger.warn('技能不在当前人格的可见范围内', {
          skillId: activated.skillId,
          persona: persona.name,
        })
        effectiveMessage = {
          ...message,
          text: `（技能 ${activated.skillId} 在当前人格下不可用）${activated.userText || ''}`.trim(),
        }
      } else {
        const found = await getSkill(ctx.db, activated.skillId).catch(() => null)
        if (found) {
          activeSkill = found
          // `/skill` 这段不该进模型，替换成任务正文。没有正文时给一句兜底，
          // 否则会发一条空的 user 消息（部分 provider 直接 400）。
          effectiveMessage = {
            ...message,
            text: activated.userText || '请按这个技能说明执行。',
          }
        } else {
          logger.warn('技能不存在，按普通消息处理', { skillId: activated.skillId })
        }
      }
    }
  }

  // 先建工具集再拼提示词：有工具时要在系统提示词里追加「工具使用规范」，
  // 需要知道这一轮到底开放了哪些（对标 AstrBot 的 TOOL_CALL_PROMPT）
  //
  // **人格提示词是追加，不是替换**（`personaPrompt` 单独传）：
  // 基础提示词里的运行时约定（时间、会话、工具规范、回复格式）不能被丢掉，
  // 否则配了人格之后模型就开始输出 Markdown、也不知道有工具了。
  // 其他插件注册的提示词片段。读失败不该中断对话——这是增强，不是必需品。
  // 注意它属于 system 的**稳定部分**：只要插件不改片段，前缀缓存就命中。
  const fragmentBlock = buildFragmentBlock(
    await listActiveFragments(ctx.db).catch(() => []),
  )

  const messages = input.checkpoint?.messages ?? buildMessages(effectiveMessage, history, {
    systemPrompt: config.system_prompt,
    ...(persona.prompt ? { personaPrompt: persona.prompt } : {}),
    timezone: config.timezone,
    historyLimit: config.history_limit,
    supportsVision: modelInfo?.capabilities.includes('image') ?? false,
    toolNames: registry.list().map((tool) => tool.definition.name),
    ...(fragmentBlock ? { pluginPrompts: [fragmentBlock] } : {}),
    exposeSenderId: config.expose_sender_id,
    exposeDatetime: config.expose_datetime,
    ...(persona.beginDialogs.length ? { beginDialogs: persona.beginDialogs } : {}),
    ...(skillCatalog.length ? { skillCatalog } : {}),
    ...(activeSkill ? { activeSkill } : {}),
    // 摘要只在 summary 模式下带：truncate / off 的用户不该多花一次 DO 读
    ...(summary ? { summary } : {}),
  })
  // 正文可能经过 /skill 处理，且与展示用的 displayText 不同，必须保存首次装配值。
  // 旧检查点没有这份记录时不补造，完成后仍沿用旧历史回放。
  const historyInput = input.checkpoint
    ? input.checkpoint.historyInput
    : {
        text: effectiveMessage.text,
        ...(effectiveMessage.quotedText !== undefined ? { quotedText: effectiveMessage.quotedText } : {}),
        scene: effectiveMessage.scene,
        receivedAt: effectiveMessage.receivedAt,
      }

  return runAgentLoop({
    checkpoint: input.checkpoint,
    onCheckpoint: async state => {
      if (historyInput) state.historyInput = historyInput
      await input.onCheckpoint?.(state)
    },
    deadline: input.deadline,
    llm,
    registry,
    logger,
    model,
    messages,
    maxModelSteps: config.max_model_steps,
    maxToolCalls: config.max_tool_calls,
    requestTimeoutMs: config.request_timeout_ms,
    // 取消：signal 打断正在飞的模型调用，isCancelled 在每步开头问一次 DO。
    // 两条都要有——只靠 signal 的话，abort 只发生在轮询器发现取消的那一刻，
    // 而在那个 tick 之前到达的步仍会继续；只靠轮询的话，用户按 /stop 之后
    // 还得等当前这次模型调用自己吐完（可能几十秒）。
    ...(input.signal ? { signal: input.signal } : {}),
    isCancelled: () => isRunCancelled(agent, runId, input.leaseId),
    // 重试下沉到**单次模型调用**：loop 状态与已执行的工具都不重来。
    retry: input.retry ?? { times: 1, delayMs: RETRY_DELAY_MS },
    // 每步之前续租：单次 run 最坏 8 步 × 20 秒 = 160 秒，必然超过 LEASE_MS(90s)。
    // 不续的话另一个执行者会在锁过期后接手同一个 run，用户收到两条回复。
    onStep: () => renewLease(agent, runId, logger, input.leaseId),
    // 压缩在 loop 内部每步前执行（工具结果会不断堆进 messages）。
    //
    // **loop 里一律用 truncate**，包括 summary 模式：循环内不可能再插一次模型调用
    // 去摘要而不超事件预算。summary 的差异体现在两处：
    // 1. 装配上下文时多带一份已有摘要（见 runLoopOnce 里的 summary 读取）；
    // 2. 压缩丢掉的内容由 `stageSummary` 登记，交给 cron 异步生成摘要。
    compaction:
      config.context_compression === 'off'
        ? { mode: 'off' as const, maxTokens: config.max_context_tokens }
        : { mode: 'truncate' as const, maxTokens: config.max_context_tokens },
    toolContext: {
      db: ctx.db,
      logger,
      conversationId: message.conversation,
      actorId: message.userId,
      actorRole: message.memberRole ?? 'unknown',
      scene: message.scene,
      targetId: message.targetId,
      runId,
      stepId: `step-${runId}`,
      timezone: config.timezone,
      allowDangerous: input.allowDangerous,
      onAudit: config.enable_audit
        ? async (entry) => {
            await recordToolAudit(ctx.db, {
              id: crypto.randomUUID(),
              conversation: message.conversation,
              runId,
              toolName: entry.toolName,
              argsJson: entry.inputJson,
              ...(entry.outputJson ? { resultJson: entry.outputJson } : {}),
              status: entry.status,
              durationMs: entry.durationMs,
            }).catch((error: unknown) => {
              // 审计写失败不该影响对话
              logger.warn('工具审计写入失败', { error: String(error) })
            })
          }
        : undefined,
    },
  })
}

/**
 * 取这个会话人格自定义的错误文案。没有就返回 undefined（调用方用通用文案）。
 *
 * 为什么单独查一次而不是复用 `runLoopOnce` 里解析好的那份：那份在成功路径上，
 * 失败时已经出了作用域。而这里**只在 catch 里跑**，成功对话不多承担任何开销。
 * 读失败也返回 undefined —— 报错路径本身不该再因为一次 D1 抖动而抛。
 */
async function resolvePersonaErrorText(
  ctx: PluginContext<AgentConfig>,
  config: AgentConfig,
  conversation: string,
): Promise<string | undefined> {
  try {
    const bound = await getPersonaBinding(ctx.db, conversation)
    return resolvePersona(config, bound).customErrorMessage
  } catch {
    return undefined
  }
}

/**
 * 判断这个 run 是否已被取消（`/stop` / `/agent reset`）。
 *
 * 跨 isolate 的取消只能在**每次问 DO storage**：执行流在 Worker 的 isolate 里，
 * `/stop` 打在 DO 的 isolate 里，两者没有共享对象。查询本身失败时按「未取消」，
 * 一次 storage 抖动不该误杀正常对话。
 */
async function isRunCancelled(agent: AgentStub, runId: string, leaseId?: string): Promise<boolean> {
  if (leaseId && agent.ownsLease && !await agent.ownsLease(runId, leaseId)) return true
  if (!agent.runStatus) return false
  try {
    return (await agent.runStatus(runId)) === 'cancelled'
  } catch {
    return false
  }
}

/** 每步续租。令牌失效必须中断旧执行者；暂时的存储异常记录日志。 */
async function renewLease(agent: AgentStub, runId: string, logger: Logger, leaseId?: string): Promise<void> {
  if (!agent.renewLease) return
  try {
    const renewed = await agent.renewLease(runId, leaseId)
    if (!renewed) throw new LoopCancelledError('执行租约已失效')
  } catch (error) {
    if (error instanceof LoopCancelledError) throw error
    logger.warn('续租出错，继续执行', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 取消轮询的退避参数：首查 800ms，之后每次翻倍，封顶 5 秒。
 *
 * 为什么要退避而不是固定 500ms：这个轮询是**每次 run 都在跑**的，
 * 不是「用户按了 /stop 才跑」。一次模型调用最长 20 秒，固定 500ms 就是
 * 每次对话多打 40 次 DO RPC（DO 按 GB-秒 + 请求计费，免费版额度共享）。
 * 退避后：典型 3 秒调用只多 2 次 RPC，20 秒的长调用约 5 次，
 * 而 /stop 的最坏响应时间仍然是 5 秒级、通常 1 秒级。
 */
const CANCEL_POLL_FIRST_MS = 800
const CANCEL_POLL_MAX_MS = 5_000

/**
 * 取消轮询器：**唯一**负责在 `/stop` 之后 abort 正在飞的模型调用的地方。
 *
 * 为什么单独一个轮询器而不是在每步检查时顺便 abort：
 * 步与步之间的检查只发生在两次模型调用之间；一次模型调用可能跑满 20 秒，
 * 用户按 `/stop` 之后要等这一整段结束才看到停止。这个轮询把
 * 「已停止继续生成」的延迟压到秒级。
 *
 * 返回一个 stop 函数，调用方在 finally 里必须调它（否则定时器会泄漏到下一次请求）。
 */
function startCancellationWatcher(
  agent: AgentStub,
  runId: string,
  controller: AbortController,
  logger: Logger,
): () => void {
  if (!agent.runStatus) return () => {}

  let stopped = false
  let interval = CANCEL_POLL_FIRST_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return
    try {
      if ((await agent.runStatus?.(runId)) === 'cancelled') {
        logger.info('检测到 run 已取消，中断正在进行的模型调用', { runId })
        controller.abort(new Error('run cancelled by user'))
        return
      }
    } catch {
      // 查询失败不当成取消：下一步的同步检查会再试
    }
    interval = Math.min(interval * 2, CANCEL_POLL_MAX_MS)
    if (!stopped) timer = setTimeout(() => void tick(), interval)
  }

  timer = setTimeout(() => void tick(), interval)

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** 执行已认领的 run；完成时 release，预算不足时保存检查点并 suspend。 */
export async function executeRun(
  deps: RunDeps,
  runId: string,
  message: InboundMessage,
): Promise<RunOutcome> {
  const { ctx, logger, config, llm, agent, reply } = deps

  // 本地取消信号。跨 isolate 的那一级由 DO storage 承担（见 isRunCancelled），
  // 这里负责**打断正在飞的模型调用**——llm 契约里早就有 ChatRequest.signal
  // （src/llm/client.ts 透传），只是从来没人设置过它。
  const controller = new AbortController()
  const stopWatcher = startCancellationWatcher(agent, runId, controller, logger)
  const checkCancelled = () => throwIfCancelled({
    signal: controller.signal,
    isCancelled: () => isRunCancelled(agent, runId, deps.leaseId),
    logger,
  })
  const finish = (result: { ok: boolean; error?: string; history?: HistoryRow[] }) =>
    agent.release(runId, { ...result, leaseId: deps.leaseId, claimNext: deps.shouldClaimNext?.() ?? true })
  const finishCancelled = async (): Promise<RunOutcome> => {
    stopWatcher()
    logger.info('run 已被用户取消，停止回复与写历史', { conversation: message.conversation })
    const next = await finish({ ok: false, error: '用户取消了这轮回答' }).catch(() => undefined)
    return { ok: false, retryable: false, replied: false, ...(next ? { next } : {}) }
  }

  let checkpoint: LoopCheckpoint | null = null
  const saveCheckpoint = async (next: LoopCheckpoint) => {
    checkpoint = next
    if (agent.saveCheckpoint && !await agent.saveCheckpoint(runId, next, deps.leaseId)) throw new LoopCancelledError('执行租约已失效')
  }
  try {
    checkpoint = await agent.checkpoint?.(runId) ?? null
    // 1–3. 装上下文、建工具集、跑 loop。
    //
    // **重试不在这里**：限流/超时这类可重试错误在 loop 内部就地对**单次模型调用**
    // 重试一次。旧版本在这里重跑整个 runLoopOnce，于是一旦第 1 步已经执行过工具
    // （比如 schedule.create 已经 INSERT 过一行），第 2 步 429 会让整个 loop
    // 从头再来——工具副作用执行两次，而注释当时还声称「此时还没有产生任何副作用」。
    // 重试下沉之后，已经跑过的工具不会重来，消息数组也不会被重置。
    const result = await runLoopOnce({
      ctx,
      logger,
      config,
      llm,
      agent,
      message,
      runId,
      checkpoint,
      onCheckpoint: saveCheckpoint,
      deadline: deps.deadline,
      leaseId: deps.leaseId,
      allowDangerous: deps.allowDangerous,
      signal: controller.signal,
      retry: { times: 1, delayMs: deps.retryDelayMs ?? RETRY_DELAY_MS },
    })

    // 4a. 先发工具产出的富媒体（图片/文件）。
    //
    // 放在纯文本之前：用户的阅读顺序应该是「看到图 → 再看到说明」。
    // 媒体本身不过内容安全（那是二进制），但 caption 会过。
    let replied = false
    // 每条投递前持久化游标；中断后不盲目重复发送结果未知的消息。
    const delivery = checkpoint?.delivery ?? { media: 0, text: false }
    if (checkpoint) checkpoint.delivery = delivery
    for (let index = delivery.media; index < (result.outbound?.length ?? 0); index++) {
      const item = result.outbound[index]!
      delivery.media = index + 1
      if (checkpoint) await saveCheckpoint(checkpoint)
      await checkCancelled()
      if (!reply.media) {
        logger.warn('回复通道不支持媒体，退化为纯文本链接', { type: item.type })
        const fallback = item.url ? `${item.caption ?? ''} ${item.url}`.trim() : (item.caption ?? '')
        if (fallback) replied = (await reply(fallback)) || replied
        continue
      }
      replied = (await reply.media(item).catch(() => false)) || replied
    }

    // 4b. 再发纯文本。工具已经发过就不重复发
    //
    // 出站也要过一遍内容安全（对标 AstrBot 的 ResultDecorateStage）：
    // 只查入站不够——模型可能把用户诱导出的敏感内容再复述一遍，
    // 而那才是真正发到群里的东西。
    if (!delivery.text && !result.repliedByTool && result.reply?.trim()) {
      delivery.text = true
      if (checkpoint) await saveCheckpoint(checkpoint)
      await checkCancelled()
      const outbound = filterOutbound(result.reply.trim(), config)
      if (outbound.blocked) {
        logger.warn('出站内容命中安全关键词，已拦截', { conversation: message.conversation })
        replied = await reply(BLOCKED_REPLY).catch(() => false)
      } else {
        replied = await reply(outbound.text)
      }
    }

    // 5. 写历史。
    //
    // 只写真正产生过的内容：assistant 那一行要有文本才写。工具已经把消息发出去时
    // `result.reply` 是空的，硬写一条空的 assistant 行会让模型下次看到「自己说了空话」，
    // 也会白白占掉 history_limit 的名额。
    const now = Date.now()
    const historyRows: HistoryRow[] = [
      {
        role: 'user',
        userId: message.userId,
        userName: message.userName,
        ...(checkpoint?.historyInput ? { input: checkpoint.historyInput } : {}),
        ...(message.passiveMessageId ? { messageId: message.passiveMessageId } : {}),
        ...(message.attachments.length ? { attachments: message.attachments } : {}),
        content: withQuotedText(message.displayText || message.text, message.quotedText),
        toolCallsJson: null,
        createdAt: now,
      },
    ]
    if (result.reply?.trim()) {
      historyRows.push({
        role: 'assistant',
        content: result.reply.trim(),
        ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
        // 把本轮调过的工具写进历史，模型下一轮才能看到「我上次查过什么」。
        // 以前这里是硬编码 null，导致 context.ts 承诺的「历史回放 toolCalls」
        // 分支在真实数据上永远走不到，模型会重复调同一个工具。
        toolCallsJson: result.toolTraces.length ? JSON.stringify(result.toolTraces) : null,
        createdAt: now + 1,
      })
    }
    await checkCancelled()

    // 5b. summary 模式：把这次压缩丢掉的内容登记进 DO，等 cron 生成摘要。
    //
    // **不在这里生成摘要**：生成要调一次模型，而 executeRun 跑在事件处理器的
    // 30 秒预算里（群聊被动回复窗口也就 5 分钟）。一次摘要调用几百毫秒到几十秒，
    // 插在这里很可能让用户什么都收不到。cron 没有事件预算，是更合适的位置。
    //
    // 登记失败不能影响这一轮对话：摘要只是增强，truncate 仍然保底。
    if (config.context_compression === 'summary' && result.droppedForSummary.length > 0) {
      await agent
        .stageSummary(result.droppedForSummary.filter(message => message.id), result.droppedForSummary.length, { runId, leaseId: deps.leaseId })
        .catch((error: unknown) => {
          logger.warn('登记待摘要内容失败，本轮不影响', { error: String(error) })
        })
    }

    const next = await finish({ ok: true, history: historyRows })

    // 6. 统计（一天一行，不随消息数线性增长）
    await bumpDailyStats(ctx.db, dayKey(config.timezone), {
      runs: 1,
      toolCalls: result.toolCalls,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    }).catch(() => {
      /* 统计失败不影响主流程 */
    })

    logger.info('run 完成', {
      conversation: message.conversation,
      steps: result.steps,
      toolCalls: result.toolCalls,
      replied,
    })

    return { ok: true, retryable: false, replied, next }
  } catch (error) {
    if (error instanceof LoopYieldError && !controller.signal.aborted && !await isRunCancelled(agent, runId, deps.leaseId)) {
      if (agent.suspend) await agent.suspend(runId, deps.leaseId)
      else await agent.retryLater(runId, '等待下一次执行预算')
      logger.info('run 已保存进度，等待接续', { runId, steps: checkpoint?.steps ?? 0 })
      return { ok: false, suspended: true, retryable: false, replied: false }
    }
    // 用户主动喊停不算失败：不回复、不写历史、不退回队列。
    //
    // 三条都必须不做：
    // - **不回复**：用户说的是「别说了」，再补一句错误提示就是反着来；
    // - **不写历史**：这一轮是旧上下文的产物，而 `release()` 见到 cancelled
    //   本来也会跳过写历史（DO 侧双保险）；
    // - **不退回队列**：退回等于「停不下来」，用户按 /stop 后它还会再跑一遍。
    if (error instanceof LoopCancelledError || controller.signal.aborted || await isRunCancelled(agent, runId, deps.leaseId)) {
      return finishCancelled()
    }

    const described = describeLoopError(error)
    logger.error('run 失败', {
      conversation: message.conversation,
      retryable: described.retryable,
      error: error instanceof Error ? error.message : String(error),
    })

    // **无论可不可重试，都要告诉用户**。
    //
    // 上一版在可重试时静默退回队列，用户什么都收不到——消息凭空消失，
    // 比报错更让人困惑。可重试错误已经在 loop 内部对单次模型调用重试过一次，
    // 走到这里说明重试也没成功，该让用户知道。
    //
    // 人格可以自定义错误文案（AstrBot 的 `custom_error_message`）：
    // 一个毒舌角色突然冒出「处理失败：HTTP 500」会很出戏。
    // 只在**错误路径**上解析一次人格——成功路径不承担这次 D1 读。
    const customError = await resolvePersonaErrorText(ctx, config, message.conversation)
    if (controller.signal.aborted || await isRunCancelled(agent, runId, deps.leaseId)) return finishCancelled()
    const replied = await reply(customError ?? described.text).catch(() => false)

    // 单次模型调用已经重试过；重新入队会丢失 loop 状态并重做已成功的工具。
    // 错误也必须交接 release 认领的下一条，否则会留下没有执行者的 running 锁。
    const next = await finish({ ok: false, error: described.text })
    await bumpDailyStats(ctx.db, dayKey(config.timezone), { runs: 1, failed: 1 }).catch(() => {})
    return { ok: false, retryable: false, replied, next }
  } finally {
    // 成功路径也要停：否则轮询定时器会活过这次请求，
    // 在 isolate 复用的情况下把 abort 打到下一轮的 controller 上。
    stopWatcher()
  }
}

/**
 * R2 是否真的绑定了。
 *
 * **不能只看 `ctx.r2` 是不是 undefined**：宿主在未绑定 R2 时返回的仍然是一个对象——
 * 每个方法都是「调用即抛」的桩（`packages/runtime/src/scoped.ts` 的 `createScopedR2`）。
 * 所以 `if (ctx.r2)` 恒为真，`enable_vfs` 会在没有 R2 的机器人上注册一整套
 * 必然失败的工具，模型只会得到一句「未绑定 R2」的工具错误、反复重试。
 *
 * 这里真的探测一次：`head()` 对空 key 在绑定时返回 null、未绑定时抛可读错误。
 * 探测结果缓存在 isolate 内（绑定不会在一次部署内变化），每个 isolate 最多多一次 R2 往返。
 */
const r2Available = new WeakMap<object, boolean>()

export async function hasR2(ctx: PluginContext<AgentConfig>): Promise<boolean> {
  const r2 = ctx.r2 as ScopedR2 | undefined
  if (!r2) return false

  const cached = r2Available.get(r2 as object)
  if (cached !== undefined) return cached

  let ok: boolean
  try {
    await r2.head('__probe__')
    ok = true
  } catch {
    ok = false
  }
  r2Available.set(r2 as object, ok)
  return ok
}

/**
 * 按配置组装工具集。
 *
 * `enable_tools` 是总开关；`enable_vfs` / `enable_schedule` 是分开关。
 * 分开关关掉时，那组工具**根本不注册**——模型看不到它们，
 * 也就不会尝试调用后被权限拒绝（那样既费 token 又让模型困惑）。
 */
export async function buildRegistry(
  ctx: PluginContext<AgentConfig>,
  config: AgentConfig,
  r2Ready: boolean,
  disabledTools: ReadonlySet<string> = new Set(),
  /**
   * 人格的工具白名单（AstrBot Persona.tools 的对应物）。
   * `undefined` = 不限；数组（含空数组）= 只允许这些。
   */
  allowedTools?: readonly string[],
  /** 每个工具自己的配置（管理页在工具详情里填的），如 `{ 'search.web': { apiKey } }` */
  toolConfig: Record<string, Record<string, string>> = {},
  invocation?: ToolInvocation | null,
  /** 明确开启的插件工具；管理目录仍展示所有项，运行时才应用。 */
  enabledTools: ReadonlySet<string> = new Set(),
): Promise<ToolRegistry> {
  if (!config.enable_tools) return createToolRegistry([])

  const tools: RegisteredTool[] = [createTimeTool(), createWebTool()]

  // http 是高权限工具（level 3），但它的权限由 permissions 层判定，
  // 这里只负责注册——关掉 enable_tools 才不注册
  tools.push(createHttpTool())

  // 联网搜索。**未配置 key 时也注册**：模型能看到这个工具、拿到一句可读的
  // 「还没配置搜索」，比让模型以为「我没有搜索能力」然后凭空瞎编要好。
  // 这比整组不注册更诚实——不注册等于假装这个能力不存在。
  // apiKey 从**工具自己的配置**里读（管理页「工具 → 搜索 → 配置」填的），
  // 不再从插件配置的 search_api_key 读。这样「加一个需要 key 的工具」只需要
  // 工具自己声明 configFields，不用改插件配置 schema，也不会让用户在一个
  // 通用设置页里看到一个不知道自己属于谁的输入框。
  //
  // 早期版本把 key 写在插件配置 `search_api_key` 里，v0.1 之后挪到了工具配置。
  // 老用户升级时那句配置会被忽略——管理页「工具 → 搜索 → 配置」重新填一次即可。
  // 不做自动迁移：读旧配置写新设置需要一次 D1/AI 之外的写，为一次性升级不值当。
  const searchApiKey = toolConfig['search.web']?.['apiKey']?.trim() ?? ''
  tools.push(
    ...createSearchTools(searchApiKey ? { provider: 'tavily', apiKey: searchApiKey } : undefined),
  )

  if (config.enable_schedule) {
    tools.push(...createScheduleTools())
  }

  if (config.enable_vfs) {
    // **没绑 R2 也注册**（轻量模式：只用 D1 存 ≤8KB 的文本）。
    //
    // 以前是「没 R2 就整组不注册」，等于把一个轻量功能绑死在重型基础设施上：
    // 「让模型记个笔记、存个待办」这类最常见的用途根本用不到大文件，
    // 结果绝大多数部署里「有虚拟工作区」这句话等于不存在。
    //
    // 大文件在轻量模式下会返回可读错误（提示绑定 R2），而不是让工具消失。
    tools.push(...createVfsTools(ctx.db, r2Ready ? ctx.r2 : undefined))
  }

  // 目录和执行均由框架提供；凭据只在闭包中传递，不进入模型提示词。
  tools.push(...await loadFrameworkTools(ctx, invocation))

  // 两道收窄，都在末尾统一做。**关掉是硬关**：工具根本不注册，
  // 模型看不到就不会尝试调用后被权限拒绝——那样既费 token 又让模型困惑。
  //
  // 放在最后统一过滤，而不是每个 push 前面加判断：这样新增工具时不必记得
  // 还要处理开关，漏一处的风险归零。
  //
  // 顺序：先减全局关掉的，再按人格白名单收窄。两者都是「减少」，
  // 所以顺序不影响结果，但按「运维 → 角色」读起来更顺。
  const allowed = allowedTools === undefined ? tools : filterAllowedTools(tools, allowedTools)
  const enabled = allowed.filter(tool => {
    // 管理目录保留停用项，运行时才收窄。
    if (invocation === undefined && disabledTools.size === 0) return true
    return !isToolDisabled(tool, disabledTools, enabledTools)
  })

  return createToolRegistry(enabled)
}


async function safeResolveModel(llm: LLMService, model: string, logger: Logger) {
  try {
    return await llm.resolve(model)
  } catch (error) {
    // 解析失败不阻断对话——chat 时还会再报一次，而且那个错误更具体
    logger.warn('模型解析失败，按不支持图片处理', {
      model,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * 从 session 造一个回复函数：走被动回复，省主动消息额度。
 *
 * 宿主的 `session.reply` 本身就支持 `{ image }` / `{ media }`，
 * 这里只是把工具产出的媒体转成它认识的形状。
 */
export function replyFromSession(session: {
  reply: (message: import('@qqbot/sdk').OutgoingMessage) => Promise<{ ok: boolean }>
}): ReplyFn {
  const reply = (async (text: string) => {
    const result = await session.reply(text)
    return result.ok
  }) as ReplyFn

  reply.media = async (item) => {
    const payload =
      item.type === 'image'
        ? {
            ...(item.caption ? { text: item.caption } : {}),
            image: { ...(item.url ? { url: item.url } : {}), ...(item.base64 ? { base64: item.base64 } : {}) },
          }
        : {
            ...(item.caption ? { text: item.caption } : {}),
            media: {
              type: item.type,
              ...(item.url ? { url: item.url } : {}),
              ...(item.base64 ? { base64: item.base64 } : {}),
              ...(item.filename ? { filename: item.filename } : {}),
            },
          }
    const result = await session.reply(payload as import('@qqbot/sdk').OutgoingMessage)
    return result.ok
  }

  return reply
}

/**
 * 出站内容过滤。返回被拦截时给出统一提示。
 *
 * `blocked` 为真时**整条回复替换成提示**而不是删掉：
 * 删除会让用户一直等不到任何回应，比拒绝更让人困惑。
 */
function filterOutbound(
  text: string,
  config: AgentConfig,
): { blocked: false; text: string } | { blocked: true } {
  const keywords = parseKeywords(config.content_filter_keywords)
  if (keywords.length === 0) return { blocked: false, text }
  const check = checkContent(text, keywords)
  if (check.blocked) return { blocked: true }
  return { blocked: false, text }
}

/** 按配置时区算日期键，用于按天统计 */
function dayKey(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}
