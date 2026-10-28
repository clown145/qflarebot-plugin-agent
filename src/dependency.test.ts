import { describe, expect, it } from 'vitest'
import plugin from './index.js'

/**
 * 依赖声明。
 *
 * `depends` 的键是**服务名**，不是插件名——QFlareBot 的安装检查按服务名解析
 * （见 packages/runtime/src/installChecks.ts 的 requiredDepends）。
 * 声明错了的后果：插件装得上，但运行时 `ctx.service('llm')` 抛错，
 * 用户看到的是内部错误而不是「先装 LLM 插件」。
 */
describe('对 llm 插件的依赖声明', () => {
  it('在 definePlugin 里声明 depends.llm', () => {
    expect(plugin.depends).toEqual({ llm: '*' })
  })

  it('depends 的键是服务名 llm，不是插件名', () => {
    // 插件名是 agent；如果这里写成 agent 或 qflarebot-plugin-llm 就是错的
    const keys = Object.keys(plugin.depends ?? {})
    expect(keys).toContain('llm')
    expect(keys).not.toContain('qflarebot-plugin-llm')
  })

  it('是必需依赖而不是 optional', () => {
    // 值为 'optional' 时不拦安装、运行时取不到就抛——但本插件没有 llm 完全没法用，
    // 所以必须是必需依赖，让安装阶段就拦住
    const value = (plugin.depends as Record<string, string>)['llm']
    expect(value).not.toBe('optional')
  })

  it('name 与 depends 一致（构建时校验源码与声明清单，不一致会失败）', () => {
    // manifest.json 由 `qqbot-plugin build` 从 definePlugin 生成并比对，
    // 所以这里验证源头的值就够了；构建本身是那道校验
    expect(plugin.name).toBe('agent')
    expect(plugin.depends).toEqual({ llm: '*' })
  })

  it('自己不再提供服务（不是 llm 的替代品）', () => {
    expect(plugin.services ?? {}).toEqual({})
  })
})

describe('依赖缺失时的降级', () => {
  it('cron 里 llm 不可用时不抛错，安静跳过', async () => {
    // 模拟 ctx.service 抛错（提供者被停用）
    const ctx = {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      kv: { getJSON: async () => ['group:g1'], get: async () => null, put: async () => {} },
      db: { run: async () => ({ changes: 0 }), all: async () => [] },
      config: { ...plugin.defaultConfig, enable_schedule: true },
      service: () => {
        throw new Error('服务 llm 不可用：提供者被停用')
      },
      waitUntil: () => {},
    } as never

    const cron = (plugin.cron as Record<string, { handler: (input: { ctx: unknown; job: string; scheduledAt: number }) => Promise<void> }>)
    // 不应抛错——cron 抛错会每分钟刷一次错误日志
    await expect(
      cron['tick']!.handler({ ctx, job: 'tick', scheduledAt: Date.now() }),
    ).resolves.toBeUndefined()
  })
})
