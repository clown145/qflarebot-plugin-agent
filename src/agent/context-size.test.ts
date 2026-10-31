import { describe, expect, it } from 'vitest'
import {
  buildSummaryRequest,
  compactMessages,
  estimateMessagesTokens,
  estimateTextTokens,
  fixMessages,
  splitIntoRounds,
  summaryMessages,
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
    // 开头的孤儿 assistant 被丢掉（它的提问不在数组里，留着会制造错位）。
    // 以前这里期望 fixed[2] 是那条开场白——那正是「把 user 提到最前」的旧行为，
    // 会让回答落到错误的问题后面（见下面「保持历史时间顺序」的用例）。
    expect(fixed).toHaveLength(2)
    expect(fixed[1]).toEqual(user('你好'))
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

describe('compactMessages 交出的丢弃内容（summary 模式用）', () => {
  it('没压缩时 droppedMessages 是空数组', () => {
    const messages = [user('短'), assistant('短')]
    const result = compactMessages(messages, { maxTokens: 100_000 })
    expect(result.droppedRounds).toBe(0)
    expect(result.droppedMessages).toEqual([])
  })

  it('被丢掉的轮次按原顺序交出来，不能凭空消失', () => {
    const long = '内容'.repeat(400)
    const messages: ModelMessage[] = []
    for (let i = 0; i < 6; i += 1) {
      messages.push(user(`问题${i}${long}`), assistant(`回答${i}${long}`))
    }
    const result = compactMessages(messages, { maxTokens: 1 })

    expect(result.droppedRounds).toBeGreaterThan(0)
    // 丢掉的条数 = 轮数 × 每轮 2 条
    expect(result.droppedMessages).toHaveLength(result.droppedRounds * 2)
    // 从最老的开始，顺序保持
    expect(result.droppedMessages[0]).toMatchObject({ role: 'user' })
    expect(String(result.droppedMessages[0]?.content)).toContain('问题0')
    expect(String(result.droppedMessages[1]?.content)).toContain('回答0')
  })

  it('丢掉的轮次里包含工具调用与结果（摘要不该漏掉用过什么工具）', () => {
    const long = 'x'.repeat(2000)
    const messages: ModelMessage[] = [
      user(`第一问${long}`),
      assistantWithCalls(['c1']),
      toolResult('c1', long),
      assistant(`第一答${long}`),
      user(`第二问${long}`),
      assistant(`第二答${long}`),
      user(`第三问${long}`),
      assistant(`第三答${long}`),
    ]
    const result = compactMessages(messages, { maxTokens: 1 })
    const roles = result.droppedMessages.map((m) => m.role)
    expect(roles).toContain('tool')
    expect(roles).toContain('assistant')
  })
})

describe('摘要消息的构造', () => {
  it('summaryMessages 是 user 摘要 + assistant 确认这一对', () => {
    const messages = summaryMessages({ content: '之前聊了 A 和 B', generatedAt: 1, coveredMessages: 4 })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(String(messages[0]?.content)).toContain('之前聊了 A 和 B')
    expect(messages[1]?.role).toBe('assistant')
  })

  it('buildSummaryRequest 把消息摊平成文本，且带上摘要指令', () => {
    const request = buildSummaryRequest([user('我叫小明'), assistant('你好小明')])
    expect(request).toHaveLength(1)
    const content = String(request[0]?.content)
    expect(content).toContain('我叫小明')
    expect(content).toContain('你好小明')
    expect(content).toContain('摘要') // 指令正文
  })

  it('buildSummaryRequest 不含 system 消息（摘要不该把提示词喂回去）', () => {
    const request = buildSummaryRequest([{ role: 'system', content: '你是助手' }, user('hi')])
    const content = String(request[0]?.content)
    expect(content).not.toContain('你是助手')
  })

  it('多模态内容的图片只留占位，不会把 base64 塞进摘要请求', () => {
    const request = buildSummaryRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', data: 'AAAA'.repeat(100) },
        ],
      },
    ])
    const content = String(request[0]?.content)
    expect(content).toContain('看图')
    expect(content).toContain('[图片]')
    expect(content).not.toContain('AAAAAAAA')
  })
})

/**
 * P1 回归：`fixMessages` 把后面第一个 user 提到最前，**打乱历史顺序**。
 *
 * 触发条件很常见：`history_limit` 把历史从中间截断，剩下的第一条是 assistant。
 * 老实现的输出是 `user:问题2 / assistant:回答1 / assistant:回答2`——
 * 「回答1」出现在「问题2」之后，模型看到的是答非所问的对话，实测就会跟着答错。
 *
 * 正确做法：保留「第一条非 system 是 user」这个 provider 硬要求，
 * 但只把**开头那几个 assistant**（开场白/截断残留）挪到第一个 user 之后，
 * 而不是把 user 提到最前。
 */
