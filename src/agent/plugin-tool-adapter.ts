import type {
  PluginContext,
  PluginToolDescriptor,
  PluginToolRegistry,
  ToolInvocation,
} from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import { listAllPluginTools, pluginToolFullName } from '../plugin-tools.js'
import type { PluginToolMeta } from '../plugin-tools.js'
import { loadLegacyPluginTools } from './legacy-plugin-tools.js'
import type { PermissionLevel, RegisteredTool } from '../tools/types.js'

/** 不引入 SDK 的运行时新导出，旧框架可以继续纯聊天和使用内置工具。 */
export function coreTools(ctx: PluginContext<AgentConfig>): PluginToolRegistry | null {
  try {
    const service = ctx.service<PluginToolRegistry>('core.tools')
    return service?.contractVersion === 1 &&
      typeof service.list === 'function' &&
      typeof service.invoke === 'function' &&
      typeof service.capture === 'function'
      ? service
      : null
  } catch {
    return null
  }
}

/** 常见短名保持旧开关兼容；长名称用摘要避免截断后碰撞。底层调用始终使用原始 id。 */
export async function modelToolName(tool: PluginToolDescriptor): Promise<string> {
  const legacy = `plugin.${tool.owner}.${tool.name}`
  if (legacy.length <= 64) return legacy
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tool.id))
  const suffix = [...new Uint8Array(bytes)]
    .map(n => n.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
  return `${legacy.slice(0, 47)}_${suffix}`
}

/** undefined 用于管理页目录；null 明确表示当前任务没有原始授权，不可用新的框架工具。 */
export async function loadFrameworkTools(
  ctx: PluginContext<AgentConfig>,
  invocation?: ToolInvocation | null,
): Promise<RegisteredTool[]> {
  const service = coreTools(ctx)
  if (!service) return loadLegacyPluginTools(ctx, new Set())
  let descriptors: PluginToolDescriptor[]
  let catalog: PluginToolDescriptor[]
  try {
    catalog = await service.list()
    descriptors = invocation === null ? [] : invocation ? await service.list(invocation) : catalog
  } catch (error) {
    ctx.logger.warn('框架工具目录不可用', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
  // 框架按权限过滤，Agent 再按工具开关/人格筛选。元数据由 manifest 提供，不依赖旧注册表。
  let legacy: PluginToolMeta[] = []
  try {
    legacy = await listAllPluginTools(ctx.db)
  } catch {
    /* 旧表不存在时无需迁移。 */
  }
  const modern = await Promise.all(
    descriptors.map(async descriptor => {
      const alias = pluginToolFullName(descriptor.owner, descriptor.name)
      const previous = legacy.filter(meta => meta.fullName === alias)
      const baseline = ({ none: 1, workspace_write: 2, external_write: 3, dangerous: 3 } as const)[
        descriptor.sideEffect
      ]
      return {
        compatibility: { aliases: [alias], disabled: previous.some(meta => !meta.enabled) },
        source: { type: 'plugin' as const, id: descriptor.owner, name: descriptor.owner },
        definition: {
          name: await modelToolName(descriptor),
          title: descriptor.id,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
          ...(descriptor.outputSchema ? { outputSchema: descriptor.outputSchema } : {}),
          // 框架校验真实角色；按副作用映射本地等级，保留 Agent 的只读/写入策略。
          permission: {
            level: Math.max(baseline, ...previous.map(meta => meta.level)) as PermissionLevel,
            scopes: ['plugin:use'],
            confirmationRequired: descriptor.sideEffect === 'dangerous',
          },
          frameworkPermission: descriptor.permission,
          sideEffect: descriptor.sideEffect,
          timeoutMs: descriptor.timeoutMs,
          binding: { id: descriptor.id, revision: descriptor.revision },
        },
        execute: async context => {
          if (!invocation)
            return {
              status: 'permission_denied' as const,
              error: {
                code: 'missing_invocation',
                message: '任务缺少原始用户的工具授权上下文',
                retryable: false,
              },
            }
          const result = await service.invoke(descriptor.id, context.input, {
            invocation,
            callId: `${context.runId}:${context.stepId}:${context.toolCallId}`,
            expectedRevision: descriptor.revision,
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.deadline !== undefined ? { deadline: context.deadline } : {}),
          })
          return {
            status: result.status,
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.error ? { error: result.error } : {}),
            ...(result.status === 'success' && result.artifacts?.length
              ? { artifacts: result.artifacts }
              : {}),
          }
        },
      } satisfies RegisteredTool
    }),
  )
  // 即使某个现代工具因权限被过滤，也不能从旧注册表绕回同名服务。
  const excluded = new Set(catalog.map(tool => pluginToolFullName(tool.owner, tool.name)))
  return [...modern, ...(await loadLegacyPluginTools(ctx, excluded))]
}
