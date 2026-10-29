import { describe, expect, it } from 'vitest'
import type { PluginDB } from '@qqbot/sdk'
import type { RegisteredTool, ToolDefinition, ToolSource } from './types.js'
import {
  applyToolSettings,
  normalizeToolSettings,
  toToolCatalog,
  type ToolSettings,
} from './catalog.js'
import { getToolSettings, setToolSettings } from '../store/d1.js'
import { SCHEMA_STATEMENTS } from '../store/schema.js'

function tool(
  name: string,
  overrides: Partial<ToolDefinition> = {},
  source: ToolSource = { type: 'builtin', id: 'test', name: '测试' },
): RegisteredTool {
  return {
    definition: {
      name,
      description: `${name} 的说明`,
      inputSchema: { type: 'object', properties: {} },
      permission: { level: 1, scopes: [] },
      sideEffect: 'none',
      timeoutMs: 1000,
      ...overrides,
    },
    source,
    execute: async () => ({ status: 'success', output: 'ok' }),
  }
}

const mcpSource: ToolSource = { type: 'mcp', id: 'mcp-1', name: '外部 MCP' }
const pluginSource: ToolSource = { type: 'plugin', id: 'other', name: '别的插件' }

describe('toToolCatalog 投影', () => {
  it('投影出管理页需要的全部字段', () => {
    const item = toToolCatalog([
      tool('http.request', {
        title: 'HTTP 请求',
        description: '发起请求',
        permission: { level: 3, scopes: ['http:request'] },
        sideEffect: 'external_write',
        timeoutMs: 15_000,
        annotations: { readOnlyHint: false, openWorldHint: true },
      }),
    ])[0]!

    expect(item.name).toBe('http.request')
    expect(item.title).toBe('HTTP 请求')
    expect(item.description).toBe('发起请求')
    expect(item.source).toEqual({ type: 'builtin', id: 'test', name: '测试' })
    expect(item.permission).toEqual({ level: 3, scopes: ['http:request'] })
    expect(item.sideEffect).toBe('external_write')
    expect(item.timeoutMs).toBe(15_000)
    expect(item.annotations).toEqual({ readOnlyHint: false, openWorldHint: true })
    expect(item.enabled).toBe(true)
  })

  it('没写 title 时退回工具名——面板直接读这个字段，留空会显示成空白', () => {
    expect(toToolCatalog([tool('time.now')])[0]!.title).toBe('time.now')
  })

  it('没写 annotations 时给空对象，面板判空少一层', () => {
    expect(toToolCatalog([tool('time.now')])[0]!.annotations).toEqual({})
  })

  it('结果可 JSON 序列化（execute 这类函数绝不能带着走）', () => {
    const catalog = toToolCatalog([tool('time.now'), tool('web.fetch_page')])
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
  })

  it('按 source.type 再按 name 排序，且与输入顺序无关', () => {
    const a = tool('web.fetch_page')
    const b = tool('zzz.plugin', {}, pluginSource)
    const c = tool('time.now')
    const d = tool('mcp.tool', {}, mcpSource)

    const expected = ['time.now', 'web.fetch_page', 'mcp.tool', 'zzz.plugin']
    expect(toToolCatalog([a, b, c, d]).map((item) => item.name)).toEqual(expected)
    // 换个输入顺序，输出必须一致：面板每次刷新的顺序都该一样
    expect(toToolCatalog([d, c, b, a]).map((item) => item.name)).toEqual(expected)
  })

  it('不排序母数组（输入顺序保持不变）', () => {
    const tools = [tool('web.fetch_page'), tool('time.now')]
    toToolCatalog(tools)
    expect(tools.map((item) => item.definition.name)).toEqual(['web.fetch_page', 'time.now'])
  })

  it('scopes 是副本，改目录不会污染工具定义', () => {
    const definition: ToolDefinition = {
      name: 'x',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
      permission: { level: 3, scopes: ['http:request'] },
      sideEffect: 'none',
      timeoutMs: 1000,
    }
    const items = toToolCatalog([{ ...tool('x'), definition }])
    items[0]!.permission.scopes.push('workspace:write')
    expect(definition.permission.scopes).toEqual(['http:request'])
  })

  it('被关掉的工具仍然留在目录里，只是 enabled=false', () => {
    // 若过滤掉，面板就再也点不到「开启」按钮，只能去改库
    const items = toToolCatalog([tool('a'), tool('b')], { disabled: ['b'] })
    expect(items.map((item) => item.name)).toEqual(['a', 'b'])
    expect(items.find((item) => item.name === 'b')!.enabled).toBe(false)
    expect(items.find((item) => item.name === 'a')!.enabled).toBe(true)
  })

  it('设置里是坏数据时按「全部可用」处理', () => {
    const items = toToolCatalog([tool('a')], { disabled: 'oops' as unknown as string[] })
    expect(items[0]!.enabled).toBe(true)
  })
})

