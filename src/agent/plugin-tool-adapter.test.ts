import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginToolDescriptor, PluginToolRegistry } from '@qqbot/sdk'
import { createMockContext } from '@qqbot/sdk/testing'
import plugin from '../index.js'
import type { AgentService } from '../agent-service.js'
import { defaultConfig } from '../config/index.js'
import { getToolSettings, setToolSettings } from '../store/d1.js'
import { createTestDb } from '../store/sqlite-test-db.js'
import {
  listAllPluginTools,
  pluginToolFullName,
  setPluginToolEnabled,
  upsertPluginTool,
} from '../plugin-tools.js'
import { createPageRoutesPage } from '../routes/page-routes.js'
import { createToolsRoutes } from '../routes/tools-routes.js'
import { canonicalDisabledTools, filterAllowedTools, toToolCatalog } from '../tools/catalog.js'
import { buildRegistry } from './run.js'
import { loadFrameworkTools, modelToolName } from './plugin-tool-adapter.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).forEach(close => close())
  vi.restoreAllMocks()
})
const invocation = { token: 'unit-test-ticket' }
const config = { ...defaultConfig, enable_vfs: false, enable_schedule: false }
const schema = { type: 'object', properties: {} }

function descriptor(owner = 'weather', name = 'query'): PluginToolDescriptor {
  return {
    id: `${owner}.${name}`,
    owner,
    name,
    revision: 'v1',
    description: '查询城市天气',
    permission: 'member',
    sideEffect: 'none',
    inputSchema: schema,
    timeoutMs: 1000,
  }
}

async function setup(catalog = [descriptor()], enable = true) {
  const store = createTestDb()
  cleanups.push(() => store.close())
  const invoke = vi.fn<PluginToolRegistry['invoke']>(async () => ({
    status: 'success',
    output: 'ok',
  }))
  const core: PluginToolRegistry = {
    contractVersion: 1,
    capture: async () => invocation,
    list: async () => catalog,
    describe: async id => catalog.find(tool => tool.id === id) ?? null,
    invoke,
  }
  const ctx = createMockContext(plugin, { config, db: store.db, services: { 'core.tools': core } })
  if (enable) {
    await setToolSettings(ctx.db, { disabled: [], enabled: await Promise.all(catalog.map(modelToolName)) })
  }
  const registry = async (disabled = new Set<string>(), allowed?: string[]) => {
    const settings = await getToolSettings(ctx.db)
    return buildRegistry(ctx, config, false, disabled, allowed, {}, invocation, new Set(settings.enabled))
  }
  return { ctx, core, invoke, registry }
}

const registration = { name: 'query', description: '旧天气服务', inputSchema: schema, level: 4 }

