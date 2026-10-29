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
import {
  getToolSettings,
  listAllSchedules,
  listDailyStats,
  setToolSettings,
  listToolAudit,
} from './store/d1.js'
import { normalizeToolSettings, toToolCatalog } from './tools/catalog.js'
import { buildRegistry, hasR2 } from './agent/run.js'
import {
  deleteSkill,
  getSkill,
  getSkillMarkdown,
  listSkills,
  upsertSkill,
} from './skills/store.js'
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
        const [stats, schedules, audits, bindings, toolSettings, skillList] = await Promise.all([
          listDailyStats(ctx.db, 14).catch(() => []),
          listAllSchedules(ctx.db, 50).catch(() => []),
          ctx.config.enable_audit ? listToolAudit(ctx.db, 30).catch(() => []) : Promise.resolve([]),
          listPersonaBindings(ctx.db, 50).catch(() => []),
          getToolSettings(ctx.db).catch(() => ({ disabled: [] as string[] })),
          listSkills(ctx.db).catch(() => []),
        ])

        // 工具栏要**未过滤**的完整列表：关掉的工具也得出现，否则页面上
        // 再也点不到「重新开启」。这里同步建一次 registry（buildRegistry 是纯函数、
        // 不碰网络），r2 探测用 false 代替——页面只需要工具清单与权限级别，
        // 而真实探测一次要多一个 R2 往返。
        const catalogTools = toToolCatalog(
          buildRegistry(ctx, config, false).list(),
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

    // ---------------------------------------------------------------- 工具栏
    //
    // 返回**未过滤**的完整工具列表：被关掉的工具也要出现，否则页面上就再也
    // 点不到「重新开启」了。`enabled` 字段区分开关状态。
    {
      method: 'GET',
      path: '/api/tools',
      auth: 'admin',
      handler: async ({ ctx }) => {
        const config = await resolveConfig(ctx)
        const settings = await getToolSettings(ctx.db).catch(() => ({ disabled: [] }))
        const r2Ready = config.enable_tools && config.enable_vfs ? await hasR2(ctx) : false
        const tools = buildRegistry(ctx, config, r2Ready).list()
        return Response.json({
          ok: true,
          tools: toToolCatalog(tools, settings),
          disabled: settings.disabled,
        })
      },
    },

    {
      method: 'POST',
      path: '/api/tools',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
        }
        // normalizeToolSettings 吃任何形状（裸数组 / {disabled:[...]} / 垃圾），
        // 页面传错不会 500——最差情况是「什么都没关」
        const settings = normalizeToolSettings(body)
        await setToolSettings(ctx.db, settings)
        return Response.json({ ok: true, disabled: settings.disabled })
      },
    },

    // ---------------------------------------------------------------- 技能
    {
      method: 'GET',
      path: '/api/skills',
      auth: 'admin',
      handler: async ({ ctx }) => {
        const skills = await listSkills(ctx.db).catch(() => [])
        return Response.json({ ok: true, skills })
      },
    },

    {
      method: 'GET',
      path: '/api/skills/:id',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        // assertSkillId 遇到非法 id 会抛，所以这里要 catch：
        // 一个乱填的 URL 不该打出 500
        try {
          const id = params['id'] ?? ''
          const [skill, content] = await Promise.all([
            getSkill(ctx.db, id),
            getSkillMarkdown(ctx.db, id),
          ])
          // content 是**原始 SKILL.md**（含 frontmatter），给编辑框用；
          // skill 是解析后的字段，给「只读展示」用。两者都返回，
          // 页面就不必再猜要不要自己拼 frontmatter。
          return skill
            ? Response.json({ ok: true, skill, content })
            : Response.json({ ok: false, error: '技能不存在' }, { status: 404 })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    },

    {
      method: 'POST',
      path: '/api/skills',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        let body: { id?: unknown; content?: unknown }
        try {
          body = (await request.json()) as { id?: unknown; content?: unknown }
        } catch {
          return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
        }
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const content = typeof body.content === 'string' ? body.content : ''
        if (!id || !content) {
          return Response.json({ ok: false, error: '缺少 id 或 content' }, { status: 400 })
        }
        // 校验错误（id 非法 / 超 32KB / 缺 description）直接把消息回给页面，
        // 运维当场知道写漏了什么，而不是等某次对话才发现技能「消失」
        try {
          const skill = await upsertSkill(ctx.db, { id, content })
          return Response.json({ ok: true, skill })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    },

    {
      method: 'DELETE',
      path: '/api/skills/:id',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        try {
          const removed = await deleteSkill(ctx.db, params['id'] ?? '')
          return removed
            ? Response.json({ ok: true })
            : Response.json({ ok: false, error: '技能不存在' }, { status: 404 })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
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
    max_context_tokens: [1000, 200000],
    rate_limit_per_minute: [0, 100],
  }
  const BOOLEANS = [
    'enable_tools',
    'enable_vfs',
    'enable_schedule',
    'enable_skills',
    'enable_audit',
    'show_typing',
    'friend_needs_wake_prefix',
  ]
  const STRINGS = [
    'model',
    'system_prompt',
    'default_persona',
    'wake_prefix',
    'command_prefixes',
    'timezone',
    'search_api_key',
    'content_filter_keywords',
  ]
  /** 枚举字段：只能取这几值 */
  const ENUMS: Record<string, readonly string[]> = {
    context_compression: ['off', 'truncate', 'summary'],
  }

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
      // tools：留空 = 不限。页面传空数组是合法的，表示「这套人格不能用任何工具」
      if (persona['tools'] !== undefined) {
        if (!Array.isArray(persona['tools'])) return '人格的 tools 必须是数组'
        for (const tool of persona['tools']) {
          if (typeof tool !== 'string' || !tool.trim()) return '人格的 tools 里必须是非空字符串'
        }
      }
      // skills：与 tools 同构（留空 = 不限，[] = 一个都不给）
      if (persona['skills'] !== undefined) {
        if (!Array.isArray(persona['skills'])) return '人格的 skills 必须是数组'
        for (const skill of persona['skills']) {
          if (typeof skill !== 'string' || !skill.trim()) return '人格的 skills 里必须是非空字符串'
        }
      }
      if (
        persona['custom_error_message'] !== undefined &&
        typeof persona['custom_error_message'] !== 'string'
      ) {
        return '人格的 custom_error_message 必须是字符串'
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

  const allowed = ENUMS[key]
  if (allowed) {
    return typeof value === 'string' && allowed.includes(value)
      ? null
      : `${key} 只能是 ${allowed.join(' / ')}`
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
