import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebTool } from './web.js'
import type { ToolExecutionContext } from './types.js'

/**
 * web.fetch_page。
 *
 * 重点覆盖本轮新增的「图片识别」：之前它会把 PNG 的原始字节当文本读进 text 字段，
 * 既浪费 token 又毫无意义；现在应该作为媒体带出去、由回复通道发给用户。
 */

function context(input: unknown): ToolExecutionContext {
  return {
    db: {} as ToolExecutionContext['db'],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    conversationId: 'group:g1',
    actorId: 'u1',
    actorRole: 'member',
    scene: 'group',
    targetId: 'g1',
    runId: 'r1',
    stepId: 's1',
    toolCallId: 'c1',
    input,
    timezone: 'Asia/Shanghai',
  }
}

function stubFetch(contentType: string, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web.fetch_page', () => {
  it('HTML 页面抽取正文', async () => {
    stubFetch('text/html; charset=utf-8', '<html><head><title>标题</title></head><body><p>正文内容</p></body></html>')
    const result = await createWebTool().execute(context({ url: 'https://example.com/a' }))
    expect(result.status).toBe('success')
    expect(JSON.stringify(result.output)).toContain('正文内容')
  })

  it('JSON 接口直接返回原文', async () => {
    stubFetch('application/json', '{"ok":true}')
    const result = await createWebTool().execute(context({ url: 'https://example.com/api' }))
    expect(result.status).toBe('success')
    // JSON.stringify 会把引号转义，所以直接断言 text 字段
    expect((result.output as { text?: string }).text).toBe('{"ok":true}')
  })

  it('图片不当作文本读，而是作为媒体带出去', async () => {
    stubFetch('image/png', 'PNG_BINARY_GARBAGE')
    const result = await createWebTool().execute(context({ url: 'https://example.com/a.png' }))

    expect(result.status).toBe('success')
    // 关键：outbound 里有这张图，回复通道会直接发给用户
    expect(result.outbound).toEqual({ type: 'image', url: 'https://example.com/a.png' })
    // 不应把二进制塞进 text
    expect(JSON.stringify(result.output)).not.toContain('PNG_BINARY_GARBAGE')
  })

  it.each(['image/jpeg', 'image/gif', 'image/webp'])('%s 也被识别为图片', async (type) => {
    stubFetch(type, 'BINARY')
    const result = await createWebTool().execute(context({ url: 'https://example.com/x' }))
    expect(result.outbound?.type).toBe('image')
  })

  it('非 http(s) 地址被拒绝', async () => {
    const result = await createWebTool().execute(context({ url: 'file:///etc/passwd' }))
    expect(result.status).toBe('failed')
  })

  it('缺少 url 返回可读错误', async () => {
    const result = await createWebTool().execute(context({}))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBeTruthy()
  })
})
