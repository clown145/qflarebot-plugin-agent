import { dispatch } from '@qqbot/runtime/testing'
import { describe, expect, it, vi } from 'vitest'
import { definePlugin, type PluginToolRegistry, type PluginHandlerTool } from '@qqbot/sdk'
import { createMockSession } from '@qqbot/sdk/testing'
import t2i from '@qflarebot-test/t2i'
import plugin from '../../src/index.js'
import { makeObject } from '../../src/do/agent-test-object.js'
import { setToolSettings } from '../../src/store/d1.js'
import { buildRegistry } from '../../src/agent/run.js'
import { runAgentLoop, type LoopCheckpoint } from '../../src/agent/loop.js'
import { modelToolName } from '../../src/agent/plugin-tool-adapter.js'
import type { LLMChatRequest } from '../../src/llm/contract.js'
import { config, harness, logger, result, setupIntegrationTests } from './harness.js'

setupIntegrationTests()

const schema = { type: 'object', additionalProperties: false, properties: {} }

function provider(
  name: string,
  handler: PluginHandlerTool['handler'],
  sideEffect: 'none' | 'external_write' = 'none',
  version = 1,
) {
  return definePlugin({
    name,
    tools: {
      query: {
        description: '测试能力',
        permission: 'member',
        sideEffect,
        version,
        timeoutMs: 1000,
        inputSchema: schema,
        handler,
      },
    },
  })
}

