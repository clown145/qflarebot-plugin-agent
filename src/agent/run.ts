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
import type { HistoryRow } from '../do/agent-object.js'
import type { InboundMessage } from '../types.js'
import type { LLMService } from '../llm/contract.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { RegisteredTool } from '../tools/types.js'
import { buildMessages } from './context.js'
import { describeLoopError, runAgentLoop, type LoopResult } from './loop.js'
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
}

export interface ReplyFn {
  (text: string): Promise<boolean>
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
  const registry = buildRegistry(ctx, config, r2Ready, disabled, persona.allowedTools)

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
  const messages = buildMessages(effectiveMessage, history, {
    systemPrompt: config.system_prompt,
    ...(persona.prompt ? { personaPrompt: persona.prompt } : {}),
    timezone: config.timezone,
    historyLimit: config.history_limit,
    supportsVision: modelInfo?.capabilities.includes('image') ?? false,
    toolNames: registry.list().map((tool) => tool.definition.name),
    ...(persona.beginDialogs.length ? { beginDialogs: persona.beginDialogs } : {}),
    ...(skillCatalog.length ? { skillCatalog } : {}),
    ...(activeSkill ? { activeSkill } : {}),
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
    // `summary` 模式在 loop 里等价于 `truncate`：循环内不可能插一次额外模型调用
    // 去摘要而不超预算。summary 的价值主要在「跨轮记忆」，这里退化为 truncate。
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

    // 4. 回复。工具已经发过就不重复发
    //
    // 出站也要过一遍内容安全（对标 AstrBot 的 ResultDecorateStage）：
    // 只查入站不够——模型可能把用户诱导出的敏感内容再复述一遍，
    // 而那才是真正发到群里的东西。
    let replied = false
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
export function buildRegistry(
  ctx: PluginContext<AgentConfig>,
  config: AgentConfig,
  r2Ready: boolean,
  disabledTools: ReadonlySet<string> = new Set(),
  /**
   * 人格的工具白名单（AstrBot Persona.tools 的对应物）。
   * `undefined` = 不限；数组（含空数组）= 只允许这些。
   */
  allowedTools?: readonly string[],
): ToolRegistry {
  if (!config.enable_tools) return createToolRegistry([])

  const tools: RegisteredTool[] = [createTimeTool(), createWebTool()]

  // http 是高权限工具（level 3），但它的权限由 permissions 层判定，
  // 这里只负责注册——关掉 enable_tools 才不注册
  tools.push(createHttpTool())

  // 联网搜索。**未配置 key 时也注册**：模型能看到这个工具、拿到一句可读的
  // 「还没配置搜索」，比让模型以为「我没有搜索能力」然后凭空瞎编要好。
  // 这比整组不注册更诚实——不注册等于假装这个能力不存在。
  tools.push(
    ...createSearchTools(
      config.search_api_key ? { provider: 'tavily', apiKey: config.search_api_key } : undefined,
    ),
  )

  if (config.enable_schedule) {
    tools.push(...createScheduleTools())
  }

  if (config.enable_vfs) {
    // R2 没绑定时 vfs 不可用（大文件存不进去）。用户开了开关却只能写小文件会困惑，
    // 所以整组不注册，并在选择模型时记一条日志（只记一次，不刷屏）
    if (r2Ready) {
      tools.push(...createVfsTools(ctx.db, ctx.r2))
    } else if (!warnedNoR2) {
      warnedNoR2 = true
      ctx.logger.warn('enable_vfs 打开了但 R2 未绑定，工作区工具不可用')
    }
  }

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

/** 同一个 isolate 里只警告一次，避免每条消息刷一行日志 */
let warnedNoR2 = false

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

/** 从 session 造一个回复函数：走被动回复，省主动消息额度 */export function replyFromSession(session: {
  reply: (text: string) => Promise<{ ok: boolean }>
}): ReplyFn {
  return async (text: string) => {
    const result = await session.reply(text)
    return result.ok
  }
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
