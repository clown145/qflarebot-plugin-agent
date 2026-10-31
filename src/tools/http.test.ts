import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginDB } from '@qqbot/sdk'
import { createHttpTool } from './http.js'
import { createWebTool } from './web.js'
import { createTimeTool } from './time.js'
import type { ToolExecutionContext } from './types.js'

/** base64 → 字节。用 atob 而不是 Buffer：测试跑在 Worker 语义下，没有 Node 全局 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
}

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

  /**
   * 回归：上一版只校验初始 URL，然后用 `redirect: 'follow'` 让 fetch 自己跟到底。
   * 公网地址 302 到 127.0.0.1 / 云元数据地址就能绕过 SSRF 黑名单。
   * `http.request` 一直是逐跳校验的，这里补齐。
   */
  it('重定向到内网地址时拒绝（不再 follow 到底）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } })),
    )
    try {
      const result = await web.execute(context({ url: 'https://example.com/redirect' }))
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('blocked_url')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('重定向到云元数据地址（169.254.169.254）时拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('', {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          }),
      ),
    )
    try {
      const result = await web.execute(context({ url: 'https://example.com/redirect' }))
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('blocked_url')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('重定向到公网地址时正常跟随并返回正文', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        if (calls.length === 1) {
          return new Response('', { status: 301, headers: { location: 'https://example.com/final' } })
        }
        return new Response('<html><body><p>最终正文</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }),
    )
    try {
      const result = await web.execute(context({ url: 'https://example.com/start' }))
      expect(result.status).toBe('success')
      expect((result.output as { text: string }).text).toContain('最终正文')
      // 两跳都是 manual，插件自己解析 Location
      expect(calls).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('重定向次数超限时返回 too_many_redirects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://example.com/next' } })),
    )
    try {
      const result = await web.execute(context({ url: 'https://example.com/' }))
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('too_many_redirects')
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

/**
 * 回归：SSRF 黑名单的漏项。
 *
 * 实测旧实现把下面这些放行了（`validateFetchUrl` 返回 undefined）：
 * IPv4 兼容 IPv6（`::a.b.c.d`）、CGNAT `100.64/10`、`192.0.0.0/24`、
 * `198.18.0.0/15`、已废弃的 site-local `fec0::/10`。
 *
 * 每一条都能在云环境里摸到不该摸的东西：CGNAT 常被当 VPC 内部地址，
 * `192.0.0.0/24` / `198.18/15` 是保留段，`fec0::` 语义等同内网。
 */
describe('SSRF：补齐的 IP 段', () => {
  const http = createHttpTool()

  const newlyBlocked = [
    'http://[::127.0.0.1]/', // IPv4 兼容 IPv6 → 回环
    'http://[::192.168.1.1]/', // IPv4 兼容 IPv6 → 私网
    'http://[::10.0.0.1]/',
    'http://[::169.254.169.254]/', // IPv4 兼容 IPv6 → 云元数据
    'http://100.64.0.1/', // CGNAT 100.64.0.0/10
    'http://100.127.255.254/',
    'http://192.0.0.5/', // 192.0.0.0/24 IETF 协议保留
    'http://192.0.2.1/', // TEST-NET-1
    'http://198.18.0.1/', // 198.18.0.0/15 基准测试段
    'http://198.19.255.254/',
    'http://198.51.100.1/', // TEST-NET-2
    'http://203.0.113.1/', // TEST-NET-3
    'http://[fec0::1]/', // 已废弃的 IPv6 site-local
    'http://224.0.0.1/', // 组播
    'http://255.255.255.255/', // 广播
    'http://[::ffff:127.0.0.1]/', // IPv4 映射 IPv6（原本已拦，防回归）
    'http://[64:ff9b::7f00:1]/', // NAT64 隧道回环（原本已拦，防回归）
  ]

  it.each(newlyBlocked)('拒绝 %s', async (url) => {
    const result = await http.execute(context({ url }))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('blocked_url')
  })

  it('公网地址不受影响：常规域名、公网字面量、公网 IPv6 都放行', async () => {
    // 只校验到 fetch 之前：fetch 打桩返回最小响应，能拿到 success 就说明没被拦
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    try {
      for (const url of [
        'https://example.com/',
        'https://api.github.com/repos/x',
        'http://1.1.1.1/',
        'https://[2606:4700:4700::1111]/',
        // 名字里带 169.254 但不是内网字面量：不做 DNS 解析，按域名放行（已知限制，见文档）
        'https://169.254.169.254.example.com/',
      ]) {
        const result = await http.execute(context({ url }))
        expect(result.status, url).toBe('success')
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * 回归：binary 模式静默损坏二进制。
 *
 * 旧实现先 `TextDecoder().decode()` 把字节解成字符串、再用 `TextEncoder`
 * 编码回去做 base64。非 UTF-8 字节（PNG 头 0x89 0x50 0x4e 0x47 之后紧跟着的
 * 0x0d 0x0a 0x1a 0x0a）会被替换成 U+FFFD（EF BF BD），文件头直接坏掉——
 * 而调用方拿到的是「成功」，看不出任何异常。当前这个路径零测试覆盖。
 */
describe('http.request binary 模式', () => {
  const http = createHttpTool()

  it('binary 模式对原始字节做 base64，PNG 头不被破坏', async () => {
    // 真实 PNG 的前 8 字节：89 50 4E 47 0D 0A 1A 0A
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(pngMagic, { status: 200, headers: { 'content-type': 'image/png' } })),
    )
    try {
      const result = await http.execute(
        context({ url: 'https://example.com/a.png', binary: true }),
      )
      expect(result.status).toBe('success')
      const bodyBase64 = (result.output as { bodyBase64: string }).bodyBase64
      // iVBORw0KGgo= 是 89 50 4E 47 0D 0A 1A 0A 的标准 base64
      expect(bodyBase64).toBe('iVBORw0KGgo=')
      // 旧实现在这里会得到含 77+9（EF BF BD 的 base64 片段）的串
      expect(bodyBase64).not.toContain('77+9')
      // 逐字节还原，确保一个字节都没改
      expect([...decodeBase64(bodyBase64)]).toEqual([...pngMagic])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('binary 模式下任意非 UTF-8 字节都原样保留（不在文本模式那种有损路径上）', async () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(raw, { status: 200 })))
    try {
      const result = await http.execute(
        context({ url: 'https://example.com/blob', binary: true }),
      )
      const bodyBase64 = (result.output as { bodyBase64: string }).bodyBase64
      expect([...decodeBase64(bodyBase64)]).toEqual([...raw])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('非 binary 模式仍然是文本，中文正常解码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('中文正文', { status: 200 })))
    try {
      const result = await http.execute(context({ url: 'https://example.com/text' }))
      expect((result.output as { body: string }).body).toBe('中文正文')
      expect(result.output as Record<string, unknown>).not.toHaveProperty('bodyBase64')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/**
 * 回归：`media.ts` 的图片下载以前是唯一一条没接 SSRF 的抓取路径。
 * 这里直接测 `url-safety` 的判定，覆盖「域名不做 DNS 解析」这个已知限制，
 * 防止有人误以为它防住了 rebinding。
 */
describe('SSRF 的已知限制：不解析 DNS', () => {
  const http = createHttpTool()

  it('解析后指向内网的公有域名被放行（已知限制，文档已写明）', async () => {
    // 这条**不是**期望的「拦住了」，而是把限制钉住：
    // 将来若真做了 DNS 校验，这条测试会失败，提醒把文档一起改掉
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    try {
      const result = await http.execute(
        context({ url: 'http://169.254.169.254.nip.io/latest/meta-data/' }),
      )
      expect(result.status).toBe('success')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('localhost 与其子域仍然被拦（字面量匹配，不依赖 DNS）', async () => {
    for (const url of ['http://localhost/', 'http://api.localhost/']) {
      const result = await http.execute(context({ url }))
      expect(result.error?.code, url).toBe('blocked_url')
    }
  })
})
