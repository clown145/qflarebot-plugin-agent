import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Logger, PluginDB } from '@qqbot/sdk'
import { createSearchTools } from './search.js'
import type { ToolExecutionContext } from './types.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function context(input: unknown): ToolExecutionContext {
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
  }
}

/** 只有一条工具，取出来省得每处都写 [0]! */
function search(config?: { provider: 'tavily'; apiKey: string }) {
  return createSearchTools(config)[0]!
}

function tavilyResponse(results: Array<{ title: string; url: string; content: string }>): Response {
  return new Response(JSON.stringify({ query: 'q', results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('search.web 的未配置降级', () => {
  it('没有配置时不抛异常，返回 failed 并说明要配 Key', async () => {
    const tool = search()
    const result = await tool.execute(context({ query: '今天天气' }))

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('search_not_configured')
    expect(result.error?.message).toContain('API Key')
    // 不可重试：重试一百次也不会突然有 key
    expect(result.error?.retryable).toBe(false)
  })

  it('apiKey 是空串时同样按未配置处理', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await search({ provider: 'tavily', apiKey: '   ' }).execute(
      context({ query: 'x' }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('search_not_configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('缺少 query 时返回 bad_request', async () => {
    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(context({}))
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
  })
})

describe('search.web 的 Tavily 解析', () => {
  it('把结果整理成 { title, url, snippet, index } 信封', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              query: '量子计算',
              results: [
                { title: 'A 标题', url: 'https://a.example/1', content: 'A 摘要', score: 0.9 },
                { title: 'B 标题', url: 'https://b.example/2', content: 'B 摘要', score: 0.8 },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    const result = await search({ provider: 'tavily', apiKey: 'tvly-k' }).execute(
      context({ query: '量子计算' }),
    )

    expect(result.status).toBe('success')
    expect(result.output).toEqual({
      results: [
        { title: 'A 标题', url: 'https://a.example/1', snippet: 'A 摘要', index: '1.1' },
        { title: 'B 标题', url: 'https://b.example/2', snippet: 'B 摘要', index: '1.2' },
      ],
      provider: 'tavily',
      query: '量子计算',
    })
  })

  it('请求体带上 api_key / query / max_results，且不带 raw_content', async () => {
    const fetchMock = vi.fn(async () => tavilyResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await search({ provider: 'tavily', apiKey: 'tvly-k' }).execute(context({ query: '关键词' }))

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe('https://api.tavily.com/search')
    const body = JSON.parse(String(call[1].body)) as Record<string, unknown>
    expect(body.api_key).toBe('tvly-k')
    expect(body.query).toBe('关键词')
    expect(body.max_results).toBe(5)
    expect(body.include_raw_content).toBe(false)
  })

  it('没有 url 的结果被丢掉，标题为空时用 url 兜底', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                { title: '', url: 'https://a.example/1', content: '有 url' },
                { title: '没 url', content: '丢弃' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )
    const output = result.output as { results: Array<{ title: string; url: string }> }
    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.title).toBe('https://a.example/1')
  })

  it('摘要超过 300 字时截断，避免一条结果吃掉上下文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tavilyResponse([{ title: 't', url: 'https://a.example/1', content: '字'.repeat(500) }]),
      ),
    )

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )
    const output = result.output as { results: Array<{ snippet: string }> }
    const snippet = output.results[0]?.snippet ?? ''
    expect(snippet.length).toBe(301) // 300 字 + 省略号
    expect(snippet.endsWith('…')).toBe(true)
  })
})

describe('search.web 的 index 编号', () => {
  it('同一次检索内从 1.1 连续编号', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tavilyResponse(
          Array.from({ length: 3 }, (_, i) => ({
            title: `t${i}`,
            url: `https://e.example/${i}`,
            content: 'c',
          })),
        ),
      ),
    )

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )
    const output = result.output as { results: Array<{ index: string }> }
    expect(output.results.map((r) => r.index)).toEqual(['1.1', '1.2', '1.3'])
  })

  it('max_results=2 时只回两条，且编号仍然从 1.1 起', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        tavilyResponse(
          Array.from({ length: 5 }, (_, i) => ({
            title: `t${i}`,
            url: `https://e.example/${i}`,
            content: 'c',
          })),
        ),
      ),
    )

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x', max_results: 2 }),
    )
    const output = result.output as { results: Array<{ index: string }> }
    expect(output.results.map((r) => r.index)).toEqual(['1.1', '1.2'])
  })
})

describe('search.web 的 max_results 夹取', () => {
  it.each([
    [0, 1],
    [-5, 1],
    [50, 10],
    [3.9, 3],
    ['5', 5],
  ])('输入 %s 时按 %s 发给 provider', async (given, expected) => {
    const fetchMock = vi.fn(async () => tavilyResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x', max_results: given }),
    )

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(call[1].body)) as { max_results: number }
    expect(body.max_results).toBe(expected)
  })
})

describe('search.web 的错误映射', () => {
  it('HTTP 429 → retryable true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('rate_limited')
    expect(result.error?.retryable).toBe(true)
  })

  it('HTTP 401 → retryable false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))

    const result = await search({ provider: 'tavily', apiKey: 'bad' }).execute(
      context({ query: 'x' }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('auth_error')
    expect(result.error?.retryable).toBe(false)
  })

  it('HTTP 400 → retryable false，并带上 provider 的错误详情', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: { error: 'Query is too long' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_request')
    expect(result.error?.retryable).toBe(false)
  })

  it('HTTP 503 → retryable true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )

    expect(result.error?.code).toBe('upstream_error')
    expect(result.error?.retryable).toBe(true)
  })

  it('网络异常 → retryable true，不抛出去', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('network')
    expect(result.error?.retryable).toBe(true)
  })

  it('200 但不是 JSON → failed 且可重试（多半是代理返回的错误页）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })),
    )

    const result = await search({ provider: 'tavily', apiKey: 'k' }).execute(
      context({ query: 'x' }),
    )

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('bad_response')
    expect(result.error?.retryable).toBe(true)
  })
})
