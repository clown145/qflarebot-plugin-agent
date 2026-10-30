/**
 * 页面本身与总览
 *
 * 页面 HTML 与 `/api/overview`。
 *
 * 页面单独一个路由、且整份内联，是因为桥接令牌只在 iframe 的第一次请求里
 * （`?token=`），页面再加载的 JS/CSS 带不上它（见 docs/ui.md 第 4 条）。
 *
 * overview 把页面要的六块数据一次取回（配置、模型、人格绑定、工具、技能、统计），
 * 避免打开页面时并发六个请求、每个都要过一次鉴权。
 */
import type { Route } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import type { LLMService } from '../llm/contract.js'
import { listAllSchedules, listDailyStats, listToolAudit, getToolSettings } from '../store/d1.js'
import { toToolCatalog } from '../tools/catalog.js'
import { buildRegistry } from '../agent/run.js'
import { listSkills } from '../skills/store.js'
import { listPersonaBindings } from '../persona.js'
import { readConfigOverride } from '../runtime-config.js'
import { resolveConfig } from '../effective-config.js'
import { PAGE_HTML } from '../page.js'
import { formatLocal } from './format.js'

export function createPageRoutesPage(): Route<AgentConfig>[] {
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

        // 页面里改过的覆盖与最终生效配置（覆盖 > 插件配置）
        const override = await readConfigOverride(ctx.kv).catch(() => null)
        const config = await resolveConfig(ctx)
        const overrideKeys = override ? Object.keys(override) : []

        // 几块数据互不依赖，并行取；任何一块失败都不该让整页挂掉
        const [stats, schedules, audits, bindings, toolSettings, skillList] = await Promise.all([
          listDailyStats(ctx.db, 14).catch(() => []),
          listAllSchedules(ctx.db, 50).catch(() => []),
          ctx.config.enable_audit ? listToolAudit(ctx.db, 30).catch(() => []) : Promise.resolve([]),
          listPersonaBindings(ctx.db, 50).catch(() => []),
          getToolSettings(ctx.db).catch(() => ({ disabled: [] as string[], config: {} })),
          listSkills(ctx.db).catch(() => []),
        ])

        // 工具栏要**未过滤**的完整列表：关掉的工具也得出现，否则页面上
        // 再也点不到「重新开启」。这里同步建一次 registry（buildRegistry 是纯函数、
        // 不碰网络），r2 探测用 false 代替——页面只需要工具清单与权限级别，
        // 而真实探测一次要多一个 R2 往返。
        // **必须把 toolSettings.config 传进去**：不传的话 buildRegistry 认为
        // 没有任何工具配置，页面就永远显示「未配置」——用户填了搜索 Key，
        // 回到工具栏却看不到「已配置」，会以为没保存成功。
        const catalogTools = toToolCatalog(
          (await buildRegistry(ctx, config, false, new Set(), undefined, toolSettings.config ?? {})).list(),
          toolSettings,
        )

        return Response.json({
          config: {
            // 生效值（可能是页面覆盖后的）
            ...config,
            // 插件配置里的原值，页面用它显示「配置里是 …」并支持「恢复」
            configured: ctx.config,
            // 哪些字段被页面覆盖过（页面据这个标「已改」）
            overriddenKeys: overrideKeys,
          },
          modelStatus,
          // 人格与会话绑定：宿主面板只管「插件配置」，管不到「哪个会话用了哪套人格」
          personas: {
            configured: (config.personas ?? []).map((p) => p.name).filter(Boolean),
            default: config.default_persona || '',
            // 页面能直接改人格列表，把完整定义也带上
            list: config.personas ?? [],
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
          // 工具栏：完整清单 + 哪些被关掉
          tools: {
            list: catalogTools,
            disabled: toolSettings.disabled,
          },
          // 技能目录。页面只列 id/name/description；正文按需用 /api/skills/:id 取，
          // 避免一次把所有 SKILL.md（可能各几十 KB）全拖到页面上。
          skills: skillList,
        })
      },
    },
  ]
}
