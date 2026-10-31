/**
 * 集成测试：压缩真的能把长会话压住。
 *
 * 这一层测的是「接线」而不是「算法」——`context-size.test.ts` 已经把
 * `compactMessages` 的算法细节覆盖了。这里只回答一个问题：
 * **loop 每次调模型之前，真的会压吗？压完之后还会不会继续涨？**
 *
 * 为什么要单独测：`compaction` 参数从 config 一路传到 `runAgentLoop`，
 * 中间任何一环漏传（比如 `run.ts` 里忘了传）都不会报错，
 * 只会「看起来一切正常但压缩从来没生效」——正是审计发现过的失效模式。
 */
import { describe, expect, it, vi } from 'vitest'
import { runAgentLoop } from './loop.js'
import { createToolRegistry } from '../tools/registry.js'
import type { LLMService } from '../llm/contract.js'
import type { Logger } from '@qqbot/sdk'
import type { InboundMessage, ModelMessage } from '../types.js'
import type { ToolExecuteInput } from '../tools/registry.js'

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const toolContext: Omit<ToolExecuteInput, 'input' | 'toolCallId'> = {
  db: {} as ToolExecuteInput['db'],
  logger,
  conversationId: 'group:g1',
  actorId: 'u1',
  actorRole: 'member',
  scene: 'group',
  targetId: 'g1',
  runId: 'run-1',
  stepId: 'step-1',
  timezone: 'Asia/Shanghai',
}

/** 造一个会返回固定内容的假 LLM，并记录每次调用收到的 messages 长度 */
function fakeLLM(
  reply: string,
  calls: ModelMessage[][],
): LLMService {
  return {
    contractVersion: 1,
    listModels: async () => [],
    resolve: async () => ({
      alias: 'chat',
      provider: 'mock',
      model: 'mock',
      capabilities: ['text'],
      provider_name: 'mock',
    }),
    ping: async () => ({ ok: true, latency_ms: 0 }),
    stream: async function* () {
      /* 本测试不用流式 */
    },
    chat: async (request) => {
      // 契约层收到的是 LLMChatMessage[]（role/tool_calls 用的是线格式）。
      // 这里只是把长度记下来做断言，形状转回内部 ModelMessage 只是为了让
      // 测试的类型检查通过，不参与任何逻辑。
      calls.push([...request.messages] as unknown as ModelMessage[])
      return {
        text: reply,
        alias: 'chat',
        provider: 'mock',
        model: 'mock',
        latency_ms: 1,
      }
    },
  } as LLMService
}

function historyOf(count: number, text: string): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (let i = 0; i < count; i += 1) {
    messages.push({ role: 'user', content: `${text}${i}` })
    messages.push({ role: 'assistant', content: `${text}答${i}` })
  }
  return messages
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

describe('loop 的压缩接线', () => {
  it('mode=off 时不压缩，发出的 messages 保持原样', async () => {
    const calls: ModelMessage[][] = []
    const history = historyOf(10, '内容内容内容')
    const messages: ModelMessage[] = [{ role: 'system', content: 'sys' }, ...history]

    const result = await runAgentLoop({
      llm: fakeLLM('好', calls),
      registry: createToolRegistry([]),
      logger,
      model: 'chat',
      messages,
      maxModelSteps: 3,
      maxToolCalls: 3,
      requestTimeoutMs: 1000,
      toolContext,
      compaction: { mode: 'off', maxTokens: 10 },
    })

    expect(result.compactedRounds).toBe(0)
    expect(calls[0]).toHaveLength(messages.length)
  })

  it('mode=truncate 且超阈值时，发给模型的 messages 变短', async () => {
    const calls: ModelMessage[][] = []
    const history = historyOf(10, '很长很长的历史内容'.repeat(20))
    const messages: ModelMessage[] = [{ role: 'system', content: 'sys' }, ...history]

    const result = await runAgentLoop({
      llm: fakeLLM('好', calls),
      registry: createToolRegistry([]),
      logger,
      model: 'chat',
      messages,
      maxModelSteps: 3,
      maxToolCalls: 3,
      requestTimeoutMs: 1000,
      toolContext,
      compaction: { mode: 'truncate', maxTokens: 200 },
    })

    expect(result.compactedRounds).toBeGreaterThan(0)
    // 真正发给模型的比原始短
    expect(calls[0]!.length).toBeLessThan(messages.length)
    // system 消息必须还在最前面（压缩不能把它丢掉）
    expect(calls[0]![0]).toEqual({ role: 'system', content: 'sys' })
  })

  it('压缩后仍保留最后一轮用户消息', async () => {
    const calls: ModelMessage[][] = []
    const history = historyOf(10, '内容'.repeat(200))
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      ...history,
      { role: 'user', content: '最后的问题' },
    ]

    await runAgentLoop({
      llm: fakeLLM('好', calls),
      registry: createToolRegistry([]),
      logger,
      model: 'chat',
      messages,
      maxModelSteps: 3,
      maxToolCalls: 3,
      requestTimeoutMs: 1000,
      toolContext,
      compaction: { mode: 'truncate', maxTokens: 100 },
    })

    const sent = calls[0]!
    const users = sent.filter((m) => m.role === 'user')
    expect(users.at(-1)).toEqual({ role: 'user', content: '最后的问题' })
  })

  it('未超阈值时不压缩（不白花力气）', async () => {
    const calls: ModelMessage[][] = []
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '短' },
      { role: 'assistant', content: '短答' },
    ]

    const result = await runAgentLoop({
      llm: fakeLLM('好', calls),
      registry: createToolRegistry([]),
      logger,
      model: 'chat',
      messages,
      maxModelSteps: 3,
      maxToolCalls: 3,
      requestTimeoutMs: 1000,
      toolContext,
      compaction: { mode: 'truncate', maxTokens: 100_000 },
    })

    expect(result.compactedRounds).toBe(0)
  })
})