describe('真实跨插件调用', () => {
  it('真实事件入口捕获身份，Agent 调用实际 T2I 插件，并交付图片和文字', async () => {
    const network = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        }),
    )
    vi.stubGlobal('fetch', network)
    const chat = vi.fn(async (_request: LLMChatRequest) =>
      chat.mock.calls.length === 1
        ? result({
            text: '',
            tool_calls: [
              {
                id: 'render',
                name: 'plugin.t2i.render',
                arguments: JSON.stringify({ html: '<h1>你好</h1>' }),
              },
            ],
          })
        : result(),
    )
    const h = await harness(chat, [t2i])
    // T2I 声明 25 秒，聊天入口会让出到 cron；随后恢复执行同一个待调用工具。
    const session = createMockSession({
      event: 'qq.group.at_message',
      scene: 'group',
      userId: 'u1',
      targetId: 'g1',
      memberRole: 'admin',
      content: '请画一张卡片',
    })
    const report = await dispatch(session, {
      contexts: h.factory,
      registry: h.registry,
      snapshot: h.snapshot,
      logger,
      commandPrefixes: ['/'],
    })
    expect(report.errors).toEqual([])
    const claim = await h.agent.poll()
    expect(claim.message?.toolInvocation?.token).toBeTruthy()
    const restarted = makeObject().obj
    Object.assign(restarted, { ctx: { storage: h.storage } })
    expect(await h.run(h.fresh().ctx, restarted, claim, Date.now() + 55_000)).toMatchObject({
      ok: true,
    })
    expect(network).toHaveBeenCalledTimes(1)
    expect(JSON.parse(network.mock.calls[0]![1]!.body as string).html).toBe('<h1>你好</h1>')
    expect(h.reply.media).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image', base64: 'iVBORw==' }),
    )
    expect(h.reply).toHaveBeenCalledWith('完成')
    expect(JSON.stringify(chat.mock.calls)).not.toContain(claim.message!.toolInvocation!.token)
  })

  it.each(['unchanged', 'upgraded', 'disabled', 'agent_disabled'] as const)(
    '两个提供者之间恢复：%s，不重做已完成的写操作',
    async mode => {
      let now = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const write = vi.fn(
        async ({ ctx, caller, actor }: Parameters<PluginHandlerTool['handler']>[0]) => {
          expect(ctx.plugin.name).toBe('writer')
          expect(caller.plugin).toBe('agent')
          expect(actor.userId).toBe('u1')
          await ctx.db.exec('CREATE TABLE IF NOT EXISTS {records} (value TEXT)')
          await ctx.db.run('INSERT INTO {records} VALUES (?)', actor.userId)
          now += 22_000
          return { status: 'success' as const, output: '已写入' }
        },
      )
      const read = vi.fn(async ({ actor }: Parameters<PluginHandlerTool['handler']>[0]) => {
        expect(actor.userId).toBe('u1')
        expect(actor.memberRole).toBe('admin')
        return {
          status: 'success' as const,
          output: '已读取',
          artifacts: [{ type: 'image' as const, url: 'https://example.com/result.png' }],
        }
      })
      const writer = provider('writer', write, 'external_write')
      const reader = provider('reader', read)
      const chat = vi.fn(async (_request: LLMChatRequest) =>
        chat.mock.calls.length === 1
          ? result({
              text: '',
              tool_calls: [
                { id: 'write', name: 'plugin.writer.query', arguments: '{}' },
                { id: 'read', name: 'plugin.reader.query', arguments: '{}' },
              ],
            })
          : result(),
      )
      const h = await harness(chat, [writer, reader])
      const claim = await h.agent.submit(await h.authorize())
      expect(await h.run(h.ctx, h.agent, claim, now + 24_000)).toMatchObject({ suspended: true })
      expect((await h.agent.checkpoint(claim.runId!))?.toolTraces).toHaveLength(1)
      const restarted = makeObject().obj
      Object.assign(restarted, { ctx: { storage: h.storage } })
      const resumed = await restarted.poll()
      if (mode === 'disabled') h.snapshot.plugins.reader = { enabled: false }
      if (mode === 'agent_disabled') await setToolSettings(h.ctx.db, { disabled: [], enabled: [] })
      const fresh = h.fresh([
        writer,
        mode === 'upgraded' ? provider('reader', read, 'none', 2) : reader,
      ])
      const outcome = await h.run(fresh.ctx, restarted, resumed, now + 55_000)
      expect(write).toHaveBeenCalledTimes(1)
      expect(h.store.raw.prepare('SELECT * FROM p_writer_records').all()).toHaveLength(1)
      if (mode === 'unchanged') {
        expect(outcome.ok).toBe(true)
        expect(read).toHaveBeenCalledTimes(1)
        expect(h.reply.media).toHaveBeenCalledTimes(1)
        expect(chat.mock.calls[1]![0].messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ role: 'tool', tool_call_id: 'write' }),
          ]),
        )
      } else {
        expect(outcome.ok).toBe(false)
        expect(read).not.toHaveBeenCalled()
        expect(h.reply).toHaveBeenCalledWith(expect.stringContaining('已停用、权限变化或版本更新'))
      }
    },
  )

  it('崩溃后不重放结果未知的跨插件写调用', async () => {
    const write = vi.fn(async () => ({ status: 'success' as const }))
    const chat = vi.fn(async () =>
      result({
        text: '',
        tool_calls: [{ id: 'write', name: 'plugin.writer.query', arguments: '{}' }],
      }),
    )
    const h = await harness(chat, [provider('writer', write, 'external_write')])
    const inbound = await h.authorize()
    const base = {
      llm: h.llm,
      registry: await buildRegistry(
        h.ctx,
        config,
        false,
        undefined,
        undefined,
        {},
        inbound.toolInvocation,
        h.enabledTools,
      ),
      logger,
      model: 'chat',
      messages: [{ role: 'user' as const, content: '执行' }],
      maxModelSteps: 3,
      maxToolCalls: 3,
      requestTimeoutMs: 20_000,
      toolContext: {
        db: h.ctx.db,
        logger,
        conversationId: 'g1',
        actorId: 'u1',
        actorRole: 'admin' as const,
        scene: 'group',
        targetId: 'g1',
        runId: 'r1',
        stepId: '1',
        timezone: 'UTC',
      },
    }
    let saved: LoopCheckpoint | undefined
    await expect(
      runAgentLoop({
        ...base,
        onCheckpoint: async state => {
          if (state.inFlight) saved = structuredClone(state)
          if (state.toolTraces.length) throw new Error('模拟结果保存前进程退出')
        },
      }),
    ).rejects.toThrow('模拟结果保存前进程退出')
    expect(write).toHaveBeenCalledTimes(1)
    const registry = await buildRegistry(
      h.fresh().ctx,
      config,
      false,
      undefined,
      undefined,
      {},
      inbound.toolInvocation,
      h.enabledTools,
    )
    await expect(runAgentLoop({ ...base, registry, checkpoint: saved })).rejects.toThrow(
      '结果尚未确认',
    )
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('真实目录遵守 Agent 开关和人格白名单，无凭据的定时任务看不到外部工具', async () => {
    const h = await harness(
      async () => result(),
      [provider('reader', async () => ({ status: 'success' }))],
    )
    const inbound = await h.authorize()
    const build = (
      disabled?: Set<string>,
      allowed?: string[],
      invocation = inbound.toolInvocation,
    ) => buildRegistry(h.ctx, config, false, disabled, allowed, {}, invocation, h.enabledTools)
    expect((await build()).get('plugin.reader.query')).toBeDefined()
    expect(
      (await build(new Set(['plugin.reader.query']))).get('plugin.reader.query'),
    ).toBeUndefined()
    expect((await build(undefined, [])).list()).toEqual([])
    expect(
      (await buildRegistry(h.ctx, config, false, undefined, undefined, {}, null, h.enabledTools)).get(
        'plugin.reader.query',
      ),
    ).toBeUndefined()
    await setToolSettings(h.ctx.db, { disabled: ['plugin.reader.query'] })
    const chat = vi.spyOn(h.llm, 'chat').mockResolvedValue(result())
    const claim = await h.agent.submit(inbound)
    await h.run(h.ctx, h.agent, claim)
    expect(chat.mock.calls[0]![0].tools?.map(t => t.name)).not.toContain('plugin.reader.query')
  })

  it('写工具超时返回 unknown，Agent 不再让模型重试', async () => {
    const write = vi.fn(async () => new Promise<never>(() => {}))
    const p = provider('writer', write, 'external_write')
    p.tools!.query!.timeoutMs = 10
    const chat = vi.fn(async () =>
      result({
        text: '',
        tool_calls: [{ id: 'write', name: 'plugin.writer.query', arguments: '{}' }],
      }),
    )
    const h = await harness(chat, [p])
    const claim = await h.agent.submit(await h.authorize())
    expect((await h.run(h.ctx, h.agent, claim)).ok).toBe(false)
    expect(h.reply).toHaveBeenCalledWith(expect.stringContaining('结果尚未确认'))
    expect(write).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledTimes(1)
    expect((await h.agent.checkpoint(claim.runId!))?.inFlight?.name).toBe('plugin.writer.query')
  })

  it('旧注册入口保留兼容，但自报的提供者不能越过框架服务依赖', async () => {
    const h = await harness(async () => result(), [])
    const { upsertPluginTool } = await import('../../src/plugin-tools.js')
    await upsertPluginTool(h.ctx.db, 'forged', {
      name: 'query',
      description: '伪造',
      inputSchema: schema,
    })
    expect(
      (await buildRegistry(h.ctx, config, false)).list().filter(t => t.source.type === 'plugin'),
    ).toEqual([])
    const service = (await plugin.services!.agent!(
      h.ctx,
    )) as import('../../src/agent-service.js').AgentService
    await service.registerTool('forged', {
      name: 'query',
      description: '伪造',
      inputSchema: schema,
    })
    expect(
      (await buildRegistry(h.ctx, config, false)).list().filter(t => t.source.type === 'plugin'),
    ).toEqual([])
  })

  it('框架允许的写工具仍受 Agent 本地只读权限约束', async () => {
    const write = vi.fn(async () => ({ status: 'success' as const }))
    const h = await harness(async () => result(), [provider('writer', write, 'external_write')])
    const inbound = await h.authorize()
    const registry = await buildRegistry(
      h.ctx,
      config,
      false,
      undefined,
      undefined,
      {},
      inbound.toolInvocation,
      h.enabledTools,
    )
    expect(registry.get('plugin.writer.query')?.definition.permission.level).toBe(3)
    const outcome = await registry.execute('plugin.writer.query', {
      db: h.ctx.db,
      logger,
      conversationId: 'g1',
      actorId: 'u1',
      actorRole: 'member',
      scene: 'group',
      targetId: 'g1',
      runId: 'r1',
      stepId: '1',
      toolCallId: 'c1',
      input: {},
      timezone: 'UTC',
    })
    expect(outcome.status).toBe('permission_denied')
    expect(write).not.toHaveBeenCalled()
  })

  it('长名称稳定映射且没有截断碰撞', async () => {
    const owner = 'a'.repeat(48)
    const h = await harness(async () => result(), [provider(owner, async () => ({ status: 'success' }))])
    const descriptor = (await h.ctx.service<PluginToolRegistry>('core.tools').list())[0]!
    const first = await modelToolName({
      ...descriptor,
      name: 'query'.repeat(8),
      id: owner + '.one',
    })
    const second = await modelToolName({
      ...descriptor,
      name: 'query'.repeat(8),
      id: owner + '.two',
    })
    expect(first).toHaveLength(64)
    expect(first).not.toBe(second)
  })
})


it.each(['default', 'settings_unavailable'] as const)('真实聊天入口在 %s 时不向模型提供插件工具', async mode => {
  const execute = vi.fn(async () => ({ status: 'success' as const }))
  const chat = vi.fn(async (_request: LLMChatRequest) => result())
  const h = await harness(chat, [provider('reader', execute)], mode !== 'default')
  const claim = await h.agent.submit(await h.authorize())
  if (mode === 'settings_unavailable') {
    const first = h.ctx.db.first.bind(h.ctx.db)
    vi.spyOn(h.ctx.db, 'first').mockImplementation(async (sql, ...params) => {
      if (sql.includes('{tool_settings}')) throw new Error('模拟设置暂时无法读取')
      return first(sql, ...params)
    })
  }
  expect(await h.run(h.ctx, h.agent, claim)).toMatchObject({ ok: true })
  const names = chat.mock.calls[0]![0].tools?.map(tool => tool.name)
  expect(names).toContain('time.now')
  expect(names).not.toContain('plugin.reader.query')
  expect(execute).not.toHaveBeenCalled()
})
