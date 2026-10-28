/**
 * 动态定时任务工具：模型可以自己建提醒。
 *
 * 照搬 serverless-agent 的 `src/tools/schedule/`（624 行）的**协议与语义**，
 * 但去掉了它对 Cloudflare Queues 的依赖——那边建完任务要 `AGENT_QUEUE.send()`
 * 派发，而 QFlareBot 没有 Queues binding。这里改成：任务落 D1，由插件自己的
 * cron（每分钟）扫表触发。
 *
 * 语义保留的关键点：
 * - `due_at` 用毫秒时间戳，不用 cron 表达式。模型算"三小时后"比写 cron 容易。
 * - 重复任务用 `repeat_seconds`，推进时**跳过已错过的周期**（机器人离线一天后
 *   不该补跑几十次）。
 */
import type { RegisteredTool } from './registry.js'
import { cancelSchedule, createSchedule, listSchedules } from '../store/d1.js'
import type { ReplyScene } from '../types.js'
import { isValidTimeZone } from './time.js'

interface CreateInput {
  /** 相对现在的延迟，秒。与 at 二选一 */
  delay_seconds?: number
  /** 绝对时间，ISO 8601 或 "YYYY-MM-DD HH:mm" */
  at?: string
  /** 到点时要对模型说的话（会作为一条用户消息重新进入 agent） */
  prompt: string
  /** 重复间隔，秒。不填就是一次性任务 */
  repeat_seconds?: number
}

interface ListInput {
  limit?: number
}

interface CancelInput {
  id: string
}

const MAX_DELAY_SECONDS = 365 * 24 * 3600

export function createScheduleTools(): RegisteredTool[] {
  return [createScheduleTool(), listSchedulesTool(), cancelScheduleTool()]
}

function createScheduleTool(): RegisteredTool {
  return {
    definition: {
      name: 'schedule.create',
      description:
        '创建一个定时任务。到点后你会收到 prompt 里的话并据此回复。' +
        '支持一次性提醒与重复任务。只能给当前会话创建。',
      parameters: {
        type: 'object',
        properties: {
          delay_seconds: {
            type: 'integer',
            description: '从现在起多少秒后触发。例如「10 分钟后」传 600。与 at 二选一',
            minimum: 60,
            maximum: MAX_DELAY_SECONDS,
          },
          at: {
            type: 'string',
            description:
              '绝对触发时间，ISO 8601（如 2026-10-29T09:00:00+08:00）或 "YYYY-MM-DD HH:mm"。与 delay_seconds 二选一',
          },
          prompt: {
            type: 'string',
            description: '到点时要提醒的内容。写成一句完整的话，比如「提醒用户喝水」',
          },
          repeat_seconds: {
            type: 'integer',
            description: '重复间隔（秒）。不填就是一次性。例如每天早上 9 点传 86400',
            minimum: 60,
          },
        },
        required: ['prompt'],
      },
      sideEffect: 'workspace_write',
      timeoutMs: 5_000,
      requires: 'schedule',
    },

    execute: async (input, context) => {
      const parsed = input as Partial<CreateInput>
      if (!parsed?.prompt?.trim()) {
        return fail('bad_request', '缺少 prompt')
      }

      const now = Date.now()
      let dueAt: number

      if (typeof parsed.delay_seconds === 'number') {
        if (parsed.delay_seconds < 60) return fail('bad_request', '延迟不能少于 60 秒')
        if (parsed.delay_seconds > MAX_DELAY_SECONDS) return fail('bad_request', '延迟不能超过一年')
        dueAt = now + parsed.delay_seconds * 1000
      } else if (parsed.at) {
        const parsedTime = parseAbsoluteTime(parsed.at, context.timezone)
        if (parsedTime === null) return fail('bad_request', `无法解析时间：${parsed.at}`)
        if (parsedTime <= now) return fail('bad_request', '指定的时间已经过去了')
        dueAt = parsedTime
      } else {
        return fail('bad_request', 'delay_seconds 与 at 必须给一个')
      }

      const id = crypto.randomUUID()
      await createSchedule(context.db, {
        id,
        conversation: context.conversation,
        scene: context.scene as ReplyScene,
        targetId: context.targetId,
        prompt: parsed.prompt.trim(),
        dueAt,
        ...(parsed.repeat_seconds ? { repeatSeconds: parsed.repeat_seconds } : {}),
        createdBy: context.userId,
      })

      return {
        status: 'success',
        output: {
          id,
          dueAt: new Date(dueAt).toISOString(),
          dueAtLocal: formatLocal(dueAt, context.timezone),
          repeatSeconds: parsed.repeat_seconds ?? null,
        },
      }
    },
  }
}

