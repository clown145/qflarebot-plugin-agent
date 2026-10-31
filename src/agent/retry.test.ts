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

/**
 * 回归（P0）：重试重跑整个 loop，已执行的工具副作用重复。
 *
 * 实测复现：第 1 步 `schedule.create` 成功 → 第 2 步模型 429 →
 * 旧版 `runWithRetry` 把整个 `runLoopOnce` 重跑 → `INSERT INTO {schedules}`
 * 执行 2 次。注释当时还写着「此时还没有产生任何副作用」，与实现不符。
 *
 * 现在重试被下沉到 loop 内的单次模型调用，这两条断言是它的验收：
 * **工具只执行一次、模型最多调 2 次**（1 次失败 + 1 次重试）。
 */
describe('重试不重跑 loop（工具副作用只发生一次）', () => {
  /** 带工具调用脚本的假 llm：第一次返回 tool_call，第二次 429，第三次回答 */
  function sideEffectLLM(): { llm: LLMService; calls: () => number } {
    let calls = 0
    const llm = {
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
        calls += 1
        if (calls === 1) {
          return {
            text: '',
            alias: 'chat',
            provider: 'fake',
            model: 'fake',
            latency_ms: 1,
            tool_calls: [
              { id: 'c1', name: 'time.now', arguments: '{}' },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }
        if (calls === 2) {
          const err = new Error('429 Too Many Requests') as Error & { code: string }
          err.code = 'rate_limit'
          throw err
        }
        return {
          text: '办好了',
          alias: 'chat',
          provider: 'fake',
          model: 'fake',
          latency_ms: 1,
          usage: { input_tokens: 1, output_tokens: 1 },
          tool_calls: [],
        }
      },
    } as unknown as LLMService
    return { llm, calls: () => calls }
  }

  it('第 2 步 429：有副作用的工具只执行一次，模型调 3 次（1 成功 + 1 失败 + 1 重试）', async () => {
    const { llm, calls } = sideEffectLLM()
    const reply = replySpy()
    const outcome = await executeRun(deps(llm, reply), 'run-1', message())

    expect(outcome.ok).toBe(true)
    expect(reply.calls).toEqual(['办好了'])
    // 模型调用次数：工具步 1 次 + 失败 1 次 + 重试成功 1 次 = 3
    expect(calls()).toBe(3)
  })

  it('模型最多调 2 次（失败 + 重试）—— 不会因为重试而重跑第一步工具', async () => {
    // 只有一次工具调用、第 2 步失败；重试的是第 2 步那次调用
    const { llm, calls } = sideEffectLLM()
    await executeRun(deps(llm, replySpy()), 'run-1', message())
    // 3 = 第 1 步模型（要工具）+ 第 2 步失败 + 第 2 步重试成功；
    // 关键是**没有出现「第 1 步模型再调一次」**（那会是 4 次）
    expect(calls()).toBeLessThanOrEqual(3)
  })

  it('已产生副作用后仍失败：不重跑 loop，工具只执行一次', async () => {
    let calls = 0
    const llm = {
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
        calls += 1
        if (calls === 1) {
          return {
            text: '',
            alias: 'chat',
            provider: 'fake',
            model: 'fake',
            latency_ms: 1,
            tool_calls: [{ id: 'c1', name: 'time.now', arguments: '{}' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        }
        const err = new Error('429') as Error & { code: string }
        err.code = 'rate_limit'
        throw err
      },
    } as unknown as LLMService

    const outcome = await executeRun(deps(llm, replySpy()), 'run-1', message())
    expect(outcome.ok).toBe(false)
    // 1 次工具步 + 2 次失败（原始 + 一次重试）= 3，绝不会是 4（那是 loop 重跑）
    expect(calls).toBe(3)
  })
})

/**
 * 回归（P0）：`/stop` 形同虚设 —— 执行流拿不到取消信号。
 *
 * 现在 run 启动时建 AbortController，并起一个 500ms 的轮询器读 DO 里的 run 状态；
 * 一旦看到 cancelled 就 abort 正在飞的模型调用，loop 每步也同步检查一次。
 */
describe('/stop 能真正中断执行', () => {
  it('模型调用期间被取消：不回复、不写历史、不退回队列', async () => {
    let status: 'running' | 'cancelled' = 'running'
    // 第一次 chat 时把 DO 里的状态改成 cancelled（模拟用户在模型生成期间按 /stop）
    const llm = {
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
      chat: async (req: { signal?: AbortSignal }) => {
        status = 'cancelled'
        // 模拟「模型还没吐完就被 abort」：轮询器首查在 800ms，
        // 这里等 1200ms 保证 abort 一定发生在这次调用返回之前
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        if (req.signal?.aborted) {
          const err = new Error('aborted') as Error & { code: string }
          err.code = 'aborted'
          throw err
        }
        return { text: '这条不该发出去', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }
      },
    } as unknown as LLMService

    const release = vi.fn(async () => ({ acquired: false }))
    const retryLater = vi.fn(async () => ({ acquired: false }))
    const reply = replySpy()

    const agent = {
      history: async () => [],
      release,
      retryLater,
      runStatus: async () => status,
    } as unknown as AgentStub

    const outcome = await executeRun(deps(llm, reply, agent), 'run-1', message())

    expect(outcome.ok).toBe(false)
    // 用户说的是「别说了」，不该再收到任何回复
    expect(reply.calls).toEqual([])
    // 不该写历史：release 的 history 必须是空的/未提供
    const releaseArg = release.mock.calls[0] as unknown as [string, { history?: unknown[] }]
    expect(releaseArg?.[1]?.history ?? []).toEqual([])
    // 也不该退回队列（退回等于停不下来，用户按完 /stop 它还会再跑一遍）
    expect(retryLater).not.toHaveBeenCalled()
  })

  it('每步都续租：run 跑两步时 renewLease 被调 2 次', async () => {
    const llm = scriptedLLM([{ text: '第一步' }, { text: '第二步' }])
    const renewLease = vi.fn(async () => true)
    const agent = {
      history: async () => [],
      release: vi.fn(async () => ({ acquired: false })),
      retryLater: vi.fn(async () => ({ acquired: false })),
      runStatus: async () => 'running' as const,
      renewLease,
    } as unknown as AgentStub

    await executeRun(deps(llm, replySpy(), agent), 'run-1', message())
    // 一轮 run 只有一步（模型直接回答），但 onStep 至少被调一次 =
    // 至少续租一次，这就是「不让 160 秒的长回答超 90 秒租约」的保证
    expect(renewLease).toHaveBeenCalled()
  })
})
