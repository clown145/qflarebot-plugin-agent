/** 旧版工具注册表：兼容静态服务接线，并保留迁移前的禁用与权限设置。 */
import type { PluginDB } from '@qqbot/sdk'
import type { JsonSchema, ToolSideEffect } from './tools/types.js'
import type { PluginToolRegistration } from './agent-service.js'

export type { PluginToolRegistration }

/** 插件工具元数据。**不含执行函数**——函数没法序列化，运行时从 services 取 */
export interface PluginToolMeta {
  /** 旧注册时填写的提供者名；不作为框架调用的身份凭据 */
  owner: string
  /** 工具短名（不含前缀），如 `echo` */
  name: string
  /** 暴露给模型的完整名字，形如 `plugin.weather.query` */
  fullName: string
  description: string
  inputSchema: JsonSchema
  /** 提供者声明的权限级别。Agent 会强制不低于 MIN_LEVEL */
  level: number
  sideEffect: ToolSideEffect
  timeoutMs: number
  enabled: boolean
  updatedAt: number
}

/** 插件工具的最低权限级别。插件工具不允许低于这个值 */
export const MIN_PLUGIN_TOOL_LEVEL = 2
/** 单个插件的工具数量上限 */
export const MAX_TOOLS_PER_PLUGIN = 20
/** 所有插件工具的总数上限（防止模型被一堆工具淹没） */
export const MAX_PLUGIN_TOOLS = 50
/** 描述长度上限。工具的 description 每轮都进上下文，太长等于每轮烧 token */
export const MAX_DESCRIPTION_CHARS = 500

/**
 * 工具名规整：只留字母数字下划线点，其余转下划线。
 *
 * 源自 AstrBot 的 MCP 工具命名规则（`mcp_client.py:804` 的
 * `re.sub(r"[^A-Za-z0-9_-]+", "_", name)`）—— 模型侧的 function name
 * 只接受有限字符集，中文、空格、斜杠都会导致 provider 400。
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
}

/** 拼出暴露给模型的完整工具名 */
export function pluginToolFullName(owner: string, name: string): string {
  const safeOwner = sanitizeToolName(owner) || 'plugin'
  const safeName = sanitizeToolName(name) || 'tool'
  // 截断到 provider 常见上限（64 字符）以内，留出余量
  return `plugin.${safeOwner}.${safeName}`.slice(0, 64)
}

/** 校验一条注册，返回 null = 通过 */
export function validateToolRegistration(input: unknown): string | null {
  if (!input || typeof input !== 'object') return '工具定义必须是对象'
  const item = input as Record<string, unknown>

  if (typeof item['name'] !== 'string' || !item['name'].trim()) {
    return '工具必须有 name'
  }
  if (sanitizeToolName(item['name']).length === 0) {
    return `工具名 ${item['name']} 不含任何可用字符（只允许字母、数字、下划线、连字符）`
  }
  if (typeof item['description'] !== 'string' || !item['description'].trim()) {
    // 描述是模型判断「该不该用这个工具」的唯一依据，没有描述等于不可用
    return '工具必须有 description'
  }
  if (item['description'].length > MAX_DESCRIPTION_CHARS) {
    return `description 超过 ${MAX_DESCRIPTION_CHARS} 字符（它每轮都进上下文，太长会持续烧 token）`
  }
  if (!item['inputSchema'] || typeof item['inputSchema'] !== 'object') {
    return '工具必须有 inputSchema（JSON Schema 对象，哪怕只是 { type: "object", properties: {} }）'
  }
  return null
}

/**
 * 注册（或覆盖）一个插件提供的工具。
 *
 * 一个插件重复注册**同名工具**是覆盖；不同名则各自一行。
 * 提供者通常会在 `onInstall` / 启动时注册一次，不需要每请求都写。
 */
