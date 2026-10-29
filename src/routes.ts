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
import { listPersonaBindings, setPersonaBinding } from './persona.js'
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
        // 同 /agent status：提供者缺失时不要把整页打成 500，而是把原因放进 modelStatus。
        // 否则面板上「插件页面 → Agent」会整页空白，看不出是 llm 插件没启用。
        let modelStatus: { ok: boolean; models?: string[]; error?: string }
        try {
          const llm = ctx.service<LLMService>('llm')
          const list = await llm.listModels()
          modelStatus = { ok: true, models: list.map((m) => m.alias) }
        } catch (error) {
          modelStatus = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }

        // 几块数据互不依赖，并行取；任何一块失败都不该让整页挂掉
        const [stats, schedules, audits, bindings] = await Promise.all([
          listDailyStats(ctx.db, 14).catch(() => []),
          listAllSchedules(ctx.db, 50).catch(() => []),
          ctx.config.enable_audit ? listToolAudit(ctx.db, 30).catch(() => []) : Promise.resolve([]),
          listPersonaBindings(ctx.db, 50).catch(() => []),
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
          // 人格与会话绑定：宿主面板只管「插件配置」，管不到「哪个会话用了哪套人格」
          personas: {
            configured: (ctx.config.personas ?? []).map((p) => p.name).filter(Boolean),
            default: ctx.config.default_persona || '',
          },
          bindings: bindings.map((row) => ({
            conversation: row.conversation,
            persona: row.persona,
            updatedAtLocal: formatLocal(row.updated_at, ctx.config.timezone),
          })),
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
      path: '/api/persona',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        // 会话管理：管理页把某个会话切到另一套人格（宿主面板没有这个概念）
        let body: { conversation?: unknown; persona?: unknown }
        try {
          body = (await request.json()) as { conversation?: unknown; persona?: unknown }
        } catch {
          return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
        }
        const conversation = typeof body.conversation === 'string' ? body.conversation.trim() : ''
        if (!conversation) return Response.json({ ok: false, error: '缺少 conversation' }, { status: 400 })

        const persona = typeof body.persona === 'string' ? body.persona.trim() : ''
        if (persona) {
          const known = (ctx.config.personas ?? []).some((item) => item.name.trim() === persona)
          if (!known) return Response.json({ ok: false, error: `没有名为 ${persona} 的人格` }, { status: 400 })
        }

        await setPersonaBinding(ctx.db, conversation, persona || undefined)
        return Response.json({ ok: true, conversation, persona: persona || null })
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
