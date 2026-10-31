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
import { executeRun, replyFromSession, type ReplyFn, type RunDeps } from './agent/run.js'
import { conversationKey, isTextMessage, toInboundMessage } from './agent/inbound.js'
import { decideWake } from './agent/wake.js'
import { summarizeForConversation } from './agent/summarize.js'
import { resolveConfig } from './effective-config.js'
import { getPersonaBinding, setPersonaBinding } from './persona.js'
import { hydrateImageAttachments } from './agent/media.js'
import { withMention, type MentionMode } from './agent/mention.js'
import { BLOCKED_REPLY, checkContent, parseKeywords } from './agent/safety.js'
import { SCHEMA_STATEMENTS } from './store/schema.js'
import { ensureColumnMigrations } from './store/migrate.js'
import {
  advanceSchedule,
  cancelSchedule,
  listDueSchedules,
  listDailyStats,
  listSchedules,
  pruneToolAudit,
} from './store/d1.js'
import { createPageRoutes } from './routes.js'
import {
  listAllFragments,
  removeFragment,
  setFragmentEnabled,
  upsertFragment,
} from './prompt-fragments.js'
import {
  listAllPluginTools,
  pluginToolFullName,
  removePluginTool,
  upsertPluginTool,
  type PluginToolRegistration,
} from './plugin-tools.js'
import type { AgentService } from './agent-service.js'
import { getSkill, listSkills } from './skills/store.js'

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

  /**
   * 对外提供服务：别的插件可以往本插件的 system prompt 里插一段话。
   *
   * 对标 AstrBot 的 `OnLLMRequestEvent`（插件能改每次 LLM 请求），
   * 但 QFlareBot 没有钩子机制，只能用 `services` + `ctx.service('agent')`。
   *
   * 用法（在**调用方**插件里）：
   *
   * ```ts
   * // 1. manifest 里声明依赖：depends: { agent: 'optional' }
   * // 2. 处理器里：
   * try {
   *   const agent = ctx.service<AgentPromptService>('agent')
   *   await agent.registerPrompt(ctx.plugin.name, '回答时优先用中文，不要用表情符号。')
   * } catch {
   *   // 没装 / 停用了 Agent 插件，按没有处理
   * }
   * ```
   *
   * **为什么 register 是写库而不是内存**：宿主对 `services` 的约定是
   * 「工厂每个请求调用一次」，内存里登记的活不过本次请求（SDK 注释明确写了）。
   *
   * 片段拼在 system prompt 末尾（稳定内容，不破坏缓存），
   * 有长度上限与去重，细节见 `src/prompt-fragments.ts`。
   */
  services: {
    agent: (ctx): AgentService => ({
      // ---- 提示词扩展 ----
      async registerPrompt(plugin, fragment, priority) {
        return upsertFragment(ctx.db, { plugin, fragment, priority })
      },
      async disablePrompt(plugin) {
        await setFragmentEnabled(ctx.db, plugin, false)
      },
      async clearPrompt(plugin) {
        await removeFragment(ctx.db, plugin)
      },
      async listPrompts() {
        return listAllFragments(ctx.db)
      },

      // ---- 工具扩展 ----
      async registerTool(plugin, tool) {
        await upsertPluginTool(ctx.db, plugin, tool)
      },
      async unregisterTool(plugin, fullNameOrName) {
        // 接受短名或全名：提供者手里通常只有短名
        const fullName = fullNameOrName.includes('.')
          ? fullNameOrName
          : pluginToolFullName(plugin, fullNameOrName)
        await removePluginTool(ctx.db, fullName)
      },
      async listTools() {
        return listAllPluginTools(ctx.db)
      },
    }),
  },

  hooks: {
    async onInstall(ctx) {
      await ensureSchema(ctx)
    },
    /**
     * 升级路径的建表兜底。
     *
     * `onInstall` 只在**首次安装**时跑（框架用 KV 里一个 marker 记住「装过了」），
     * 所以插件升级后新增的表不会自动创建——用到时才炸 `no such table`。
     * 本插件就踩过：v0.1.0 升上来新增了 `{conversations}`，`/agent persona` 直接报
     * `D1_ERROR: no such table: p_agent_conversations`。
     *
     * 全部语句都是 `IF NOT EXISTS`，所以这里每次冷启动跑一遍是安全的；
     * 但 D1 的 exec 也算一次查询，所以用一个进程内标记只跑一次（isolate 回收后重跑，无害）。
     */
    async onBoot(ctx) {
      await ensureSchema(ctx)
    },
  },

  commands: {
    ask: {
      description: '问 Agent 一个问题',
      usage: '/ask <问题>',
      async handler({ session, ctx, argText }) {
        if (!argText.trim()) return '用法：/ask <你的问题>'
        await handleMessage(session, ctx, argText)
        return undefined
      },
    },

    reset: {
      description: '清空当前会话的记忆',
      // **破坏性操作，必须有门槛**：不声明就是 `member`，群里任何人
      // 都能把整个群的记忆清掉。清空是单会话范围内不可逆的。
      permission: 'group_admin',
      async handler({ session, ctx }) {
        const cfg = await resolveConfig(ctx)
        const stub = agentStub(ctx, conversationKey(session, cfg.isolate_sessions))
        await stub.reset()
        return '这个会话的记忆已经清空了。'
      },
    },

    /**
     * 只打断当前这次回答，**不清记忆**。
     *
     * 对标 AstrBot 的 `/stop`（`conversation.py` 的 `stop()` 走
     * `active_event_registry.stop_all()`）。它和 `/agent reset` 是两件事：
     * - 用户说「别说了」→ `/agent stop`，记忆还在
     * - 用户说「忘掉之前聊的」→ `/agent reset`，清历史
     *
     * 之前只有 reset，用户想打断一句回答只能连记忆一起丢掉。
     */
    stop: {
      aliases: ['停', '别说了'],
      description: '打断正在进行的回答（保留记忆）',
      async handler({ session, ctx }) {
        const cfg = await resolveConfig(ctx)
        const stub = agentStub(ctx, conversationKey(session, cfg.isolate_sessions))
        const result = await stub.stop()
        return result.stopped
          ? '好，这次回答停下了。之前的对话记忆还在。'
          : '现在没有正在进行的回答。'
      },
    },

    /**
     * 开一段新对话：清空历史，但**不中断**正在跑的回答。
     *
     * 与 reset 的区别和 AstrBot 一致（`/new` vs `/reset`）：
     * - `reset` 会先打断再清（因为正在跑的回答还在往旧历史里写，不清干净会串味）
     * - `new` 是「这轮答完，下一句重新开始」——对用户来说更温和
     *
     * 实现上两者都落到 DO 的 reset：历史只有一份，区别在语义与提示语。
     * 如果正在跑，reset 会打断它 —— 这是必要的，否则那次回答的产物
     * 会写进「已经清空」的历史里，用户会看到记忆又冒出来。
     */
    new: {
      aliases: ['新对话'],
      description: '开始新对话（清空本次记忆）',
      // 和 reset 同档：清空是单会话范围内不可逆的
      permission: 'group_admin',
      async handler({ session, ctx }) {
        const cfg = await resolveConfig(ctx)
        const stub = agentStub(ctx, conversationKey(session, cfg.isolate_sessions))
        await stub.reset()
        return '好，重新开始。之前的对话我已经不记得了。'
      },
    },

    /**
     * 看这个会话的规模与额度使用情况。
     *
     * 对标 AstrBot 的 `/stats`（它报 token 用量）。这里报的是**我们真有的数据**：
     * 历史条数、排队数、是否在跑，以及今天的全局用量。
     *
     * AstrBot 的 token 统计来自 `ProviderStat` 表（按 conversation 聚合）；
     * 我们的 token 记在 `{daily_stats}` 里但是**全局按天**的，
     * 没有按会话分——所以这里分开报：会话维度报条数，全局维度报 token，
     * 而不是假装能给出「本会话的 token」。
     */
    stats: {
      aliases: ['用量'],
      description: '查看本会话的记忆规模与今日用量',
      async handler({ session, ctx }) {
        const cfgForKey = await resolveConfig(ctx)
        const conversation = conversationKey(session, cfgForKey.isolate_sessions)
        const stub = agentStub(ctx, conversation)
        const [size, recent] = await Promise.all([
          stub.stats().catch(() => ({ history: 0, pending: 0, locked: false })),
          listDailyStats(ctx.db, 1).catch(() => []),
        ])
        // listDailyStats 按 day 倒序，第一条就是今天（如果今天有记录）
        const today = recent[0]

        const lines = [
          '本会话：',
          `- 记忆：${size.history} 条`,
          `- 排队中：${size.pending} 条`,
          `- 正在回答：${size.locked ? '是' : '否'}`,
        ]
        if (today) {
          lines.push(
            '',
            '今天（所有会话合计）：',
            `- 回答次数：${today.runs}`,
            `- 工具调用：${today.tool_calls}`,
            `- 输入 token：${today.input_tokens}`,
            `- 输出 token：${today.output_tokens}`,
          )
        } else {
          lines.push('', '今天还没有用量记录。')
        }
        return lines.join('\n')
      },
    },

    /**
     * 列出所有可用命令。
     *
     * 对标 AstrBot 的 `/help`。它那边会从**实时指令配置**生成清单
     * （支持重命名、禁用、子命令分组），我们这边没有指令管理，
     * 所以是手写清单 —— 但**自带一致性检查测试**：
     * `commands.test.ts` 会比对这里列出的每一项和实际注册的命令，
     * 少一个、多一个都会失败。这样「加了命令忘了更新帮助」不会发生。
     */
    help: {
      aliases: ['帮助', '菜单'],
      description: '列出所有可用命令',
      async handler({ ctx }) {
        const cfg = await resolveConfig(ctx)
        // 只在真有技能时列出技能命令，避免列出一个「现在用不了」的入口。
        // 技能存在 D1（页面里加的），不在插件配置里 —— 读到失败就当作没有。
        const skillCount = cfg.enable_skills
          ? (await listSkills(ctx.db).catch(() => [])).length
          : 0
        const hasSkills = skillCount > 0
        const lines = [
          'Agent 命令：',
          '/ask <问题> — 问 Agent 一个问题',
          '/reset — 清空本会话记忆（群管理员）',
          '/new — 开始新对话（群管理员）',
          '/stop — 打断正在进行的回答',
          '/stats — 查看记忆规模与今日用量',
          '/schedule [cancel <id>] — 查看/取消定时任务',
          '/persona [名字|off] — 查看/切换人格（群管理员）',
          '/status — 查看模型与工具状态',
          '/help — 就是这张清单',
        ]
        if (hasSkills) {
          lines.push('/skill [<id> [任务]] — 查看或激活技能')
        }
        lines.push('', '中文别名也认：/停、/帮助、/用量、/新对话、/菜单。')
        return lines.join('\n')
      },
    },

    schedule: {
      description: '查看本会话的定时任务',
      usage: '/schedule [cancel <id>]',
      async handler({ session, ctx, argText }) {
        const cfgForKey = await resolveConfig(ctx)
        const conversation = conversationKey(session, cfgForKey.isolate_sessions)
        const arg = argText.trim()

        // /schedule cancel <id>
        if (arg.startsWith('cancel ')) {
          const id = arg.slice('cancel '.length).trim()
          if (!id) return '用法：/schedule cancel <任务 id>'
          const cancelled = await cancelSchedule(ctx.db, id, conversation)
          return cancelled ? `已取消任务 ${id}。` : '没有找到这个任务，或者它不在本会话。'
        }

        const rows = await listSchedules(ctx.db, conversation, 20)
        if (rows.length === 0) return '本会话没有待触发的定时任务。'
        const cfg = await resolveConfig(ctx)

        const lines = rows.map((row) => {
          const when = formatScheduleTime(row.due_at, cfg.timezone)
          const repeat = row.repeat_seconds
            ? `（每 ${Math.round(row.repeat_seconds / 60)} 分钟重复）`
            : '（一次性）'
          return `${when}${repeat}：${row.prompt}\n  id: ${row.id}`
        })
        return ['本会话的定时任务：', ...lines, '', '取消用 /schedule cancel <id>'].join('\n')
      },
    },

    persona: {
      // 人格是**整群共享**的（绑定在 conversation 上），改它会影响群里所有人，
      // 所以和 reset 一样限群管理员。查询（不带参数）其实人人无害，
      // 但一条命令只有一个门槛，用「能改」的那档更安全。
      permission: 'group_admin',
      description: '查看或切换本会话的人格',
      usage: '/persona [名字]',
      async handler({ session, ctx, argText }) {
        const cfgForKey = await resolveConfig(ctx)
        const conversation = conversationKey(session, cfgForKey.isolate_sessions)
        const wanted = argText.trim()
        const cfg = await resolveConfig(ctx)
        const available = (cfg.personas ?? []).map((p) => p.name.trim()).filter(Boolean)

        // 不带参数：显示当前绑定与可选列表
        if (!wanted) {
          const bound = await getPersonaBinding(ctx.db, conversation).catch(() => undefined)
          const active = bound ?? cfg.default_persona ?? '(未设置，用系统提示词)'
          return [
            `当前人格：${active}`,
            available.length ? `可选：${available.join('、')}` : '还没有配置任何人格（插件设置 → 人格）',
            '',
            '切换用 /persona <名字>，清除用 /persona off',
          ].join('\n')
        }

        // off / 清除：解绑，回落默认人格
        if (wanted === 'off' || wanted === 'none' || wanted === '清除') {
          await setPersonaBinding(ctx.db, conversation, undefined)
          return cfg.default_persona
            ? `已清除本会话的人格绑定，回到默认人格「${cfg.default_persona}」。`
            : '已清除本会话的人格绑定，改用系统提示词。'
        }

        if (!available.includes(wanted)) {
          return available.length
            ? `没有名为「${wanted}」的人格。可选：${available.join('、')}`
            : '还没有配置任何人格，请先在插件设置里添加。'
        }

        await setPersonaBinding(ctx.db, conversation, wanted)
        return `本会话的人格已切换为「${wanted}」。`
      },
    },

    status: {
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
        const cfg = await resolveConfig(ctx)
        const changed = cfg.model !== ctx.config.model ? `（页面已改；配置里是 ${ctx.config.model}）` : ''
        const lines = [
          `模型别名：${cfg.model}${changed}`,
          !llm
            ? 'LLM 接口插件未启用——请在面板的插件页启用或安装它'
            : models.length
              ? `可用别名：${models.join('、')}`
              : `别名列表读取失败${error ? `：${error}` : ''}`,
          `工具调用：${cfg.enable_tools ? '开' : '关'}`,
          `步数上限：${cfg.max_model_steps}`,
        ]
        return lines.join('\n')
      },
    },

    /**
     * 技能：列目录 / 查看 / 激活。
     *
     * **激活的实际作用点不在这里**：真正的注入发生在 `runLoopOnce` 里，
     * 它读原始消息文本、匹配 `/skill <id> <任务>`，然后把技能正文塞进系统提示词。
     * 这条命令负责「列」和「看」，以及在不带任务时给出用法提示——
     * 因为走命令路径时那句话不会再进模型，光靠 runLoopOnce 是触发不到的。
     */
    skill: {
      description: '查看可用技能，或激活一个技能',
      usage: '/skill [<id> [任务]]',
      async handler({ ctx, argText }) {
        if (!(await resolveConfig(ctx)).enable_skills) {
          return '技能功能没开。请先在插件配置里打开「启用技能」。'
        }
        const arg = argText.trim()

        // 不带参数：列目录（与注入给模型的目录同源）
        if (!arg) {
          const skills = await listSkills(ctx.db).catch(() => [])
          if (skills.length === 0) return '还没有配置任何技能。可以在插件页面里添加。'
          return [
            '可用技能：',
            ...skills.map((skill) => `- ${skill.id}: ${skill.description}`),
            '',
            '激活：/skill <id> <任务>',
          ].join('\n')
        }

        // 带 id 但没有任务：只展示这份技能的说明，不激活
        const [id, ...rest] = arg.split(/\s+/)
        const task = rest.join(' ').trim()
        try {
          const skill = await getSkill(ctx.db, id ?? '')
          if (!skill) return `没有找到技能「${id}」。`
          if (!task) {
            return [
              `技能：${skill.metadata.name}（${skill.id}）`,
              skill.metadata.description,
              '',
              '用它：/skill ' + skill.id + ' <你的任务>',
            ].join('\n')
          }
          // 带任务：提示用户改用聊天路径（那里才会真正注入正文）
          return `请直接发：/@我 /skill ${skill.id} ${task}`
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    },
  },

  /**
   * 聊天入口：**没命中指令的消息就该走 Agent**（对标 AstrBot 的 waking check）。
   *
   * 这里订阅三种消息事件，由 `decideWake` 统一判定：
   * - `qq.group.at_message`：群里 @ 了机器人（平台只在 @ 时才推）
   * - `qq.group.message`：群全量消息（**需要群主在 QQ 里给机器人开启「接收全部消息」**，
   *   否则收不到；开了之后群里非 @ 消息才会到达插件（由 decideWake 再判一次））
   * - `qq.c2c.message`：私聊
   *
   * 命令（`/agent …`）默认 `block: true`，命中并返回后不会再走到这些事件——
   * 所以「命中指令」和「聊天」天然互斥，不会同一句话既执行指令又调模型。
   */
  events: {
    'qq.group.at_message': onChatMessage,
    'qq.group.message': onChatMessage,
    'qq.c2c.message': onChatMessage,
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
        const cfg = await resolveConfig(ctx)

        const hasDueSchedule = cfg.enable_schedule
          ? (await listDueSchedules(ctx.db, Date.now(), 1)).length > 0
          : false

        if (hasDueSchedule) await fireDueSchedules(ctx, startedAt, cfg)

        const now = Date.now()
        // 节流决策只做一次，然后**显式传下去**：
        // 以前是先置 `pruneThrottle.at = now` 再让 maybePruneAudit 自己重判 `shouldPrune`，
        // 于是第二次判断永远为假，审计清理一次都没跑过（{tool_audit} 无限增长）。
        if (!shouldPrune(ctx, now)) return
        pruneThrottle.at = now

        await maybePruneAudit(ctx, now, cfg)
        await serviceConversationObjects(ctx, startedAt)
      },
    },
  },

  routes: createPageRoutes(),
})

