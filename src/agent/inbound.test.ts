import { describe, expect, it } from 'vitest'
import type { Session } from '@qqbot/sdk'
import { conversationKey, toInboundMessage } from './inbound.js'

/**
 * 会话键与「按成员隔离」（对标 AstrBot 的 `unique_session`）。
 *
 * 隔离开关改变的是**会话粒度**：关闭时一群一会话，打开时一人一会话。
 * 这个键决定 DO 实例、历史、人格绑定、定时任务归属，改错会串数据。
 */

function session(overrides: Partial<Session> = {}): Session {
  return {
    scene: 'group',
    targetId: 'group-openid',
    userId: 'openid-a',
    userName: '小明',
    content: '你好',
    displayContent: '你好',
    attachments: [],
    mentions: [],
    atMe: true,
    isGroupAdmin: false,
    ...overrides,
  } as unknown as Session
}

describe('conversationKey：默认行为（不隔离）', () => {
  it('群聊按群 —— 整个群共享一段历史', () => {
    expect(conversationKey(session())).toBe('group:group-openid')
  })

  it('同一群的两个人得到**同一个**键（共享上下文）', () => {
    const a = conversationKey(session({ userId: 'openid-a' }))
    const b = conversationKey(session({ userId: 'openid-b' }))
    expect(a).toBe(b)
  })

  it('单聊按用户', () => {
    expect(conversationKey(session({ scene: 'c2c', targetId: 'user-openid' }))).toBe(
      'c2c:user-openid',
    )
  })

  it('频道按频道，频道私信按用户', () => {
    expect(conversationKey(session({ scene: 'guild', targetId: 'channel-1' }))).toBe(
      'guild:channel-1',
    )
    expect(conversationKey(session({ scene: 'guild_dm', targetId: 'user-1' }))).toBe(
      'guild_dm:user-1',
    )
  })
})

describe('conversationKey：按成员隔离', () => {
  it('同一群的两个人得到**不同**的键', () => {
    const a = conversationKey(session({ userId: 'openid-a' }), true)
    const b = conversationKey(session({ userId: 'openid-b' }), true)
    expect(a).toBe('group:group-openid:openid-a')
    expect(b).toBe('group:group-openid:openid-b')
    expect(a).not.toBe(b)
  })

  it('同一个人重复说话键稳定（不会每次都换 DO）', () => {
    const first = conversationKey(session({ userId: 'openid-a' }), true)
    const second = conversationKey(session({ userId: 'openid-a' }), true)
    expect(first).toBe(second)
  })

  it('不同群的同一个人仍是不同的键（群维度没丢）', () => {
    const g1 = conversationKey(session({ targetId: 'group-1', userId: 'u' }), true)
    const g2 = conversationKey(session({ targetId: 'group-2', userId: 'u' }), true)
    expect(g1).not.toBe(g2)
  })

  it('单聊不受影响（本来就一人一档）', () => {
    expect(conversationKey(session({ scene: 'c2c', targetId: 'user-openid' }), true)).toBe(
      'c2c:user-openid',
    )
  })

  it('频道受隔离影响（公开帖语义接近群）', () => {
    expect(conversationKey(session({ scene: 'guild', targetId: 'ch-1', userId: 'u1' }), true)).toBe(
      'guild:ch-1:u1',
    )
  })

  it('缺 userId 时退回不隔离（不能用空串拼出脏键）', () => {
    const key = conversationKey(session({ userId: '' }), true)
    expect(key).toBe('group:group-openid')
    expect(key).not.toContain('::')
  })
})

describe('toInboundMessage 带上隔离后的会话键', () => {
  it('默认不隔离', () => {
    expect(toInboundMessage(session()).conversation).toBe('group:group-openid')
  })

  it('传 true 时隔离', () => {
    expect(toInboundMessage(session(), true).conversation).toBe(
      'group:group-openid:openid-a',
    )
  })

  it('非会话字段不受影响', () => {
    const plain = toInboundMessage(session())
    const isolated = toInboundMessage(session(), true)
    expect(isolated.userId).toBe(plain.userId)
    expect(isolated.userName).toBe(plain.userName)
    expect(isolated.text).toBe(plain.text)
    expect(isolated.scene).toBe(plain.scene)
    expect(isolated.targetId).toBe(plain.targetId)
  })
})
