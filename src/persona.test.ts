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
    expect(parseBeginDialogs('随便一句话')).toEqual([{ role: 'user', content: '随便一句话' }])
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
