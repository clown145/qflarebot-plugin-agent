/**
 * 一次 run 的执行编排：装上下文 → 跑 loop → 回复 → 收尾。
 *
 * 两条路径共用这一个函数：
 * - **事件处理器**：拿到执行权就同步跑（受软预算约束），用户感知是"秒回"。
 * - **cron**：兜底捡队列里的 run，以及触发到期的定时任务。
 *
 * 这是双段式调度的关键：不是两套逻辑，是同一个函数的两个调用点。
 */
import type { Logger, PluginContext, ScopedR2 } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import type { HistoryRow, SummaryInput } from '../do/agent-object.js'
import type { InboundMessage } from '../types.js'
import type { LLMService } from '../llm/contract.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { PermissionLevel, RegisteredTool } from '../tools/types.js'
import { buildMessages } from './context.js'
import { describeLoopError, runAgentLoop, type LoopResult } from './loop.js'
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
import {
  listPluginTools,
  type PluginToolExecutor,
  type PluginToolMeta,
  type PluginToolsService,
} from '../plugin-tools.js'

/** release / retryLater 之后可能返回「队列里下一个已认领的 run」 */
export interface NextRun {
  acquired: boolean
  runId?: string
  message?: InboundMessage
}

export interface AgentStub {
  history(limit: number): Promise<HistoryRow[]>
  release(
    runId: string,
    result: { ok: boolean; error?: string; history?: HistoryRow[] },
  ): Promise<NextRun>
  retryLater(runId: string, reason: string): Promise<NextRun>
  /** 登记待摘要的轮次（`summary` 模式用；其他模式不调） */
  stageSummary(messages: SummaryInput[], coveredMessages: number): Promise<void>
  /** 读取会话摘要（`summary` 模式用） */
  summary(): Promise<StoredSummary | null>
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
}

