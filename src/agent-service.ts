/**
 * 本插件对外提供的服务契约：`ctx.service<AgentService>('agent')`。
 *
 * 两块扩展能力：
 * 1. **提示词**：往 system prompt 里插一段话（对标 AstrBot 的 `OnLLMRequestEvent`）
 * 2. **工具**：把自己的函数交给模型调用（对标 AstrBot 插件定义 `llm_tool` 的做法）
 *
 * ## 调用方怎么用
 *
 * ```ts
 * // manifest 里声明可选依赖
 * { "depends": { "agent": "optional" } }
 *
 * // 运行时
 * try {
 *   const agent = ctx.service<AgentService>('agent')
 *   await agent.registerPrompt(ctx.plugin.name, '回答天气前先调 weather.query')
 *   await agent.registerTool(ctx.plugin.name, {
 *     name: 'query',
 *     description: '查询某个城市当前的天气',
 *     inputSchema: {
 *       type: 'object',
 *       properties: { city: { type: 'string', description: '城市名' } },
 *       required: ['city'],
 *     },
 *   })
 * } catch {
 *   // 没装 / 停用了 Agent 插件，按没有处理
 * }
 * ```
 *
 * ## 工具的「元数据」和「执行」为什么分两处
 *
 * - `registerTool` 只登记**元数据**（名字、描述、schema）到 D1
 * - **执行函数**由提供者通过自己的 `services` 暴露，名字约定是 `tools`：
 *
 * ```ts
 * export default definePlugin({
 *   name: 'weather',
 *   services: {
 *     tools: () => ({
 *       query: async (input) => ({ city: input.city, temp: 21 }),
 *     }),
 *   },
 * })
 * ```
 *
 * 为什么必须这样：函数不是可序列化的值。而宿主的 `services` 工厂
 * **每个请求调用一次**，所以 Agent 只能在构建注册表的那一刻去取执行函数。
 * 元数据必须提前存好，否则「模型能看到哪些工具」这件事就没法在请求开始时确定。
 *
 * ## 名字规则
 *
 * 工具对外暴露成 `plugin.<你的插件名>.<工具名>`，强制带前缀：
 * - 防止提供者注册一个叫 `http.request` 的工具来冒充内置工具
 * - 两个插件撞名时天然区分
 *
 * 工具名会被规整（只留字母数字下划线连字符，其余转下划线）——
 * 模型侧的 function name 字符集有限，中文和空格会让 provider 直接 400。
 */
import type { JsonSchema, ToolSideEffect } from './tools/types.js'
import type { PluginToolMeta } from './plugin-tools.js'

/** 注册工具时提供的元数据。执行函数不在这里，见文件头说明 */
export interface PluginToolRegistration {
  /** 工具短名（不含前缀），如 `query` */
  name: string
  /** 给模型看的描述。**必填**——没有描述等于模型不知道何时该用 */
  description: string
  /** 入参 JSON Schema。必填，哪怕只是 `{ type: 'object', properties: {} }` */
  inputSchema: JsonSchema
  /** 权限级别。Agent 会强制抬到至少 2（不允许插件把能力降到人人可用） */
  level?: number
  /** 副作用等级，默认 `external_write` */
  sideEffect?: ToolSideEffect
  /** 单次调用超时，默认 10 秒，上限 30 秒 */
  timeoutMs?: number
}

export interface AgentService {
  // ---------------- 提示词 ----------------

  /**
   * 注册（或覆盖）提示词片段。内容没变时**不写库**（返回 `false`），
   * 可以放心在每个请求里调。
   *
   * @param plugin 用你自己的 `ctx.plugin.name`
   * @param fragment 追加到 system prompt 末尾的文本（≤2000 字节）
   * @param priority 越大越靠前，默认 0
   */
  registerPrompt(plugin: string, fragment: string, priority?: number): Promise<boolean>
  /** 停用但保留内容 */
  disablePrompt(plugin: string): Promise<void>
  /** 彻底删除 */
  clearPrompt(plugin: string): Promise<void>
  /** 列出全部片段（含停用的），排障用 */
  listPrompts(): Promise<
    Array<{ plugin: string; fragment: string; priority: number; enabled: boolean; updatedAt: number }>
  >

  // ---------------- 工具 ----------------

  /**
   * 注册一个工具。重复注册同名工具是覆盖。
   *
   * 注册后**下一轮对话**就能生效（不需要重启）。
   * 记得同时通过你自己的 `services.tools` 暴露同名执行函数，否则工具不会被注册
   * （Agent 拿不到执行函数时会跳过它）。
   */
  registerTool(plugin: string, tool: PluginToolRegistration): Promise<void>
  /** 注销一个工具。接受短名或全名 */
  unregisterTool(plugin: string, fullNameOrName: string): Promise<void>
  /** 列出全部插件工具（含停用的），管理页与排障用 */
  listTools(): Promise<PluginToolMeta[]>
}
