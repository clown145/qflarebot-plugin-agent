import { buildSession, dispatch } from '@qqbot/runtime/testing'
import { definePlugin } from '@qqbot/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { LLMChatRequest } from '../../src/llm/contract.js'
import { harness, logger, result, setupIntegrationTests } from './harness.js'

setupIntegrationTests()

const quotedAll = {
  message_type: 103,
  msg_elements: [{ content: '<@everyone> 集合', msg_idx: 'REFIDX_q' }],
}
const otherBot = [{ id: 'ABC', is_you: false, bot: true }]
const self = [{ id: 'ABC', is_you: true }]
type RoutingCase = { name: string; body: Record<string, unknown>; rawType?: string }

async function route({ body, rawType = 'GROUP_MESSAGE_CREATE' }: RoutingCase) {
  const chat = vi.fn(async (_request: LLMChatRequest) => result())
  const command = vi.fn(() => '命令完成')
  const h = await harness(chat, [definePlugin({ name: 'command', commands: { echo: command } })])
  const submit = vi.spyOn(h.agent, 'submit')
  const session = buildSession({
    op: 0,
    t: rawType,
    d: { id: 'm1', group_openid: 'g1', author: { member_openid: 'u1' }, ...body },
  }, { botId: '123', maxPassiveReplies: 5, sender: h.api })
  const report = await dispatch(session, {
    contexts: h.factory,
    registry: h.registry,
    snapshot: h.snapshot,
    logger,
    commandPrefixes: ['/'],
  })
  expect(report.errors).toEqual([])
  return { ...h, chat, command, submit, session, report }
}

describe('消息收件人与引用通过真实框架分发到 Agent', () => {
  const ignored: RoutingCase[] = [
    ...['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].flatMap(rawType => [
      { name: '全体艾特后接命令', body: { content: '/echo hi', mentions: [{ scope: 'all', is_you: true }] } },
      { name: '全体艾特后接唤醒前缀', body: { content: '/你好', mentions: [{ scope: 'all', is_you: true }] } },
      { name: '全体艾特后接聊天', body: { content: '大家好', mentions: [{ scope: 'all', is_you: true }] } },
      { name: '全体标记', body: { content: '<@everyone> 大家好' } },
      { name: '引用全体后仅说收到', body: { ...quotedAll, content: '收到' } },
      { name: '引用类型没有附带原文', body: { content: '收到', message_type: 103 } },
      { name: '只有引用 ID', body: { content: '收到', message_reference: { message_id: 'quoted' } } },
      { name: '引用全体后提及其他机器人', body: { ...quotedAll, content: '你好 <@ABC>', mentions: otherBot } },
    ].map(test => ({ ...test, name: `${rawType}：${test.name}`, rawType }))),
    ...['<@ABC>', '<@!ABC>', '<qqbot-at-user id="ABC" />'].flatMap(tag => [
      { name: `${tag} 后接命令`, body: { content: `${tag}/echo hi`, mentions: otherBot } },
      { name: `${tag} 后接唤醒前缀`, body: { content: `${tag} /你好`, mentions: otherBot } },
      { name: `${tag} 后接技能调用`, body: { content: `${tag} /skill report 写周报`, mentions: otherBot } },
    ]),
    { name: '文字后提及其他机器人', body: { content: '你好 <@ABC> /echo hi', mentions: otherBot } },
    ...['<@everyone> /echo hi', '<@123> /你好', '<qqbot-at-user id="123" /> /你好'].map(content => ({
      name: `引用中的 ${content} 不唤醒`,
      body: { content: '同意', message_type: 103, msg_elements: [{ content, msg_idx: 'REFIDX_q' }] },
    })),
  ]

  it.each(ignored)('$name：不执行命令、不入队、不调用模型、不回复', async test => {
    const h = await route(test)
    expect(h.report.matched).toEqual([{ plugin: 'agent', kind: 'event', name: h.session.event }])
    expect(h.command).not.toHaveBeenCalled()
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.chat).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  const commands: RoutingCase[] = [
    { name: '明确艾特自己', body: { content: '<@ABC> /echo hi', mentions: self } },
    { name: '新格式艾特自己', body: { content: '<qqbot-at-user id="ABC" /> /echo hi', mentions: self } },
    { name: '命令后艾特群友', body: { content: '/echo <@DEF>', mentions: [{ id: 'DEF', bot: false }] } },
    { name: '命令后艾特别的机器人', body: { content: '/echo <@ABC>', mentions: otherBot } },
    { name: '命令后用新格式艾特群友', body: { content: '/echo <qqbot-at-user id="DEF" />', mentions: [{ id: 'DEF', bot: false }] } },
    {
      name: '专用事件已省略自身艾特，剩余开头艾特是参数', rawType: 'GROUP_AT_MESSAGE_CREATE',
      body: { content: '<@DEF> /echo hi', mentions: [{ id: 'DEF', bot: false, is_you: false }] },
    },
  ]

  it.each(commands)('$name：命令消费消息并成功回复', async test => {
    const h = await route(test)
    expect(h.command).toHaveBeenCalledTimes(1)
    expect(h.submit).not.toHaveBeenCalled()
    expect(h.chat).not.toHaveBeenCalled()
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(h.sendMessage.mock.calls[0]![1]).toBe('命令完成')
  })

  const chats: Array<RoutingCase & { text: string }> = [
    { name: '明确艾特自己', body: { content: '<@ABC> 你好', mentions: self }, text: '你好' },
    { name: '文字在自身艾特之前', body: { content: '你好 <@ABC> 帮我看看', mentions: self }, text: '你好  帮我看看' },
    { name: '文字在新格式自身艾特之前', body: { content: '你好 <qqbot-at-user id="ABC" /> 帮我看看', mentions: self }, text: '你好  帮我看看' },
    {
      name: '专用事件省略自身艾特', rawType: 'GROUP_AT_MESSAGE_CREATE',
      body: { content: '<qqbot-at-user id="DEF" /> /你好', mentions: [{ id: 'DEF', bot: false, is_you: false }] },
      text: '你好',
    },
    {
      name: '引用全体并在当前正文艾特自己', rawType: 'GROUP_AT_MESSAGE_CREATE',
      body: { ...quotedAll, content: '请问 <@ABC> 怎么办', mentions: self }, text: '请问  怎么办',
    },
    { name: '普通前缀唤醒', body: { content: '/你好' }, text: '你好' },
    ...['GROUP_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].map(rawType => ({
      name: `${rawType}：引用全体并在当前正文使用前缀`, rawType,
      body: { ...quotedAll, content: '/你好' }, text: '你好',
    })),
  ]

  it.each(chats)('$name：保留用户文字并成功回复', async test => {
    const h = await route(test)
    expect(h.command).not.toHaveBeenCalled()
    expect(h.submit).toHaveBeenCalledTimes(1)
    expect(h.chat).toHaveBeenCalledTimes(1)
    expect(h.chat.mock.calls[0]![0].messages.some(message =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes(test.text),
    )).toBe(true)
    expect(h.sendMessage).toHaveBeenCalled()
    expect(JSON.stringify(h.sendMessage.mock.calls)).toContain('完成')
  })
})
