import { describe, expect, it } from 'vitest'
import type { Logger, PluginDB } from '@qqbot/sdk'
import { resolveDefaultPolicy } from './default-policy.js'
import { checkToolPolicy } from './policy-resolver.js'
import { evaluateToolPermission } from './policy.js'
import type { ToolExecutionContext, ToolDefinition } from '../tools/types.js'

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** 假 db：只响应 policies 查询 */
function fakeDb(policies: Array<{ type: string; id: string; maxLevel: number; scopes: string[] }> = []): PluginDB {
  return {
    all: async (sql: string, ...params: unknown[]) => {
      if (!sql.includes('{policies}')) return []
      const rows = policies
        .filter((p) => {
          // 粗暴匹配：policy 的 (type,id) 出现在参数里就算命中
          return params.includes(p.type) && params.includes(p.id)
        })
        .map((p) => ({
          id: `p-${p.type}-${p.id}`,
          max_level: p.maxLevel,
          scopes_json: JSON.stringify(p.scopes),
        }))
      return rows
    },
  } as unknown as PluginDB
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    db: fakeDb(),
    logger,
    conversationId: 'group:g1',
    actorId: 'u1',
    actorRole: 'member',
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

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    permission: { level: 1, scopes: [] },
    sideEffect: 'none',
    timeoutMs: 1000,
    ...overrides,
  }
}

describe('resolveDefaultPolicy（照搬原文的角色基线）', () => {
  it('群主与管理员是 level 4，几乎全开', () => {
    for (const role of ['owner', 'admin'] as const) {
      const policy = resolveDefaultPolicy(context({ actorRole: role }))
      expect(policy.maxLevel).toBe(4)
      expect(policy.scopes).toContain('http:request')
      expect(policy.scopes).toContain('schedule:write')
    }
  })

  it('普通成员是 level 2，只能读写工作区', () => {
    const policy = resolveDefaultPolicy(context({ actorRole: 'member' }))
    expect(policy.maxLevel).toBe(2)
    expect(policy.scopes).toEqual(['workspace:read', 'workspace:write', 'plugin:use'])
    expect(policy.scopes).not.toContain('http:request')
  })

  it('群里角色未知仍是 level 1，只读（保守基线不变）', () => {
    const policy = resolveDefaultPolicy(context({ actorRole: undefined, scene: 'group' }))
    expect(policy.maxLevel).toBe(1)
    expect(policy.scopes).toEqual(['workspace:read'])
  })

  // 这条以前断言「单聊也是 level 1」，那是单聊工具全废的根因：
  // 单聊没有群角色 → actorRole 兜底成 unknown → 只给只读，
  // 于是 schedule.create / http.request / vfs.write 在单聊里一律 permission_denied，
  // 连 Bot 管理员都建不出「提醒我三小时后…」。现在单聊按 1:1 信道给可用基线。
  it('单聊（c2c）没有群角色，但按 1:1 信道给 level 3 可用基线', () => {
    const policy = resolveDefaultPolicy(context({ actorRole: undefined, scene: 'c2c' }))
    expect(policy.maxLevel).toBe(3)
    expect(policy.scopes).toEqual([
      'workspace:read',
      'workspace:write',
      'schedule:read',
      'schedule:write',
      'http:request',
      'plugin:use',
    ])
  })

  it('频道私信（guild_dm）与单聊同一档', () => {
    const policy = resolveDefaultPolicy(context({ actorRole: 'unknown', scene: 'guild_dm' }))
    expect(policy.maxLevel).toBe(3)
    expect(policy.scopes).toContain('schedule:write')
  })

  it('单聊基线能真的把「提醒我」建出来（级别与 scope 都够）', async () => {
    const check = await checkToolPolicy(
      context({ actorRole: undefined, scene: 'c2c' }),
      { level: 3, scopes: ['schedule:write'] },
    )
    expect(check.allowed).toBe(true)
  })

  it('单聊基线仍不给 level 4 —— 单聊用户不是群主，不该拿到群管理那档', async () => {
    const check = await checkToolPolicy(
      context({ actorRole: undefined, scene: 'c2c' }),
      { level: 4, scopes: [] },
    )
    expect(check.allowed).toBe(false)
  })

  it('定时任务按 level 3 + owner scope 处理，否则「提醒我」会被自己拦下', () => {
    const policy = resolveDefaultPolicy(context({ actorId: 'scheduler' }))
    expect(policy.maxLevel).toBe(3)
    expect(policy.scopes).toContain('schedule:write')
  })
})

