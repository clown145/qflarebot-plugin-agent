/**
 * 插件配置。对应 manifest.json 的 configSchema，面板按它渲染表单。
 *
 * 设计原则：**默认值要保守**。额度是全机器人共享的（免费版 D1 写 10 万行/日、
 * DO 13,000 GB-s/日），功能默认关、步数默认小，用户按需打开。
 */

/**
 * 一套人格（对标 AstrBot 的 persona）。
 *
 * `name` 是绑定用的标识（会话里存的就是它），改名字等于换了一整套人格。
 */
export interface PersonaConfig {
  /** 标识，会话按它绑定 */
  name: string
  /** 这套人格的系统提示词 */
  prompt: string
  /**
   * 开场对话（AstrBot 的 begin_dialogs）：每轮都插在历史最前面，用来锚定说话风格。
   * 形如 `user: …` / `assistant: …` 的纯文本行，见 persona.ts 的解析。
   */
  begin_dialogs: string

  /**
   * 这套人格允许用的工具（AstrBot Persona.tools 的对应物）。
   *
   * **留空 = 不限**（用全局工具集）；写了就是白名单，只有名单里的能用。
   * 为什么需要它：同一台机器人上，「客服人格」不该能发 HTTP 请求，
   * 而「运维人格」需要。以前只能全局开关工具，没法按人格区分。
   *
   * 注意这不替代权限层：白名单只是**收窄**，具体某个工具能不能真跑
   * 仍然由权限级别 + scope 决定（两道关卡叠加）。
   *
   * **可选**：老配置里没有这个字段，缺省视为「不限」。
   */
  tools?: string[]

  /**
   * 这套人格可见的技能（AstrBot Persona.skills 的对应物）。
   *
   * **留空 = 不限**（用全局技能目录）；写了就是白名单；`[]` = 一个都不给。
   *
   * 与 `tools` 同构，也对齐 AstrBot 的语义（`po.py:169-170`）：
   * `None` 是全部，空列表是都没有。
   *
   * 为什么要按人格限制技能：技能目录每轮都进上下文，一台机器人挂十几套技能时
   * 「客服人格」不该看到「运维手册」—— 既省 token，也避免模型激活错技能。
   *
   * **只影响可见性**：被挡掉的技能进不了目录，用户即使手动 `/skill <id>` 也激活不了。
   */
  skills?: string[]

  /**
   * 出错时给用户的回复（AstrBot Persona.custom_error_message）。
   *
   * 留空则用默认的通用错误文案。人格化的错误提示能让「这个角色」一致 ——
   * 一个毒舌角色突然冒出「处理失败：HTTP 500」会很出戏。
   *
   * **可选**：老配置里没有，缺省用通用文案。
   */
  custom_error_message?: string
}

export interface AgentConfig {
  /** 调用的模型别名（plugin-llm 的 `llm` 服务里配置的别名） */
  model: string

  /** 系统提示词。留空时用内置的默认人格 */
  system_prompt: string

  /**
   * 人格（AstrBot 的 persona）。
   *
   * 一个机器人可以有多套人格，每个会话绑一套。`system_prompt` 是「没人格时的兜底」，
   * 存在 `personas` 里时优先用会话绑定的那套（见 `src/persona.ts`）。
   */
  personas: PersonaConfig[]

  /** 会话没有显式绑人格时用哪一套；留空用 `system_prompt`（内置默认人格） */
  default_persona: string

  /**
   * 唤醒前缀（对标 AstrBot 的 `wake_prefix`，默认 `/`）。
   *
   * 群聊里以此开头的消息会唤醒 Agent，并剥掉前缀再交给模型。
   * 指令前缀由宿主框架管理（命令命中后不再进模型），这里不必再配一份。
   */
  wake_prefix: string

  /** 单聊没有 @ 的概念：关掉时私聊任何消息都触发，打开后需要前缀（对应 AstrBot 的 friend_message_needs_wake_prefix） */
  friend_needs_wake_prefix: boolean


  /** 一次 run 内最多几步模型调用。失控的 loop 会烧光 DO 时长与 token，默认 8 */
  max_model_steps: number

  /** 一次 run 内最多几次工具调用 */
  max_tool_calls: number

  /** 会话历史保留多少条消息（user + assistant） */
  history_limit: number

  /** 单次模型调用的超时（毫秒） */
  request_timeout_ms: number

  /** 工具调用总开关 */
  enable_tools: boolean

  /**
   * 虚拟工作区。默认**开**。
   *
   * 没绑 R2 也能用（轻量模式：D1 存 ≤8KB 文本）；绑了 R2 才支持大文件。
   * 以前默认关且必须有 R2，导致「有工作区」这件事在多数部署里等于不存在。
   */
  enable_vfs: boolean

