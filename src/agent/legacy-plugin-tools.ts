/** @deprecated 只兼容已有的静态 depends 接线；新工具走 core.tools。 */
import type { PluginContext } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import type { RegisteredTool, PermissionLevel } from '../tools/types.js'
import { listAllPluginTools, sanitizeToolName } from '../plugin-tools.js'
import type { PluginToolMeta, PluginToolsService, PluginToolExecutor } from '../plugin-tools.js'

/**
 * 把其他插件注册的工具变成 RegisteredTool。
 *
 * ## 为什么要过 services
 *
 * 工具元数据（名字、描述、schema）能存 D1，但**执行函数不能** ——
 * 函数不是可序列化的值。所以元数据从库里读，函数从提供者的
 * `services` 运行时取。
 *
 * ## 服务名与 key 的映射（这里踩过两个坑）
 *
 * 1. **服务名是 `tools`，不是提供者插件名**。宿主对 `services` 的约定是
 *    `{ <服务名>: (ctx) => <对象> }`，提供者导出的是 `services: { tools: () => … }`，
 *    所以要用 `ctx.service('tools')` 取，而不是 `ctx.service(<插件名>)`。
 * 2. **对象 key 是工具短名（未规整）**。`registerTool` 时登记的名字会经过
 *    `sanitizeToolName()`（`weather.query` → `weather_query`），而 D1 里
 *    `name` 列存的就是**规整后**的短名——执行对象用的是提供者写的那份原始 key。
 *    两者不一致时按规整后的名字去取会永远取不到（`service[meta.name] === undefined`），
 *    工具静默消失。所以这里两种 key 都试：先原始、再规整。
 *
 * ## 一个**框架限制**，不要在这里假装解决
 *
 * 宿主的 `ctx.service(name)` 只认本插件 manifest 里 `depends` 声明过的服务。
 * Agent 无法为「任意第三方插件」声明依赖——`depends` 是静态清单，插件名在安装
 * 别的插件之前不可能知道。所以：
 *
 * - 第三方插件提供的工具，**只有在 Agent 的 depends 里能写死的服务名（`llm`、
 *   未来的 `tools`）才真的取得到**；
 * - 其余 owner 的 `ctx.service()` 会抛「没有在 depends 中声明服务」。
 *
 * 这里不伪造可用性：抛错时**记一次带原因日志**（而不是静默 continue），
 * 并在 docs/plugin-api.md 里如实写明限制。以前是无日志 `continue`，
 * 表现为「按文档接线了但工具就是不见」，排障时完全看不出原因。
 */
export async function loadLegacyPluginTools(
  ctx: PluginContext<AgentConfig>,
  excluded: ReadonlySet<string>,
): Promise<RegisteredTool[]> {
  let metas: PluginToolMeta[]
  try {
    metas = (await listAllPluginTools(ctx.db)).filter(meta => !excluded.has(meta.fullName))
  } catch {
    // 建表前/读失败：没有插件工具而已，不该让整轮对话失败
    return []
  }
  if (!metas.length) return []

  // 按提供者分组，每个提供者只取一次服务
  const byOwner = new Map<string, PluginToolMeta[]>()
  for (const meta of metas) {
    const list = byOwner.get(meta.owner) ?? []
    list.push(meta)
    byOwner.set(meta.owner, list)
  }

  const out: RegisteredTool[] = []
  for (const [owner, items] of byOwner) {
    const service = resolvePluginToolsService(ctx, owner)
    if (!service) continue

    let registered = 0
    for (const meta of items) {
      const execute = pickExecutor(service, meta)
      if (typeof execute !== 'function') {
        // 有元数据却没有执行函数：注册时可能写坏、或提供者改了 key。
        // 只影响这一个工具，记一条可排查的 warn（以前是静默 continue）
        ctx.logger.warn('插件工具没有对应的执行函数，已跳过', {
          owner,
          tool: meta.fullName,
          keys: Object.keys(service).slice(0, 10),
        })
        continue
      }
      out.push(toRegisteredPluginTool(meta, execute))
      registered += 1
    }

    if (registered === 0 && items.length > 0) {
      ctx.logger.warn('插件声明了工具但一个都没注册上', { owner, count: items.length })
    }
  }
  return out
}

/**
 * 取一个提供者的 `tools` 服务对象。
 *
 * 取不到就返回 null 并**记日志说明原因**：这条路径每个会话都会走，
 * 所以按 owner 做**时间窗节流**（10 分钟内只记一次），既能查到原因又不刷屏。
 *
 * 用时间窗而不是「只记一次」：结构性问题修好后（比如宿主支持了动态 depends），
 * 日志应当能重新出现；进程内永久静音会让「第一次没注意到」的人再也看不到。
 */
const pluginToolWarnAt = new Map<string, number>()
const PLUGIN_TOOL_WARN_INTERVAL_MS = 10 * 60_000

