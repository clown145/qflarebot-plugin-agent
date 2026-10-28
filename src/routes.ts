/**
 * 插件页面与 API 路由。
 *
 * 页面是**单个 HTML 文件**（脚本样式内联），因为 QFlareBot 的桥接令牌只在
 * iframe 的第一个请求里（`?token=`），页面再加载的 JS/CSS 带不上它。
 * 详见 docs/ui.md 第 4 条。
 */
import type { Route } from '@qqbot/sdk'
import type { AgentConfig } from './config/index.js'
import type { LLMService } from './llm/contract.js'
import { listDailyStats, listSchedules } from './store/d1.js'
import { PAGE_HTML } from './page.js'

export function createPageRoutes(): Route<AgentConfig>[] {
  return [
    {
      method: 'GET',
      path: '/ui/*',
      auth: 'admin',
      handler: async () =>
        new Response(PAGE_HTML, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            // auth: 'admin' 的页面由运行时加 CSP sandbox，这里不用自己加
          },
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

        const [stats, schedules] = await Promise.all([
          listDailyStats(ctx.db, 14).catch(() => []),
          listSchedules(ctx.db, '', 50).catch(() => []),
        ])

        return Response.json({
          config: {
            model: ctx.config.model,
            enableTools: ctx.config.enable_tools,
            enableSchedule: ctx.config.enable_schedule,
            enableVfs: ctx.config.enable_vfs,
            enableAudit: ctx.config.enable_audit,
            maxModelSteps: ctx.config.max_model_steps,
            historyLimit: ctx.config.history_limit,
          },
          modelStatus,
          stats,
          schedules,
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
