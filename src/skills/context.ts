/**
 * 技能的两段上下文注入——**渐进披露**就是全部要点。
 *
 * ## 为什么不是「把所有技能都塞给模型」
 *
 * 一份 SKILL.md 通常 1–8KB（中文约 500–4000 token）。装 5 个技能、每轮都全量带上，
 * 光技能就吃掉一多半上下文预算；而其中绝大多数与当前这句话无关。
 *
 * 所以拆成两段：
 *
 * 1. **目录（每轮都带）**：每行 `- <id>: <description>`，最多 40 行。
 *    在中文下大约 800 token，是**便宜的**、可预测的固定开销。
 *    模型只从它判断「有没有相关技能」。
 * 2. **正文（只在激活时带）**：用户显式 `/skill <id> <task>` 之后，
 *    才把那一份 SKILL.md 全文作为一条单独的 system 消息注入。**贵的**那一份，
 *    因此只会在真的要用的时候出现。
 *
 * 这与 serverless-agent 的做法一致（`core/agent-context.ts:113-147`）：
 * 目录用 `createSkillCatalogMessages`，激活用 `createSkillMessages`。
 *
 * ## 为什么两个函数都只返回字符串
 *
 * 拼 `ModelMessage` 是上下文装配的事，注入位置（在系统提示词之后、历史之前）
 * 也只有 `agent/context.ts` 知道。这里保持纯函数、零依赖：
 * 好测、也不把这个模块绑死在消息协议上。
 */
import type { LoadedSkill, SkillCatalogItem } from './store.js'

/**
 * 目录最多列多少项。与 serverless-agent 的 `agent-context.ts:133` 一致。
 *
 * 40 行是「够用」与「便宜」的折中：少到这个量级，一次目录注入的成本
 * 与系统提示词里一段普通说明相当；再多，就该考虑让运维把技能合并了。
 */
export const SKILL_CATALOG_LIMIT = 40

/**
 * 单条 description 在目录里的展示上限。
 *
 * description 是用户写的，写 500 字它也照样进目录——40 条这样的描述能把
 * 「便宜」直接变成「一轮几千 token」。这里截断而不是拒绝入库：
 * 完整描述在管理页能看到，目录只用第一句。
 */
const MAX_CATALOG_DESCRIPTION = 120

/**
 * 拼技能目录。没有技能时返回 undefined——**不要发一条空消息**，
 * 那只是在每轮里白加几个 token，还会让模型去琢磨"为什么给我一个空技能列表"。
 */
export function buildSkillCatalogPrompt(skills: SkillCatalogItem[]): string | undefined {
  if (skills.length === 0) return undefined

  // 按 id 排序后再截断：调用方的 SQL/数组顺序不该决定「哪 40 个技能可见」，
  // 否则同一份数据在不同查询下给模型看的东西会变。
  const sorted = [...skills].sort((left, right) => left.id.localeCompare(right.id))
  const shown = sorted.slice(0, SKILL_CATALOG_LIMIT)
  const omitted = sorted.length - shown.length

  // 只在超限时提到的这一句：超过 40 个技能时，悄悄丢掉后几个最难排查
  // （运维会以为技能没保存上），所以把「还有几个没列」告诉模型，让它能说明情况。
  const omittedNote = omitted > 0 ? `（另有 ${omitted} 个技能未列出）` : ''

  return [
    '## 可用技能' +
      omittedNote +
      '：用 `/skill <技能id> <任务>` 激活其中一个。目录里只有 id 和描述，' +
      '技能正文只在该技能被激活后才会载入。',
    ...shown.map((skill) => `- ${skill.id}: ${clipDescription(skill.description)}`),
  ].join('\n')
}

/**
 * 拼**已激活**技能的全文。
 *
 * 这一段是「贵的」那一半：调用方只在用户显式 `/skill` 时调用它，
 * 每次 run 最多一份（与 serverless-agent 的「一次 run 最多一个技能」一致）。
 * 函数名里带 Active 是提醒调用方：别把它塞进每轮的固定上下文。
 */
export function buildActiveSkillPrompt(skill: LoadedSkill): string {
  return [
    `## 已激活技能：${skill.id}`,
    `技能名：${skill.metadata.name}`,
    '下面这份说明由技能作者提供，请按它完成当前任务；若与用户的要求冲突，以用户为准。',
    '',
    skill.instructions.trim(),
  ].join('\n')
}

/**
 * 解析 `/skill <id> <task>`。
 *
 * 照搬 serverless-agent 的 `parseExplicitSkillCommand`（`skill-selector.ts:26-38`）。
 * **只认显式命令**，没有语义匹配、也不让模型自己决定加载哪个技能：自动选择意味着
 * 每次对话都要先猜、再加载，等于把「渐进披露」退化成「先全量再说」。
 *
 * 剩下的正文（`userText`）会替代原消息作为这一轮的用户输入——
 * 命令本身不该进模型，否则模型会去回答「/skill」这三个字。
 */
export function parseSkillCommand(text: string): { skillId: string; userText: string } | undefined {
  const match = text.match(/^\/skill\s+([a-zA-Z0-9._-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return undefined
  return {
    skillId: match[1]!,
    userText: match[2]?.trim() ?? '',
  }
}

/** 截断过长的描述；按字符算即可，这里只是控制目录的展示长度 */
function clipDescription(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ')
  return text.length > MAX_CATALOG_DESCRIPTION ? `${text.slice(0, MAX_CATALOG_DESCRIPTION)}…` : text
}
