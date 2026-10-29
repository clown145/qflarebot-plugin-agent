/**
 * SKILL.md 的解析：`---` 包起来的头 + 正文。
 *
 * 照搬 serverless-agent 的 `src/skills/skill-frontmatter.ts`（91 行）。
 * 它对 YAML 的解析是**故意偷懒**的：只认 `key: value` 一行一个标量，
 * 不支持嵌套、数组、多行字符串。理由：
 *
 * - 本插件不是给人写复杂配置用的。SKILL.md 的头只有 name / description 两个字段
 *   （外加原文里可选的 version），为此拉一个 YAML 库（yaml ~50KB、js-yaml 100KB+）
 *   会让 Workers 包体白白变大，而每次解析还得多吃 CPU（免费版全机器人共享 10ms）。
 * - 真正的技能正文是 Markdown，不需要 YAML 语义；写歪了的头最多丢一个字段，
 *   而丢 description 的后果已经在 store.ts 里被拦截（直接拒绝入库）。
 *
 * 与原文的唯一差异：先把 CRLF 归一化成 LF。运维修 SKILL.md 大多在 Windows 上，
 * 而 `---\n` 的头部判定和按行切分都假定 LF——不归一化的话整份文件会被当成
 * 「没有 frontmatter 的正文」，于是这条技能从目录里静默消失（最难查的那类 bug）。
 */

export interface SkillFrontmatter {
  name?: string
  description?: string
  /** 原文有、插件暂不消费；留着是为了兼容从 serverless-agent 搬过来的技能 */
  version?: string
  [key: string]: unknown
}

export interface ParsedSkillMarkdown {
  frontmatter: SkillFrontmatter
  body: string
}

/** 技能 id 允许的字符。限制字符集是为了让 id 能安全出现在命令、URL 路径和日志里 */
const SKILL_ID_PATTERN = /^[a-zA-Z0-9._-]+$/

/** 上限 64：目录里每行都以 id 开头，太长的 id 纯粹是在烧 token */
const MAX_SKILL_ID_LENGTH = 64

export function isSkillId(skillId: string): boolean {
  return skillId.length >= 1 && skillId.length <= MAX_SKILL_ID_LENGTH && SKILL_ID_PATTERN.test(skillId)
}

/**
 * 校验技能 id，不合法直接抛错。
 *
 * 与原文的 `assertSkillId` 同义，但**必须**在这里拦：id 会拼进 `/skill <id>` 命令、
 * 管理接口的路径和 D1 的主键，脏 id 一旦进库，后面每个读取点都得重复防御。
 */
export function assertSkillId(skillId: string): void {
  if (!isSkillId(skillId)) {
    throw new Error(
      `技能 id 只能包含字母、数字、点、下划线和短横线，长度 1-${MAX_SKILL_ID_LENGTH}：${JSON.stringify(skillId)}`,
    )
  }
}

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  // 归一化换行，见文件头注释
  const text = content.replace(/\r\n/g, '\n')

  if (!text.startsWith('---\n')) {
    // 没有头就整份当正文。不报错：从别处复制来的纯 Markdown 说明也能直接用
    return { frontmatter: {}, body: text.trimStart() }
  }

  const end = text.indexOf('\n---', 4)
  if (end === -1) {
    // 开了头却没闭合：同样退回「整份是正文」。
    // 宁可让 description 缺失触发入库校验（能看见的错），也不要吞掉半份内容
    return { frontmatter: {}, body: text.trimStart() }
  }

  const rawFrontmatter = text.slice(4, end)
  const bodyStart = text.indexOf('\n', end + 4)
  return {
    frontmatter: parseSimpleYamlFrontmatter(rawFrontmatter),
    body: text.slice(bodyStart === -1 ? end + 4 : bodyStart + 1).trimStart(),
  }
}

/** 反向拼一份 SKILL.md。管理页保存和测试的 round-trip 都走这个 */
export function createSkillMarkdown(input: { name: string; description: string; body: string }): string {
  return [
    '---',
    `name: ${quoteYamlScalar(input.name)}`,
    `description: ${quoteYamlScalar(input.description)}`,
    '---',
    '',
    input.body.trimStart(),
  ].join('\n')
}

/**
 * 取一个「可信字符串」字段：只认非空字符串并 trim。
 *
 * frontmatter 的值来自用户输入（`unknown`），`getSkill` 的每个消费点都直接
 * `as string` 会埋雷——一个 `description: 123` 就能把目录拼成 `- id: 123` 之外的东西。
 */
export function frontmatterString(frontmatter: SkillFrontmatter, key: string): string | undefined {
  const value = frontmatter[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseSimpleYamlFrontmatter(value: string): SkillFrontmatter {
  const frontmatter: SkillFrontmatter = {}
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    // 空行与注释跳过
    if (!trimmed || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf(':')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    const raw = trimmed.slice(separator + 1).trim()
    if (!key) continue
    frontmatter[key] = parseYamlScalar(raw)
  }
  return frontmatter
}

/** 只认三种标量：引号字符串、true/false、数字。其余原样当字符串 */
function parseYamlScalar(value: string): unknown {
  // 双引号交给 JSON 解：写出去的正是 JSON.stringify，读回来必须做它的逆运算，
  // 否则描述里的 `"` 和反斜杠会带着转义符进入目录（原文这里只 slice 掉引号，
  // 于是 create → parse 的往返对含引号的描述不成立）。
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : value.slice(1, -1)
    } catch {
      // 手写的非法 JSON 不该让整份技能解析失败，退回裸 slice
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

/**
 * 用 JSON 引号包一层再写出去。
 *
 * 这样 description 里的 `:`、`#`、引号都不会把 YAML 写坏，而且
 * `JSON.stringify` 的转义正好是 YAML 双引号字符串认识的子集——
 * 不引号的话「description: 用法: 先查文档」这种写法会被解析成 `用法`，静默丢半句。
 */
function quoteYamlScalar(value: string): string {
  return JSON.stringify(value)
}
