import { describe, expect, it } from 'vitest'
import {
  compactMessages,
  estimateMessagesTokens,
  estimateTextTokens,
  fixMessages,
  splitIntoRounds,
} from './context-size.js'
import type { ModelMessage } from '../types.js'

function user(text: string): ModelMessage {
  return { role: 'user', content: text }
}

function assistant(text: string): ModelMessage {
  return { role: 'assistant', content: text }
}

function assistantWithCalls(ids: string[]): ModelMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: ids.map((id) => ({ id, name: 'time.now', arguments: {} })),
  }
}

function toolResult(id: string, content = '{}'): ModelMessage {
  return { role: 'tool', toolCallId: id, toolName: 'time.now', content }
}

describe('estimateTextTokens', () => {
  it('中文按 0.6/字估算', () => {
    // 4 个汉字 = 2.4 → ceil = 3
    expect(estimateTextTokens('你好世界')).toBe(3)
  })

  it('英文按 0.3/字符估算', () => {
    // 10 个字符 = 3
    expect(estimateTextTokens('abcdefghij')).toBe(3)
  })

  it('中英混排分别计算', () => {
    // 2 汉字 = 1.2，4 字符 = 1.2 → 2.4 → ceil 3
    expect(estimateTextTokens('你好abcd')).toBe(3)
  })

  it('空串是 0', () => {
    expect(estimateTextTokens('')).toBe(0)
  })

  it('日文假名也算 CJK', () => {
    expect(estimateTextTokens('ありがとう')).toBe(3)
  })
})

describe('estimateMessagesTokens', () => {
  it('工具结果只算 content', () => {
    expect(estimateMessagesTokens([toolResult('a', 'abcdefghij')])).toBe(3)
  })

  it('assistant 的工具调用参数也要算', () => {
    const withCall: ModelMessage = {
      role: 'assistant',
      content: 'abc',
      toolCalls: [{ id: 'x', name: 'vfs.read_file', arguments: { path: '/a' } }],
    }
    const plain: ModelMessage = { role: 'assistant', content: 'abc' }
    expect(estimateMessagesTokens([withCall])).toBeGreaterThan(estimateMessagesTokens([plain]))
  })

  it('图片按每张 765 算', () => {
    const withImage: ModelMessage = {
      role: 'user',
      content: [{ type: 'image', url: 'https://x/y.png' }],
    }
    expect(estimateMessagesTokens([withImage])).toBe(765)
  })

  it('多模态文本段与图片相加', () => {
    const mixed: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '你好' },
        { type: 'image', data: 'xxx' },
      ],
    }
    // 2 汉字 = 1.2 → ceil 2，图片 765
    expect(estimateMessagesTokens([mixed])).toBe(767)
  })
})

describe('fixMessages', () => {
  it('丢弃没有前置 assistant 的孤儿 tool 消息', () => {
    const input: ModelMessage[] = [user('hi'), toolResult('orphan'), assistant('ok')]
    const fixed = fixMessages(input)
    expect(fixed.some((m) => m.role === 'tool')).toBe(false)
    expect(fixed).toHaveLength(2)
  })

  it('保留配对的 assistant + tool', () => {
    const input: ModelMessage[] = [
      user('现在几点'),
      assistantWithCalls(['c1']),
      toolResult('c1'),
      assistant('十点'),
    ]
    const fixed = fixMessages(input)
    expect(fixed).toHaveLength(4)
    expect(fixed[1]?.role).toBe('assistant')
    expect(fixed[2]?.role).toBe('tool')
  })

  it('丢弃「有调用但没有任何结果」的 assistant', () => {
    const input: ModelMessage[] = [user('hi'), assistantWithCalls(['c1']), assistant('算了')]
    const fixed = fixMessages(input)
    // 带调用的 assistant 被去掉，只剩 user + 后面的 assistant
    expect(fixed).toHaveLength(2)
    expect(fixed[0]).toEqual(user('hi'))
    expect(fixed[1]).toEqual(assistant('算了'))
  })

  it('多个工具调用都配齐时全部保留', () => {
    const input: ModelMessage[] = [
      user('x'),
      assistantWithCalls(['c1', 'c2']),
      toolResult('c1'),
      toolResult('c2'),
    ]
    expect(fixMessages(input)).toHaveLength(4)
  })

  it('部分工具结果缺失时，保留已有的（assistant 不丢）', () => {
    const input: ModelMessage[] = [
      user('x'),
      assistantWithCalls(['c1', 'c2']),
      toolResult('c1'),
    ]
    const fixed = fixMessages(input)
    expect(fixed).toHaveLength(3)
    expect(fixed.filter((m) => m.role === 'tool')).toHaveLength(1)
  })

  it('system 段永远在最前且不动', () => {
    const input: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      toolResult('orphan'),
      user('hi'),
    ]
    const fixed = fixMessages(input)
    expect(fixed[0]).toEqual({ role: 'system', content: 'sys' })
    expect(fixed).toHaveLength(2)
  })

  it('保证 system 后第一条是 user', () => {
    const input: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      assistant('开场白'),
      user('你好'),
    ]
    const fixed = fixMessages(input)
    expect(fixed[1]?.role).toBe('user')
    expect(fixed[2]?.role).toBe('assistant')
  })

  it('空数组原样返回', () => {
    expect(fixMessages([])).toEqual([])
  })

  it('全是孤儿 tool 时返回空（除 system）', () => {
    const input: ModelMessage[] = [toolResult('a'), toolResult('b')]
    expect(fixMessages(input)).toEqual([])
  })
})

