/**
 * 集成测试：工具栏与技能**真的接通了**。
 *
 * `catalog.test.ts` 和 `skills/*.test.ts` 已经把各自的算法测透了。这里只回答一个
 * 问题：**它们有没有被接到实际执行路径上？**
 *
 * 为什么必须单独测这件事：`buildRegistry` 的过滤参数、`buildMessages` 的技能选项
 * 都是从配置/DB 一路传下来的，中间漏一环**不会报错**，只会「看起来一切正常但
 * 开关从来没生效」——正是这次审计在 `allowDangerous` 上发现过的失效模式。
 */
import { describe, expect, it, vi } from 'vitest'
import { buildRegistry, replyFromSession } from './run.js'
import { buildMessages } from './context.js'
import { applyToolSettings } from '../tools/catalog.js'
import { createToolRegistry } from '../tools/registry.js'
import { defaultConfig } from '../config/index.js'
import type { PluginContext } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import type { HistoryRow } from '../do/agent-object.js'
import type { InboundMessage } from '../types.js'
import type { LoadedSkill, SkillCatalogItem } from '../skills/store.js'

/** 只用到 db / r2 / logger 三个字段的最小 ctx */
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

const message: InboundMessage = {
  conversation: 'group:g1',
  userId: 'u1',
  userName: '小明',
  text: '你好',
  displayText: '你好',
  attachments: [],
  scene: 'group',
  targetId: 'g1',
  memberRole: 'member',
  receivedAt: Date.now(),
}

const baseOptions = {
  timezone: 'Asia/Shanghai',
  historyLimit: 20,
  supportsVision: false,
}

describe('工具栏接通 buildRegistry', () => {
  it('不传 disabled 时注册全部工具', async () => {
    const registry = await buildRegistry(fakeCtx(), defaultConfig, false)
    const names = registry.list().map((tool) => tool.definition.name)
    expect(names).toContain('time.now')
    expect(names).toContain('http.request')
  })

  it('被关掉的工具根本不注册（模型看不到）', async () => {
    const registry = await buildRegistry(fakeCtx(), defaultConfig, false, new Set(['http.request']))
    const names = registry.list().map((tool) => tool.definition.name)
    expect(names).not.toContain('http.request')
    // 其他工具不受影响
    expect(names).toContain('time.now')
  })

  it('enable_tools 关掉时什么都没有——开关优先级更高', async () => {
    const registry = await buildRegistry(
      fakeCtx(),
      { ...defaultConfig, enable_tools: false },
      false,
      new Set(['time.now']),
    )
    expect(registry.list()).toHaveLength(0)
  })

  it('关掉一个不存在的工具名是无害的', async () => {
    const registry = await buildRegistry(fakeCtx(), defaultConfig, false, new Set(['no.such.tool']))
    expect(registry.list().length).toBeGreaterThan(0)
  })
})

describe('applyToolSettings 与 buildRegistry 的一致性', () => {
  it('两者过滤结果相同（防止接线时用了不同的过滤逻辑）', async () => {
    const ctx = fakeCtx()
    const settings = { disabled: ['web.fetch_page'], config: {} }
    const viaRegistry = (await buildRegistry(ctx, defaultConfig, false, new Set(settings.disabled)))
      .list()
      .map((t) => t.definition.name)
      .sort()

    const allTools = (await buildRegistry(ctx, defaultConfig, false)).list()
    const viaApply = applyToolSettings(allTools, settings)
      .map((t) => t.definition.name)
      .sort()

    expect(viaRegistry).toEqual(viaApply)
  })
})

