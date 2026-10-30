/**
 * 管理接口的两条契约：
 *
 * 1. `configuredKeys` 来自 `toToolCatalog(tools, settings)`，页面靠它显示
 *    「Key 已设置」——secret 的值本身不回显。
 * 2. `buildRegistry` 也要拿到同一份 `settings.config`：catalog 虽然只读
 *    `configuredKeys`，但 registry 里的工具是按配置构造的。两处用同一份配置，
 *    页面看到的与真正运行时的才一致。
 */
import { describe, expect, it } from 'vitest'
import { createPageRoutes } from './routes.js'
import type { PluginDB } from '@qqbot/sdk'

function dbWithSavedKey(): PluginDB {
  return {
    async run() { return { changes: 1 } },
    async all() { return [] },
    async first(sql: string) {
      if (sql.includes('tool_settings')) {
        return { disabled_json: '[]', config_json: JSON.stringify({ 'search.web': { apiKey: 'tvly-saved' } }) }
      }
      return null
    },
    async exec() {},
    table: (n: string) => `p_agent_${n}`,
  } as unknown as PluginDB
}

const call = async (method: string, path: string) => {
  const route = createPageRoutes().find((r) => r.method === method && r.path === path)!
  const res = await route.handler({
    ctx: {
      db: dbWithSavedKey(),
      kv: { async get() { return null }, async getJSON() { return null }, async put() {}, async delete() {} },
      config: { enable_tools: true, enable_vfs: false, enable_schedule: false, personas: [], default_persona: '' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      service: () => { throw new Error('no llm') },
    },
    request: new Request('https://bot' + path),
    params: {},
    authenticated: true,
  } as never)
  return (await res.json()) as { tools: Array<{ name: string; configuredKeys?: string[]; config?: Record<string, string> }> }
}

describe('工具配置在管理接口里可见', () => {
  it('GET /api/tools 告诉页面「搜索 Key 已设置」', async () => {
    const body = await call('GET', '/api/tools')
    const search = body.tools.find((tool) => tool.name === 'search.web')
    expect(search?.configuredKeys).toContain('apiKey')
  })

  it('secret 的值不回显（只告诉「配置过」）', async () => {
    const body = await call('GET', '/api/tools')
    const search = body.tools.find((tool) => tool.name === 'search.web')
    expect(search?.config?.['apiKey']).toBeUndefined()
  })

  it('GET /api/overview 的工具栏同样带上已配置状态', async () => {
    const route = createPageRoutes().find((r) => r.method === 'GET' && r.path === '/api/overview')!
    const res = await route.handler({
      ctx: {
        db: dbWithSavedKey(),
        kv: { async get() { return null }, async getJSON() { return null }, async put() {}, async delete() {} },
        config: { enable_tools: true, enable_vfs: false, enable_schedule: false, personas: [], default_persona: '' },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        service: () => { throw new Error('no llm') },
      },
      request: new Request('https://bot/api/overview'),
      params: {},
      authenticated: true,
    } as never)
    const body = (await res.json()) as { tools: { list: Array<{ name: string; configuredKeys?: string[] }> } }
    const search = body.tools.list.find((tool) => tool.name === 'search.web')
    expect(search?.configuredKeys).toContain('apiKey')
  })
})
