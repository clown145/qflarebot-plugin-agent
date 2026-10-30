/**
 * 虚拟工作区工具。照搬 serverless-agent 的 `src/tools/vfs/`（456 行）。
 *
 * 工具清单与权限级别（与原文一致）：
 * - `vfs.read_file`   level 1 / workspace:read
 * - `vfs.list_dir`    level 1 / workspace:read
 * - `vfs.search`      level 1 / workspace:read
 * - `vfs.write_file`  level 2 / workspace:write
 * - `vfs.mkdir`       level 2 / workspace:write
 * - `vfs.delete`      level 3 / workspace:write（删除不可逆，抬高一级）
 *
 * 没搬 `vfs.command`：原文那个虚拟 shell 有 196 行解析器 + 一套命令注册，
 * 实际价值不高（模型有 read/write/list 就够），却要吃不少 CPU。
 */
import type { PluginDB, ScopedR2 } from '@qqbot/sdk'
import type { RegisteredTool, ToolResult } from '../types.js'
import { createVfsWorkspace } from './store.js'
import { normalizeVfsPath } from './path.js'

const SOURCE = { type: 'builtin' as const, id: 'vfs', name: '工作区' }

export function createVfsTools(db: PluginDB, r2?: ScopedR2): RegisteredTool[] {
  const workspace = createVfsWorkspace(db, r2)
  return [
    readFileTool(workspace),
    listDirTool(workspace),
    searchTool(workspace),
    writeFileTool(workspace),
    mkdirTool(workspace),
    moveTool(workspace),
    deleteTool(workspace),
  ]
}

function readFileTool(workspace: ReturnType<typeof createVfsWorkspace>): RegisteredTool {
  return {
    definition: {
      name: 'vfs.read_file',
      title: '读取文件',
      description: '从虚拟工作区读取一个文件的全文。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径，如 /notes/todo.md' },
        },
        required: ['path'],
      },
      permission: { level: 1, scopes: ['workspace:read'] },
      sideEffect: 'none',
      timeoutMs: 5_000,
      annotations: { readOnlyHint: true },
    },
    source: SOURCE,
    execute: async (context) => {
      const path = (context.input as { path?: string })?.path
      if (!path) return fail('bad_request', '缺少 path')
      const file = await workspace.readFile(path)
      return { status: 'success', output: file }
    },
  }
}

function listDirTool(workspace: ReturnType<typeof createVfsWorkspace>): RegisteredTool {
  return {
    definition: {
      name: 'vfs.list_dir',
      title: '列目录',
      description: '列出虚拟工作区某个目录下的文件与子目录。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径，默认 /' },
        },
      },
      permission: { level: 1, scopes: ['workspace:read'] },
      sideEffect: 'none',
      timeoutMs: 5_000,
      annotations: { readOnlyHint: true },
    },
    source: SOURCE,
    execute: async (context) => {
      const path = (context.input as { path?: string })?.path ?? '/'
      const entries = await workspace.listDir(path)
      return {
        status: 'success',
        output: entries.map((e) => ({
          name: e.name,
          kind: e.kind,
          size: e.size,
          path: e.path,
        })),
      }
    },
  }
}

function searchTool(workspace: ReturnType<typeof createVfsWorkspace>): RegisteredTool {
  return {
    definition: {
      name: 'vfs.search',
      title: '搜索工作区',
      description: '在虚拟工作区的所有文件里搜索一段文本，返回命中的路径与上下文片段。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的文本' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '默认 10' },
        },
        required: ['query'],
      },
      permission: { level: 1, scopes: ['workspace:read'] },
      sideEffect: 'none',
      timeoutMs: 10_000,
      annotations: { readOnlyHint: true },
    },
    source: SOURCE,
    execute: async (context) => {
      const input = context.input as { query?: string; limit?: number }
      if (!input?.query) return fail('bad_request', '缺少 query')
      const results = await workspace.search(input.query, input.limit ?? 10)
      return { status: 'success', output: results }
    },
  }
}

