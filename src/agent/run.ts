/**
 * 一次 run 的执行编排：认领 → 装上下文 → 跑 loop → 回复 → 收尾。
 *
 * 这个模块同时被两条路径调用：
 * - **事件处理器**：拿到执行权就同步跑（受软预算约束），用户感知上是"秒回"。
 * - **cron**：兜底捡队列里的 run，以及触发到期的定时任务。
 *
 * 两条路径共用同一份代码，保证行为一致——这是双段式调度的关键：
 * 不是两套逻辑，是同一个函数的两个调用点。
 */
import type { Logger, PluginContext, Session } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import type { HistoryRow } from '../do/agent-object.js'
import type { InboundMessage } from '../types.js'
import type { LLMService } from '../llm/contract.js'
import type { ToolRegistry } from '../tools/registry.js'
import { buildMessages, toHistoryRows } from './context.js'
import { describeLoopError, runAgentLoop } from './loop.js'
import { createToolRegistry } from '../tools/registry.js'
import { createTimeTool } from '../tools/time.js'
import { createHttpTool } from '../tools/http.js'
import { createWebTool } from '../tools/web.js'
import { createScheduleTools } from '../tools/schedule.js'
import { bumpDailyStats, recordToolAudit } from '../store/d1.js'
import { isTextMessage } from './inbound.js'

export interface RunDeps {
  ctx: PluginContext<AgentConfig>
  logger: Logger
  config: AgentConfig
  llm: LLMService
  /** 能拿到历史与写回历史的 DO stub */
  agent: AgentStub
  /** 回复用；cron 触发的定时任务没有 session，用 api 直接发 */
  reply: ReplyFn
}

export interface AgentStub {
  history(limit: number): Promise<HistoryRow[]>
  release(runId: string, result: { ok: boolean; error?: string; history?: HistoryRow[] }): Promise<void>
  retryLater(runId: string, reason: string): Promise<void>
}

export interface ReplyFn {
  (text: string): Promise<boolean>
}

/**
 * 跑一个已经认领的 run。
 *
 * 返回 `{ ok, retryable }`：`retryable` 为真时调用方应当把 run 退回队列
 * （上游限流这类错误），否则标记失败。
 */
export async function executeRun(
  deps: RunDeps,
  runId: string,
  message: InboundMessage,
): Promise<{ ok: boolean; retryable: boolean }> {
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
    const registry = buildRegistry(config)

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
      toolContext: (toolName) => ({
        db: ctx.db,
        logger,
        conversation: message.conversation,
        userId: message.userId,
        scene: message.scene,
        targetId: message.targetId,
        runId,
        timezone: config.timezone,
        markReplied: () => {
          /* loop 内部用 isRepliedByTool 判断，这里留空给将来扩展 */
        },
      }),
      onToolCall: config.enable_audit
        ? async ({ name, args, result, durationMs }) => {
            await recordToolAudit(ctx.db, {
              id: crypto.randomUUID(),
              conversation: message.conversation,
              runId,
              toolName: name,
              argsJson: JSON.stringify(args),
              resultJson: JSON.stringify(result).slice(0, 2000),
              status: result.status,
              durationMs,
            }).catch((error: unknown) => {
              // 审计写失败不该影响对话
              logger.warn('工具审计写入失败', { error: String(error) })
            })
          }
        : undefined,
    })

    // 4. 回复。工具已经发过就不重复发
    let replied = false
    if (!result.repliedByTool && result.reply?.trim()) {
      replied = await reply(result.reply.trim())
    }

    // 5. 写历史（工具已经发过消息时，把 assistant 的文本也记下来）
    const historyRows = toHistoryRows(
      message.displayText || message.text,
      result.reply ?? '',
      [],
    )
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

    return { ok: true, retryable: false }
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
      return { ok: false, retryable: true }
    }

    // 不可重试：直接告诉用户，并标记失败
    await reply(described.text).catch(() => false)
    await agent.release(runId, { ok: false, error: described.text })
    await bumpDailyStats(ctx.db, dayKey(config.timezone), { runs: 1, failed: 1 }).catch(() => {})
    return { ok: false, retryable: false }
  }
}

/** 按配置组装工具集。分开关只影响"要不要暴露给模型"，不影响已注册的工具 */
export function buildRegistry(config: AgentConfig): ToolRegistry {
  const enabled = new Set<'vfs' | 'schedule' | 'mcp'>()
  if (config.enable_vfs) enabled.add('vfs')
  if (config.enable_schedule) enabled.add('schedule')
  if (config.enable_mcp) enabled.add('mcp')

  const tools = [createTimeTool(), createHttpTool(), createWebTool(), ...createScheduleTools()]

  // enable_tools 是总开关：关掉之后一个工具都不给模型
  return createToolRegistry(config.enable_tools ? tools : [], { enabled })
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

/** 按配置时区算日期键，用于按天统计 */
function dayKey(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

/** 从 session 造一个回复函数：走被动回复，省主动消息额度 */
export function replyFromSession(session: Session): ReplyFn {
  return async (text: string) => {
    const result = await session.reply(text)
    return result.ok
  }
}
