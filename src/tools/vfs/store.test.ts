/**
 * VFS 存储层测试。**跑真实 SQLite（Node 22 内置 `node:sqlite`），不跑内存假件。**
 *
 * ## 为什么换掉手写内存 DB
 *
 * 这个文件以前有一个 `memoryDb()` 假件，它**自己实现了"应该有的行为"**：
 * - `:19` 自己按 `path.slice(0, lastIndexOf('/'))` 算 parent；
 * - `:51` 把 `LIKE '%…%'` 用 `replaceAll('%', '')` 转成前缀比较。
 *
 * 于是两个真实缺陷被假件完全遮住：
 * 1. `writeFile` 的 INSERT 从来没写 `parent` 列 → 真实 SQLite 上写完
 *    `/notes/a.md` 之后 `listDir('/notes')` 永远返回 `[]`；
 * 2. `remove` / `move` 的 `LIKE` 没转义 → `remove('/my_notes')` 会把
 *    `/myxnotes/b.md` 一起删掉（`_` 是 LIKE 的任意单字符通配符）。
 *
 * 假件让 644 个测试全绿，而线上这两个功能是坏的。所以这里的铁律是：
 * **存储层测试只准跑真实 SQL**。SQL 规则（`{表名}` 展开、PRAGMA 被拒、
 * batch 事务）由 `src/store/sqlite-test-db.ts` 复刻线上实现。
 */
import { describe, expect, it } from 'vitest'
import type { ScopedR2 } from '@qqbot/sdk'
import { createVfsWorkspace, descendantLikePattern } from './store.js'
import { createTestDb } from '../../store/sqlite-test-db.js'

/** 内存版 R2（只存文本）。R2 本身不是本测试要验证的对象，D1 那一侧才是 */
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
    async get() {
      return null
    },
    async getJSON() {
      return null
    },
    async getStream() {
      return null
    },
    async head() {
      return null
    },
    async list() {
      return []
    },
  } as unknown as ScopedR2
}

