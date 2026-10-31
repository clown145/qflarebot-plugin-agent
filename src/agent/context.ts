/**
 * 上下文装配：会话历史 + 系统提示词 + 本轮输入 → 模型消息数组。
 *
 * 照搬 serverless-agent 的 `src/core/agent-context.ts`（171 行，零存储耦合），
 * 但砍掉了它那套 skill 机制（`src/skills/` 721 行）——QFlareBot 的"插件"是部署单元，
 * 没有"模型在运行时改写工作区文档"这个概念，语义对不上。
 *
 * 保留的核心是**历史回放的两个细节**，这两点漏了会明显影响体验：
 * 1. 历史里的 assistant 消息如果带工具调用，必须连 tool_calls 一起回放，
 *    否则模型看到自己"说过"工具结果却没有调用记录，会困惑。
 * 2. 当前这条用户消息不能重复——历史里已经有它了。
 */
import type { HistoryRow } from '../do/agent-object.js'
import type {
  HistoryToolTrace,
  InboundMessage,
  ModelContent,
  ModelContentPart,
  ModelMessage,
} from '../types.js'
import { DEFAULT_SYSTEM_PROMPT } from '../config/index.js'
import type { BeginDialogTurn } from '../persona.js'
import { fixMessages, summaryMessages, type StoredSummary } from './context-size.js'
import { buildActiveSkillPrompt, buildSkillCatalogPrompt } from '../skills/context.js'
import type { LoadedSkill, SkillCatalogItem } from '../skills/store.js'

export interface ContextOptions {
  systemPrompt?: string
  /**
   * 人格提示词。**追加**到系统提示词之后、运行时环境之前（对标 AstrBot 的
   * `# Persona Instructions` 段落）。不传 = 没有生效人格。
   */
  personaPrompt?: string
  /** 本轮给模型开放了哪些工具（只用于拼「工具使用规范」，见 TOOL_USE_GUIDE） */
  toolNames?: string[]
  /**
   * 是否把说话人的 openid 告诉模型（配置项 `expose_sender_id`）。
   *
   * 单独一个选项而不是整包传配置：这块只关心「给不给身份」和「给不给时间」，
   * 传整个 AgentConfig 会让这个纯函数依赖配置结构，测试也得造一大堆无关字段。
   */
  exposeSenderId?: boolean
  /** 是否把当前时间告诉模型（配置项 `expose_datetime`） */
  exposeDatetime?: boolean
  /**
   * 其他插件注册的提示词片段（`ctx.service('agent').registerPrompt`）。
   *
   * 拼在 system prompt **末尾**：属于稳定内容的一部分，只要插件不改它，
   * 前缀缓存就是稳的。注意这是纯文本，不做模板替换（见 prompt-fragments.ts）。
   */
  pluginPrompts?: string[]
  timezone: string
  /** 历史条数上限 */
  historyLimit: number
  /**
   * 会话摘要（`summary` 压缩模式）。
   *
   * 插在历史**之前**、人格开场白**之后**：它重述的是更早的对话，
   * 逻辑上早于还在历史里的那几轮。没有摘要时不传。
   */
  summary?: StoredSummary
  /** 模型是否支持图片输入 */
  supportsVision: boolean
  /**
   * 人格的开场对话（AstrBot 的 begin_dialogs）。
   *
   * 插在**历史之前**（与 AstrBot 的 `req.contexts[:0] = begin_dialogs` 一致），
   * 每轮都会带上：它的作用不是记忆，而是给模型看「这个角色平时怎么说话」。
   */
  beginDialogs?: BeginDialogTurn[]
  /**
   * 技能目录：**每轮都带**，只含 id 与一句话描述（≤40 行）。
   *
   * 这是「渐进披露」便宜的那一半：固定的小开销换来模型知道自己有哪些能力，
   * 而不必把每份技能正文都塞进上下文。
   */
  skillCatalog?: SkillCatalogItem[]
  /**
   * 激活的技能全文：**只在用户显式 `/skill` 时注入**。
   *
   * 这是贵的那一半 —— 一份技能正文可能几千 token，所以「用到才付」。
   * 一轮最多激活一个技能。
   */
  activeSkill?: LoadedSkill
}

