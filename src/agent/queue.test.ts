import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import { normalizePlugin } from '@qqbot/sdk'
import plugin from '../index.js'
import type { Agent } from '../do/agent-object.js'
import { makeObject } from '../do/agent-test-object.js'
import { defaultConfig } from '../config/index.js'
import type { AgentConfig } from '../config/index.js'
import type { InboundMessage } from '../types.js'
import type { LLMChatResult, LLMService } from '../llm/contract.js'
import { createTestDb } from '../store/sqlite-test-db.js'
import { createSchedule } from '../store/d1.js'
import { executeRun } from './run.js'

/** 连接真实执行流、DO 调度和 SQLite；平台存储复用 DO 单测的替身。 */
function message(text: string, userId = 'old-user'): InboundMessage {
  return {
    conversation: 'group:g1',
    userId,
    userName: userId,
    text,
    displayText: text,
    attachments: [],
    scene: 'group',
    targetId: 'g1',
    memberRole: 'admin',
    passiveMessageId: `${userId}-message`,
    receivedAt: Date.now(),
  }
}

function result(text = '完成', extra: Partial<LLMChatResult> = {}): LLMChatResult {
  return { text, alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1, ...extra }
}

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
  vi.restoreAllMocks()
})

function setup(chat: LLMService['chat'] = async () => result(), config: Partial<AgentConfig> = {}) {
  const store = createTestDb()
  cleanup.push(() => store.close())
  const { obj: agent } = makeObject()
  const llm: LLMService = {
    contractVersion: 1,
    chat: vi.fn(chat),
    stream: async function* () {},
    listModels: async () => [],
    resolve: async () => ({
      alias: 'chat',
      provider: 'fake',
      provider_name: 'fake',
      model: 'fake',
      capabilities: ['text', 'tools'],
    }),
    ping: async () => ({ ok: true, latency_ms: 1 }),
  }
  const ctx = createMockContext<AgentConfig>(plugin, {
    config: {
      ...defaultConfig,
      enable_tools: false,
      enable_schedule: true,
      enable_skills: false,
      enable_vfs: false,
      enable_audit: false,
      reply_mention: 'group',
      ...config,
    },
    db: store.db,
    services: { llm },
    durable: { Agent: agent as unknown as DurableObjectStub },
  })
  const send = vi.spyOn(ctx.api, 'sendMessage')
  const reply = vi.fn(async () => true)
  const deps = { ctx, config: ctx.config, logger: ctx.logger, agent, llm, reply, retryDelayMs: 0 }
  const tick = async () => {
    // 每次 cron 模块实例隔离，避免另一个测试的十分钟清理节流影响本用例。
    vi.resetModules()
    const fresh = (await import('../index.js')).default
    return normalizePlugin(fresh).cron.find((item) => item.name === 'tick')!.handler({
      ctx, job: 'tick', scheduledAt: Date.now(),
    })
  }
  const ask = (text = 'new request') => normalizePlugin(plugin).commands.find((item) => item.name === 'ask')!.handler({
    ctx,
    session: createMockSession({
      scene: 'group',
      targetId: 'g1',
      userId: 'new-user',
      messageId: 'new-user-message',
      memberRole: 'admin',
      content: text,
    }),
    command: 'ask',
    args: text.split(' '),
    argText: text,
  })
  return { store, agent, llm, ctx, send, reply, deps, tick, ask }
}

async function enqueue(agent: Agent, text: string) {
  const claimed = await agent.submit(message(text))
  if (!claimed.runId || !claimed.message) throw new Error('测试未拿到执行权')
  return { runId: claimed.runId, message: claimed.message }
}

