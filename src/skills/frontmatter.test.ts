import { describe, expect, it } from 'vitest'
import {
  assertSkillId,
  createSkillMarkdown,
  frontmatterString,
  isSkillId,
  parseSkillMarkdown,
} from './frontmatter.js'

describe('parseSkillMarkdown', () => {
  it('解析 frontmatter 与正文', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: 写作助手', 'description: 帮你把草稿改得更简洁', '---', '', '# 步骤', '1. 通读'].join(
        '\n',
      ),
    )
    expect(parsed.frontmatter['name']).toBe('写作助手')
    expect(parsed.frontmatter['description']).toBe('帮你把草稿改得更简洁')
    expect(parsed.body).toBe('# 步骤\n1. 通读')
  })

  it('没有 frontmatter 时整份当正文（从别处复制来的纯 Markdown 也能直接用）', () => {
    const parsed = parseSkillMarkdown('# 只是一个标题\n正文')
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.body).toBe('# 只是一个标题\n正文')
  })

  it('只开了 --- 却没闭合：退回「整份是正文」，不吞内容', () => {
    const parsed = parseSkillMarkdown('---\nname: x\n正文还在')
    expect(parsed.frontmatter).toEqual({})
    expect(parsed.body).toContain('正文还在')
  })

  it('CRLF 文件也能解析——Windows 上编辑的 SKILL.md 不能静默失效', () => {
    const parsed = parseSkillMarkdown('---\r\nname: a\r\ndescription: b\r\n---\r\n\r\n正文')
    expect(parsed.frontmatter['description']).toBe('b')
    expect(parsed.body).toBe('正文')
  })

  it('引号包起来的标量去掉引号', () => {
    const parsed = parseSkillMarkdown('---\ndescription: "用法: 先查文档"\n---\n正文')
    expect(parsed.frontmatter['description']).toBe('用法: 先查文档')
  })

  it('true/false/数字按标量解析，其余原样当字符串', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'flag: true', 'ratio: 0.5', 'count: 3', 'plain: hello world', '---', '正文'].join('\n'),
    )
    expect(parsed.frontmatter['flag']).toBe(true)
    expect(parsed.frontmatter['ratio']).toBe(0.5)
    expect(parsed.frontmatter['count']).toBe(3)
    expect(parsed.frontmatter['plain']).toBe('hello world')
  })

  it('注释行与不带冒号的行被忽略', () => {
    const parsed = parseSkillMarkdown('---\n# 这是注释\n随便一行\ndescription: d\n---\n正文')
    expect(parsed.frontmatter).toEqual({ description: 'd' })
  })
})

describe('createSkillMarkdown', () => {
  it('与 parseSkillMarkdown 往返一致', () => {
    const markdown = createSkillMarkdown({
      name: '写作助手',
      description: '把草稿改简洁',
      body: '# 步骤\n1. 通读',
    })
    const parsed = parseSkillMarkdown(markdown)
    expect(parsed.frontmatter['name']).toBe('写作助手')
    expect(parsed.frontmatter['description']).toBe('把草稿改简洁')
    expect(parsed.body).toBe('# 步骤\n1. 通读')
  })

  it('描述里有冒号、井号、引号也不会把 YAML 写坏', () => {
    const description = '用法: 先看 "文档" # 再动手'
    const parsed = parseSkillMarkdown(createSkillMarkdown({ name: 'x', description, body: '正文' }))
    expect(parsed.frontmatter['description']).toBe(description)
  })
})

describe('assertSkillId / isSkillId', () => {
  it('接受字母、数字、点、下划线、短横线', () => {
    for (const id of ['writer', 'my-skill', 'my_skill', 'v1.2.3', 'A9']) {
      expect(() => assertSkillId(id)).not.toThrow()
      expect(isSkillId(id)).toBe(true)
    }
  })

  it('拒绝空串、路径分隔符与空格——id 会拼进命令和 URL', () => {
    for (const id of ['', 'a/b', 'a b', '技能', '../etc', 'a?b']) {
      expect(() => assertSkillId(id)).toThrow()
      expect(isSkillId(id)).toBe(false)
    }
  })

  it('拒绝超过 64 字符的 id', () => {
    expect(isSkillId('a'.repeat(64))).toBe(true)
    expect(() => assertSkillId('a'.repeat(65))).toThrow()
  })
})

describe('frontmatterString', () => {
  it('只认非空字符串，数字与布尔值不算', () => {
    const frontmatter = parseSkillMarkdown('---\ndesc: 文字\nnum: 3\ntruth: true\n---\n正文').frontmatter
    expect(frontmatterString(frontmatter, 'desc')).toBe('文字')
    expect(frontmatterString(frontmatter, 'num')).toBeUndefined()
    expect(frontmatterString(frontmatter, 'truth')).toBeUndefined()
    expect(frontmatterString(frontmatter, 'missing')).toBeUndefined()
  })
})