  /** 动态定时任务（LLM 可自己建提醒） */
  enable_schedule: boolean

  /**
   * 技能（Skills）。打开后每轮会给模型一份技能目录（≤40 行），
   * 用户显式 `/skill <id> <任务>` 时才注入该技能的完整正文。
   *
   * 默认关：没配任何技能时这份目录是空的，开着只是多一次 D1 查询。
   */
  enable_skills: boolean

  /** 是否把工具调用记进 D1（排障用，吃额度，默认关） */
  enable_audit: boolean

  /** 回复里是否附带"思考中"提示（单聊可用 typing） */
  show_typing: boolean

  /**
   * 群聊是否**按成员隔离会话**（每人一段独立历史）。
   *
   * 默认关：整个群共享一段历史，和人类在群里聊天的直觉一致。
   * 打开后同一个群里 A 和 B 各聊各的，互相看不到对方的上下文 ——
   * 适合客服、多租户这类「一人一档」的场景。
   *
   * 对标 AstrBot 的 `platform_settings.unique_session`
   * （`waking_check/stage.py:88-92`，它拼 `sender_id + group_id`）。
   *
   * **只影响群聊与频道**，单聊和频道私信本来就一人一档。
   *
   * ⚠️ 切换后**已有记忆不会迁移**：会话键变了，DO 里那批历史查不到，
   * 所有人等于重新开始。不做迁移是因为旧历史里压根没存 userId，
   * 技术上分不出哪句话是谁说的。
   */
  isolate_sessions: boolean

  /**
   * 是否让模型知道**说话人的 openid**。
   *
   * 默认关。开启后提示词里会带一行 `User ID: <openid>`，模型可以据此
   * 「记住这个人」「区分群里不同的人」。
   *
   * **注意这不是 QQ 号**：QQ 官方机器人接口只给 openid（按机器人隔离的
   * 匿名标识），拿不到真实 QQ 号。openid 同一个用户在同一台机器人下稳定，
   * 但换一台机器人就不同，所以不能拿去跨机器人识别。
   *
   * 默认关的理由：多数对话不需要它，而它每轮都进上下文；更重要的是
   * 一旦进了上下文，模型可能把它念出来 —— 那是用户看不见的标识符，
   * 泄露到群里没有意义。
   */
  expose_sender_id: boolean

  /**
   * 回复时要不要 @ 说话人。
   *
   * - `off`：不 @（默认）
   * - `group`：只在群聊/频道 @（单聊只有两个人，@ 没意义）
   * - `always`：总是 @
   *
   * 为什么默认关：群里每条都 @ 会很吵，客户端还会额外推送。
   * 但「多人同时问」时它确实有用 —— 用户一眼看出机器人在回谁。
   *
   * 注意 @ 只对**群聊/频道**有意义，单聊发 `<@openid>` 会被平台当普通文本。
   */
  reply_mention: 'off' | 'group' | 'always'

  /**
   * 是否把当前时间告诉模型。**默认关**。
   *
   * 关的理由：`time.now` 工具已经能取时间，每轮都塞进提示词是重复供养、
   * 白占上下文。
   *
   * 但确实有代价：模型**经常忘记调工具**，直接说「今天是 2024 年」。
   * 所以这个开关要留着——需要精确日期（比如算「三天后是几号」）的部署
   * 可以打开，代价是每轮多一行。
   */
  expose_datetime: boolean

  /** 时区，用于 time 工具与提示词 */
  timezone: string

  /**
   * 上下文压缩模式（对标 AstrBot 的 `context_compression`）。
   *
   * - `off`：不压缩，只按 `history_limit` 截断。
   * - `truncate`：丢掉最老的整轮。**零额外模型调用、零额外存储写入**，纯内存计算。
   * - `summary`：把丢掉的旧轮交给模型摘要，摘要存 DO。每压一次多一次模型调用。
   *
   * 默认 `truncate`：它能挡住长会话的成本爆炸，且不花任何额度。
   */
  context_compression: 'off' | 'truncate' | 'summary'

  /**
   * 触发压缩的 token 估算阈值（对标 AstrBot 的 `max_context_tokens` 与 0.82 水位）。
   *
   * 不需要精确：这是个**估算**，真实 usage 由 provider 返回、会覆盖估算值
   * （见 context-size.ts 的注释）。设小会压得勤，设大会更贵。
   */
  max_context_tokens: number

  /** 每个会话每分钟最多触发几次 run（0 = 不限）。防单人刷屏烧 token */
  rate_limit_per_minute: number


  /**
   * 纯文本关键词内容安全（逗号分隔）。
   *
   * 命中即拒绝，不发模型。这是最便宜的护栏：零外部依赖、零额外请求。
   * 空字符串 = 关闭。对标 AstrBot 的 `content_safety_check` 的 keywords 策略。
   */
  content_filter_keywords: string
}

