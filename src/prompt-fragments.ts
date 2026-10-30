/**
 * 插件间提示词扩展：别的插件可以往本插件的 system prompt 里插一段话。
 *
 * ## 为什么需要
 *
 * 对标 AstrBot 的 `OnLLMRequestEvent`（插件能在每次 LLM 请求前改 `req`）
 * 和 `EXTRA_PROMPT.md`（运维写文件就追加指令）。
 *
 * QFlareBot 没有插件钩子机制，但**有 `services`**：插件可以导出对象、
 * 别的插件通过 `ctx.service('agent')` 取用。所以做成服务方法。
 *
 * ## 为什么必须落库
 *
 * 宿主 SDK 对 `services` 的限制是明确的：
 *
 * > 工厂**每个请求**调用一次……也做不了「别的插件来登记」式的接口——
 * > 这次请求登记的，下次就没了。
 *
 * 所以 `register()` 不能只存在内存里，必须写 D1。注入时读回来。
 *
 * ## 安全边界
 *
 * 1. **只能追加，不能改**：片段拼在 system prompt 末尾，改不了基础指令、
 *    人格、工具规范。想篡改那些只能改自己的片段。
 * 2. **长度上限**：每个片段 2000 字符。不设限的话一个插件塞几万字进来，
 *    别人的 token 账单直接爆掉。
 * 3. **落库前不执行任何代码**：片段是纯文本，不做模板替换——
 *    否则等于给其他插件一个「在本插件上下文里求值」的口子。
 * 4. **按 plugin 去重**：一个插件一份，重复注册是覆盖而不是追加，
 *    避免某插件每次请求都注册一次导致无限增长。
 *
 * ## 缓存影响（重要）
 *
 * 片段拼在 system prompt **末尾**，属于「稳定内容」的一部分——
 * 只要插件不改它，前缀就是稳的。但**如果某个插件每轮都改片段，
 * 会把整段 system 的缓存击穿**。
 *
 * 所以：注册是**显式动作**（调 register），不是每轮自动拼；
 * 而且片段内容变了才算变（写库前比对，相同就不写）。
 */
import type { PluginDB } from '@qqbot/sdk'

/** 每个片段的最大长度。超出直接拒绝，不做静默截断——截断会让插件以为写进去了 */
export const MAX_FRAGMENT_BYTES = 2000

/** 一次最多注入几个插件的片段。防止某个部署被插件刷屏 */
export const MAX_FRAGMENTS = 8

export interface PromptFragment {
  plugin: string
  fragment: string
  /** 越大越靠前。同优先级按 plugin 名字排序，保证跨轮稳定（缓存） */
  priority: number
  enabled: boolean
  updatedAt: number
}

export interface AgentPromptService {
  /**
   * 注册（或覆盖）本插件的提示词片段。
   *
   * @param plugin 调用方插件名。用自己的 `ctx.plugin.name`，别写死别人的名字
   * @param fragment 要追加到 system prompt 末尾的文本
   * @param priority 越大越靠前，默认 0
   * @returns 写入结果；`false` 表示内容没变、未产生写入（省 D1 写额度）
   */
  registerPrompt(plugin: string, fragment: string, priority?: number): Promise<boolean>
  /** 停用但保留内容（卸载前的软手段） */
  disablePrompt(plugin: string): Promise<void>
  /** 彻底删除 */
  clearPrompt(plugin: string): Promise<void>
  /** 读当前全部片段（排障用） */
  listPrompts(): Promise<PromptFragment[]>
}

/** 校验片段。返回 null = 通过，否则是可读错误 */
export function validateFragment(fragment: unknown): string | null {
  if (typeof fragment !== 'string') return '片段必须是字符串'
  if (!fragment.trim()) return '片段不能为空'
  const bytes = new TextEncoder().encode(fragment).byteLength
  if (bytes > MAX_FRAGMENT_BYTES) {
    return `片段 ${bytes} 字节，超过上限 ${MAX_FRAGMENT_BYTES} 字节。请精简后再注册`
  }
  return null
}

