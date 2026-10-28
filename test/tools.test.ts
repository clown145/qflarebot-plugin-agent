import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginDB } from '@qqbot/sdk'
import { createToolRegistry, stringifyToolResult } from '../src/tools/registry.js'
import type { RegisteredTool, ToolExecutionContext } from '../src/tools/registry.js'
import { createHttpTool } from '../src/tools/http.js'
import { createWebTool } from '../src/tools/web.js'
import { createTimeTool } from '../src/tools/time.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    db: {} as PluginDB,
    logger,
    conversation: 'group:g1',
    userId: 'u1',
    scene: 'group',
    targetId: 'g1',
    runId: 'r1',
    timezone: 'Asia/Shanghai',
    markReplied: () => {},
    ...overrides,
  }
}

function tool(name: string, overrides: Partial<RegisteredTool['definition']> = {}): RegisteredTool {
  return {
    definition: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      sideEffect: 'none',
      timeoutMs: 1000,
      ...overrides,
    },
    execute: async () => ({ status: 'success', output: 'ok' }),
  }
}

describe('createToolRegistry', () => {
  it('list / get / toModelTools 反映注册内容', () => {
    const registry = createToolRegistry([tool('a'), tool('b')])
    expect(registry.list()).toHaveLength(2)
    expect(registry.get('a')?.definition.name).toBe('a')
    expect(registry.toModelTools().map((t) => t.name)).toEqual(['a', 'b'])
  })

  it('requires 未满足的工具不会暴露给模型', () => {
    const registry = createToolRegistry(
      [tool('a'), tool('v', { requires: 'vfs' })],
      { enabled: new Set() },
    )
    expect(registry.list().map((t) => t.definition.name)).toEqual(['a'])
  })

  it('requires 满足时工具正常暴露', () => {
    const registry = createToolRegistry([tool('v', { requires: 'vfs' })], {
      enabled: new Set(['vfs'] as const),
    })
    expect(registry.list()).toHaveLength(1)
  })

  it('调用未知工具返回 failed，不抛异常', async () => {
    const registry = createToolRegistry([])
    const result = await registry.execute('nope', {}, context())
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('unknown_tool')
  })

  it('工具抛异常时被兜住，转成 failed 结果', async () => {
    const registry = createToolRegistry([
      {
        ...tool('boom'),
        execute: async () => {
          throw new Error('内部炸了')
        },
      },
    ])
    const result = await registry.execute('boom', {}, context())
    expect(result.status).toBe('failed')
    expect(result.error?.message).toContain('内部炸了')
  })

  it('工具超时被中断并返回 failed，不会挂住整个 loop', async () => {
    const registry = createToolRegistry([
      {
        ...tool('slow', { timeoutMs: 20 }),
        execute: async () => {
          await new Promise((r) => setTimeout(r, 200))
          return { status: 'success', output: 'never' }
        },
      },
    ])
    const result = await registry.execute('slow', {}, context())
    expect(result.status).toBe('failed')
    expect(result.error?.message).toContain('超时')
  })
})

describe('stringifyToolResult', () => {
  it('成功且输出是字符串时原样返回', () => {
    expect(stringifyToolResult({ status: 'success', output: 'hi' })).toBe('hi')
  })

  it('成功且输出是对象时序列化', () => {
    expect(stringifyToolResult({ status: 'success', output: { a: 1 } })).toBe('{"a":1}')
  })

  it('没有输出时返回 ok', () => {
    expect(stringifyToolResult({ status: 'success' })).toBe('ok')
  })

  it('失败时序列化错误结构，模型能读懂', () => {
    const text = stringifyToolResult({
      status: 'failed',
      error: { code: 'boom', message: '炸了', retryable: false },
    })
    const parsed = JSON.parse(text)
    expect(parsed.code).toBe('boom')
    expect(parsed.message).toBe('炸了')
  })
})

describe('http.request SSRF 防护', () => {
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

  for (const url of blocked) {
    it(`拒绝内网/非法地址：${url}`, async () => {
      const result = await http.execute({ url }, context())
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('blocked_url')
    })
  }

  it('缺少 url 时返回 bad_request', async () => {
    const result = await http.execute({}, context())
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
  })

  it('重定向到内网时也会被拦（不能只校验初始地址）', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/secret' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await http.execute({ url: 'https://example.com/start' }, context())
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('blocked_url')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('正常请求返回状态码与响应体', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })),
    )
    try {
      const result = await http.execute({ url: 'https://example.com/' }, context())
      expect(result.status).toBe('success')
      const output = result.output as { status: number; body: string }
      expect(output.status).toBe(200)
      expect(output.body).toBe('hello')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('web.fetch_page', () => {
  const web = createWebTool()

  it('拒绝内网地址', async () => {
    const result = await web.execute({ url: 'http://127.0.0.1/' }, context())
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
      const result = await web.execute({ url: 'https://example.com/' }, context())
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
          new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    )
    try {
      const result = await web.execute({ url: 'https://example.com/api' }, context())
      expect(result.status).toBe('success')
      expect((result.output as { text: string }).text).toBe('{"ok":true}')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('HTTP 错误码转成 failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    try {
      const result = await web.execute({ url: 'https://example.com/missing' }, context())
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
    const result = await time.execute({}, context({ timezone: 'Asia/Shanghai' }))
    expect(result.status).toBe('success')
    const output = result.output as { timeZone: string; iso: string; weekday: string }
    expect(output.timeZone).toBe('Asia/Shanghai')
    expect(output.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(output.weekday).toBeTruthy()
  })

  it('时区非法时退回 UTC 并说明，而不是崩掉', async () => {
    const result = await time.execute({}, context({ timezone: 'Not/AZone' }))
    expect(result.status).toBe('success')
    const output = result.output as { timeZone: string; note?: string }
    expect(output.timeZone).toBe('UTC')
    expect(output.note).toContain('无效')
  })
})
