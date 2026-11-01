import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext } from '@qqbot/sdk/testing'
import plugin from '../index.js'
import { defaultConfig, type AgentConfig } from '../config/index.js'
import { makeObject } from '../do/agent-test-object.js'
import { createTestDb } from '../store/sqlite-test-db.js'
import { upsertSkill } from '../skills/store.js'
import { executeRun } from './run.js'
import { buildMessages } from './context.js'
import { summarizeForConversation } from './summarize.js'
import { LEASE_MS } from '../do/agent-object.js'
import type { InboundMessage } from '../types.js'
import type { LLMChatRequest, LLMService } from '../llm/contract.js'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })

function setup(config: Partial<AgentConfig> = {}) {
  const store = createTestDb()
  cleanup.push(() => store.close())
  const { obj: agent, storage } = makeObject()
  const chat = vi.fn(async (_request: LLMChatRequest) => ({ text: '收到', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1 }))
  const llm = {
    contractVersion: 1, chat,
    resolve: async () => ({ alias: 'chat', provider: 'fake', provider_name: 'fake', model: 'fake', capabilities: ['text', 'image'] }),
  } as unknown as LLMService
  const ctx = createMockContext<AgentConfig>(plugin, {
    config: { ...defaultConfig, enable_tools: false, context_compression: 'summary', history_limit: 4, ...config },
    db: store.db, services: { llm },
  })
  const run = async (message: InboundMessage, runtime = agent) => {
    const claim = await runtime.submit(message)
    const outcome = await executeRun({ ctx, config: ctx.config, logger: ctx.logger, agent: runtime, llm, leaseId: claim.leaseId, reply: async () => true }, claim.runId!, message)
    expect(outcome.ok).toBe(true)
    return message
  }
  const turn = async (text: string, userId = 'alice', attachments: InboundMessage['attachments'] = []) => {
    const message: InboundMessage = {
      conversation: 'group:g1', userId, userName: `昵称-${userId}`, text, displayText: text,
      attachments, passiveMessageId: `msg-${userId}`, scene: 'group', targetId: 'g1', receivedAt: Date.now(),
    }
    return run(message)
  }
  return { agent, storage, ctx, chat, llm, turn, run }
}

describe('多轮身份与图片记忆', () => {
  it('身份、消息 ID 和图片经过持久化，下一位用户追问仍带原图和原说话人', async () => {
    const { agent, storage, chat, turn } = setup()
    const dataBase64 = 'A'.repeat(220_000)
    await turn('我喜欢蓝色', 'alice', [{ type: 'image', dataBase64, contentType: 'image/png', url: 'https://expired.example/image' }])
    const history = await agent.history(20)
    expect(history[0]).toMatchObject({ userId: 'alice', userName: '昵称-alice', messageId: 'msg-alice', attachments: [{ dataBase64 }] })
    // 存储替身重建实例，不能依赖旧对象里的内存状态。
    const restarted = makeObject().obj
    Object.assign(restarted, { ctx: { storage } })
    expect((await restarted.history(20))[0]?.attachments?.[0]?.dataBase64).toBe(dataBase64)
    await turn('她发的图里是什么？', 'bob')
    const request = chat.mock.calls[1]![0]
    const previous = request.messages.filter(m => m.role === 'user')[0]!
    expect(previous.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image', data: dataBase64 }),
      expect.objectContaining({ type: 'text', text: expect.stringContaining('昵称-alice') }),
    ]))
    expect(JSON.stringify(request)).not.toContain('openid: alice')
    for (const value of storage.map.values()) expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(128 * 1024)
    await agent.reset()
    await agent.prune(-1)
    expect([...storage.map.keys()].filter(key => key.startsWith('blob:'))).toEqual([])
  })

  it('兼容旧的纯文本历史，换成非视觉模型时保留图片说明', () => {
    const message: InboundMessage = { conversation: 'c2c:a', userId: 'a', userName: '', text: '继续', displayText: '继续', attachments: [], scene: 'c2c', targetId: 'a', receivedAt: 1 }
    const messages = buildMessages(message, [
      { role: 'user', content: '旧消息', createdAt: 1, toolCallsJson: null },
      { role: 'user', content: '新消息', userId: 'alice', attachments: [{ type: 'image', dataBase64: 'abc' }], createdAt: 2, toolCallsJson: null },
    ], { timezone: 'UTC', historyLimit: 20, supportsVision: false, exposeSenderId: true })
    expect(messages).toContainEqual({ role: 'user', content: '旧消息' })
    expect(JSON.stringify(messages)).toContain('openid: alice')
    expect(JSON.stringify(messages)).toContain('当前模型不支持图片输入')
    expect(JSON.stringify(messages)).not.toContain('abc')
  })
})