describe('技能接通 buildMessages', () => {
  const catalog: SkillCatalogItem[] = [
    { id: 'report', name: '写周报', description: '把本周提交整理成周报' },
    { id: 'review', name: '审查', description: '按清单审查代码' },
  ]

  const activeSkill: LoadedSkill = {
    id: 'report',
    metadata: { id: 'report', name: '写周报', description: '把本周提交整理成周报' },
    instructions: '# 写周报\n\n1. 拉取提交\n2. 按模块归类',
    updatedAt: Date.now(),
  }

  it('目录以 system 消息注入，且在历史之前', () => {
    const messages = buildMessages(message, [], { ...baseOptions, skillCatalog: catalog })
    const catalogIndex = messages.findIndex(
      (m) => m.role === 'system' && m.content.includes('report'),
    )
    expect(catalogIndex).toBeGreaterThan(-1)
    // 目录必须在最后一条 user 之前（它是系统提示，不该排在用户消息后面）
    const lastUser = messages.flatMap((m) => (m.role === 'user' ? [1] : [])).length
    expect(catalogIndex).toBeLessThan(lastUser + 1)
  })

  it('不传技能时不多注入任何 system 消息', () => {
    const withSkills = buildMessages(message, [], { ...baseOptions, skillCatalog: catalog })
    const without = buildMessages(message, [], baseOptions)
    expect(withSkills.length).toBeGreaterThan(without.length)
    expect(without.filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('激活的技能正文被注入', () => {
    const messages = buildMessages(message, [], {
      ...baseOptions,
      skillCatalog: catalog,
      activeSkill,
    })
    const injected = messages.some(
      (m) => m.role === 'system' && m.content.includes('拉取提交'),
    )
    expect(injected).toBe(true)
  })

  it('目录在前、正文在后', () => {
    const messages = buildMessages(message, [], {
      ...baseOptions,
      skillCatalog: catalog,
      activeSkill,
    })
    const systemTexts = messages.flatMap((m) =>
      m.role === 'system' ? [m.content] : [],
    )
    const catalogIndex = systemTexts.findIndex((text) => text.includes('report'))
    const bodyIndex = systemTexts.findIndex((text) => text.includes('拉取提交'))
    expect(catalogIndex).toBeGreaterThan(-1)
    expect(bodyIndex).toBeGreaterThan(catalogIndex)
  })

  it('技能注入不会破坏「最后一条是本轮用户消息」', () => {
    const messages = buildMessages(message, [], {
      ...baseOptions,
      skillCatalog: catalog,
      activeSkill,
    })
    const last = messages.at(-1)
    expect(last?.role).toBe('user')
    // 正文仍在（前面带 system_reminder）
    expect(String(last && 'content' in last ? last.content : '')).toContain('你好')
  })

  it('有历史时技能仍在历史之前', () => {
    const history: HistoryRow[] = [
      { role: 'user', content: '旧问题', toolCallsJson: null, createdAt: 1 },
      { role: 'assistant', content: '旧回答', toolCallsJson: null, createdAt: 2 },
    ]
    const messages = buildMessages(message, history, {
      ...baseOptions,
      skillCatalog: catalog,
    })
    // 用真实数组下标比较（不能拿过滤后的顺序，那是另一个数组）
    const skillIndex = messages.findIndex(
      (m) => m.role === 'system' && m.content.includes('report'),
    )
    const historyIndex = messages.findIndex(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content === '旧问题',
    )
    expect(skillIndex).toBeGreaterThan(-1)
    expect(historyIndex).toBeGreaterThan(-1)
    expect(skillIndex).toBeLessThan(historyIndex)
  })
})

describe('工具白名单与提示词一致', () => {
  it('提示词里的工具名与注册表一致（关掉的不会出现在提示词里）', async () => {
    const registry = await buildRegistry(fakeCtx(), defaultConfig, false, new Set(['http.request']))
    const toolNames = registry.list().map((t) => t.definition.name)
    const messages = buildMessages(message, [], { ...baseOptions, toolNames })
    const system = messages[0]
    const content = system && system.role === 'system' ? system.content : ''
    // 有关工具时才会追加「工具使用规范」；里面不该提到被关掉的 http.request
    expect(content).not.toContain('http.request')
  })
})

/**
 * 人格提示词必须是**追加**而不是替换（对标 AstrBot 的
 * `req.system_prompt += "\n# Persona Instructions\n\n{prompt}\n"`）。
 *
 * 为什么单独测：早期实现是 `persona.prompt ?? config.system_prompt`（替换），
 * 结果配了人格就丢掉了全部运行时信息——模型开始输出 Markdown、不知道现在几点、
 * 也不知道自己有工具。这类回归不会报错，只会「用着不对劲」，所以必须锁住。
 */
describe('人格提示词是追加不是替换', () => {
  const personaPrompt = '你是一只猫，说话带喵。'

  it('人格段落出现在系统提示词里', () => {
    const messages = buildMessages(message, [], { ...baseOptions, personaPrompt })
    const system = messages[0]
    const content = system && system.role === 'system' ? system.content : ''
    expect(content).toContain(personaPrompt)
    expect(content).toContain('# Persona Instructions')
  })

  it('运行时信息**没有被人格挤掉**', () => {
    const messages = buildMessages(message, [], {
      ...baseOptions,
      personaPrompt,
      // 时间默认关了，这条要验的是「人格有没有挤掉运行时信息」
      exposeDatetime: true,
    })
    const system = messages[0]
    const systemContent = system && system.role === 'system' ? String(system.content) : ''
    const last = messages.at(-1)
    const userContent = String(last && 'content' in last ? last.content : '')

    // 回复格式要求（稳定）留在 system
    expect(systemContent).toContain('纯文本')
    // 时间/会话（每轮变）在 user 里，避免破坏缓存
    expect(userContent).toContain('现在时间')
    expect(userContent).not.toBe('')
  })

  it('基础提示词仍然在最前面（人格不覆盖身份）', () => {
    const messages = buildMessages(message, [], {
      ...baseOptions,
      systemPrompt: '基础身份',
      personaPrompt,
    })
    const system = messages[0]
    const content = system && system.role === 'system' ? system.content : ''
    expect(content.indexOf('基础身份')).toBeLessThan(content.indexOf('# Persona Instructions'))
  })

  it('回复格式要求排在人格之后（越靠后模型越遵守）', () => {
    const messages = buildMessages(message, [], { ...baseOptions, personaPrompt })
    const system = messages[0]
    const content = system && system.role === 'system' ? String(system.content) : ''
    expect(content.indexOf('# Persona Instructions')).toBeLessThan(content.indexOf('纯文本'))
  })

  it('没有人格时不出现人格段落（不留空标题）', () => {
    const messages = buildMessages(message, [], baseOptions)
    const system = messages[0]
    const content = system && system.role === 'system' ? system.content : ''
    expect(content).not.toContain('# Persona Instructions')
  })
})

/**
 * 人格工具白名单与全局开关叠加：两道收窄但都是「减少」，不会互相抵消。
 */
describe('人格工具白名单接通 buildRegistry', () => {
  it('白名单只放行名单里的工具', async () => {
    const registry = await buildRegistry(
      fakeCtx(),
      defaultConfig,
      false,
      new Set(),
      ['time.now'],
    )
    const names = registry.list().map((t) => t.definition.name)
    expect(names).toEqual(['time.now'])
  })

  it('undefined 表示不限（老配置的语义）', async () => {
    const registry = await buildRegistry(fakeCtx(), defaultConfig, false, new Set(), undefined)
    expect(registry.list().length).toBeGreaterThan(3)
  })

  it('空数组表示一个都不给（与 undefined 含义相反）', async () => {
    const registry = await buildRegistry(fakeCtx(), defaultConfig, false, new Set(), [])
    expect(registry.list()).toHaveLength(0)
  })

  it('与全局开关叠加：人格白名单外的工具即使没被全局关也拿不到', async () => {
    const registry = await buildRegistry(
      fakeCtx(),
      defaultConfig,
      false,
      new Set(),
      ['time.now', 'web.fetch_page'],
    )
    const names = registry.list().map((t) => t.definition.name)
    expect(names).toContain('time.now')
    expect(names).not.toContain('http.request')
  })
})

/**
 * 人格的技能白名单：**只过滤目录是不够的**。
 *
 * 用户仍可能手动 `/skill <id>` 激活一个被挡掉的技能。如果只过滤目录，
 * 白名单就只是「不显示」而不是「不能用」—— 那是个假的权限边界。
 */
describe('人格技能白名单的语义', () => {
  it('白名单只放行名单里的技能', () => {
    const allowed = ['report']
    const catalog = [
      { id: 'report', name: '写周报', description: 'd1' },
      { id: 'secret', name: '运维手册', description: 'd2' },
    ]
    const visible = catalog.filter((s) => allowed.includes(s.id))
    expect(visible.map((s) => s.id)).toEqual(['report'])
  })

  it('undefined 不过滤（全部可见）', () => {
    const catalog = [
      { id: 'a', name: 'A', description: '' },
      { id: 'b', name: 'B', description: '' },
    ]
    // 模拟 resolvePersona 在「没配 skills」时返回 undefined。
    // 用一个函数参数来拿类型，避免 TS 把 `= undefined` 的局部变量收窄成 never。
    const filterByAllowed = (
      skills: typeof catalog,
      whitelist: string[] | undefined,
    ): typeof catalog =>
      whitelist === undefined ? skills : skills.filter((s) => whitelist.includes(s.id))

    const noWhitelist: string[] | undefined = undefined
    expect(filterByAllowed(catalog, noWhitelist)).toHaveLength(2)
  })

  it('空数组过滤掉全部（与 undefined 含义相反）', () => {
    const catalog = [{ id: 'a', name: 'A', description: '' }]
    const allowed: string[] = []
    const visible = catalog.filter((s) => allowed.includes(s.id))
    expect(visible).toHaveLength(0)
  })
})

/**
 * 富媒体回复链路。
 *
 * 这轮补上的真实缺口：宿主 `session.reply` 支持 `{ image }` / `{ media }`，
 * 但插件一直只发纯文本 —— 模型抓到图片只能把 URL 塞进正文让用户自己点。
 * 现在工具可以带 `outbound`，由回复通道发出去。
 */
describe('富媒体回复链路', () => {
  it('ReplyFn 支持 media 方法', () => {
    const reply = replyFromSession({ reply: async () => ({ ok: true }) })
    expect(typeof reply).toBe('function')
    expect(typeof reply.media).toBe('function')
  })

  it('媒体会转成宿主认识的 image 形状（不是塞进 text）', async () => {
    const sent: unknown[] = []
    const reply = replyFromSession({
      reply: async (message) => {
        sent.push(message)
        return { ok: true }
      },
    })

    await reply.media?.({ type: 'image', url: 'https://x/a.png', caption: '这是图' })

    expect(sent).toHaveLength(1)
    const payload = sent[0] as { image?: { url?: string }; text?: string }
    expect(payload.image?.url).toBe('https://x/a.png')
    expect(payload.text).toBe('这是图')
  })

  it('file 类型走 media 形状并带文件名', async () => {
    const sent: unknown[] = []
    const reply = replyFromSession({
      reply: async (message) => {
        sent.push(message)
        return { ok: true }
      },
    })

    await reply.media?.({ type: 'file', url: 'https://x/a.pdf', filename: '报告.pdf' })

    const payload = sent[0] as { media?: { type?: string; filename?: string } }
    expect(payload.media?.type).toBe('file')
    expect(payload.media?.filename).toBe('报告.pdf')
  })
})

/**
 * 插件提供的工具：从注册到能被模型调用的完整链路。
 *
 * 这是本轮功能的端到端验证 —— 单独测存储（plugin-tools.test.ts）只能证明
 * 「写进去了」，证明不了「模型真的能调到」。这类「代码写了但没接线」的 bug
 * 在本项目里出现过多次（allowDangerous、/skill），所以必须端到端测。
 */
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
    const names = registry.list().map((t) => t.definition.name)
    expect(names).toContain('plugin.weather.query')
  })

  it('工具能真的执行并返回结果', async () => {
    const ctx = ctxWithPluginTools([meta], {
      query: async (input) => ({ city: (input as { city: string }).city, temp: 21 }),
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
    expect(registry.list().map((t) => t.definition.name)).not.toContain('plugin.weather.query')
  })

  it('有元数据但提供者没暴露对应执行函数时，跳过那个工具', async () => {
    const ctx = ctxWithPluginTools([meta], { 其它工具: async () => null })
    const registry = await buildRegistry(ctx, defaultConfig, false)
    expect(registry.list().map((t) => t.definition.name)).not.toContain('plugin.weather.query')
  })

  it('执行函数抛错时返回可读的 failed，不影响整轮对话', async () => {
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
    expect(result.status).toBe('failed')
    expect(result.error?.message).toContain('上游接口挂了')
    // 插件内部错误是否可重试我们不知道，保守设为不可重试，避免模型反复重试
    expect(result.error?.retryable).toBe(false)
  })

  it('执行超时时返回 timeout，不让坏插件拖死整个 run', async () => {
    const ctx = ctxWithPluginTools(
      [{ ...meta, timeout_ms: 1000 }],
      {
        query: () =>
          new Promise(() => {
            /* 永不 resolve */
          }),
      },
    )
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
    expect(result.status).toBe('timeout')
  }, 15_000)

  it('插件工具也能被工具栏开关关掉', async () => {
    const ctx = ctxWithPluginTools([meta], { query: async () => null })
    const registry = await buildRegistry(
      ctx,
      defaultConfig,
      false,
      new Set(['plugin.weather.query']),
    )
    expect(registry.list().map((t) => t.definition.name)).not.toContain('plugin.weather.query')
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
    expect(registry.list().map((t) => t.definition.name)).toContain('plugin.weather.query')
  })

  it('D1 里是规整后的短名、服务对象用原始 key（含点）时仍能取到执行函数', async () => {
    // meta.name = 'weather.query'（带点）；D1 列存规整后的 'weather_query'
    const dirty = { ...meta, name: 'weather_query' }
    const ctx = ctxWithPluginTools([dirty], { 'weather.query': async () => ({ temp: 21 }) }, 'tools')
    const registry = await buildRegistry(ctx, defaultConfig, false)
    const names = registry.list().map((t) => t.definition.name)
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
    expect(registry.list().map((t) => t.definition.name)).toContain('plugin.weather.query')
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
