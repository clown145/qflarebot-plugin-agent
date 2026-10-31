import { afterAll, describe, expect, it } from 'vitest'
import {
  MAX_SKILL_BYTES,
  SKILLS_SCHEMA,
  deleteSkill,
  getSkill,
  getSkillMarkdown,
  listSkills,
  upsertSkill,
} from './store.js'
import { createTestDb } from '../store/sqlite-test-db.js'

/**
 * 测试用 db：**真实 SQLite（Node 22 内置 `node:sqlite`）**，不再是手写内存假件。
 *
 * 为什么换：手写假件会自己实现「应该有的行为」——vfs 那边就因此把两个真实 SQL bug
 * （INSERT 少写 parent、LIKE 少 ESCAPE）掩盖了整整一版。`{skills}` 用到的 SQL
 * 虽然简单（UPSERT / ORDER BY / DELETE），但 UPSERT 的 `excluded.*`、`ORDER BY id`
 * 的排序规则、`NOT NULL` 约束都只有真实 SQLite 才能验证。
 *
 * `createTestDb` 复刻线上的 SQL 规则（`{表名}` 展开、PRAGMA 被拒），
 * 所以这里写的 SQL 与线上走的是同一套检查。
 */

/** 已创建的测试库，测试结束时统一关掉（node:sqlite 是原生句柄） */
const openDbs: Array<ReturnType<typeof createTestDb>> = []

function memoryDb(): ReturnType<typeof createTestDb>['db'] {
  const t = createTestDb()
  openDbs.push(t)
  return t.db
}

afterAll(() => {
  for (const t of openDbs) t.close()
})

function markdown(overrides: { name?: string; description?: string; body?: string } = {}): string {
  return [
    '---',
    `name: ${overrides.name ?? '写作助手'}`,
    `description: ${overrides.description ?? '把草稿改得更简洁'}`,
    '---',
    '',
    overrides.body ?? '# 步骤\n1. 通读\n2. 删掉形容词',
  ].join('\n')
}

describe('SKILLS_SCHEMA', () => {
  it('是 IF NOT EXISTS 的建表语句，重复执行安全', () => {
    const ddl = SKILLS_SCHEMA.join('\n')
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS {skills}')
    expect(ddl).toContain('WITHOUT ROWID')
  })

  it('没有额外索引——技能是几十条的小表，全扫描比维护索引划算', () => {
    expect(SKILLS_SCHEMA).toHaveLength(1)
  })
})

describe('upsertSkill / getSkill', () => {
  it('入库后能原样读回正文与元信息', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: 'writer', content: markdown() })

    const skill = await getSkill(db, 'writer')
    expect(skill?.id).toBe('writer')
    expect(skill?.metadata.name).toBe('写作助手')
    expect(skill?.metadata.description).toBe('把草稿改得更简洁')
    // 正文只存 frontmatter 之后的部分，激活时直接拼进上下文
    expect(skill?.instructions).toBe('# 步骤\n1. 通读\n2. 删掉形容词')
  })

  it('覆盖同一个 id 时更新而不是插入第二行', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: 'writer', content: markdown() })
    await upsertSkill(db, { id: 'writer', content: markdown({ description: '换了个描述' }) })

    const list = await listSkills(db)
    expect(list).toHaveLength(1)
    expect(list[0]?.description).toBe('换了个描述')
  })

  it('name 缺失时回落到 id（目录展示 name 只是锦上添花）', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: 'plain', content: '---\ndescription: 只有描述\n---\n正文' })
    const skill = await getSkill(db, 'plain')
    expect(skill?.metadata.name).toBe('plain')
  })

  it('缺 description 直接拒绝——目录里没有描述的技能等于不存在', async () => {
    const db = memoryDb()
    await expect(upsertSkill(db, { id: 'nodesc', content: '---\nname: x\n---\n正文' })).rejects.toThrow(
      /description/,
    )
  })

  it('正文超过 32KB 拒绝入库', async () => {
    const db = memoryDb()
    const huge = 'a'.repeat(MAX_SKILL_BYTES + 1)
    await expect(upsertSkill(db, { id: 'huge', content: markdown({ body: huge }) })).rejects.toThrow(
      /32/,
    )
  })

  it('空内容与只有 frontmatter 没有正文都拒绝', async () => {
    const db = memoryDb()
    await expect(upsertSkill(db, { id: 'empty', content: '   ' })).rejects.toThrow()
    await expect(
      upsertSkill(db, { id: 'nobody', content: '---\ndescription: d\n---\n' }),
    ).rejects.toThrow(/正文/)
  })

  it('非法 id 在入库前就拒绝', async () => {
    const db = memoryDb()
    await expect(upsertSkill(db, { id: '../etc', content: markdown() })).rejects.toThrow()
  })

  it('id 首尾空白会被 trim', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: '  writer  ', content: markdown() })
    expect(await getSkill(db, 'writer')).not.toBeNull()
  })
})