describe('执行流与 DO 队列的衔接', () => {
  it.each([
    { reasoning: '最终回答的推理', withTool: false },
    { reasoning: '', withTool: false },
    { reasoning: '最终回答的推理', withTool: true },
    { reasoning: '', withTool: true },
  ])('后续用户轮次保留历史回答的 reasoning：%j', async ({ reasoning, withTool }) => {
    let calls = 0
    const s = setup(async () => {
      if (++calls === 1 && withTool) {
        return result('', {
          reasoning: '先查询时间',
          tool_calls: [{ id: 'c1', name: 'time.now', arguments: '{}' }],
        })
      }
      return result('回答', { reasoning })
    }, { enable_tools: true })
    await s.ask('第一轮')
    expect((await s.agent.history(20)).find((item) => item.role === 'assistant')?.reasoning).toBe(reasoning)
    await s.ask('第二轮')
    const request = vi.mocked(s.llm.chat).mock.calls.at(-1)![0]
    expect(request.messages.find((item) => item.role === 'assistant')?.reasoning).toBe(reasoning)
    expect(request.tools?.length).toBeGreaterThan(0)
  })

  it('成功创建提醒之后模型重试耗尽，不会把整轮重新排队并重复创建提醒', async () => {
    let calls = 0
    const s = setup(async () => {
      if (++calls === 1) {
        return result('', {
          tool_calls: [{
            id: 'c1', name: 'schedule.create',
            arguments: JSON.stringify({ delay_seconds: 600, prompt: '喝水' }),
          }],
        })
      }
      throw Object.assign(new Error('429'), { code: 'rate_limit' })
    }, { enable_tools: true })
    const first = await enqueue(s.agent, '十分钟后提醒我喝水')
    const outcome = await executeRun(s.deps, first.runId, first.message)
    expect(outcome).toMatchObject({ ok: false, retryable: false })
    expect(calls).toBe(3)
    expect(await s.store.db.all('SELECT * FROM {schedules}')).toHaveLength(1)
    expect(await s.agent.poll()).toMatchObject({ acquired: false })
    expect(await s.agent.runStatus(first.runId)).toBe('failed')
  })

  it.each(['auth', 'rate_limit', 'cancelled'])('%s 收尾时返回下一条已认领的消息', async (code) => {
    const s = setup(async () => {
      if (code === 'cancelled') {
        await s.agent.stop()
        return result('不应发送')
      }
      throw Object.assign(new Error(code), { code })
    })
    const first = await enqueue(s.agent, '第一条')
    await s.agent.submit(message('第二条'))
    const outcome = await executeRun(s.deps, first.runId, first.message)
    expect(outcome.next).toMatchObject({ acquired: true, message: { text: '第二条' } })
    expect(await s.agent.stats()).toMatchObject({ locked: true })
    if (code === 'cancelled') {
      expect(s.reply).not.toHaveBeenCalled()
      expect(await s.agent.history(20)).toEqual([])
    }
  })

  it('新消息唤醒旧队列时先执行旧消息，每条回复使用自己的被动凭据和 @ 对象', async () => {
    const s = setup()
    const first = await enqueue(s.agent, 'old request')
    await s.agent.retryLater(first.runId, '旧版本遗留待处理消息')
    await s.ask()
    expect(s.llm.chat).toHaveBeenCalledTimes(2)
    expect(vi.mocked(s.llm.chat).mock.calls[0]?.[0].messages.at(-1)?.content).toContain('old request')
    expect(vi.mocked(s.llm.chat).mock.calls[1]?.[0].messages.at(-1)?.content).toContain('new request')
    expect(s.send.mock.calls.map((call) => call[2]?.messageId)).toEqual(['old-user-message', 'new-user-message'])
    expect(s.send.mock.calls[0]?.[1]).toMatchObject({ text: expect.stringContaining('old-user') })
    expect(s.send.mock.calls[1]?.[1]).toMatchObject({ text: expect.stringContaining('new-user') })
    expect((await s.agent.history(20)).filter((item) => item.role === 'user').map((item) => item.content))
      .toEqual(['old request', 'new request'])
  })

  it('定时提醒认领到旧消息时执行旧消息，并继续处理新提醒', async () => {
    const s = setup()
    const first = await enqueue(s.agent, 'old request')
    await s.agent.retryLater(first.runId, '待处理')
    await createSchedule(s.store.db, { id: 'reminder', conversation: 'group:g1', scene: 'group',
      targetId: 'g1', prompt: 'new reminder', dueAt: Date.now() - 1000, createdBy: 'new-user' })
    await s.tick()
    const requests = vi.mocked(s.llm.chat).mock.calls
    expect(requests).toHaveLength(2)
    expect(requests[0]?.[0].messages.at(-1)?.content).toContain('old request')
    expect(requests[1]?.[0].messages.at(-1)?.content).toContain('new reminder')
    expect(await s.agent.stats()).toMatchObject({ locked: false, pending: 0 })
  })

  it('一次最多执行五条，剩下的仍是 pending，cron 可以接着处理', async () => {
    const s = setup()
    const first = await enqueue(s.agent, 'queued-0')
    for (let i = 1; i < 6; i++) await s.agent.submit(message(`queued-${i}`))
    await s.agent.retryLater(first.runId, '待处理')
    await s.ask()
    expect(s.llm.chat).toHaveBeenCalledTimes(5)
    expect(await s.agent.stats()).toMatchObject({ locked: false, pending: 2 })
    await s.tick()
    expect(s.llm.chat).toHaveBeenCalledTimes(7)
    expect(await s.agent.stats()).toMatchObject({ locked: false, pending: 0 })
  })

  it('cron 预算用完时不提前认领下一条', async () => {
    const now = Date.now()
    const time = vi.spyOn(Date, 'now').mockReturnValue(now)
    const s = setup(async () => {
      time.mockReturnValue(now + 60_000)
      return result()
    })
    const first = await enqueue(s.agent, 'old request')
    await s.agent.retryLater(first.runId, '待处理')
    await createSchedule(s.store.db, { id: 'reminder', conversation: 'group:g1', scene: 'group',
      targetId: 'g1', prompt: 'new reminder', dueAt: now - 1000, createdBy: 'new-user' })
    await s.tick()
    expect(s.llm.chat).toHaveBeenCalledOnce()
    expect(await s.agent.stats()).toMatchObject({ locked: false, pending: 1 })
  })
})
