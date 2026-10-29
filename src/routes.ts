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
import { clearConfigOverride, patchConfigOverride, readConfigOverride, type ConfigOverride } from './runtime-config.js'
import { resolveConfig } from './effective-config.js'
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

        // 页面里改过的覆盖与最终生效配置（覆盖 > 插件配置）
        const override = await readConfigOverride(ctx.kv).catch(() => null)
        const config = await resolveConfig(ctx)
        const overrideKeys = override ? Object.keys(override) : []

        // 几块数据互不依赖，并行取；任何一块失败都不该让整页挂掉
        const [stats, schedules, audits, bindings] = await Promise.all([
          listDailyStats(ctx.db, 14).catch(() => []),
          listAllSchedules(ctx.db, 50).catch(() => []),
          ctx.config.enable_audit ? listToolAudit(ctx.db, 30).catch(() => []) : Promise.resolve([]),
          listPersonaBindings(ctx.db, 50).catch(() => []),
        ])

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
        })
      },
    },

    {
      method: 'POST',
      path: '/api/settings',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        /**
         * 页面里改任意配置项。
         *
         * 宿主面板的插件配置表单写着这些字段，但改一次要去面板、还可能忘记保存；
         * 页面这块**点一下 / 勾一下立即生效**，写进本插件 KV 的覆盖层
         * （`src/runtime-config.ts`），运行时按「覆盖 > 插件配置」合并
         * （`src/effective-config.ts`）。
         *
         * 请求体：`{ patch: { <字段>: <值> }, reset?: string[] | true }`
         * - `patch` 里值为 `null` 表示**清除该项覆盖**、回落到插件配置；
         * - `reset: true` 清空全部覆盖；`reset: ["字段", …]` 只清指定的。
         */
        let body: { patch?: unknown; reset?: unknown }
        try {
          body = (await request.json()) as { patch?: unknown; reset?: unknown }
        } catch {
          return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
        }

        // 全量重置
        if (body.reset === true) {
          await clearConfigOverride(ctx.kv)
          return Response.json({ ok: true, reset: true })
        }

        const config = await resolveConfig(ctx)
        const patch: ConfigOverride = {}

        if (body.patch !== undefined) {
          if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
            return Response.json({ ok: false, error: 'patch 必须是对象' }, { status: 400 })
          }
          for (const [key, value] of Object.entries(body.patch as Record<string, unknown>)) {
            const invalid = validateConfigField(key, value, ctx, config)
            if (invalid) return Response.json({ ok: false, error: invalid }, { status: 400 })
            // null = 清除该项覆盖
            patch[key as keyof AgentConfig] = (value === null ? undefined : value) as never
          }
        }

        // 指定字段重置
        if (Array.isArray(body.reset)) {
          for (const key of body.reset) {
            if (typeof key === 'string') patch[key as keyof AgentConfig] = undefined
          }
        }

        // 传插件配置里的原值：改回原值时自动清掉覆盖，避免页面一直标着「已改」
        const next = await patchConfigOverride(ctx.kv, patch, ctx.config)
        return Response.json({ ok: true, overriddenKeys: Object.keys(next) })
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
          const config = await resolveConfig(ctx)
          const known = (config.personas ?? []).some((item) => item.name.trim() === persona)
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
          const config = await resolveConfig(ctx)
          const result = await llm.ping({ alias: config.model })
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

/**
 * 校验页面提交的单个配置字段。
 *
 * 和面板表单是同一套约束（这里手写一遍是因为页面走的是自己的接口）：
 * 越界、类型不对、枚举不认识的值，都在保存时就拒掉——而不是等下一次对话
 * 才炸一个看不懂的错误。
 */
function validateConfigField(
  key: string,
  value: unknown,
  ctx: { service: <T>(name: string) => T; kv: unknown },
  config: AgentConfig,
): string | null {
  /** 数值字段的上下限，与 configSchema 保持一致 */
  const RANGES: Record<string, [number, number]> = {
    max_model_steps: [1, 30],
    max_tool_calls: [1, 50],
    history_limit: [0, 100],
    request_timeout_ms: [1000, 25000],
  }
  const BOOLEANS = ['enable_tools', 'enable_vfs', 'enable_schedule', 'enable_audit', 'show_typing', 'friend_needs_wake_prefix']
  const STRINGS = ['model', 'system_prompt', 'default_persona', 'wake_prefix', 'command_prefixes', 'timezone']

  if (!(key in config) && !['personas'].includes(key)) return `未知配置项：${key}`

  if (key === 'personas') {
    if (!Array.isArray(value)) return 'personas 必须是数组'
    for (const item of value) {
      if (!item || typeof item !== 'object') return 'personas 的每一项必须是对象'
      const persona = item as Record<string, unknown>
      if (typeof persona['name'] !== 'string' || !persona['name'].trim()) return '人格必须有 name'
      if (typeof persona['prompt'] !== 'string') return '人格的 prompt 必须是字符串'
      if (persona['begin_dialogs'] !== undefined && typeof persona['begin_dialogs'] !== 'string') {
        return '人格的 begin_dialogs 必须是字符串'
      }
    }
    // 名字不能重复：会话按名字绑定，重名等于绑不准
    const names = (value as Array<{ name: string }>).map((p) => p.name.trim())
    if (new Set(names).size !== names.length) return '人格名字不能重复'
    return null
  }

  if (key === 'model') {
    if (typeof value !== 'string' || !value.trim()) return 'model 不能为空'
    // 只接受真实存在的别名：手打错一个字母，运行时才炸 unknown_model 太难查
    return null
  }

  if (BOOLEANS.includes(key)) {
    return typeof value === 'boolean' ? null : `${key} 必须是布尔值`
  }

  if (STRINGS.includes(key)) {
    return typeof value === 'string' ? null : `${key} 必须是字符串`
  }

  const range = RANGES[key]
  if (range) {
    const num = value as number
    if (typeof num !== 'number' || !Number.isInteger(num)) return `${key} 必须是整数`
    if (num < range[0] || num > range[1]) return `${key} 应在 ${range[0]}–${range[1]} 之间`
    return null
  }

  return null
}
