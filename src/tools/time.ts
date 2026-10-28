/**
 * `time.now`：当前时间。照搬 serverless-agent 的 `src/tools/time/tools.ts`（87 行）。
 *
 * 模型没有时钟，这一条看着简单但几乎每个带时间的问题都会用到
 * （"现在几点""明天是周几""三小时后提醒我"）。
 */
import type { RegisteredTool, ToolResult } from './registry.js'

export function createTimeTool(): RegisteredTool {
  return {
    definition: {
      name: 'time.now',
      description: '返回当前日期与时间，包含时区、星期几和 ISO 格式。',
      parameters: { type: 'object', properties: {} },
      sideEffect: 'none',
      timeoutMs: 1_000,
    },

    execute: async (_input, context) => {
      const now = new Date()
      const timeZone = normalizeTimeZone(context.timezone)

      try {
        const formatter = new Intl.DateTimeFormat('zh-CN', {
          timeZone,
          dateStyle: 'full',
          timeStyle: 'long',
        })
        return {
          status: 'success',
          output: {
            iso: now.toISOString(),
            epochMs: now.getTime(),
            timeZone,
            local: formatter.format(now),
            weekday: new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now),
          },
        }
      } catch {
        // 时区写错时不要整个工具挂掉，退回 UTC 并说明
        return {
          status: 'success',
          output: {
            iso: now.toISOString(),
            epochMs: now.getTime(),
            timeZone: 'UTC',
            note: `配置的时区 ${context.timezone} 无效，已按 UTC 返回`,
          },
        }
      }
    },
  }
}

/** 与 serverless-agent 的 normalizeTimeZone 同义：非法时区退回 UTC，交给 Intl 抛错兜底 */
function normalizeTimeZone(value: string | undefined): string {
  return value?.trim() || 'UTC'
}

/** 供 schedule 工具复用的时区校验 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function fail(code: string, message: string): ToolResult {
  return { status: 'failed', error: { code, message, retryable: false } }
}
