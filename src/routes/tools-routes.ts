/**
 * 工具开关与单工具配置
 *
 * 工具开关是**整批状态**（`disabled` / `enabled` 名单），单工具配置是**某个工具的若干字段**。
 * 拆成两个端点，是因为「点开关」是高频路径，不该顺带传一遍配置从而多一次覆盖风险。
 */
import type { Route } from '@qqbot/sdk'
import type { ToolSettings } from '../tools/catalog.js'
import type { AgentConfig } from '../config/index.js'
import { getToolSettings, setToolSettings } from '../store/d1.js'
import { canonicalDisabledTools, normalizeToolSettings, toToolCatalog } from '../tools/catalog.js'
import { buildRegistry, hasR2 } from '../agent/run.js'
import { listAllPluginTools, setPluginToolEnabled } from '../plugin-tools.js'
import { coreTools, loadFrameworkTools } from '../agent/plugin-tool-adapter.js'
import { resolveConfig } from '../effective-config.js'

export function createToolsRoutes(): Route<AgentConfig>[] {
  return [
    {
      method: 'GET',
      path: '/api/tools',
      auth: 'admin',
      handler: async ({ ctx }) => {
        const config = await resolveConfig(ctx)
        const settings: ToolSettings = await getToolSettings(ctx.db).catch(() => ({
          disabled: [],
          enabled: [],
          config: {},
        }))
        const r2Ready = config.enable_tools && config.enable_vfs ? await hasR2(ctx) : false
        const tools = (await buildRegistry(ctx, config, r2Ready)).list()
        return Response.json({
          ok: true,
          tools: toToolCatalog(tools, settings),
          frameworkTools: { available: coreTools(ctx) !== null },
          disabled: canonicalDisabledTools(tools, settings.disabled, settings.enabled),
          enabled: settings.enabled ?? [],
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
        // 明确开启列表不能从“没有禁用”推断；旧客户端不传 enabled 时保留已有选择。
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return Response.json({ ok: false, error: '工具设置必须是对象' }, { status: 400 })
        }
        const fields = body as Record<string, unknown>
        for (const key of ['disabled', 'enabled']) {
          const value = fields[key]
          if (
            Object.hasOwn(fields, key) &&
            (!Array.isArray(value) || !value.every(name => typeof name === 'string'))
          ) {
            return Response.json({ ok: false, error: `${key} 必须是工具名数组` }, { status: 400 })
          }
        }
        const incoming = normalizeToolSettings(body)
        const current: ToolSettings = await getToolSettings(ctx.db)

        // 按字段合并开关；不能因为保存开关清空工具配置或已有明确开启名单。
        // 这是最容易踩的坑——用户点一下开关，搜索 key 就没了，而且不报错。
        const merged = {
          disabled: Object.hasOwn(fields, 'disabled') ? incoming.disabled : current.disabled,
          enabled: Object.hasOwn(fields, 'enabled') ? incoming.enabled : (current.enabled ?? []),
          config:
            incoming.config && Object.keys(incoming.config).length
              ? incoming.config
              : (current.config ?? {}),
        }
        // 与旧注册表保持一致，否则旧 disabled 标记会让现代工具无法重新开启。
        const tools = await loadFrameworkTools(ctx)
        const legacy = await listAllPluginTools(ctx.db)
        const disabled = new Set(merged.disabled)
        for (const meta of legacy) {
          const matches = tools.filter(
            tool =>
              tool.definition.name === meta.fullName ||
              tool.compatibility?.aliases.includes(meta.fullName),
          )
          if (!matches.length) continue
          const enabled =
            !disabled.has(meta.fullName) &&
            matches.some(
              tool =>
                merged.enabled?.includes(tool.definition.name) &&
                !disabled.has(tool.definition.name),
            )
          if (meta.enabled !== enabled) await setPluginToolEnabled(ctx.db, meta.fullName, enabled)
        }
        await setToolSettings(ctx.db, merged)
        return Response.json({ ok: true, disabled: merged.disabled, enabled: merged.enabled })
      },
    },

    /**
     * 保存某个工具自己的配置（如搜索的 api key）。
     *
     * 单独一个端点而不是塞进 `POST /api/tools`：开关是「整批状态」，
     * 配置是「单个工具的若干字段」，混在一起会让「点开关」这条高频路径
     * 也要传一遍配置，从而多一次覆盖风险。
     */
    {
      method: 'POST',
      path: '/api/tools/config',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        let body: { tool?: unknown; values?: unknown }
        try {
          body = (await request.json()) as { tool?: unknown; values?: unknown }
        } catch {
          return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
        }
        const tool = typeof body.tool === 'string' ? body.tool.trim() : ''
        if (!tool) {
          return Response.json({ ok: false, error: '缺少工具名' }, { status: 400 })
        }
        if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
          return Response.json({ ok: false, error: 'values 必须是对象' }, { status: 400 })
        }

        const current = await getToolSettings(ctx.db)
        const config: Record<string, Record<string, string>> = { ...(current.config ?? {}) }
        // 空字符串视为「清空这项」，直接把键删掉，不存一个空串进去
        const values: Record<string, string> = {}
        for (const [key, value] of Object.entries(body.values as Record<string, unknown>)) {
          if (typeof value !== 'string') continue
          const trimmed = value.trim()
          if (trimmed) values[key.trim()] = trimmed
        }
        if (Object.keys(values).length) config[tool] = values
        else delete config[tool]

        await setToolSettings(ctx.db, { ...current, config })
        return Response.json({ ok: true })
      },
    },
  ]
}
