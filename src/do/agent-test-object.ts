/** DO 调度测试共用的内存存储，仅替代平台构造与存储接口。 */
import { Agent } from './agent-object.js'

/** 内存版 DurableObjectStorage，只实现 Agent 用到的方法 */
function memoryStorage() {
  const map = new Map<string, unknown>()
  return {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined
    },
    async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrEntries === 'string') {
        map.set(keyOrEntries, value)
      } else {
        for (const [k, v] of Object.entries(keyOrEntries)) map.set(k, v)
      }
    },
    async delete(keyOrKeys: string | string[]) {
      for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) map.delete(k)
      return true
    },
    async list<T>(options: { prefix?: string; limit?: number } = {}) {
      const prefix = options.prefix ?? ''
      const entries = [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort((a, b) => a[0].localeCompare(b[0]))
      const limited = options.limit ? entries.slice(0, options.limit) : entries
      return new Map(limited) as Map<string, T>
    },
  }
}

export function makeObject() {
  const storage = memoryStorage()
  const obj = Object.create(Agent.prototype) as Agent
  // 只注入 ctx.storage —— Agent 里没有别的地方碰 this.ctx
  ;(obj as unknown as { ctx: { storage: unknown } }).ctx = { storage }
  return { obj, storage }
}
