import { describe, expect, it } from 'vitest'
import { BLOCKED_REPLY, checkContent, parseKeywords } from './safety.js'

describe('parseKeywords', () => {
  it('按中英文逗号切分', () => {
    expect(parseKeywords('赌博,色情，暴力')).toEqual(['赌博', '色情', '暴力'])
  })

  it('去掉空白项', () => {
    expect(parseKeywords(' a , , b ')).toEqual(['a', 'b'])
  })

  it('空配置返回空数组（功能关闭）', () => {
    expect(parseKeywords('')).toEqual([])
    expect(parseKeywords(undefined)).toEqual([])
  })
})

describe('checkContent', () => {
  it('没配关键词时一律放行', () => {
    expect(checkContent('任何内容', []).blocked).toBe(false)
  })

  it('命中关键词时拒绝并返回命中的词', () => {
    const result = checkContent('我来教你赌博吧', ['赌博'])
    expect(result.blocked).toBe(true)
    expect(result.matched).toBe('赌博')
  })

  it('没命中时放行', () => {
    expect(checkContent('今天天气不错', ['赌博', '暴力']).blocked).toBe(false)
  })

  it('英文关键词大小写不敏感', () => {
    expect(checkContent('this is PORN', ['porn']).blocked).toBe(true)
    expect(checkContent('this is porn', ['PORN']).blocked).toBe(true)
  })

  it('空文本放行', () => {
    expect(checkContent('', ['赌博']).blocked).toBe(false)
  })

  it('多个关键词里命中任一即拒绝', () => {
    expect(checkContent('暴力内容', ['赌博', '暴力']).blocked).toBe(true)
  })

  it('子串匹配（中文不分词也能命中）', () => {
    expect(checkContent('我们要抵制网络赌博行为', ['赌博']).blocked).toBe(true)
  })

  it('提示文案不暴露命中的关键词', () => {
    // 暴露关键词等于把过滤规则交给用户去试探
    expect(BLOCKED_REPLY).not.toContain('赌博')
  })
})
