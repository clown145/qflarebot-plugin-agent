/**
 * 工具开关与单工具配置
 *
 * 工具开关是**整批状态**（`disabled: [...]`），单工具配置是**某个工具的若干字段**。
 * 拆成两个端点，是因为「点开关」是高频路径，不该顺带传一遍配置从而多一次覆盖风险。
 */
import type { Route } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import { getToolSettings, setToolSettings } from '../store/d1.js'
import { normalizeToolSettings, toToolCatalog } from '../tools/catalog.js'
import { buildRegistry, hasR2 } from '../agent/run.js'
import { resolveConfig } from '../effective-config.js'

export function createToolsRoutes(): Route<AgentConfig>[] {
  return [
    {
      method: 'GET',
      path: '/api/tools',
      auth: 'admin',
      handler: async ({ ctx }) => {
        const config = await resolveConfig(ctx)
        const settings = await getToolSettings(ctx.db).catch(() => ({ disabled: [], config: {} }))
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
        const incoming = normalizeToolSettings(body)
        const current = await getToolSettings(ctx.db).catch(() => ({ disabled: [], config: {} }))

        // **按字段合并，不是整体覆盖**：页面上的「关掉一个工具」只发
        // `{ disabled: [...] }`，如果整体写回就会把工具配置（api key 那些）清空。
        // 这是最容易踩的坑——用户点一下开关，搜索 key 就没了，而且不报错。
        const merged = {
          disabled: incoming.disabled,
          config: incoming.config && Object.keys(incoming.config).length
            ? incoming.config
            : (current.config ?? {}),
        }
        await setToolSettings(ctx.db, merged)
        return Response.json({ ok: true, disabled: merged.disabled })
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

        const current = await getToolSettings(ctx.db).catch(() => ({
          disabled: [] as string[],
          config: {} as Record<string, Record<string, string>>,
        }))
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

        await setToolSettings(ctx.db, { disabled: current.disabled, config })
        return Response.json({ ok: true })
      },
    },
  ]
}
