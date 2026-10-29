/**
 * 运行时覆盖的「当前模型别名」。
 *
 * ## 为什么要有这一层（而不是只改插件配置）
 *
 * 模型别名本来在插件配置里（`config.model`，面板表单里手填）。但**别名是可以枚举的**：
 * `llm` 服务有 `listModels()`，能列出所有可用别名。让用户在配置里手打 `chat`、
 * 打错了还要等对话失败才发现，是没道理的设计——这恰恰是「面板装插件图省事」要避免的。
 *
 * 所以插件页面提供一个「点一下即切换」的模型选择器，选中的值存 KV（宿主面板只管插件
 * 配置，插件页面调不了 `/admin/*`，改不了那份配置）。运行时按
 * **KV 覆盖 > config.model** 取别名，所以点完立即生效、不用去配置里再填一遍。
 *
 * 配置里的 `model` 仍然是权威的回退值：KV 里没有覆盖时一律用它。
 */
import type { PluginContext } from '@qqbot/sdk'
import type { AgentConfig } from './config/index.js'

/** KV 里的键（框架会自动加插件前缀） */
const PICKED_MODEL_KEY = 'model:selected'

/** 页面里改过的配置（部分对象，只含被改的字段） */
const CONFIG_OVERRIDE_KEY = 'config:override'

/**
 * 页面覆盖：`Partial<AgentConfig>`，只含用户在插件页面里真正改过的字段。
 *
 * 用部分对象而不是整份替换：升级后新增的配置项，即便用户改过别的字段，
 * 也仍能从插件配置里拿到默认值。
 */
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
