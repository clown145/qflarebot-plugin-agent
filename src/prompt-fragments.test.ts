import { describe, expect, it } from 'vitest'
import type { PluginDB } from '@qqbot/sdk'
import {
  MAX_FRAGMENT_BYTES,
  buildFragmentBlock,
  listActiveFragments,
  listAllFragments,
  removeFragment,
  setFragmentEnabled,
  upsertFragment,
  validateFragment,
} from './prompt-fragments.js'

/**
 * 插件间提示词扩展。
 *
 * 对标 AstrBot 的 `OnLLMRequestEvent`：别的插件能往本插件的 system prompt 里插话。
 * 这里只测存储与拼装，注入点由 context/wiring 测试覆盖。
 */

/** 内存版 D1，只实现 {prompt_fragments} 需要的语句 */
function memoryDb(): PluginDB {
  const rows = new Map<string, { plugin: string; fragment: string; priority: number; enabled: number; updated_at: number }>()
  let writes = 0

  return {
    async run(sql: string, ...params: unknown[]) {
      if (sql.includes('INSERT INTO {prompt_fragments}')) {
        const [plugin, fragment, priority, updatedAt] = params as [string, string, number, number]
        const existing = rows.get(plugin)
        rows.set(plugin, {
          plugin,
          fragment,
          priority,
          enabled: 1,
          updated_at: updatedAt,
        })
        writes += 1
        return { changes: existing ? 1 : 1 }
      }
      if (sql.includes('UPDATE {prompt_fragments}')) {
        const [enabled, updatedAt, plugin] = params as [number, number, string]
        const row = rows.get(plugin)
        if (row) {
          row.enabled = enabled
          row.updated_at = updatedAt
          writes += 1
        }
        return { changes: row ? 1 : 0 }
      }
      if (sql.includes('DELETE FROM {prompt_fragments}')) {
        const existed = rows.delete(params[0] as string)
        return { changes: existed ? 1 : 0 }
      }
      return { changes: 0 }
    },
    async all<T>(sql: string) {
      let list = [...rows.values()]
      if (sql.includes('WHERE enabled = 1')) list = list.filter((r) => r.enabled === 1)
      list.sort((a, b) => b.priority - a.priority || a.plugin.localeCompare(b.plugin))
      if (sql.includes('LIMIT')) list = list.slice(0, 8)
      return list as T[]
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (rows.get(params[0] as string) ?? null) as T | null
    },
    async exec() {},
    table: (name: string) => `p_agent_${name}`,
  } as unknown as PluginDB
}

describe('validateFragment', () => {
  it('接受正常片段', () => {
    expect(validateFragment('回答时优先用中文')).toBeNull()
  })

  it('拒绝非字符串与空串', () => {
    expect(validateFragment(42)).toBeTruthy()
    expect(validateFragment('   ')).toBeTruthy()
  })

  it('拒绝超长片段，并在错误里给出实际字节数', () => {
    const huge = 'x'.repeat(MAX_FRAGMENT_BYTES + 10)
    const error = validateFragment(huge)
    expect(error).toContain(String(MAX_FRAGMENT_BYTES))
    expect(error).toContain(String(MAX_FRAGMENT_BYTES + 10))
  })

  it('按字节而不是字符算长度（中文一个字 3 字节）', () => {
    // 700 个汉字 = 2100 字节 > 2000
    const chinese = '字'.repeat(700)
    expect(validateFragment(chinese)).toBeTruthy()
  })
})

describe('upsertFragment', () => {
  it('首次注册写库', async () => {
    const db = memoryDb()
    expect(await upsertFragment(db, { plugin: 'weather', fragment: '天气要用中文' })).toBe(true)
    const list = await listAllFragments(db)
    expect(list).toHaveLength(1)
    expect(list[0]?.plugin).toBe('weather')
  })

  it('内容没变时不写库（插件可能在每个请求里调 register）', async () => {
    const db = memoryDb()
    await upsertFragment(db, { plugin: 'weather', fragment: '天气要用中文' })
    // 再注册一次完全相同的内容
    expect(await upsertFragment(db, { plugin: 'weather', fragment: '天气要用中文' })).toBe(false)
  })

  it('内容变了才写，覆盖而不是追加（一个插件只有一份）', async () => {
    const db = memoryDb()
    await upsertFragment(db, { plugin: 'weather', fragment: '旧内容' })
    expect(await upsertFragment(db, { plugin: 'weather', fragment: '新内容' })).toBe(true)
    const list = await listAllFragments(db)
    expect(list).toHaveLength(1)
    expect(list[0]?.fragment).toBe('新内容')
  })

  it('超长片段抛错而不是静默截断', async () => {
    const db = memoryDb()
    await expect(
      upsertFragment(db, { plugin: 'x', fragment: 'y'.repeat(MAX_FRAGMENT_BYTES + 1) }),
    ).rejects.toThrow()
  })

  it('缺 plugin 名时抛错', async () => {
    await expect(upsertFragment(memoryDb(), { plugin: '  ', fragment: 'x' })).rejects.toThrow()
  })
})

