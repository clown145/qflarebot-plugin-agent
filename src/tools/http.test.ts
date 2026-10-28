import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginDB } from '@qqbot/sdk'
import { createHttpTool } from './http.js'
import { createWebTool } from './web.js'
import { createTimeTool } from './time.js'
import type { ToolExecutionContext } from './types.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function context(input: unknown, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    db: {} as PluginDB,
    logger,
    conversationId: 'group:g1',
    actorId: 'u1',
    actorRole: 'admin',
    scene: 'group',
    targetId: 'g1',
    runId: 'r1',
    stepId: 's1',
    toolCallId: 'c1',
    input,
    timezone: 'Asia/Shanghai',
    ...overrides,
  }
}

describe('http.request 的 SSRF 防护', () => {
  const http = createHttpTool()

  const blocked = [
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'file:///etc/passwd',
  ]

  it.each(blocked)('拒绝内网/非法地址：%s', async (url) => {
    const result = await http.execute(context({ url }))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('blocked_url')
  })

  it('缺少 url 时返回 bad_request', async () => {
    const result = await http.execute(context({}))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
  })

  it('重定向到内网时也被拦——不能只校验初始地址', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
      ),
    )
    try {
      const result = await http.execute(context({ url: 'https://example.com/start' }))
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('blocked_url')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('正常请求返回状态码与响应体', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ),
    )
    try {
      const result = await http.execute(context({ url: 'https://example.com/' }))
      expect(result.status).toBe('success')
      const output = result.output as { status: number; body: string }
      expect(output.status).toBe(200)
      expect(output.body).toBe('hello')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('重定向次数超限时返回 too_many_redirects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('', { status: 302, headers: { location: 'https://example.com/next' } }),
      ),
    )
    try {
      const result = await http.execute(context({ url: 'https://example.com/' }))
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('too_many_redirects')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('web.fetch_page', () => {
  const web = createWebTool()

  it('拒绝内网地址', async () => {
    const result = await web.execute(context({ url: 'http://127.0.0.1/' }))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('blocked_url')
  })

  it('抓 HTML 时抽出正文并去掉脚本样式', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<html><head><title>标题</title><style>body{}</style></head>' +
              '<body><script>alert(1)</script><p>正文内容</p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html' } },
          ),
      ),
    )
    try {
      const result = await web.execute(context({ url: 'https://example.com/' }))
      expect(result.status).toBe('success')
      const output = result.output as { title?: string; text: string }
      expect(output.title).toBe('标题')
      expect(output.text).toContain('正文内容')
      expect(output.text).not.toContain('alert(1)')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('非 HTML 内容原样返回（JSON 接口常见）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    try {
      const result = await web.execute(context({ url: 'https://example.com/api' }))
      expect(result.status).toBe('success')
      expect((result.output as { text: string }).text).toBe('{"ok":true}')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('HTTP 错误码转成 failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    try {
      const result = await web.execute(context({ url: 'https://example.com/missing' }))
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('http_error')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('time.now', () => {
  const time = createTimeTool()

  it('返回配置时区的时间与星期', async () => {
    const result = await time.execute(context({}, { timezone: 'Asia/Shanghai' }))
    expect(result.status).toBe('success')
    const output = result.output as { timeZone: string; iso: string; weekday: string }
    expect(output.timeZone).toBe('Asia/Shanghai')
    expect(output.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(output.weekday).toBeTruthy()
  })

  it('时区非法时退回 UTC 并说明，而不是崩掉', async () => {
    const result = await time.execute(context({}, { timezone: 'Not/AZone' }))
    expect(result.status).toBe('success')
    const output = result.output as { timeZone: string; note?: string }
    expect(output.timeZone).toBe('UTC')
    expect(output.note).toContain('无效')
  })
})