describe('listSkills', () => {
  it('按 id 升序、且只返回短字段（正文不进内存）', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: 'zeta', content: markdown() })
    await upsertSkill(db, { id: 'alpha', content: markdown({ description: '第一个' }) })

    const list = await listSkills(db)
    expect(list.map((item) => item.id)).toEqual(['alpha', 'zeta'])
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(['description', 'id', 'name'])
  })

  it('空表返回空数组，调用方据此不发目录消息', async () => {
    expect(await listSkills(memoryDb())).toEqual([])
  })

  it('limit 透传，避免一次捞出过多', async () => {
    const db = memoryDb()
    for (const id of ['a', 'b', 'c']) await upsertSkill(db, { id, content: markdown() })
    expect(await listSkills(db, 2)).toHaveLength(2)
  })
})

describe('getSkill / deleteSkill', () => {
  it('不存在返回 null，而不是抛错', async () => {
    expect(await getSkill(memoryDb(), 'missing')).toBeNull()
  })

  it('删除后读不到，再删返回 false', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: 'writer', content: markdown() })
    expect(await deleteSkill(db, 'writer')).toBe(true)
    expect(await getSkill(db, 'writer')).toBeNull()
    expect(await deleteSkill(db, 'writer')).toBe(false)
  })

  it('get/delete 也校验 id，脏 id 不该发出查询', async () => {
    const db = memoryDb()
    await expect(getSkill(db, 'a/b')).rejects.toThrow()
    await expect(deleteSkill(db, '')).rejects.toThrow()
  })
})

describe('getSkillMarkdown（管理页编辑用）', () => {
  it('返回带 frontmatter 的原文，能直接回填编辑框', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: 'writer', content: markdown() })
    const raw = await getSkillMarkdown(db, 'writer')
    expect(raw).toContain('---')
    expect(raw).toContain('description:')
    expect(raw).toContain('# 步骤')
  })

  it('往返可逆：取出来再存回去，字段不变', async () => {
    const db = memoryDb()
    await upsertSkill(db, { id: 'writer', content: markdown({ name: '写作助手', description: '改草稿' }) })
    const raw = await getSkillMarkdown(db, 'writer')
    expect(raw).not.toBeNull()
    // 用取出来的原文再存一次，不该报错、也不该丢字段
    await upsertSkill(db, { id: 'writer', content: raw! })
    const after = await getSkill(db, 'writer')
    expect(after?.metadata.name).toBe('写作助手')
    expect(after?.metadata.description).toBe('改草稿')
  })

  it('不存在的技能返回 null', async () => {
    expect(await getSkillMarkdown(memoryDb(), 'nope')).toBeNull()
  })

  it('非法 id 抛错（会拼进 URL 和主键）', async () => {
    await expect(getSkillMarkdown(memoryDb(), 'bad/id')).rejects.toThrow()
  })

  it('正文里的特殊字符不会被 frontmatter 编码破坏', async () => {
    const db = memoryDb()
    await upsertSkill(db, {
      id: 'quote',
      content: markdown({ description: '描述里有"双引号"和: 冒号' }),
    })
    const raw = await getSkillMarkdown(db, 'quote')
    expect(raw).not.toBeNull()
    await upsertSkill(db, { id: 'quote', content: raw! })
    const after = await getSkill(db, 'quote')
    // 上一轮已修过这个坑：JSON.stringify 写入 + 天真 slice 解析会留下字面 \"
    expect(after?.metadata.description).toBe('描述里有"双引号"和: 冒号')
  })
})
