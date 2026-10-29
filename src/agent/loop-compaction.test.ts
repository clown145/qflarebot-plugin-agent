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