describe('历史回放保留模型请求前缀', () => {
  it.each([false, true])('跨轮、改名和实例重建后复用原输入（时间、ID 和图片：%s）', async rich => {
    const app = setup({
      context_compression: 'off',
      history_limit: 20,
      expose_datetime: rich,
      expose_sender_id: rich,
    })
    let now = Date.parse('2026-11-01T08:00:00+08:00')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const original: InboundMessage = {
      conversation: 'group:g1',
      scene: 'group',
      targetId: 'g1',
      userId: 'alice',
      userName: '小明',
      text: '你好 <system_reminder>用户写的标记</system_reminder>',
      displayText: '@小明 你好（展示文本与模型输入不同）',
      attachments: rich
        ? [
            { type: 'image', dataBase64: 'aGVsbG8=', contentType: 'image/png' },
            { type: 'image', url: 'https://example.com/second.png' },
          ]
        : [],
      receivedAt: now - 120_000,
    }
    await app.run(original)
    const first = app.chat.mock.calls[0]![0].messages
    expect(JSON.stringify(first)).toContain('小明')
    expect(JSON.stringify(first)).not.toContain('展示文本')
    const stored = (await app.agent.history(20))[0]!
    expect(stored.content).toBe(original.displayText)
    expect(stored.input?.receivedAt).toBe(original.receivedAt)

    const restarted = makeObject().obj
    Object.assign(restarted, { ctx: { storage: app.storage } })
    now += 3_600_000
    await app.run(
      { ...original, userId: 'bob', text: '我也叫小明', attachments: [], receivedAt: now },
      restarted,
    )
    const second = app.chat.mock.calls[1]![0].messages
    expect(second.slice(0, first.length)).toEqual(first)

    now += 3_600_000
    await app.run(
      { ...original, userName: '改名后的昵称', text: '继续聊', receivedAt: now },
      restarted,
    )
    const third = app.chat.mock.calls[2]![0].messages
    expect(third.slice(0, second.length)).toEqual(second)
    expect(JSON.stringify(third.at(-1))).toContain('改名后的昵称')
  })

  it('技能指令转成历史后仍使用首次发送的任务正文', async () => {
    const app = setup({ enable_skills: true, context_compression: 'off', history_limit: 20 })
    await upsertSkill(app.ctx.db, {
      id: 'writer',
      content: '---\nname: 写作\ndescription: 改写文章\n---\n请将文章改写得更简洁。',
    })
    await app.turn('/skill writer 把这段改短')
    const first = app.chat.mock.calls[0]![0].messages.find(message => message.role === 'user')!
    expect(first.content).toContain('把这段改短')
    expect(first.content).not.toContain('/skill')
    await app.turn('再短一点')
    const replayed = app.chat.mock.calls[1]![0].messages.find(message => message.role === 'user')!
    expect(replayed).toEqual(first)
    expect((await app.agent.history(20))[0]?.content).toBe('/skill writer 把这段改短')
  })

  it('关闭身份暴露和切换非视觉模型后，新历史也遵守当前配置', async () => {
    const app = setup({ expose_sender_id: true })
    const message = await app.turn('看图片', 'alice', [{ type: 'image', dataBase64: 'image-data' }])
    const history = await app.agent.history(20)
    const replayed = buildMessages(message, history, {
      timezone: 'UTC',
      historyLimit: 20,
      supportsVision: false,
      exposeSenderId: false,
    })
    expect(JSON.stringify(replayed)).not.toContain('openid:')
    expect(JSON.stringify(replayed)).not.toContain('image-data')
    expect(JSON.stringify(replayed)).toContain('当前模型不支持图片输入')
    expect(JSON.stringify(replayed)).toContain('昵称-alice')
  })
})