/**
 * 读所有启用中的片段，按 priority 降序、plugin 名字升序排列。
 *
 * **排序必须稳定**：同样的片段集合要产生同样的拼接结果，否则每轮顺序抖动
 * 会击穿 system 的缓存。所以同优先级时按 plugin 名字而不是写入时间排。
 */
export async function listActiveFragments(db: PluginDB): Promise<PromptFragment[]> {
  const rows = await db.all<{
    plugin: string
    fragment: string
    priority: number
    enabled: number
    updated_at: number
  }>(
    `SELECT plugin, fragment, priority, enabled, updated_at FROM {prompt_fragments}
     WHERE enabled = 1 ORDER BY priority DESC, plugin ASC LIMIT ?`,
    MAX_FRAGMENTS,
  )

  return rows.map((row) => ({
    plugin: row.plugin,
    fragment: row.fragment,
    priority: row.priority,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  }))
}

/** 全部片段（含停用的），管理页与排障用 */
export async function listAllFragments(db: PluginDB): Promise<PromptFragment[]> {
  const rows = await db.all<{
    plugin: string
    fragment: string
    priority: number
    enabled: number
    updated_at: number
  }>(
    `SELECT plugin, fragment, priority, enabled, updated_at FROM {prompt_fragments}
     ORDER BY priority DESC, plugin ASC`,
  )
  return rows.map((row) => ({
    plugin: row.plugin,
    fragment: row.fragment,
    priority: row.priority,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  }))
}

/**
 * 写入片段。内容与优先级都没变时不写库。
 *
 * 为什么不无脑 UPSERT：`register()` 可能被插件在**每个请求**里调用
 * （它是个幂等的「确保已注册」，插件图省事就这么写）。每次也写一次 D1
 * 的话，一条消息就是一行写入——D1 免费版才 10 万行/日，撑不住。
 *
 * 返回 `true` = 真的写了。
 */
export async function upsertFragment(
  db: PluginDB,
  input: { plugin: string; fragment: string; priority?: number },
): Promise<boolean> {
  const plugin = input.plugin.trim()
  if (!plugin) throw new Error('缺少 plugin 名')

  const error = validateFragment(input.fragment)
  if (error) throw new Error(error)

  const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0

  const existing = await db.first<{ fragment: string; priority: number }>(
    `SELECT fragment, priority FROM {prompt_fragments} WHERE plugin = ?`,
    plugin,
  )
  if (existing && existing.fragment === input.fragment && existing.priority === priority) {
    return false
  }

  await db.run(
    `INSERT INTO {prompt_fragments} (plugin, fragment, priority, enabled, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(plugin) DO UPDATE SET
       fragment = excluded.fragment,
       priority = excluded.priority,
       enabled = 1,
       updated_at = excluded.updated_at`,
    plugin,
    input.fragment,
    priority,
    Date.now(),
  )
  return true
}

export async function setFragmentEnabled(
  db: PluginDB,
  plugin: string,
  enabled: boolean,
): Promise<void> {
  await db.run(
    `UPDATE {prompt_fragments} SET enabled = ?, updated_at = ? WHERE plugin = ?`,
    enabled ? 1 : 0,
    Date.now(),
    plugin.trim(),
  )
}

export async function removeFragment(db: PluginDB, plugin: string): Promise<void> {
  await db.run(`DELETE FROM {prompt_fragments} WHERE plugin = ?`, plugin.trim())
}

/**
 * 把片段拼成一段可注入的文本。没有片段时返回 undefined（不注入空段落）。
 *
 * 格式：每个片段带 `## 来自插件 <name>` 标题，让模型知道这段话的出处——
 * 出问题时能对得上是哪个插件塞进来的。
 */
export function buildFragmentBlock(fragments: PromptFragment[]): string | undefined {
  if (!fragments.length) return undefined
  const parts = fragments.map(
    (item) => `## 来自插件 ${item.plugin}\n${item.fragment.trim()}`,
  )
  return parts.join('\n\n')
}