export function buildMessages(
  message: InboundMessage,
  history: HistoryRow[],
  options: ContextOptions,
): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(
        options.systemPrompt,
        options.toolNames,
        options.personaPrompt,
        options.pluginPrompts,
      ),
    },
  ]

  // 开场对话：插在历史最前，每轮都带（锚定说话风格，不属于会话记忆）
  for (const turn of options.beginDialogs ?? []) {
    messages.push({ role: turn.role, content: turn.content })
  }

  // 技能：目录每轮都带，正文只在激活时带。**分开注入就是这一整套设计的意义所在** ——
  // 目录是固定的小开销（≤40 行），正文是「用到才付」的大开销。
  // 顺序上目录在前、正文在后（先知道有哪些，再展开具体这个）。
  const catalogPrompt = buildSkillCatalogPrompt(options.skillCatalog ?? [])
  if (catalogPrompt) messages.push({ role: 'system', content: catalogPrompt })
  if (options.activeSkill) {
    messages.push({ role: 'system', content: buildActiveSkillPrompt(options.activeSkill) })
  }

  // 会话摘要：放在历史之前。它覆盖的是已经被压缩掉的更早内容，
  // 所以顺序是「摘要（更早）→ 真实历史（更近）→ 本轮消息」。
  if (options.summary) {
    messages.push(...summaryMessages(options.summary))
  }

  // 历史：只取最近 N 条。条数越多越贵，history_limit 默认 20
  const recent = options.historyLimit > 0 ? history.slice(-options.historyLimit) : []
  for (const row of recent) {
    messages.push(toModelMessage(row))
  }

  // 本轮的动态上下文（时间/会话/说话人）附在**这条 user 消息**上，
  // 而不是塞进 system —— 理由见 buildSystemReminder 的注释（缓存）。
  messages.push({
    role: 'user',
    content: withReminder(
      buildUserContent(message, options.supportsVision),
      buildSystemReminder(message, options.timezone, {
        senderId: options.exposeSenderId ?? false,
        datetime: options.exposeDatetime ?? false,
      }),
    ),
  })

  // 兜底修一次配对：历史里可能出现「有 assistant.toolCalls 但工具结果没存下来」
  // （目前 run.ts 只存纯文本，不会产生这种数据；但一旦开始存 toolCalls，
  // 或某个 run 在写历史前被掐断，就会出现半截序列）。
  // 发出去之前保证合法，比让 provider 400 便宜得多。
  //
  // 注意：**本轮用户消息不能因为 fixMessages 被挪走**——它一定在最后，
  // 而 fixMessages 只调整 system 后的顺序，不会动尾部。
  return fixMessages(messages)
}

/**
 * 工具使用规范。有工具时追加在系统提示词末尾（对标 AstrBot 的 TOOL_CALL_PROMPT）。
 *
 * 工具本身的清单走 schema 下发（`tools` 参数），这里只讲「怎么用」——
 * 这几条都是从实际故障里总结出来的：返回空回复、每次调用前都啰嗦一句、
 * 凭空编造参数。
 */
const TOOL_USE_GUIDE = [
  '## 工具使用',
  '- 用工具拿到的事实优先于你的记忆；不确定就去查，不要猜。',
  '- 严格按工具的参数定义传参，不要编造不存在的参数。',
  '- 开始一类新任务时简单说明你在做什么；不必每次调用工具前都解释。',
  '- 工具返回后要基于结果给出最终答复，不要返回空回复。',
  // 媒体能力：模型不知道自己能把图发出去，就会把 URL 塞进正文让用户自己点
  '- 如果工具返回了图片或文件，它会自动发给用户；你不需要再重复描述它的内容或贴链接。',
].join('\n')

