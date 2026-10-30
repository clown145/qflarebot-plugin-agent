import { describe, expect, it } from 'vitest'
import { buildMessages, serializeToolTraces } from './context.js'
import type { HistoryRow } from '../do/agent-object.js'
import type { InboundMessage } from '../types.js'

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    conversation: 'group:g1',
    userId: 'u1',
    userName: '小明',
    text: '你好',
    displayText: '你好',
    attachments: [],
    scene: 'group',
    targetId: 'g1',
    receivedAt: Date.now(),
    ...overrides,
  }
}

const baseOptions = {
  timezone: 'Asia/Shanghai',
  historyLimit: 20,
  supportsVision: false,
}

describe('buildMessages', () => {
  it('第一条永远是 system，最后一条是本轮用户消息', () => {
    const messages = buildMessages(message(), [], baseOptions)
    expect(messages[0]?.role).toBe('system')
    const last = messages.at(-1)
    expect(last?.role).toBe('user')
    // 用户消息前面会带 system_reminder（时间/会话/说话人），正文仍在末尾
    expect(String(last && 'content' in last ? last.content : '')).toContain('你好')
  })

  /**
   * 环境信息（时间/时区）在**本轮 user 消息**里，不在 system 里。
   *
   * 这是缓存修复的核心：system 必须跨轮稳定，否则前缀缓存每轮失效。
   * 见 `buildSystemReminder` 的注释。
   */
  it('环境信息（时间/时区）附在本轮用户消息上，模型不用调工具问时间', () => {
    const messages = buildMessages(message(), [], {
      ...baseOptions,
      timezone: 'Asia/Shanghai',
      // 时间默认关了（time.now 工具能取），这条测的是「放在哪」不是「开不开」
      exposeDatetime: true,
    })
    const last = messages.at(-1)
    const content = String(last && 'content' in last ? last.content : '')
    expect(content).toContain('Asia/Shanghai')
    expect(content).toContain('现在时间')
    expect(content).toContain('<system_reminder>')
  })

  it('自定义提示词在 system 里，环境信息在 user 里', () => {
    const messages = buildMessages(message(), [], {
      ...baseOptions,
      systemPrompt: '你是猫娘',
      exposeDatetime: true,
    })
    const system = messages[0]
    const systemContent = system && 'content' in system ? String(system.content) : ''
    const last = messages.at(-1)
    const userContent = String(last && 'content' in last ? last.content : '')

    expect(systemContent).toContain('你是猫娘')
    // 环境信息不该在 system 里（那会破坏缓存）
    expect(systemContent).not.toContain('现在时间')
    expect(userContent).toContain('现在时间')
  })

  it('historyLimit 为 0 时不带任何历史', () => {
    const history: HistoryRow[] = [
      { role: 'user', content: '旧问题', toolCallsJson: null, createdAt: 1 },
      { role: 'assistant', content: '旧回答', toolCallsJson: null, createdAt: 2 },
    ]
    const messages = buildMessages(message(), history, { ...baseOptions, historyLimit: 0 })
    expect(messages).toHaveLength(2) // system + 本轮
  })

  it('历史超过上限时只保留最近 N 条', () => {
    const history: HistoryRow[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `第${i}条`,
      toolCallsJson: null,
      createdAt: i,
    }))
    const messages = buildMessages(message(), history, { ...baseOptions, historyLimit: 4 })
    // system + 4 条历史 + 本轮
    expect(messages).toHaveLength(6)
    expect(messages[1]).toEqual({ role: 'user', content: '第6条' })
  })

  it('历史里的工具调用回放成正文说明（不伪造协议级 tool_calls）', () => {
    const history: HistoryRow[] = [
      { role: 'user', content: '查天气', toolCallsJson: null, createdAt: 1 },
      {
        role: 'assistant',
        content: '我查一下',
        toolCallsJson: JSON.stringify([
          { name: 'http.request', args: '{"url":"x"}', result: '{"ok":true}', status: 'success' },
        ]),
        createdAt: 2,
      },
    ]
    const messages = buildMessages(message(), history, baseOptions)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // 不再还原成协议级 toolCalls：历史里存的是截断过的摘要，还原成协议消息
    // 会让模型误以为拿到完整结果。改为在正文里说明上一轮调过什么。
    const content = assistant && typeof assistant.content === 'string' ? assistant.content : ''
    expect(content).toContain('我查一下')
    expect(content).toContain('http.request')
    expect(content).toContain('上一轮调用过的工具')
  })

  it('历史里的老格式 ModelToolCall 也能读出（向后兼容）', () => {
    const history: HistoryRow[] = [
      {
        role: 'assistant',
        content: '旧数据',
        toolCallsJson: JSON.stringify([{ id: 'c1', name: 'http.request', arguments: { url: 'x' } }]),
        createdAt: 1,
      },
    ]
    const messages = buildMessages(message(), history, baseOptions)
    const assistant = messages.find((m) => m.role === 'assistant')
    const content = assistant && typeof assistant.content === 'string' ? assistant.content : ''
    expect(content).toContain('http.request')
  })

  it('历史里坏掉的 toolCallsJson 不会让整个对话失败', () => {
    const history: HistoryRow[] = [
      { role: 'assistant', content: '坏的', toolCallsJson: '{not json', createdAt: 1 },
    ]
    const messages = buildMessages(message(), history, baseOptions)
    const assistant = messages.find((m) => m.role === 'assistant')
    // 读不懂就当没有工具调用，正文原样保留
    expect(assistant).toEqual({ role: 'assistant', content: '坏的' })
  })

  it('模型不支持图片时，图片退回成正文里的地址说明', () => {
    const messages = buildMessages(
      message({
        text: '看这个',
        attachments: [{ type: 'image', url: 'https://example.com/a.png' }],
      }),
      [],
      { ...baseOptions, supportsVision: false },
    )
    const last = messages.at(-1)
    expect(typeof (last && 'content' in last ? last.content : '')).toBe('string')
    expect(last && 'content' in last ? last.content : '').toContain('https://example.com/a.png')
  })

  it('模型支持图片时，图片转成内容片段', () => {
    const messages = buildMessages(
      message({
        text: '看这个',
        attachments: [{ type: 'image', url: 'https://example.com/a.png' }],
      }),
      [],
      { ...baseOptions, supportsVision: true },
    )
    const last = messages.at(-1)
    const content = last && 'content' in last ? last.content : undefined
    expect(Array.isArray(content)).toBe(true)
    expect(content).toContainEqual({ type: 'image', url: 'https://example.com/a.png' })
  })
})

