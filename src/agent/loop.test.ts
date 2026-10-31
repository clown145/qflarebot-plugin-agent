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

/**
 * 回归：重试重跑整个 loop 导致工具副作用重复（P0）。
 *
 * 旧实现把重试放在 `run.ts` 的 `runWithRetry` 里、重跑整个 `runLoopOnce`。
 * 实测：第 1 步 `schedule.create` 成功（INSERT 已落库）、第 2 步 429 →
 * 整个 loop 从头再来 → INSERT 执行 2 次。
 *
 * 正确的层是**单次模型调用**：这里断言「工具只执行一次、模型最多调 2 次」。
 */
describe('单次模型调用的重试（不重跑 loop）', () => {
  it('第 2 步 429 时只重试那次调用：工具只执行一次，模型调 2 次', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: '已建任务' }))
    const tools = [{ ...tool('schedule.create', 'x'), execute }]

    let call = 0
    const llm = {
      ...fakeLLM(),
      chat: async () => {
        call += 1
        if (call === 1) {
          return {
            text: '',
            tool_calls: [
              { id: 'c1', name: 'schedule.create', arguments: JSON.stringify({ prompt: '喝水' }) },
            ],
            alias: 'chat',
            provider: 'fake',
            model: 'fake',
            latency_ms: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }
        if (call === 2) {
          const error = new Error('429 rate limited') as Error & { code: string }
          error.code = 'rate_limit'
          throw error
        }
        return {
          text: '任务建好了',
          alias: 'chat',
          provider: 'fake',
          model: 'fake',
          latency_ms: 1,
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    } as unknown as LLMService

    const result = await runAgentLoop(
      loopOptions(llm, tools, { retry: { times: 1, delayMs: 0 } }),
    )

    expect(result.reply).toBe('任务建好了')
    // 关键断言：有副作用的工具只跑了一次
    expect(execute).toHaveBeenCalledOnce()
    // 模型调 3 次是「1 次成功 + 1 次失败 + 1 次重试成功」，不是 loop 重来
    expect(call).toBe(3)
    // loop 的步数仍然是 2（第 1 步工具、第 2 步回答），没有从头再来
    expect(result.steps).toBe(2)
  })

  it('不传 retry 时不重试（默认行为不变）', async () => {
    let calls = 0
    const llm = {
      ...fakeLLM(),
      chat: async () => {
        calls += 1
        const error = new Error('429') as Error & { code: string }
        error.code = 'rate_limit'
        throw error
      },
    } as unknown as LLMService

    await expect(runAgentLoop(loopOptions(llm, []))).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('不可重试错误（auth）即使配了 retry 也不重试', async () => {
    let calls = 0
    const llm = {
      ...fakeLLM(),
      chat: async () => {
        calls += 1
        const error = new Error('401') as Error & { code: string }
        error.code = 'auth'
        throw error
      },
    } as unknown as LLMService

    await expect(
      runAgentLoop(loopOptions(llm, [], { retry: { times: 1, delayMs: 0 } })),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('重试只做一次，不会无限重试', async () => {
    let calls = 0
    const llm = {
      ...fakeLLM(),
      chat: async () => {
        calls += 1
        const error = new Error('429') as Error & { code: string }
        error.code = 'rate_limit'
        throw error
      },
    } as unknown as LLMService

    await expect(
      runAgentLoop(loopOptions(llm, [], { retry: { times: 1, delayMs: 0 } })),
    ).rejects.toThrow()
    expect(calls).toBe(2)
  })
})

/**
 * 回归：`/stop` 形同虚设（P0）。
 *
 * `stop()` 只改 DO 里的 status，执行流完全不知道，照旧把完整回答发出去。
 * 现在 loop 每步开头问一次 `isCancelled()`，signal 则负责打断正在飞的调用。
 */
describe('取消（/stop）', () => {
  it('取消后不再继续下一步：模型只调一次，抛 LoopCancelledError', async () => {
    const { LoopCancelledError } = await import('./loop.js')
    let cancelled = false
    const llm = fakeLLM([
      { toolCalls: [{ id: 'c1', name: 't', arguments: {} }] },
      { text: '不该走到这里' },
    ])
    let calls = 0
    const counting = {
      ...llm,
      chat: async (...args: Parameters<LLMService['chat']>) => {
        calls += 1
        // 第一次模型调用之后（执行完工具）用户按了 /stop
        if (calls === 1) cancelled = true
        return llm.chat(...args)
      },
    } as LLMService

    await expect(
      runAgentLoop(
        loopOptions(
          counting,
          [tool('t', 'x')],
          { isCancelled: async () => cancelled },
        ),
      ),
    ).rejects.toBeInstanceOf(LoopCancelledError)
    // 取消发生在第 2 步开头：模型只被调了 1 次
    expect(calls).toBe(1)
  })

  it('signal 已 abort 时一步都不跑', async () => {
    const { LoopCancelledError } = await import('./loop.js')
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const llm = {
      ...fakeLLM(),
      chat: async () => {
        calls += 1
        return { text: 'x', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
      },
    } as unknown as LLMService

    await expect(
      runAgentLoop(loopOptions(llm, [], { signal: controller.signal })),
    ).rejects.toBeInstanceOf(LoopCancelledError)
    expect(calls).toBe(0)
  })

  it('signal 透传给 llm.chat（llm 契约里早就有 ChatRequest.signal，只是从来没人设置）', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const llm = {
      ...fakeLLM(),
      chat: async (req: { signal?: AbortSignal }) => {
        seen = req.signal
        return { text: '好', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
      },
    } as unknown as LLMService

    await runAgentLoop(loopOptions(llm, [], { signal: controller.signal }))
    expect(seen).toBe(controller.signal)
  })

  it('取消检查失败（DO 抖动）按未取消处理，不误杀对话', async () => {
    const result = await runAgentLoop(
      loopOptions(fakeLLM([{ text: '正常回答' }]), [], {
        isCancelled: async () => {
          throw new Error('DO 抖动')
        },
      }),
    )
    expect(result.reply).toBe('正常回答')
  })

  it('onStep 每步都在，续租靠它（step 1,2 都被回调）', async () => {
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
})
