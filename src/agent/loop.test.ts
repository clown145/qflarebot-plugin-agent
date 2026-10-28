import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginDB } from '@qqbot/sdk'
import { describeLoopError, LoopLimitError, runAgentLoop } from './loop.js'
import { LLMCallError } from '../llm/client.js'
import type { LLMService } from '../llm/contract.js'
import { createToolRegistry } from '../tools/registry.js'
import type { ToolExecuteInput } from '../tools/registry.js'
import type { RegisteredTool, ToolDefinition } from '../tools/types.js'
import type { ModelToolCall } from '../types.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** 造一个按脚本返回的假 llm */
function fakeLLM(script: Array<{ text?: string; toolCalls?: ModelToolCall[] }> = []): LLMService {
  let index = 0
  return {
    contractVersion: 1,
    listModels: async () => [],
    resolve: async () => ({
      alias: 'chat',
      provider: 'fake',
      provider_name: 'fake',
      model: 'fake',
      capabilities: ['text'],
    }),
    ping: async () => ({ ok: true, latency_ms: 1 }),
    stream: async function* () {},
    chat: async () => {
      const step = script[index++] ?? { text: '默认回复' }
      return {
        text: step.text ?? '',
        ...(step.toolCalls?.length
          ? {
              tool_calls: step.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              })),
            }
          : {}),
        alias: 'chat',
        provider: 'fake',
        model: 'fake',
        latency_ms: 1,
        usage: { input_tokens: 10, output_tokens: 5 },
      }
    },
  }
}

function tool(name: string, output: unknown, overrides: Partial<ToolDefinition> = {}): RegisteredTool {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      permission: { level: 1, scopes: [] },
      sideEffect: 'none',
      timeoutMs: 1000,
      ...overrides,
    },
    source: { type: 'builtin', id: 'test', name: 'test' },
    execute: async () => ({ status: 'success', output }),
  }
}

const toolContext = (): Omit<ToolExecuteInput, 'input' | 'toolCallId'> => ({
  db: {} as PluginDB,
  logger,
  conversationId: 'group:g1',
  actorId: 'u1',
  actorRole: 'member',
  scene: 'group',
  targetId: 'g1',
  runId: 'r1',
  stepId: 's1',
  timezone: 'UTC',
})

function loopOptions(llm: LLMService, tools: RegisteredTool[], overrides = {}) {
  return {
    llm,
    registry: createToolRegistry(tools),
    logger,
    model: 'chat',
    messages: [{ role: 'user' as const, content: '你好' }],
    maxModelSteps: 8,
    maxToolCalls: 12,
    requestTimeoutMs: 5000,
    toolContext: toolContext(),
    ...overrides,
  }
}

