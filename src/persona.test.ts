import { describe, expect, it } from 'vitest'
import type { PluginDB } from '@qqbot/sdk'
import {
  findPersona,
  parseBeginDialogs,
  resolvePersona,
  setPersonaBinding,
  getPersonaBinding,
  listPersonaBindings,
} from './persona.js'
import { defaultConfig, type AgentConfig } from './config/index.js'

/**
 * 人格（对标 AstrBot 的 persona）：多套定义、按会话绑定、begin_dialogs。
 * 以及优先级：会话绑定 > 配置默认人格 > system_prompt。
 */

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultConfig, ...overrides }
}

const personas = [
  { name: 'cat', prompt: '你是一只猫，说话带「喵」。', begin_dialogs: 'user: 你好\nassistant: 喵～' },
  { name: 'butler', prompt: '你是管家，说话正式。', begin_dialogs: '' },
]

describe('findPersona', () => {
  it('按名字精确找', () => {
    expect(findPersona(config({ personas }), 'cat')?.prompt).toContain('猫')
  })

  it('名字两侧空白不影响', () => {
    expect(findPersona(config({ personas }), '  cat  ')?.name).toBe('cat')
  })

  it('找不到 / 空名字返回 null', () => {
    expect(findPersona(config({ personas }), 'dog')).toBeNull()
    expect(findPersona(config({ personas }), '')).toBeNull()
    expect(findPersona(config({ personas }), undefined)).toBeNull()
  })
})

describe('parseBeginDialogs', () => {
  it('解析 user/assistant 两种角色', () => {
    expect(parseBeginDialogs('user: 你好\nassistant: 喵～')).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '喵～' },
    ])
  })

  it('中文冒号也认', () => {
    expect(parseBeginDialogs('user：你好\nassistant：在')).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
    ])
  })

  it('不带前缀的行归给 user（写起来省事）', () => {
    // 单行归给 user 之后是「落单的一条」，会被成对校正丢掉 —— 见下一个 describe。
    // 要让它生效，必须配成一对：user 行 + assistant 行。
    expect(parseBeginDialogs('随便一句话\nassistant: 回你一句')).toEqual([
      { role: 'user', content: '随便一句话' },
      { role: 'assistant', content: '回你一句' },
    ])
  })

  it('空行与纯空白行忽略', () => {
    expect(parseBeginDialogs('user: a\n\n   \nassistant: b')).toHaveLength(2)
  })

  it('空文本返回空数组', () => {
    expect(parseBeginDialogs('')).toEqual([])
    expect(parseBeginDialogs(undefined)).toEqual([])
  })
})

describe('resolvePersona：优先级', () => {
  it('会话绑定的人格优先', () => {
    const resolved = resolvePersona(config({ personas, default_persona: 'butler' }), 'cat')
    expect(resolved.name).toBe('cat')
    expect(resolved.prompt).toContain('猫')
  })

  it('没绑定时用配置的默认人格', () => {
    const resolved = resolvePersona(config({ personas, default_persona: 'butler' }), undefined)
    expect(resolved.name).toBe('butler')
  })

  it('绑定的人格不存在时回落到默认人格', () => {
    // 用户删掉了一套人格、但会话还绑着它——不该让对话失败
    const resolved = resolvePersona(config({ personas, default_persona: 'butler' }), 'deleted-persona')
    expect(resolved.name).toBe('butler')
  })

  it('都没有时 prompt 为 undefined，由调用方用 system_prompt', () => {
    const resolved = resolvePersona(config({ personas }), undefined)
    expect(resolved.name).toBeUndefined()
    expect(resolved.prompt).toBeUndefined()
    expect(resolved.beginDialogs).toEqual([])
  })

  it('begin_dialogs 一起解析出来', () => {
    const resolved = resolvePersona(config({ personas }), 'cat')
    expect(resolved.beginDialogs).toHaveLength(2)
  })
})

