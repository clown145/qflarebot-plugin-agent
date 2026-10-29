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

/** 这个提示词覆盖用的键（同理，见下） */
const PROMPT_OVERRIDE_KEY = 'prompt:override'

export interface RuntimeOverrides {
  /** KV 里选中的模型别名；没有就是 undefined */
  model?: string
  /** 页面里临时改过的系统提示词 */
  systemPrompt?: string
}

/** 读运行时覆盖。读失败按「没有覆盖」处理——不该让页面读失败拖垮对话 */
export async function readOverrides(
  kv: PluginContext<AgentConfig>['kv'],
): Promise<RuntimeOverrides> {
  const [model, systemPrompt] = await Promise.all([
    kv.get(PICKED_MODEL_KEY).catch(() => null),
    kv.get(PROMPT_OVERRIDE_KEY).catch(() => null),
  ])
  return {
    ...(model?.trim() ? { model: model.trim() } : {}),
    ...(systemPrompt !== null ? { systemPrompt } : {}),
  }
}

/** 写选中的模型别名；传空串清除覆盖、回落到配置里的 `model` */
export async function setSelectedModel(
  kv: PluginContext<AgentConfig>['kv'],
  alias: string | undefined,
): Promise<void> {
  const name = (alias ?? '').trim()
  if (!name) {
    await kv.delete(PICKED_MODEL_KEY)
    return
  }
  await kv.put(PICKED_MODEL_KEY, name)
}

/** 写系统提示词覆盖；传空串清除覆盖、回落到配置 */
export async function setSystemPromptOverride(
  kv: PluginContext<AgentConfig>['kv'],
  prompt: string | undefined,
): Promise<void> {
  const text = (prompt ?? '').trim()
  if (!text) {
    await kv.delete(PROMPT_OVERRIDE_KEY)
    return
  }
  await kv.put(PROMPT_OVERRIDE_KEY, text)
}

/**
 * 解析本轮实际用哪个别名。
 *
 * 优先级：页面选中（KV）> 配置里的 `model`。
 * 未知别名查不到时 `chat` 会自己报 `unknown_model`，错误信息里带别名，用户能看懂。
 */
export function effectiveModel(config: AgentConfig, overrides: RuntimeOverrides): string {
  return overrides.model?.trim() || config.model
}

/** 解析本轮实际的系统提示词（人格优先，见 persona.ts；这里只管「没人格时的兜底」） */
export function effectiveSystemPrompt(config: AgentConfig, overrides: RuntimeOverrides): string {
  return overrides.systemPrompt ?? config.system_prompt
}