/**
 * 建表 + 补列。重复执行安全（onInstall 与 onBoot 共用）。
 *
 * 两步分工：
 * - `SCHEMA_STATEMENTS` 全是 `CREATE TABLE IF NOT EXISTS`，**只能建缺失的表**。
 *   老库里表已经存在时会整条跳过，于是后来新增的**列**永远建不出来
 *   （典型后果：老部署升级后 `{tool_settings}` 缺 `config_json`，保存搜索 Key 直接 500）。
 * - `ensureColumnMigrations` 负责那些列：`SELECT <col> … LIMIT 0` 探测 + `ALTER TABLE ADD COLUMN`。
 *   不能用 `PRAGMA table_info` —— 框架的 sqlScope 把 PRAGMA 列为 BANNED，插件执行会直接抛错。
 */
let schemaReady = false
async function ensureSchema(ctx: PluginContext<AgentConfig>): Promise<void> {
  if (schemaReady) return
  for (const statement of SCHEMA_STATEMENTS) {
    await ctx.db.exec(statement)
  }
  await ensureColumnMigrations(ctx.db, ctx.logger)
  schemaReady = true
}

// ---------------------------------------------------------------- 消息处理

/**
 * 聊天消息入口：判定该不该唤醒，唤醒则进 Agent。
 *
 * 与 AstrBot 的对应关系见 `src/agent/wake.ts` 的注释。这里只做三件事：
 * 判定 → 剥前缀 → 交给 handleMessage。
 */
