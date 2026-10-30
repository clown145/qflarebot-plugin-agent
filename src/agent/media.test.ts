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

describe('图片体积的两道闸', () => {
  /** 造一个指定字节数的响应 */
  const responseOf = (bytes: number) =>
    new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } })

  it('单张超过 800 KB：跳过并说明，不占总量', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseOf(900_000)))
    try {
      const result = await hydrateImageAttachments([{ type: 'image', url: 'https://x/a.jpg' }])
      expect(result.attachments).toHaveLength(0)
      expect(result.notes.join()).toContain('太大')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('单张都合格但总量超限：后面的被挡掉（这是单张上限挡不住的情况）', async () => {
    // 4 张各 600 KB：单张都 < 800 KB，但合计 2.4 MB > 1.5 MB 总量上限
    vi.stubGlobal('fetch', vi.fn(async () => responseOf(600_000)))
    try {
      const result = await hydrateImageAttachments(
        [1, 2, 3, 4].map((i) => ({ type: 'image' as const, url: `https://x/${i}.jpg` })),
      )
      // 1.5MB / 600KB = 2 张放得下，第三张开始超
      expect(result.attachments).toHaveLength(2)
      expect(result.notes.join()).toContain('总大小超过上限')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('总量恰好在上限内时全部收下', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseOf(500_000)))
    try {
      const result = await hydrateImageAttachments(
        [1, 2, 3].map((i) => ({ type: 'image' as const, url: `https://x/${i}.jpg` })),
      )
      // 3 × 500 KB = 1.5 MB，正好等于上限（用 <= 判定所以都收）
      expect(result.attachments).toHaveLength(3)
      expect(result.notes).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('已有 base64 的图片也计入总量，不能靠重入绕过限制', async () => {
    // 一张已有的图（base64 长度折算后约 600 KB）+ 两张新图各 600 KB
    const existing = 'A'.repeat(Math.ceil((600_000 * 4) / 3))
    vi.stubGlobal('fetch', vi.fn(async () => responseOf(600_000)))
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', url: 'https://x/old.jpg', dataBase64: existing },
        { type: 'image', url: 'https://x/new1.jpg' },
        { type: 'image', url: 'https://x/new2.jpg' },
      ])
      // 已有 600KB + 一张新的 600KB = 1.2MB，第二张新的会超
      expect(result.attachments).toHaveLength(2)
      expect(result.notes.join()).toContain('总大小超过上限')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超限的图不影响同一条消息里的其他附件与正文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => responseOf(900_000)))
    try {
      const result = await hydrateImageAttachments([
        { type: 'image', url: 'https://x/big.jpg' },
        { type: 'file', url: 'https://x/a.pdf', filename: 'a.pdf' },
      ])
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]?.type).toBe('file')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