describe('框架工具迁移兼容', () => {
  it('旧禁用状态在重复注册后保留，并能从工具页重新开启', async () => {
    const { ctx, registry } = await setup()
    const agent = (await plugin.services!.agent!(ctx)) as AgentService
    await agent.registerTool('weather', registration)
    await setPluginToolEnabled(ctx.db, 'plugin.weather.query', false)
    await agent.registerTool('weather', { ...registration, description: '更新说明' })

    expect((await listAllPluginTools(ctx.db))[0]?.enabled).toBe(false)
    expect((await registry()).get('plugin.weather.query')).toBeUndefined()
    const catalog = await loadFrameworkTools(ctx)
    expect(toToolCatalog(catalog)[0]?.enabled).toBe(false)
    expect(canonicalDisabledTools(catalog, [])).toEqual(['plugin.weather.query'])

    const route = createToolsRoutes().find(
      route => route.method === 'POST' && route.path === '/api/tools',
    )!
    const response = await route.handler({
      ctx,
      params: {},
      authenticated: true,
      request: new Request('https://bot.test/api/tools', {
        method: 'POST',
        body: JSON.stringify({ disabled: [], enabled: ['plugin.weather.query'] }),
      }),
    })
    expect(response.status).toBe(200)
    expect((await registry()).get('plugin.weather.query')?.definition.permission.level).toBe(4)
    expect((await listAllPluginTools(ctx.db))[0]?.enabled).toBe(true)
  })

  it('长名称沿用旧开关和唯一白名单，不丢掉权限限制', async () => {
    const tool = descriptor('w'.repeat(55), 'query')
    const { ctx, registry } = await setup([tool])
    await upsertPluginTool(ctx.db, tool.owner, registration)
    const legacy = pluginToolFullName(tool.owner, tool.name)
    const name = await modelToolName(tool)
    expect(name).not.toBe(legacy)
    expect((await registry(new Set([legacy]))).get(name)).toBeUndefined()
    expect((await registry(new Set(), [legacy])).get(name)?.definition.permission.level).toBe(4)
    const catalog = await loadFrameworkTools(ctx)
    expect(canonicalDisabledTools(catalog, [legacy, 'uninstalled.tool'])).toEqual([
      'uninstalled.tool',
      name,
    ])
  })

  it('旧截断名碰撞时禁用全部候选，白名单不能扩大到两个工具', async () => {
    const owner = 'w'.repeat(60)
    const { ctx, registry } = await setup([descriptor(owner, 'one'), descriptor(owner, 'two')])
    const alias = pluginToolFullName(owner, 'one')
    const catalog = await loadFrameworkTools(ctx)
    expect(filterAllowedTools(catalog, [alias])).toEqual([])
    expect(
      (await registry(new Set([alias]))).list().filter(tool => tool.source.type === 'plugin'),
    ).toEqual([])
    expect(filterAllowedTools(catalog, [catalog[0]!.definition.name])).toHaveLength(1)
  })

  it('危险工具允许管理员确认后执行，普通成员仍被本地权限拒绝', async () => {
    const { ctx, registry, invoke } = await setup([{ ...descriptor(), sideEffect: 'dangerous' }])
    const tools = await registry()
    const input = {
      db: ctx.db,
      logger: ctx.logger,
      conversationId: 'g',
      actorId: 'u',
      actorRole: 'admin' as const,
      scene: 'group',
      targetId: 'g',
      runId: 'r',
      stepId: '1',
      toolCallId: 'c',
      input: {},
      timezone: 'UTC',
    }

    expect((await tools.execute('plugin.weather.query', input)).status).toBe('needs_confirmation')
    expect(invoke).not.toHaveBeenCalled()
    expect(
      (await tools.execute('plugin.weather.query', { ...input, allowDangerous: true })).status,
    ).toBe('success')
    expect(
      (
        await tools.execute('plugin.weather.query', {
          ...input,
          actorRole: 'member',
          allowDangerous: true,
        })
      ).status,
    ).toBe('permission_denied')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('现代工具被框架过滤后，旧表不能绕回 services 执行', async () => {
    const { ctx, core, registry } = await setup()
    await upsertPluginTool(ctx.db, 'weather', registration)
    core.list = async ticket => (ticket ? [] : [descriptor()])
    const legacy = vi.fn(async () => 'wrong path')
    const original = ctx.service
    ctx.service = name => (name === 'tools' ? ({ query: legacy } as never) : original(name))
    expect((await registry()).get('plugin.weather.query')).toBeUndefined()
    expect(legacy).not.toHaveBeenCalled()
  })
})


async function saveSwitches(ctx: Awaited<ReturnType<typeof setup>>['ctx'], body: unknown) {
  const route = createToolsRoutes().find(
    route => route.method === 'POST' && route.path === '/api/tools',
  )!
  return route.handler({
    ctx,
    params: {},
    authenticated: true,
    request: new Request('https://bot.test/api/tools', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  })
}

describe('插件工具默认关闭', () => {
  it('新安装和旧空配置都不交给模型，但两处管理目录保留关闭项', async () => {
    const { ctx, registry } = await setup(undefined, false)
    expect((await registry()).get('plugin.weather.query')).toBeUndefined()
    expect((await registry(new Set(), ['plugin.weather.query'])).list()).toEqual([])
    expect((await registry()).get('time.now')).toBeDefined()
    const request = new Request('https://bot.test/api/overview')
    for (const route of [
      createPageRoutesPage().find(route => route.path === '/api/overview')!,
      createToolsRoutes().find(route => route.method === 'GET')!,
    ]) {
      const response = await route.handler({ ctx, params: {}, authenticated: true, request })
      const body = (await response.json()) as {
        tools:
          | { list: Array<{ name: string; enabled: boolean }>; disabled: string[] }
          | Array<{ name: string; enabled: boolean }>
        disabled?: string[]
      }
      const list = Array.isArray(body.tools) ? body.tools : body.tools.list
      const disabled = Array.isArray(body.tools) ? body.disabled : body.tools.disabled
      expect(list.find(tool => tool.name === 'plugin.weather.query')?.enabled).toBe(false)
      expect(disabled).toContain('plugin.weather.query')
    }
  })

  it('明确开启一个工具后仍关闭其他及后来新增的工具，旧接口缺省不代表开启', async () => {
    const catalog = [descriptor(), descriptor('image')]
    const { ctx, registry } = await setup(catalog, false)
    await saveSwitches(ctx, { disabled: [] })
    expect((await registry()).get('plugin.weather.query')).toBeUndefined()
    await saveSwitches(ctx, { disabled: [], enabled: ['plugin.weather.query'] })
    catalog.push(descriptor('later'))
    const current = await registry()
    expect(current.get('plugin.weather.query')).toBeDefined()
    expect(current.get('plugin.image.query')).toBeUndefined()
    expect(current.get('plugin.later.query')).toBeUndefined()

    await saveSwitches(ctx, { disabled: [] })
    expect((await registry()).get('plugin.weather.query')).toBeDefined()
    await saveSwitches(ctx, { disabled: [], enabled: [] })
    expect((await registry()).get('plugin.weather.query')).toBeUndefined()
  })

  it('单工具配置保存保留开启名单，禁用仍优先，畸形开启请求不覆盖设置', async () => {
    const { ctx, registry } = await setup()
    const route = createToolsRoutes().find(route => route.path === '/api/tools/config')!
    await route.handler({
      ctx,
      params: {},
      authenticated: true,
      request: new Request('https://bot.test/api/tools/config', {
        method: 'POST',
        body: JSON.stringify({ tool: 'search.web', values: { apiKey: 'test-key' } }),
      }),
    })
    expect((await getToolSettings(ctx.db)).enabled).toEqual(['plugin.weather.query'])
    expect((await saveSwitches(ctx, { enabled: 'all' })).status).toBe(400)
    expect((await registry()).get('plugin.weather.query')).toBeDefined()
    expect(
      (await registry(new Set(['plugin.weather.query']))).get('plugin.weather.query'),
    ).toBeUndefined()
    expect((await getToolSettings(ctx.db)).config?.['search.web']).toEqual({ apiKey: 'test-key' })
  })

  it('注册旧工具和人格白名单都不会自动开启插件工具', async () => {
    const { ctx, registry } = await setup(undefined, false)
    await upsertPluginTool(ctx.db, 'weather', registration)
    expect((await registry(new Set(), ['plugin.weather.query'])).list()).toEqual([])
    const original = ctx.service
    ctx.service = name =>
      name === 'core.tools'
        ? (undefined as never)
        : name === 'weather'
          ? ({ query: async () => 'legacy' } as never)
          : original(name)
    const legacy = await buildRegistry(ctx, config, false, undefined, undefined, {}, null)
    expect(legacy.get('plugin.weather.query')).toBeUndefined()
  })

  it('读取设置失败时拒绝保存配置，避免覆盖已有工具开关', async () => {
    const { ctx } = await setup()
    const previous = await getToolSettings(ctx.db)
    const run = vi.spyOn(ctx.db, 'run')
    vi.spyOn(ctx.db, 'first').mockRejectedValueOnce(new Error('settings unavailable'))
    const route = createToolsRoutes().find(route => route.path === '/api/tools/config')!
    await expect(
      route.handler({
        ctx,
        params: {},
        authenticated: true,
        request: new Request('https://bot.test/api/tools/config', {
          method: 'POST',
          body: JSON.stringify({ tool: 'search.web', values: { apiKey: 'test-key' } }),
        }),
      }),
    ).rejects.toThrow('settings unavailable')
    expect(run).not.toHaveBeenCalled()
    expect(await getToolSettings(ctx.db)).toEqual(previous)
  })
})