describe('splitIntoRounds', () => {
  it('一个 user + 其后的 assistant/tool 算一轮', () => {
    const rounds = splitIntoRounds([
      user('a'),
      assistantWithCalls(['c1']),
      toolResult('c1'),
      assistant('r1'),
      user('b'),
      assistant('r2'),
    ])
    expect(rounds).toHaveLength(2)
    expect(rounds[0]?.messages).toHaveLength(4)
    expect(rounds[1]?.messages).toHaveLength(2)
  })

  it('开头的 assistant 自成一轮（人格开场白）', () => {
    const rounds = splitIntoRounds([assistant('我是小猫'), user('你好'), assistant('喵')])
    expect(rounds).toHaveLength(2)
    expect(rounds[0]?.messages[0]?.role).toBe('assistant')
  })

  it('每轮带 token 估算', () => {
    const rounds = splitIntoRounds([user('你好'), assistant('你好呀')])
    expect(rounds[0]?.tokens).toBeGreaterThan(0)
  })
})

describe('compactMessages', () => {
  it('低于阈值时不压缩', () => {
    const messages = [user('你好'), assistant('你好')]
    const result = compactMessages(messages, { maxTokens: 100_000 })
    expect(result.droppedRounds).toBe(0)
    expect(result.messages).toBe(messages)
  })

  it('超过阈值时丢掉最老的整轮', () => {
    const long = '很长的历史内容'.repeat(200)
    const messages: ModelMessage[] = [
      user(long),
      assistant(long),
      user('第二句'),
      assistant('第二答'),
      user('第三句'),
      assistant('第三答'),
    ]
    const result = compactMessages(messages, { maxTokens: 100 })
    expect(result.droppedRounds).toBeGreaterThan(0)
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore)
  })

  it('永远保留最新一轮', () => {
    const long = '内容'.repeat(500)
    const messages: ModelMessage[] = [
      user(long),
      assistant(long),
      user('最后的问题'),
      assistant('最后答'),
    ]
    const result = compactMessages(messages, { maxTokens: 10 })
    const last = result.messages.filter((m) => m.role === 'user').pop()
    expect(last).toEqual(user('最后的问题'))
  })

  it('只有一轮时不压（否则等于删掉本轮问题）', () => {
    const messages = [user('唯一的问题')]
    const result = compactMessages(messages, { maxTokens: 1 })
    expect(result.droppedRounds).toBe(0)
    expect(result.messages).toHaveLength(1)
  })

  it('压缩后工具配对仍然合法', () => {
    const long = '历史'.repeat(300)
    const messages: ModelMessage[] = [
      user(long),
      assistantWithCalls(['c1']),
      toolResult('c1', long),
      assistant(long),
      user('新问题'),
      assistantWithCalls(['c2']),
      toolResult('c2'),
    ]
    const result = compactMessages(messages, { maxTokens: 50 })
    // 任何残留的 tool 消息都必须能往前找到配对的 assistant
    for (let i = 0; i < result.messages.length; i += 1) {
      if (result.messages[i]?.role === 'tool') {
        expect(result.messages[i - 1]?.role).toBe('assistant')
      }
    }
  })

  it('一次最多丢一半的轮，避免上下文抖动过大', () => {
    const long = '内容'.repeat(400)
    const messages: ModelMessage[] = []
    for (let i = 0; i < 8; i += 1) {
      messages.push(user(`${long}${i}`), assistant(long))
    }
    const result = compactMessages(messages, { maxTokens: 1 })
    // 8 轮，最多丢 4 轮
    expect(result.droppedRounds).toBeLessThanOrEqual(4)
  })

  it('把 systemTokens 计入总量', () => {
    const messages = [user('短'), assistant('短')]
    const without = compactMessages(messages, { maxTokens: 100_000 })
    const withSystem = compactMessages(messages, { maxTokens: 5, systemTokens: 10_000 })
    expect(without.droppedRounds).toBe(0)
    // 只有一轮所以仍然不丢，但这条保证调用方传了 systemTokens 不会报错
    expect(withSystem.droppedRounds).toBe(0)
  })
})
