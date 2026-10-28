/**
 * 插件配置。对应 manifest.json 的 configSchema，面板按它渲染表单。
 *
 * 设计原则：**默认值要保守**。额度是全机器人共享的（免费版 D1 写 10 万行/日、
 * DO 13,000 GB-s/日），功能默认关、步数默认小，用户按需打开。
 */

export interface AgentConfig {
  /** 调用的模型别名（plugin-llm 的 `llm` 服务里配置的别名） */
  model: string

  /** 系统提示词。留空时用内置的默认人格 */
  system_prompt: string

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

  /** MCP 服务器工具 */
  enable_mcp: boolean

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
  max_model_steps: 8,
  max_tool_calls: 12,
  history_limit: 20,
  request_timeout_ms: 20000,
  enable_tools: true,
  enable_vfs: false,
  enable_schedule: false,
  enable_mcp: false,
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
      description: '模型可以读写文件。文件存在 R2 里，需要绑定 R2',
      default: defaultConfig.enable_vfs,
    },
    enable_schedule: {
      type: 'boolean',
      title: '启用动态定时任务',
      description: '模型可以自己创建提醒。需要机器人开启每分钟 cron',
      default: defaultConfig.enable_schedule,
    },
    enable_mcp: {
      type: 'boolean',
      title: '启用 MCP 工具',
      default: defaultConfig.enable_mcp,
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
    timezone: {
      type: 'string',
      title: '时区',
      default: defaultConfig.timezone,
    },
  },
} as const
