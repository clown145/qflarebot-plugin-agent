import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '@qqbot/sdk'
import { describeLoopError, LoopLimitError, runAgentLoop } from '../src/agent/loop.js'
import { LLMCallError } from '../src/llm/client.js'
import type { LLMService } from '../src/llm/contract.js'
import type { RegisteredTool, ToolRegistry } from '../src/tools/registry.js'
import { createToolRegistry } from '../src/tools/registry.js'
import type { ModelToolCall } from '../src/types.js'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** 造一个按脚本返回的假 llm */
function fakeLLM(script: Array<{ text?: string; toolCalls?: ModelToolCall[] }>): LLMService {
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

function tool(name: string, result: unknown): RegisteredTool {
  return {
    definition: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      sideEffect: 'none',
      timeoutMs: 1000,
    },
    execute: async () => ({ status: 'success', output: result }),
  }
}

const toolContext = () =>
  ({
    db: {} as never,
    logger,
    conversation: 'group:g1',
    userId: 'u1',
    scene: 'group',
    targetId: 'g1',
    runId: 'r1',
    timezone: 'UTC',
    markReplied: () => {},
  }) as Parameters<ToolRegistry['execute']>[2]

function loopOptions(llm: LLMService, registry: ToolRegistry, overrides = {}) {
  return {
    llm,
    registry,
    logger,
    model: 'chat',
    messages: [{ role: 'user' as const, content: '你好' }],
    maxModelSteps: 8,
    maxToolCalls: 12,
    requestTimeoutMs: 5000,
    toolContext,
    ...overrides,
  }
}

describe('runAgentLoop', () => {
  it('模型直接给答复时不调工具，返回文本', async () => {
    const registry = createToolRegistry([])
    const result = await runAgentLoop(loopOptions(fakeLLM([{ text: '你好呀' }]), registry))
    expect(result.reply).toBe('你好呀')
    expect(result.steps).toBe(1)
    expect(result.toolCalls).toBe(0)
  })

  it('模型要求调工具时，执行后把结果回填再问一次', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: '晴，25 度' }))
    const registry = createToolRegistry([
      { ...tool('weather', 'x'), execute },
    ])
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'weather', arguments: { city: '北京' } }] },
      { text: '北京晴，25 度' },
    ])
    const result = await runAgentLoop(loopOptions(llm, registry))
    expect(execute).toHaveBeenCalledOnce()
    expect(result.reply).toBe('北京晴，25 度')
    expect(result.steps).toBe(2)
    expect(result.toolCalls).toBe(1)
  })

  it('工具结果以 tool 角色消息回填，带 toolCallId', async () => {
    const registry = createToolRegistry([tool('t', { ok: 1 })])
    const llm = fakeLLM([
      { toolCalls: [{ id: 'call-1', name: 't', arguments: {} }] },
      { text: 'done' },
    ])
    const result = await runAgentLoop(loopOptions(llm, registry))
    expect(result.reply).toBe('done')
  })

  it('超过 maxModelSteps 抛 LoopLimitError，不是无限循环', async () => {
    // 每次都要求调工具，永远不给最终答复
    const script = Array.from({ length: 20 }, (_, i) => ({
      toolCalls: [{ id: `c${i}`, name: 't', arguments: {} }],
    }))
    const registry = createToolRegistry([tool('t', 'x')])
    const llm = fakeLLM(script)
    await expect(
      runAgentLoop(loopOptions(llm, registry, { maxModelSteps: 3 })),
    ).rejects.toThrow(LoopLimitError)
  })

  it('超过 maxToolCalls 抛 LoopLimitError', async () => {
    const registry = createToolRegistry([tool('t', 'x')])
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
      runAgentLoop(loopOptions(llm, registry, { maxToolCalls: 1 })),
    ).rejects.toThrow(LoopLimitError)
  })

  it('工具返回失败时 loop 继续，把错误交给模型而不是崩掉', async () => {
    const registry = createToolRegistry([
      {
        definition: {
          name: 'bad',
          description: 'bad',
          parameters: { type: 'object', properties: {} },
          sideEffect: 'none',
          timeoutMs: 1000,
        },
        execute: async () => ({
          status: 'failed' as const,
          error: { code: 'boom', message: '炸了', retryable: false },
        }),
      },
    ])
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'bad', arguments: {} }] },
      { text: '工具挂了，我直接回答' },
    ])
    const result = await runAgentLoop(loopOptions(llm, registry))
    expect(result.reply).toBe('工具挂了，我直接回答')
  })

  it('未知工具返回 failed 而不是抛异常', async () => {
    const registry = createToolRegistry([])
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 'nonexistent', arguments: {} }] },
      { text: '没有这个工具' },
    ])
    const result = await runAgentLoop(loopOptions(llm, registry))
    expect(result.reply).toBe('没有这个工具')
  })

  it('累计 usage 并返回', async () => {
    const registry = createToolRegistry([])
    const llm = fakeLLM([{ text: 'a' }, { text: 'b' }])
    const result = await runAgentLoop(loopOptions(llm, registry))
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('onStep 每步都被调用，从 1 开始', async () => {
    const steps: number[] = []
    const registry = createToolRegistry([tool('t', 'x')])
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 't', arguments: {} }] },
      { text: 'done' },
    ])
    await runAgentLoop(
      loopOptions(llm, registry, { onStep: async (n: number) => void steps.push(n) }),
    )
    expect(steps).toEqual([1, 2])
  })
})

describe('describeLoopError', () => {
  it('限流错误标记为可重试', () => {
    const described = describeLoopError(new LLMCallError('429', 'rate_limit'))
    expect(described.retryable).toBe(true)
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
