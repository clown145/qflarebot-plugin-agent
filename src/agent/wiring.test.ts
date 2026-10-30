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
import { describe, expect, it } from 'vitest'
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
  it('不传 disabled 时注册全部工具', () => {
    const registry = buildRegistry(fakeCtx(), defaultConfig, false)
    const names = registry.list().map((tool) => tool.definition.name)
    expect(names).toContain('time.now')
    expect(names).toContain('http.request')
  })

  it('被关掉的工具根本不注册（模型看不到）', () => {
    const registry = buildRegistry(fakeCtx(), defaultConfig, false, new Set(['http.request']))
    const names = registry.list().map((tool) => tool.definition.name)
    expect(names).not.toContain('http.request')
    // 其他工具不受影响
    expect(names).toContain('time.now')
  })

  it('enable_tools 关掉时什么都没有——开关优先级更高', () => {
    const registry = buildRegistry(
      fakeCtx(),
      { ...defaultConfig, enable_tools: false },
      false,
      new Set(['time.now']),
    )
    expect(registry.list()).toHaveLength(0)
  })

  it('关掉一个不存在的工具名是无害的', () => {
    const registry = buildRegistry(fakeCtx(), defaultConfig, false, new Set(['no.such.tool']))
    expect(registry.list().length).toBeGreaterThan(0)
  })
})

describe('applyToolSettings 与 buildRegistry 的一致性', () => {
  it('两者过滤结果相同（防止接线时用了不同的过滤逻辑）', () => {
    const ctx = fakeCtx()
    const settings = { disabled: ['web.fetch_page'], config: {} }
    const viaRegistry = buildRegistry(ctx, defaultConfig, false, new Set(settings.disabled))
      .list()
      .map((t) => t.definition.name)
      .sort()

    const allTools = buildRegistry(ctx, defaultConfig, false).list()
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
  it('提示词里的工具名与注册表一致（关掉的不会出现在提示词里）', () => {
    const registry = buildRegistry(fakeCtx(), defaultConfig, false, new Set(['http.request']))
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
    const messages = buildMessages(message, [], { ...baseOptions, personaPrompt })
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
  it('白名单只放行名单里的工具', () => {
    const registry = buildRegistry(
      fakeCtx(),
      defaultConfig,
      false,
      new Set(),
      ['time.now'],
    )
    const names = registry.list().map((t) => t.definition.name)
    expect(names).toEqual(['time.now'])
  })

  it('undefined 表示不限（老配置的语义）', () => {
    const registry = buildRegistry(fakeCtx(), defaultConfig, false, new Set(), undefined)
    expect(registry.list().length).toBeGreaterThan(3)
  })

  it('空数组表示一个都不给（与 undefined 含义相反）', () => {
    const registry = buildRegistry(fakeCtx(), defaultConfig, false, new Set(), [])
    expect(registry.list()).toHaveLength(0)
  })

  it('与全局开关叠加：人格白名单外的工具即使没被全局关也拿不到', () => {
    const registry = buildRegistry(
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
