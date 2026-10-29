import { describe, expect, it } from 'vitest'
import type { Session } from '@qqbot/sdk'
import { decideWake } from './wake.js'
import { defaultConfig, type AgentConfig } from '../config/index.js'

/**
 * 唤醒判定（对标 AstrBot 的 WakingCheckStage）。
 *
 * 这一组覆盖本次最核心的行为改动：「没命中指令的消息就该触发 Agent」。
 */

function session(overrides: Partial<Session> = {}): Session {
  return {
    botId: 'BOT',
    botName: '机器人',
    botAvatar: '',
    platform: 'qq',
    event: 'qq.group.at_message',
    rawType: 'GROUP_AT_MESSAGE_CREATE',
    id: 'e1',
    timestamp: '',
    raw: {},
    scene: 'group',
    targetId: 'G1',
    userId: 'U1',
    userName: '小明',
    avatarUrl: '',
    memberRole: 'member',
    isBotAdmin: false,
    messageId: 'm1',
    refIndex: undefined,
    quote: undefined,
    canReply: true,
    content: '你好',
    displayContent: '你好',
    mentions: [],
    atMe: true,
    attachments: [],
    interaction: undefined,
    reply: async () => ({ ok: true, status: 200, raw: null }),
    send: async () => ({ ok: true, status: 200, raw: null }),
    typing: async () => ({ ok: true, status: 200, raw: null }),
    stream: () => {
      throw new Error('not used')
    },
    recall: async () => true,
    ...overrides,
  } as unknown as Session
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultConfig, ...overrides }
}

describe('decideWake：群聊', () => {
  it('@ 了机器人就唤醒（默认 at 模式）', () => {
    const decision = decideWake(session({ atMe: true, content: '你好' }), config())
    expect(decision).toMatchObject({ wake: true, reason: 'at', text: '你好' })
  })

  it('没 @ 就不唤醒（at 模式）——群全量消息里绝大多数是这种', () => {
    const decision = decideWake(session({ atMe: false, event: 'qq.group.message' }), config())
    expect(decision).toMatchObject({ wake: false, reason: 'not-mentioned' })
  })

  it('all 模式下群里所有消息都唤醒', () => {
    const decision = decideWake(
      session({ atMe: false, event: 'qq.group.message' }),
      config({ wake_mode: 'all' }),
    )
    expect(decision).toMatchObject({ wake: true, reason: 'all' })
  })

  it('at_or_prefix：以前缀开头的消息唤醒，并剥掉前缀', () => {
    const decision = decideWake(
      session({ atMe: false, event: 'qq.group.message', content: '/你好' }),
      config({ wake_mode: 'at_or_prefix', wake_prefix: '/' }),
    )
    // 先被 command_prefixes 拦下（默认也是 /）——这正是「带前缀交给指令」的语义
    expect(decision).toMatchObject({ wake: false, reason: 'command' })
  })

  it('at_or_prefix：自定义唤醒前缀与指令前缀不冲突时正常唤醒', () => {
    const decision = decideWake(
      session({ atMe: false, event: 'qq.group.message', content: '#你好' }),
      config({ wake_mode: 'at_or_prefix', wake_prefix: '#', command_prefixes: '/' }),
    )
    expect(decision).toMatchObject({ wake: true, reason: 'prefix', text: '你好' })
  })

  it('at_or_prefix：引用消息也算明确意图', () => {
    const decision = decideWake(
      session({
        atMe: false,
        event: 'qq.group.message',
        quote: { messageId: 'q1', content: '原文', attachments: [], refIndex: 'REFIDX_1' },
      }),
      config({ wake_mode: 'at_or_prefix' }),
    )
    expect(decision).toMatchObject({ wake: true, reason: 'reply' })
  })
})

describe('decideWake：单聊', () => {
  it('默认私聊任何消息都唤醒', () => {
    const decision = decideWake(
      session({ scene: 'c2c', event: 'qq.c2c.message', atMe: true }),
      config(),
    )
    expect(decision).toMatchObject({ wake: true, reason: 'private', text: '你好' })
  })

  it('开了 friend_needs_wake_prefix 后，不带前缀就不唤醒', () => {
    const decision = decideWake(
      session({ scene: 'c2c', event: 'qq.c2c.message' }),
      config({ friend_needs_wake_prefix: true }),
    )
    expect(decision).toMatchObject({ wake: false, reason: 'not-woken' })
  })

  it('开了 friend_needs_wake_prefix 后，带前缀唤醒并剥前缀', () => {
    const decision = decideWake(
      session({ scene: 'c2c', event: 'qq.c2c.message', content: '#你好' }),
      config({ friend_needs_wake_prefix: true, wake_prefix: '#', command_prefixes: '/' }),
    )
    expect(decision).toMatchObject({ wake: true, reason: 'prefix', text: '你好' })
  })
})

describe('decideWake：不该唤醒的情况', () => {
  it('机器人自己发的消息不唤醒（避免自问自答）', () => {
    const decision = decideWake(session({ userId: 'BOT' }), config())
    expect(decision).toMatchObject({ wake: false, reason: 'bot-self' })
  })

  it('空消息（正文与附件都没有）不唤醒', () => {
    const decision = decideWake(session({ content: '   ', attachments: [] }), config())
    expect(decision).toMatchObject({ wake: false, reason: 'empty' })
  })

  it('指令前缀的消息交给指令路径，不当作聊天', () => {
    const decision = decideWake(session({ content: '/agent status' }), config())
    expect(decision).toMatchObject({ wake: false, reason: 'command' })
  })

  it('没命中指令但带前缀的未知命令，也不该发给模型', () => {
    const decision = decideWake(session({ content: '/unknowncmd 随便说点什么' }), config())
    expect(decision).toMatchObject({ wake: false, reason: 'command' })
  })

  it('只有图片没有正文时照样唤醒', () => {
    const decision = decideWake(
      session({ content: '', attachments: [{ url: 'https://x/a.png', contentType: 'image/png' }] }),
      config(),
    )
    expect(decision).toMatchObject({ wake: true, reason: 'at' })
  })
})