describe('fixMessages 保持历史时间顺序', () => {
  it('开头是 assistant 时，不能把后面的 user 提前', () => {
    const input: ModelMessage[] = [
      assistant('回答1'),
      user('问题2'),
      assistant('回答2'),
    ]
    const fixed = fixMessages(input)
    // 第一问已经随截断丢失的「回答1」必须被丢掉，而不是留在数组里制造错位
    expect(fixed.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(fixed[0]).toEqual(user('问题2'))
    expect(fixed[1]).toEqual(assistant('回答2'))
  })

  it('历史被截成 [assistant, user, assistant] 时，问答仍然相邻且顺序正确', () => {
    const input: ModelMessage[] = [
      assistant('答：北京晴'),
      user('上海呢'),
      assistant('答：上海雨'),
    ]
    const fixed = fixMessages(input)
    // 关键：不能出现「上海呢 → 北京晴」这种错位
    const userIndex = fixed.findIndex((m) => m.role === 'user')
    expect(userIndex).toBe(0)
    expect(fixed[userIndex + 1]).toEqual(assistant('答：上海雨'))
    expect(fixed.at(-1)).toEqual(assistant('答：上海雨'))
  })

  it('system 段仍在最前，且 system 后的第一条是 user', () => {
    const input: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      assistant('开场白'),
      user('你好'),
      assistant('喵'),
    ]
    const fixed = fixMessages(input)
    expect(fixed[0]).toEqual({ role: 'system', content: 'sys' })
    expect(fixed[1]?.role).toBe('user')
    expect(fixed[1]).toEqual(user('你好'))
  })

  it('开头多条 assistant 全部丢掉，直到遇到 user', () => {
    const input: ModelMessage[] = [
      assistant('开场1'),
      assistant('开场2'),
      user('问题'),
      assistant('回答'),
    ]
    const fixed = fixMessages(input)
    expect(fixed).toEqual([user('问题'), assistant('回答')])
  })

  it('开头是 user 时顺序完全不变（不做任何搬运）', () => {
    const input: ModelMessage[] = [user('问'), assistant('答'), user('问2'), assistant('答2')]
    expect(fixMessages(input)).toEqual(input)
  })

  it('完全没有 user 时原样输出，不凭空造一条', () => {
    const input: ModelMessage[] = [assistant('只有开场白')]
    expect(fixMessages(input)).toEqual(input)
  })

  it('本轮消息不会被打乱：历史后接一条本轮 user，它必须留在最后', () => {
    const input: ModelMessage[] = [
      assistant('历史里的回答'),
      user('历史里的问题'),
      assistant('历史里的回答2'),
      user('本轮问题'),
    ]
    const fixed = fixMessages(input)
    expect(fixed.at(-1)).toEqual(user('本轮问题'))
    // 丢掉开头的孤儿 assistant 之后，历史内部顺序原样保留：
    // 问题 → 它自己的回答2 → 本轮问题（顺序不能像旧实现那样被打乱）
    expect(fixed).toEqual([
      user('历史里的问题'),
      assistant('历史里的回答2'),
      user('本轮问题'),
    ])
  })
})

/**
 * 单轮工具循环里的压缩。
 *
 * `rounds.length <= 1` 时老实现直接 `return none()`——一次 run 里模型可以连着调
 * 十几个工具，全都属于同一轮，于是**一条轮都丢不了、压缩彻底失效**。
 * 实测：1 条 user + 6 个巨大 tool 结果 ≈ 72,063 token，maxTokens=1000，
 * droppedRounds 仍然是 0，下一次模型调用直接超上下文。
 *
 * 修法：单轮时**截断超大工具结果**，不删消息、不动 toolCalls——
 * 删 tool 消息会拆散 tool_call/tool_result 配对，上游直接 400。
 */
