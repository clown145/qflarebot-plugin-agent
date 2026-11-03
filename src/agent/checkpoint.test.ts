import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext } from '@qqbot/sdk/testing'
import plugin from '../index.js'
import { defaultConfig, type AgentConfig } from '../config/index.js'
import { makeObject } from '../do/agent-test-object.js'
import { LEASE_MS } from '../do/agent-object.js'
import { createTestDb } from '../store/sqlite-test-db.js'
import { deleteSkill, upsertSkill } from '../skills/store.js'
import { executeRun } from './run.js'
import { runAgentLoop, LoopYieldError, type LoopCheckpoint, type LoopOptions } from './loop.js'
import { createToolRegistry } from '../tools/registry.js'
import type { LLMChatRequest, LLMChatResult, LLMService } from '../llm/contract.js'
import type { InboundMessage } from '../types.js'
import type { RegisteredTool } from '../tools/types.js'

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
const logger = { info() {}, debug() {}, warn() {}, error() {} }
const message: InboundMessage = { conversation: 'group:g1', userId: 'u1', userName: '小明', memberRole: 'admin', scene: 'group', targetId: 'g1', text: '提醒我喝水', displayText: '提醒我喝水', attachments: [], receivedAt: 1 }
const result = (extra: Partial<LLMChatResult> = {}): LLMChatResult => ({ text: '完成', alias: 'chat', provider: 'fake', model: 'fake', latency_ms: 1, ...extra })

function llmWith(chat: LLMService['chat']): LLMService {
  return { chat, resolve: async () => ({ alias: 'chat', provider: 'fake', provider_name: 'fake', model: 'fake', capabilities: ['text', 'tools'] }) } as LLMService
}

