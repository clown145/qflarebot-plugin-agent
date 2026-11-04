import { QQBotClient } from '@qqbot/api'
import { buildSession, dispatch } from '@qqbot/runtime/testing'
import { describe, expect, it, vi } from 'vitest'
import { replyFromSession } from '../../src/agent/run.js'
import { harness, logger, result, setupIntegrationTests } from './harness.js'

setupIntegrationTests()

const markdown = '# 标题\n\n**重点**与[链接](https://example.com)\n\n```ts\nconst n = 1\n```'
const scenes = [
  { name: '群聊', rawType: 'GROUP_MESSAGE_CREATE', body: { group_openid: 'g1', author: { member_openid: 'u1' } }, path: '/v2/groups/g1/messages', v2: true },
  { name: '单聊', rawType: 'C2C_MESSAGE_CREATE', body: { author: { user_openid: 'u1' } }, path: '/v2/users/u1/messages', v2: true },
  { name: '频道', rawType: 'AT_MESSAGE_CREATE', body: { channel_id: 'c1', author: { id: 'u1' } }, path: '/channels/c1/messages', v2: false },
  { name: '频道私信', rawType: 'DIRECT_MESSAGE_CREATE', body: { guild_id: 'guild1', author: { id: 'u1' } }, path: '/dms/guild1/messages', v2: false },
]

async function delivery(scene = scenes[0]!) {
  const chat = vi.fn(async () => result({ text: markdown }))
  const h = await harness(chat, [])
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: 'sent' }))
  const client = new QQBotClient({
    appId: 'test', secret: 'test', fetchImpl: fetchMock,
    tokenProvider: { get: async () => 'token', invalidate: async () => {} },
  })
  h.sendMessage.mockImplementation(client.sendMessage.bind(client))
  const session = buildSession({
    op: 0, t: scene.rawType,
    d: { id: 'm1', content: '/ask 请输出示例', ...scene.body },
  }, { botId: '123', maxPassiveReplies: 5, sender: h.api })
  const run = () => dispatch(session, {
    contexts: h.factory, registry: h.registry, snapshot: h.snapshot, logger, commandPrefixes: ['/'],
  })
  const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
  return { ...h, chat, fetchMock, session, run, bodies }
}

describe('Agent 原生 Markdown 通过真实框架客户端投递', () => {
  it.each(scenes)('$name 默认发送 Markdown，保留格式和被动回复凭据', async scene => {
    const h = await delivery(scene)
    expect((await h.run()).errors).toEqual([])
    expect(h.bodies()).toEqual([{
      markdown: { content: markdown }, msg_id: 'm1', ...(scene.v2 ? { msg_type: 2, msg_seq: 2 } : {}),
    }])
    expect(String(h.fetchMock.mock.calls[0]?.[0]).endsWith(scene.path)).toBe(true)
    const request = vi.mocked(h.llm.chat).mock.calls[0]![0]
    const system = request.messages.find(message => message.role === 'system')?.content
    expect(system).not.toContain('纯文本')
    expect(system).not.toContain('不要用 Markdown')
    expect(system).toContain('不要输出思考过程')
    expect((await h.agent.history(20)).find(row => row.role === 'assistant')?.content).toBe(markdown)
  })

  it.each(scenes)('$name 的 MD 权限被拒绝时用原文回退文本，并保留同一凭据', async scene => {
    const h = await delivery(scene)
    h.fetchMock.mockResolvedValueOnce(Response.json({ code: 50056, message: 'denied' }, { status: 403 }))
    expect((await h.run()).errors).toEqual([])
    expect(h.bodies()).toEqual([
      { markdown: { content: markdown }, msg_id: 'm1', ...(scene.v2 ? { msg_type: 2, msg_seq: 2 } : {}) },
      { content: markdown, msg_id: 'm1', ...(scene.v2 ? { msg_type: 0, msg_seq: 2 } : {}) },
    ])
    expect(h.sendMessage).toHaveBeenCalledOnce()
  })

  it('session 回复通道遇到旧接口的 MD 拒绝提示也回退文本', async () => {
    const h = await delivery()
    h.fetchMock.mockResolvedValueOnce(Response.json({ message: '不允许发送原生 markdown' }, { status: 400 }))
    expect(await replyFromSession(h.session)(markdown)).toBe(true)
    expect(h.bodies()).toEqual([
      { markdown: { content: markdown }, msg_type: 2, msg_id: 'm1', msg_seq: 1 },
      { content: markdown, msg_type: 0, msg_id: 'm1', msg_seq: 1 },
    ])
  })

  it.each([
    { name: '普通权限拒绝', errors: [{ code: 11253, message: 'forbidden' }], count: 1 },
    { name: 'MD 回退也被拒绝', errors: [{ code: 50056, message: 'denied' }, { code: 50056, message: 'denied' }], count: 2 },
  ])('$name 后停止发送，避免重复回复或改成主动消息', async ({ errors, count }) => {
    const h = await delivery()
    for (const error of errors) h.fetchMock.mockResolvedValueOnce(Response.json(error, { status: 403 }))
    expect(await replyFromSession(h.session)(markdown)).toBe(false)
    expect(h.fetchMock).toHaveBeenCalledTimes(count)
    expect(h.bodies().every(body => body.msg_id === 'm1' && body.msg_seq === 1)).toBe(true)
  })
})