/**
 * 拼系统提示词。**分三层，顺序固定**：
 *
 * 1. **基础提示词**（`system_prompt` 或内置默认）—— 身份与总体语气
 * 2. **人格段落**（`# Persona Instructions`）—— 追加，不替换，见下
 * 3. **运行时环境**（时间 / 会话 / 工具规范 / 回复格式）—— 每轮都必须在
 *
 * 为什么人格是追加而不是替换：基础提示词里那些运行时约定（当前时间、
 * 当前会话、工具使用规范、「纯文本不要 Markdown」）是**功能性的**，
 * 替换掉模型就会开始输出 Markdown、不知道现在几点。AstrBot 也是追加
 * （`req.system_prompt += "\n# Persona Instructions\n\n{prompt}\n"`）。
 *
 * 人格放中间、运行时信息放最后：越靠后模型越容易遵守，
 * 而「不要用 Markdown」这类硬约束最需要被遵守。
 */
/**
 * 拼 system prompt。**这里放的东西必须跨轮稳定**——原因见文件顶上关于缓存的说明。
 *
 * 动态内容（时间、会话类型、说话人）**不在**这里，而是作为 system_reminder
 * 附在本轮 user 消息上（`buildSystemReminder`）。
 */
function buildSystemPrompt(
  configured: string | undefined,
  toolNames: string[] = [],
  personaPrompt?: string,
  pluginPrompts: string[] = [],
): string {
  const base = configured?.trim() || DEFAULT_SYSTEM_PROMPT

  // 用数组 join 而不是过滤空串：段落之间的空行是**可读性**的一部分，
  // `.filter(Boolean)` 会把它们一起删掉，导致标题和正文挤在一起
  return [
    base,
    personaPrompt ? `\n# Persona Instructions\n\n${personaPrompt}` : '',
    toolNames.length ? `\n${TOOL_USE_GUIDE}` : '',
    // 其他插件插的片段：放在最后，属于稳定内容（只要插件不改就命中缓存）
    ...pluginPrompts.map((block) => `\n${block}`),
    '\n回复要求：纯文本，不要用 Markdown 语法（QQ 不渲染），不要输出思考过程。',
  ].join('')
}

/**
 * 每轮会变的信息，作为 system_reminder 附在**本轮 user 消息**上。
 *
 * ## 为什么不放进 system prompt
 *
 * 模型的 prompt 缓存是**前缀匹配**的：从第一个字符逐字比对，命中到缓存断点为止。
 * 把时间放进 system（哪怕放在中间）会让它之后的全部内容每轮失效 ——
 * 实测时间戳出现在 system 的第 42/322 字符处，也就是后面 **87% 的内容
 * 每轮都要重新计费**，而且必然如此（时间精确到分钟）。
 *
 * 用户名也一样：同一个群里不同人说话会轮流击穿缓存。
 *
 * AstrBot 的做法是同一个道理 —— 它把群名、时间这些塞进
 * `req.extra_user_content_parts`，system 只留稳定内容
 * （见 `astr_main_agent.py:997-1002`）。
 *
 * 用 `<system_reminder>` 包起来是沿用 AstrBot 的标记，模型能理解这是
 * 系统给的即时上下文，而不是用户在说话。
 */