function shouldWarnPluginTool(owner: string, now: number): boolean {
  const last = pluginToolWarnAt.get(owner)
  if (last !== undefined && now - last < PLUGIN_TOOL_WARN_INTERVAL_MS) return false
  pluginToolWarnAt.set(owner, now)
  return true
}

function resolvePluginToolsService(
  ctx: PluginContext<AgentConfig>,
  owner: string,
): PluginToolsService | null {
  // 首选取约定服务名 `tools`（提供者 `services: { tools: () => … }`）。
  // 取不到再退回提供者插件名：老文档曾把服务名写成插件名，兼容它不会带来风险
  // ——两个都取不到就是「没有」，行为与以前一致。
  const candidates = ['tools', owner]
  const errors: string[] = []

  for (const name of candidates) {
    let raw: unknown
    try {
      raw = ctx.service<PluginToolsService>(name)
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (raw && typeof raw === 'object') return raw as PluginToolsService
  }

  // 框架的硬约束：depends 里没声明的服务取不到。
  // 这不是「提供者没装」的瞬时状态，而是**结构性限制**，必须能看得见——
  // 以前这里是静默 continue，表现为「按文档接线了但工具就是不见」，完全查不出原因。
  // 按 owner 做时间窗节流，避免每个会话刷一条。
  if (shouldWarnPluginTool(owner, Date.now())) {
    ctx.logger.warn(
      '第三方插件工具当前不可用：宿主只允许取 depends 里声明的服务，' +
        'Agent 无法为任意插件声明依赖（见 docs/plugin-api.md「已知限制」）',
      { owner, error: errors.join('; ') },
    )
  }
  return null
}

/**
 * 从服务对象里挑执行函数。
 *
 * 提供者写的是**原始短名**，而 D1 里的 `meta.name` 是 `sanitizeToolName()` 的
 * 结果（`weather.query` → `weather_query`）。两种 key 都要试，顺序是
 * 「原始 → 规整 → 反查（把服务对象里的 key 规整后比对）」。
 */
function pickExecutor(
  service: PluginToolsService,
  meta: PluginToolMeta,
): PluginToolExecutor | undefined {
  const direct = service[meta.name]
  if (typeof direct === 'function') return direct.bind(service)

  const sanitized = sanitizeToolName(meta.name)
  const bySanitized = service[sanitized]
  if (typeof bySanitized === 'function') return bySanitized.bind(service)

  // 最后一种：提供者用了原名（含点、空格、中文），与服务对象 key 只是一次规整之差
  for (const [key, value] of Object.entries(service)) {
    if (typeof value !== 'function') continue
    if (sanitizeToolName(key) === sanitized) return value.bind(service)
  }
  return undefined
}

/** 把一条元数据 + 执行函数包成 Agent 自己的 RegisteredTool */
function toRegisteredPluginTool(meta: PluginToolMeta, execute: PluginToolExecutor): RegisteredTool {
  return {
    source: { type: 'plugin', id: meta.owner, name: meta.owner },
    compatibility: { aliases: [], disabled: !meta.enabled },
    definition: {
      name: meta.fullName,
      title: meta.name,
      description: meta.description,
      inputSchema: meta.inputSchema,
      // 权限级别在注册时已经被抬到至少 MIN_PLUGIN_TOOL_LEVEL；
      // 这里再兜一次，防止有人直接改库把它调低
      // 用通用 scope `plugin:use`，不用 `plugin:<owner>` ——
      // 后者不在角色基线里，会让工具的 level 判定形同虚设（永远 permission_denied）。
      // 各插件的权限差异由 level 表达，不需要每个插件一个 scope。
      permission: { level: Math.max(2, meta.level) as PermissionLevel, scopes: ['plugin:use'] },
      sideEffect: meta.sideEffect,
      timeoutMs: meta.timeoutMs,
    },
    execute: async context => {
      try {
        // 超时兜底：插件工具的实现不受我们控制，可能挂住不返回。
        // 不 race 掉的话，一个坏插件能把整个 run 拖到事件超时。
        const output = await withTimeout(execute(context.input), meta.timeoutMs)
        return { status: 'success', output }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const timedOut = message.includes('超时')
        return {
          status: meta.sideEffect !== 'none' ? 'unknown' : timedOut ? 'timeout' : 'failed',
          error: {
            code: timedOut ? 'plugin_tool_timeout' : 'plugin_tool_failed',
            message: `插件 ${meta.owner} 的工具 ${meta.name} 失败：${message}`,
            // 插件内部错误是否可重试我们不知道，保守起见不可重试 ——
            // 可重试会让模型反复重试同一次失败
            retryable: false,
          },
        }
      }
    },
  }
}

/** 超时包装。`Promise.race` 不能取消底层 promise，但能让 run 继续往下走 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
