/**
 * 配置、人格与连通性测试
 *
 * 页面里改配置、切默认人格、测模型连通性。
 *
 * 页面拿的是**本插件的桥接令牌**，调不了宿主的 `/admin/*`，所以配置改动写进
 * 插件自己的 KV 覆盖层（`runtime-config.ts`），运行时用 `resolveConfig()` 合并。
 */
import type { Route } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import type { LLMService } from '../llm/contract.js'
import { listPersonaBindings, setPersonaBinding } from '../persona.js'
import {
  clearConfigOverride,
  patchConfigOverride,
  readConfigOverride,
  type ConfigOverride,
} from '../runtime-config.js'
import { resolveConfig } from '../effective-config.js'
import { validateConfigField } from './config-validation.js'
import { formatLocal } from './format.js'

export function createSettingsRoutes(): Route<AgentConfig>[] {
  return [
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
  ]
}
