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
    const match = /^(user|assistant|系统|助手)\s*[:：]\s*(.*)$/i.exec(line)
    if (match) {
      const role = match[1]!.toLowerCase()
      const isUser = role === 'user' || role === '系统'
      const content = match[2]!.trim()
      if (content) turns.push({ role: isUser ? 'user' : 'assistant', content })
      continue
    }
    // 没写前缀的行归给 user：写配置时省一堆「user: 」
    turns.push({ role: 'user', content: line })
  }
  return finalizeBeginDialogs(turns)
}

/**
 * 收尾校正。对标 AstrBot 的 `begin_dialogs` 约定：
 *
 * 1. **必须是偶数条**（一 user 一 assistant 成对）。AstrBot 遇到奇数条
 *    会记 error 并**整段丢弃**（`persona_mgr.py:396-403`）。
 *    这里不整段丢——那对用户太狠，写歪一行就全没了。
 *    改成**丢掉最后一条落单的**，前面的成对部分照常生效。
 * 2. **必须以 user 开头**。以 assistant 开头等于模型先说话，
 *    历史回放时和本轮 user 消息的顺序会变得很怪；AstrBot 靠「第一条固定
 *    是 user」保证这点（`user_turn = True` 起手）。这里直接丢掉开头的
 *    assistant，直到遇到 user。
 *
 * 这两种情况都是「配置写歪了」，所以只做最小修正、不抛错：
 * 人格开场白是锦上添花，写坏了不该让整轮对话失败。
 */
function finalizeBeginDialogs(turns: BeginDialogTurn[]): BeginDialogTurn[] {
  let start = 0
  while (start < turns.length && turns[start]!.role !== 'user') start += 1
  const trimmed = turns.slice(start)
  // 落单的最后一条丢掉（奇数时）
  if (trimmed.length % 2 !== 0) trimmed.pop()
  return trimmed
}

export interface ResolvedPersona {
  /** 生效的人格名；没有可用人格时为 undefined */
  name: string | undefined
  /** 拼进系统提示词的人格段落；没有则 undefined */
  prompt: string | undefined
  beginDialogs: BeginDialogTurn[]
  /**
   * 这套人格允许的工具白名单。`undefined` = 不限。
   *
   * 空数组是有意义的：它表示「这套人格什么工具都不能用」，
   * 与 `undefined`（不限）**含义相反**，所以这里不能用 `?? []` 糊过去
   * （AstrBot 的注释也特意点了这一条：`None` 是全部，空列表是都没有）。
   */
  allowedTools: string[] | undefined
  /**
   * 这套人格可见的技能白名单。`undefined` = 不限。
   *
   * 与 `allowedTools` 同构，也**同样严格区分 `undefined` 与 `[]`**：
   * 前者是全部可见，后者是一个都看不到（AstrBot 的 `Persona.skills` 也是这个语义）。
   */
  allowedSkills: string[] | undefined
  /** 出错时的自定义回复；undefined 用通用文案 */
  customErrorMessage: string | undefined
}

/**
 * 决定这个会话该用哪套人格 / 提示词。
 *
 * ## 人格提示词是「追加」还是「替换」—— 这里刻意跟 AstrBot 一致
 *
 * AstrBot 的做法是（`astr_main_agent.py`）：
 *
 * ```python
 * req.system_prompt += f"\n# Persona Instructions\n\n{prompt}\n"
 * ```
 *
 * 也就是**追加到基础系统提示词后面**，而不是替换它。这个差别很关键：
 * 基础提示词里有一堆运行时约定（当前时间、当前会话、工具使用规范、
 * 回复格式「纯文本不要 Markdown」），替换掉就全丢了 ——
 * 模型会开始输出 Markdown、不知道现在几点、也不知道有工具。
 *
 * 早期这里用的是 `persona.prompt ?? config.system_prompt`（替换），
 * 结果配了人格就丢掉了全部运行时信息。现在改为追加：
 * 基础提示词 + 人格段落。
 *
 * 没有可用人格时返回 `prompt: undefined`，调用方就只用基础提示词。
 */
export function resolvePersona(config: AgentConfig, bound: string | undefined): ResolvedPersona {
  // 会话绑定优先；**绑的那套被删掉时回落到默认人格**（而不是直接放弃）。
  // 这样用户在设置里删掉一套人格，不会让已经绑过它的会话突然失去人格。
  const persona = findPersona(config, bound) ?? findPersona(config, config.default_persona)
  if (!persona) {
    return {
      name: undefined,
      prompt: undefined,
      beginDialogs: [],
      allowedTools: undefined,
      allowedSkills: undefined,
      customErrorMessage: undefined,
    }
  }
  return {
    name: persona.name,
    prompt: persona.prompt?.trim() || undefined,
    beginDialogs: parseBeginDialogs(persona.begin_dialogs),
    // 没有这个字段 = 不限（老配置的语义）
    allowedTools: persona.tools ? [...persona.tools] : undefined,
    allowedSkills: persona.skills ? [...persona.skills] : undefined,
    customErrorMessage: persona.custom_error_message?.trim() || undefined,
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