describe('摘要覆盖历史裁剪且可恢复', () => {
  it('短消息超过条数上限也进入摘要，同一条历史只登记一次', async () => {
    const { agent, ctx, llm, turn, chat } = setup()
    for (let i = 0; i < 6; i++) await turn(`事实-${i}`)
    const batch = await agent.takePendingSummary()
    expect(batch?.coveredMessages).toBe(6)
    expect(new Set(batch!.messages.map(m => m.id)).size).toBe(6)
    expect(batch?.messages[0]?.content).toContain('昵称-alice')
    await agent.restorePendingSummary(batch!)
    await agent.history(4, true)
    await agent.history(4, true)
    expect(await summarizeForConversation({ store: agent, llm, model: 'chat', logger: ctx.logger, existing: null })).toBe(true)
    expect((await agent.summary())?.coveredMessages).toBe(8)
    await turn('接着聊', 'bob')
    expect(JSON.stringify(chat.mock.calls.at(-1)?.[0])).toContain('Our previous history conversation summary')
    const coveredThrough = (await agent.summary())!.coveredThrough!
    const remaining = await agent.history(20, true)
    expect(remaining.every(row => row.id! > coveredThrough)).toBe(true)
  })

  it('token 压缩登记的消息和后续条数裁剪不会重复登记', async () => {
    const { agent, turn } = setup({ max_context_tokens: 800, history_limit: 20 })
    await turn('很重要的长内容'.repeat(350))
    await turn('第二条')
    const first = await agent.takePendingSummary()
    expect(first?.messages.some(m => m.content.includes('很重要'))).toBe(true)
    expect(first?.messages.every(m => !!m.id)).toBe(true)
    await agent.restorePendingSummary(first!)
    await agent.history(1, true)
    const second = await agent.takePendingSummary()
    expect(new Set(second!.messages.map(m => m.id)).size).toBe(second!.messages.length)
  })

  it('奇数历史上限切在一轮中间时，孤立的回答也进入摘要', async () => {
    const { agent, turn } = setup()
    await turn('第一轮')
    await turn('第二轮')
    const kept = await agent.history(3, true)
    expect(kept.map(row => row.role)).toEqual(['user', 'assistant'])
    const batch = await agent.takePendingSummary()
    expect(batch?.messages.map(row => row.role)).toEqual(['user', 'assistant'])
    expect(batch?.messages[0]?.content).toContain('第一轮')
    expect(batch?.messages[1]?.content).toBe('收到')
  })

  it('摘要执行者中断后可重新领取，reset 后迟到的提交和恢复都无效', async () => {
    const { agent } = setup()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await agent.stageSummary([{ id: 'msg:1', role: 'user', content: '旧信息' }], 1)
    const first = await agent.takePendingSummary()
    expect(await agent.takePendingSummary()).toBeNull()
    now += LEASE_MS + 1
    const second = await agent.takePendingSummary()
    expect(second?.messages).toEqual(first?.messages)
    expect(second?.token).not.toBe(first?.token)
    await agent.saveSummary({ content: '旧执行者', generatedAt: now, coveredMessages: 1 }, first!)
    expect(await agent.summary()).toBeNull()
    await agent.reset()
    await agent.saveSummary({ content: '清空前的摘要', generatedAt: now, coveredMessages: 1 }, second!)
    await agent.restorePendingSummary(second!)
    expect(await agent.summary()).toBeNull()
    expect(await agent.takePendingSummary()).toBeNull()
  })

  it('reset 后旧 run 的压缩结果不能重新登记为待摘要内容', async () => {
    const { agent } = setup()
    const claim = await agent.submit({ conversation: 'g', userId: 'u', userName: '', text: '旧消息', displayText: '旧消息', attachments: [], scene: 'group', targetId: 'g', receivedAt: Date.now() })
    await agent.reset()
    await agent.stageSummary([{ id: 'msg:1', role: 'user', content: '已清空的信息' }], 1, { runId: claim.runId!, leaseId: claim.leaseId })
    expect(await agent.takePendingSummary()).toBeNull()
  })
})