describe('VFS 工作区（真实 SQLite）', () => {
  it('写入后能读回内容', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/notes/a.md', '你好世界')
    const file = await ws.readFile('/notes/a.md')
    expect(file.content).toBe('你好世界')
    expect(file.path).toBe('/notes/a.md')
    t.close()
  })

  it('写入时自动创建父目录', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/a/b/c.md', 'x')
    const root = await ws.listDir('/')
    expect(root.map((e) => e.name)).toContain('a')
    const a = await ws.listDir('/a')
    expect(a.map((e) => e.name)).toContain('b')
    t.close()
  })

  /**
   * P0 回归：`writeFile` 的 INSERT 以前**没写 parent 列**。
   *
   * 真实 SQLite 上 `parent` 取表默认值 `'/'`，于是 `listDir('/notes')` 永远是空——
   * 模型写完文件后在目录里找不到它。手写内存假件自己算 parent，所以这条一直测不出来。
   */
  it('写入的文件出现在它的父目录里（parent 列必须写对）', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/notes/a.md', 'hello')

    const listed = await ws.listDir('/notes')
    expect(listed.map((entry) => entry.path)).toEqual(['/notes/a.md'])
    expect(listed[0]?.kind).toBe('file')

    // 库里那一行的 parent 也得是真实父路径（不是建表默认值 '/'）
    const row = t.raw
      .prepare(t.scope('SELECT path, parent FROM {vfs_entries} WHERE path = ?'))
      .get('/notes/a.md') as { path: string; parent: string }
    expect(row.parent).toBe('/notes')
    t.close()
  })

  it('覆盖已有文件时 parent 仍然正确', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/notes/a.md', 'v1')
    await ws.writeFile('/notes/a.md', 'v2')
    expect(await ws.listDir('/notes')).toHaveLength(1)
    expect((await ws.readFile('/notes/a.md')).content).toBe('v2')
    t.close()
  })

  it('超过 8KB 的内容走 R2，小内容留 D1', async () => {
    const t = createTestDb()
    const r2 = memoryR2()
    const ws = createVfsWorkspace(t.db, r2)
    await ws.writeFile('/small.txt', 'tiny')
    await ws.writeFile('/big.txt', 'x'.repeat(9000))

    // 大文件从 R2 读得回来
    expect((await ws.readFile('/big.txt')).content).toHaveLength(9000)
    // 小文件不占 R2
    expect(await r2.getText('vfs/big.txt')).not.toBeNull()
    expect(await r2.getText('vfs/small.txt')).toBeNull()
    t.close()
  })

  /**
   * 回归：大文件被小内容覆盖时，旧 R2 对象必须删掉。
   * 上一版把 `r2_key` 置 NULL 就完事，R2 里那份内容永远没人引用、也没人删（无界增长）。
   */
  it('大文件改成小文件时删掉旧的 R2 对象', async () => {
    const t = createTestDb()
    const r2 = memoryR2()
    const ws = createVfsWorkspace(t.db, r2)

    await ws.writeFile('/doc.txt', 'x'.repeat(9000))
    expect(await r2.getText('vfs/doc.txt')).not.toBeNull()

    await ws.writeFile('/doc.txt', 'small')

    // 内容现在在 D1，R2 里那份应该已经清掉
    expect(await r2.getText('vfs/doc.txt')).toBeNull()
    expect((await ws.readFile('/doc.txt')).content).toBe('small')
    t.close()
  })

  it('小文件改大文件时读回的是 R2 里的新内容', async () => {
    const t = createTestDb()
    const r2 = memoryR2()
    const ws = createVfsWorkspace(t.db, r2)

    await ws.writeFile('/doc.txt', 'small')
    await ws.writeFile('/doc.txt', 'y'.repeat(9000))

    expect(await r2.getText('vfs/doc.txt')).toHaveLength(9000)
    expect((await ws.readFile('/doc.txt')).content).toBe('y'.repeat(9000))
    t.close()
  })

  it('拒绝 . 与 .. 段（路径穿越）', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await expect(ws.writeFile('/a/../b.md', 'x')).rejects.toThrow('..')
    await expect(ws.writeFile('relative.md', 'x')).rejects.toThrow('必须')
    t.close()
  })

  it('拒绝写入根目录', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await expect(ws.writeFile('/', 'x')).rejects.toThrow('根目录')
    t.close()
  })

  it('读取不存在的文件时抛可读错误', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await expect(ws.readFile('/nope.md')).rejects.toThrow('不存在')
    t.close()
  })

  it('mkdir 建出的目录能列出来', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.mkdir('/empty')
    const root = await ws.listDir('/')
    expect(root.map((entry) => entry.name)).toContain('empty')
    expect(await ws.listDir('/empty')).toEqual([])
    t.close()
  })

  it('删除目录会连同内容一起删', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    await ws.writeFile('/dir/b.md', 'b')
    expect(await ws.remove('/dir')).toBe(true)
    expect(await ws.listDir('/dir')).toEqual([])
    // 库里的行也要真的没了（不能只删了元数据）
    expect(
      t.raw.prepare(t.scope('SELECT path FROM {vfs_entries} WHERE path LIKE ?')).all('/dir%'),
    ).toEqual([])
    t.close()
  })

  it('删除带 R2 大文件的目录时，R2 对象一起清掉', async () => {
    const t = createTestDb()
    const r2 = memoryR2()
    const ws = createVfsWorkspace(t.db, r2)
    await ws.writeFile('/blob/big.txt', 'x'.repeat(9000))
    expect(await r2.getText('vfs/blob/big.txt')).not.toBeNull()
    expect(await ws.remove('/blob')).toBe(true)
    expect(await r2.getText('vfs/blob/big.txt')).toBeNull()
    t.close()
  })

  it('删除不存在的路径返回 false', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    expect(await ws.remove('/nope')).toBe(false)
    t.close()
  })

  it('搜索返回命中路径与上下文片段', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/a.md', '前面一些文字 关键词 后面一些文字')
    const results = await ws.search('关键词')
    expect(results).toHaveLength(1)
    expect(results[0]?.path).toBe('/a.md')
    expect(results[0]?.snippet).toContain('关键词')
    t.close()
  })

  it('搜索空串返回空数组，不扫全表', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    expect(await ws.search('   ')).toEqual([])
    t.close()
  })
})