describe('applyToolSettings 过滤', () => {
  it('去掉被关掉的工具，返回新数组且不改输入', () => {
    const tools = [tool('a'), tool('b'), tool('c')]
    const result = applyToolSettings(tools, { disabled: ['b'] })

    expect(result.map((item) => item.definition.name)).toEqual(['a', 'c'])
    // 新数组 + 原数组一行不少：调用方可能还在用原清单拼提示词
    expect(result).not.toBe(tools)
    expect(tools).toHaveLength(3)
  })

  it('空设置返回全部工具（仍是新数组）', () => {
    const tools = [tool('a'), tool('b')]
    const result = applyToolSettings(tools, { disabled: [] })
    expect(result).toEqual(tools)
    expect(result).not.toBe(tools)
  })

  it('没传设置时也返回全部工具', () => {
    const tools = [tool('a'), tool('b')]
    expect(applyToolSettings(tools, undefined)).toHaveLength(2)
  })

  it('关掉一个不存在的工具名是无害的（配置关掉后名字会过期）', () => {
    const tools = [tool('a')]
    const result = applyToolSettings(tools, { disabled: ['vfs.read_file', 'already.gone'] })
    expect(result).toHaveLength(1)
    expect(result[0]!.definition.name).toBe('a')
  })

  it('名字带空白或重复时按归一化后的名字匹配', () => {
    const tools = [tool('a'), tool('b')]
    expect(applyToolSettings(tools, { disabled: [' b ', 'b'] })).toHaveLength(1)
  })

  it('设置里混进非字符串时不误伤（不会把比对的 Set 弄成字符串化）', () => {
    const tools = [tool('1'), tool('a')]
    const dirty = { disabled: [1, null, 'a'] } as unknown as ToolSettings
    expect(applyToolSettings(tools, dirty).map((item) => item.definition.name)).toEqual(['1'])
  })
})

describe('normalizeToolSettings 容错', () => {
  it('合法输入原样返回', () => {
    expect(normalizeToolSettings({ disabled: ['a', 'b'] })).toEqual({ disabled: ['a', 'b'] })
  })

  it('D1 的 disabled_json 是名字数组本身，解析出来就是 disabled', () => {
    expect(normalizeToolSettings('["http.request"]')).toEqual({ disabled: ['http.request'] })
    expect(normalizeToolSettings('[]')).toEqual({ disabled: [] })
    // 未解包的数组也认（调用方可能已经 JSON.parse 过）
    expect(normalizeToolSettings(['a'])).toEqual({ disabled: ['a'] })
  })

  it('页面 POST 上来的接口形状也认', () => {
    expect(normalizeToolSettings({ disabled: ['http.request'] })).toEqual({
      disabled: ['http.request'],
    })
    expect(normalizeToolSettings('{"disabled":["http.request"]}')).toEqual({
      disabled: ['http.request'],
    })
  })

  it('null / 非数组一律当成全开', () => {
    expect(normalizeToolSettings(null)).toEqual({ disabled: [] })
    expect(normalizeToolSettings(undefined)).toEqual({ disabled: [] })
    expect(normalizeToolSettings(42)).toEqual({ disabled: [] })
    expect(normalizeToolSettings('"oops"')).toEqual({ disabled: [] })
    expect(normalizeToolSettings({})).toEqual({ disabled: [] })
  })

  it('数组里全是数字时也当成全开（不是有效的工具名列表）', () => {
    expect(normalizeToolSettings([1, 2, 3])).toEqual({ disabled: [] })
    expect(normalizeToolSettings('[7,8]')).toEqual({ disabled: [] })
  })

  it('disabled 不是数组时当成全开（手改库写错字段名是常见情况）', () => {
    expect(normalizeToolSettings({ disabled: 'a' })).toEqual({ disabled: [] })
    expect(normalizeToolSettings({ enabled: ['a'] })).toEqual({ disabled: [] })
  })

  it('数组里混着数字 / null / 对象时只留字符串', () => {
    expect(normalizeToolSettings({ disabled: [1, null, { name: 'x' }, 'a', true] })).toEqual({
      disabled: ['a'],
    })
    expect(normalizeToolSettings([1, null, { name: 'x' }, 'a', true])).toEqual({ disabled: ['a'] })
  })

  it('去空白、去空串、去重——重复项会让面板画两行勾选框', () => {
    expect(normalizeToolSettings({ disabled: [' a ', 'a', '', '   ', 'b'] })).toEqual({
      disabled: ['a', 'b'],
    })
  })

  it('坏 JSON / 抛错的 getter 都不抛异常', () => {
    expect(normalizeToolSettings('{not json')).toEqual({ disabled: [] })
    const hostile = {
      get disabled(): unknown {
        throw new Error('库里读出来的奇怪结构')
      },
    }
    // 读设置抛错会直接断掉整轮对话，这里必须兜住
    expect(() => normalizeToolSettings(hostile)).not.toThrow()
    expect(normalizeToolSettings(hostile)).toEqual({ disabled: [] })
  })
})

/**
 * 假 D1：真的按主键读写 `{tool_settings}`，才能验「先写后读」和「永远只有一行」。
 * 只实现这两个 helper 用到的两种语句形态，其余一律走兜底返回。
 */