export async function upsertPluginTool(
  db: PluginDB,
  owner: string,
  input: PluginToolRegistration,
): Promise<void> {
  const cleanOwner = sanitizeToolName(owner)
  if (!cleanOwner) throw new Error('缺少提供者插件名')

  const error = validateToolRegistration(input)
  if (error) throw new Error(error)

  const name = sanitizeToolName(input.name)
  const fullName = pluginToolFullName(cleanOwner, name)

  // 插件工具一律不低于 MIN_PLUGIN_TOOL_LEVEL：提供者说自己 level 1 也不作数，
  // 否则任何插件都能把「发 HTTP 请求」这类能力降到人人可用
  const level = Math.max(MIN_PLUGIN_TOOL_LEVEL, Math.trunc(input.level ?? MIN_PLUGIN_TOOL_LEVEL))
  const timeoutMs = Math.min(Math.max(Math.trunc(input.timeoutMs ?? 10_000), 1_000), 30_000)

  const count = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM {plugin_tools} WHERE owner = ?`,
    cleanOwner,
  )
  const existing = await db.first<{ full_name: string }>(
    `SELECT full_name FROM {plugin_tools} WHERE full_name = ?`,
    fullName,
  )
  // 新工具（不是覆盖）才检查数量上限
  if (!existing && (count?.n ?? 0) >= MAX_TOOLS_PER_PLUGIN) {
    throw new Error(`插件 ${cleanOwner} 最多注册 ${MAX_TOOLS_PER_PLUGIN} 个工具`)
  }

  await db.run(
    `INSERT INTO {plugin_tools}
       (full_name, owner, name, description, input_schema, level, side_effect, timeout_ms, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(full_name) DO UPDATE SET
       description = excluded.description,
       input_schema = excluded.input_schema,
       level = excluded.level,
       side_effect = excluded.side_effect,
       timeout_ms = excluded.timeout_ms,
       updated_at = excluded.updated_at`,
    fullName,
    cleanOwner,
    name,
    input.description.trim(),
    JSON.stringify(input.inputSchema),
    level,
    input.sideEffect ?? 'external_write',
    timeoutMs,
    Date.now(),
  )
}

/** 读所有启用中的插件工具（构建注册表时用） */
export async function listPluginTools(db: PluginDB): Promise<PluginToolMeta[]> {
  const rows = await db.all<{
    full_name: string
    owner: string
    name: string
    description: string
    input_schema: string
    level: number
    side_effect: string
    timeout_ms: number
    enabled: number
    updated_at: number
  }>(
    `SELECT full_name, owner, name, description, input_schema, level, side_effect, timeout_ms, enabled, updated_at
     FROM {plugin_tools} WHERE enabled = 1
     ORDER BY owner ASC, name ASC LIMIT ?`,
    MAX_PLUGIN_TOOLS,
  )

  return rows.map((row) => ({
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    description: row.description,
    inputSchema: safeJsonObject(row.input_schema),
    level: row.level,
    sideEffect: (row.side_effect as ToolSideEffect) ?? 'external_write',
    timeoutMs: row.timeout_ms,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  }))
}

/** 全部插件工具（含停用的），管理页用 */
export async function listAllPluginTools(db: PluginDB): Promise<PluginToolMeta[]> {
  const rows = await db.all<{
    full_name: string
    owner: string
    name: string
    description: string
    input_schema: string
    level: number
    side_effect: string
    timeout_ms: number
    enabled: number
    updated_at: number
  }>(
    `SELECT full_name, owner, name, description, input_schema, level, side_effect, timeout_ms, enabled, updated_at
     FROM {plugin_tools} ORDER BY owner ASC, name ASC`,
  )
  return rows.map((row) => ({
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    description: row.description,
    inputSchema: safeJsonObject(row.input_schema),
    level: row.level,
    sideEffect: (row.side_effect as ToolSideEffect) ?? 'external_write',
    timeoutMs: row.timeout_ms,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  }))
}

export async function setPluginToolEnabled(
  db: PluginDB,
  fullName: string,
  enabled: boolean,
): Promise<void> {
  await db.run(
    `UPDATE {plugin_tools} SET enabled = ?, updated_at = ? WHERE full_name = ?`,
    enabled ? 1 : 0,
    Date.now(),
    fullName,
  )
}

/** 删掉某个插件的全部工具（提供者卸载时该调，但通常调不到，靠管理页兜底） */
export async function removePluginTools(db: PluginDB, owner: string): Promise<void> {
  await db.run(`DELETE FROM {plugin_tools} WHERE owner = ?`, sanitizeToolName(owner))
}

export async function removePluginTool(db: PluginDB, fullName: string): Promise<void> {
  await db.run(`DELETE FROM {plugin_tools} WHERE full_name = ?`, fullName)
}

function safeJsonObject(raw: string): JsonSchema {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonSchema)
      : { type: 'object', properties: {} }
  } catch {
    return { type: 'object', properties: {} }
  }
}

/** 执行函数签名：提供者实现这个 */
export type PluginToolExecutor = (input: unknown) => Promise<unknown>

/** 提供者通过 `services` 暴露的形状 */
export type PluginToolsService = Record<string, PluginToolExecutor>
