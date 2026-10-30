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
      decideWake(session({ atMe: false, content: '!你好' }), config({ wake_prefix: '!' })),
    ).toMatchObject({ wake: true, reason: 'prefix', text: '你好' })
  })

  /**
   * 回归：`command_prefixes` 与 `wake_prefix` 默认都是 `/`。
   * 上一版把两者拼进同一个列表 → 任何 `/xxx` 既被判成「指令」又被判成「唤醒」。
   * 现在 `command_prefixes` 只用于排除。
   */
  /**
   * 指令路由**不归 wake 层管**（2026-10 重构）。
   *
   * 指令前缀是宿主框架的职责：命令默认 `block: true`，命中后同一事件不会再分发给
   * events，所以「是指令」与「进模型」天然互斥。插件在这里再排除一遍会造成
   * 两个真相：唤醒前缀与指令前缀默认都是 `/` 时，`/agent` 既不算唤醒也进不了模型；
   * 把唤醒前缀改成多字符（如 `bot`）后更会直接失效。
   */
  it('/agent 这类指令以唤醒前缀开头时，wake 层按唤醒处理（拦截交给宿主的 block）', () => {
    const cfg = config({ wake_prefix: '/' })
    expect(decideWake(session({ content: '/agent status', atMe: false }), cfg)).toMatchObject({
      wake: true, reason: 'prefix',
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
      decideWake(session({ content: '/你好', atMe: false }), config({ wake_prefix: '' })),
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
        config({ friend_needs_wake_prefix: true, wake_prefix: '!' }),
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
  // 注意：以唤醒前缀（默认 `/`）开头的消息**会**唤醒——指令的拦截由宿主 block 负责，
  // 这里只验证「既没 @ 也没前缀」的普通聊天不唤醒
  const contents = ['你好', '今天吃啥', '哈哈哈哈', '?', '在吗在吗', '这个怎么弄', '111', '我同意']

  it.each(contents)('内容 %s 不唤醒', (content) => {
    expect(decideWake(session({ content, atMe: false }), config()).wake).toBe(false)
  })

  it('同一批内容，只要 @ 了机器人就唤醒', () => {
    for (const content of contents) {
      expect(decideWake(session({ content, atMe: true }), config()).wake).toBe(true)
    }
  })
})

/**
 * 回归：`/skill <id> <任务>` 必须能进模型。
 *
 * 这是一个**曾经真实存在的死路**：技能激活的长相是 `/skill …`，
 * 而 `command_prefixes` 默认就是 `/`，于是它先被「指令前缀」判定拦下，
 * `runLoopOnce` 里的 `parseSkillCommand` 永远收不到它 —— 技能功能整个不存在，
 * 而且不报任何错。
 *
 * 这些用例锁住「技能激活优先于指令前缀」这个顺序。
 */
describe('技能激活必须先于指令前缀判定', () => {
  it('群里带 /skill 前缀也能唤醒（否则技能永远触发不到）', () => {
    const decision = decideWake(session({ content: '/skill report 写周报', atMe: false }), config())
    expect(decision.wake).toBe(true)
    expect(decision.wake && decision.reason).toBe('skill')
  })

  it('单聊里同样能唤醒', () => {
    const decision = decideWake(session({ content: '/skill report 写周报', scene: 'c2c' }), config())
    expect(decision.wake).toBe(true)
    expect(decision.wake && decision.reason).toBe('skill')
  })

  it('正文原样保留 /skill 开头（解析层靠它匹配）', () => {
    const decision = decideWake(session({ content: '/skill report 写周报' }), config())
    expect(decision.wake && decision.text).toBe('/skill report 写周报')
  })

  it('光一个 /skill 不当作激活（按普通唤醒前缀处理）', () => {
    const decision = decideWake(session({ content: '/skill' }), config())
    expect(decision.wake).toBe(true)
    expect(decision.wake && decision.reason).toBe('prefix')
  })

  it('/skillx 之类不是技能激活，按普通唤醒前缀处理', () => {
    const decision = decideWake(session({ content: '/skillx foo' }), config())
    expect(decision.wake).toBe(true)
    expect(decision.wake && decision.reason).toBe('prefix')
  })

  it('其他 /agent 指令在 wake 层仍算唤醒（实际拦截由宿主命令 block 完成）', () => {
    for (const content of ['/agent status', '/agent reset', '/agent skill']) {
      // @ 了机器人时 reason 是 at、否则是 prefix，两者都算唤醒——
      // 关键是 wake 层不再把指令前缀当成「不唤醒」
      expect(decideWake(session({ content, atMe: true }), config()).wake).toBe(true)
      expect(decideWake(session({ content, atMe: false }), config()).wake).toBe(true)
    }
  })
})

/**
 * 指令前缀不再由插件排除（2026-10 重构）。
 *
 * 指令前缀是**宿主管的**：框架的 commands 匹配器负责，命令默认 `block: true`，
 * 命中后同一事件不会再分发到 events。插件再判断一遍会造成两个真相——
 * 唤醒前缀与指令前缀默认都是 `/` 时，`/agent` 既不算唤醒也进不了模型；
 * 把唤醒前缀改成多字符（如 `bot`）后更会直接失效。
 */
describe('唤醒层不负责指令路由', () => {
  it('唤醒前缀改成多字符后仍然能唤醒', () => {
    const decision = decideWake(session({ content: 'bot 你好' }), config({ wake_prefix: 'bot' }))
    expect(decision.wake).toBe(true)
    expect(decision.wake && decision.text).toBe('你好')
  })

  it('不再提供 command_prefixes 这个配置项', () => {
    // 配置里存在但默认为空 = 跟随唤醒前缀；页面也不再暴露输入框
    expect('command_prefixes' in defaultConfig).toBe(false)
  })
})
