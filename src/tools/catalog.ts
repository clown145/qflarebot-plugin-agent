/**
 * 工具目录（catalog）：注册表 → 管理页能吃的描述，外加「按名字开关单个工具」。
 *
 * 投影与稳定排序照搬 serverless-agent 的 `src/tools/catalog/tool-catalog.ts`，
 * 设置持久化照搬 `src/storage/repositories/tool-settings-repository.ts`，
 * 但语义换了一处：
 *
 * 原文的设置是 `maxToolCallsPerRun` / `maxModelStepsPerRun`——这两个在本插件里
 * 已经是配置项（`max_tool_calls` / `max_model_steps`，页面也能改），再存一份就是
 * 两个真相、必然对不上。这里真正缺的是「这个机器人别开 http.request」这种
 * 按**工具名**的开关。
 *
 * ## 为什么存「关掉的」而不是「打开的」
 *
 * 设置里只记 disabled。存 enabled 的话，每次升级新增的工具都要先把名字补进设置里
 * 才可用，漏了就是「明明注册了却调不到」；反过来漏一个 disable 只是多开一个工具，
 * 用户看得见，也改得回来。
 *
 * ## 为什么投影一层，不把 registry 直接吐给页面
 *
 * `RegisteredTool` 里带 `execute`（函数），`Response.json` 之后只会得到 `{}`；
 * 管理页要的是名字、标题、权限级别、副作用、能不能点开关。投影一次既保证可序列化，
 * 也把顺序固定下来——不排序的话每次刷新工具顺序都可能变，看着像在闪。
 */
import type {
  ToolConfigField,
  PermissionLevel,
  RegisteredTool,
  ToolAnnotations,
  ToolSideEffect,
  ToolSource,
} from './types.js'

/**
 * 工具开关状态。
 *
 * 只有「关掉了哪些」。空数组 = 全部可用，也就是说**注册了就能用**是默认值；
 * 这样新版本新增的工具不需要任何迁移就能出现（见文件头的注释）。
 */
export interface ToolSettings {
  disabled: string[]
  /**
   * 每个工具自己的配置，如 `{ 'search.web': { apiKey: 'tvly-…' } }`。
   *
   * 为什么放在工具设置里而不是插件配置：**api key 是单个工具的事**。
   * 放在插件顶层会让「对话行为」页出现一个和限流、时区混在一起的神秘输入框，
   * 用户根本不知道它属于哪个工具。工具自己声明要什么配置、在自己的详情里填。
   */
  config?: Record<string, Record<string, string>>
}

/**
 * 管理页用的一条工具描述。
 *
 * **刻意不带 `inputSchema`**：工具的参数 schema 是整份描述里最占体积的部分，
 * 一屏十几个工具很容易撑到几十 KB，而管理页只用它画开关和权限标签。
 * 真要看参数，面板里已经有工具定义的源码，加一列反而让接口变慢。
 */
export interface ToolCatalogItem {
  name: string
  /** 展示名。工具没写 `title` 时退回工具名，见 `toToolCatalogItem` */
  title: string
  description: string
  source: ToolSource
  permission: { level: PermissionLevel; scopes: string[] }
  sideEffect: ToolSideEffect
  timeoutMs: number
  annotations: ToolAnnotations
  enabled: boolean
  /** 这个工具需要填哪些配置（空/不传 = 不需要配置，页面不显示「配置」按钮） */
  configFields?: ToolConfigField[]
  /** 已经填好的值。`secret` 类型的值**不回显**，只标 `configured: true` */
  config?: Record<string, string>
  /** `config` 里哪些键已经有值（secret 类型靠它显示「已设置」） */
  configuredKeys?: string[]
}

/**
 * 把工具投影成目录。
 *
 * `settings` 只用来标 `enabled`，**传进来的 `tools` 应当是没被过滤过的完整清单**：
 * 若先 `applyToolSettings` 再投影，被关掉的工具会从目录里消失，页面就再也点不到
 * 它的开启按钮（只能去改库）。「关了还能再打开」是管理页的基本要求。
 *
 * 排序与原文 `compareToolCatalogItems` 一致：先按来源类型分组，再按名字。
 * 面板按这个顺序渲染，分组后同一来源的工具挨在一起，比纯按名字好看也好找。
 */
export function toToolCatalog(
  tools: RegisteredTool[],
  settings?: ToolSettings,
): ToolCatalogItem[] {
  const normalized = normalizeToolSettings(settings)
  const disabled = new Set(normalized.disabled)
  return tools
    .map((tool) => {
      const item = toToolCatalogItem(tool, !disabled.has(tool.definition.name))
      const fields = tool.definition.configFields
      if (!fields?.length) return item

      const stored = normalized.config?.[tool.definition.name] ?? {}
      // **secret 不回显**：页面只该知道「有没有填」，不该把 key 明文写进
      // 一个之后可能被截图、被 devtools 翻出来的响应体里
      const shown: Record<string, string> = {}
      const configuredKeys: string[] = []
      for (const field of fields) {
        const value = stored[field.key] ?? ''
        if (!value) continue
        configuredKeys.push(field.key)
        if (field.type !== 'secret') shown[field.key] = value
      }
      return { ...item, configFields: fields, config: shown, configuredKeys }
    })
    .sort(compareToolCatalogItems)
}

