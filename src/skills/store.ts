/**
 * 技能的存储层：一张 D1 表，四个操作。
 *
 * ## 为什么是独立表，而不是复用 vfs
 *
 * vfs 已经能用（`{vfs_entries}` 元数据 + 大文件进 R2），把技能放成
 * `/skills/<id>/SKILL.md` 看着更"统一"。但这里选了**独立表**，理由是三条实际约束：
 *
 * 1. **读的次数远多于写**。目录每轮都要拼（见 context.ts），而 vfs 读一次要
 *    先查元数据、再判断内容在 D1 还是 R2、必要时再打一次 R2——那是 2 次往返起步。
 *    独立表一次 `SELECT id, name, description` 就够，且只取短字段，
 *    不把几 KB 的正文捞进内存。
 * 2. **vfs 是"模型可写"的**。模型手上就有 `vfs.write_file`，技能要是也放在 vfs 里，
 *    等于模型能自己改写自己的技能——包括改掉别人写好的技能。独立表把「谁在写」
 *    收窄到管理接口与运维命令两处。
 * 3. **技能的语义不是文件**。没有目录树、没有版本、没有权限位，只有「一个 id 对应
 *    一份说明」。用文件系统去表达它，只会把 vfs 那套路径解析、父目录创建、
 *    R2 孤儿清理都拖进来。
 *
 * 代价是写入算 D1 的行数（按免费版 10 万行/日算，一次 upsert 约 2 行）。
 * 但技能是**运维偶尔才写一次**的数据，不是每条消息都写——这与对话历史的写入量
 * 完全脱钩，可以接受。
 *
 * ## 表结构不在这里建
 *
 * DDL 导出成 `SKILLS_SCHEMA`，由 `src/store/schema.ts` 的 `SCHEMA_STATEMENTS`
 * 统一收集、`onInstall` / `onBoot` 统一执行。理由：建表只该有一个入口，
 * 分散到各模块后「升级后新表没建」这种问题会变成逐个文件排查。
 */
import type { PluginDB } from '@qqbot/sdk'
import {
  assertSkillId,
  createSkillMarkdown,
  frontmatterString,
  parseSkillMarkdown,
} from './frontmatter.js'

/**
 * 建表语句。由 `src/store/schema.ts` 追加进 `SCHEMA_STATEMENTS`。
 *
 * 用 `WITHOUT ROWID`：主键是 TEXT，行也小，省掉一层间接寻址——与库里其它表保持一致。
 *
 * 没有额外索引：唯一的高频查询是「列出全部技能」的全表扫描，而技能数量是几十的量级，
 * 扫一张小表比维护索引更划算。`ORDER BY id` 走的正是主键顺序，也不需要索引。
 */