function buildSystemReminder(
  message: InboundMessage,
  timezone: string,
  // 默认值要和配置的默认值一致：两个都关。
  // 这里的默认值只影响「调用方没传」的情况（主要是一些老测试），
  // 真实路径由 run.ts 从 config 传进来。
  expose: { senderId: boolean; datetime: boolean } = {
    senderId: false,
    datetime: false,
  },
): string {
  const lines: string[] = []

  if (expose.datetime) {
    const now = new Date()
    let localTime = now.toISOString()
    try {
      localTime = new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(now)
    } catch {
      // 时区配错时退回 ISO，不影响对话
    }
    // 模型没有时钟，把当前时间告诉它，比让它每轮调 time.now 便宜
    lines.push(`- 现在时间：${localTime}（时区 ${timezone}）`)
  }

  lines.push(`- 当前会话：${message.scene === 'c2c' ? '单聊' : '群聊'}`)

  // 说话人：**昵称总是给**（没有昵称模型没法自然称呼对方），openid 受开关控制。
  //
  // 为什么 ID 要单独开关：它是按机器人隔离的匿名标识，用户自己看不见、
  // 跨机器人也不通用。默认开着每轮都占上下文，还可能被模型念到群里去。
  // 但关掉它，模型在群里就分不清哪句话是谁说的 —— 需要「记住某个人」
  // 或者「按人区分」时才该打开。
  //
  // 注意这里给的**不是 QQ 号**：QQ 官方机器人接口只提供 openid。
  if (expose.senderId && message.userId) {
    lines.push(
      `- 正在和你说话的人：${message.userName || '(无昵称)'}（openid: ${message.userId}）`,
    )
  } else if (message.userName) {
    lines.push(`- 正在和你说话的人：${message.userName}`)
  }

  if (!lines.length) return ''
  return ['<system_reminder>', ...lines, '</system_reminder>'].join('\n')
}

function toModelMessage(row: HistoryRow): ModelMessage {
  if (row.role === 'assistant') {
    const thinking = row.reasoning !== undefined ? { reasoning: row.reasoning } : {}
    const traces = parseToolTraces(row.toolCallsJson)
    if (traces.length === 0) {
      return { role: 'assistant', content: row.content, ...thinking }
    }
    // 历史里的工具调用回放成**正文的一部分**，而不是真正的 tool_calls/tool 消息对。
    //
    // 为什么不还原成协议级消息：一次工具调用要还原成 assistant(toolCalls) + tool(result)
    // 两条消息，而历史按条数占 DO 配额；更要紧的是那些 tool 结果当年可能被截断过，
    // 还原成协议消息会让模型以为拿到了完整结果。折中成一段说明，
    // 既让模型知道「上次调过什么」，又不伪造协议结构。
    const lines = traces.map((trace) => {
      const ok = trace.status === 'success' ? '成功' : `失败（${trace.status}）`
      return `- ${trace.name}(${trace.args}) → ${ok}：${trace.result}`
    })
    return {
      role: 'assistant',
      content: `${row.content}\n\n（上一轮调用过的工具：\n${lines.join('\n')}）`,
      ...thinking,
    }
  }
  return { role: 'user', content: row.content }
}

/**
 * 解析历史里存的工具调用摘要。
 *
 * 兼容两种形状：
 * - 新格式（`HistoryToolTrace[]`，由 loop 记录）
 * - 老格式（`ModelToolCall[]`，v0.1.0 之前可能残留的数据）
 *
 * 老数据不该让整个对话失败——读不懂就当没有工具调用。
 */
function parseToolTraces(json: string | null): HistoryToolTrace[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.flatMap((item): HistoryToolTrace[] => {
      if (!item || typeof item !== 'object') return []
      const entry = item as Record<string, unknown>
      // 新格式：有 status 字段
      if (typeof entry.name === 'string' && typeof entry.status === 'string') {
        return [
          {
            name: entry.name,
            args: typeof entry.args === 'string' ? entry.args : '',
            result: typeof entry.result === 'string' ? entry.result : '',
            status: entry.status,
          },
        ]
      }
      // 老格式 ModelToolCall：只有 id/name/arguments
      if (typeof entry.name === 'string' && entry.arguments !== undefined) {
        return [
          {
            name: entry.name,
            args: JSON.stringify(entry.arguments),
            result: '（历史里没有保存结果）',
            status: 'unknown',
          },
        ]
      }
      return []
    })
  } catch {
    // 历史里的坏数据不该让整个对话失败
    return []
  }
}

