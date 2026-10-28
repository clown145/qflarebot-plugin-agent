/**
 * `http.request` 工具。
 *
 * 核心逻辑照搬 serverless-agent 的 `src/tools/http/client.ts`（276 行，零存储耦合），
 * 但裁掉了 cookie jar（要加密存 D1，吃额度且极少用到）。
 *
 * 保留的关键部分是 **SSRF 防护**：`validateFetchUrl` 会拒绝回环、内网、
 * 链路本地地址，并且**每一跳重定向都重新校验**——只校验初始 URL 的话，
 * 攻击者可以用一个公网地址 302 到 127.0.0.1 绕过。
 */
import type { RegisteredTool, ToolResult } from './types.js'
import { validateFetchUrl } from './http/url-safety.js'

const MAX_BODY_BYTES = 1024 * 1024
/** 回给模型的字符上限（不是字节）。与 web.fetch_page 保持一致 */
const MAX_BODY_CHARS = 20_000
const MAX_REDIRECTS = 3

interface HttpRequestInput {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 为 true 时把响应体按 base64 返回（二进制用） */
  binary?: boolean
}

export function createHttpTool(): RegisteredTool {
  return {
    definition: {
      name: 'http.request',
      title: 'HTTP 请求',
      description:
        '发起一个 HTTP 请求并返回状态码与响应体。只能访问公网地址，内网与回环地址会被拒绝。' +
        '响应体上限 1MB，超出部分会被截断。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 URL，必须是 http 或 https' },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
            description: '默认 GET',
          },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '请求头',
          },
          body: { type: 'string', description: '请求体（字符串）' },
          binary: {
            type: 'boolean',
            description: '为 true 时响应体按 base64 返回，用于图片等二进制内容',
          },
        },
        required: ['url'],
      },
      // level 3 + http:request scope：普通群成员（level 2）用不了，
      // 群主与管理员（level 4）能用。这是原文 default-policy 的设计
      permission: { level: 3, scopes: ['http:request'] },
      sideEffect: 'external_write',
      timeoutMs: 15_000,
      annotations: { openWorldHint: true },
    },
    source: { type: 'builtin', id: 'http', name: 'HTTP' },

    execute: async (context) => {
      const parsed = context.input as Partial<HttpRequestInput> | undefined
      if (!parsed?.url || typeof parsed.url !== 'string') {
        return fail('bad_request', '缺少 url')
      }

      let current = parsed.url
      const method = (parsed.method ?? 'GET').toUpperCase()

      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const invalid = validateFetchUrl(current)
        if (invalid) return fail('blocked_url', invalid)

        let response: Response
        try {
          response = await fetch(current, {
            method,
            headers: parsed.headers,
            ...(parsed.body && method !== 'GET' && method !== 'HEAD' ? { body: parsed.body } : {}),
            redirect: 'manual',
          })
        } catch (error) {
          return fail('network', error instanceof Error ? error.message : String(error))
        }

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) return fail('bad_response', '重定向没有 Location 头')
          current = new URL(location, current).toString()
          continue
        }

        const { text, truncated } = await readCapped(response)
        // 结果要回到模型上下文里，而 plugin-llm 的请求体上限是 256 KB：
        // 1 MB 的正文塞进去会让下一条消息直接 bad_request，还会白烧 token。
        // 按字符截断（与 web.fetch_page 的 20k 一致），二进制走 base64 不截（调用方要完整字节）。
        const capped = parsed.binary ? text : text.slice(0, MAX_BODY_CHARS)
        return {
          status: 'success',
          output: {
            status: response.status,
            url: current,
            contentType: response.headers.get('content-type') ?? '',
            truncated: truncated || capped.length < text.length,
            ...(parsed.binary ? { bodyBase64: toBase64(text) } : { body: capped }),
          },
        }
      }

      return fail('too_many_redirects', `重定向超过 ${MAX_REDIRECTS} 次`)
    },
  }
}

/** 读响应体并截断。按字节数算，不是按字符——中文一个字三字节 */
async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { text: '', truncated: false }

  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - MAX_BODY_BYTES))))
      truncated = true
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

  return { text: new TextDecoder().decode(merged), truncated }
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fail(code: string, message: string): ToolResult {
  return { status: 'failed', error: { code, message, retryable: code === 'network' } }
}
