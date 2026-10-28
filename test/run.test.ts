import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginDB, PluginContext } from '@qqbot/sdk'
import { executeRun } from '../src/agent/run.js'
import type { AgentStub, ReplyFn } from '../src/agent/run.js'
import type { AgentConfig } from '../src/config/index.js'
import type { LLMService } from '../src/llm/contract.js'
import type { InboundMessage } from '../src/types.js'
import { defaultConfig } from '../src/config/index.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

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

function fakeLLM(reply = '你好呀'): LLMService {
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
    chat: async () => ({
      text: reply,
      alias: 'chat',
      provider: 'fake',
      model: 'fake',
      latency_ms: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  }
}

function fakeStub(overrides: Partial<AgentStub> = {}): AgentStub {
  return {
    history: async () => [],
    release: vi.fn(async () => {}),
    retryLater: vi.fn(async () => {}),
    ...overrides,
  } as AgentStub
}

function context(config: Partial<AgentConfig> = {}): PluginContext<AgentConfig> {
  return {
    plugin: { name: 'agent', version: '0.1.0' },
    botId: 'b1',
    config: { ...defaultConfig, ...config },
    logger,
    kv: {} as never,
    db: { run: async () => ({ changes: 0 }) } as unknown as PluginDB,
    r2: {} as never,
    api: {} as never,
    durable: {} as never,
    service: <T>() => fakeLLM() as unknown as T,
    waitUntil: () => {},
  } as unknown as PluginContext<AgentConfig>
}

/** 带类型的 release 替身：能直接读 mock.calls 的第二个参数 */
type ReleaseArg = { ok: boolean; error?: string; history?: Array<{ role: string; content: string; toolCallsJson: string | null; createdAt: number }> }
function releaseSpy() {
  return vi.fn<(runId: string, result: ReleaseArg) => Promise<void>>(async () => {})
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

describe('executeRun', () => {
  it('正常一轮：回复、写历史、release 成功', async () => {
    const reply = replySpy()
    const release = releaseSpy()
    const result = await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        llm: fakeLLM('你好呀'),
        agent: fakeStub({ release }),
        reply,
      },
      'run-1',
      message(),
    )

    expect(result.ok).toBe(true)
    expect(reply.calls).toEqual(['你好呀'])
    expect(release).toHaveBeenCalledOnce()

    const releaseArg = release.mock.calls[0]?.[1]
    expect(releaseArg?.ok).toBe(true)
    // user + assistant 两行
    expect(releaseArg?.history).toHaveLength(2)
  })

  it('历史里 user 行记的是 displayText（保留其他人的 @）', async () => {
    const release = releaseSpy()
    await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        llm: fakeLLM('收到'),
        agent: fakeStub({ release }),
        reply: replySpy(),
      },
      'run-1',
      message({ text: '@小明 你好', displayText: '@小明 你好' }),
    )

    const history = release.mock.calls[0]?.[1].history ?? []
    expect(history[0]).toEqual({
      role: 'user',
      content: '@小明 你好',
      toolCallsJson: null,
      createdAt: expect.any(Number),
    })
  })

  it('模型没给文本时不写空的 assistant 行（否则占掉 history_limit 名额）', async () => {
    const release = releaseSpy()
    await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        llm: fakeLLM(''),
        agent: fakeStub({ release }),
        reply: replySpy(),
      },
      'run-1',
      message(),
    )

    const history = release.mock.calls[0]?.[1].history ?? []
    expect(history).toHaveLength(1)
    expect(history[0]?.role).toBe('user')
  })

  it('上游限流时退回队列，不标记失败、不回复错误文案', async () => {
    const reply = replySpy()
    const retryLater = vi.fn<(runId: string, reason: string) => Promise<void>>(async () => {})
    const release = releaseSpy()

    const llm = {
      ...fakeLLM(),
      chat: async () => {
        const err = new Error('429 Too Many Requests')
        ;(err as unknown as { code: string }).code = 'rate_limit'
        throw err
      },
    } as LLMService

    const result = await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        llm,
        agent: fakeStub({ retryLater, release }),
        reply,
      },
      'run-1',
      message(),
    )

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(retryLater).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    // 可重试错误不该给用户看错误文案——cron 会再试一次
    expect(reply.calls).toHaveLength(0)
  })

  it('不可重试错误（如认证失败）回复用户并标记失败', async () => {
    const reply = replySpy()
    const release = releaseSpy()
    const retryLater = vi.fn<(runId: string, reason: string) => Promise<void>>(async () => {})

    const llm = {
      ...fakeLLM(),
      chat: async () => {
        const err = new Error('401 Unauthorized')
        ;(err as unknown as { code: string }).code = 'auth'
        throw err
      },
    } as LLMService

    const result = await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        llm,
        agent: fakeStub({ retryLater, release }),
        reply,
      },
      'run-1',
      message(),
    )

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(retryLater).not.toHaveBeenCalled()
    expect(reply.calls[0]).toContain('LLM 接口')
  })

  it('模型别名不存在时给出可操作的提示', async () => {
    const reply = replySpy()
    const llm = {
      ...fakeLLM(),
      chat: async () => {
        const err = new Error('unknown model')
        ;(err as unknown as { code: string }).code = 'unknown_model'
        throw err
      },
    } as LLMService

    await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        llm,
        agent: fakeStub(),
        reply,
      },
      'run-1',
      message(),
    )

    expect(reply.calls[0]).toContain('模型别名')
  })

  it('enable_tools 关掉时不给模型任何工具', async () => {
    let seenTools: unknown
    const llm = {
      ...fakeLLM(),
      chat: async (req: { tools?: unknown }) => {
        seenTools = req.tools
        return {
          text: '纯聊天',
          alias: 'chat',
          provider: 'fake',
          model: 'fake',
          latency_ms: 1,
        }
      },
    } as LLMService

    await executeRun(
      {
        ctx: context({ enable_tools: false }),
        logger,
        config: { ...defaultConfig, enable_tools: false },
        llm,
        agent: fakeStub(),
        reply: replySpy(),
      },
      'run-1',
      message(),
    )

    expect(seenTools).toBeUndefined()
  })
})
