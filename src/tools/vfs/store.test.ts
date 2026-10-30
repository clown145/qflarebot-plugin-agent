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
      if (sql.includes('UPDATE {vfs_entries}')) {
        // 两种更新：改单条（SET path/name/r2_key/updated_at WHERE path = ?）
        // 和后代的路径前缀（SET path/r2_key WHERE path = ?）
        if (sql.includes('SET path = ?, name = ?')) {
          const [newPath, newName, newR2Key, updatedAt, oldPath] = params as [
            string, string, string | null, number, string,
          ]
          const row = rows.get(oldPath)
          if (!row) return { changes: 0 }
          rows.delete(oldPath)
          const parent = newPath.slice(0, newPath.lastIndexOf('/')) || '/'
          rows.set(newPath, { ...row, path: newPath, name: newName, parent, r2_key: newR2Key, updated_at: updatedAt })
          return { changes: 1 }
        }
        if (sql.includes('SET path = ?, r2_key = ?')) {
          const [newPath, newR2Key, updatedAt, oldPath] = params as [string, string | null, number, string]
          const row = rows.get(oldPath)
          if (!row) return { changes: 0 }
          rows.delete(oldPath)
          const parent = newPath.slice(0, newPath.lastIndexOf('/')) || '/'
          rows.set(newPath, { ...row, path: newPath, parent, r2_key: newR2Key, updated_at: updatedAt })
          return { changes: 1 }
        }
        return { changes: 0 }
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

/**
 * vfs.move：改名 / 移动。
 *
 * 这个工具是 serverless-agent 有而插件之前缺的。没有它，模型只能
 * 「读 → 写新路径 → 删旧的」三步模拟，既费 token 又可能中途失败留下两份。
 */
describe('vfs.move', () => {
  it('重命名文件，内容跟着走', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/note.md', '内容')
    await ws.move('/note.md', '/todo.md')
    expect(await ws.readFile('/todo.md')).toMatchObject({ content: '内容' })
    await expect(ws.readFile('/note.md')).rejects.toThrow()
  })

  it('移动到子目录', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/a.md', 'x')
    await ws.move('/a.md', '/archive/a.md')
    expect(await ws.readFile('/archive/a.md')).toMatchObject({ content: 'x' })
  })

  it('目录连同后代一起移动', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    await ws.writeFile('/dir/b.md', 'b')
    await ws.move('/dir', '/moved')
    expect(await ws.readFile('/moved/a.md')).toMatchObject({ content: 'a' })
    expect(await ws.readFile('/moved/b.md')).toMatchObject({ content: 'b' })
    expect(await ws.listDir('/dir')).toEqual([])
  })

  it('目标已存在时拒绝，不覆盖用户数据', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/a.md', 'a')
    await ws.writeFile('/b.md', 'b')
    await expect(ws.move('/a.md', '/b.md')).rejects.toThrow('已存在')
    // 两份内容都还在
    expect(await ws.readFile('/a.md')).toMatchObject({ content: 'a' })
    expect(await ws.readFile('/b.md')).toMatchObject({ content: 'b' })
  })

  it('不能把目录移到它自己里面（会造成无限嵌套）', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    await expect(ws.move('/dir', '/dir/sub')).rejects.toThrow()
  })

  it('源不存在时报错', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await expect(ws.move('/nope.md', '/x.md')).rejects.toThrow()
  })

  it('不能移动根目录', async () => {
    const ws = createVfsWorkspace(memoryDb(), memoryR2())
    await expect(ws.move('/', '/x')).rejects.toThrow('根目录')
  })
})

/**
 * 轻量模式：不传 R2 也能用（只用 D1 存 ≤8KB 文本）。
 *
 * 这是本轮的关键改动：以前「没绑 R2 就整组 vfs 不可用」，
 * 等于把「记个笔记」这种最常见的用途绑死在重型基础设施上。
 */
describe('轻量模式（没有 R2）', () => {
  it('小文本可以正常读写，不需要 R2', async () => {
    const ws = createVfsWorkspace(memoryDb())
    await ws.writeFile('/note.md', '记一笔')
    expect(await ws.readFile('/note.md')).toMatchObject({ content: '记一笔' })
  })

  it('超过 8KB 时给出可读错误，而不是让工具整体失效', async () => {
    const ws = createVfsWorkspace(memoryDb())
    const big = 'x'.repeat(9 * 1024)
    await expect(ws.writeFile('/big.md', big)).rejects.toThrow('R2')
  })

  it('列表与搜索照常可用', async () => {
    const ws = createVfsWorkspace(memoryDb())
    await ws.writeFile('/a.md', '关键词在这里')
    expect(await ws.search('关键词')).toHaveLength(1)
    expect(await ws.listDir('/')).toHaveLength(1)
  })
})
