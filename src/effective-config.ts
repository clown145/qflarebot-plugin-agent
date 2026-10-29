/**
 * 生效配置 = 插件配置（面板表单） + 页面里改过的覆盖值。
 *
 * ## 为什么要有这一层
 *
 * 插件页面（`/p/agent/ui/`）拿的是**限定本插件的桥接令牌**，调不了 `/admin/*`
 * （实测 401），所以它没法写回面板里的插件配置。但「模型别名、人格、唤醒方式、
 * 步数上限」这些东西，在插件页面里点一下就能改显然比让人去配置表单里填更顺手。
 *
 * 做法：页面把改动写进本插件自己的 KV（`src/runtime-config.ts` 的存储层），
 * 运行时用 `resolveConfig()` 把覆盖合并到 `ctx.config` 上，得到一个**生效配置**。
 * 所有运行路径只认这个生效配置，于是页面上点了就立即生效，不用重新构建、也不用
 * 再去面板保存一次。
 *
 * ## 合并规则
 *
 * - 覆盖是**部分对象**：只包含真正被页面改过的字段，没改的字段沿用插件配置。
 *   所以升级后新增的配置项，即使用户在页面里改过别的字段，也照样拿到默认值。
 * - 数组（`personas`）与对象整体替换，不做深合并——页面上增删人格是「全量提交」语义，
 *   深合并会让「删掉一个人格」变得做不到。
 * - `null` 表示「这一项没有覆盖」；空字符串是合法值（比如清空 `system_prompt`）。
 *
 * ## 优先级
 *
 * 页面覆盖 > 插件配置（`ctx.config`，即面板表单里保存的值 + defaultConfig）。
 * 面板那边永远是权威的「出厂设置」，页面的改动是运行时叠加。
 */
import type { PluginContext } from '@qqbot/sdk'
import type { AgentConfig } from './config/index.js'
import { readConfigOverride } from './runtime-config.js'

/**
 * 取本次请求的生效配置。
 *
 * 读覆盖失败时退回插件配置（不能让 KV 抖动导致整台机器人不可用）。
 */
export async function resolveConfig(ctx: PluginContext<AgentConfig>): Promise<AgentConfig> {
  const override = await readConfigOverride(ctx.kv).catch(() => null)
  if (!override) return ctx.config
  return { ...ctx.config, ...override }
}
