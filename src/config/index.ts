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
   * 群聊里什么消息会触发 Agent（AstrBot 的 waking check）。
   *
   * - `at`：只有 @机器人才触发（默认，最省额度、不打扰）
   * - `at_or_prefix`：@机器人，或以 `wake_prefix` 开头，或回复机器人消息
   * - `all`：群里所有消息（需要群主在 QQ 里开启「接收全部消息」）
   */
  wake_mode: 'at' | 'at_or_prefix' | 'all'

  /** 唤醒前缀（`wake_mode` 为 `at_or_prefix` 时生效），默认 `/` */
  wake_prefix: string

  /** 单聊没有 @ 的概念：关掉时私聊任何消息都触发，打开后需要前缀（对应 AstrBot 的 friend_message_needs_wake_prefix） */
  friend_needs_wake_prefix: boolean

  /**
   * 已发出的回复里带这些前缀时视为「聊天」，不触发 Agent。
   *
   * 用于避免插件与指令互相打架：`/agent` 这类显式指令应当由命令路径处理，
   * 不该再进模型（否则同一句话会既执行指令又产生一次模型调用）。
   */
  command_prefixes: string

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

  /** 虚拟工作区（吃 R2，默认关） */
  enable_vfs: boolean

  /** 动态定时任务（LLM 可自己建提醒） */
  enable_schedule: boolean

  /** 是否把工具调用记进 D1（排障用，吃额度，默认关） */
  enable_audit: boolean

  /** 回复里是否附带"思考中"提示（单聊可用 typing） */
  show_typing: boolean

  /** 时区，用于 time 工具与提示词 */
  timezone: string
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
  wake_mode: 'at',
  wake_prefix: '/',
  friend_needs_wake_prefix: false,
  command_prefixes: '/',
  max_model_steps: 8,
  max_tool_calls: 12,
  history_limit: 20,
  request_timeout_ms: 20000,
  enable_tools: true,
  enable_vfs: false,
  enable_schedule: false,
  enable_audit: false,
  show_typing: true,
  timezone: 'Asia/Shanghai',
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
      description: '模型可以读写工作区文件。小文本存 D1，超过 8KB 的存 R2（需要绑定 R2）',
      default: defaultConfig.enable_vfs,
    },
    enable_schedule: {
      type: 'boolean',
      title: '启用动态定时任务',
      description: '模型可以自己创建提醒。需要机器人开启每分钟 cron',
      default: defaultConfig.enable_schedule,
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
    wake_mode: {
      oneOf: [
        { const: 'at', title: '仅 @ 机器人' },
        { const: 'at_or_prefix', title: '@ / 前缀 / 回复机器人' },
        { const: 'all', title: '群里所有消息（需开启接收全部消息）' },
      ],
      title: '群聊触发方式',
      description:
        '群聊里什么消息会触发 Agent。`all` 需要群主在 QQ 里给机器人开启「接收全部消息」，否则只能收到 @ 消息',
      default: defaultConfig.wake_mode,
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
    command_prefixes: {
      type: 'string',
      title: '机器人自身的指令前缀',
      description:
        '以此开头的消息交给指令处理，不再触发 Agent。多个用逗号分隔，默认 `/`',
      default: defaultConfig.command_prefixes,
    },
    timezone: {
      type: 'string',
      title: '时区',
      default: defaultConfig.timezone,
    },
  },
} as const
