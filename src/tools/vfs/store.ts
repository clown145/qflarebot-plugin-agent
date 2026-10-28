/**
 * 虚拟工作区的存储层。
 *
 * 照搬 serverless-agent 的 VFS 设计思路（`src/vfs/storage/`，1029 行），
 * 但大幅简化：原文有 entries / contents / revisions / mounts 四张表 + blob 存储，
 * 这里只保留 entries（元数据，D1）+ contents（内容，小文本进 D1、大的进 R2）。
 *
 * 为什么砍掉 revisions：原文用它做版本历史与回滚，但每个版本都是额外写入——
 * 按免费版 10 万行/日算，一次写文件就吃掉 2–3 行额度。本插件改成只保留最新版本。
 */
import type { PluginDB, ScopedR2 } from '@qqbot/sdk'
import { normalizeVfsPath, parentPath, childName } from './path.js'

/** 内容超过这个大小就走 R2，避免 D1 单行过大 */
const INLINE_LIMIT = 8 * 1024

export interface VfsEntry {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  /** 内容存在 R2 时的 key；小文本存 D1 时为 null */
  r2Key: string | null
  updatedAt: number
}

export interface VfsWorkspace {
  readFile(path: string): Promise<{ path: string; content: string; size: number }>
  writeFile(path: string, content: string): Promise<{ path: string; size: number }>
  listDir(path: string): Promise<VfsEntry[]>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<boolean>
  search(query: string, limit?: number): Promise<Array<{ path: string; snippet: string }>>
}

export function createVfsWorkspace(db: PluginDB, r2: ScopedR2): VfsWorkspace {
  return {
    async readFile(rawPath) {
      const path = normalizeVfsPath(rawPath)
      const entry = await getEntry(db, path)
      if (!entry) throw new Error(`文件不存在：${path}`)
      if (entry.kind !== 'file') throw new Error(`不是文件：${path}`)

      // 小文本在 D1，大的在 R2
      const content = entry.r2Key
        ? await readFromR2(r2, entry.r2Key)
        : ((await getInlineContent(db, path)) ?? '')

      return { path, content, size: entry.size }
    },

    async writeFile(rawPath, content) {
      const path = normalizeVfsPath(rawPath)
      if (path === '/') throw new Error('不能写入根目录')

      const size = byteLength(content)
      const r2Key = size > INLINE_LIMIT ? `vfs${path}` : null

      // 大的写 R2，小的写 D1
      if (r2Key) {
        await r2.put(r2Key, content, { contentType: 'text/plain; charset=utf-8' })
      }

      await ensureParentDirs(db, path)
      await db.run(
        `INSERT INTO {vfs_entries} (path, name, kind, size, r2_key, content, updated_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size,
           r2_key = excluded.r2_key,
           content = excluded.content,
           updated_at = excluded.updated_at`,
        path,
        childName(path),
        size,
        r2Key,
        r2Key ? null : content,
        Date.now(),
      )

      return { path, size }
    },

    async listDir(rawPath) {
      const path = normalizeVfsPath(rawPath)
      const rows = await db.all<{
        path: string
        name: string
        kind: 'file' | 'dir'
        size: number
        r2_key: string | null
        updated_at: number
      }>(
        `SELECT path, name, kind, size, r2_key, updated_at FROM {vfs_entries}
         WHERE parent = ? ORDER BY kind DESC, name ASC`,
        path,
      )
      return rows.map(toEntry)
    },

    async mkdir(rawPath) {
      const path = normalizeVfsPath(rawPath)
      if (path === '/') return
      await ensureParentDirs(db, path)
      await db.run(
        `INSERT INTO {vfs_entries} (path, name, parent, kind, size, r2_key, content, updated_at)
         VALUES (?, ?, ?, 'dir', 0, NULL, NULL, ?)
         ON CONFLICT(path) DO NOTHING`,
        path,
        childName(path),
        parentPath(path),
        Date.now(),
      )
    },

    async remove(rawPath) {
      const path = normalizeVfsPath(rawPath)
      if (path === '/') throw new Error('不能删除根目录')

      // 先查出要删的所有路径（自己 + 后代），才能一并清 R2 对象
      const rows = await db.all<{ path: string; r2_key: string | null }>(
        `SELECT path, r2_key FROM {vfs_entries} WHERE path = ? OR path LIKE ?`,
        path,
        `${path}/%`,
      )
      // 目录本身可能没有 entry（写入时只建了父级），但它的子项存在时也要算删成功
      if (rows.length === 0) return false

      const r2Keys = rows.map((r) => r.r2_key).filter((k): k is string => Boolean(k))
      if (r2Keys.length) await r2.delete(r2Keys)

      await db.run(`DELETE FROM {vfs_entries} WHERE path = ? OR path LIKE ?`, path, `${path}/%`)
      return true
    },

    async search(query, limit = 10) {
      if (!query.trim()) return []
      // LIKE 转义：用户的 % 和 _ 不该当通配符
      const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`)
      const rows = await db.all<{ path: string; content: string }>(
        `SELECT path, content FROM {vfs_entries}
         WHERE kind = 'file' AND content LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ?`,
        `%${escaped}%`,
        limit,
      )
      return rows.map((row) => ({
        path: row.path,
        snippet: makeSnippet(row.content, query),
      }))
    },
  }
}

async function getEntry(db: PluginDB, path: string): Promise<VfsEntry | null> {
  const row = await db.first<{
    path: string
    name: string
    kind: 'file' | 'dir'
    size: number
    r2_key: string | null
    updated_at: number
  }>(`SELECT path, name, kind, size, r2_key, updated_at FROM {vfs_entries} WHERE path = ?`, path)
  return row ? toEntry(row) : null
}

async function getInlineContent(db: PluginDB, path: string): Promise<string | null> {
  const row = await db.first<{ content: string | null }>(
    `SELECT content FROM {vfs_entries} WHERE path = ?`,
    path,
  )
  return row?.content ?? null
}

async function readFromR2(r2: ScopedR2, key: string): Promise<string> {
  const text = await r2.getText(key)
  if (text === null) throw new Error(`文件内容丢失：${key}`)
  return text
}

/** 逐级创建父目录。路径段数通常很少，一次 run 也就几层 */
async function ensureParentDirs(db: PluginDB, path: string): Promise<void> {
  const parts = normalizeVfsPath(path).split('/').filter(Boolean)
  let current = ''
  const now = Date.now()
  const statements = []
  for (const part of parts.slice(0, -1)) {
    const parent = current || '/'
    current = `${current}/${part}`
    statements.push({
      sql: `INSERT INTO {vfs_entries} (path, name, parent, kind, size, r2_key, content, updated_at)
            VALUES (?, ?, ?, 'dir', 0, NULL, NULL, ?) ON CONFLICT(path) DO NOTHING`,
      params: [current, part, parent, now],
    })
  }
  if (statements.length) await db.batch(statements)
}

function toEntry(row: {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  r2_key: string | null
  updated_at: number
}): VfsEntry {
  return {
    path: row.path,
    name: row.name,
    kind: row.kind,
    size: row.size,
    r2Key: row.r2_key,
    updatedAt: row.updated_at,
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** 截取命中位置附近的一段，让模型看到上下文 */
function makeSnippet(content: string, query: string, radius = 60): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return content.slice(0, radius * 2)
  const start = Math.max(0, index - radius)
  const end = Math.min(content.length, index + query.length + radius)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}