export const DEFAULT_SYSTEM_PROMPT = [
  '你是一个运行在 QQ 上的助手。回答要简洁，能一句话说清就不要展开。',
  '你不确定的事情要直说，不要编造。',
  '你能调用工具时优先用工具拿事实，不要凭记忆猜。',
].join('\n')

export const defaultConfig: AgentConfig = {
  model: 'chat',
  system_prompt: DEFAULT_SYSTEM_PROMPT,
  personas: [],
  default_persona: '',
  wake_prefix: '/',
  friend_needs_wake_prefix: false,
  max_model_steps: 8,
  max_tool_calls: 12,
  history_limit: 20,
  request_timeout_ms: 20000,
  enable_tools: true,
  enable_vfs: true,
  enable_schedule: false,
  enable_skills: false,
  enable_audit: false,
  show_typing: true,
  isolate_sessions: false,
  expose_sender_id: false,
  reply_mention: 'off' as const,
  expose_datetime: false,
  timezone: 'Asia/Shanghai',
  context_compression: 'truncate',
  max_context_tokens: 12000,
  rate_limit_per_minute: 10,
  content_filter_keywords: '',
}

/** 面板渲染用的 JSON Schema。与 defaultConfig 一一对应 */
export const configSchema = {
  type: 'object',
  properties: {
    model: {
      type: 'string',
      title: '模型别名',
      description: 'plugin-llm 插件里配置的模型别名，默认 `chat`',
      default: defaultConfig.model,
    },
    system_prompt: {
      type: 'string',
      format: 'textarea',
      title: '系统提示词',
      description: '留空则用内置的默认人格',
      default: DEFAULT_SYSTEM_PROMPT,
    },
    max_model_steps: {
      type: 'integer',
      title: '单次最多模型步数',
      description: '一步 = 一次模型调用。失控的循环会烧光时长与 token，建议 8–12',
      minimum: 1,
      maximum: 30,
      default: defaultConfig.max_model_steps,
    },
    max_tool_calls: {
      type: 'integer',
      title: '单次最多工具调用',
      minimum: 1,
      maximum: 50,
      default: defaultConfig.max_tool_calls,
    },
    history_limit: {
      type: 'integer',
      title: '会话历史条数',
      description: '每次带多少条历史消息给模型。条数越多越贵',
      minimum: 0,
      maximum: 100,
      default: defaultConfig.history_limit,
    },
    request_timeout_ms: {
      type: 'integer',
      title: '模型调用超时（毫秒）',
      minimum: 1000,
      maximum: 25000,
      default: defaultConfig.request_timeout_ms,
    },
    enable_tools: {
      type: 'boolean',
      title: '启用工具调用',
      description: '关掉之后就是纯聊天，模型不会调用任何工具',
      default: defaultConfig.enable_tools,
    },
    enable_vfs: {
      type: 'boolean',
      title: '启用虚拟工作区',
      description:
        '模型可以读写工作区文件。默认开：不绑 R2 也能存 8KB 以内的文本；绑了 R2 才支持大文件',
      default: defaultConfig.enable_vfs,
    },
    enable_schedule: {
      type: 'boolean',
      title: '启用动态定时任务',
      description: '模型可以自己创建提醒。需要机器人开启每分钟 cron',
      default: defaultConfig.enable_schedule,
    },
    enable_skills: {
      type: 'boolean',
      title: '启用技能',
      description:
        '模型可以在对话里用 `/skill <id> <任务>` 激活技能。目录每轮只占几行，技能正文只在激活时载入',
      default: defaultConfig.enable_skills,
    },
    enable_audit: {
      type: 'boolean',
      title: '记录工具调用',
      description: '写进 D1，方便排障。会消耗 D1 写入额度',
      default: defaultConfig.enable_audit,
    },
    show_typing: {
      type: 'boolean',
      title: '回复前显示"正在输入"',
      description: '仅单聊有效',
      default: defaultConfig.show_typing,
    },
    isolate_sessions: {
      type: 'boolean',
      title: '群聊按成员隔离会话',
      description:
        '打开后每个群成员拥有独立的历史，互相看不到对方聊的内容；' +
        '适合客服、多租户。关闭时整个群共享一段历史（默认）。' +
        '⚠️ 切换后已有记忆查不到，等于所有人重新开始',
      default: defaultConfig.isolate_sessions,
    },
    expose_sender_id: {
      type: 'boolean',
      title: '让模型知道说话人 ID',
      description:
        '提示词里带上说话人的 openid（不是 QQ 号，QQ 机器人接口拿不到真实 QQ 号）。' +
        '同一用户在同一台机器人下稳定，换机器人就不同，不能跨机器人识别。' +
        '开了模型才能区分群里不同的人、记住谁说过什么',
      default: defaultConfig.expose_sender_id,
    },
    reply_mention: {
      type: 'string',
      title: '回复时 @ 说话人',
      description:
        '关：不 @（默认，群里不吵）。' +
        '仅群聊：群聊/频道里 @ 说话人，单聊不 @。' +
        '总是：所有场景都 @。' +
        '多人同时提问时 @ 一下，用户能一眼看出机器人在回谁',
      enum: ['off', 'group', 'always'],
      enumNames: ['关', '仅群聊', '总是'],
      default: defaultConfig.reply_mention,
    },
    expose_datetime: {
      type: 'boolean',
      title: '在提示词里带上当前时间',
      description:
        '关闭时模型需要自己调 time.now 取时间，省一点上下文。' +
        '但模型经常忘记调、直接凭记忆编日期，需要精确日期的场景可以打开。' +
        '注意这条不影响缓存——时间放在本轮用户消息里，不在系统提示词里',
      default: defaultConfig.expose_datetime,
    },
    personas: {
      type: 'array',
      title: '人格',
      description:
        '每个会话绑一套。留空时用下面的「系统提示词」。会话里用 `/agent persona <名字>` 切换',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            title: '名字',
            description: '会话按它绑定，建议短且唯一（如 `cat`、`assistant`）',
          },
          prompt: {
            type: 'string',
            format: 'textarea',
            title: '人格提示词',
            description: '这套人格的系统提示词',
          },
          begin_dialogs: {
            type: 'string',
            format: 'textarea',
            title: '开场对话',
            description:
              '每轮插在历史最前面，用来锚定风格。每行一句，以 `user:` / `assistant:` 开头，例如：\nuser: 你好\nassistant: 你好呀～',
            default: '',
          },
          tools: {
            type: 'array',
            title: '可用工具',
            description:
              '留空 = 不限（用全局工具集）；填了就是白名单，只有这些工具能被这套人格使用。不能突破权限层',
            items: { type: 'string' },
            default: [],
          },
          skills: {
            type: 'array',
            title: '可见技能',
            description: '留空 = 不限（全部技能都可见）；填了就是白名单；空列表表示一个都看不到',
            items: { type: 'string' },
            default: [],
          },
          custom_error_message: {
            type: 'string',
            format: 'textarea',
            title: '出错时的回复',
            description: '留空用通用错误文案。人格化回复能让出错时也不出戏',
            default: '',
          },
        },
      },
      default: [],
    },
    default_persona: {
      type: 'string',
      title: '默认人格',
      description: '会话没有显式绑人格时用哪一套；留空则用「系统提示词」',
      default: '',
    },
    wake_prefix: {
      type: 'string',
      title: '唤醒前缀',
      description: '「@ / 前缀 / 回复机器人」模式下，以此开头的消息也会触发。默认 `/`',
      default: defaultConfig.wake_prefix,
    },
    friend_needs_wake_prefix: {
      type: 'boolean',
      title: '单聊需要前缀才触发',
      description: '关掉时私聊任何消息都会触发 Agent；打开后私聊也要带唤醒前缀',
      default: defaultConfig.friend_needs_wake_prefix,
    },
    timezone: {
      type: 'string',
      title: '时区',
      default: defaultConfig.timezone,
    },
    context_compression: {
      type: 'string',
      enum: ['off', 'truncate', 'summary'],
      title: '上下文压缩',
      description:
        '长会话怎么处理旧记录。`truncate` = 丢掉最老的整轮（零额外模型调用，推荐）；`summary` = 丢掉旧轮的同时让模型生成摘要，跨轮记忆更好，每次压缩会多一次模型调用；`off` = 只按历史条数截断',
      default: defaultConfig.context_compression,
    },
    max_context_tokens: {
      type: 'integer',
      title: '压缩触发的 token 阈值',
      description:
        '估算值超过这个数就开始压缩。这是估算，真实用量由模型返回后覆盖。建议 8000–20000',
      minimum: 1000,
      maximum: 200000,
      default: defaultConfig.max_context_tokens,
    },
    rate_limit_per_minute: {
      type: 'integer',
      title: '每会话每分钟最多几次对话',
      description: '防止单人刷屏烧 token。0 = 不限制。被限时用户会收到一句提示',
      minimum: 0,
      maximum: 100,
      default: defaultConfig.rate_limit_per_minute,
    },
    content_filter_keywords: {
      type: 'string',
      title: '内容安全关键词',
      description:
        '命中即拒绝、不发模型（逗号分隔）。留空 = 关闭。零外部依赖，只做纯文本匹配',
      default: defaultConfig.content_filter_keywords,
    },
  },
} as const
