/** 真框架注册/分发/服务解析 + 真 Agent loop/DO + SQLite；仅替代平台绑定、LLM 与网络。 */
import {
  ContextFactory,
  PluginRegistry,
  resetLifecycle,
  resetSnapshotCache,
  createEnv,
  createExecutionContext,
  unavailableApi,
  type Snapshot,
} from '@qqbot/runtime/testing'
import { afterEach, beforeEach, vi } from 'vitest'
import { definePlugin, type BotApi, type PluginContext, type PluginDefinition, type PluginToolRegistry } from '@qqbot/sdk'
import { createMockSession } from '@qqbot/sdk/testing'
import plugin from '../../src/index.js'
import { defaultConfig, type AgentConfig } from '../../src/config/index.js'
import { makeObject } from '../../src/do/agent-test-object.js'
import { createTestDb } from '../../src/store/sqlite-test-db.js'
import { setToolSettings } from '../../src/store/d1.js'
import { executeRun, type ReplyFn } from '../../src/agent/run.js'
import { modelToolName } from '../../src/agent/plugin-tool-adapter.js'
import type { LLMChatResult, LLMService } from '../../src/llm/contract.js'
import type { InboundMessage } from '../../src/types.js'

const cleanups: Array<() => void> = []

export function setupIntegrationTests() {
  beforeEach(() => {
    resetLifecycle()
    resetSnapshotCache()
  })
  afterEach(() => {
    cleanups.splice(0).forEach(f => f())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
}

export const logger = { debug() {}, info() {}, warn() {}, error() {} }
export const result = (extra: Partial<LLMChatResult> = {}): LLMChatResult => ({
  text: '完成',
  alias: 'chat',
  provider: 'test',
  model: 'test',
  latency_ms: 1,
  ...extra,
})
const message: InboundMessage = {
  conversation: 'group:g1',
  userId: 'u1',
  userName: '小明',
  memberRole: 'admin',
  scene: 'group',
  targetId: 'g1',
  text: '办好这件事',
  displayText: '办好这件事',
  attachments: [],
  receivedAt: 1,
}
export const config = {
  ...defaultConfig,
  enable_vfs: false,
  enable_schedule: false,
  enable_skills: false,
  show_typing: false,
}

export async function harness(chat: LLMService['chat'], providers: PluginDefinition<any>[], enable = true) {
  const store = createTestDb()
  cleanups.push(() => store.close())
  // D1 接口适配真实 SQLite。SQL 展开和隔离全部由框架 createScopedDB 处理。
  const db = {
    prepare(sql: string) {
      let params: never[] = []
      const statement = {
        bind(...args: unknown[]) {
          params = args as never[]
          return statement
        },
        async run() {
          const r = store.raw.prepare(sql).run(...params)
          return { success: true, results: [], meta: { changes: Number(r.changes) } }
        },
        async all() {
          return { results: store.raw.prepare(sql).all(...params), success: true, meta: {} }
        },
        async first() {
          return store.raw.prepare(sql).get(...params) ?? null
        },
      }
      return statement
    },
    async exec(sql: string) {
      store.raw.exec(sql)
      return { count: 1, duration: 0 }
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      store.raw.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        store.raw.exec('COMMIT')
        return results
      } catch (error) {
        store.raw.exec('ROLLBACK')
        throw error
      }
    },
  }
  const env = createEnv({ DB: db as unknown as D1Database })
  const { obj: agent, storage } = makeObject()
  Object.assign(env, { P_agent_Agent: { idFromName: (name: string) => name, get: () => agent } })
  const sendMessage = vi.fn<BotApi['sendMessage']>(async () => ({ ok: true, status: 200, raw: null }))
  const api = { ...unavailableApi(), sendMessage }
  const llm: LLMService = {
    chat,
    resolve: async () => ({
      alias: 'chat',
      provider: 'test',
      provider_name: 'test',
      model: 'test',
      capabilities: ['text', 'tools'],
    }),
  } as LLMService
  const llmPlugin = definePlugin({ name: 'llm-provider', services: { llm: () => llm } })
  const snapshot: Snapshot = { revision: 1, plugins: { agent: { enabled: true, config } } }
  const fresh = (nextProviders = providers) => {
    const registry = new PluginRegistry([
      plugin as PluginDefinition<any>,
      llmPlugin,
      ...nextProviders,
    ])
    const factory = new ContextFactory({
      env,
      registry,
      snapshot,
      refreshSnapshot: async () => snapshot,
      api,
      botId: env.BOT_APPID!,
      execCtx: createExecutionContext(),
    })
    return {
      registry,
      factory,
      ctx: factory.for(registry.get('agent')!) as PluginContext<AgentConfig>,
    }
  }
  const first = fresh()
  const enabledTools = new Set(enable ? await Promise.all(
    (await first.ctx.service<PluginToolRegistry>('core.tools').list()).map(modelToolName),
  ) : [])
  await setToolSettings(first.ctx.db, { disabled: [], enabled: [...enabledTools] })
  const authorize = async () => {
    first.factory.bindSession(
      createMockSession({ userId: 'u1', targetId: 'g1', scene: 'group', memberRole: 'admin' }),
    )
    return {
      ...message,
      toolInvocation: await first.ctx.service<PluginToolRegistry>('core.tools').capture(),
    }
  }
  const reply = Object.assign(
    vi.fn(async () => true),
    { media: vi.fn(async () => true) },
  ) as ReplyFn & ReturnType<typeof vi.fn>
  const run = async (
    ctx: PluginContext<AgentConfig>,
    current: typeof agent,
    claim: Awaited<ReturnType<typeof agent.poll>>,
    deadline?: number,
  ) =>
    executeRun(
      {
        ctx,
        config,
        logger,
        llm,
        agent: current,
        reply,
        leaseId: claim.leaseId,
        ...(deadline ? { deadline } : {}),
      },
      claim.runId!,
      claim.message!,
    )
  return { ...first, store, env, api, sendMessage, agent, storage, llm, snapshot, fresh, authorize, reply, run, enabledTools }
}

