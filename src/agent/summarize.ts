/**
 * `summary` 压缩模式的摘要生成（跑在 cron 里）。
 *
 * ## 为什么不在事件处理器里生成
 *
 * loop 每次压缩后要把丢掉的轮次交给摘要，但**生成**不能就地做：
 *
 * - 事件处理器有 **30 秒硬窗**（QFlareBot 的事件预算），被动回复窗口也就 5 分钟；
 * - 一次摘要就是一整次模型调用，几百毫秒到几十秒，插在回复路径上很可能把预算吃光，
 *   用户就什么都收不到 —— 比「暂时没有摘要」糟糕得多。
 *
 * cron 没有事件预算（墙钟上限 15 分钟，整轮自己控制在 20 秒），是更合适的位置。
 * AstrBot 可以在 loop 内部同步摘要，因为它常驻运行、没有这个窗口；
 * 本项目不能照搬那个位置。
 *
 * ## 失败怎么处理
 *
 * 拿不到模型 / 调用失败 / 返回空：把待摘要内容**放回去**，下一轮 cron 再试。
 * 期间对话照常用 truncate 保底，用户察觉不到异常（只是暂时没有摘要）。
 * 重试次数不设上限，但每次失败都是「放回队列尾部」——
 * 如果模型一直坏着，这些内容就一直等着，不会丢。
 */
import type { Logger } from '@qqbot/sdk'
import type { StoredSummary } from './context-size.js'
import { buildSummaryRequest, SUMMARY_INSTRUCTION } from './context-size.js'
import { callLLM } from '../llm/client.js'
import type { LLMService } from '../llm/contract.js'
import type { SummaryInput } from '../do/agent-object.js'
import type { ModelMessage } from '../types.js'

/** 摘要要用的能力（从 DO stub 抽出来，测试里给个假的即可） */
export interface SummaryStore {
  takePendingSummary(): Promise<{ messages: SummaryInput[]; coveredMessages: number } | null>
  saveSummary(summary: StoredSummary): Promise<void>
  restorePendingSummary(pending: { messages: SummaryInput[]; coveredMessages: number }): Promise<void>
}

/** 摘要超时：比正对话短。摘要失败不影响用户，宁可早点放弃留给下一轮 */
const SUMMARY_TIMEOUT_MS = 20_000

/**
 * 给一个会话生成摘要。返回值表示这一轮是否真的写了摘要。
 *
 * **不抛错**：调用方是 cron 的循环，一个会话失败不该拖累其他会话。
 */
export async function summarizeForConversation(input: {
  store: SummaryStore
  llm: LLMService
  model: string
  logger: Logger
  /** 已有摘要：新摘要要把它一起带上，否则更早的内容会被覆盖掉 */
  existing: StoredSummary | null
}): Promise<boolean> {
  const { store, llm, model, logger, existing } = input

  const pending = await store.takePendingSummary()
  if (!pending || pending.messages.length === 0) return false

  // 已有摘要 + 新丢弃的轮次，一起喂给模型：摘要要**累积**，
  // 不能只摘要最新的那批——否则更早的约定会被新摘要覆盖掉。
  const carried: ModelMessage[] = existing
    ? [{ role: 'user', content: `（已有摘要，请合并进新摘要）\n${existing.content}` }]
    : []
  const fresh: ModelMessage[] = pending.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }))

  try {
    const request = buildSummaryRequest([...carried, ...fresh])
    const response = await callLLM(llm, {
      model,
      messages: request,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      // 摘要要稳定、不要创意：低温度减少「模型自己发挥」带来的失真
      temperature: 0,
    })

    const content = response.content?.trim() ?? ''
    if (!content) {
      logger.warn('摘要返回空内容，放回队列等下一轮', { coveredMessages: pending.coveredMessages })
      await store.restorePendingSummary(pending)
      return false
    }

    await store.saveSummary({
      content,
      generatedAt: Date.now(),
      coveredMessages: (existing?.coveredMessages ?? 0) + pending.coveredMessages,
    })
    logger.info('会话摘要已更新', {
      coveredMessages: pending.coveredMessages,
      totalCovered: (existing?.coveredMessages ?? 0) + pending.coveredMessages,
      chars: content.length,
    })
    return true
  } catch (error) {
    logger.warn('摘要生成失败，放回队列等下一轮', {
      error: error instanceof Error ? error.message : String(error),
    })
    // 放回去，下一轮再试。不设重试上限：内容不该因为模型临时故障就永久丢失
    await store.restorePendingSummary(pending).catch(() => undefined)
    return false
  }
}

/** 摘要请求的提示词（导出给测试与页面说明用） */
export { SUMMARY_INSTRUCTION }
