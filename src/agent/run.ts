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
import { describeLoopError, runAgentLoop } from './loop.js'
import { createToolRegistry } from '../tools/registry.js'
import { createTimeTool } from '../tools/time.js'
import { createHttpTool } from '../tools/http.js'
import { createWebTool } from '../tools/web.js'
import { createScheduleTools } from '../tools/schedule.js'
import { createVfsTools } from '../tools/vfs/tools.js'
import { bumpDailyStats, recordToolAudit } from '../store/d1.js'

export interface AgentStub {
  history(limit: number): Promise<HistoryRow[]>
  release(runId: string, result: { ok: boolean; error?: string; history?: HistoryRow[] }): Promise<void>
  retryLater(runId: string, reason: string): Promise<void>
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
}

/** run 的结果。`retryable` 为真时调用方应把 run 退回队列 */
export interface RunOutcome {
  ok: boolean
  retryable: boolean
  /** 已经发过回复 */
  replied: boolean
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
    // 1. 装配上下文
    const history = await agent.history(config.history_limit)
    const modelInfo = await safeResolveModel(llm, config.model, logger)
    const messages = buildMessages(message, history, {
      systemPrompt: config.system_prompt,
      timezone: config.timezone,
      historyLimit: config.history_limit,
      supportsVision: modelInfo?.capabilities.includes('image') ?? false,
    })

    // 2. 建工具集
    const registry = buildRegistry(ctx, config)

    // 3. 跑 loop
    const result = await runAgentLoop({
      llm,
      registry,
      logger,
      model: config.model,
      messages,
      maxModelSteps: config.max_model_steps,
      maxToolCalls: config.max_tool_calls,
      requestTimeoutMs: config.request_timeout_ms,
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
        allowDangerous: deps.allowDangerous,
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

    // 4. 回复。工具已经发过就不重复发
    let replied = false
    if (!result.repliedByTool && result.reply?.trim()) {
      replied = await reply(result.reply.trim())
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
        toolCallsJson: null,
        createdAt: now + 1,
      })
    }
    await agent.release(runId, { ok: true, history: historyRows })

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

    return { ok: true, retryable: false, replied }
  } catch (error) {
    const described = describeLoopError(error)
    logger.error('run 失败', {
      conversation: message.conversation,
      retryable: described.retryable,
      error: error instanceof Error ? error.message : String(error),
    })

    if (described.retryable) {
      // 可重试：退回队列，让 cron 稍后捡起来
      await agent.retryLater(runId, described.text)
      return { ok: false, retryable: true, replied: false }
    }

    // 不可重试：直接告诉用户，并标记失败
    const replied = await reply(described.text).catch(() => false)
    await agent.release(runId, { ok: false, error: described.text })
    await bumpDailyStats(ctx.db, dayKey(config.timezone), { runs: 1, failed: 1 }).catch(() => {})
    return { ok: false, retryable: false, replied }
  }
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
): ToolRegistry {
  if (!config.enable_tools) return createToolRegistry([])

  const tools: RegisteredTool[] = [createTimeTool(), createWebTool()]

  // http 是高权限工具（level 3），但它的权限由 permissions 层判定，
  // 这里只负责注册——关掉 enable_tools 才不注册
  tools.push(createHttpTool())

  if (config.enable_schedule) {
    tools.push(...createScheduleTools())
  }

  if (config.enable_vfs) {
    // R2 没绑定时 vfs 不可用（大文件存不进去）。此时只注册 D1 能撑的部分？
    // 不行——用户开了开关却只能写小文件会困惑，所以直接不注册并记一条日志
    const r2 = ctx.r2 as ScopedR2 | undefined
    if (r2) {
      tools.push(...createVfsTools(ctx.db, r2))
    } else {
      ctx.logger.warn('enable_vfs 打开了但 R2 未绑定，工作区工具不可用')
    }
  }

  return createToolRegistry(tools)
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

/** 从 session 造一个回复函数：走被动回复，省主动消息额度 */
export function replyFromSession(session: {
  reply: (text: string) => Promise<{ ok: boolean }>
}): ReplyFn {
  return async (text: string) => {
    const result = await session.reply(text)
    return result.ok
  }
}

/** 按配置时区算日期键，用于按天统计 */
function dayKey(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}