export const SKILLS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS {skills} (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     description TEXT NOT NULL,
     body TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) WITHOUT ROWID`,
] as const

/**
 * 单份 SKILL.md 的大小上限（32KB）。
 *
 * 正文是**激活后整段塞进上下文**的，而上下文预算是按 token 算的：32KB 中文大约
 * 1.6 万 token，已经逼近一次请求的合理上限。超过这个体积的技能说明不该靠"加载"
 * 塞给模型，应该拆成多个技能或多用工具去查。入库时就拒掉，比在对话里炸上下文便宜。
 */
export const MAX_SKILL_BYTES = 32 * 1024

/** 目录里一项。只有 id 和一句 description，这正是"便宜"的来源 */
export interface SkillCatalogItem {
  id: string
  name: string
  description: string
}

/** 技能的元信息。对齐 serverless-agent 的 `SkillMetadata`，但**去掉了 version** */
export interface SkillMetadata {
  id: string
  name: string
  description: string
}

/** 一份**已激活**的技能：元信息 + 完整正文 */
export interface LoadedSkill {
  id: string
  metadata: SkillMetadata
  /** SKILL.md 去掉 frontmatter 之后的正文 */
  instructions: string
  updatedAt: number
}

/** `{skills}` 表的一行，只给内部反序列化用 */
interface SkillRow {
  id: string
  name: string
  description: string
  body: string
  updated_at: number
}

/**
 * 列出全部技能，按 id 升序。
 *
 * **只查短字段**：正文可能几 KB，而调用方（拼目录、管理页列表）都不需要它。
 * 真要正文请一次只取一份（`getSkill`）。这就是渐进披露在存储层的体现。
 */
export async function listSkills(db: PluginDB, limit = 100): Promise<SkillCatalogItem[]> {
  const rows = await db.all<Pick<SkillRow, 'id' | 'name' | 'description'>>(
    `SELECT id, name, description FROM {skills} ORDER BY id ASC LIMIT ?`,
    limit,
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
  }))
}

/** 取一份完整技能。不存在返回 null（而不是抛错：调用方要能区分"没有"和"读崩了"） */
export async function getSkill(db: PluginDB, id: string): Promise<LoadedSkill | null> {
  assertSkillId(id)
  const row = await db.first<SkillRow>(
    `SELECT id, name, description, body, updated_at FROM {skills} WHERE id = ?`,
    id,
  )
  if (!row) return null
  return {
    id: row.id,
    metadata: {
      id: row.id,
      name: row.name,
      description: row.description,
    },
    instructions: row.body,
    updatedAt: row.updated_at,
  }
}

/**
 * 新建或覆盖一份技能。`content` 是完整的 SKILL.md 原文。
 *
 * 三道校验，都在入库前做——脏数据一旦进库，后面每个读取点都要重复防御：
 *
 * 1. **id 合法**：它会拼进命令、URL 和主键。
 * 2. **正文不超 32KB**：见 `MAX_SKILL_BYTES`。
 * 3. **frontmatter 必须有 description**：目录里一行就是 `- <id>: <description>`，
 *    没有描述的技能在目录里等于不存在——模型不知道该不该激活它。
 *    serverless-agent 在加载时抛这个错（`skill-loader.ts`），这里提前到写入时，
 *    运维当场就知道写漏了，而不是等到某次对话才发现技能"消失"。
 *
 * 返回落库后的元信息，方便调用方直接回显。
 */
export async function upsertSkill(
  db: PluginDB,
  input: { id: string; content: string },
): Promise<SkillCatalogItem> {
  const id = input.id.trim()
  assertSkillId(id)

  const content = input.content
  if (!content.trim()) throw new Error(`技能 ${id} 的 SKILL.md 是空的`)

  // 按字节而不是字符算：D1 的存储上限与网络传输都按字节，中文一个字 3 字节
  const bytes = new TextEncoder().encode(content).byteLength
  if (bytes > MAX_SKILL_BYTES) {
    throw new Error(
      `技能 ${id} 的 SKILL.md 有 ${bytes} 字节，超过上限 ${MAX_SKILL_BYTES} 字节（正文是激活后整段进上下文的，太大请拆成多个技能）`,
    )
  }

  const parsed = parseSkillMarkdown(content)
  const description = frontmatterString(parsed.frontmatter, 'description')
  if (!description) {
    throw new Error(`技能 ${id} 的 frontmatter 缺少 description；目录只展示 id 与描述，没有描述就无法被选中`)
  }
  // name 缺失时回落到 id：目录里展示 name 只是锦上添花，不该因此拒绝入库
  const name = frontmatterString(parsed.frontmatter, 'name') ?? id
  const body = parsed.body.trim()
  if (!body) throw new Error(`技能 ${id} 的 SKILL.md 只有 frontmatter，没有正文`)

  await db.run(
    `INSERT INTO {skills} (id, name, description, body, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       body = excluded.body,
       updated_at = excluded.updated_at`,
    id,
    name,
    description,
    body,
    Date.now(),
  )

  return { id, name, description }
}

/**
 * 取技能的**原始 SKILL.md 全文**（含 frontmatter），给编辑界面用。
 *
 * 为什么需要这个而不是复用 `getSkill`：表里存的是**解析后**的字段
 * （`name` / `description` / `body`），拼不回原文——frontmatter 的其它字段、
 * 书写顺序、注释都会丢。管理页要「打开 → 改 → 存」保持原样，
 * 就必须能拿到原文。
 *
 * 这里用 `createSkillMarkdown` 重建：它保证 name/description 一定在，
 * 而这两项正是入库时唯一被保留的 frontmatter。对编辑场景够用
 * （其它自定义 frontmatter 本来就没被读），且不会出现"编辑一次就丢字段"。
 */
export async function getSkillMarkdown(db: PluginDB, id: string): Promise<string | null> {
  assertSkillId(id)
  const row = await db.first<SkillRow>(
    `SELECT id, name, description, body, updated_at FROM {skills} WHERE id = ?`,
    id,
  )
  if (!row) return null
  return createSkillMarkdown({
    name: row.name,
    description: row.description,
    body: row.body,
  })
}

/** 删除一份技能。返回是否真的删掉了（不存在时 false，调用方好回一句"没找到"） */
export async function deleteSkill(db: PluginDB, id: string): Promise<boolean> {
  assertSkillId(id)
  const result = await db.run(`DELETE FROM {skills} WHERE id = ?`, id)
  return result.changes > 0
}
