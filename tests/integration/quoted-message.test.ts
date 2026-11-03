import { buildSession, dispatch } from '@qqbot/runtime/testing'
import { describe, expect, it, vi } from 'vitest'
import { makeObject } from '../../src/do/agent-test-object.js'
import { upsertSkill } from '../../src/skills/store.js'
import type { LLMChatRequest } from '../../src/llm/contract.js'
import { config, harness, logger, result, setupIntegrationTests } from './harness.js'

setupIntegrationTests()

const imageUrl = 'https://example.com/quoted.png?signature=temporary'
const quoted = (content = '原消息说明') => ({
  message_type: 103,
  msg_elements: [{ content, attachments: [{ url: imageUrl, content_type: 'image/png' }] }],
})

async function app(vision = true) {
  const chat = vi.fn(async (_request: LLMChatRequest) => result())
  const h = await harness(chat, [])
  const model = await h.llm.resolve()
  vi.spyOn(h.llm, 'resolve').mockResolvedValue({ ...model, capabilities: vision ? ['text', 'image'] : ['text'] })
  const network = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'content-type': 'image/png' },
  }))
  vi.stubGlobal('fetch', network)
  return { ...h, chat, network }
}

async function send(h: Awaited<ReturnType<typeof app>>, body: Record<string, unknown>, rawType = 'GROUP_MESSAGE_CREATE') {
  const session = buildSession({
    op: 0,
    t: rawType,
    d: { id: 'm1', group_openid: 'g1', author: { member_openid: 'u1' }, ...body },
  }, { botId: '123', maxPassiveReplies: 5, sender: h.api })
  const report = await dispatch(session, {
    contexts: h.factory, registry: h.registry, snapshot: h.snapshot, logger, commandPrefixes: ['/'],
  })
  expect(report.errors).toEqual([])
}