async function onChatMessage({
  session,
  ctx,
}: {
  session: Session
  ctx: PluginContext<AgentConfig>
}): Promise<void> {
  const config = await resolveConfig(ctx)
  const decision = decideWake(session, config)
  if (!decision.wake) {
    // not-mentioned 是常态（群全量消息里绝大多数没 @ 机器人），不打日志免得刷屏
    if (decision.reason !== 'not-mentioned' && decision.reason !== 'command') {
      ctx.logger.debug('消息不唤醒 Agent', { reason: decision.reason, scene: session.scene })
    }
    return
  }
  if (!isTextMessage(session) && decision.text.trim().length === 0) return

  ctx.logger.debug('唤醒 Agent', { reason: decision.reason, scene: session.scene })

  // 唤醒前缀已经剥掉（例如「/你好」→「你好」），不能再让 handleMessage 去猜
  await handleMessage(session, ctx, decision.text, config)
}

/**
 * 入站守卫：内容安全 + 依赖可用性。
 *
 * 抽出来是因为这两件事都属于「这条消息该不该继续处理」，
 * 和后面「怎么把它跑完」是两回事。混在一个 130 行的函数里时，
 * 改动投递逻辑得先读完整段守卫才敢动手。
 *
 * 返回 false = 已经处理完（拒绝并回复了），调用方直接 return。
 */
