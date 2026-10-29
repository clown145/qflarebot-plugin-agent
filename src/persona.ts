/**
 * 人格（persona）：多套人格定义 + 按会话绑定。
 *
 * 对标 AstrBot 的 persona 机制：
 *
 * - **多套并存**：一个机器人可以配若干人格（配置里的 `personas`），每个会话绑一套。
 * - **begin_dialogs（开场对话）**：每轮都插在历史最前面的一小段对话，用来锚定风格。
 *   AstrBot 把它插在 `req.contexts[:0]`（即历史最前），这里保持一致。
 * - **按会话绑定**：绑定的名字存在 D1 的 `{conversations}` 表里（跨会话可查，管理页要看）。
 *   不用 KV：绑定时要能列出「这个机器人都绑了什么」。
 *
 * ## 与 `system_prompt` 的关系
 *
 * `system_prompt` 是「没有人格时的兜底」。优先级：会话绑定的人格 > `default_persona` > `system_prompt`。
 * 这样老用户不改配置也照常工作，新用户可以用人格做多角色。
 */
import type { PluginDB } from '@qqbot/sdk'
import type { AgentConfig, PersonaConfig } from './config/index.js'

/** 会话绑定的人格名存在 D1；与 `{sessions}` 表一行一会话 */
export interface PersonaBinding {
  conversation: string
  persona: string
  updated_at: number
}

/** 解析后的「开场对话」一行 */
export interface BeginDialogTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 按名字找人格。找不到返回 null，由调用方回落到 `default_persona` / `system_prompt`。
 */
export function findPersona(config: AgentConfig, name: string | undefined): PersonaConfig | null {
  const key = (name ?? '').trim()
  if (!key) return null
  return (config.personas ?? []).find((persona) => persona.name.trim() === key) ?? null
}

/**
 * 解析 `begin_dialogs` 文本。
 *
 * 每行一句，`user:` / `assistant:` 开头；不带前缀的行归给 user（写起来省事）。
 * 空行忽略。坏行忽略而不是抛错——配置写歪了不该让整轮对话失败。
 */
export function parseBeginDialogs(text: string | undefined): BeginDialogTurn[] {
  if (!text) return []
  const turns: BeginDialogTurn[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(user|assistant|系统|assistant|助手)\s*[:：]\s*(.*)$/i.exec(line)
    if (match) {
      const role = match[1]!.toLowerCase()
      const isUser = role === 'user' || role === '系统'
      const content = match[2]!.trim()
      if (content) turns.push({ role: isUser ? 'user' : 'assistant', content })
      continue
    }
    turns.push({ role: 'user', content: line })
  }
  return turns
}

/**
 * 决定这个会话该用哪套人格 / 提示词。
 *
 * 返回 `prompt` 与 `beginDialogs`；没有可用人格时 `prompt` 为 undefined，
 * 调用方继续用 `system_prompt`（内置默认人格）。
 */
export function resolvePersona(
  config: AgentConfig,
  bound: string | undefined,
): { name: string | undefined; prompt: string | undefined; beginDialogs: BeginDialogTurn[] } {
  // 会话绑定优先；**绑的那套被删掉时回落到默认人格**（而不是直接放弃）。
  // 这样用户在设置里删掉一套人格，不会让已经绑过它的会话突然失去人格。
  const persona = findPersona(config, bound) ?? findPersona(config, config.default_persona)
  if (!persona) return { name: undefined, prompt: undefined, beginDialogs: [] }
  return {
    name: persona.name,
    prompt: persona.prompt?.trim() || undefined,
    beginDialogs: parseBeginDialogs(persona.begin_dialogs),
  }
}

/** 读会话绑定的人格名；没绑过返回 undefined */
export async function getPersonaBinding(db: PluginDB, conversation: string): Promise<string | undefined> {
  const row = await db.first<{ persona: string }>(
    `SELECT persona FROM {conversations} WHERE conversation = ?`,
    conversation,
  )
  const value = row?.persona?.trim()
  return value ? value : undefined
}

/**
 * 绑定 / 解绑。返回是否真的改动。
 *
 * 解绑（传空串）时删掉整行——没有别的字段要留。
 */
export async function setPersonaBinding(
  db: PluginDB,
  conversation: string,
  persona: string | undefined,
): Promise<boolean> {
  const name = (persona ?? '').trim()
  if (!name) {
    const removed = await db.run(`DELETE FROM {conversations} WHERE conversation = ?`, conversation)
    return removed.changes > 0
  }
  await db.run(
    `INSERT INTO {conversations} (conversation, persona, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(conversation) DO UPDATE SET persona = excluded.persona, updated_at = excluded.updated_at`,
    conversation,
    name,
    Date.now(),
  )
  return true
}

/** 列出所有绑定了人格的会话（管理页用） */
export async function listPersonaBindings(db: PluginDB, limit = 50): Promise<PersonaBinding[]> {
  return db.all<PersonaBinding>(
    `SELECT conversation, persona, updated_at FROM {conversations} ORDER BY updated_at DESC LIMIT ?`,
    limit,
  )
}