describe('checkToolPolicy', () => {
  it('级别够、scope 也有 → 允许', async () => {
    const check = await checkToolPolicy(
      context({ actorRole: 'admin' }),
      { level: 3, scopes: ['http:request'] },
    )
    expect(check.allowed).toBe(true)
  })

  it('级别不够 → 拒绝，理由里带上两个级别', async () => {
    const check = await checkToolPolicy(
      context({ actorRole: 'member' }),
      { level: 4, scopes: [] },
    )
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('4')
    expect(check.reason).toContain('2')
  })

  it('级别够但缺 scope → 拒绝，理由里点出缺哪个', async () => {
    const check = await checkToolPolicy(
      context({ actorRole: 'member' }),
      { level: 1, scopes: ['http:request'] },
    )
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('http:request')
  })

  it('D1 里的策略只能放宽：叠加后级别取最大、scope 求并', async () => {
    const ctx = context({
      actorRole: 'member',
      db: fakeDb([{ type: 'user', id: 'u1', maxLevel: 4, scopes: ['http:request'] }]),
    })
    const check = await checkToolPolicy(ctx, { level: 4, scopes: ['http:request'] })
    expect(check.allowed).toBe(true)
    expect(check.resolved.sources).toContain('policy:p-user-u1')
  })

  it('策略表读失败时退回基线，不让所有工具都不可用', async () => {
    const ctx = context({
      actorRole: 'admin',
      db: {
        all: async () => {
          throw new Error('D1 挂了')
        },
      } as unknown as PluginDB,
    })
    const check = await checkToolPolicy(ctx, { level: 3, scopes: ['http:request'] })
    expect(check.allowed).toBe(true)
  })
})

describe('evaluateToolPermission（照搬原文的三步判定）', () => {
  it('策略通过且不危险 → 允许', async () => {
    const decision = await evaluateToolPermission(tool(), context({ actorRole: 'admin' }))
    expect(decision.allowed).toBe(true)
  })

  it('level 5 在 admin（level 4）下被策略先拒——策略检查在确认之前', async () => {
    const decision = await evaluateToolPermission(
      tool({ permission: { level: 5, scopes: [] } }),
      context({ actorRole: 'admin' }),
    )
    expect(decision.allowed).toBe(false)
    // 策略不过就不提确认：先能过门槛，才谈要不要确认
    expect(decision.needsConfirmation).toBeUndefined()
  })

  it('策略通过但 level 5 时要求确认（用策略放宽到 5）', async () => {
    const ctx = context({
      actorRole: 'admin',
      db: fakeDb([{ type: 'user', id: 'u1', maxLevel: 5, scopes: [] }]),
    })
    const decision = await evaluateToolPermission(tool({ permission: { level: 5, scopes: [] } }), ctx)
    expect(decision.allowed).toBe(false)
    expect(decision.needsConfirmation).toBe(true)
  })

  it('sideEffect 为 dangerous 需要二次确认', async () => {
    const decision = await evaluateToolPermission(
      tool({ sideEffect: 'dangerous' }),
      context({ actorRole: 'admin' }),
    )
    expect(decision.needsConfirmation).toBe(true)
  })

  it('用户已确认（allowDangerous）时不再重复要求确认', async () => {
    const decision = await evaluateToolPermission(
      tool({ sideEffect: 'dangerous' }),
      context({ actorRole: 'admin', allowDangerous: true }),
    )
    expect(decision.allowed).toBe(true)
  })

  it('策略不过时不提确认，直接拒', async () => {
    const decision = await evaluateToolPermission(
      tool({ permission: { level: 4, scopes: [] } }),
      context({ actorRole: 'member' }),
    )
    expect(decision.allowed).toBe(false)
    expect(decision.needsConfirmation).toBeUndefined()
  })
})
