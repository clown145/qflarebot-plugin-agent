import { describe, expect, it, vi } from 'vitest'
import type { Logger, PluginDB } from '@qqbot/sdk'
import { createToolRegistry, stringifyToolResult, toModelTools } from './registry.js'
import type { ToolExecuteInput } from './registry.js'
import type { RegisteredTool, ToolDefinition } from './types.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

function tool(name: string, overrides: Partial<ToolDefinition> = {}): RegisteredTool {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      permission: { level: 1, scopes: [] },
      sideEffect: 'none',
      timeoutMs: 1000,
      ...overrides,
    },
    source: { type: 'builtin', id: 'test', name: 'test' },
    execute: async () => ({ status: 'success', output: 'ok' }),
  }
}

function input(overrides: Partial<ToolExecuteInput> = {}): ToolExecuteInput {
  return {
    db: {} as PluginDB,
    logger,
    conversationId: 'group:g1',
    actorId: 'u1',
    actorRole: 'admin',
    scene: 'group',
    targetId: 'g1',
    runId: 'r1',
    stepId: 's1',
    toolCallId: 'c1',
    input: {},
    timezone: 'UTC',
    ...overrides,
  }
}

describe('createToolRegistry', () => {
  it('get / list 反映注册内容', () => {
    const registry = createToolRegistry([tool('a'), tool('b')])
    expect(registry.list()).toHaveLength(2)
    expect(registry.get('a')?.definition.name).toBe('a')
  })

  it('调用未知工具返回 failed，不抛异常', async () => {
    const result = await createToolRegistry([]).execute('nope', input())
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('unknown_tool')
  })

  it('工具抛异常时被兜住，转成 failed 结果', async () => {
    const registry = createToolRegistry([
      {
        ...tool('boom'),
        execute: async () => {
          throw new Error('内部炸了')
        },
      },
    ])
    const result = await registry.execute('boom', input())
    expect(result.status).toBe('failed')
    expect(result.error?.message).toContain('内部炸了')
  })

  it('工具超时被中断并返回 failed，不会挂住整个 run', async () => {
    const registry = createToolRegistry([
      {
        ...tool('slow', { timeoutMs: 20 }),
        execute: async () => {
          await new Promise((r) => setTimeout(r, 200))
          return { status: 'success', output: 'never' }
        },
      },
    ])
    const result = await registry.execute('slow', input())
    expect(result.status).toBe('failed')
    expect(result.error?.message).toContain('超时')
  })

  it('权限不足时工具根本不执行', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: 'ok' }))
    const registry = createToolRegistry([
      { ...tool('admin_only', { permission: { level: 4, scopes: [] } }), execute },
    ])
    // member 只有 level 2
    const result = await registry.execute('admin_only', input({ actorRole: 'member' }))
    expect(result.status).toBe('permission_denied')
    expect(execute).not.toHaveBeenCalled()
  })

  it('需要确认时不执行，返回 needs_confirmation', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: 'ok' }))
    const registry = createToolRegistry([
      { ...tool('danger', { sideEffect: 'dangerous' }), execute },
    ])
    const result = await registry.execute('danger', input())
    expect(result.status).toBe('needs_confirmation')
    expect(execute).not.toHaveBeenCalled()
  })

  it('allowDangerous 时危险工具照常执行', async () => {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: 'done' }))
    const registry = createToolRegistry([
      { ...tool('danger', { sideEffect: 'dangerous' }), execute },
    ])
    const result = await registry.execute('danger', input({ allowDangerous: true }))
    expect(result.status).toBe('success')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('onAudit 在成功与失败时都被调用，带耗时', async () => {
    const audits: Array<{ status: string; durationMs: number }> = []
    const registry = createToolRegistry([tool('ok')])
    await registry.execute('ok', input({ onAudit: async (e) => void audits.push(e) }))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.status).toBe('success')
    expect(typeof audits[0]?.durationMs).toBe('number')
  })

  it('权限拒绝时也记审计（排障要知道谁被拦了）', async () => {
    const audits: Array<{ status: string }> = []
    const registry = createToolRegistry([tool('x', { permission: { level: 4, scopes: [] } })])
    await registry.execute('x', input({ actorRole: 'member', onAudit: async (e) => void audits.push(e) }))
    expect(audits[0]?.status).toBe('permission_denied')
  })

  it('不传 onAudit 时不报错（审计是可选的）', async () => {
    const registry = createToolRegistry([tool('ok')])
    await expect(registry.execute('ok', input())).resolves.toMatchObject({ status: 'success' })
  })
})

describe('toModelTools', () => {
  it('转成模型能吃的形状：name / description / parameters', () => {
    const converted = toModelTools([tool('a')])
    expect(converted).toEqual([
      { name: 'a', description: 'a', parameters: { type: 'object', properties: {} } },
    ])
  })
})

describe('stringifyToolResult', () => {
  it('成功且输出是字符串时原样返回', () => {
    expect(stringifyToolResult({ status: 'success', output: 'hi' })).toBe('hi')
  })

  it('成功且输出是对象时序列化', () => {
    expect(stringifyToolResult({ status: 'success', output: { a: 1 } })).toBe('{"a":1}')
  })

  it('没有输出时返回 ok', () => {
    expect(stringifyToolResult({ status: 'success' })).toBe('ok')
  })

  it('失败时序列化错误结构，模型能读懂', () => {
    const parsed = JSON.parse(
      stringifyToolResult({
        status: 'failed',
        error: { code: 'boom', message: '炸了', retryable: false },
      }),
    )
    expect(parsed.code).toBe('boom')
    expect(parsed.message).toBe('炸了')
  })
})
