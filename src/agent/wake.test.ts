import { describe, expect, it } from 'vitest'
import type { Session } from '@qqbot/sdk'
import { decideWake } from './wake.js'
import { defaultConfig, type AgentConfig } from '../config/index.js'

/**
 * 唤醒判定。**这一组必须能复现真实踩过的刷屏 bug**：
 *
 * 选了「@/前缀/引用机器人」之后，群里所有消息都被 AI 回复。根因两个：
 * (a) `command_prefixes` 被拼进了唤醒前缀列表，两者默认都是 `/`，
 *     于是任何以 `/` 开头的消息既被排除又被唤醒；
 * (b) 「有引用就唤醒」退化成「别人互相引用也唤醒」。
 * 现在两者都去掉：群聊只认「@机器人」与「唤醒前缀」。
 */

function session(overrides: Partial<Session> = {}): Session {
  return {
    botId: 'BOT', botName: '机器人', botAvatar: '', platform: 'qq',
    event: 'qq.group.message', rawType: 'GROUP_MESSAGE_CREATE', id: 'e1', timestamp: '',
    raw: {}, scene: 'group', targetId: 'G1', userId: 'U1', userName: '小明',
    avatarUrl: '', memberRole: 'member', isBotAdmin: false, messageId: 'm1',
    refIndex: undefined, quote: undefined, canReply: true,
    content: '你好', displayContent: '你好', mentions: [], atMe: false,
    attachments: [], interaction: undefined,
    ...overrides,
  } as unknown as Session
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...defaultConfig, ...overrides }
}

describe('群聊：只认 @机器人 与 唤醒前缀', () => {
  it('@ 了机器人 → 唤醒', () => {
    expect(decideWake(session({ atMe: true, content: '你好' }), config())).toMatchObject({
      wake: true, reason: 'at', text: '你好',
    })
  })

  it('没 @ / 没前缀的普通群消息 → 不唤醒（刷屏 bug 的核心）', () => {
    expect(decideWake(session({ atMe: false, content: '今天吃啥' }), config())).toMatchObject({
      wake: false, reason: 'not-mentioned',
    })
  })

  it('以唤醒前缀开头 → 唤醒并剥掉前缀', () => {
    expect(
      decideWake(session({ atMe: false, content: '!你好' }), config({ wake_prefix: '!', command_prefixes: '#' })),
    ).toMatchObject({ wake: true, reason: 'prefix', text: '你好' })
  })

  /**
   * 回归：`command_prefixes` 与 `wake_prefix` 默认都是 `/`。
   * 上一版把两者拼进同一个列表 → 任何 `/xxx` 既被判成「指令」又被判成「唤醒」。
   * 现在 `command_prefixes` 只用于排除。
   */
  it('指令前缀的消息交给指令路径，不当作聊天（哪怕它同时是唤醒前缀）', () => {
    const cfg = config({ wake_prefix: '/', command_prefixes: '/' })
    expect(decideWake(session({ content: '/agent status', atMe: false }), cfg)).toMatchObject({
      wake: false, reason: 'command',
    })
    expect(decideWake(session({ content: '/agent status', atMe: true }), cfg)).toMatchObject({
      wake: false, reason: 'command',
    })
  })

  /**
   * 回归：「引用消息就唤醒」已删除。
   * AstrBot 的语义是「引用了机器人自己的消息」，而 QFlareBot 的 `session.quote`
   * 不带被引用消息的发送者，精确判断做不到。退化成「有引用就唤醒」会让机器人
   * 在两个人互相引用聊天时插嘴。
   */
  it('引用别人的消息不唤醒（无法判断引用的是谁，宁可不理）', () => {
    const quoted = session({
      atMe: false, content: '我同意',
      quote: { messageId: 'q1', content: '别人说的话', attachments: [], refIndex: 'REFIDX_1' },
    })
    expect(decideWake(quoted, config())).toMatchObject({ wake: false, reason: 'not-mentioned' })
  })

  it('引用消息 + @机器人 → 仍然唤醒（@ 才是决定性的）', () => {
    const quoted = session({
      atMe: true, content: '我同意',
      quote: { messageId: 'q1', content: 'x', attachments: [], refIndex: 'REFIDX_1' },
    })
    expect(decideWake(quoted, config())).toMatchObject({ wake: true, reason: 'at' })
  })

  it('没有 @ 也没有前缀时，附件消息也不唤醒', () => {
    expect(
      decideWake(session({ atMe: false, content: '', attachments: [{ url: 'https://x/a.png' }] }), config()),
    ).toMatchObject({ wake: false, reason: 'not-mentioned' })
  })
})

describe('群聊：唤醒前缀可自定义', () => {
  it('多字符前缀', () => {
    expect(decideWake(session({ content: 'bot 你好' }), config({ wake_prefix: 'bot' }))).toMatchObject({
      wake: true, reason: 'prefix', text: '你好',
    })
  })

  it('前缀为空时不把任何消息当前缀唤醒', () => {
    expect(
      decideWake(session({ content: '/你好', atMe: false }), config({ wake_prefix: '', command_prefixes: '#' })),
    ).toMatchObject({ wake: false, reason: 'not-mentioned' })
  })
})

describe('单聊', () => {
  it('默认任何消息都唤醒', () => {
    expect(decideWake(session({ scene: 'c2c', event: 'qq.c2c.message', content: '在吗' }), config())).toMatchObject({
      wake: true, reason: 'private', text: '在吗',
    })
  })

  it('开了 friend_needs_wake_prefix 后，不带前缀不唤醒', () => {
    expect(
      decideWake(session({ scene: 'c2c', event: 'qq.c2c.message', content: '在吗' }), config({ friend_needs_wake_prefix: true })),
    ).toMatchObject({ wake: false, reason: 'not-woken' })
  })

  it('开了之后带前缀则唤醒并剥前缀', () => {
    expect(
      decideWake(
        session({ scene: 'c2c', event: 'qq.c2c.message', content: '!在吗' }),
        config({ friend_needs_wake_prefix: true, wake_prefix: '!', command_prefixes: '#' }),
      ),
    ).toMatchObject({ wake: true, reason: 'prefix', text: '在吗' })
  })
})

describe('不该唤醒的情况', () => {
  it('机器人自己发的消息', () => {
    expect(decideWake(session({ userId: 'BOT' }), config())).toMatchObject({ wake: false, reason: 'bot-self' })
  })

  it('空消息', () => {
    expect(decideWake(session({ content: '   ', attachments: [] }), config())).toMatchObject({
      wake: false, reason: 'empty',
    })
  })
})

/**
 * 守卫：**群聊里未 @、未带前缀的消息一条都不该唤醒**。
 * 上一次就是这一类消息全部进了 AI。用真实 Session 形状扫一批典型内容。
 */
describe('守卫：群聊未 @ 未带前缀的消息全都不唤醒', () => {
  const contents = ['你好', '今天吃啥', '哈哈哈哈', '?', '在吗在吗', '这个怎么弄', '111', '/agent status', '/unknown', '我同意']

  it.each(contents)('内容 %s 不唤醒', (content) => {
    expect(decideWake(session({ content, atMe: false }), config()).wake).toBe(false)
  })

  it('同一批内容，只要 @ 了机器人就唤醒（带指令前缀的除外）', () => {
    for (const content of contents) {
      const decision = decideWake(session({ content, atMe: true }), config())
      if (content.startsWith('/')) expect(decision.wake).toBe(false)
      else expect(decision.wake).toBe(true)
    }
  })
})