describe('单轮工具循环的压缩（截断超大工具结果）', () => {
  /** 造一轮：1 条 user + n 组 (assistant.toolCalls + tool 结果) */
  function singleRoundWithBigResults(count: number, size: number): ModelMessage[] {
    const messages: ModelMessage[] = [user('帮我查一下这些接口')]
    for (let i = 0; i < count; i += 1) {
      messages.push(assistantWithCalls([`c${i}`]))
      messages.push(toolResult(`c${i}`, 'x'.repeat(size)))
    }
    return messages
  }

  it('单轮 + 6 个巨大工具结果：压缩后 token 显著下降', () => {
    const messages = singleRoundWithBigResults(6, 120_000)
    const before = estimateMessagesTokens(messages)
    // 前提：确实远超阈值
    expect(before).toBeGreaterThan(50_000)

    const result = compactMessages(messages, { maxTokens: 1_000 })

    expect(result.droppedRounds).toBe(0) // 一轮都不能丢
    expect(result.truncatedToolResults).toBe(6) // 六条都截了
    expect(result.tokensAfter).toBeLessThan(before / 10)
  })

  it('截断后 tool_call / tool_result 仍然成对（不能拆散）', () => {
    const messages = singleRoundWithBigResults(4, 50_000)
    const result = compactMessages(messages, { maxTokens: 500 })

    // 每条 tool 消息前面必须是一条带 toolCalls 的 assistant，且 id 对得上
    for (let i = 0; i < result.messages.length; i += 1) {
      const message = result.messages[i]
      if (message?.role !== 'tool') continue
      const prev = result.messages[i - 1]
      expect(prev?.role).toBe('assistant')
      expect(prev && 'toolCalls' in prev ? prev.toolCalls?.[0]?.id : undefined).toBe(
        message.toolCallId,
      )
    }
    // 条数不变：截断内容，不删消息
    expect(result.messages).toHaveLength(messages.length)
    // 本轮用户消息还在
    expect(result.messages[0]).toEqual(user('帮我查一下这些接口'))
  })

  it('截断后的工具结果带「已省略」提示，模型知道内容不完整', () => {
    const messages = singleRoundWithBigResults(1, 100_000)
    const result = compactMessages(messages, { maxTokens: 100 })
    const toolMessage = result.messages.find((m) => m.role === 'tool')
    expect(toolMessage).toBeDefined()
    const content = toolMessage && 'content' in toolMessage ? toolMessage.content : ''
    expect(content).toContain('已省略')
    // 头尾都要保留：正文开头和结尾的字段往往是关键信息
    expect(content.length).toBeGreaterThan(1_000)
  })

  it('小工具结果不动（没超限就别截）', () => {
    const messages = singleRoundWithBigResults(2, 100)
    const result = compactMessages(messages, { maxTokens: 1 })
    // 一条轮也丢不了、tool 结果也没超限 → 什么都不做
    expect(result.droppedRounds).toBe(0)
    expect(result.truncatedToolResults).toBe(0)
    expect(result.messages).toBe(messages) // 原样返回，不做无谓拷贝
  })

  it('未超阈值时完全不碰消息', () => {
    const messages = singleRoundWithBigResults(3, 100_000)
    const result = compactMessages(messages, { maxTokens: 10_000_000 })
    expect(result.truncatedToolResults).toBe(0)
    expect(result.messages).toBe(messages)
  })

  it('多轮场景下，丢轮之后仍然截断剩下的超大结果', () => {
    const long = '历史'.repeat(2000)
    const messages: ModelMessage[] = [
      user(`第一问${long}`),
      assistant(`第一答${long}`),
      user('第二问'),
      assistantWithCalls(['c1']),
      toolResult('c1', 'y'.repeat(200_000)),
    ]
    const result = compactMessages(messages, { maxTokens: 100 })
    expect(result.droppedRounds).toBeGreaterThan(0)
    // 丢轮之后最后一轮自己就超大，所以还要截断
    expect(result.truncatedToolResults).toBeGreaterThan(0)
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore / 10)
    // 配对仍合法
    for (let i = 0; i < result.messages.length; i += 1) {
      if (result.messages[i]?.role === 'tool') {
        expect(result.messages[i - 1]?.role).toBe('assistant')
      }
    }
  })

  it('截断是纯函数：不改入参的消息对象', () => {
    const messages = singleRoundWithBigResults(2, 100_000)
    const originalContent = String(
      (messages[2] as { content: string }).content,
    )
    compactMessages(messages, { maxTokens: 100 })
    expect((messages[2] as { content: string }).content).toBe(originalContent)
  })

  it('极端情况：截断后仍超阈值也不会丢轮或破坏配对', () => {
    // 500 组工具调用，即使每条截到 2000 token 也还是超阈值
    const messages = singleRoundWithBigResults(50, 20_000)
    const result = compactMessages(messages, { maxTokens: 1_000 })
    expect(result.droppedRounds).toBe(0)
    expect(result.messages).toHaveLength(messages.length)
    for (let i = 0; i < result.messages.length; i += 1) {
      if (result.messages[i]?.role === 'tool') {
        expect(result.messages[i - 1]?.role).toBe('assistant')
      }
    }
  })
})
