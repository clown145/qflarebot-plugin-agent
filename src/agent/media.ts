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
 * ## 体积限制从哪来
 *
 * **不是** plugin-llm 的 `body_max_bytes`（256 KB）——那个只管它自己的管理页 API
 * （`PUT /api/config` 之类），`llm.chat()` 是进程内直调、不经那条路，请求方向
 * 没有任何体积校验。真实约束在别处：
 *
 * - **Worker 内存**：一次事件里整个请求体、base64 编码的中间串、克隆出来的
 *   消息副本都要同时存在。免费版 Worker 的内存上限只有 128 MB，而且这是
 *   全机器人所有插件共享的。
 * - **CPU**：base64 编码是纯 CPU 活，而免费版一次事件只有 10 ms CPU。
 *   大图会直接把这一轮算超时。
 * - **上游**：多数 provider 对单张图片有自己的上限（常见 5–20 MB），但那是
 *   上游的规矩，不该由我们替它赌。
 *
 * 所以这里用**两道闸**：单张上限挡掉个别大图，总量上限挡掉「4 张中等图叠起来
 * 依然过大」这种组合。超限的图不下载、只留一句说明，整条对话不受影响。
 */
import type { MessageAttachment } from '../types.js'

/**
 * 单张图片上限（原始字节，未编码）。
 *
 * base64 会把体积撑大约 4/3，所以 800 KB 的原图编码后约 1.07 MB。
 * 这个数字是权衡：手机直出的照片常在 2–4 MB，基本都会被挡在这里——
 * 但那种尺寸塞进 Worker 内存和 10 ms CPU 预算里本来就不现实。
 */
const MAX_IMAGE_BYTES = 800_000

/**
 * 一次请求里所有图片的**总量**上限（原始字节）。
 *
 * 光有单张上限不够：4 张各 700 KB 的图全是合法单张，加起来编码后接近 3.7 MB。
 * 总量取 1.5 MB（编码后约 2 MB），在 Worker 内存里留足余量。
 */
const MAX_TOTAL_IMAGE_BYTES = 1_500_000

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
  /** 已收下图片的原始字节总和（base64 前的口径） */
  let totalBytes = 0

  for (const image of images) {
    // 已经有 base64 的（重入路径）：按编码后的长度折回原始字节，同样要计入总量。
    // 不折回来就会漏算——一张已有的 700 KB 图 + 三张新图还是可能超限。
    if (image.dataBase64) {
      const rawEstimate = Math.ceil((image.dataBase64.length * 3) / 4)
      if (totalBytes + rawEstimate > MAX_TOTAL_IMAGE_BYTES) {
        notes.push('图片总大小超过上限，最后几张没有读取')
        continue
      }
      totalBytes += rawEstimate
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
      // 单张合格但累计超限：说明「几张中等图叠起来」已经逼近内存与 CPU 预算
      if (totalBytes + buffer.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        notes.push('图片总大小超过上限，最后几张没有读取')
        continue
      }
      totalBytes += buffer.byteLength

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