describe('serializeToolTraces', () => {
  it('有工具调用时序列化成 JSON', () => {
    const json = serializeToolTraces([
      { name: 'time.now', args: '{}', result: '{"now":"..."}', status: 'success' },
    ])
    expect(json).toContain('time.now')
  })

  it('没有工具调用时返回 null，不是 "[]"', () => {
    // 存 "[]" 会让历史回放误以为「有工具调用但结果为空」
    expect(serializeToolTraces([])).toBeNull()
  })
})

/**
 * 缓存：system prompt 必须跨轮稳定。
 *
 * 模型的 prompt 缓存是**前缀匹配**的 —— 从第一个字符逐字比对，命中到断点为止。
 * 只要 system 里有任何每轮会变的内容（时间、会话、说话人），
 * 它**之后**的全部内容每轮都要重新计费。
 *
 * 这组测试把「system 不含动态内容」变成契约，防止以后有人图方便把
 * 时间又塞回 system。
 */
describe('缓存：system prompt 跨轮稳定', () => {
  /** 取出 system 内容 */
  function systemOf(messages: ReturnType<typeof buildMessages>): string {
    const first = messages[0]
    return first && first.role === 'system' ? String(first.content) : ''
  }

  it('不同时间构造的 system 完全相同（时间不在 system 里）', () => {
    // 用手动改 Date 的方式模拟「跨分钟」
    const realNow = Date.now
    try {
      Date.now = () => new Date('2026-10-30T10:00:00+08:00').getTime()
      const morning = systemOf(buildMessages(message(), [], baseOptions))

      Date.now = () => new Date('2026-10-30T23:59:00+08:00').getTime()
      const night = systemOf(buildMessages(message(), [], baseOptions))

      expect(morning).toBe(night)
    } finally {
      Date.now = realNow
    }
  })

  it('不同说话人的 system 完全相同', () => {
    const a = systemOf(buildMessages(message({ userName: '小明' }), [], baseOptions))
    const b = systemOf(buildMessages(message({ userName: '小红' }), [], baseOptions))
    expect(a).toBe(b)
  })

  it('群聊与单聊的 system 完全相同', () => {
    const group = systemOf(buildMessages(message({ scene: 'group' }), [], baseOptions))
    const c2c = systemOf(buildMessages(message({ scene: 'c2c' }), [], baseOptions))
    expect(group).toBe(c2c)
  })

  it('system 里不出现任何动态内容', () => {
    const content = systemOf(buildMessages(message(), [], baseOptions))
    expect(content).not.toContain('现在时间')
    expect(content).not.toContain('Asia/Shanghai')
    expect(content).not.toContain('单聊')
    expect(content).not.toContain('群聊')
    expect(content).not.toContain('小明')
  })

  it('动态内容确实在 user 消息里（不是丢了）', () => {
    const messages = buildMessages(message(), [], {
      ...baseOptions,
      timezone: 'Asia/Shanghai',
      exposeDatetime: true,
      exposeSenderId: true,
    })
    const last = messages.at(-1)
    const content = String(last && 'content' in last ? last.content : '')
    expect(content).toContain('<system_reminder>')
    expect(content).toContain('现在时间')
    expect(content).toContain('Asia/Shanghai')
    expect(content).toContain('群聊')
    expect(content).toContain('小明')
  })
})