/**
 * Lead 追加项 A：单轮内「截断超大工具结果」必须被写回 messages。
 *
 * `compactMessages` 在 `rounds.length <= 1` 时的返回值里 `droppedRounds` 是 0、
 * 只有 `truncatedToolResults > 0`。如果 loop 只判断 `droppedRounds > 0`，
 * 算出来的截断结果**写不回** messages —— 端到端等于没生效。
 */
describe('单轮内截断超大工具结果的接线', () => {
  /** 一轮里塞多个巨大 tool 结果（同一轮 = 1 条 user + N 个 tool 结果） */
  function singleRoundWithHugeToolResults(count: number, size: number): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: '帮我查几件事' })
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: Array.from({ length: count }, (_, i) => ({
        id: `c${i}`,
        name: 'big',
        arguments: {},
      })),
    })
    for (let i = 0; i < count; i += 1) {
      messages.push({
        role: 'tool',
        toolCallId: `c${i}`,
        toolName: 'big',
        content: '巨大结果'.repeat(size),
      })
    }
    return messages
  }

  it('只有一轮时 droppedRounds=0，但截断必须真的写回：发给模型的 tool 内容变短', async () => {
    const calls: ModelMessage[][] = []
    // 每条 tool 结果 ≈ 8000 字符 ≈ 4800 token，远超单条上限 2000 token
    const messages = singleRoundWithHugeToolResults(6, 2000)

    const result = await runAgentLoop({
      llm: fakeLLM('好', calls),
      registry: createToolRegistry([]),
      logger,
      model: 'chat',
      messages,
      // 单步即可：只要保证「第一次模型调用前压过一次」
      maxModelSteps: 1,
      maxToolCalls: 3,
      requestTimeoutMs: 1000,
      toolContext,
      compaction: { mode: 'truncate', maxTokens: 1000 },
    })

    // 丢弃轮数仍然是 0（单轮不能丢问题）
    expect(result.compactedRounds).toBe(0)

    const sent = calls[0]!
    const toolsBefore = messages.filter((m) => m.role === 'tool')
    const toolsAfter = sent.filter((m) => m.role === 'tool')
    // 消息条数不变（只截内容，不删消息，配对结构保持）
    expect(toolsAfter).toHaveLength(toolsBefore.length)

    const totalBefore = toolsBefore.reduce(
      (n, m) => n + ('content' in m ? String(m.content).length : 0),
      0,
    )
    const totalAfter = toolsAfter.reduce(
      (n, m) => n + ('content' in m ? String(m.content).length : 0),
      0,
    )
    // 关键断言：真的变短了（没变短说明截断结果没写回 messages）
    expect(totalAfter).toBeLessThan(totalBefore)
    // tool_call_id 配对必须完整保留（这里读到的是契约层的线格式：
    // 内部 ModelMessage 的 toolCallId 在 toChatMessages 里变成 tool_call_id）
    const idsAfter = toolsAfter.map((m) => String((m as { tool_call_id?: string }).tool_call_id))
    expect(idsAfter).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5'])
  })
})
