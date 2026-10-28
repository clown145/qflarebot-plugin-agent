import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginContext } from '@qqbot/sdk'
import { executeRun } from './run.js'
import type { AgentStub, ReplyFn } from './run.js'
import type { AgentConfig } from '../config/index.js'
import { defaultConfig } from '../config/index.js'
import type { LLMService } from '../llm/contract.js'
import type { InboundMessage } from '../types.js'

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
    memberRole: 'admin',
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

type ReleaseArg = {
  ok: boolean
  error?: string
  history?: Array<{ role: string; content: string; toolCallsJson: string | null; createdAt: number }>
}

function fakeStub(overrides: Partial<AgentStub> = {}): AgentStub {
  return {
    history: async () => [],
    release: vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false })),
    retryLater: vi.fn<(runId: string, reason: string) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false })),
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
    db: { run: async () => ({ changes: 0 }) } as never,
    r2: undefined,
    api: {} as never,
    durable: {} as never,
    service: <T>() => fakeLLM() as unknown as T,
    waitUntil: () => {},
  } as unknown as PluginContext<AgentConfig>
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
    const release = vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))
    const outcome = await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        retryDelayMs: 0,
        llm: fakeLLM('你好呀'),
        agent: fakeStub({ release }),
        reply,
      },
      'run-1',
      message(),
    )

    expect(outcome.ok).toBe(true)
    expect(reply.calls).toEqual(['你好呀'])
    expect(release).toHaveBeenCalledOnce()

    const releaseArg = release.mock.calls[0]?.[1]
    expect(releaseArg?.ok).toBe(true)
    expect(releaseArg?.history).toHaveLength(2)
  })

  it('历史里 user 行记的是 displayText（保留其他人的 @）', async () => {
    const release = vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))
    await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        retryDelayMs: 0,
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
    const release = vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))
    await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        retryDelayMs: 0,
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

  it('上游限流：重试一次后仍失败，告知用户并退回队列', async () => {
    const reply = replySpy()
    const retryLater = vi.fn<(runId: string, reason: string) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))
    const release = vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))

    const llm = {
      ...fakeLLM(),
      chat: async () => {
        const err = new Error('429 Too Many Requests')
        ;(err as unknown as { code: string }).code = 'rate_limit'
        throw err
      },
    } as LLMService

    const outcome = await executeRun(
      { ctx: context(), logger, config: defaultConfig, llm, agent: fakeStub({ retryLater, release }), reply, retryDelayMs: 0 },
      'run-1',
      message(),
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.retryable).toBe(true)
    expect(retryLater).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    // 上一版这里是静默的——用户什么都收不到，消息凭空消失。
    // 现在会告知「正在限流」，用户至少知道发生了什么
    expect(reply.calls).toHaveLength(1)
    expect(reply.calls[0]).toContain('限流')
  })

  it('不可重试错误（如认证失败）回复用户并标记失败', async () => {
    const reply = replySpy()
    const release = vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))
    const retryLater = vi.fn<(runId: string, reason: string) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))

    const llm = {
      ...fakeLLM(),
      chat: async () => {
        const err = new Error('401 Unauthorized')
        ;(err as unknown as { code: string }).code = 'auth'
        throw err
      },
    } as LLMService

    const outcome = await executeRun(
      { ctx: context(), logger, config: defaultConfig, llm, agent: fakeStub({ retryLater, release }), reply, retryDelayMs: 0 },
      'run-1',
      message(),
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.retryable).toBe(false)
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
      { ctx: context(), logger, config: defaultConfig, llm, agent: fakeStub(), reply, retryDelayMs: 0 },
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
        return { text: '纯聊天', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
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

  it('enable_vfs 关掉时 vfs 工具不注册（模型看不到）', async () => {
    let seenTools: Array<{ name: string }> = []
    const llm = {
      ...fakeLLM(),
      chat: async (req: { tools?: Array<{ name: string }> }) => {
        seenTools = req.tools ?? []
        return { text: 'ok', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
      },
    } as LLMService

    await executeRun(
      {
        ctx: context({ enable_vfs: false }),
        logger,
        config: { ...defaultConfig, enable_vfs: false },
        llm,
        agent: fakeStub(),
        reply: replySpy(),
      },
      'run-1',
      message(),
    )

    expect(seenTools.map((t) => t.name)).not.toContain('vfs.read_file')
  })

  it('定时任务以 scheduler 身份跑时不会被权限拦下（actorId 保留在消息里）', async () => {
    // 这条验证 run 把 message.userId 传进工具上下文，
    // 而 permissions/default-policy 对 actorId === 'scheduler' 有特判
    const release = vi.fn<(runId: string, result: ReleaseArg) => Promise<{ acquired: boolean }>>(async () => ({ acquired: false }))
    const outcome = await executeRun(
      {
        ctx: context(),
        logger,
        config: defaultConfig,
        retryDelayMs: 0,
        llm: fakeLLM('提醒你喝水'),
        agent: fakeStub({ release }),
        reply: replySpy(),
      },
      'run-1',
      message({ userId: 'scheduler', text: '提醒用户喝水' }),
    )
    expect(outcome.ok).toBe(true)
  })
})