/**
 * P1 回归：`remove` / `move` 的 `path LIKE ?` 没转义 LIKE 元字符。
 *
 * 这些用例在手写内存假件下**永远通过**——假件把 `%` 去掉做 `startsWith` 比较，
 * 恰好等于「正确转义后」的语义。只有真实 SQLite 才能证伪。
 */
describe('VFS 路径通配符转义（真实 SQLite）', () => {
  it('descendantLikePattern 转义 % _ \\ 并拼出后代模式', () => {
    expect(descendantLikePattern('/dir')).toBe('/dir/%')
    expect(descendantLikePattern('/my_notes')).toBe('/my\\_notes/%')
    expect(descendantLikePattern('/100%')).toBe('/100\\%/%')
    expect(descendantLikePattern('/a\\b')).toBe('/a\\\\b/%')
  })

  it('remove("/my_notes") 不能误删 /myxnotes', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/my_notes/a.md', 'mine')
    await ws.writeFile('/myxnotes/b.md', 'other')

    expect(await ws.remove('/my_notes')).toBe(true)

    // 自己的没了
    await expect(ws.readFile('/my_notes/a.md')).rejects.toThrow('不存在')
    // 别人的还在——真实 SQLite 里 `_` 匹配任意单字符，不转义就会把它一起删掉
    expect((await ws.readFile('/myxnotes/b.md')).content).toBe('other')
    expect(await ws.listDir('/myxnotes')).toHaveLength(1)
    t.close()
  })

  it('remove("/a%b") 不能匹配任意中间串', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/a%b/x.md', 'x')
    await ws.writeFile('/aZZZb/y.md', 'y')

    expect(await ws.remove('/a%b')).toBe(true)
    expect((await ws.readFile('/aZZZb/y.md')).content).toBe('y')
    t.close()
  })

  it('move("/my_notes", …) 不能把 /myxnotes 当成自己的后代', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/my_notes/a.md', 'mine')
    await ws.writeFile('/myxnotes/b.md', 'other')

    await ws.move('/my_notes', '/renamed')

    expect((await ws.readFile('/renamed/a.md')).content).toBe('mine')
    // 隔壁目录原封不动
    expect((await ws.readFile('/myxnotes/b.md')).content).toBe('other')
    expect(await ws.listDir('/myxnotes')).toHaveLength(1)
    t.close()
  })

  it('remove 的 SQL 带 ESCAPE 子句（语句级契约）', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    t.sqlLog.length = 0
    await ws.remove('/dir')
    const deleteSql = t.sqlLog.find((sql) => sql.startsWith('DELETE FROM'))
    expect(deleteSql).toBeDefined()
    expect(deleteSql).toContain("ESCAPE '\\'")
    t.close()
  })
})

/**
 * vfs.move：改名 / 移动。
 *
 * 这个工具是 serverless-agent 有而插件之前缺的。没有它，模型只能
 * 「读 → 写新路径 → 删旧的」三步模拟，既费 token 又可能中途失败留下两份。
 */