/**
 * 其他插件注册的提示词片段。
 *
 * 拼在 system prompt **末尾**，属于稳定内容 —— 只要插件不改片段，
 * 前缀缓存就命中。这里验证「注入成功」+「不破坏稳定性」两件事。
 */
describe('插件提示词片段注入', () => {
  function systemOf(messages: ReturnType<typeof buildMessages>): string {
    const first = messages[0]
    return first && first.role === 'system' ? String(first.content) : ''
  }

  it('片段出现在 system prompt 里', () => {
    const messages = buildMessages(message(), [], {
      ...baseOptions,
      pluginPrompts: ['## 来自插件 weather\n天气要用中文'],
    })
    expect(systemOf(messages)).toContain('天气要用中文')
  })

  it('片段排在回复格式要求之前（属于稳定内容区）', () => {
    const messages = buildMessages(message(), [], {
      ...baseOptions,
      pluginPrompts: ['## 来自插件 weather\n天气要用中文'],
    })
    const content = systemOf(messages)
    expect(content.indexOf('天气要用中文')).toBeLessThan(content.indexOf('纯文本'))
  })

  it('没有片段时不产生空段落', () => {
    const withNone = systemOf(buildMessages(message(), [], baseOptions))
    expect(withNone).not.toContain('来自插件')
  })

  it('相同片段产生相同 system（不破坏缓存）', () => {
    const opts = { ...baseOptions, pluginPrompts: ['## 来自插件 a\nX'] }
    expect(systemOf(buildMessages(message({ userName: '小明' }), [], opts))).toBe(
      systemOf(buildMessages(message({ userName: '小红' }), [], opts)),
    )
  })
})

/**
 * 说话人身份与时是否暴露给模型。
 *
 * 对标 AstrBot 的 `identifier` / `datetime_system_prompt` 开关
 * （`astr_main_agent.py:968-997` 的 `_append_system_reminders`）。
 *
 * **关键区别：我们给的是 openid，不是 QQ 号。**
 * QQ 官方机器人接口只提供按机器人隔离的 openid，拿不到真实 QQ 号 ——
 * 所以配置项和提示词里都写 openid，不写「QQ 号」，免得工具作者误解。
 */
describe('说话人身份与时是否暴露', () => {
  /** 取本轮 user 消息的文本内容 */
  function userText(messages: ReturnType<typeof buildMessages>): string {
    const last = messages.at(-1)
    if (!last) return ''
    const content = 'content' in last ? last.content : ''
    if (typeof content === 'string') return content
    if (!content) return ''
    return content.map((part) => ('text' in part ? part.text : '')).join('')
  }

  it('默认不给 ID（只给昵称）', () => {
    const messages = buildMessages(message({ userName: '小明', userId: 'openid-123' }), [], baseOptions)
    const text = userText(messages)
    expect(text).toContain('小明')
    expect(text).not.toContain('openid-123')
    expect(text).not.toContain('openid:')
  })

  it('打开后给出 openid，措辞是 openid 而不是 QQ 号', () => {
    const messages = buildMessages(message({ userName: '小明', userId: 'openid-123' }), [], {
      ...baseOptions,
      exposeSenderId: true,
    })
    const text = userText(messages)
    expect(text).toContain('openid-123')
    expect(text).toContain('openid')
    // 不能让人误会成 QQ 号
    expect(text).not.toContain('QQ 号')
  })

  it('没有昵称时给了 ID 也能认出是谁', () => {
    const messages = buildMessages(message({ userName: '', userId: 'openid-abc' }), [], {
      ...baseOptions,
      exposeSenderId: true,
    })
    expect(userText(messages)).toContain('openid-abc')
  })

  it('关掉时间后提示词里没有日期', () => {
    const messages = buildMessages(message(), [], { ...baseOptions, exposeDatetime: false })
    const text = userText(messages)
    expect(text).not.toContain('现在时间')
    // 但会话类型还在（这是基本语境，不受这个开关影响）
    expect(text).toContain('当前会话')
  })

  it('时间默认是关的（time.now 工具已经能取）', () => {
    const messages = buildMessages(message(), [], baseOptions)
    expect(userText(messages)).not.toContain('现在时间')
  })

  it('打开后时间出现，且不影响缓存', () => {
    const messages = buildMessages(message(), [], { ...baseOptions, exposeDatetime: true })
    expect(userText(messages)).toContain('现在时间')
  })

  it('这两个开关不影响 system 的稳定性（缓存）', () => {
    // 身份与时间都在 user 消息里，system 必须跨轮一致
    const a = buildMessages(message({ userName: '小明', userId: 'u1' }), [], {
      ...baseOptions,
      exposeSenderId: true,
    })[0]
    const b = buildMessages(message({ userName: '小红', userId: 'u2' }), [], {
      ...baseOptions,
      exposeSenderId: true,
    })[0]
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
