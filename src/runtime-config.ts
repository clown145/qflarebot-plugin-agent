/**
 * 页面里的配置覆盖：存哪、怎么读。
 *
 * 插件页面拿的是限定本插件的桥接令牌，调不了 `/admin/*`（实测 401），写不回面板里的
 * 插件配置。所以页面上的改动写进本插件自己的 KV，运行时用 `resolveConfig()`
 * （见 `effective-config.ts`）合并到 `ctx.config` 上得到生效配置。
 *
 * ## 存储位置
 *
 * 键名 `config:override`，宿主自动加插件前缀，落在 `p:agent:config:override`。
 * 升级/更新插件**不会**清 KV（宿主的清数据只在卸载并勾选「连数据一起清」时按前缀删，
 * 见 `packages/runtime/src/purge.ts`），所以这些设置在升级后应当保留。
 *
 * 但键名本身仍是跨版本契约：**改动键名等于丢掉用户已设好的配置**。
 * 之前就因为重构时换过键名（`model:selected` / `prompt:override` → `config:override`），
 * 让用户以为「一更新就丢」。所以现在键名固定，不再折腾。
 */
import type { PluginContext } from '@qqbot/sdk'
import type { AgentConfig } from './config/index.js'

/** 页面覆盖的唯一存储键（跨版本契约，勿改） */
const CONFIG_OVERRIDE_KEY = 'config:override'

export type ConfigOverride = Partial<AgentConfig>

/** 读页面里的配置覆盖；没有就返回 null */
export async function readConfigOverride(
  kv: PluginContext<AgentConfig>['kv'],
): Promise<ConfigOverride | null> {
  const raw = await kv.get(CONFIG_OVERRIDE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ConfigOverride
  } catch {
    // 坏数据按「没有覆盖」处理，不要让页面写坏一次就永久失效
    return null
  }
}

/** 合并写入覆盖；`undefined` 的字段表示清除覆盖、回落到插件配置 */
export async function patchConfigOverride(
  kv: PluginContext<AgentConfig>['kv'],
  patch: ConfigOverride,
  /** 插件配置里的原值；传了就能在「改回原值」时顺手清掉覆盖，避免虚标的「已改」 */
  baseline?: AgentConfig,
): Promise<ConfigOverride> {
  const current = (await readConfigOverride(kv)) ?? {}
  const next: ConfigOverride = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key as keyof AgentConfig]
      continue
    }
    // 页面把值改回插件配置里的原值时，覆盖就没有意义了：
    // 留着会让页面一直显示「已改」，而且配置升级后这个字段跟不上
    if (baseline && JSON.stringify(value) === JSON.stringify(baseline[key as keyof AgentConfig])) {
      delete next[key as keyof AgentConfig]
      continue
    }
    next[key as keyof AgentConfig] = value as never
  }
  if (Object.keys(next).length === 0) {
    await kv.delete(CONFIG_OVERRIDE_KEY)
    return {}
  }
  await kv.put(CONFIG_OVERRIDE_KEY, JSON.stringify(next))
  return next
}

/** 清空全部覆盖，回到插件配置 */
export async function clearConfigOverride(kv: PluginContext<AgentConfig>['kv']): Promise<void> {
  await kv.delete(CONFIG_OVERRIDE_KEY)
}