describe('vfs.move（真实 SQLite）', () => {
  it('重命名文件，内容跟着走', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/note.md', '内容')
    await ws.move('/note.md', '/todo.md')
    expect(await ws.readFile('/todo.md')).toMatchObject({ content: '内容' })
    await expect(ws.readFile('/note.md')).rejects.toThrow()
    t.close()
  })

  it('移动到子目录', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/a.md', 'x')
    await ws.move('/a.md', '/archive/a.md')
    expect(await ws.readFile('/archive/a.md')).toMatchObject({ content: 'x' })
    t.close()
  })

  it('移动后文件出现在新父目录里（parent 必须跟着改）', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    await ws.move('/dir/a.md', '/moved/a.md')

    expect((await ws.listDir('/moved')).map((entry) => entry.path)).toEqual(['/moved/a.md'])
    expect(await ws.listDir('/dir')).toEqual([])
    t.close()
  })

  it('目录连同后代一起移动', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    await ws.writeFile('/dir/b.md', 'b')
    await ws.move('/dir', '/moved')
    expect(await ws.readFile('/moved/a.md')).toMatchObject({ content: 'a' })
    expect(await ws.readFile('/moved/b.md')).toMatchObject({ content: 'b' })
    // 旧目录不能再列出任何东西
    expect(await ws.listDir('/dir')).toEqual([])
    // 新目录能列出两个文件（后代的 parent 要一起改成 /moved）
    expect((await ws.listDir('/moved')).map((entry) => entry.name).sort()).toEqual(['a.md', 'b.md'])
    t.close()
  })

  it('移动带 R2 大文件的目录时，对象 key 跟着改', async () => {
    const t = createTestDb()
    const r2 = memoryR2()
    const ws = createVfsWorkspace(t.db, r2)
    await ws.writeFile('/dir/big.txt', 'x'.repeat(9000))
    await ws.move('/dir', '/moved')
    expect(await r2.getText('vfs/moved/big.txt')).not.toBeNull()
    expect((await ws.readFile('/moved/big.txt')).content).toHaveLength(9000)
    t.close()
  })

  it('目标已存在时拒绝，不覆盖用户数据', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/a.md', 'a')
    await ws.writeFile('/b.md', 'b')
    await expect(ws.move('/a.md', '/b.md')).rejects.toThrow('已存在')
    // 两份内容都还在
    expect(await ws.readFile('/a.md')).toMatchObject({ content: 'a' })
    expect(await ws.readFile('/b.md')).toMatchObject({ content: 'b' })
    t.close()
  })

  it('不能把目录移到它自己里面（会造成无限嵌套）', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await ws.writeFile('/dir/a.md', 'a')
    await expect(ws.move('/dir', '/dir/sub')).rejects.toThrow()
    t.close()
  })

  it('源不存在时报错', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await expect(ws.move('/nope.md', '/x.md')).rejects.toThrow()
    t.close()
  })

  it('不能移动根目录', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db, memoryR2())
    await expect(ws.move('/', '/x')).rejects.toThrow('根目录')
    t.close()
  })
})

/**
 * 轻量模式：不传 R2 也能用（只用 D1 存 ≤8KB 文本）。
 *
 * 这是本轮的关键改动：以前「没绑 R2 就整组 vfs 不可用」，
 * 等于把「记个笔记」这种最常见的用途绑死在重型基础设施上。
 */
describe('轻量模式（没有 R2，真实 SQLite）', () => {
  it('小文本可以正常读写，不需要 R2', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db)
    await ws.writeFile('/note.md', '记一笔')
    expect(await ws.readFile('/note.md')).toMatchObject({ content: '记一笔' })
    t.close()
  })

  it('超过 8KB 时给出可读错误，而不是让工具整体失效', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db)
    const big = 'x'.repeat(9 * 1024)
    await expect(ws.writeFile('/big.md', big)).rejects.toThrow('R2')
    t.close()
  })

  it('列表与搜索照常可用', async () => {
    const t = createTestDb()
    const ws = createVfsWorkspace(t.db)
    await ws.writeFile('/a.md', '关键词在这里')
    expect(await ws.search('关键词')).toHaveLength(1)
    expect(await ws.listDir('/')).toHaveLength(1)
    t.close()
  })
})