async function admitInbound(
  session: Session,
  ctx: PluginContext<AgentConfig>,
  config: AgentConfig,
  text: string,
): Promise<boolean> {
  const logger = ctx.logger

  // 内容安全（入站）。放在最前面：命中的消息不该花掉一次 LLM 调用，
  // 也不该进队列占住会话。对标 AstrBot 的 ContentSafetyCheckStage。
  // 这是**零成本**护栏：纯文本匹配，没有额外请求、没有额外存储。
  const keywords = parseKeywords(config.content_filter_keywords)
  if (keywords.length > 0) {
    const check = checkContent(text, keywords)
    if (check.blocked) {
      logger.warn('入站内容命中安全关键词，已拒绝', {
        conversation: conversationKey(session),
        // 日志里记命中的词便于运维排查，但不回给用户（否则等于交出规则）
        matched: check.matched,
      })
      await session.reply(BLOCKED_REPLY).catch(() => false)
      return false
    }
  }
  return true
}

/**
 * 解析 llm 服务。取不到时给用户一句能看懂的话，并返回 null。
 *
 * 不能让它抛：`ctx.service()` 在提供者被停用/卸载时抛错，直接抛就变成
 * 「用户发了消息、什么都没收到」。
 */
async function resolveLlmOrExplain(
  session: Session,
  ctx: PluginContext<AgentConfig>,
): Promise<LLMService | null> {
  try {
    return ctx.service<LLMService>('llm')
  } catch {
    await session
      .reply('Agent 需要的「LLM 接口」插件没有启用。请在面板的插件页启用它，或者先安装。')
      .catch(() => false)
    ctx.logger.error('llm 服务不可用，无法处理消息', {
      conversation: conversationKey(session),
    })
    return null
  }
}