describe('引用文字和图片通过真实框架进入模型与历史', () => {
  it.each(['/看看这张图', '/ask 看看这张图', '<@123> 看看这张图', '你好 <@123> 看看这张图'])(
    '%s：引用原文和图片都进入模型，下一轮回放不丢失、不重复下载', async content => {
      const h = await app()
      await send(h, { ...quoted(), content })
      expect(h.network).toHaveBeenCalledTimes(1)
      const first = h.chat.mock.calls[0]![0].messages.find(m => m.role === 'user')!
      expect(first.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('原消息说明') }),
        { type: 'image', data: 'iVBORw==', media_type: 'image/png' },
      ]))
      const history = await h.agent.history(20)
      expect(history[0]).toMatchObject({
        userId: 'u1', input: { quotedText: '原消息说明' },
        attachments: [{ source: 'quote', dataBase64: 'iVBORw==' }],
      })
      expect(history[0]!.content).toContain('[引用消息，仅作上下文]')

      await send(h, { id: 'm2', content: '/继续' })
      const replay = h.chat.mock.calls[1]![0].messages.find(m => m.role === 'user')!
      expect(replay.content).toEqual(first.content)
      expect(h.network).toHaveBeenCalledTimes(1)
    },
  )

  it('当前和引用同时携带同一图片时，不重复下载或保存', async () => {
    const h = await app()
    await send(h, {
      ...quoted(), content: '/比较一下',
      attachments: [{ url: 'https://example.com/current.png' }, { url: imageUrl }],
    })
    expect(h.network).toHaveBeenCalledTimes(2)
    const user = h.chat.mock.calls[0]![0].messages.find(m => m.role === 'user')!
    expect(Array.isArray(user.content) && user.content.filter(p => p.type === 'image')).toHaveLength(2)
    expect((await h.agent.history(20))[0]!.attachments).toHaveLength(2)
  })

  it.each(['', '/'])('当前只有自身艾特或前缀（%s）时，纯引用图片也能处理', async content => {
    const h = await app()
    await send(h, { ...quoted(''), content: `${content}<@123>` })
    expect(h.chat).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.chat.mock.calls[0]![0].messages)).toContain('iVBORw==')
  })

  it.each(['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'])(
    '%s：仅引用图片/全体艾特/技能指令不会唤醒，也不会下载附件', async rawType => {
      const h = await app()
      await send(h, { ...quoted('<@everyone> /skill report 写周报'), content: '收到' }, rawType)
      expect(h.chat).not.toHaveBeenCalled()
      expect(h.network).not.toHaveBeenCalled()
    },
  )

  it('引用原文中的技能指令不会被当成本轮的技能调用', async () => {
    const h = await app()
    h.snapshot.plugins.agent!.config = { ...config, enable_skills: true }
    Object.assign(h, h.fresh())
    await upsertSkill(h.ctx.db, { id: 'secret', content: '---\nname: Secret\ndescription: 测试技能\n---\n只在激活时出现的技能正文' })
    await send(h, { ...quoted('/skill secret 不该激活'), content: '/解释原文' })
    const request = h.chat.mock.calls[0]![0]
    expect(request.messages.filter(m => m.role === 'system').some(m => JSON.stringify(m).includes('只在激活时出现的技能正文'))).toBe(false)
    expect(JSON.stringify(request.messages.find(m => m.role === 'user'))).toContain('/skill secret 不该激活')
  })

  it('当前技能正常激活，引用内容经过技能正文替换和历史回放后仍保留', async () => {
    const h = await app()
    h.snapshot.plugins.agent!.config = { ...config, enable_skills: true }
    Object.assign(h, h.fresh())
    await upsertSkill(h.ctx.db, { id: 'writer', content: '---\nname: Writer\ndescription: 写作\n---\n当前写作技能正文' })
    await send(h, { ...quoted('需要改写的文章'), content: '/skill writer 改短一点' })
    const first = h.chat.mock.calls[0]![0]
    expect(JSON.stringify(first.messages.filter(m => m.role === 'system'))).toContain('当前写作技能正文')
    const user = first.messages.find(m => m.role === 'user')!
    expect(JSON.stringify(user)).toContain('改短一点')
    expect(JSON.stringify(user)).toContain('需要改写的文章')
    expect(JSON.stringify(user)).not.toContain('/skill writer')
    await send(h, { id: 'm2', content: '/继续' })
    expect(h.chat.mock.calls[1]![0].messages.find(m => m.role === 'user')!.content).toEqual(user.content)
  })

  it('引用原文同样经过已有关键词过滤，命中时不下载也不调用模型', async () => {
    const h = await app()
    h.snapshot.plugins.agent!.config = { ...config, content_filter_keywords: 'blocked-word' }
    Object.assign(h, h.fresh())
    await send(h, { ...quoted('blocked-word'), content: '/解释引用' })
    expect(h.network).not.toHaveBeenCalled()
    expect(h.chat).not.toHaveBeenCalled()
    expect(await h.agent.history(20)).toEqual([])
    expect(h.sendMessage).toHaveBeenCalled()
  })

  it('引用纯文字和其他文件也保留上下文，未解析的文件明确只提供元信息', async () => {
    const h = await app()
    await send(h, { content: '/解释引用内容', message_type: 103, msg_elements: [{
      content: '这是文档说明',
      attachments: [{ url: 'https://example.com/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' }],
    }] })
    const request = JSON.stringify(h.chat.mock.calls[0]![0].messages)
    expect(request).toContain('这是文档说明')
    expect(request).toContain('引用消息附件：report.pdf')
    expect(request).toContain('未解析文件内容')
    expect(h.network).not.toHaveBeenCalled()
  })

  it('当前图片和引用图片共用张数上限，跳过的图片会向模型说明', async () => {
    const h = await app()
    await send(h, {
      ...quoted(), content: '/逐张说明',
      attachments: Array.from({ length: 4 }, (_, i) => ({ url: `https://example.com/current-${i}.png` })),
    })
    expect(h.network).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(h.chat.mock.calls[0]![0].messages)).toContain('图片超过 4 张')
    expect((await h.agent.history(20))[0]!.attachments).toHaveLength(4)
  })

  it('下载失败时说明未读到图片，文字仍可处理', async () => {
    const h = await app()
    h.network.mockImplementation(async () => new Response('', { status: 403 }))
    await send(h, { ...quoted(), content: '/说明一下' })
    const request = JSON.stringify(h.chat.mock.calls[0]![0].messages)
    expect(request).toContain('原消息说明')
    expect(request).toContain('图片下载失败')
    expect(request).not.toContain('"type":"image"')
    expect(h.sendMessage).toHaveBeenCalled()
  })

  it('非视觉模型接收引用原文和图片能力说明，不伪装成看到了图片', async () => {
    const h = await app(false)
    await send(h, { ...quoted(), content: '/解释一下' })
    const request = JSON.stringify(h.chat.mock.calls[0]![0].messages)
    expect(request).toContain('原消息说明')
    expect(request).toContain('当前模型不支持图片输入')
    expect(request).not.toContain('iVBORw==')
    expect(h.network).not.toHaveBeenCalled()
    expect((await h.agent.history(20))[0]!.attachments![0]).not.toHaveProperty('dataBase64')
  })

  it('只有引用 ID、平台没给原文时，明确标记缺失而不编造内容', async () => {
    const h = await app()
    await send(h, { content: '/这是什么意思', message_reference: { message_id: 'old' } })
    expect(JSON.stringify(h.chat.mock.calls[0]![0].messages)).toContain('平台未提供被引用消息的正文或附件')
    expect(h.network).not.toHaveBeenCalled()
  })

  it('图片先下载再入队，实例重建和继续执行都不依赖临时 URL', async () => {
    const h = await app()
    const blocker = await h.agent.submit(await h.authorize())
    const bytes = new Uint8Array(160_000).fill(65)
    h.network.mockImplementation(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
    await send(h, { ...quoted(), content: '/稍后看看这张图' })
    expect(h.chat).not.toHaveBeenCalled()
    expect(h.network).toHaveBeenCalledTimes(1)
    await h.agent.release(blocker.runId!, { ok: true, leaseId: blocker.leaseId, claimNext: false })

    const restarted = makeObject().obj
    Object.assign(restarted, { ctx: { storage: h.storage } })
    const claim = await restarted.poll()
    expect(claim.message).toMatchObject({ quotedText: '原消息说明' })
    expect(claim.message!.attachments[0]!.dataBase64).toBe(btoa('A'.repeat(bytes.length)))
    h.network.mockImplementation(async () => new Response('', { status: 403 }))
    expect(await h.run(h.fresh().ctx, restarted, claim, Date.now() - 1)).toMatchObject({ suspended: true })
    expect((await restarted.checkpoint(claim.runId!))?.historyInput?.quotedText).toBe('原消息说明')
    const resumed = makeObject().obj
    Object.assign(resumed, { ctx: { storage: h.storage } })
    expect(await h.run(h.fresh().ctx, resumed, await resumed.poll())).toMatchObject({ ok: true })
    expect(JSON.stringify(h.chat.mock.calls[0]![0].messages)).toContain(btoa('A'.repeat(bytes.length)))
    expect(h.network).toHaveBeenCalledTimes(1)
    expect((await restarted.history(20))[0]!.input?.quotedText).toBe('原消息说明')
    expect(await resumed.checkpoint(claim.runId!)).toBeNull()
    expect(h.storage.map.has(`input:${claim.runId}`)).toBe(false)
    expect(h.storage.map.get(`run:${claim.runId}`)).toMatchObject({ status: 'completed', inputJson: '' })
    for (const value of h.storage.map.values()) {
      expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(128 * 1024)
    }
    await resumed.reset()
    expect([...h.storage.map.keys()].filter(key => key.startsWith('blob:'))).toEqual([])
  })
})