function toToolCatalogItem(tool: RegisteredTool, enabled: boolean): ToolCatalogItem {
  const { definition } = tool
  return {
    name: definition.name,
    // 缺 title 时退回 name：面板直接显示这个字段，否则每处都要写 `?? name`，
    // 漏一处就是一行空白，看不出那里本该有个工具
    title: definition.title ?? definition.name,
    description: definition.description,
    source: tool.source,
    permission: {
      level: definition.permission.level,
      // 复制一份数组：目录会被序列化、被页面改，共享引用迟早把注册表里的定义改脏
      scopes: [...definition.permission.scopes],
    },
    sideEffect: definition.sideEffect,
    timeoutMs: definition.timeoutMs,
    // 缺省给空对象：面板按 readOnlyHint / destructiveHint 打角标，判空会多一层
    annotations: definition.annotations ?? {},
    enabled,
  }
}

function compareToolCatalogItems(left: ToolCatalogItem, right: ToolCatalogItem): number {
  return `${left.source.type}:${left.name}`.localeCompare(`${right.source.type}:${right.name}`)
}

/**
 * 按设置过滤要注册给模型的工具。
 *
 * 返回**新数组**：一次 run 里注册表会被多处读（提示词要工具名、loop 要工具集），
 * 原地删会连带改到别处，而这类 bug 只在特定配置下才复现。空设置也返回新数组，
 * 理由相同——调用方可能对结果排序或追加。
 *
 * 找不到的名字直接跳过：工具会随 `enable_vfs` / `enable_schedule` 之类的开关增减，
 * 设置里留着过期名字是常态。过期项不该让对话失败，也不在这里顺手删掉——
 * 用户可能只是临时把配置关了，回头还会打开。
 */
export function applyToolSettings(
  tools: RegisteredTool[],
  settings?: ToolSettings,
): RegisteredTool[] {
  const disabled = new Set(normalizeToolSettings(settings).disabled)
  if (disabled.size === 0) return [...tools]
  return tools.filter((tool) => !disabled.has(tool.definition.name))
}

/**
 * 把库里 / 请求体里的任意值归一成 `{ disabled: string[] }`。**永不抛错**。
 *
 * 接受两种形状，因为两处真的都会传进来：
 * - `'["a","b"]'` / `['a','b']`——`{tool_settings}.disabled_json` 列存的就是名字
 *   数组本身（列名即约定，手工翻库一眼能看懂），读出来是字符串；
 * - `{ disabled: [...] }`——页面 POST 上来的接口形状。
 *
 * 坏数据最坏的结果应当是「工具照常全部可用」，而不是「一个都调不到」——后者会让
 * 机器人整体失灵，排查成本远高于一个设置项失效。所以解析失败、字段类型不对、
 * 顶层是数字/null，一律退回全开。
 *
 * 顺手做的清理：去掉非字符串（数字 / null / 对象）、去空白、去空串、去重。
 * 重复项不影响过滤结果，但面板会重复画一行勾选框，看着像坏了。
 */
export function normalizeToolSettings(raw: unknown): ToolSettings {
  const value = typeof raw === 'string' ? parseJsonOrNull(raw) : raw
  // 裸数组 = 库里的存储形状（老版本只存 disabled）；对象 = 接口形状
  const list = Array.isArray(value) ? value : readDisabledField(value)
  const disabled = Array.isArray(list) ? readStringList(list) : []
  return { disabled, config: readConfigMap(value) }
}

function readStringList(list: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * 解析每工具配置。形状必须是 `{ <工具名>: { <键>: <字符串> } }`。
 *
 * 逐层校验而不是整体 `as`：这份数据会被直接拼进工具构造参数（比如 api key），
 * 一个多余的嵌套层级或非字符串值都应该被丢掉，而不是传到下游去炸。
 */
function readConfigMap(value: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out

  const raw = (value as Record<string, unknown>)['config']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out

  for (const [toolName, toolConfig] of Object.entries(raw as Record<string, unknown>)) {
    if (!toolName.trim()) continue
    if (!toolConfig || typeof toolConfig !== 'object' || Array.isArray(toolConfig)) continue
    const fields: Record<string, string> = {}
    for (const [key, val] of Object.entries(toolConfig as Record<string, unknown>)) {
      if (typeof val === 'string' && key.trim()) fields[key.trim()] = val
    }
    if (Object.keys(fields).length) out[toolName.trim()] = fields
  }
  return out
}

function readDisabledField(value: unknown): unknown {
  // 顶层不是对象（null / 数字 / 字符串解析失败的 undefined）都当全开
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  // 取字段也可能抛（Proxy、getter、`Object.create` 出来的怪东西）。
  // 「读设置」在每条 run 的路径上，这里抛一次 = 整轮对话挂掉，比设置失效严重得多。
  try {
    return (value as { disabled?: unknown }).disabled
  } catch {
    return undefined
  }
}

/** JSON 解析失败退回 null，交给 normalize 统一产出「全开」 */
function parseJsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}
