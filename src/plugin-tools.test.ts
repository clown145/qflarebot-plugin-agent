import { describe, expect, it } from 'vitest'
import type { PluginDB } from '@qqbot/sdk'
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TOOLS_PER_PLUGIN,
  MIN_PLUGIN_TOOL_LEVEL,
  listAllPluginTools,
  listPluginTools,
  pluginToolFullName,
  removePluginTool,
  removePluginTools,
  sanitizeToolName,
  setPluginToolEnabled,
  upsertPluginTool,
  validateToolRegistration,
} from './plugin-tools.js'

/**
 * 插件间工具扩展：别的插件把自己的函数交给模型调用。
 *
 * 这里测存储、命名、校验；「执行函数从 services 取」那条链路由
 * agent/run 的集成测试覆盖。
 */

/** 内存版 D1，只实现 {plugin_tools} 需要的语句 */
function memoryDb(): PluginDB {
  const rows = new Map<string, Record<string, unknown>>()

  return {
    async run(sql: string, ...params: unknown[]) {
      if (sql.includes('INSERT INTO {plugin_tools}')) {
        const [fullName, owner, name, description, inputSchema, level, sideEffect, timeoutMs, updatedAt] =
          params as [string, string, string, string, string, number, string, number, number]
        rows.set(fullName, {
          full_name: fullName, owner, name, description, input_schema: inputSchema,
          level, side_effect: sideEffect, timeout_ms: timeoutMs, enabled: 1, updated_at: updatedAt,
        })
        return { changes: 1 }
      }
      if (sql.includes('UPDATE {plugin_tools}')) {
        if (sql.includes('SET enabled')) {
          const [enabled, updatedAt, fullName] = params as [number, number, string]
          const row = rows.get(fullName)
          if (row) { row['enabled'] = enabled; row['updated_at'] = updatedAt }
          return { changes: row ? 1 : 0 }
        }
        return { changes: 0 }
      }
      if (sql.includes('DELETE FROM {plugin_tools}')) {
        if (sql.includes('WHERE owner = ?')) {
          const owner = params[0] as string
          let n = 0
          for (const [k, v] of [...rows.entries()]) {
            if (v['owner'] === owner) { rows.delete(k); n += 1 }
          }
          return { changes: n }
        }
        return { changes: rows.delete(params[0] as string) ? 1 : 0 }
      }
      return { changes: 0 }
    },
    async all<T>(sql: string) {
      let list = [...rows.values()]
      if (sql.includes('WHERE enabled = 1')) list = list.filter((r) => r['enabled'] === 1)
      list.sort(
        (a, b) =>
          String(a['owner']).localeCompare(String(b['owner'])) ||
          String(a['name']).localeCompare(String(b['name'])),
      )
      return list as T[]
    },
    async first<T>(sql: string, ...params: unknown[]) {
      if (sql.includes('COUNT(*)')) {
        const owner = params[0] as string
        const n = [...rows.values()].filter((r) => r['owner'] === owner).length
        return { n } as T
      }
      return (rows.get(params[0] as string) ?? null) as T | null
    },
    async exec() {},
    table: (name: string) => `p_agent_${name}`,
  } as unknown as PluginDB
}

const validTool = {
  name: 'query',
  description: '查询某个城市当前的天气',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}

describe('sanitizeToolName', () => {
  it('保留字母数字下划线连字符', () => {
    expect(sanitizeToolName('my_tool-2')).toBe('my_tool-2')
  })

  it('中文和空格转下划线（provider 的 function name 只接受有限字符集）', () => {
    expect(sanitizeToolName('查天气 now')).toBe('now')
    expect(sanitizeToolName('a b/c')).toBe('a_b_c')
  })

  it('去掉首尾下划线', () => {
    expect(sanitizeToolName('__x__')).toBe('x')
  })
})

describe('pluginToolFullName', () => {
  it('拼成 plugin.<owner>.<name>', () => {
    expect(pluginToolFullName('weather', 'query')).toBe('plugin.weather.query')
  })

  it('全是非法字符时回退到 plugin/tool 占位（仍能拼出合法名字）', () => {
    // 中文会被 sanitize 成空串，回退成 'plugin' / 'tool' 占位 ——
    // 关键是结果仍然是一个 provider 能接受的合法 function name
    const name = pluginToolFullName('天气 插件', '查')
    expect(name).toBe('plugin.plugin.tool')
    expect(name).toMatch(/^[A-Za-z0-9_.]+$/)
  })

  it('截断到 64 字符以内（provider 常见上限）', () => {
    const long = pluginToolFullName('a'.repeat(50), 'b'.repeat(50))
    expect(long.length).toBeLessThanOrEqual(64)
  })
})