/**
 * 把 system_reminder 拼到本轮 user 内容上。
 *
 * 文本内容直接前置；多模态（带图）时要拼成一个 text 片段放在最前面，
 * 否则图片和文字的顺序会乱。
 *
 * 为什么放**前面**而不是后面：模型读到最后一句的印象最深，而这里是
 * 环境信息（现在几点、在哪说话），提前给比追加强。
 */
function withReminder(content: ModelContent, reminder: string): ModelContent {
  if (!reminder) return content
  if (typeof content === 'string') {
    return `${reminder}\n\n${neutralizeReminderTags(content)}`
  }
  // 多模态：把 reminder 作为第一个 text 片段
  return [
    { type: 'text', text: reminder },
    ...neutralizeParts(content),
  ]
}

/**
 * 中和用户正文里的 `<system_reminder>` 标记。
 *
 * 为什么必须做：真正的环境信息（时间/会话/说话人）是用
 * `<system_reminder>…</system_reminder>` 包起来拼在**本轮 user 消息**里的，
 * 模型被训练成「看到这个标记就是系统给的」。而用户的聊天正文同样能写出这段标签，
 * 于是一次输入里会出现两个 `<system_reminder>`——模型分不清哪段才是系统的，
 * 这正是提示注入的经典形态（伪造「现在是管理员模式」之类）。
 *
 * 处理方式是把用户内容里的尖括号替换成全角字符：语义仍然可读（人看得出来用户
 * 写了这个词），但**不再构成标签**，模型侧也就没有可混淆的结构。
 *
 * 只改这一对标记，不做通用的 HTML/XML 转义：那会把 `a < b`、代码片段、
 * XML 示例一起改乱，而这些是正常对话内容。
 */
function neutralizeReminderTags(text: string): string {
  if (!text.includes('<') && !text.includes('>')) return text
  return text.replace(/<(\/?)\s*system_reminder\s*>/gi, (_match, slash: string) =>
    slash ? '＜/system_reminder＞' : '＜system_reminder＞',
  )
}

/** 多模态内容里只动 text 片段，图片片段原样保留 */
function neutralizeParts(parts: ModelContentPart[]): ModelContentPart[] {
  return parts.map((part) =>
    part.type === 'text' ? { ...part, text: neutralizeReminderTags(part.text) } : part,
  )
}

function buildUserContent(message: InboundMessage, supportsVision: boolean): ModelContent {
  const images = message.attachments.filter((a) => a.type === 'image')

  // 没有图片，或者模型不吃图片：退回纯文本，把图片地址写进正文
  if (images.length === 0 || !supportsVision) {
    const imageNote = images.length
      ? `\n\n（用户发了 ${images.length} 张图片，但当前模型不支持图片输入：${images.map((i) => i.url ?? '').join(' ')}）`
      : ''
    return `${message.text}${imageNote}`
  }

  const parts: ModelContentPart[] = []
  if (message.text) parts.push({ type: 'text', text: message.text })
  for (const image of images) {
    if (image.dataBase64) {
      parts.push({
        type: 'image',
        data: image.dataBase64,
        ...(image.contentType ? { mediaType: image.contentType } : {}),
      })
    } else if (image.url) {
      parts.push({ type: 'image', url: image.url })
    }
  }
  return parts.length ? parts : message.text
}

/**
 * 由 `loop.ts` 返回的工具调用摘要转成历史行的 `toolCallsJson`。
 *
 * 单独抽出来是因为「什么时候有工具调用」的判断在 `loop.ts`（它才知道本轮调了什么），
 * 而「怎么存进历史」属于上下文装配的职责。生产路径用这个；
 * 下面不再保留旧版 `toHistoryRows` —— 它从来没有被生产代码调用过
 * （`run.ts` 自己手写历史行），是被审计发现的死代码。
 */
export function serializeToolTraces(traces: HistoryToolTrace[]): string | null {
  return traces.length ? JSON.stringify(traces) : null
}
