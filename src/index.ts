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
import { Agent } from './do/agent-object.js'
import type { HistoryRow } from './do/agent-object.js'
import type { InboundMessage } from './types.js'
import type { LLMService } from './llm/contract.js'
import { executeRun, replyFromSession, type RunDeps } from './agent/run.js'
import { conversationKey, isTextMessage, toInboundMessage } from './agent/inbound.js'
import { hydrateImageAttachments } from './agent/media.js'
import { SCHEMA_STATEMENTS } from './store/schema.js'
import {
  advanceSchedule,
  cancelSchedule,
  listDueSchedules,
  listSchedules,
  pruneToolAudit,
} from './store/d1.js'
import { createPageRoutes } from './routes.js'

export { Agent }

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

/**
 * KV 里记住多少个会话。
 *
 * 这个列表唯一的用途是 cron 的 10 分钟清理轮知道该扫哪些 DO（恢复滞留 run、清终态 run）。
 * 每多记一个会话，就是每天多 144 次 DO 唤醒。
 */
const MAX_TRACKED_CONVERSATIONS = 20

export default definePlugin<AgentConfig>({
  name: 'agent',
  displayName: 'Agent',
  description:
    '带工具调用的多轮对话：会话记忆、联网查资料、HTTP 请求、动态定时任务。需要配合「LLM 接口」插件使用。',
  // 2 = 用到 `ctx.db.batch()`（VFS 写入把元数据与内容合成一批）。
  // 写 1 的话装在 0.4 以前的机器人上能过安装检查，然后在第一次写文件时
  // `TypeError: db.batch is not a function`——正是 apiVersion 要防的那种「装上了才炸」。
  apiVersion: 2,
  permissions: ['net', 'kv', 'db', 'durable', 'proactive'],

  depends: { llm: '*' },

  configSchema,
  defaultConfig,

  durableObjects: { Agent: Agent },

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

    'agent schedule': {
      description: '查看本会话的定时任务',
      usage: '/agent schedule [cancel <id>]',
      async handler({ session, ctx, argText }) {
        const conversation = conversationKey(session)
        const arg = argText.trim()

        // /agent schedule cancel <id>
        if (arg.startsWith('cancel ')) {
          const id = arg.slice('cancel '.length).trim()
          if (!id) return '用法：/agent schedule cancel <任务 id>'
          const cancelled = await cancelSchedule(ctx.db, id, conversation)
          return cancelled ? `已取消任务 ${id}。` : '没有找到这个任务，或者它不在本会话。'
        }

        const rows = await listSchedules(ctx.db, conversation, 20)
        if (rows.length === 0) return '本会话没有待触发的定时任务。'

        const lines = rows.map((row) => {
          const when = formatScheduleTime(row.due_at, ctx.config.timezone)
          const repeat = row.repeat_seconds
            ? `（每 ${Math.round(row.repeat_seconds / 60)} 分钟重复）`
            : '（一次性）'
          return `${when}${repeat}：${row.prompt}\n  id: ${row.id}`
        })
        return ['本会话的定时任务：', ...lines, '', '取消用 /agent schedule cancel <id>'].join('\n')
      },
    },

    'agent status': {
      description: '查看 Agent 状态',
      async handler({ ctx }) {
        // `ctx.service()` 在提供者被停用/卸载时会抛错。这里必须兜住：
        // 让它抛就变成「用户发了命令、什么都没收到」，而实际原因是 LLM 插件没启用。
        // 与 handleMessage 的降级保持一致，只是这里还能把本地配置照常报出来。
        let llm: LLMService | null = null
        let models: string[] = []
        let error: string | undefined
        try {
          llm = ctx.service<LLMService>('llm')
          const list = await llm.listModels()
          models = list.map((m) => m.alias)
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        const lines = [
          `模型别名：${ctx.config.model}`,
          !llm
            ? 'LLM 接口插件未启用——请在面板的插件页启用或安装它'
            : models.length
              ? `可用别名：${models.join('、')}`
              : `别名列表读取失败${error ? `：${error}` : ''}`,
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
     * 每分钟一次。**只做三件事**：触发到期的定时任务、恢复被掐断的 run、清理过期数据。
     *
     * ## 为什么不在这里轮询消息队列
     *
     * 队列里的 run 只有两种来源：同会话正忙时新消息入队（上一个 run 跑完后
     * `release()` 会顺手认领下一个并返回，事件处理器接着跑完），以及
     * **执行者中途被掐断**（事件 30 秒硬窗、CPU 1102）。
     *
     * 前者不需要 cron；后者必须有兜底——否则租约过期后没有任何人会再来认领，
     * 这个会话的排队消息就永久停滞，用户再也收不到回复。所以恢复只在
     * **10 分钟一次的清理轮**里做，平时不碰 DO：每分钟对每个会话 poll 一次是
     * 20 会话 = 每天 28,800 次 DO 唤醒，而 DO 按 GB-秒计费。
     *
     * ## 为什么定时任务必须靠 cron
     *
     * 它们的触发时间散落在未来，没有任何请求会主动唤醒。这是 cron 唯一不可替代的职责。
     * 只有 enable_schedule 打开时才查，且没到期任务时一次 D1 查询就退出。
     *
     * 注意 QFlareBot 的 cron 是**所有插件串行**跑在同一个 invocation 里，
     * 墙钟上限 15 分钟。所以这里整轮控制在 20 秒内，不拖累别的插件。
     */
    tick: {
      cron: '* * * * *',
      async handler({ ctx }) {
        const startedAt = Date.now()

        const hasDueSchedule = ctx.config.enable_schedule
          ? (await listDueSchedules(ctx.db, Date.now(), 1)).length > 0
          : false

        if (hasDueSchedule) await fireDueSchedules(ctx, startedAt)

        const now = Date.now()
        // 节流决策只做一次，然后**显式传下去**：
        // 以前是先置 `pruneThrottle.at = now` 再让 maybePruneAudit 自己重判 `shouldPrune`，
        // 于是第二次判断永远为假，审计清理一次都没跑过（{tool_audit} 无限增长）。
        if (!shouldPrune(ctx, now)) return
        pruneThrottle.at = now

        await maybePruneAudit(ctx, now)
        await serviceConversationObjects(ctx, startedAt)
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
  const config = ctx.config

  // 依赖没满足时给用户一句能看懂的话，而不是让框架抛 "没有在 depends 中声明" 这类内部错误。
  // 正常情况下安装时就被拦下了（depends: { llm: '*' }），但提供者可能事后被停用或卸载
  let llm: LLMService
  try {
    llm = ctx.service<LLMService>('llm')
  } catch {
    await session
      .reply('Agent 需要的「LLM 接口」插件没有启用。请在面板的插件页启用它，或者先安装。')
      .catch(() => false)
    logger.error('llm 服务不可用，无法处理消息', { conversation: conversationKey(session) })
    return
  }

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

  // 记住这个会话，cron 兜底时要遍历。只在收到消息时记，不是每次取 stub 时记
  await rememberConversation(ctx, message.conversation)

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

  // 抢到执行权：立刻跑，带软预算。
  //
  // 关键：超时后**不能**丢弃这个 Promise。上一版用 Promise.race 直接放弃等待，
  // 结果原任务继续跑完并 reply()，同时 cron 因租约到期把同一个 run 重跑一遍，
  // 用户收到两条回复、还写了两份历史。
  //
  // 正确做法：超时只停止"等待"，任务本身仍然跑完并自己 release。
  // 超时那一刻告诉用户一声，但不再补第二条。
  const running = runUntilQueueEmpty(
    { ctx, logger, config, llm, agent: stub, reply },
    claimed.runId,
    message,
  )

  const outcome = await withBudget(running, INLINE_BUDGET_MS)

  if (outcome === 'timeout') {
    logger.warn('内联执行超预算，任务继续在后台跑', {
      conversation: message.conversation,
      runId: claimed.runId,
    })
    // 只提示一次，不 await 任务本身
    await reply('这个问题要多花点时间，我处理完会直接回复你。').catch(() => false)
    // 让任务在本次请求的后台继续跑完（ctx.waitUntil 保证它不会被提前取消）。
    // runUntilQueueEmpty 会一路把队列跑空，所以不需要额外标记让 cron 兜底。
    ctx.waitUntil(running.catch(() => undefined))
  }
}

/**
 * 跑一个 run，跑完接着跑队列里的下一个，直到队列空或超出预算。
 *
 * **为什么不需要 cron 定期唤醒**：队列里的 run 只有两种情况——
 * 1. 同会话正忙时新消息入队 → 上一个跑完就立刻接着跑，延迟只有几秒
 * 2. 事件处理器超预算 → `ctx.waitUntil` 里这条链会继续跑到队列空
 *
 * 所以正常情况下队列永远是空的，cron 不需要每分钟轮询它。
 * cron 唯一的职责是「检查有没有到期的定时任务」。
 */
async function runUntilQueueEmpty(
  deps: RunDeps,
  runId: string,
  message: InboundMessage,
): Promise<void> {
  // executeRun 内部的 release() 会顺手认领队列里的下一个并返回，
  // 所以这里循环到「没有下一个」为止。
  // 上限 5 个：防止某个会话积压几十条消息时一次请求跑太久
  for (let i = 0; i < 5; i += 1) {
    const next = await executeRun(deps, runId, message)
    if (!next.next?.acquired || !next.next.runId || !next.next.message) return
    runId = next.next.runId
    message = next.next.message
  }
}

// ---------------------------------------------------------------- cron 部分

/**
 * 安全地取 llm 服务。
 *
 * `ctx.service()` 在提供者被停用/卸载时会抛错。在事件处理器里让它抛是对的
 * （用户能立刻看到原因），但在 cron 里抛会让**每分钟都失败一次**、
 * 把日志刷满，还拖慢同一 invocation 里其他插件的定时任务。
 * 所以 cron 用这个：取不到就返回 null，由调用方安静跳过。
 */
function tryLLM(ctx: PluginContext<AgentConfig>): LLMService | null {
  try {
    return ctx.service<LLMService>('llm')
  } catch (error) {
    ctx.logger.warn('llm 服务不可用，本次 cron 跳过', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}


/**
 * 一次 cron 轮的总时间预算。
 *
 * QFlareBot 的 cron 是**所有插件串行**跑在同一个 invocation 里（墙钟 15 分钟），
 * 这个插件拖久了别的插件的定时任务就得排队等。留足余量：整轮 20 秒。
 */
const CRON_BUDGET_MS = 20_000

/**
 * 顺带扫一遍各会话的 DO：认领滞留的 run + 清理终态 run。
 *
 * ## 为什么必须有这一步
 *
 * run 有两种来源：同会话忙时新消息入队（跑完后 `release()` 链式认领，不需要 cron），
 * 和**执行者中途被掐断**（事件 30 秒硬窗、CPU 1102 都会）。后者 `release()` 永远跑不到，
 * 租约 90 秒后过期但没人认领——这个会话的排队消息就永久停滞。
 * 只靠「下一条消息进来时顺带认领」在冷会话里等于永远不恢复。
 *
 * ## 为什么节流到 10 分钟
 *
 * DO 按 GB-秒计费（免费版 13,000 GB-s/日）。每分钟对每个会话唤醒一次是
 * 20 会话 × 1,440 = 28,800 次/天，纯浪费。10 分钟一次、且**每个会话只发一次 RPC**
 * （`sweep` 在 DO 内部一次做完认领与清理）：20 × 144 = 2,880 次/天。
 *
 * 会话列表上限因此压到 20：个人机器人远用不到，多出来的会话真的触发时
 * 会被 `rememberConversation` 记进来（保留最近的）。
 */
async function serviceConversationObjects(
  ctx: PluginContext<AgentConfig>,
  startedAt: number,
): Promise<void> {
  const known = (await ctx.kv.getJSON<string[]>('conversations')) ?? []
  if (known.length === 0) return

  // llm 只在真的要跑滞留 run 时才需要：清理终态 run 与它无关，
  // 不能因为 LLM 插件被停用就把清理也一起停掉（那会让 DO 里堆满终态 run）。
  let llm: LLMService | null = null
  let llmChecked = false

  for (const conversation of known) {
    // 超预算就放弃剩下的会话，下一轮 cron 接着来——宁可晚 10 分钟恢复，
    // 也不能把同一个 invocation 里别的插件的定时任务拖到超时
    if (Date.now() - startedAt > CRON_BUDGET_MS) {
      ctx.logger.warn('cron 超出预算，剩余会话留待下一轮', { remaining: known.length - known.indexOf(conversation) })
      return
    }

    try {
      const stub = agentStub(ctx, conversation)
      // 一次 RPC 同时做「认领滞留 run」与「清理终态 run」
      const picked = await stub.sweep(RUN_RETENTION_MS)
      if (!picked.claimed.acquired || !picked.claimed.runId || !picked.claimed.message) continue

      if (!llmChecked) {
        llmChecked = true
        llm = tryLLM(ctx)
      }
      if (!llm) {
        // 认领到了却跑不了：把 run 退回队列，别让它挂在 running 状态上
        await stub.retryLater(picked.claimed.runId, 'llm 服务不可用')
        continue
      }

      const message = picked.claimed.message
      const reply = makeApiReply(ctx, message)
      await executeRun(
        { ctx, logger: ctx.logger, config: ctx.config, llm, agent: stub, reply },
        picked.claimed.runId,
        message,
      )
    } catch (error) {
      // 某个会话的 DO 挂了不该挡住别的会话
      ctx.logger.warn('恢复会话 DO 失败', { conversation, error: String(error) })
    }
  }
}

/**
 * 这次 cron 要不要顺手清理终态 run / 恢复滞留 run。
 *
 * 清理是 DELETE 类操作、恢复要唤醒 DO，都不必每分钟做。
 * 用进程内时间戳节流到 10 分钟一次。
 */
function shouldPrune(ctx: PluginContext<AgentConfig>, now = Date.now()): boolean {
  return now - pruneThrottle.at > PRUNE_INTERVAL_MS
}

/** 进程内节流状态。isolate 被回收后重置，最多多做一次清理，无害 */
const pruneThrottle = { at: 0 }

/**
 * 到期的定时任务：用保存的 prompt 重新跑一轮 agent。
 *
 * ## 关键：**提交即推进**
 *
 * `submit()` 一返回，这条提醒的责任就已经交给 DO 的队列了（入队失败会抛）。
 * 所以立刻推进 `due_at` / 标 `done`，而不是等「跑成功」。
 *
 * 以前是「跑成功才推进」，会造成同一条提醒执行两遍：
 * - 会话正忙 → 没抢到执行权，run 进了队列，`due_at` 不动 → 下一分钟 cron 又 submit 一份；
 * - 可重试失败 → `executeRun` 内部 `retryLater()` 把 run 退回队列，`due_at` 还不动 → 同样重复。
 *
 * 推进失败（D1 抖动）时抛出去，让 cron 记录失败——宁可下一分钟重来，也不要静默吞掉。
 */
async function fireDueSchedules(
  ctx: PluginContext<AgentConfig>,
  startedAt: number,
): Promise<void> {
  if (!ctx.config.enable_schedule) return

  const llm = tryLLM(ctx)
  if (!llm) return
  const due = await listDueSchedules(ctx.db, Date.now(), 3)
  if (due.length === 0) return

  for (const schedule of due) {
    if (Date.now() - startedAt > CRON_BUDGET_MS) {
      ctx.logger.warn('cron 超出预算，剩余定时任务留待下一轮', { scheduleId: schedule.id })
      return
    }

    const message: InboundMessage = {
      conversation: schedule.conversation,
      // 定时任务由系统发起，不是「那个人正在说话」：用 `scheduler` 这个保留身份，
      // 权限层把它判成 owner 级（见 permissions/default-policy.ts）。
      // 以前传的是 created_by，但没带 memberRole → 角色 unknown → 只有 level 1，
      // 于是管理员建的、需要 http.request/schedule.* 的提醒到点会被自己拦下。
      userId: 'scheduler',
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

    // 先入队：入队失败会抛，那就**不**推进，交给下一轮
    const claimed = await stub.submit(message)
    await advanceSchedule(ctx.db, schedule, Date.now())

    // 抢到执行权就当场跑（用户希望提醒准时到），没抢到就交给 DO 的队列，
    // 由 release() 链或 10 分钟一次的 sweep 兜底。
    if (claimed.acquired && claimed.runId) {
      await executeRun(
        { ctx, logger: ctx.logger, config: ctx.config, llm, agent: stub, reply },
        claimed.runId,
        message,
      )
    } else {
      ctx.logger.info('定时任务已入队，等队列执行', { scheduleId: schedule.id })
    }
  }
}

/** 清理 D1 里的工具审计。只在开了审计时才需要 */
async function maybePruneAudit(ctx: PluginContext<AgentConfig>, now: number): Promise<void> {
  if (!ctx.config.enable_audit) return

  const removed = await pruneToolAudit(ctx.db, now - AUDIT_RETENTION_MS)
  if (removed > 0) ctx.logger.info('清理过期审计', { removed })
}

// ---------------------------------------------------------------- 工具函数

type AgentStub = {
  submit(message: InboundMessage): Promise<{ acquired: boolean; runId?: string; message?: InboundMessage; retryAfterMs?: number }>
  history(limit: number): Promise<HistoryRow[]>
  release(runId: string, result: { ok: boolean; error?: string; history?: HistoryRow[] }): Promise<void>
  retryLater(runId: string, reason: string): Promise<void>
  reset(): Promise<void>
  /** 一次 RPC 同时做「认领滞留 run」与「清理终态 run」，cron 的 10 分钟清理轮用 */
  sweep(olderThanMs: number): Promise<{
    claimed: { acquired: boolean; runId?: string; message?: InboundMessage; retryAfterMs?: number }
    pruned: number
  }>
}

/**
 * 取会话的 DO stub。
 *
 * **不再顺带记录会话列表**：上一版每次调用都读一次 KV、必要时再写一次。
 * cron 里每个会话每分钟调一次，就是每分钟 N 次 KV 读——免费版 KV 只有
 * 10 万读/日、1,000 写/日，这么用很快打满。
 *
 * 现在由 `rememberConversation()` 在**收到消息时**记一次（低频、有去重）。
 */
function agentStub(
  ctx: PluginContext<AgentConfig>,
  conversation: string,
): DurableObjectStub<Agent> {
  return ctx.durable.get<Agent>('Agent', conversation)
}

/**
 * 记住一个会话，供 cron 兜底时遍历。
 *
 * 只在收到消息时调用（不是每次取 stub 时），且列表里有就不写。
 * KV 写额度免费版只有 1,000 次/日，所以这个函数必须便宜：
 * 一次读 + 条件写。
 */
async function rememberConversation(
  ctx: PluginContext<AgentConfig>,
  conversation: string,
): Promise<void> {
  try {
    const list = (await ctx.kv.getJSON<string[]>('conversations')) ?? []
    if (list.includes(conversation)) return
    // 列表上限压到 20：这个列表唯一的用途是「cron 的 10 分钟清理轮要扫哪些会话的 DO」，
    // 而每次扫都是 DO 唤醒（按 GB-秒计费）。100 个会话 = 每天 14,400 次唤醒，
    // 正好是 README 里说要消灭的那种空转。个人机器人 20 个会话足够；
    // 被挤掉的会话下次真有消息进来会重新记到列表末尾。
    const next = [...list, conversation].slice(-MAX_TRACKED_CONVERSATIONS)
    await ctx.kv.put('conversations', JSON.stringify(next))
  } catch {
    // 记录失败不影响对话
  }
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

/** 把时间戳格式化成配置时区的短格式。时区写错时退回 ISO */
function formatScheduleTime(epochMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(epochMs))
  } catch {
    return new Date(epochMs).toISOString()
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