function listSchedulesTool(): RegisteredTool {
  return {
    definition: {
      name: 'schedule.list',
      description: '列出当前会话里所有还没触发的定时任务。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
      },
      sideEffect: 'none',
      timeoutMs: 5_000,
      requires: 'schedule',
    },

    execute: async (input, context) => {
      const limit = (input as Partial<ListInput>)?.limit ?? 20
      const rows = await listSchedules(context.db, context.conversation, limit)
      return {
        status: 'success',
        output: rows.map((row) => ({
          id: row.id,
          prompt: row.prompt,
          dueAtLocal: formatLocal(row.due_at, context.timezone),
          repeatSeconds: row.repeat_seconds,
        })),
      }
    },
  }
}

function cancelScheduleTool(): RegisteredTool {
  return {
    definition: {
      name: 'schedule.cancel',
      description: '取消一个定时任务。先用 schedule.list 拿到 id。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'schedule.list 返回的 id' } },
        required: ['id'],
      },
      sideEffect: 'workspace_write',
      timeoutMs: 5_000,
      requires: 'schedule',
    },

    execute: async (input, context) => {
      const id = (input as Partial<CancelInput>)?.id
      if (!id) return fail('bad_request', '缺少 id')

      const cancelled = await cancelSchedule(context.db, id, context.conversation)
      if (!cancelled) return fail('not_found', '没有找到这个任务，或者它已经不在活动状态')
      return { status: 'success', output: { id, cancelled: true } }
    },
  }
}

/**
 * 解析绝对时间。
 *
 * 支持两种：
 * - 带时区的 ISO 8601（`2026-10-29T09:00:00+08:00`）——直接交给 Date
 * - 不带时区的 `YYYY-MM-DD HH:mm`——按配置时区解释
 *
 * 第二种要自己算，因为 `new Date("2026-10-29 09:00")` 在 Workers 里按 UTC 解析，
 * 用户以为说的是本地时间，会差 8 小时。
 */
export function parseAbsoluteTime(input: string, timezone: string): number | null {
  const trimmed = input.trim()

  const withZone = Date.parse(trimmed)
  if (!Number.isNaN(withZone) && /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return withZone
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed)
  if (!match) {
    return Number.isNaN(withZone) ? null : withZone
  }

  const [, y, mo, d, h, mi, s] = match
  if (!isValidTimeZone(timezone)) {
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
  }

  return zonedTimeToEpoch(
    Number(y),
    Number(mo),
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
    timezone,
  )
}

/**
 * 把"某时区的某个墙上时间"换算成 epoch 毫秒。
 *
 * 做法：先按 UTC 造一个候选值，再用 `Intl` 反查该时区在那一刻的偏移，修正一次。
 * 夏令时切换的边界情况可能差一小时，但对提醒类任务够用。
 */
export function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timezone: string,
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second)
  const offset = timezoneOffsetMs(utcGuess, timezone)
  return utcGuess - offset
}

function timezoneOffsetMs(epochMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - epochMs
}

export function formatLocal(epochMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(epochMs))
  } catch {
    return new Date(epochMs).toISOString()
  }
}

function fail(code: string, message: string) {
  return { status: 'failed' as const, error: { code, message, retryable: false } }
}
