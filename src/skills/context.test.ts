import { describe, expect, it } from 'vitest'
import {
  SKILL_CATALOG_LIMIT,
  buildActiveSkillPrompt,
  buildSkillCatalogPrompt,
  parseSkillCommand,
} from './context.js'
import type { LoadedSkill, SkillCatalogItem } from './store.js'

function item(id: string, description = `${id} 的描述`): SkillCatalogItem {
  return { id, name: id, description }
}

function loaded(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    id: 'writer',
    metadata: {
      id: 'writer',
      name: '写作助手',
      description: '把草稿改得更简洁',
    },
    instructions: '# 步骤\n1. 通读\n2. 删掉形容词',
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('buildSkillCatalogPrompt（便宜的那一半）', () => {
  it('没有技能时返回 undefined，不发空消息', () => {
    expect(buildSkillCatalogPrompt([])).toBeUndefined()
  })

  it('每个技能一行 `- id: description`', () => {
    const prompt = buildSkillCatalogPrompt([item('alpha'), item('beta')])
    expect(prompt).toContain('- alpha: alpha 的描述')
    expect(prompt).toContain('- beta: beta 的描述')
  })

  it('明确告诉模型「正文只在激活后才载入」——这是渐进披露的关键指令', () => {
    const prompt = buildSkillCatalogPrompt([item('alpha')]) ?? ''
    expect(prompt).toContain('/skill <技能id> <任务>')
    expect(prompt).toContain('只在')
  })

  it('目录里**不含正文**：只经 id 与描述，成本是固定的小常数', () => {
    const prompt = buildSkillCatalogPrompt([item('alpha')]) ?? ''
    expect(prompt).not.toContain('# 步骤')
    // 一行目录 + 一行说明，行数必须可预测
    expect(prompt.split('\n')).toHaveLength(2)
  })

  it(`最多 ${SKILL_CATALOG_LIMIT} 项，与 serverless-agent 的上限一致`, () => {
    const skills = Array.from({ length: 60 }, (_, index) => item(`skill-${String(index).padStart(2, '0')}`))
    const prompt = buildSkillCatalogPrompt(skills) ?? ''
    const lines = prompt.split('\n').filter((line) => line.startsWith('- '))
    expect(lines).toHaveLength(SKILL_CATALOG_LIMIT)
  })

  it('超过上限时告诉模型「还有几个没列」，否则运维会以为技能没保存上', () => {
    const skills = Array.from({ length: 45 }, (_, index) => item(`skill-${index}`))
    const prompt = buildSkillCatalogPrompt(skills) ?? ''
    expect(prompt).toContain('另有 5 个技能未列出')
  })

  it('按 id 排序后截断，结果与传入顺序无关', () => {
    const forward = Array.from({ length: 45 }, (_, index) => item(`skill-${String(index).padStart(2, '0')}`))
    const reversed = [...forward].reverse()
    expect(buildSkillCatalogPrompt(forward)).toBe(buildSkillCatalogPrompt(reversed))
  })

  it('过长的描述被截断，避免一条描述把目录成本顶上去', () => {
    const prompt = buildSkillCatalogPrompt([item('long', 'とても'.repeat(200))]) ?? ''
    const line = prompt.split('\n')[1] ?? ''
    expect(line.length).toBeLessThan(200)
    expect(line.endsWith('…')).toBe(true)
  })

  it('描述里的换行被压成空格，一条技能永远只占一行', () => {
    const prompt = buildSkillCatalogPrompt([item('nl', '第一行\n第二行')]) ?? ''
    expect(prompt.split('\n')).toHaveLength(2)
    expect(prompt).toContain('- nl: 第一行 第二行')
  })
})

describe('buildActiveSkillPrompt（贵的那一半）', () => {
  it('包含完整正文与元信息', () => {
    const prompt = buildActiveSkillPrompt(loaded())
    expect(prompt).toContain('已激活技能：writer')
    expect(prompt).toContain('写作助手')
    expect(prompt).toContain('# 步骤\n1. 通读\n2. 删掉形容词')
  })

  it('正文原样保留段落结构', () => {
    const instructions = '第一段\n\n第二段\n\n- 要点'
    const prompt = buildActiveSkillPrompt(loaded({ instructions }))
    expect(prompt).toContain(instructions)
  })

  it('与用户要求冲突时以用户为准——技能说明不是最高优先级', () => {
    expect(buildActiveSkillPrompt(loaded())).toContain('以用户为准')
  })
})

describe('parseSkillCommand', () => {
  it('解析 id 与后续任务', () => {
    expect(parseSkillCommand('/skill writer 把这段改简洁')).toEqual({
      skillId: 'writer',
      userText: '把这段改简洁',
    })
  })

  it('只有 id 时 userText 是空串', () => {
    expect(parseSkillCommand('/skill writer')).toEqual({ skillId: 'writer', userText: '' })
  })

  it('任务里带换行也整段保留', () => {
    expect(parseSkillCommand('/skill writer 第一行\n第二行')).toEqual({
      skillId: 'writer',
      userText: '第一行\n第二行',
    })
  })

  it('容忍多余空白', () => {
    expect(parseSkillCommand('  /skill   writer   任务  ')).toBeUndefined()
    expect(parseSkillCommand('/skill  writer 任务')).toEqual({ skillId: 'writer', userText: '任务' })
  })

  it('不是 /skill 开头的输入一律不匹配（普通聊天不该被误判）', () => {
    for (const text of ['/skill', '/skills writer', 'skill writer', '/skill a/b', '请用 /skill writer']) {
      expect(parseSkillCommand(text)).toBeUndefined()
    }
  })
})
