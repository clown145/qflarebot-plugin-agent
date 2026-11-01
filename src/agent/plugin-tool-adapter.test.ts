import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginToolDescriptor, PluginToolRegistry } from '@qqbot/sdk'
import { createMockContext } from '@qqbot/sdk/testing'
import plugin from '../index.js'
import type { AgentService } from '../agent-service.js'
import { defaultConfig } from '../config/index.js'
import { createTestDb } from '../store/sqlite-test-db.js'
import {
  listAllPluginTools,
  pluginToolFullName,
  setPluginToolEnabled,
  upsertPluginTool,
} from '../plugin-tools.js'
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

function setup(catalog = [descriptor()]) {
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
  const registry = (disabled = new Set<string>(), allowed?: string[]) =>
    buildRegistry(ctx, config, false, disabled, allowed, {}, invocation)
  return { ctx, core, invoke, registry }
}

const registration = { name: 'query', description: '旧天气服务', inputSchema: schema, level: 4 }

describe('框架工具迁移兼容', () => {
  it('旧禁用状态在重复注册后保留，并能从工具页重新开启', async () => {
    const { ctx, registry } = setup()
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
        body: JSON.stringify({ disabled: [] }),
      }),
    })
    expect(response.status).toBe(200)
    expect((await registry()).get('plugin.weather.query')?.definition.permission.level).toBe(4)
    expect((await listAllPluginTools(ctx.db))[0]?.enabled).toBe(true)
  })

  it('长名称沿用旧开关和唯一白名单，不丢掉权限限制', async () => {
    const tool = descriptor('w'.repeat(55), 'query')
    const { ctx, registry } = setup([tool])
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
    const { ctx, registry } = setup([descriptor(owner, 'one'), descriptor(owner, 'two')])
    const alias = pluginToolFullName(owner, 'one')
    const catalog = await loadFrameworkTools(ctx)
    expect(filterAllowedTools(catalog, [alias])).toEqual([])
    expect(
      (await registry(new Set([alias]))).list().filter(tool => tool.source.type === 'plugin'),
    ).toEqual([])
    expect(filterAllowedTools(catalog, [catalog[0]!.definition.name])).toHaveLength(1)
  })

  it('危险工具允许管理员确认后执行，普通成员仍被本地权限拒绝', async () => {
    const { ctx, registry, invoke } = setup([{ ...descriptor(), sideEffect: 'dangerous' }])
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
    const { ctx, core, registry } = setup()
    await upsertPluginTool(ctx.db, 'weather', registration)
    core.list = async ticket => (ticket ? [] : [descriptor()])
    const legacy = vi.fn(async () => 'wrong path')
    const original = ctx.service
    ctx.service = name => (name === 'tools' ? ({ query: legacy } as never) : original(name))
    expect((await registry()).get('plugin.weather.query')).toBeUndefined()
    expect(legacy).not.toHaveBeenCalled()
  })
})