describe('长任务分段执行', () => {
  it('预算耗尽后从工具结果接续，不重复创建提醒，累计步数和用量保持', async () => {
    const store = createTestDb(); cleanup.push(() => store.close())
    const { obj: agent, storage } = makeObject()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const chat = vi.fn(async (_request: LLMChatRequest) => {
      now += 10_000
      return chat.mock.calls.length === 1
        ? result({
          text: '',
          tool_calls: [{ id: 'create-1', name: 'schedule.create', arguments: JSON.stringify({ delay_seconds: 60, prompt: '喝水' }) }],
          thought_signatures: [{ part_index: 0, part_kind: 'function_call', signature: 'gemini-signature', tool_call_id: 'create-1', tool_name: 'schedule.create' }],
          usage: { input_tokens: 10 },
        })
        : result({ usage: { input_tokens: 20 } })
    })
    const llm = llmWith(chat)
    const config = { ...defaultConfig, enable_schedule: true, enable_vfs: false, enable_skills: true, expose_datetime: true }
    const ctx = createMockContext<AgentConfig>(plugin, { config, db: store.db, services: { llm } })
    await upsertSkill(store.db, { id: 'reminders', content: '---\ndescription: 创建提醒\n---\n按用户要求创建提醒。' })
    const input = { ...message, text: '/skill reminders 提醒我喝水' }
    const reply = vi.fn(async () => true)
    const claimed = await agent.submit(input)
    const deps = { ctx, config, logger, llm, agent, reply }
    expect(await executeRun({ ...deps, leaseId: claimed.leaseId, deadline: now + 24_000 }, claimed.runId!, input)).toMatchObject({ suspended: true, replied: false })
    expect(await agent.runStatus(claimed.runId!)).toBe('pending')
    expect((await store.db.all('SELECT id FROM {schedules}')).length).toBe(1)
    expect(reply).not.toHaveBeenCalled()
    const checkpoint = await agent.checkpoint(claimed.runId!)
    expect(checkpoint).toMatchObject({
      steps: 1, usedToolCalls: 1,
      historyInput: { text: '提醒我喝水', scene: message.scene, receivedAt: message.receivedAt },
    })
    // 恢复时技能已不存在，也必须按检查点里的首次正文写历史。
    await deleteSkill(store.db, 'reminders')
    // 重建 DO 实例、重新认领，模拟下一次 cron 的独立调用。
    const restarted = makeObject().obj
    Object.assign(restarted, { ctx: { storage } })
    const resumed = await restarted.poll()
    expect(resumed.runId).toBe(claimed.runId)
    const saveCheckpoint = vi.spyOn(restarted, 'saveCheckpoint')
    expect(await executeRun({ ...deps, agent: restarted, leaseId: resumed.leaseId, deadline: now + 55_000 }, resumed.runId!, resumed.message!)).toMatchObject({ ok: true })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1]?.[0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'create-1' })]))
    const resumedMessages = chat.mock.calls[1]![0].messages
    expect(resumedMessages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'create-1' })
    expect(resumedMessages.find(message => message.role === 'assistant' && message.tool_calls?.length)).toMatchObject({
      tool_calls: [{ id: 'create-1', name: 'schedule.create', arguments: JSON.stringify({ delay_seconds: 60, prompt: '喝水' }) }],
      thought_signatures: [{ part_index: 0, part_kind: 'function_call', signature: 'gemini-signature', tool_call_id: 'create-1', tool_name: 'schedule.create' }],
    })
    expect((await store.db.all('SELECT id FROM {schedules}')).length).toBe(1)
    expect(saveCheckpoint.mock.calls.at(-1)?.[1].result).toMatchObject({ steps: 2, toolCalls: 1, usage: { inputTokens: 30 } })
    expect(await restarted.checkpoint(resumed.runId!)).toBeNull()
    expect(reply).toHaveBeenCalledTimes(1)
    const nextMessage = { ...message, text: '继续', receivedAt: now }
    const next = await restarted.submit(nextMessage)
    expect(await executeRun({ ...deps, agent: restarted, leaseId: next.leaseId }, next.runId!, nextMessage)).toMatchObject({ ok: true })
    const originalUser = chat.mock.calls[0]![0].messages.find(message => message.role === 'user')
    const replayedUser = chat.mock.calls[2]![0].messages.find(message => message.role === 'user')
    expect(replayedUser).toEqual(originalUser)
    expect(replayedUser?.content).not.toContain('/skill')
  })

  it('租约接管后旧执行者不能续租、保存进度或提交历史', async () => {
    const { obj: agent } = makeObject()
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now)
    const first = await agent.submit(message)
    now += LEASE_MS + 1
    const second = await agent.poll()
    expect(second.runId).toBe(first.runId)
    expect(second.leaseId).not.toBe(first.leaseId)
    expect(await agent.renewLease(first.runId!, first.leaseId)).toBe(false)
    expect(await agent.saveCheckpoint(first.runId!, {} as LoopCheckpoint, first.leaseId)).toBe(false)
    await agent.release(first.runId!, { ok: true, leaseId: first.leaseId, history: [{ role: 'assistant', content: '迟到的回复', toolCallsJson: null, createdAt: now }] })
    expect(await agent.history(20)).toEqual([])
    expect(await agent.ownsLease(second.runId!, second.leaseId!)).toBe(true)
  })

  it('让出的任务仍可 /stop，恢复不能越过更早的任务', async () => {
    const { obj: agent } = makeObject()
    const first = await agent.submit(message)
    await agent.saveCheckpoint(first.runId!, {} as LoopCheckpoint, first.leaseId)
    await agent.submit({ ...message, text: '第二条' })
    await agent.suspend(first.runId!, first.leaseId)
    expect((await agent.poll()).runId).toBe(first.runId)
    const current = await agent.checkpoint(first.runId!)
    expect(current).toBeDefined()
    // 再让出后停止，下一次只认领第二条。
    await agent.suspend(first.runId!)
    expect(await agent.stop()).toEqual({ stopped: true })
    expect((await agent.poll()).message?.text).toBe('第二条')
  })
})