function writeFileTool(workspace: ReturnType<typeof createVfsWorkspace>): RegisteredTool {
  return {
    definition: {
      name: 'vfs.write_file',
      title: '写入文件',
      description: '把内容写入虚拟工作区的一个文件，父目录会自动创建。已存在则覆盖。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '绝对路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
      permission: { level: 2, scopes: ['workspace:write'] },
      sideEffect: 'workspace_write',
      timeoutMs: 10_000,
    },
    source: SOURCE,
    execute: async (context) => {
      const input = context.input as { path?: string; content?: string }
      if (!input?.path) return fail('bad_request', '缺少 path')
      if (typeof input.content !== 'string') return fail('bad_request', '缺少 content')
      const result = await workspace.writeFile(input.path, input.content)
      return { status: 'success', output: result }
    },
  }
}

function mkdirTool(workspace: ReturnType<typeof createVfsWorkspace>): RegisteredTool {
  return {
    definition: {
      name: 'vfs.mkdir',
      title: '创建目录',
      description: '在虚拟工作区创建一个目录（含必要的父目录）。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '绝对路径' } },
        required: ['path'],
      },
      permission: { level: 2, scopes: ['workspace:write'] },
      sideEffect: 'workspace_write',
      timeoutMs: 5_000,
    },
    source: SOURCE,
    execute: async (context) => {
      const path = (context.input as { path?: string })?.path
      if (!path) return fail('bad_request', '缺少 path')
      await workspace.mkdir(path)
      return { status: 'success', output: { path: normalizeVfsPath(path) } }
    },
  }
}

function moveTool(workspace: ReturnType<typeof createVfsWorkspace>): RegisteredTool {
  return {
    definition: {
      name: 'vfs.move',
      title: '移动或重命名',
      description:
        '把文件或目录移到新路径，也可以用来重命名。目标已存在时会失败而不是覆盖。',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '原路径（绝对路径）' },
          to: { type: 'string', description: '新路径（绝对路径）' },
        },
        required: ['from', 'to'],
      },
      permission: { level: 2, scopes: ['workspace:write'] },
      sideEffect: 'workspace_write',
      timeoutMs: 8_000,
    },
    source: SOURCE,
    execute: async (context) => {
      const input = context.input as { from?: string; to?: string }
      if (!input?.from) return fail('bad_request', '缺少 from')
      if (!input?.to) return fail('bad_request', '缺少 to')
      try {
        const result = await workspace.move(input.from, input.to)
        return { status: 'success', output: result }
      } catch (error) {
        // 目标已存在 / 要移到自己里面 这类是**可预期的用户错误**，
        // 返回可读消息而不是让它变成 run 失败
        return fail('move_failed', error instanceof Error ? error.message : String(error))
      }
    },
  }
}

function deleteTool(workspace: ReturnType<typeof createVfsWorkspace>): RegisteredTool {
  return {
    definition: {
      name: 'vfs.delete',
      title: '删除',
      description: '删除虚拟工作区里的一个文件或目录（目录会连同内容一起删）。不可恢复。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '绝对路径' } },
        required: ['path'],
      },
      // 删除不可逆，比写入抬一级
      permission: { level: 3, scopes: ['workspace:write'] },
      sideEffect: 'workspace_write',
      timeoutMs: 10_000,
      annotations: { destructiveHint: true },
    },
    source: SOURCE,
    execute: async (context) => {
      const path = (context.input as { path?: string })?.path
      if (!path) return fail('bad_request', '缺少 path')
      const removed = await workspace.remove(path)
      if (!removed) return fail('not_found', `没有这个路径：${path}`)
      return { status: 'success', output: { path, removed: true } }
    },
  }
}

function fail(code: string, message: string): ToolResult {
  return { status: 'failed', error: { code, message, retryable: false } }
}
