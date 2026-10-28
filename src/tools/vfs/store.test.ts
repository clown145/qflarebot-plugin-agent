import { describe, expect, it } from 'vitest'
import type { PluginDB, ScopedR2 } from '@qqbot/sdk'
import { createVfsWorkspace } from './store.js'

/** 内存版 D1：只实现 vfs_entries 需要的那几个语句 */
function memoryDb(): PluginDB {
  const rows = new Map<string, Record<string, unknown>>()

  const run = async (sql: string, ...params: unknown[]): Promise<{ changes: number }> => {
      if (sql.includes('INSERT INTO {vfs_entries}')) {
        const isDir = sql.includes("'dir'")
        if (isDir) {
          const [path, name, parent, updatedAt] = params as [string, string, string, number]
          if (!rows.has(path)) {
            rows.set(path, { path, name, parent, kind: 'dir', size: 0, r2_key: null, content: null, updated_at: updatedAt })
          }
        } else {
          const [path, name, size, r2Key, content, updatedAt] = params as [string, string, number, string | null, string | null, number]
          const parent = path.slice(0, path.lastIndexOf('/')) || '/'
          rows.set(path, { path, name, parent, kind: 'file', size, r2_key: r2Key, content, updated_at: updatedAt })
        }
        return { changes: 1 }
      }
      if (sql.includes('DELETE FROM {vfs_entries}')) {
        const [path, like] = params as [string, string]
        // `%` 是 LIKE 的通配符，转成前缀比较；replaceAll 而不是 replace
        const prefix = like.replaceAll('%', '')
        let changes = 0
        for (const key of [...rows.keys()]) {
          if (key === path || key.startsWith(prefix)) {
            rows.delete(key)
            changes += 1
          }
        }
        return { changes }
      }
      return { changes: 0 }
  }

  return {
    run,
    async all(sql: string, ...params: unknown[]) {
      if (sql.includes('path = ? OR path LIKE ?')) {
        const [path, like] = params as [string, string]
        const prefix = like.replaceAll('%', '')
        return [...rows.values()].filter(
          (r) => r['path'] === path || String(r['path']).startsWith(prefix),
        )
      }
      if (sql.includes('WHERE parent = ?')) {
        const parent = params[0] as string
        return [...rows.values()]
          .filter((r) => r['parent'] === parent)
          .sort((a, b) => String(a['kind']).localeCompare(String(b['kind'])))
      }
      if (sql.includes('LIKE')) {
        const needle = String(params[0]).replaceAll('%', '').replaceAll('\\', '')
        return [...rows.values()].filter(
          (r) => r['kind'] === 'file' && String(r['content'] ?? '').includes(needle),
        )
      }
      return []
    },
    async first(sql: string, ...params: unknown[]) {
      if (sql.includes('path = ?')) {
        const row = rows.get(params[0] as string)
        if (!row) return null
        return sql.includes('SELECT content') ? { content: row['content'] } : row
      }
      return null
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      const out: Array<{ changes: number; results: never[] }> = []
      for (const s of statements) {
        out.push({ changes: (await run(s.sql, ...(s.params ?? []))).changes, results: [] })
      }
      return out
    },
    async exec() {},
    table: (n: string) => `p_agent_${n}`,
  } as unknown as PluginDB
}

function memoryR2(): ScopedR2 {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: unknown) {
      store.set(key, String(value))
    },
    async getText(key: string) {
      return store.get(key) ?? null
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k)
    },
    async get() { return null },
    async getJSON() { return null },
    async getStream() { return null },
    async head() { return null },
    async list() { return [] },
  } as unknown as ScopedR2
}

describe('VFS 工作区', () => {
  it('写入后能读回内容', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/notes/a.md', '你好世界')
    const file = await ws.readFile('/notes/a.md')
    expect(file.content).toBe('你好世界')
    expect(file.path).toBe('/notes/a.md')
  })

  it('写入时自动创建父目录', async () => {
    const db = memoryDb()
    const ws = createVfsWorkspace(db, memoryR2())
    await ws.writeFile('/a/b/c.md', 'x')
    const root = await ws.listDir('/')
    expect(root.map((e) => e.name)).toContain('a')
    const a = await ws.listDir('/a')
    expect(a.map((e) => e.name)).toContain('b')
  })

  it('超过 8KB 的内容走 R2，小内容留 D1', async () => {
    const r2 = memoryR2()
    const ws = createVfsWorkspace(memoryDb(), r2)
    await ws.writeFile('/small.txt', 'tiny')
    await ws.writeFile('/big.txt', 'x'.repeat(9000))

    // 大文件从 R2 读得回来
    expect((await ws.readFile('/big.txt')).content).toHaveLength(9000)
    // 小文件不占 R2
    expect(await r2.getText('vfs/big.txt')).not.toBeNull()
    expect(await r2.getText('vfs/small.txt')).toBeNull()
  })

  /**
   * 回归：大文件被小内容覆盖时，旧 R2 对象必须删掉。
   * 上一版把 `r2_key` 置 NULL 就完事，R2 里那份内容永远没人引用、也没人删（无界增长）。
   */
  it('大文件改成小文件时删掉旧的 R2 对象', async () => {
    const r2 = memoryR2()
    const ws = createVfsWorkspace(memoryDb(), r2)

    await ws.writeFile('/doc.txt', 'x'.repeat(9000))
    expect(await r2.getText('vfs/doc.txt')).not.toBeNull()

    await ws.writeFile('/doc.txt', 'small')

    // 内容现在在 D1，R2 里那份应该已经清掉
    expect(await r2.getText('vfs/doc.txt')).toBeNull()
    expect((await ws.readFile('/doc.txt')).content).toBe('small')
  })

  it('小文件改大文件时读回的是 R2 里的新内容', async () => {
    const r2 = memoryR2()
    const ws = createVfsWorkspace(memoryDb(), r2)

    await ws.writeFile('/doc.txt', 'small')
    await ws.writeFile('/doc.txt', 'y'.repeat(9000))

    expect(await r2.getText('vfs/doc.txt')).toHaveLength(9000)
    expect((await ws.readFile('/doc.txt')).content).toBe('y'.repeat(9000))
  })

  it('拒绝 . 与 .. 段（路径穿越）', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await expect(ws.writeFile('/a/../b.md', 'x')).rejects.toThrow('..')
    await expect(ws.writeFile('relative.md', 'x')).rejects.toThrow('必须')
  })

  it('拒绝写入根目录', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await expect(ws.writeFile('/', 'x')).rejects.toThrow('根目录')
  })

  it('读取不存在的文件时抛可读错误', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await expect(ws.readFile('/nope.md')).rejects.toThrow('不存在')
  })

  it('删除目录会连同内容一起删', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    await ws.writeFile('/dir/b.md', 'b')
    expect(await ws.remove('/dir')).toBe(true)
    expect(await ws.listDir('/dir')).toEqual([])
  })

  it('删除不存在的路径返回 false', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    expect(await ws.remove('/nope')).toBe(false)
  })

  it('搜索返回命中路径与上下文片段', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/a.md', '前面一些文字 关键词 后面一些文字')
    const results = await ws.search('关键词')
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe('/a.md')
    expect(results[0]?.snippet).toContain('关键词')
  })

  it('搜索空串返回空数组，不扫全表', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    expect(await ws.search('   ')).toEqual([])
  })
})
