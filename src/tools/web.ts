/**
 * `web.fetch_page`：抓网页并抽成纯文本。
 *
 * `extract.ts` 是从 serverless-agent 原样复制的（172 行，零依赖）——
 * 它做的 HTML → 文本转换（去 script/style、压空白、按块加换行）足够 agent 读正文，
 * 而且不引入任何第三方解析库（插件体积与 CPU 都是全机器人共享的）。
 */
import type { RegisteredTool, ToolResult } from './types.js'
import { validateFetchUrl } from './http/url-safety.js'
import { extractPageContent } from './web/extract.js'

const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_CHARS = 20_000

export function createWebTool(): RegisteredTool {
  return {
    definition: {
      name: 'web.fetch_page',
      title: '抓取网页',
      description:
        '抓取一个网页并返回可读的正文文本（已去掉脚本、样式与标签）。' +
        '适合读文档、文章、公告。单页上限 2MB。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页地址，必须是 http 或 https' },
        },
        required: ['url'],
      },
      // 只读、无副作用，level 1 人人可用
      permission: { level: 1, scopes: [] },
      sideEffect: 'none',
      timeoutMs: 20_000,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    source: { type: 'builtin', id: 'web', name: '网页' },

    execute: async (context) => {
      const url = (context.input as Partial<{ url: string }>)?.url
      if (!url || typeof url !== 'string') return fail('bad_request', '缺少 url')

      const invalid = validateFetchUrl(url)
      if (invalid) return fail('blocked_url', invalid)

      let response: Response
      try {
        response = await fetch(url, {
          headers: {
            // 不带 UA 的话不少站点会直接 403
            'user-agent': 'Mozilla/5.0 (compatible; QFlareBot-Agent/1.0)',
            accept: 'text/html,application/xhtml+xml,text/plain',
          },
          redirect: 'follow',
        })
      } catch (error) {
        return fail('network', error instanceof Error ? error.message : String(error))
      }

      if (!response.ok) return fail('http_error', `HTTP ${response.status}`)

      const contentType = response.headers.get('content-type') ?? ''
      const raw = await readCapped(response, MAX_PAGE_BYTES)

      // 非 HTML 直接返回原文（JSON 接口、纯文本公告都常见）
      if (!contentType.includes('html')) {
        return { status: 'success', output: { url, contentType, text: raw.slice(0, MAX_CHARS) } }
      }

      const extracted = extractPageContent({
        body: raw,
        contentType,
        baseUrl: url,
        maxChars: MAX_CHARS,
        includeLinks: false,
      })
      return {
        status: 'success',
        output: {
          url,
          contentType,
          title: extracted.title,
          text: extracted.text,
          truncated: raw.length >= MAX_PAGE_BYTES,
        },
      }
    },
  }
}

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > max) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - max))))
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function fail(code: string, message: string): ToolResult {
  return { status: 'failed', error: { code, message, retryable: code === 'network' } }
}