/** 只实现 persona.ts 用到的那几条 SQL 的内存替身 */
function memoryDb(): PluginDB & { rows: Map<string, { persona: string; updated_at: number }> } {
  const rows = new Map<string, { persona: string; updated_at: number }>()
  return {
    rows,
    async run(sql: string, ...params: unknown[]) {
      if (sql.includes('DELETE FROM {conversations}')) {
        return { changes: rows.delete(String(params[0])) ? 1 : 0 }
      }
      if (sql.includes('INSERT INTO {conversations}')) {
        const [conversation, persona, updatedAt] = params as [string, string, number]
        rows.set(conversation, { persona, updated_at: updatedAt })
        return { changes: 1 }
      }
      return { changes: 0 }
    },
    async first<T>(sql: string, ...params: unknown[]) {
      if (sql.includes('SELECT persona FROM {conversations}')) {
        return (rows.get(String(params[0])) ?? null) as T | null
      }
      return null
    },
    async all<T>(sql: string) {
      if (sql.includes('SELECT conversation, persona, updated_at FROM {conversations}')) {
        return [...rows.entries()]
          .map(([conversation, value]) => ({ conversation, ...value }))
          .sort((a, b) => b.updated_at - a.updated_at) as T[]
      }
      return []
    },
    async exec() {},
    table: (name: string) => `p_agent_${name}`,
  } as unknown as PluginDB & { rows: typeof rows }
}

describe('会话绑定', () => {
  it('绑定后能读回', async () => {
    const db = memoryDb()
    await setPersonaBinding(db, 'group:G1', 'cat')
    expect(await getPersonaBinding(db, 'group:G1')).toBe('cat')
  })

  it('覆盖绑定', async () => {
    const db = memoryDb()
    await setPersonaBinding(db, 'group:G1', 'cat')
    await setPersonaBinding(db, 'group:G1', 'butler')
    expect(await getPersonaBinding(db, 'group:G1')).toBe('butler')
  })

  it('传空串清除绑定', async () => {
    const db = memoryDb()
    await setPersonaBinding(db, 'group:G1', 'cat')
    await setPersonaBinding(db, 'group:G1', undefined)
    expect(await getPersonaBinding(db, 'group:G1')).toBeUndefined()
  })

  it('没绑定过返回 undefined（不抛）', async () => {
    const db = memoryDb()
    expect(await getPersonaBinding(db, 'group:nope')).toBeUndefined()
  })

  it('列出所有绑定，按更新时间倒序', async () => {
    const db = memoryDb()
    await setPersonaBinding(db, 'group:G1', 'cat')
    await setPersonaBinding(db, 'c2c:U1', 'butler')
    const list = await listPersonaBindings(db)
    expect(list.map((row) => row.conversation)).toContain('group:G1')
    expect(list.map((row) => row.conversation)).toContain('c2c:U1')
  })
})

/**
 * 本轮补齐的三处 AstrBot 对齐点：
 * 1. 人格提示词是**追加**还是替换
 * 2. 人格可以**限制工具**（Persona.tools）
 * 3. 人格可以**自定义错误文案**（Persona.custom_error_message）
 */
describe('人格的工具白名单（对标 AstrBot 的 Persona.tools）', () => {
  it('没配 tools 时是 undefined（不限），不是空数组', () => {
    const resolved = resolvePersona(
      config({ personas: [{ name: 'plain', prompt: 'p', begin_dialogs: '' }] }),
      'plain',
    )
    // undefined 与 [] 含义相反：前者是「全部工具」，后者是「一个都不给」
    expect(resolved.allowedTools).toBeUndefined()
  })

  it('配了 tools 时原样返回', () => {
    const resolved = resolvePersona(
      config({
        personas: [
          { name: 'limited', prompt: 'p', begin_dialogs: '', tools: ['time.now', 'web.fetch_page'] },
        ],
      }),
      'limited',
    )
    expect(resolved.allowedTools).toEqual(['time.now', 'web.fetch_page'])
  })

  it('显式空数组表示「什么工具都不能用」，不能当成不限', () => {
    const resolved = resolvePersona(
      config({ personas: [{ name: 'notool', prompt: 'p', begin_dialogs: '', tools: [] }] }),
      'notool',
    )
    expect(resolved.allowedTools).toEqual([])
    expect(resolved.allowedTools).not.toBeUndefined()
  })

  it('返回的是副本，改它不会污染配置', () => {
    const personas = [
      { name: 'limited', prompt: 'p', begin_dialogs: '', tools: ['time.now'] },
    ]
    const resolved = resolvePersona(config({ personas }), 'limited')
    resolved.allowedTools?.push('http.request')
    expect(personas[0]!.tools).toEqual(['time.now'])
  })
})