describe('中断点恢复语义', () => {
  function options(sideEffect: RegisteredTool['definition']['sideEffect']) {
    const execute = vi.fn(async () => ({ status: 'success' as const, output: 'ok' }))
    const tool: RegisteredTool = { source: { type: 'builtin', id: 'test', name: 'test' }, definition: { name: 'test', description: 'test', inputSchema: {}, permission: { level: 1, scopes: [] }, sideEffect, timeoutMs: 1_000 }, execute }
    const chat = vi.fn(async () => chat.mock.calls.length === 1
      ? result({ text: '', tool_calls: [{ id: 'one', name: 'test', arguments: '{}' }, { id: 'two', name: 'test', arguments: '{}' }] })
      : result())
    const base: LoopOptions = {
      llm: llmWith(chat), registry: createToolRegistry([tool]), logger, model: 'chat', messages: [{ role: 'user', content: '做两次' }], maxModelSteps: 3, maxToolCalls: 3, requestTimeoutMs: 20_000,
      toolContext: { db: { all: async () => [] } as never, logger, conversationId: 'g', actorId: 'u', actorRole: 'admin', scene: 'group', targetId: 'g', runId: 'r', stepId: 's', timezone: 'UTC' },
    }
    return { base, execute, chat }
  }

  it('第一个工具结果保存后中断，只执行第二个工具并保留完整调用配对', async () => {
    const { base, execute, chat } = options('workspace_write')
    let saved: LoopCheckpoint | undefined
    await expect(runAgentLoop({ ...base, onCheckpoint: async state => {
      saved = structuredClone(state)
      if (state.toolTraces.length === 1) throw new Error('模拟进程中断')
    } })).rejects.toThrow('模拟进程中断')
    await runAgentLoop({ ...base, checkpoint: saved })
    expect(execute).toHaveBeenCalledTimes(2)
    const messages = chat.mock.calls.length
    expect(messages).toBe(2)
    expect(saved?.messages.find(m => m.role === 'assistant')?.role).toBe('assistant')
  })

  it.each(['external_write', 'workspace_write', 'dangerous'] as const)('执行中的 %s 工具结果未知时不自动重试', async sideEffect => {
    const { base, execute } = options(sideEffect)
    let saved: LoopCheckpoint | undefined
    await expect(runAgentLoop({ ...base, onCheckpoint: async state => {
      saved = structuredClone(state)
      if (state.inFlight) throw new Error('模拟进程中断')
    } })).rejects.toThrow('模拟进程中断')
    await expect(runAgentLoop({ ...base, checkpoint: saved })).rejects.toThrow('结果尚未确认')
    expect(execute).not.toHaveBeenCalled()
  })

  it('只读工具可恢复重试，完成的模型结果无需再次生成', async () => {
    const { base, execute, chat } = options('none')
    let saved: LoopCheckpoint | undefined
    await expect(runAgentLoop({ ...base, onCheckpoint: async state => {
      saved = structuredClone(state)
      if (state.inFlight) throw new Error('模拟进程中断')
    } })).rejects.toThrow('模拟进程中断')
    const completed = await runAgentLoop({ ...base, checkpoint: saved, onCheckpoint: async state => { saved = structuredClone(state) } })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(await runAgentLoop({ ...base, checkpoint: saved })).toEqual(completed)
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('跨预算恢复仍只重试一次模型调用，不会每次恢复都重置重试额度', async () => {
    const { base } = options('none')
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const chat = vi.fn(async () => {
      now += 20_000
      throw Object.assign(new Error('timeout'), { code: 'timeout' })
    })
    let saved: LoopCheckpoint | undefined
    const run = () => runAgentLoop({ ...base, llm: llmWith(chat), checkpoint: saved, deadline: now + 24_000,
      retry: { times: 1, delayMs: 0 }, onCheckpoint: async state => { saved = structuredClone(state) } })
    await expect(run()).rejects.toBeInstanceOf(LoopYieldError)
    await expect(run()).rejects.toThrow('timeout')
    expect(chat).toHaveBeenCalledTimes(2)
  })
})