describe('启用 / 停用 / 删除', () => {
  it('停用后不出现在启用列表里，但还在库里', async () => {
    const db = memoryDb()
    await upsertFragment(db, { plugin: 'weather', fragment: 'x' })
    await setFragmentEnabled(db, 'weather', false)

    expect(await listActiveFragments(db)).toHaveLength(0)
    expect(await listAllFragments(db)).toHaveLength(1)
  })

  it('重新注册会重新启用', async () => {
    const db = memoryDb()
    await upsertFragment(db, { plugin: 'weather', fragment: 'a' })
    await setFragmentEnabled(db, 'weather', false)
    await upsertFragment(db, { plugin: 'weather', fragment: 'b' })
    expect(await listActiveFragments(db)).toHaveLength(1)
  })

  it('删除后彻底不见', async () => {
    const db = memoryDb()
    await upsertFragment(db, { plugin: 'weather', fragment: 'x' })
    await removeFragment(db, 'weather')
    expect(await listAllFragments(db)).toHaveLength(0)
  })
})

describe('排序稳定性（影响缓存）', () => {
  it('按 priority 降序', async () => {
    const db = memoryDb()
    await upsertFragment(db, { plugin: 'low', fragment: 'a', priority: 1 })
    await upsertFragment(db, { plugin: 'high', fragment: 'b', priority: 9 })
    const list = await listActiveFragments(db)
    expect(list.map((x) => x.plugin)).toEqual(['high', 'low'])
  })

  it('同优先级按插件名排序，不随写入顺序变（否则每轮顺序抖动会击穿缓存）', async () => {
    const db = memoryDb()
    await upsertFragment(db, { plugin: 'zeta', fragment: 'z' })
    await upsertFragment(db, { plugin: 'alpha', fragment: 'a' })

    const first = (await listActiveFragments(db)).map((x) => x.plugin)
    expect(first).toEqual(['alpha', 'zeta'])

    // 换个写入顺序再读，结果必须一样
    const db2 = memoryDb()
    await upsertFragment(db2, { plugin: 'alpha', fragment: 'a' })
    await upsertFragment(db2, { plugin: 'zeta', fragment: 'z' })
    expect((await listActiveFragments(db2)).map((x) => x.plugin)).toEqual(first)
  })
})

describe('buildFragmentBlock', () => {
  it('没有片段时返回 undefined（不注入空段落）', () => {
    expect(buildFragmentBlock([])).toBeUndefined()
  })

  it('每个片段带出处标题，模型能对得上是谁塞的', () => {
    const block = buildFragmentBlock([
      { plugin: 'weather', fragment: '天气要用中文', priority: 0, enabled: true, updatedAt: 1 },
    ])
    expect(block).toContain('来自插件 weather')
    expect(block).toContain('天气要用中文')
  })

  it('多个片段按传入顺序拼接', () => {
    const block = buildFragmentBlock([
      { plugin: 'a', fragment: 'AAA', priority: 9, enabled: true, updatedAt: 1 },
      { plugin: 'b', fragment: 'BBB', priority: 1, enabled: true, updatedAt: 1 },
    ])
    expect(block?.indexOf('AAA')).toBeLessThan(block!.indexOf('BBB'))
  })

  it('同样的输入产生同样的输出（缓存前提）', () => {
    const input = [
      { plugin: 'a', fragment: 'x', priority: 0, enabled: true, updatedAt: 1 },
    ]
    expect(buildFragmentBlock(input)).toBe(buildFragmentBlock([{ ...input[0]!, updatedAt: 999 }]))
  })
})
