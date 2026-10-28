/**
 * 插件入口。
 *
 * ## 整体形状
 *
 * ```text
 * QQ 消息 ──> events 处理器（30 秒硬窗）
 *               │
 *               ├─ DO.submit() ──> 抢到执行权？
 *               │     ├─ 是 → 立刻跑 loop（软预算 18 秒），用被动回复发出去
 *               │     └─ 否 → 入队，等 cron
 *               │
 * cron（每分钟）──> ① 兜底捡队列里的 run
 *                   ② 触发到期的定时任务
 *                   ③ 清理过期数据（节流）
 * ```
 *
 * ## 为什么事件处理器要"抢执行权"而不是无脑入队
 *
 * 用户感知上，聊天必须秒回。如果所有消息都走 cron，最坏要等 60 秒，
 * 群里体验会很差。所以处理器先尝试同步跑，跑不完才落到 cron 兜底。
 *
 * 这是双段式调度的核心：**同一个 executeRun，两个调用点**。
 */
import { definePlugin } from '@qqbot/sdk'
import type { PluginContext, Session } from '@qqbot/sdk'
import type { AgentConfig } from './config/index.js'
import { configSchema, defaultConfig } from './config/index.js'
import { AgentObject } from './do/agent-object.js'
import type { HistoryRow } from './do/agent-object.js'
import type { InboundMessage } from './types.js'
import type { LLMService } from './llm/contract.js'
import { executeRun, replyFromSession } from './agent/run.js'
import { conversationKey, isTextMessage, toInboundMessage } from './agent/inbound.js'
import { hydrateImageAttachments } from './agent/media.js'
import { SCHEMA_STATEMENTS } from './store/schema.js'
import {
  advanceSchedule,
  listDueSchedules,
  pruneToolAudit,
} from './store/d1.js'
import { createPageRoutes } from './routes.js'

export { AgentObject }

/**
 * 事件处理器里同步跑 loop 的软预算。
 *
 * QFlareBot 一次事件所有插件合计只有 30 秒（平台限制），框架 25 秒就告警。
 * 留 12 秒余量给别的插件和回复投递，所以这里 18 秒就放弃、交给 cron。
 */
const INLINE_BUDGET_MS = 18_000

/** 审计数据保留多久 */
const AUDIT_RETENTION_MS = 7 * 24 * 3600 * 1000

/** 终态 run 在 DO 里保留多久（供处理器查询结果），之后清掉 */
const RUN_RETENTION_MS = 10 * 60 * 1000

/** 清理节流：最多每 10 分钟跑一次（删除也算 D1 写入） */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000