/**
 * 把 QQ 的入站消息准备成内部形状。
 *
 * 图片必须**在入站时**取回来：QQ 的图片 URL 带签名且有效期很短，
 * 等 cron 段（最坏 5 分钟后）再取可能已经 403。
 */
async function prepareInbound(
  session: Session,
  text: string,
  isolateSessions = false,
): Promise<InboundMessage> {
  const message = toInboundMessage(session, isolateSessions)

  // 事件里拿到的正文可能带 /agent 前缀，剥掉
  const cleaned = text.replace(/^\/agent\s*/i, '').trim()
  if (cleaned) message.text = cleaned

  // 取不到图片就把说明拼进正文，别让整条消息失败
  if (message.attachments.some((a) => a.type === 'image')) {
    const hydrated = await hydrateImageAttachments(message.attachments)
    message.attachments = hydrated.attachments
    if (hydrated.notes.length) {
      message.text = `${message.text}\n\n（${hydrated.notes.join('；')}）`.trim()
      message.displayText = message.text
    }
  }
  return message
}

/**
 * 聊天消息入口。
 *
 * 只做编排，三块细节各自独立（见上面的函数）：
 * 守卫 → 准备消息 → 投递到队列并尽量当场跑完。
 */
async function handleMessage(
  session: Session,
  ctx: PluginContext<AgentConfig>,
  text: string,
  resolvedConfig?: AgentConfig,
): Promise<void> {
  const logger = ctx.logger
  const config = resolvedConfig ?? (await resolveConfig(ctx))

  if (!(await admitInbound(session, ctx, config, text))) return

  const llm = await resolveLlmOrExplain(session, ctx)
  if (!llm) return

  const message = await prepareInbound(session, text, config.isolate_sessions)
  const stub = agentStub(ctx, message.conversation)
  const reply = replyFromSession(session)

  // 记住这个会话，cron 兜底时要遍历。只在收到消息时记，不是每次取 stub 时记
  await rememberConversation(ctx, message.conversation)

  // 单聊先给个"正在输入"，缓解等待焦虑
  if (config.show_typing && session.scene === 'c2c') {
    void session.typing(10).catch(() => false)
  }

  const claimed = await stub.submit(message, {
    perMinute: config.rate_limit_per_minute,
  })

  // 被频率限制：明确告知用户，而不是静默丢弃。
  //
  // AstrBot 的默认策略是 `stall`（await sleep 等窗口过去），那在 Worker 里会吃光
  // 30 秒事件预算然后**用户什么都收不到** —— 比拒绝回复更糟。所以这里只用
  // 「回一句然后放弃」这一种策略。
  if (claimed.rateLimited) {
    const seconds = Math.max(1, Math.ceil(claimed.rateLimited.retryAfterMs / 1000))
    logger.info('触发频率限制，已拒绝', {
      conversation: message.conversation,
      retryAfterMs: claimed.rateLimited.retryAfterMs,
    })
    await reply(`说得有点快，等 ${seconds} 秒再继续吧。`).catch(() => false)
    return
  }

  if (!claimed.acquired || !claimed.runId) {
    // 这个会话已经有人在跑，run 进了队列，**静默排队**。
    //
    // 不要回一句「上一条还在处理」：用户等一会儿自然就收到答复，
    // 中途插一条提示只会刷屏，而且同一会话连发几条时每次都要被敷衍一句。
    // 队列会由当前 run 跑完后 `release()` 链式认领（见 runUntilQueueEmpty），
    // 正常情况延迟只有几秒；执行者被掐断时由 cron 的 10 分钟清理轮兜底。
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
 * 给一个会话补摘要（`summary` 模式，跑在 cron 里）。
 *
 * 没待摘要内容时只是一次存储读就返回——**不是每分钟都调模型**。
 * 真正调模型的频率取决于对话有多长（压缩发生得多频繁），
 * 个人机器人通常一天也就几次。
 */
async function maybeSummarize(
  ctx: PluginContext<AgentConfig>,
  stub: ReturnType<typeof agentStub>,
  config: AgentConfig,
  getLLM: () => LLMService | null,
): Promise<void> {
  try {
    const existing = await stub.summary()
    const llm = getLLM()
    if (!llm) return
    await summarizeForConversation({
      store: stub,
      llm,
      model: config.model,
      logger: ctx.logger,
      existing,
    })
  } catch (error) {
    // 摘要失败不能拖累这个会话的滞留 run 恢复
    ctx.logger.warn('补摘要失败', { error: String(error) })
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

  // 生效配置读一次就够一轮（管理页覆盖是全局的，不是按会话）。
  // 用 resolveConfig 而不是 ctx.config，原因见下面 executeRun 处的注释。
  // 懒加载：如果一个滞留 run 都没有，这次 cron 就不该多读一次 KV。
  let resumeConfig: AgentConfig | null = null

  // 摘要配置也是全局的，同样懒加载：非 summary 模式下这轮 cron 不该多读一次 KV
  let summaryConfig: AgentConfig | null = null
  let summaryConfigChecked = false

  for (const conversation of known) {
    // 超预算就放弃剩下的会话，下一轮 cron 接着来——宁可晚 10 分钟恢复，
    // 也不能把同一个 invocation 里别的插件的定时任务拖到超时
    if (Date.now() - startedAt > CRON_BUDGET_MS) {
      ctx.logger.warn('cron 超出预算，剩余会话留待下一轮', { remaining: known.length - known.indexOf(conversation) })
      return
    }

    try {
      const stub = agentStub(ctx, conversation)

      // 摘要优先于「恢复滞留 run」：摘要是**用户可感知的记忆**，
      // 而滞留 run 通常已经过期（用户多半另发了一条消息）。
      // 只在 summary 模式下发生；其他模式这里只多一次存储读（没有 pending 就返回）。
      if (!summaryConfigChecked) {
        summaryConfigChecked = true
        const cfg: AgentConfig = resumeConfig ?? (await resolveConfig(ctx))
        resumeConfig = cfg
        if (cfg.context_compression === 'summary') summaryConfig = cfg
      }
      if (summaryConfig) {
        await maybeSummarize(ctx, stub, summaryConfig, () => {
          if (!llmChecked) {
            llmChecked = true
            llm = tryLLM(ctx)
          }
          return llm
        })
      }

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
      // @ 的开关在配置里，这里要先拿到（后面 runUntilQueueEmpty 也用它）
      resumeConfig ??= await resolveConfig(ctx)
      const reply = makeApiReply(ctx, message, resumeConfig.reply_mention)
      // **必须用 resolveConfig 而不是 ctx.config**：管理页改的模型/限额/人格
      // 存在 KV 覆盖层里（见 effective-config.ts），`ctx.config` 只是面板配置的
      // 权威默认值。用 ctx.config 会让「被 cron 捡回来的 run」退回旧模型——用户在
      // 页面把模型从 chat 切到别的，正常消息走新模型，恢复的那条却走旧的。
      resumeConfig ??= await resolveConfig(ctx)
      await executeRun(
        { ctx, logger: ctx.logger, config: resumeConfig, llm, agent: stub, reply },
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
  config: AgentConfig,
): Promise<void> {
  if (!config.enable_schedule) return

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
    const reply = makeApiReply(ctx, message, config.reply_mention)

    // 先入队：入队失败会抛，那就**不**推进，交给下一轮
    const claimed = await stub.submit(message)
    await advanceSchedule(ctx.db, schedule, Date.now())

    // 抢到执行权就当场跑（用户希望提醒准时到），没抢到就交给 DO 的队列，
    // 由 release() 链或 10 分钟一次的 sweep 兜底。
    if (claimed.acquired && claimed.runId) {
      await executeRun(
        { ctx, logger: ctx.logger, config, llm, agent: stub, reply },
        claimed.runId,
        message,
      )
    } else {
      ctx.logger.info('定时任务已入队，等队列执行', { scheduleId: schedule.id })
    }
  }
}

/** 清理 D1 里的工具审计。只在开了审计时才需要 */
async function maybePruneAudit(
  ctx: PluginContext<AgentConfig>,
  now: number,
  config: AgentConfig,
): Promise<void> {
  if (!config.enable_audit) return

  const removed = await pruneToolAudit(ctx.db, now - AUDIT_RETENTION_MS)
  if (removed > 0) ctx.logger.info('清理过期审计', { removed })
}

// ---------------------------------------------------------------- 工具函数

type AgentStub = {
  submit(
    message: InboundMessage,
    rateLimit?: { perMinute: number },
  ): Promise<{
    acquired: boolean
    runId?: string
    message?: InboundMessage
    retryAfterMs?: number
    rateLimited?: { retryAfterMs: number }
  }>
  history(limit: number): Promise<HistoryRow[]>
  release(runId: string, result: { ok: boolean; error?: string; history?: HistoryRow[] }): Promise<void>
  retryLater(runId: string, reason: string): Promise<void>
  reset(): Promise<void>
  /** 只打断正在跑的 run，不清历史（/stop 用） */
  stop(): Promise<{ stopped: boolean }>
  /** 会话规模：历史条数、队列长度、是否正在跑（/stats 与状态查看用） */
  stats(): Promise<{ history: number; pending: number; locked: boolean }>
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
  /** @ 说话人的模式（配置项 reply_mention） */
  mentionMode: MentionMode = 'off',
): ReplyFn {
  const target = { scene: message.scene, id: message.targetId } as Parameters<
    typeof ctx.api.sendMessage
  >[0]

  // 一次 run 里回复可能被拆成多条（媒体 + 文本），msg_seq 必须递增，
  // 否则平台会把后一条当成重复消息丢掉
  let seq = 2
  const nextOptions = () =>
    message.passiveMessageId ? { messageId: message.passiveMessageId, msgSeq: seq++ } : {}

  const reply = (async (text: string) => {
    // @ 只加在**文本**回复上：媒体消息带 @ 会变成独立一行，看着很怪
    const withAt = withMention(text, message.userId, message.scene, mentionMode)
    const result = await ctx.api.sendMessage(target, { text: withAt }, nextOptions())
    if (!result.ok) {
      ctx.logger.warn('主动回复失败', { conversation: message.conversation, error: result.error })
    }
    return result.ok
  }) as ReplyFn

  reply.media = async (item: import('./tools/types.js').OutboundMedia) => {
    // 拆成平台认识的形状：图片用 `image` 简写，其余走 `media`
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

    const result = await ctx.api.sendMessage(target, payload, nextOptions())
    if (!result.ok) {
      // 媒体发送失败（URL 过期、格式不支持、超限）是常见情况，
      // 退化成把链接放进正文，至少用户还能自己点开
      ctx.logger.warn('媒体回复失败', {
        conversation: message.conversation,
        type: item.type,
        error: result.error,
      })
      if (item.url) return reply(`${item.caption ?? ''} ${item.url}`.trim() || item.url)
    }
    return result.ok
  }

  return reply
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
