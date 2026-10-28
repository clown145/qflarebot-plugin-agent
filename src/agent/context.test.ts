import { describe, expect, it } from 'vitest'
import { buildMessages, toHistoryRows } from './context.js'
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
    expect(messages.at(-1)).toEqual({ role: 'user', content: '你好' })
  })

  it('系统提示词里带上当前时间与时区，模型不需要调工具问时间', () => {
    const messages = buildMessages(message(), [], { ...baseOptions, timezone: 'Asia/Shanghai' })
    const system = messages[0]
    expect(system?.role).toBe('system')
    const content = system && 'content' in system ? system.content : ''
    expect(content).toContain('Asia/Shanghai')
    expect(content).toContain('现在时间')
  })

  it('自定义提示词会盖掉默认人格，但环境信息仍然追加', () => {
    const messages = buildMessages(message(), [], { ...baseOptions, systemPrompt: '你是猫娘' })
    const system = messages[0]
    const content = system && 'content' in system ? system.content : ''
    expect(content).toContain('你是猫娘')
    expect(content).toContain('现在时间')
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

  it('历史里 assistant 的工具调用要一起回放，否则模型看不到自己的调用记录', () => {
    const history: HistoryRow[] = [
      { role: 'user', content: '查天气', toolCallsJson: null, createdAt: 1 },
      {
        role: 'assistant',
        content: '我查一下',
        toolCallsJson: JSON.stringify([{ id: 'c1', name: 'http.request', arguments: { url: 'x' } }]),
        createdAt: 2,
      },
    ]
    const messages = buildMessages(message(), history, baseOptions)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant && 'toolCalls' in assistant ? assistant.toolCalls : undefined).toEqual([
      { id: 'c1', name: 'http.request', arguments: { url: 'x' } },
    ])
  })

  it('历史里坏掉的 toolCallsJson 不会让整个对话失败', () => {
    const history: HistoryRow[] = [
      { role: 'assistant', content: '坏的', toolCallsJson: '{not json', createdAt: 1 },
    ]
    const messages = buildMessages(message(), history, baseOptions)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant && 'toolCalls' in assistant ? assistant.toolCalls : undefined).toBeUndefined()
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

describe('toHistoryRows', () => {
  it('生成 user + assistant 两行，时间戳递增保证顺序', () => {
    const rows = toHistoryRows('问题', '回答', [])
    expect(rows).toHaveLength(2)
    expect(rows[0]?.role).toBe('user')
    expect(rows[1]?.role).toBe('assistant')
    expect(rows[1]!.createdAt).toBeGreaterThan(rows[0]!.createdAt)
  })

  it('有工具调用时序列化进 toolCallsJson', () => {
    const rows = toHistoryRows('问题', '回答', [
      { id: 'c1', name: 'time.now', arguments: {} },
    ])
    expect(rows[1]?.toolCallsJson).toContain('time.now')
  })

  it('没有工具调用时 toolCallsJson 是 null，不是 "[]"', () => {
    const rows = toHistoryRows('问题', '回答', [])
    expect(rows[1]?.toolCallsJson).toBeNull()
  })
})