export default definePlugin<AgentConfig>({
  name: 'agent',
  displayName: 'Agent',
  description:
    '带工具调用的多轮对话：会话记忆、联网查资料、HTTP 请求、动态定时任务。需要配合「LLM 接口」插件使用。',
  apiVersion: 1,
  permissions: ['net', 'kv', 'db', 'durable', 'proactive'],

  depends: { llm: '*' },

  configSchema,
  defaultConfig,

  durableObjects: { Agent: AgentObject },

  ui: { path: '/ui/', title: 'Agent' },

  hooks: {
    async onInstall(ctx) {
      // 建表。QFlareBot 没有 migration runner，表结构统一在这里一次性建好；
      // IF NOT EXISTS 保证重装时幂等
      for (const statement of SCHEMA_STATEMENTS) {
        await ctx.db.exec(statement)
      }
    },
  },

  commands: {
    agent: {
      description: '问 Agent 一个问题',
      usage: '/agent <问题>',
      async handler({ session, ctx, argText }) {
        if (!argText.trim()) return '用法：/agent <你的问题>'
        await handleMessage(session, ctx, argText)
        return undefined
      },
    },

    'agent reset': {
      description: '清空当前会话的记忆',
      async handler({ session, ctx }) {
        const stub = agentStub(ctx, conversationKey(session))
        await stub.reset()
        return '这个会话的记忆已经清空了。'
      },
    },

    'agent status': {
      description: '查看 Agent 状态',
      async handler({ ctx }) {
        const llm = ctx.service<LLMService>('llm')
        let models: string[] = []
        let error: string | undefined
        try {
          const list = await llm.listModels()
          models = list.map((m) => m.alias)
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        const lines = [
          `模型别名：${ctx.config.model}`,
          models.length ? `可用别名：${models.join('、')}` : `别名列表读取失败${error ? `：${error}` : ''}`,
          `工具调用：${ctx.config.enable_tools ? '开' : '关'}`,
          `步数上限：${ctx.config.max_model_steps}`,
        ]
        return lines.join('\n')
      },
    },
  },

  // 群里 @机器人 或单聊时，直接说话就进 agent（不用打 /agent）
  events: {
    'qq.group.at_message': async ({ session, ctx }) => {
      if (!isTextMessage(session)) return
      await handleMessage(session, ctx, session.content ?? '')
      return undefined
    },
    'qq.c2c.message': async ({ session, ctx }) => {
      if (!isTextMessage(session)) return
      await handleMessage(session, ctx, session.content ?? '')
      return undefined
    },
  },

  cron: {
    /**
     * 每分钟一次。三件事：捡队列、跑定时任务、清理。
     *
     * 注意 QFlareBot 的 cron 是**所有插件串行**跑在同一个 invocation 里，
     * 一次 15 分钟墙钟上限。所以这里每次只处理少量 run，
     * 单次控制在 20 秒内，不拖累别的插件。
     */
    tick: {
      cron: '* * * * *',
      async handler({ ctx }) {
        await drainQueues(ctx)
        await fireDueSchedules(ctx)
        await maybePrune(ctx)
      },
    },
  },

  routes: createPageRoutes(),
})

// ---------------------------------------------------------------- 消息处理

async function handleMessage(
  session: Session,
  ctx: PluginContext<AgentConfig>,
  text: string,
): Promise<void> {
  const logger = ctx.logger
  const llm = ctx.service<LLMService>('llm')
  const config = ctx.config

  const message = toInboundMessage(session)
  // 事件里拿到的正文可能带 /agent 前缀，剥掉
  const cleaned = text.replace(/^\/agent\s*/i, '').trim()
  if (cleaned) message.text = cleaned

  // 图片要在入站时取回来：QQ 的图片 URL 带签名且有效期很短，
  // 等 cron 段再取可能已经 403。取不到就把说明拼进正文，别让整条消息失败
  if (message.attachments.some((a) => a.type === 'image')) {
    const hydrated = await hydrateImageAttachments(message.attachments)
    message.attachments = hydrated.attachments
    if (hydrated.notes.length) {
      message.text = `${message.text}\n\n（${hydrated.notes.join('；')}）`.trim()
      message.displayText = message.text
    }
  }

  const stub = agentStub(ctx, message.conversation)
  const reply = replyFromSession(session)

  // 单聊先给个"正在输入"，缓解等待焦虑
  if (config.show_typing && session.scene === 'c2c') {
    void session.typing(10).catch(() => false)
  }

  const claimed = await stub.submit(message)
  if (!claimed.acquired || !claimed.runId) {
    // 这个会话已经有人在跑，消息进队列了。告诉用户一声，别让人干等
    await reply('上一条还在处理，这条排队中，稍等一下。').catch(() => false)
    return
  }

  // 抢到执行权：立刻跑，带软预算
  const outcome = await withBudget(
    executeRun(
      { ctx, logger, config, llm, agent: stub, reply },
      claimed.runId,
      message,
    ),
    INLINE_BUDGET_MS,
  )

  if (outcome === 'timeout') {
    // 超预算：不 release，让租约到期后由 cron 接管重跑
    logger.warn('内联执行超预算，交给 cron 兜底', {
      conversation: message.conversation,
      runId: claimed.runId,
    })
    await reply('这个问题需要多花点时间，我处理完会直接回复你。').catch(() => false)
  }
}

// ---------------------------------------------------------------- cron 部分

/** 捡队列：每个会话的 DO 各问一次。会话数量通常很小（群 + 私聊） */
async function drainQueues(ctx: PluginContext<AgentConfig>): Promise<void> {
  const llm = ctx.service<LLMService>('llm')

  // 已知会话列表存在 KV 里（低频写，只在出现新会话时更新）
  const known = (await ctx.kv.getJSON<string[]>('conversations')) ?? []

  for (const conversation of known) {
    const stub = agentStub(ctx, conversation)
    const polled = await stub.poll()
    if (!polled.acquired || !polled.runId || !polled.message) continue

    // cron 里没有 session，用 api 主动发送
    const reply = makeApiReply(ctx, polled.message)
    await executeRun(
      { ctx, logger: ctx.logger, config: ctx.config, llm, agent: stub, reply },
      polled.runId,
      polled.message,
    )
  }
}

/** 到期的定时任务：用保存的 prompt 重新跑一轮 agent */
async function fireDueSchedules(
  ctx: PluginContext<AgentConfig>,
): Promise<void> {
  if (!ctx.config.enable_schedule) return

  const llm = ctx.service<LLMService>('llm')
  const due = await listDueSchedules(ctx.db, Date.now(), 3)
  if (due.length === 0) return

  for (const schedule of due) {
    const message: InboundMessage = {
      conversation: schedule.conversation,
      userId: schedule.created_by,
      userName: '',
      text: schedule.prompt,
      displayText: schedule.prompt,
      attachments: [],
      scene: schedule.scene,
      targetId: schedule.target_id,
      receivedAt: Date.now(),
    }

    const stub = agentStub(ctx, schedule.conversation)
    const reply = makeApiReply(ctx, message)

    try {
      // 定时任务直接跑，不进队列——它自己就是"已经到点"的语义
      const claimed = await stub.submit(message)
      if (claimed.acquired && claimed.runId) {
        await executeRun(
          { ctx, logger: ctx.logger, config: ctx.config, llm, agent: stub, reply },
          claimed.runId,
          message,
        )
      }
    } finally {
      // 无论跑没跑成都推进时间，否则会每分钟重试同一个任务直到天荒地老
      await advanceSchedule(ctx.db, schedule, Date.now())
    }
  }
}

/**
 * 清理。两件事，都做节流：
 *
 * 1. **DO 里的终态 run**：`release()` 把 run 标成 completed/failed 但保留记录，
 *    让处理器还能查到结果。不清的话 DO storage 会一直涨（DO storage 没有 TTL）。
 * 2. **D1 里的工具审计**：只在开了审计时才需要。
 *
 * 节流用 KV（十分钟一次），比每次 cron 都全扫一遍便宜。
 */
async function maybePrune(ctx: PluginContext<AgentConfig>): Promise<void> {
  const last = Number((await ctx.kv.get('last_prune')) ?? '0')
  const now = Date.now()
  if (now - last < PRUNE_INTERVAL_MS) return

  await ctx.kv.put('last_prune', String(now))

  // DO 侧的终态 run：保留一段时间供查询，之后清掉
  const known = (await ctx.kv.getJSON<string[]>('conversations')) ?? []
  let prunedRuns = 0
  for (const conversation of known) {
    try {
      prunedRuns += await agentStub(ctx, conversation).prune(RUN_RETENTION_MS)
    } catch (error) {
      // 某个会话的 DO 挂了不该挡住清理其他会话
      ctx.logger.warn('清理 DO 里的 run 失败', { conversation, error: String(error) })
    }
  }
  if (prunedRuns > 0) ctx.logger.info('清理终态 run', { count: prunedRuns })

  if (!ctx.config.enable_audit) return
  const removed = await pruneToolAudit(ctx.db, now - AUDIT_RETENTION_MS)
  if (removed > 0) ctx.logger.info('清理过期审计', { removed })
}

// ---------------------------------------------------------------- 工具函数

type AgentStub = {
  submit(message: InboundMessage): Promise<{ acquired: boolean; runId?: string; message?: InboundMessage; retryAfterMs?: number }>
  poll(): Promise<{ acquired: boolean; runId?: string; message?: InboundMessage; retryAfterMs?: number }>
  history(limit: number): Promise<HistoryRow[]>
  release(runId: string, result: { ok: boolean; error?: string; history?: HistoryRow[] }): Promise<void>
  retryLater(runId: string, reason: string): Promise<void>
  reset(): Promise<void>
  prune(olderThanMs: number): Promise<number>
}

function agentStub(
  ctx: PluginContext<AgentConfig>,
  conversation: string,
): AgentStub {
  // 记录已知会话，供 cron 遍历。低频写 KV（只在第一次见到某个会话时）
  void ctx.kv
    .getJSON<string[]>('conversations')
    .then(async (list) => {
      const current = list ?? []
      if (!current.includes(conversation)) {
        await ctx.kv.put('conversations', JSON.stringify([...current, conversation]))
      }
    })
    .catch(() => {})

  return ctx.durable.get<AgentObject>('Agent', conversation)
}

/**
 * cron 里用的回复函数。
 *
 * 优先用被动回复（`messageId` 还在有效期内，群聊 5 分钟），过期就退回主动消息。
 * 主动消息在群里需要群主授权，失败时只能记日志——这时候用户确实收不到，
 * 但那是平台限制，不是 bug。
 */
function makeApiReply(
  ctx: PluginContext<AgentConfig>,
  message: InboundMessage,
): (text: string) => Promise<boolean> {
  return async (text: string) => {
    const target = { scene: message.scene, id: message.targetId } as Parameters<
      typeof ctx.api.sendMessage
    >[0]

    const result = await ctx.api.sendMessage(
      target,
      { text },
      message.passiveMessageId ? { messageId: message.passiveMessageId, msgSeq: 2 } : {},
    )

    if (!result.ok) {
      ctx.logger.warn('主动回复失败', { conversation: message.conversation, error: result.error })
    }
    return result.ok
  }
}

/** 给一个 Promise 套时间预算；超时不取消原任务，只是不再等它 */
async function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