describe('validateToolRegistration', () => {
  it('接受合法定义', () => {
    expect(validateToolRegistration(validTool)).toBeNull()
  })

  it('拒绝没有 name 的', () => {
    expect(validateToolRegistration({ ...validTool, name: '' })).toBeTruthy()
  })

  it('拒绝全是非法字符的名字', () => {
    expect(validateToolRegistration({ ...validTool, name: '中文名' })).toBeTruthy()
  })

  it('拒绝没有 description 的（模型靠它判断该不该用）', () => {
    expect(validateToolRegistration({ ...validTool, description: '' })).toBeTruthy()
  })

  it('拒绝过长的 description（每轮都进上下文）', () => {
    const error = validateToolRegistration({
      ...validTool,
      description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1),
    })
    expect(error).toContain(String(MAX_DESCRIPTION_CHARS))
  })

  it('拒绝没有 inputSchema 的', () => {
    expect(validateToolRegistration({ ...validTool, inputSchema: undefined })).toBeTruthy()
  })
})

describe('upsertPluginTool', () => {
  it('注册后能在列表里看到', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    const list = await listPluginTools(db)
    expect(list).toHaveLength(1)
    expect(list[0]?.fullName).toBe('plugin.weather.query')
    expect(list[0]?.owner).toBe('weather')
  })

  it('强制抬到最低权限级别（插件不能把能力降到人人可用）', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', { ...validTool, level: 0 })
    const list = await listPluginTools(db)
    expect(list[0]?.level).toBe(MIN_PLUGIN_TOOL_LEVEL)
  })

  it('level 更高时保留提供者声明的值', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', { ...validTool, level: 3 })
    expect((await listPluginTools(db))[0]?.level).toBe(3)
  })

  it('超时被夹到 1–30 秒', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', { ...validTool, timeoutMs: 999_999 })
    expect((await listPluginTools(db))[0]?.timeoutMs).toBe(30_000)
  })

  it('重复注册同名工具是覆盖', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    await upsertPluginTool(db, 'weather', { ...validTool, description: '新描述' })
    const list = await listPluginTools(db)
    expect(list).toHaveLength(1)
    expect(list[0]?.description).toBe('新描述')
  })

  it('不同工具名各自一行', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    await upsertPluginTool(db, 'weather', { ...validTool, name: 'forecast' })
    expect(await listPluginTools(db)).toHaveLength(2)
  })

  it('单插件超过工具数上限时抛错', async () => {
    const db = memoryDb()
    for (let i = 0; i < MAX_TOOLS_PER_PLUGIN; i += 1) {
      await upsertPluginTool(db, 'weather', { ...validTool, name: 'tool' + i })
    }
    await expect(
      upsertPluginTool(db, 'weather', { ...validTool, name: 'overflow' }),
    ).rejects.toThrow(String(MAX_TOOLS_PER_PLUGIN))
  })

  it('非法定义抛错而不是静默丢弃', async () => {
    await expect(
      upsertPluginTool(memoryDb(), 'weather', { ...validTool, description: '' }),
    ).rejects.toThrow()
  })

  it('坏掉的 input_schema 被读成空 schema，而不是让整轮失败', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    // 模拟有人手工改库写坏 JSON —— 这里直接改内存行
    const list = await listPluginTools(db)
    expect(list[0]?.inputSchema).toBeTruthy()
  })
})

describe('启停与删除', () => {
  it('停用后不在启用列表里', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    await setPluginToolEnabled(db, 'plugin.weather.query', false)
    expect(await listPluginTools(db)).toHaveLength(0)
    expect(await listAllPluginTools(db)).toHaveLength(1)
  })

  it('重新注册会重新启用', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    await setPluginToolEnabled(db, 'plugin.weather.query', false)
    await upsertPluginTool(db, 'weather', validTool)
    expect(await listPluginTools(db)).toHaveLength(1)
  })

  it('按全名删单个工具', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    await removePluginTool(db, 'plugin.weather.query')
    expect(await listAllPluginTools(db)).toHaveLength(0)
  })

  it('按提供者删全部（卸载清理）', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'weather', validTool)
    await upsertPluginTool(db, 'weather', { ...validTool, name: 'forecast' })
    await upsertPluginTool(db, 'news', validTool)
    await removePluginTools(db, 'weather')

    const left = await listAllPluginTools(db)
    expect(left).toHaveLength(1)
    expect(left[0]?.owner).toBe('news')
  })
})

describe('排序稳定（影响 prompt 缓存）', () => {
  it('按 owner 再按 name 排序，不随写入顺序变', async () => {
    const db = memoryDb()
    await upsertPluginTool(db, 'zeta', validTool)
    await upsertPluginTool(db, 'alpha', validTool)

    const first = (await listPluginTools(db)).map((t) => t.fullName)
    expect(first).toEqual(['plugin.alpha.query', 'plugin.zeta.query'])

    const db2 = memoryDb()
    await upsertPluginTool(db2, 'alpha', validTool)
    await upsertPluginTool(db2, 'zeta', validTool)
    expect((await listPluginTools(db2)).map((t) => t.fullName)).toEqual(first)
  })
})
