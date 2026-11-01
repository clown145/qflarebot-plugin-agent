/** Agent 提示词扩展与旧工具注册兼容接口。新工具请声明 definePlugin.tools，见 docs/plugin-api.md。 */
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

  /** @deprecated 保留旧注册与静态 depends 接线；新工具使用框架 definePlugin.tools。 */
  registerTool(plugin: string, tool: PluginToolRegistration): Promise<void>
  /** @deprecated 仅删除旧注册表记录，不影响框架工具。 */
  unregisterTool(plugin: string, fullNameOrName: string): Promise<void>
  /** @deprecated 只读旧注册表；新目录使用 core.tools.list。 */
  listTools(): Promise<PluginToolMeta[]>
}
