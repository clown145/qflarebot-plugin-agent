/**
 * 附件处理：把 QQ 的图片 URL 取回来转成 base64，供视觉模型使用。
 *
 * ## 为什么要下载
 *
 * plugin-llm 的图片内容片段支持两种来源：`url` 和 `data`（base64）。
 * QQ 的图片 URL 带签名且**有效期很短**（几分钟到几小时），而 agent loop 可能
 * 在 cron 段才跑到（最坏 5 分钟后）。直接把 URL 交给上游，等模型真要读时可能已经 403。
 *
 * 所以入站时就把图片取回来（此时签名一定有效），转成 base64 存进消息里。
 *
 * ## 为什么限制大小
 *
 * base64 编码会把体积撑大约 1/3，而一次模型请求的 body 上限是 256 KB
 * （见 plugin-llm 的限制说明）。所以单张图片限制在 1.5 MB 以内，
 * 超过的直接降级成"发不了"，而不是让整个对话因为超限失败。
 */
import type { MessageAttachment } from '../types.js'

/** 单张图片上限：base64 后约 2 MB，留足 JSON 结构与其他消息的余量 */
const MAX_IMAGE_BYTES = 1_500_000

/** 一次最多取几张图。群里有人连发十几张时不能全下 */
const MAX_IMAGES = 4

export interface DownloadResult {
  attachments: MessageAttachment[]
  /** 下载失败或被跳过的图片说明，会写进正文让模型知道 */
  notes: string[]
}

/**
 * 把图片附件下载成 base64。
 *
 * 失败不抛异常——附件下载不了不该让整条消息丢失。失败信息会作为 notes 返回，
 * 由调用方拼进正文，模型能据此告诉用户"图片没读到"。
 */
export async function hydrateImageAttachments(
  attachments: MessageAttachment[],
): Promise<DownloadResult> {
  const images = attachments.filter((a) => a.type === 'image').slice(0, MAX_IMAGES)
  const rest = attachments.filter((a) => a.type !== 'image')

  const notes: string[] = []
  const hydrated: MessageAttachment[] = []

  for (const image of images) {
    if (image.dataBase64) {
      hydrated.push(image)
      continue
    }

    if (!image.url) {
      notes.push('有一张图片没有可用的地址，没能读取')
      continue
    }

    try {
      const response = await fetch(image.url, { redirect: 'follow' })
      if (!response.ok) {
        notes.push(`有一张图片下载失败（HTTP ${response.status}）`)
        continue
      }

      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        notes.push(`有一张图片太大（${Math.round(buffer.byteLength / 1024)} KB），没有读取`)
        continue
      }

      hydrated.push({
        ...image,
        dataBase64: arrayBufferToBase64(buffer),
        ...(image.contentType
          ? {}
          : { contentType: response.headers.get('content-type') ?? 'image/jpeg' }),
      })
    } catch (error) {
      notes.push(`有一张图片下载出错：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { attachments: [...hydrated, ...rest], notes }
}

/** base64 编码。分块避免大数组展开成函数参数时爆栈 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
