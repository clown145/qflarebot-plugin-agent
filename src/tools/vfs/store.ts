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
  move(from: string, to: string): Promise<{ from: string; to: string }>
  search(query: string, limit?: number): Promise<Array<{ path: string; snippet: string }>>
}

/**
 * 创建虚拟工作区。
 *
 * `r2` 可以传 `undefined` —— 那是**轻量模式**：只用 D1 存小文本（≤8KB），
 * 大文件直接拒绝并给出可读提示。
 *
 * 为什么需要轻量模式：R2 是可选绑定，而「让模型记个笔记、存个待办」这类
 * 最常见的用途根本用不到大文件。原来的实现要求必须有 R2，否则整组 vfs 工具
 * 都不注册——等于把一个轻量功能绑死在重型基础设施上，绝大多数部署里
 * 「有虚拟工作区」这句话等于不存在。
 */
export function createVfsWorkspace(db: PluginDB, r2?: ScopedR2): VfsWorkspace {  return {
    async readFile(rawPath) {
      const path = normalizeVfsPath(rawPath)
      const entry = await getEntry(db, path)
      if (!entry) throw new Error(`文件不存在：${path}`)
      if (entry.kind !== 'file') throw new Error(`不是文件：${path}`)

      // 小文本在 D1，大的在 R2
      if (entry.r2Key) {
        if (!r2) {
          throw new Error(
            `文件 ${path} 存在 R2 里，但当前机器人没有绑定 R2 存储，读不到它。`,
          )
        }
        return { path, content: await readFromR2(r2, entry.r2Key), size: entry.size }
      }
      const content = (await getInlineContent(db, path)) ?? ''

      return { path, content, size: entry.size }
    },

    async writeFile(rawPath, content) {
      const path = normalizeVfsPath(rawPath)
      if (path === '/') throw new Error('不能写入根目录')

      const size = byteLength(content)
      if (size > INLINE_LIMIT && !r2) {
        throw new Error(
          `文件有 ${size} 字节，超过轻量工作区的 ${INLINE_LIMIT} 字节上限。` +
            '要存更大的文件，请让管理员给机器人绑定 R2 存储。',
        )
      }
      const r2Key = size > INLINE_LIMIT && r2 ? `vfs${path}` : null

      // 覆盖已有文件时先记住旧内容的存放位置：大文件改成小文件（或反过来）时，
      // 旧的那份必须删掉，否则 R2 里的对象永远没人引用、也没人删
      const previous = await getEntry(db, path)
      const previousR2Key = previous?.r2Key ?? null

      // 大的写 R2，小的写 D1
      if (r2Key && r2) {
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

      // 新内容不进 R2（变小了），或换了 key：把旧对象删掉。
      // 放在 D1 更新之后：先删后写的话，D1 写失败就会留下「元数据指向一个不存在的对象」。
      if (previousR2Key && previousR2Key !== r2Key && r2) {
        await r2.delete(previousR2Key).catch(() => {
          /* 删不掉（R2 抖动）只是留个孤儿对象，不该让写文件失败 */
        })
      }

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
      if (r2Keys.length && r2) await r2.delete(r2Keys)

      await db.run(`DELETE FROM {vfs_entries} WHERE path = ? OR path LIKE ?`, path, `${path}/%`)
      return true
    },

    /**
     * 移动 / 重命名。
     *
     * 为什么值得单独做一个工具：模型经常需要「把这个文件改名」。
     * 没有它只能「读 → 写新路径 → 删旧的」三步模拟，既费 token，
     * 又可能中途失败留下两份（读到一半失败、或写成功但删失败）。
     *
     * 目录用一条 SQL 连带改所有后代的路径前缀；R2 对象 key 按路径生成，
     * 也要跟着改，否则元数据指向老 key 就永远读不到了。
     */
    async move(rawFrom, rawTo) {
      const from = normalizeVfsPath(rawFrom)
      const to = normalizeVfsPath(rawTo)
      if (from === '/') throw new Error('不能移动根目录')
      if (from === to) return { from, to }
      if (to.startsWith(from + '/')) throw new Error('不能把目录移到它自己里面')

      const source = await getEntry(db, from)
      if (!source) throw new Error(`没有这个路径：${from}`)

      // 目标已存在就拒绝：静默覆盖会让用户丢掉数据
      const existing = await getEntry(db, to)
      if (existing) throw new Error(`目标已存在：${to}`)

      // 目录：连后代一起改前缀。先查出来，改 R2 key 时需要知道旧的
      // 用与 remove() 相同的查询形状（`path = ? OR path LIKE ?`）：
      // 真实 D1 上纯 `LIKE` 也能跑，但语义上这里要的是「自己 + 后代」，
      // 写成同一个形状既不依赖实现细节，也和删除逻辑保持一致
      const subtree = await db.all<{ path: string; r2_key: string | null }>(
        `SELECT path, r2_key FROM {vfs_entries} WHERE path = ? OR path LIKE ?`,
        from,
        `${from}/%`,
      )
      const descendants = subtree.filter((row) => row.path !== from)

      await ensureParentDirs(db, to)

      // 逐个搬 R2 对象（文本文件才可能有）
      if (r2) {
        for (const row of [{ path: from, r2_key: source.r2Key }, ...descendants]) {
          if (!row.r2_key) continue
          const newPath = row.path === from ? to : to + row.path.slice(from.length)
          const newKey = `vfs${newPath}`
          try {
            const body = await r2.getText(row.r2_key)
            if (body !== null) {
              await r2.put(newKey, body, { contentType: 'text/plain; charset=utf-8' })
            }
            await r2.delete(row.r2_key)
          } catch {
            // R2 抖动不该让整个移动失败：元数据先改，最坏是留个孤儿对象
          }
        }
      }

      // 元数据：**先改后代、再改自己**。
      //
      // 顺序很关键：后代的 WHERE 条件是它们各自的老路径（`/dir/a.md`），
      // 一旦先把 `/dir` 改成 `/moved`，这些老路径虽然还在表里，
      // 但语义上已经属于一个不存在的父目录；先改后代能让每一步都基于
      // 仍然自洽的状态。真实 D1 两种顺序都能跑通，但测试里的内存实现
      // 和「先改父再改子」的直觉容易冲突，统一成这个顺序更省心。
      for (const row of descendants) {
        const newPath = to + row.path.slice(from.length)
        await db.run(
          `UPDATE {vfs_entries} SET path = ?, r2_key = ?, updated_at = ? WHERE path = ?`,
          newPath,
          row.r2_key ? `vfs${newPath}` : null,
          Date.now(),
          row.path,
        )
      }

      await db.run(
        `UPDATE {vfs_entries} SET path = ?, name = ?, r2_key = ?, updated_at = ? WHERE path = ?`,
        to,
        childName(to),
        source.r2Key ? `vfs${to}` : null,
        Date.now(),
        from,
      )

      return { from, to }
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
