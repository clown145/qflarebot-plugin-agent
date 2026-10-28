import { describe, expect, it, vi } from 'vitest'
import { hydrateImageAttachments } from './media.js'
import type { MessageAttachment } from '../types.js'

describe('hydrateImageAttachments', () => {
  it('没有图片时原样返回，不发起请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await hydrateImageAttachments([
        { type: 'file', url: 'https://example.com/a.pdf' },
      ])
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.attachments).toHaveLength(1)
      expect(result.notes).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('下载图片并转成 base64', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })),
    )
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', url: 'https://example.com/a.png' },
      ])
      expect(result.attachments[0]?.dataBase64).toBeTruthy()
      expect(result.attachments[0]?.contentType).toBe('image/png')
      expect(result.notes).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('已经带 base64 的图片不重复下载', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', dataBase64: 'abc', url: 'https://example.com/a.png' },
      ])
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.attachments[0]?.dataBase64).toBe('abc')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('下载失败时记 note 但不抛异常（不让整条消息丢失）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', url: 'https://example.com/expired.png' },
      ])
      expect(result.attachments).toHaveLength(0)
      expect(result.notes[0]).toContain('403')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('网络异常时记 note 但不抛', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('连接超时')
      }),
    )
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', url: 'https://example.com/a.png' },
      ])
      expect(result.notes[0]).toContain('连接超时')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超过大小上限的图片被跳过并说明', async () => {
    const big = new Uint8Array(2_000_000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big, { status: 200 })))
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', url: 'https://example.com/huge.png' },
      ])
      expect(result.attachments).toHaveLength(0)
      expect(result.notes[0]).toContain('太大')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超过张数上限时只取前几张（群里连发十几张不能全下）', async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const attachments: MessageAttachment[] = Array.from({ length: 10 }, (_, i) => ({
        type: 'image' as const,
        url: `https://example.com/${i}.png`,
      }))
      const result = await hydrateImageAttachments(attachments)
      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(result.attachments).toHaveLength(4)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('没有 url 也没有 base64 的图片记 note', async () => {
    const result = await hydrateImageAttachments([{ type: 'image' }])
    expect(result.notes[0]).toContain('没有可用的地址')
  })

  it('非图片附件与图片一起返回时顺序不乱', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } })),
    )
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', url: 'https://example.com/a.png' },
        { type: 'file', url: 'https://example.com/a.pdf' },
      ])
      expect(result.attachments.map((a) => a.type).sort()).toEqual(['file', 'image'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
