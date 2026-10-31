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
    // runtime-config 会读页面里选中的别名 / 提示词覆盖，给个最小 KV 替身
    kv: {
      async get() { return null },
      async getJSON() { return null },
      async put() {},
      async delete() {},
      async list() { return [] },
    } as never,
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

  it('上游限流：局部重试耗尽后结束本轮，不回队列重跑已成功的工具', async () => {
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
    expect(outcome.retryable).toBe(false)
    expect(retryLater).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
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

  /**
   * 回归：宿主的 `ctx.r2` **永远是一个对象**——没绑 R2 时每个方法都是「调用即抛」的桩
   * （`packages/runtime/src/scoped.ts` 的 `createScopedR2`）。上一版 `if (ctx.r2)` 恒为真，
   * 于是 enable_vfs 会在没有 R2 的机器人上注册一整套必然失败的工具。
   * 现在真的探测一次（`head()` 抛错即视为未绑定）。
   */
  /**
   * 轻量模式：没绑 R2 时 vfs **仍然注册**（只用 D1 存 ≤8KB 文本）。
   *
   * 以前是「没 R2 就整组不注册」，等于把轻量功能绑死在重型基础设施上——
   * 「记个笔记、存个待办」根本用不到大文件，结果多数部署里
   * 「有虚拟工作区」等于不存在。大文件在轻量模式下会返回可读错误。
   */
  it('enable_vfs 打开但 R2 未绑定时，vfs 工具仍然注册（轻量模式）', async () => {
    let seenTools: Array<{ name: string }> = []
    const llm = {
      ...fakeLLM(),
      chat: async (req: { tools?: Array<{ name: string }> }) => {
        seenTools = req.tools ?? []
        return { text: 'ok', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
      },
    } as LLMService

    const thrower = async (): Promise<never> => {
      throw new Error('未绑定 R2（wrangler.jsonc 的 r2_buckets），插件无法使用 ctx.r2')
    }
    const unboundR2 = {
      get: thrower,
      getText: thrower,
      getJSON: thrower,
      getStream: thrower,
      put: thrower,
      delete: thrower,
      head: thrower,
      list: thrower,
    }

    await executeRun(
      {
        ctx: { ...context({ enable_vfs: true }), r2: unboundR2 } as unknown as PluginContext<AgentConfig>,
        logger,
        config: { ...defaultConfig, enable_vfs: true },
        llm,
        agent: fakeStub(),
        reply: replySpy(),
      },
      'run-1',
      message(),
    )

    // 轻量模式下 vfs 可用（只是存不了大文件）
    expect(seenTools.map((t) => t.name)).toContain('vfs.read_file')
    expect(seenTools.map((t) => t.name)).toContain('vfs.write_file')
    // 也仍然该有时间与网页工具
    expect(seenTools.map((t) => t.name)).toContain('time.now')
  })

  it('enable_vfs 打开且 R2 可用时，vfs 工具正常注册', async () => {
    let seenTools: Array<{ name: string }> = []
    const llm = {
      ...fakeLLM(),
      chat: async (req: { tools?: Array<{ name: string }> }) => {
        seenTools = req.tools ?? []
        return { text: 'ok', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
      },
    } as LLMService

    const boundR2 = {
      get: async () => null,
      getText: async () => null,
      getJSON: async () => null,
      getStream: async () => null,
      put: async () => {},
      delete: async () => {},
      head: async () => null,
      list: async () => [],
    }

    await executeRun(
      {
        ctx: { ...context({ enable_vfs: true }), r2: boundR2 } as unknown as PluginContext<AgentConfig>,
        logger,
        config: { ...defaultConfig, enable_vfs: true },
        llm,
        agent: fakeStub(),
        reply: replySpy(),
      },
      'run-1',
      message(),
    )

    expect(seenTools.map((t) => t.name)).toContain('vfs.read_file')
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
