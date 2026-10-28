import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginContext } from '@qqbot/sdk'
import { executeRun } from './run.js'
import type { AgentStub, ReplyFn } from './run.js'
import { defaultConfig } from '../config/index.js'
import type { AgentConfig } from '../config/index.js'
import type { LLMService } from '../llm/contract.js'
import type { InboundMessage } from '../types.js'

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function message(): InboundMessage {
  return {
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
}

/** 按脚本依次返回成功或抛错的假 llm */
function scriptedLLM(steps: Array<{ text?: string; error?: { code: string } }>): LLMService & { calls: number } {
  let index = 0
  const llm = {
    calls: 0,
    contractVersion: 1 as const,
    listModels: async () => [],
    resolve: async () => ({
      alias: 'chat',
      provider: 'fake',
      provider_name: 'fake',
      model: 'fake',
      capabilities: ['text' as const],
    }),
    ping: async () => ({ ok: true, latency_ms: 1 }),
    stream: async function* () {},
    chat: async () => {
      llm.calls += 1
      const step = steps[index++] ?? { text: '默认' }
      if (step.error) {
        const err = new Error(step.error.code) as Error & { code: string }
        err.code = step.error.code
        throw err
      }
      return {
        text: step.text ?? '',
        alias: 'chat',
        provider: 'fake',
        model: 'fake',
        latency_ms: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  }
  return llm
}

function context(): PluginContext<AgentConfig> {
  return {
    plugin: { name: 'agent', version: '0.1.0' },
    botId: 'b1',
    config: defaultConfig,
    logger,
    kv: {} as never,
    db: { run: async () => ({ changes: 0 }) } as never,
    r2: undefined,
    api: {} as never,
    durable: {} as never,
    service: () => null as never,
    waitUntil: () => {},
  } as unknown as PluginContext<AgentConfig>
}

function stub(): AgentStub {
  return {
    history: async () => [],
    release: vi.fn(async () => ({ acquired: false })),
    retryLater: vi.fn(async () => ({ acquired: false })),
  } as unknown as AgentStub
}

function replySpy(): ReplyFn & { calls: string[] } {
  const calls: string[] = []
  const fn = (async (text: string) => {
    calls.push(text)
    return true
  }) as ReplyFn & { calls: string[] }
  fn.calls = calls
  return fn
}

function deps(llm: LLMService, reply: ReplyFn, agent = stub()) {
  return { ctx: context(), logger, config: defaultConfig, llm, agent, reply, retryDelayMs: 0 }
}

describe('可重试错误的重试', () => {
  it('限流时重试一次，第二次成功则用户无感', async () => {
    const llm = scriptedLLM([{ error: { code: 'rate_limit' } }, { text: '重试后成功' }])
    const reply = replySpy()

    const outcome = await executeRun(deps(llm, reply), 'run-1', message())

    expect(outcome.ok).toBe(true)
    expect(llm.calls).toBe(2)
    expect(reply.calls).toEqual(['重试后成功'])
  })

  it('超时也重试', async () => {
    const llm = scriptedLLM([{ error: { code: 'timeout' } }, { text: '好了' }])
    const outcome = await executeRun(deps(llm, replySpy()), 'run-1', message())

    expect(outcome.ok).toBe(true)
    expect(llm.calls).toBe(2)
  })

  it('重试只做一次，不无限重试', async () => {
    const llm = scriptedLLM([
      { error: { code: 'rate_limit' } },
      { error: { code: 'rate_limit' } },
      { error: { code: 'rate_limit' } },
    ])
    const outcome = await executeRun(deps(llm, replySpy()), 'run-1', message())

    expect(outcome.ok).toBe(false)
    // 第一次 + 一次重试 = 2 次调用
    expect(llm.calls).toBe(2)
  })

  it('重试后仍失败时告知用户，不静默消失', async () => {
    const llm = scriptedLLM([{ error: { code: 'rate_limit' } }, { error: { code: 'rate_limit' } }])
    const reply = replySpy()

    await executeRun(deps(llm, reply), 'run-1', message())

    expect(reply.calls).toHaveLength(1)
    expect(reply.calls[0]).toContain('限流')
  })

  it('不可重试错误不重试，直接告知用户', async () => {
    const llm = scriptedLLM([{ error: { code: 'auth' } }])
    const reply = replySpy()

    const outcome = await executeRun(deps(llm, reply), 'run-1', message())

    expect(outcome.ok).toBe(false)
    expect(outcome.retryable).toBe(false)
    expect(llm.calls).toBe(1)
    expect(reply.calls[0]).toContain('LLM 接口')
  })

  it('重试成功后不把失败写进历史', async () => {
    const llm = scriptedLLM([{ error: { code: 'rate_limit' } }, { text: '成功' }])
    type ReleaseArg = { ok: boolean; error?: string; history?: Array<{ role: string; content: string }> }
    const release = vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(
      async () => ({ acquired: false }),
    )

    await executeRun(
      deps(llm, replySpy(), {
        history: async () => [],
        release,
        retryLater: vi.fn(async () => ({ acquired: false })),
      } as unknown as AgentStub),
      'run-1',
      message(),
    )

    const arg = release.mock.calls[0]?.[1]
    expect(arg?.ok).toBe(true)
    expect(arg?.history?.map((h) => h.content)).toEqual(['你好', '成功'])
  })
})