function fakeToolDb(): {
  db: PluginDB
  calls: Array<{ sql: string; params: unknown[] }>
  rows: Map<string, { disabled_json: string; updated_at: number }>
  writes: number
} {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const rows = new Map<string, { disabled_json: string; updated_at: number }>()
  let writes = 0

  const db = {
    async run(sql: string, ...params: unknown[]) {
      calls.push({ sql, params })
      writes += 1
      if (sql.includes('{tool_settings}')) {
        rows.set(String(params[0]), {
          disabled_json: String(params[1]),
          updated_at: Number(params[2]),
        })
      }
      return { changes: 1 }
    },
    async all(sql: string, ...params: unknown[]) {
      calls.push({ sql, params })
      return []
    },
    async first(sql: string, ...params: unknown[]) {
      calls.push({ sql, params })
      if (!sql.includes('{tool_settings}')) return null
      const row = rows.get(String(params[0]))
      return row ? { disabled_json: row.disabled_json } : null
    },
    async exec() {},
    table: (name: string) => `p_agent_${name}`,
  } as unknown as PluginDB

  return { db, calls, rows, writes }
}

describe('D1 工具开关', () => {
  it('没有行时返回全开，而且不写库', async () => {
    const { db, calls, writes } = fakeToolDb()
    const settings = await getToolSettings(db)

    expect(settings).toEqual({ disabled: [] })
    expect(writes).toBe(0)
    // 只按主键查一行，没有二级索引可走
    expect(calls[0]?.sql).toContain('SELECT disabled_json FROM {tool_settings} WHERE id = ?')
    expect(calls[0]?.params).toEqual(['default'])
  })

  it('有行时解析出 disabled', async () => {
    const { db, rows } = fakeToolDb()
    rows.set('default', { disabled_json: '["http.request"]', updated_at: 1 })
    expect(await getToolSettings(db)).toEqual({ disabled: ['http.request'] })
  })

  it('库里是坏 JSON 时返回全开而不是抛错', async () => {
    const { db, rows } = fakeToolDb()
    rows.set('default', { disabled_json: '{"disabled":', updated_at: 1 })
    expect(await getToolSettings(db)).toEqual({ disabled: [] })
  })

  it('库里存的是旧版对象形状时也读得出来（不用写迁移）', async () => {
    const { db, rows } = fakeToolDb()
    rows.set('default', { disabled_json: '{"disabled":["http.request"]}', updated_at: 1 })
    expect(await getToolSettings(db)).toEqual({ disabled: ['http.request'] })
  })

  it('set 是单行 UPSERT，不是 INSERT OR REPLACE', async () => {
    const { db, calls } = fakeToolDb()
    await setToolSettings(db, { disabled: ['http.request'] })

    expect(calls[0]?.sql).toContain('INSERT INTO {tool_settings}')
    // UPSERT 改同一行只算 2 行写入；INSERT OR REPLACE 是删 + 插，多一倍
    expect(calls[0]?.sql).toContain('ON CONFLICT(id) DO UPDATE')
    expect(calls[0]?.params[0]).toBe('default')
    expect(calls[0]?.params[1]).toBe('["http.request"]')
    expect(typeof calls[0]?.params[2]).toBe('number')
  })

  it('set → get 往返一致', async () => {
    const { db } = fakeToolDb()
    await setToolSettings(db, { disabled: ['vfs.delete', 'vfs.write_file'] })
    expect(await getToolSettings(db)).toEqual({ disabled: ['vfs.delete', 'vfs.write_file'] })
  })

  it('set 前先归一化：脏值不会落库', async () => {
    const { db, rows } = fakeToolDb()
    await setToolSettings(db, { disabled: [' a ', 'a', 42 as unknown as string] })
    expect(rows.get('default')?.disabled_json).toBe('["a"]')
  })

  it('反复 set 也只有一行（整张表就一个默认行）', async () => {
    const { db, rows } = fakeToolDb()
    await setToolSettings(db, { disabled: ['a'] })
    await setToolSettings(db, { disabled: [] })
    await setToolSettings(db, { disabled: ['b'] })

    expect(rows.size).toBe(1)
    expect(await getToolSettings(db)).toEqual({ disabled: ['b'] })
  })
})

describe('{tool_settings} 的建表语句', () => {
  /** 从 SCHEMA_STATEMENTS 里挑出工具开关那张表——DDL 只该在 schema.ts 里有一份 */
  const ddl = SCHEMA_STATEMENTS.find((statement) => statement.includes('{tool_settings}')) ?? ''

  it('建表语句在 SCHEMA_STATEMENTS 里（onInstall / onBoot 只扫这一份清单）', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS {tool_settings}')
  })

  it('主键是 id 且 WITHOUT ROWID：单行表省掉一层间接寻址', () => {
    expect(ddl).toContain('id TEXT PRIMARY KEY')
    expect(ddl).toContain('WITHOUT ROWID')
  })

  it('没有额外索引：这张表只按主键读写，加索引只是多算写入行数', () => {
    const indexes = SCHEMA_STATEMENTS.filter(
      (statement) => statement.includes('INDEX') && statement.includes('{tool_settings}'),
    )
    expect(indexes).toEqual([])
  })
})
