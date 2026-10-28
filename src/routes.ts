/**
 * 插件页面与 API 路由。
 *
 * 页面是**单个 HTML 文件**（脚本样式内联），因为 QFlareBot 的桥接令牌只在
 * iframe 的第一个请求里（`?token=`），页面再加载的 JS/CSS 带不上它。
 * 详见 QFlareBot 的 docs/ui.md 第 4 条。
 */
import type { Route } from '@qqbot/sdk'
import type { AgentConfig } from './config/index.js'
import type { LLMService } from './llm/contract.js'
import { listAllSchedules, listDailyStats, listToolAudit } from './store/d1.js'
import { PAGE_HTML } from './page.js'

export function createPageRoutes(): Route<AgentConfig>[] {
  return [
    {
      method: 'GET',
      path: '/ui/*',
      auth: 'admin',
      handler: async () =>
        new Response(PAGE_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },

    {
      method: 'GET',
      path: '/api/overview',
      auth: 'admin',
      handler: async ({ ctx }) => {
        const llm = ctx.service<LLMService>('llm')

        let modelStatus: { ok: boolean; models?: string[]; error?: string }
        try {
          const list = await llm.listModels()
          modelStatus = { ok: true, models: list.map((m) => m.alias) }
        } catch (error) {
          modelStatus = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }

        // 三块数据互不依赖，并行取；任何一块失败都不该让整页挂掉
        const [stats, schedules, audits] = await Promise.all([
          listDailyStats(ctx.db, 14).catch(() => []),
          listAllSchedules(ctx.db, 50).catch(() => []),
          ctx.config.enable_audit ? listToolAudit(ctx.db, 30).catch(() => []) : Promise.resolve([]),
        ])

        return Response.json({
          config: {
            model: ctx.config.model,
            enableTools: ctx.config.enable_tools,
            enableSchedule: ctx.config.enable_schedule,
            enableVfs: ctx.config.enable_vfs,
            enableAudit: ctx.config.enable_audit,
            maxModelSteps: ctx.config.max_model_steps,
            maxToolCalls: ctx.config.max_tool_calls,
            historyLimit: ctx.config.history_limit,
            timezone: ctx.config.timezone,
          },
          modelStatus,
          stats,
          schedules: schedules.map((row) => ({
            id: row.id,
            conversation: row.conversation,
            prompt: row.prompt,
            dueAt: row.due_at,
            dueAtLocal: formatLocal(row.due_at, ctx.config.timezone),
            repeatSeconds: row.repeat_seconds,
          })),
          audits: audits.map((row) => ({
            id: row.id,
            conversation: row.conversation,
            toolName: row.tool_name,
            status: row.status,
            durationMs: row.duration_ms,
            createdAt: row.created_at,
            createdAtLocal: formatLocal(row.created_at, ctx.config.timezone),
          })),
        })
      },
    },

    {
      method: 'POST',
      path: '/api/test',
      auth: 'admin',
      handler: async ({ ctx }) => {
        const llm = ctx.service<LLMService>('llm')
        try {
          const result = await llm.ping({ alias: ctx.config.model })
          return Response.json({
            ok: result.ok,
            latencyMs: result.latency_ms,
            model: result.model,
            provider: result.provider,
            ...(result.error ? { error: result.error } : {}),
          })
        } catch (error) {
          return Response.json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    },
  ]
}

/** 把时间戳格式化成配置时区的可读字符串。时区写错时退回 ISO */
function formatLocal(epochMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(epochMs))
  } catch {
    return new Date(epochMs).toISOString()
  }
}
