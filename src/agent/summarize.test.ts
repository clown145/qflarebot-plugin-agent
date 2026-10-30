import { describe, expect, it, vi } from 'vitest'
import { summarizeForConversation } from './summarize.js'
import type { StoredSummary } from './context-size.js'
import type { LLMService } from '../llm/contract.js'
import type { Logger } from '@qqbot/sdk'
import type { SummaryInput } from '../do/agent-object.js'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** 内存版 SummaryStore，行为和 DO 一致：取走即清空、失败可放回 */
function createStore(initial?: {
  pending?: { messages: SummaryInput[]; coveredMessages: number }
  summary?: StoredSummary
}) {
  let pending = initial?.pending ?? null
  let summary = initial?.summary ?? null
  return {
    async takePendingSummary() {
      const taken = pending
      pending = null
      return taken
    },
    async saveSummary(next: StoredSummary) {
      summary = next
    },
    async restorePendingSummary(restored: { messages: SummaryInput[]; coveredMessages: number }) {
      pending = pending
        ? {
            messages: [...restored.messages, ...pending.messages],
            coveredMessages: restored.coveredMessages + pending.coveredMessages,
          }
        : restored
    },
    pendingNow: () => pending,
    summaryNow: () => summary,
  }
}

/** 假 LLM：默认返回固定摘要 */
function fakeLLM(reply: string | (() => Promise<never>) = '摘要内容'): LLMService {
  return {
    async chat() {
      if (typeof reply === 'function') return reply()
      return { text: reply, tool_calls: [] } as never
    },
  } as unknown as LLMService
}

const pendingOf = (n = 2): { messages: SummaryInput[]; coveredMessages: number } => ({
  messages: Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `第${i}条`,
  })),
  coveredMessages: n,
})

describe('summarizeForConversation', () => {
  it('没有待摘要内容时什么都不做，也不调模型', async () => {
    const store = createStore()
    const chat = vi.fn()
    const llm = { chat } as unknown as LLMService

    const wrote = await summarizeForConversation({ store, llm, model: 'chat', logger: silentLogger, existing: null })

    expect(wrote).toBe(false)
    expect(chat).not.toHaveBeenCalled()
  })

  it('正常生成：写入摘要，清空待摘要', async () => {
    const store = createStore({ pending: pendingOf() })
    const wrote = await summarizeForConversation({
      store,
      llm: fakeLLM('他们聊了天气'),
      model: 'chat',
      logger: silentLogger,
      existing: null,
    })

    expect(wrote).toBe(true)
    expect(store.summaryNow()?.content).toBe('他们聊了天气')
    expect(store.summaryNow()?.coveredMessages).toBe(2)
    expect(store.pendingNow()).toBeNull()
  })

  it('已有摘要时累积 coveredMessages，不覆盖更早的覆盖计数', async () => {
    const store = createStore({
      pending: pendingOf(3),
      summary: { content: '旧摘要', generatedAt: 1, coveredMessages: 10 },
    })
    await summarizeForConversation({
      store,
      llm: fakeLLM('新摘要'),
      model: 'chat',
      logger: silentLogger,
      existing: { content: '旧摘要', generatedAt: 1, coveredMessages: 10 },
    })

    expect(store.summaryNow()?.coveredMessages).toBe(13)
  })

  it('把旧摘要一起喂给模型（新摘要要合并，不能只管最新那批）', async () => {
    const store = createStore({ pending: pendingOf() })
    let sent = ''
    const llm = {
      async chat(request: { messages: Array<{ content: string }> }) {
        sent = request.messages.map((m) => String(m.content)).join('\n')
        return { text: '合并后的摘要', tool_calls: [] } as never
      },
    } as unknown as LLMService

    await summarizeForConversation({
      store,
      llm,
      model: 'chat',
      logger: silentLogger,
      existing: { content: '旧摘要提到了约定 X', generatedAt: 1, coveredMessages: 4 },
    })

    expect(sent).toContain('旧摘要提到了约定 X')
  })

  it('模型返回空内容：不写摘要，内容放回队列等下一轮', async () => {
    const store = createStore({ pending: pendingOf() })
    const wrote = await summarizeForConversation({
      store,
      llm: fakeLLM('   '),
      model: 'chat',
      logger: silentLogger,
      existing: null,
    })

    expect(wrote).toBe(false)
    expect(store.summaryNow()).toBeNull()
    expect(store.pendingNow()?.coveredMessages).toBe(2)
  })

  it('模型调用抛错：内容放回队列，不抛给调用方', async () => {
    const store = createStore({ pending: pendingOf() })
    const llm = {
      async chat() {
        throw new Error('上游 500')
      },
    } as unknown as LLMService

    const wrote = await summarizeForConversation({ store, llm, model: 'chat', logger: silentLogger, existing: null })

    expect(wrote).toBe(false)
    expect(store.pendingNow()?.coveredMessages).toBe(2)
  })

  it('失败时放回的内容排在更旧的位置（下次仍按时间顺序摘要）', async () => {
    const store = createStore({ pending: pendingOf(1) })
    // 第一次失败，放回
    await summarizeForConversation({
      store,
      llm: fakeLLM(() => Promise.reject(new Error('boom'))),
      model: 'chat',
      logger: silentLogger,
      existing: null,
    })
    const restored = store.pendingNow()
    expect(restored?.messages).toHaveLength(1)
    expect(restored?.messages[0]?.content).toBe('第0条')
  })
})
