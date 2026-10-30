import { describe, expect, it } from 'vitest'
import { withMention } from './mention.js'

/**
 * 回复时 @ 说话人。
 *
 * QQ 官方接口没有独立的「@某人」字段 —— 就是在正文里写 `<@openid>`，
 * 平台渲染成真正的 @ 提醒。这里测的是**什么时候该加**、加得对不对。
 */

describe('withMention：不该加的情况', () => {
  it('配置关时不加', () => {
    expect(withMention('你好', 'u1', 'group', 'off')).toBe('你好')
  })

  it('配置未设置时不加（老配置没这个字段）', () => {
    expect(withMention('你好', 'u1', 'group', undefined)).toBe('你好')
  })

  it('没有 userId 时不加（拿不到 openid 就没法 @）', () => {
    expect(withMention('你好', '', 'group', 'always')).toBe('你好')
    expect(withMention('你好', undefined, 'group', 'always')).toBe('你好')
  })

  it('「仅群聊」模式下，单聊不加', () => {
    expect(withMention('你好', 'u1', 'c2c', 'group')).toBe('你好')
  })

  it('「仅群聊」模式下，频道私信不加（和单聊同一档）', () => {
    expect(withMention('你好', 'u1', 'guild_dm', 'group')).toBe('你好')
  })
})

describe('withMention：该加的情况', () => {
  it('群聊 + 仅群聊模式 → 加', () => {
    expect(withMention('你好', 'u1', 'group', 'group')).toBe('<@u1> 你好')
  })

  it('频道 + 仅群聊模式 → 加', () => {
    expect(withMention('你好', 'u1', 'guild', 'group')).toBe('<@u1> 你好')
  })

  it('总是模式：单聊也加', () => {
    expect(withMention('你好', 'u1', 'c2c', 'always')).toBe('<@u1> 你好')
  })

  it('@ 在正文最前面，正文完整保留', () => {
    const out = withMention('这是很长的一段回答，包含标点和换行。', 'abc', 'group', 'group')
    expect(out).toBe('<@abc> 这是很长的一段回答，包含标点和换行。')
  })
})

describe('withMention：边界', () => {
  it('正文已经以同一个 @ 开头时不重复加', () => {
    // 模型偶尔会自己写出 <@openid>
    expect(withMention('<@u1> 你好', 'u1', 'group', 'group')).toBe('<@u1> 你好')
  })

  it('@ 的是不同的人时仍然加（不是同一个前缀）', () => {
    expect(withMention('<@u2> 你好', 'u1', 'group', 'group')).toBe('<@u1> <@u2> 你好')
  })

  it('空正文也能加（只有 @ 没有内容）', () => {
    expect(withMention('', 'u1', 'group', 'group')).toBe('<@u1> ')
  })

  it('不修改入参（纯函数）', () => {
    const text = '你好'
    withMention(text, 'u1', 'group', 'group')
    expect(text).toBe('你好')
  })
})