describe('runAgentLoop', () => {
  it('模型直接给答复时不调工具，返回文本', async () => {
    const result = await runAgentLoop(loopOptions(fakeLLM([{ text: '你好呀' }]), []))
    expect(result.reply).toBe('你好呀')
    expect(result.steps).toBe(1)
    expect(result.toolCalls).toBe(0)
  })

  it('模型要求调工具时，执行后把结果回填再问一次', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: '晴，25 度' }))
    const weather = { ...tool('weather', 'x'), execute }
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'weather', arguments: { city: '北京' } }] },
      { text: '北京晴，25 度' },
    ])
    const result = await runAgentLoop(loopOptions(llm, [weather]))
    expect(execute).toHaveBeenCalledOnce()
    expect(result.reply).toBe('北京晴，25 度')
    expect(result.steps).toBe(2)
    expect(result.toolCalls).toBe(1)
  })

  it('超过 maxModelSteps 抛 LoopLimitError，不是无限循环', async () => {
    const script = Array.from({ length: 20 }, (_, i) => ({
      toolCalls: [{ id: `c${i}`, name: 't', arguments: {} }],
    }))
    await expect(
      runAgentLoop(loopOptions(fakeLLM(script), [tool('t', 'x')], { maxModelSteps: 3 })),
    ).rejects.toThrow(LoopLimitError)
  })

  it('超过 maxToolCalls 抛 LoopLimitError（预留制：超了就停，不执行）', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: 'x' }))
    const llm = fakeLLM([
      {
        toolCalls: [
          { id: 'c1', name: 't', arguments: {} },
          { id: 'c2', name: 't', arguments: {} },
        ],
      },
      { text: 'never' },
    ])
    await expect(
      runAgentLoop(loopOptions(llm, [{ ...tool('t', 'x'), execute }], { maxToolCalls: 1 })),
    ).rejects.toThrow(LoopLimitError)
    // 只执行了一次，第二次在预留阶段就被拦下
    expect(execute).toHaveBeenCalledOnce()
  })

  it('工具返回失败时 loop 继续，把错误交给模型而不是崩掉', async () => {
    const bad: RegisteredTool = {
      ...tool('bad', 'x'),
      execute: async () => ({
        status: 'failed',
        error: { code: 'boom', message: '炸了', retryable: false },
      }),
    }
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'bad', arguments: {} }] },
      { text: '工具挂了，我直接回答' },
    ])
    const result = await runAgentLoop(loopOptions(llm, [bad]))
    expect(result.reply).toBe('工具挂了，我直接回答')
  })

  it('模型调用不存在的工具时被白名单拦下，不抛异常', async () => {
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'nonexistent', arguments: {} }] },
      { text: '没有这个工具' },
    ])
    const result = await runAgentLoop(loopOptions(llm, []))
    expect(result.reply).toBe('没有这个工具')
  })

  it('工具声明 preventsFinalResponse 且成功时，repliedByTool 为真', async () => {
    const sender = tool('send', 'ok', { behavior: { preventsFinalResponse: true } })
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'send', arguments: {} }] },
      { text: '' },
    ])
    const result = await runAgentLoop(loopOptions(llm, [sender]))
    expect(result.repliedByTool).toBe(true)
  })

  it('工具失败时即使声明了 preventsFinalResponse 也不算已回复', async () => {
    const sender: RegisteredTool = {
      ...tool('send', 'x', { behavior: { preventsFinalResponse: true } }),
      execute: async () => ({ status: 'failed', error: { code: 'e', message: 'e', retryable: false } }),
    }
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'send', arguments: {} }] },
      { text: '那我直接说' },
    ])
    const result = await runAgentLoop(loopOptions(llm, [sender]))
    expect(result.repliedByTool).toBe(false)
  })

  it('累计 usage 并返回', async () => {
    const result = await runAgentLoop(loopOptions(fakeLLM([{ text: 'a' }]), []))
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('onStep 每步都被调用，从 1 开始', async () => {
    const steps: number[] = []
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 't', arguments: {} }] },
      { text: 'done' },
    ])
    await runAgentLoop(
      loopOptions(llm, [tool('t', 'x')], { onStep: async (n: number) => void steps.push(n) }),
    )
    expect(steps).toEqual([1, 2])
  })

  it('enable_tools 关闭时不传 tools 给模型', async () => {
    let seenTools: unknown
    const llm = {
      ...fakeLLM(),
      chat: async (req: { tools?: unknown }) => {
        seenTools = req.tools
        return { text: '纯聊天', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
      },
    } as LLMService
    await runAgentLoop(loopOptions(llm, []))
    expect(seenTools).toBeUndefined()
  })
})

describe('describeLoopError', () => {
  it('限流错误标记为可重试', () => {
    expect(describeLoopError(new LLMCallError('429', 'rate_limit')).retryable).toBe(true)
  })

  it('认证错误标记为不可重试，并提示去改配置', () => {
    const described = describeLoopError(new LLMCallError('401', 'auth'))
    expect(described.retryable).toBe(false)
    expect(described.text).toContain('LLM 接口')
  })

  it('步数超限给出可读文案且不可重试', () => {
    const described = describeLoopError(new LoopLimitError('步数用完了'))
    expect(described.retryable).toBe(false)
    expect(described.text).toBe('步数用完了')
  })

  it('未知错误不会漏出原始堆栈', () => {
    const described = describeLoopError(new Error('内部错误'))
    expect(described.text).toContain('内部错误')
    expect(described.retryable).toBe(false)
  })
})