/** run 的结果。`retryable` 为真时调用方应把 run 退回队列 */
export interface RunOutcome {
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
 * 抽出来是为了让 `runWithRetry` 能整个重跑——重跑时上下文和工具集都会重建，
 * 不会带着上一轮的部分状态。
 */
async function runLoopOnce(input: {
  ctx: PluginContext<AgentConfig>
  logger: Logger
  config: AgentConfig
  llm: LLMService
  agent: AgentStub
  message: InboundMessage
  runId: string
  allowDangerous?: boolean
}): Promise<LoopResult> {
  const { ctx, logger, config, llm, agent, message, runId } = input

  const history = await agent.history(config.history_limit)
  // 摘要只在 summary 模式下读；读失败退回「没有摘要」——
  // 压缩仍然由 truncate 兜底，不该因为一次 DO 抖动就中断整轮对话
  const summary =
    config.context_compression === 'summary'
      ? await (agent.summary?.() ?? Promise.resolve(null)).catch(() => null)
      : null
  const modelInfo = await safeResolveModel(llm, config.model, logger)

  // 人格：会话绑定 > 配置默认人格 > system_prompt。读失败不该让整轮对话失败
  // （绑定表是 D1，抖动时退回 system_prompt 即可）
  const bound = await getPersonaBinding(ctx.db, message.conversation).catch(() => undefined)
  const persona = resolvePersona(config, bound)
  if (persona.name) logger.debug('使用人格', { conversation: message.conversation, persona: persona.name })

  // R2 探测放在这里（而不是 buildRegistry 里）是因为它是异步的，而 buildRegistry
  // 被设计成同步、好测。探测结果在 isolate 内缓存，正常对话不会多出往返。
  const r2Ready = config.enable_tools && config.enable_vfs ? await hasR2(ctx) : false

  // 工具栏开关：管理页里逐个关掉的工具。读失败不该让整轮对话失败——
  // 退回「全开」是安全的（权限层仍然管着每个工具能不能真用）。
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

  const messages = buildMessages(effectiveMessage, history, {
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

  return runAgentLoop({
    llm,
    registry,
    logger,
    model: config.model,
    messages,
    maxModelSteps: config.max_model_steps,
    maxToolCalls: config.max_tool_calls,
    requestTimeoutMs: config.request_timeout_ms,
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
 * 跑一次，遇到可重试错误就等一会儿再跑一次。
 *
 * **为什么不在事件处理器里做**：限流发生在 loop 内部（第一次模型调用就可能 429），
 * 在外面重试等于把整个 loop 重跑，但如果已经执行过工具就会重复副作用。
 * 所以放在这一层：重试时上下文和工具集重建，loop 从头开始——
 * 此时还没有产生任何副作用（第一次模型调用就失败了）。
 *
 * 重试次数固定为 1：两次都失败说明不是瞬时抖动，继续等只会吃满事件预算。
 */
async function runWithRetry(
  run: () => Promise<LoopResult>,
  logger: Logger,
  delayMs: number,
): Promise<LoopResult> {
  try {
    return await run()
  } catch (error) {
    const described = describeLoopError(error)
    if (!described.retryable) throw error

    logger.warn('可重试错误，稍后重试一次', { error: described.text, delayMs })
    await sleep(delayMs)

    try {
      return await run()
    } catch (secondError) {
      const second = describeLoopError(secondError)
      logger.error('重试后仍失败', { error: second.text })
      throw secondError
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 跑一个已经认领的 run。
 *
 * **注意**：这个函数一旦开始就必须跑完并 `release`。调用方（事件处理器）
 * 用 `withBudget` 做软预算时**不能**在超时后丢弃它——那会导致
 * 原任务继续跑、cron 又重跑一遍，用户收到两条回复。
 * 正确做法是超时后**只停止等待**，但仍让本函数跑完收尾（见 index.ts）。
 */
export async function executeRun(
  deps: RunDeps,
  runId: string,
  message: InboundMessage,
): Promise<RunOutcome> {
  const { ctx, logger, config, llm, agent, reply } = deps

  try {
    // 1–3. 装上下文、建工具集、跑 loop。
    //
    // 限流/超时这类可重试错误在这里**就地重试一次**，而不是退回队列——
    // 退回队列会让用户什么都收不到（消息静默消失）。429 通常几秒就恢复，
    // 而被动回复窗口群聊有 5 分钟，完全等得起。
    const result = await runWithRetry(
      () =>
        runLoopOnce({
          ctx,
          logger,
          config,
          llm,
          agent,
          message,
          runId,
          allowDangerous: deps.allowDangerous,
        }),
      logger,
      deps.retryDelayMs ?? RETRY_DELAY_MS,
    )

    // 4a. 先发工具产出的富媒体（图片/文件）。
    //
    // 放在纯文本之前：用户的阅读顺序应该是「看到图 → 再看到说明」。
    // 媒体本身不过内容安全（那是二进制），但 caption 会过。
    let replied = false
    for (const item of result.outbound ?? []) {
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
    if (!result.repliedByTool && result.reply?.trim()) {
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
        content: message.displayText || message.text,
        toolCallsJson: null,
        createdAt: now,
      },
    ]
    if (result.reply?.trim()) {
      historyRows.push({
        role: 'assistant',
        content: result.reply.trim(),
        // 把本轮调过的工具写进历史，模型下一轮才能看到「我上次查过什么」。
        // 以前这里是硬编码 null，导致 context.ts 承诺的「历史回放 toolCalls」
        // 分支在真实数据上永远走不到，模型会重复调同一个工具。
        toolCallsJson: result.toolTraces.length ? JSON.stringify(result.toolTraces) : null,
        createdAt: now + 1,
      })
    }
    const next = await agent.release(runId, { ok: true, history: historyRows })

    // 5b. summary 模式：把这次压缩丢掉的内容登记进 DO，等 cron 生成摘要。
    //
    // **不在这里生成摘要**：生成要调一次模型，而 executeRun 跑在事件处理器的
    // 30 秒预算里（群聊被动回复窗口也就 5 分钟）。一次摘要调用几百毫秒到几十秒，
    // 插在这里很可能让用户什么都收不到。cron 没有事件预算，是更合适的位置。
    //
    // 登记失败不能影响这一轮对话：摘要只是增强，truncate 仍然保底。
    if (config.context_compression === 'summary' && result.droppedForSummary.length > 0) {
      await agent
        .stageSummary(result.droppedForSummary, result.droppedForSummary.length)
        .catch((error: unknown) => {
          logger.warn('登记待摘要内容失败，本轮不影响', { error: String(error) })
        })
    }

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
    const described = describeLoopError(error)
    logger.error('run 失败', {
      conversation: message.conversation,
      retryable: described.retryable,
      error: error instanceof Error ? error.message : String(error),
    })

    // **无论可不可重试，都要告诉用户**。
    //
    // 上一版在可重试时静默退回队列，用户什么都收不到——消息凭空消失，
    // 比报错更让人困惑。而 runWithRetry 已经在内部重试过一次，
    // 走到这里说明重试也没成功，该让用户知道。
    //
    // 人格可以自定义错误文案（AstrBot 的 `custom_error_message`）：
    // 一个毒舌角色突然冒出「处理失败：HTTP 500」会很出戏。
    // 只在**错误路径**上解析一次人格——成功路径不承担这次 D1 读。
    const customError = await resolvePersonaErrorText(ctx, config, message.conversation)
    const replied = await reply(customError ?? described.text).catch(() => false)

    if (described.retryable) {
      // 仍然退回队列：用户可能再发一次消息，那时能接着处理。
      // 但已经告知过用户，不再是静默失败。
      const next = await agent.retryLater(runId, described.text)
      await bumpDailyStats(ctx.db, dayKey(config.timezone), { runs: 1, failed: 1 }).catch(() => {})
      return { ok: false, retryable: true, replied, next }
    }

    await agent.release(runId, { ok: false, error: described.text })
    await bumpDailyStats(ctx.db, dayKey(config.timezone), { runs: 1, failed: 1 }).catch(() => {})
    return { ok: false, retryable: false, replied }
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

  // 其他插件提供的工具。
  //
  // 分两步：**元数据**从 D1 读（构建注册表时要同步拿到），
  // **执行函数**从提供者的 `services` 取（函数没法序列化）。
  // 取不到执行函数的工具**不注册** —— 提供者可能没装或被停用了，
  // 注册一个每次调用都报错的工具只会让模型反复重试。
  tools.push(...await loadPluginTools(ctx))

  // 两道收窄，都在末尾统一做。**关掉是硬关**：工具根本不注册，
  // 模型看不到就不会尝试调用后被权限拒绝——那样既费 token 又让模型困惑。
  //
  // 放在最后统一过滤，而不是每个 push 前面加判断：这样新增工具时不必记得
  // 还要处理开关，漏一处的风险归零。
  //
  // 顺序：先减全局关掉的，再按人格白名单收窄。两者都是「减少」，
  // 所以顺序不影响结果，但按「运维 → 角色」读起来更顺。
  let enabled = disabledTools.size
    ? tools.filter((tool) => !disabledTools.has(tool.definition.name))
    : tools

  // 人格白名单：`undefined` = 不限（老配置的语义）；数组（含空）才过滤。
  // 空数组 = 这套人格什么工具都不能用 —— 这是有意义的配置，不能当成「不限」。
  if (allowedTools !== undefined) {
    const allow = new Set(allowedTools)
    enabled = enabled.filter((tool) => allow.has(tool.definition.name))
  }

  return createToolRegistry(enabled)
}


/**
 * 把其他插件注册的工具变成 RegisteredTool。
 *
 * ## 为什么要过 services
 *
 * 工具元数据（名字、描述、schema）能存 D1，但**执行函数不能** ——
 * 函数不是可序列化的值。所以元数据从库里读，函数从提供者的
 * `services` 运行时取。
 *
 * 提供者的服务名约定是 `tools`：它导出一个
 * `{ [工具短名]: (input) => Promise<unknown> }` 的对象。
 *
 * ## 失败处理
 *
 * 任何一个提供者出问题都**只影响它自己的工具**：
 * - 服务取不到（没装/被停用）→ 跳过它的全部工具
 * - 某个工具没有对应执行函数 → 跳过那个工具
 * - 每次调用都包了超时，防止一个插件拖死整个 run
 */
async function loadPluginTools(ctx: PluginContext<AgentConfig>): Promise<RegisteredTool[]> {
  let metas: PluginToolMeta[]
  try {
    metas = await listPluginTools(ctx.db)
  } catch {
    // 建表前/读失败：没有插件工具而已，不该让整轮对话失败
    return []
  }
  if (!metas.length) return []

  // 按提供者分组，每个提供者只取一次服务
  const byOwner = new Map<string, PluginToolMeta[]>()
  for (const meta of metas) {
    const list = byOwner.get(meta.owner) ?? []
    list.push(meta)
    byOwner.set(meta.owner, list)
  }

  const out: RegisteredTool[] = []
  for (const [owner, items] of byOwner) {
    let service: PluginToolsService
    try {
      service = ctx.service<PluginToolsService>(owner)
    } catch {
      // 提供者没装 / 被停用：静默跳过（这条路径每个会话都会走，不能刷日志）
      continue
    }
    if (!service || typeof service !== 'object') continue

    for (const meta of items) {
      const execute = service[meta.name]
      if (typeof execute !== 'function') continue
      out.push(toRegisteredPluginTool(meta, execute))
    }
  }
  return out
}

/** 把一条元数据 + 执行函数包成 Agent 自己的 RegisteredTool */
function toRegisteredPluginTool(
  meta: PluginToolMeta,
  execute: PluginToolExecutor,
): RegisteredTool {
  return {
    source: { type: 'plugin', id: meta.owner, name: meta.owner },
    definition: {
      name: meta.fullName,
      title: meta.name,
      description: meta.description,
      inputSchema: meta.inputSchema,
      // 权限级别在注册时已经被抬到至少 MIN_PLUGIN_TOOL_LEVEL；
      // 这里再兜一次，防止有人直接改库把它调低
      // 用通用 scope `plugin:use`，不用 `plugin:<owner>` ——
      // 后者不在角色基线里，会让工具的 level 判定形同虚设（永远 permission_denied）。
      // 各插件的权限差异由 level 表达，不需要每个插件一个 scope。
      permission: { level: Math.max(2, meta.level) as PermissionLevel, scopes: ['plugin:use'] },
      sideEffect: meta.sideEffect,
      timeoutMs: meta.timeoutMs,
    },
    execute: async (context) => {
      try {
        // 超时兜底：插件工具的实现不受我们控制，可能挂住不返回。
        // 不 race 掉的话，一个坏插件能把整个 run 拖到事件超时。
        const output = await withTimeout(execute(context.input), meta.timeoutMs)
        return { status: 'success', output }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const timedOut = message.includes('超时')
        return {
          status: timedOut ? 'timeout' : 'failed',
          error: {
            code: timedOut ? 'plugin_tool_timeout' : 'plugin_tool_failed',
            message: `插件 ${meta.owner} 的工具 ${meta.name} 失败：${message}`,
            // 插件内部错误是否可重试我们不知道，保守起见不可重试 ——
            // 可重试会让模型反复重试同一次失败
            retryable: false,
          },
        }
      }
    },
  }
}

/** 超时包装。`Promise.race` 不能取消底层 promise，但能让 run 继续往下走 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
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