describe('人格的自定义错误文案（对标 AstrBot 的 custom_error_message）', () => {
  it('配了就返回', () => {
    const resolved = resolvePersona(
      config({
        personas: [
          { name: 'tsundere', prompt: 'p', begin_dialogs: '', custom_error_message: '哼，才不是出错了' },
        ],
      }),
      'tsundere',
    )
    expect(resolved.customErrorMessage).toBe('哼，才不是出错了')
  })

  it('空白字符串视为没配', () => {
    const resolved = resolvePersona(
      config({
        personas: [{ name: 'x', prompt: 'p', begin_dialogs: '', custom_error_message: '   ' }],
      }),
      'x',
    )
    expect(resolved.customErrorMessage).toBeUndefined()
  })

  it('没有生效人格时是 undefined', () => {
    const resolved = resolvePersona(config({ personas: [] }), undefined)
    expect(resolved.customErrorMessage).toBeUndefined()
    expect(resolved.name).toBeUndefined()
  })
})

/**
 * 开场对话的成对校正（对标 AstrBot 的偶数条约定）。
 *
 * AstrBot 遇到奇数条会记 error 并**整段丢弃**（persona_mgr.py:396-403）。
 * 这里不整段丢（对用户太狠），只丢掉落单的那条，成对部分照常生效。
 */
describe('begin_dialogs 成对校正', () => {
  it('奇数条时丢掉最后落单的那条', () => {
    const turns = parseBeginDialogs('user: 你好\nassistant: 你好呀\nuser: 落单')
    expect(turns).toHaveLength(2)
    expect(turns[1]).toEqual({ role: 'assistant', content: '你好呀' })
  })

  it('只有一条 user 时整段为空（落单，留着会污染历史）', () => {
    expect(parseBeginDialogs('单独一句')).toEqual([])
  })

  it('以 assistant 开头时丢掉开头，直到遇到 user', () => {
    const turns = parseBeginDialogs('assistant: 我先说\nuser: 你好\nassistant: 你好呀')
    expect(turns).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
    ])
  })

  it('偶数条正常保留', () => {
    expect(parseBeginDialogs('user: a\nassistant: b')).toHaveLength(2)
  })

  it('偶数条但如果开头是 assistant，裁完可能变奇数，继续裁', () => {
    // assistant, user, assistant → 裁掉开头 assistant 后剩 user+assistant，正好一对
    expect(parseBeginDialogs('assistant: x\nuser: a\nassistant: b')).toHaveLength(2)
    // assistant, user → 裁掉开头后只剩一条 user（落单），再丢掉
    expect(parseBeginDialogs('assistant: x\nuser: a')).toEqual([])
  })
})

describe('人格的可见技能白名单（对标 AstrBot 的 Persona.skills）', () => {
  it('没配 skills 时是 undefined（不限）', () => {
    const resolved = resolvePersona(
      config({ personas: [{ name: 'p', prompt: 'x', begin_dialogs: '' }] }),
      'p',
    )
    expect(resolved.allowedSkills).toBeUndefined()
  })

  it('配了就是白名单', () => {
    const resolved = resolvePersona(
      config({
        personas: [{ name: 'p', prompt: 'x', begin_dialogs: '', skills: ['report'] }],
      }),
      'p',
    )
    expect(resolved.allowedSkills).toEqual(['report'])
  })

  it('空数组表示一个都看不到，不能当成不限', () => {
    const resolved = resolvePersona(
      config({ personas: [{ name: 'p', prompt: 'x', begin_dialogs: '', skills: [] }] }),
      'p',
    )
    expect(resolved.allowedSkills).toEqual([])
    expect(resolved.allowedSkills).not.toBeUndefined()
  })

  it('返回副本，改它不会污染配置', () => {
    const personas = [{ name: 'p', prompt: 'x', begin_dialogs: '', skills: ['a'] }]
    const resolved = resolvePersona(config({ personas }), 'p')
    resolved.allowedSkills?.push('b')
    expect(personas[0]!.skills).toEqual(['a'])
  })
})
