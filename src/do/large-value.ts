/** 图片和检查点可能超过单个 KV 值限制。调用方在 storage.transaction 内使用。 */
export type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>
interface Chunked { chunkedValue: true; prefix: string; count: number }
const CHARS_PER_CHUNK = 16_384

function isChunked(value: unknown): value is Chunked {
  return !!value && typeof value === 'object' && 'chunkedValue' in value && value.chunkedValue === true
}

export async function readValue<T>(storage: Storage, key: string): Promise<T | undefined> {
  const value = await storage.get<T | Chunked>(key)
  if (!isChunked(value)) return value
  const chunks: string[] = []
  for (let i = 0; i < value.count; i++) {
    const part = await storage.get<string>(`${value.prefix}${i}`)
    if (part === undefined) throw new Error(`持久化数据缺少分片：${key}`)
    chunks.push(part)
  }
  return JSON.parse(chunks.join('')) as T
}

export async function deleteValue(storage: Storage, key: string): Promise<void> {
  const previous = await storage.get<unknown>(key)
  if (isChunked(previous)) {
    for (let i = 0; i < previous.count; i++) await storage.delete(`${previous.prefix}${i}`)
  }
  await storage.delete(key)
}

export async function writeValue<T>(storage: Storage, key: string, value: T): Promise<void> {
  const json = JSON.stringify(value)
  await deleteValue(storage, key)
  if (json.length <= CHARS_PER_CHUNK) {
    await storage.put(key, value)
    return
  }
  const prefix = `blob:${crypto.randomUUID()}:`
  const count = Math.ceil(json.length / CHARS_PER_CHUNK)
  for (let i = 0; i < count; i++) {
    await storage.put(`${prefix}${i}`, json.slice(i * CHARS_PER_CHUNK, (i + 1) * CHARS_PER_CHUNK))
  }
  await storage.put(key, { chunkedValue: true, prefix, count } satisfies Chunked)
}
