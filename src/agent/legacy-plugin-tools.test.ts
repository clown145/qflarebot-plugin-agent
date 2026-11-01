/** 旧 services 接线的兼容测试；真实框架鉴权另见 tests/integration。 */
import { describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import { defaultConfig } from '../config/index.js'
import { buildRegistry } from './run.js'

function fakeCtx(): PluginContext<AgentConfig> {
  return {
    plugin: { name: 'agent', version: '0.0.0' },
    botId: 'bot',
    config: defaultConfig,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    kv: {} as PluginContext<AgentConfig>['kv'],
    db: {} as PluginContext<AgentConfig>['db'],
    r2: {} as PluginContext<AgentConfig>['r2'],
    api: {} as PluginContext<AgentConfig>['api'],
    durable: {} as PluginContext<AgentConfig>['durable'],
    botAdmins: [],
    service: () => ({}) as never,
    waitUntil: () => undefined,
  } as unknown as PluginContext<AgentConfig>
}

describe('插件提供的工具接通 buildRegistry', () => {
  /** 造一个能返回指定工具元数据的 fake db，以及一个带 tools 服务的 ctx */
  function ctxWithPluginTools(
    metas: Array<Record<string, unknown>>,
    executors: Record<string, (input: unknown) => Promise<unknown>>,
    serviceName = 'weather',
  ): PluginContext<AgentConfig> {
    const db = {
      async all() {
        return metas
      },
      async first() {
        return null
      },
      async run() {
        return { changes: 0 }
      },
      async exec() {},
      table: (n: string) => `p_agent_${n}`,
    } as unknown as PluginContext<AgentConfig>['db']

    return {
      ...fakeCtx(),
      db,
      service: ((name: string) => {
        if (name === serviceName) return executors
        throw new Error(`没有这个服务：${name}`)
      }) as unknown as PluginContext<AgentConfig>['service'],
    } as unknown as PluginContext<AgentConfig>
  }

  // 注意用**库里的列名**（snake_case）——listPluginTools 读的是 D1 行，
  // 不是 PluginToolMeta 的 camelCase 形状
  const meta = {
    full_name: 'plugin.weather.query',
    owner: 'weather',
    name: 'query',
    description: '查询某个城市当前的天气',
    input_schema: JSON.stringify({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    }),
    level: 2,
    side_effect: 'external_write',
    timeout_ms: 1000,
    enabled: 1,
    updated_at: 1,
  }

  it('注册的工具出现在注册表里', async () => {
    const ctx = ctxWithPluginTools([meta], { query: async () => ({ temp: 21 }) })
    const registry = await buildRegistry(ctx, defaultConfig, false)
    const names = registry.list().map(t => t.definition.name)
    expect(names).toContain('plugin.weather.query')
  })

  it('工具能真的执行并返回结果', async () => {
    const ctx = ctxWithPluginTools([meta], {
      query: async input => ({ city: (input as { city: string }).city, temp: 21 }),
    })
    const registry = await buildRegistry(ctx, defaultConfig, false)
    const result = await registry.execute('plugin.weather.query', {
      db: ctx.db,
      logger: ctx.logger,
      conversationId: 'group:g1',
      actorId: 'u1',
      actorRole: 'admin',
      scene: 'group',
      targetId: 'g1',
      runId: 'r1',
      stepId: 's1',
      toolCallId: 'c1',
      input: { city: '北京' },
      timezone: 'Asia/Shanghai',
    })
    expect(result.status).toBe('success')
    expect(result.output).toMatchObject({ city: '北京', temp: 21 })
  })

  it('提供者没装（服务取不到）时，工具不注册 —— 而不是注册一个必然报错的工具', async () => {
    const ctx = ctxWithPluginTools([meta], {}, 'other-plugin')
    const registry = await buildRegistry(ctx, defaultConfig, false)
    expect(registry.list().map(t => t.definition.name)).not.toContain('plugin.weather.query')
  })

  it('有元数据但提供者没暴露对应执行函数时，跳过那个工具', async () => {
    const ctx = ctxWithPluginTools([meta], { 其它工具: async () => null })
    const registry = await buildRegistry(ctx, defaultConfig, false)
    expect(registry.list().map(t => t.definition.name)).not.toContain('plugin.weather.query')
  })

  it('写函数抛错时返回 unknown，不自动重试', async () => {
    const ctx = ctxWithPluginTools([meta], {
      query: async () => {
        throw new Error('上游接口挂了')
      },
    })
    const registry = await buildRegistry(ctx, defaultConfig, false)
    const result = await registry.execute('plugin.weather.query', {
      db: ctx.db,
      logger: ctx.logger,
      conversationId: 'group:g1',
      actorId: 'u1',
      actorRole: 'admin',
      scene: 'group',
      targetId: 'g1',
      runId: 'r1',
      stepId: 's1',
      toolCallId: 'c1',
      input: {},
      timezone: 'Asia/Shanghai',
    })
    expect(result.status).toBe('unknown')
    expect(result.error?.message).toContain('上游接口挂了')
    // 插件内部错误是否可重试我们不知道，保守设为不可重试，避免模型反复重试
    expect(result.error?.retryable).toBe(false)
  })

  it('写函数超时时返回 unknown，不让坏插件拖死整个 run', async () => {
    const ctx = ctxWithPluginTools([{ ...meta, timeout_ms: 1000 }], {
      query: () =>
        new Promise(() => {
          /* 永不 resolve */
        }),
    })
    const registry = await buildRegistry(ctx, defaultConfig, false)
    const result = await registry.execute('plugin.weather.query', {
      db: ctx.db,
      logger: ctx.logger,
      conversationId: 'group:g1',
      actorId: 'u1',
      actorRole: 'admin',
      scene: 'group',
      targetId: 'g1',
      runId: 'r1',
      stepId: 's1',
      toolCallId: 'c1',
      input: {},
      timezone: 'Asia/Shanghai',
    })
    expect(result.status).toBe('unknown')
  }, 15_000)

  it('插件工具也能被工具栏开关关掉', async () => {
    const ctx = ctxWithPluginTools([meta], { query: async () => null })
    const registry = await buildRegistry(
      ctx,
      defaultConfig,
      false,
      new Set(['plugin.weather.query']),
    )
    expect(registry.list().map(t => t.definition.name)).not.toContain('plugin.weather.query')
  })

  /**
   * 回归：插件工具链路的两个 key 映射错误。
   *
   * ① 服务名约定是 `tools`（提供者 `services: { tools: () => … }`），
   *    而代码取的是 `ctx.service(owner)`——按文档接线时工具静默消失。
   * ② D1 里 `name` 列存的是 `sanitizeToolName()` 规整后的短名
   *    （`weather.query` → `weather_query`），但提供者服务对象的 key 是原始名字，
   *    于是 `service[meta.name]` 取到 undefined，工具又一次静默消失。
   */
  it('服务挂在约定名 tools 下时也能接通（不只是提供者插件名）', async () => {
    const ctx = ctxWithPluginTools([meta], { query: async () => ({ temp: 21 }) }, 'tools')
    const registry = await buildRegistry(ctx, defaultConfig, false)
    expect(registry.list().map(t => t.definition.name)).toContain('plugin.weather.query')
  })

  it('D1 里是规整后的短名、服务对象用原始 key（含点）时仍能取到执行函数', async () => {
    // meta.name = 'weather.query'（带点）；D1 列存规整后的 'weather_query'
    const dirty = { ...meta, name: 'weather_query' }
    const ctx = ctxWithPluginTools(
      [dirty],
      { 'weather.query': async () => ({ temp: 21 }) },
      'tools',
    )
    const registry = await buildRegistry(ctx, defaultConfig, false)
    const names = registry.list().map(t => t.definition.name)
    expect(names).toContain('plugin.weather.query')

    const result = await registry.execute('plugin.weather.query', {
      db: ctx.db,
      logger: ctx.logger,
      conversationId: 'group:g1',
      actorId: 'u1',
      actorRole: 'admin',
      scene: 'group',
      targetId: 'g1',
      runId: 'r1',
      stepId: 's1',
      toolCallId: 'c1',
      input: {},
      timezone: 'Asia/Shanghai',
    })
    expect(result.status).toBe('success')
    expect(result.output).toMatchObject({ temp: 21 })
  })

  it('服务键被规整过（空格/中文换成下划线）时也能反查到执行函数', async () => {
    const dirty = { ...meta, name: 'query_weather' }
    const ctx = ctxWithPluginTools(
      [dirty],
      { 'query weather': async () => ({ ok: true }) },
      'tools',
    )
    const registry = await buildRegistry(ctx, defaultConfig, false)
    expect(registry.list().map(t => t.definition.name)).toContain('plugin.weather.query')
  })

  it('取不到服务时记一条明确的 warn，而不是静默 continue', async () => {
    const warns: string[] = []
    const ctx = ctxWithPluginTools([meta], {}, 'not-provided')
    const loggingCtx = {
      ...ctx,
      logger: {
        debug() {},
        info() {},
        warn(message: string) {
          warns.push(message)
        },
        error() {},
      },
    } as PluginContext<AgentConfig>

    // 日志按 owner 做 10 分钟节流；把时钟推远，保证这条测试不依赖执行顺序
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000)
    try {
      await buildRegistry(loggingCtx, defaultConfig, false)
    } finally {
      now.mockRestore()
    }
    // 这条日志是「按文档接线了但工具不见」的唯一线索，必须存在且说得清原因
    expect(warns.join('\n')).toContain('depends')
    expect(warns.join('\n')).toContain('plugin-api.md')
  })

  it('enable_tools 关掉时，插件工具也不注册', async () => {
    const ctx = ctxWithPluginTools([meta], { query: async () => null })
    const registry = await buildRegistry(ctx, { ...defaultConfig, enable_tools: false }, false)
    expect(registry.list()).toHaveLength(0)
  })
})
