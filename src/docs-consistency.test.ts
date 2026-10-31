import { describe, expect, it } from 'vitest'
// 用 Vite 的 ?raw 导入而不是 node:fs：tsconfig 的 types 只有 workers-types，
// 没有 @types/node（这个插件的运行环境本来就不是 Node），
// 而 vitest 走 Vite 管线，?raw 两边都能用。
import troubleshootingMd from '../docs/troubleshooting.md?raw'
import toolsMd from '../docs/tools.md?raw'
import quickstartMd from '../docs/quickstart.md?raw'
import configurationMd from '../docs/configuration.md?raw'
import pluginApiMd from '../docs/plugin-api.md?raw'
import { defaultConfig } from './config/index.js'

/**
 * 文档与代码的一致性守卫。
 *
 * 为什么需要：这一版排障文档里有整段**事实错误**——说 `enable_vfs` 默认关、
 * 必须绑 R2，还让人去 grep 一条**从来不存在的日志**（grep 零命中）。
 * 这种错误比「没写文档」更糟：用户按它排障会走进死胡同，而且没人会发现。
 *
 * 守的是「文档里写死的、能被代码验证的具体断言」，不是文风。
 * 断言写成字符串包含检查，故意很窄——只覆盖踩过坑的那几处：
 * - `enable_vfs` 的默认值与 R2 无关性
 * - 重试表必须覆盖 `client.ts` 里所有可重试的 code
 * - `docs/plugin-api.md` 不能出现解析不了的 import 路径
 */

function doc(path: string): string {
  switch (path) {
    case 'troubleshooting.md':
      return troubleshootingMd
    case 'tools.md':
      return toolsMd
    case 'quickstart.md':
      return quickstartMd
    case 'configuration.md':
      return configurationMd
    case 'plugin-api.md':
      return pluginApiMd
    default:
      throw new Error(`没有导入这份文档：${path}`)
  }
}

describe('文档事实与代码一致', () => {
  it('enable_vfs 在代码里默认是开着的（文档若说「默认关」就是错的）', () => {
    // 这条断言是文档的前提：一旦代码默认值改了，下面几条文档断言也必须跟着改
    expect(defaultConfig.enable_vfs).toBe(true)
  })

  it('troubleshooting.md 不再声称 enable_vfs 默认关、也不是「必须绑 R2」', () => {
    const text = doc('troubleshooting.md')
    expect(text).not.toContain('enable_vfs` 默认是关的')
    expect(text).not.toContain('而且**要绑 R2**')
    // 不能让人去 grep 一条不存在的日志（可以提到「没有这条日志」，但不能当排障步骤）
    expect(text).not.toContain('日志搜「enable_vfs 打开了但 R2 未绑定」')
    expect(text).toContain('没有**「enable_vfs 打开了但 R2 未绑定」')
    // 正面陈述必须存在
    expect(text).toContain('enable_vfs')
    expect(text).toContain('默认')
  })

  it('tools.md 的 vfs 前置条件不再要求 R2', () => {
    const text = doc('tools.md')
    expect(text).not.toContain('`enable_vfs` + 绑了 R2')
    expect(text).toContain('轻量模式')
  })

  it('quickstart.md 不再让人去填已删除的 search_api_key', () => {
    const text = doc('quickstart.md')
    // 字段已从配置里删除（config/index.ts 无此键）
    expect('search_api_key' in (defaultConfig as unknown as Record<string, unknown>)).toBe(false)
    // 文档里可以提到「那个字段已经删了」，但不能作为操作步骤出现
    expect(text).not.toContain('配置表单填 `search_api_key`')
  })

  it('quickstart.md 不再把 apiVersion 2 说成 0.7.0 的门槛', () => {
    const text = doc('quickstart.md')
    expect(text).not.toContain('`apiVersion: 2`，用到 `ctx.db.batch()`')
    // 必须明确区分「能力门槛」与「语义依赖」
    expect(text).toContain('语义依赖')
  })

  it('重试表覆盖 LLMCallError 里所有可重试的 code', () => {
    const text = doc('troubleshooting.md')
    // 与 src/llm/client.ts 的 LLMCallError.retryable 保持一致：
    // rate_limit / network / upstream / timeout
    for (const code of ['rate_limit', 'network', 'upstream', 'timeout']) {
      expect(text, `重试表缺少 ${code}`).toContain(`\`${code}\` | ✅`)
    }
    // 不可重试的也要在表里，避免「没写=可重试」的误解
    for (const code of ['auth', 'unknown_model', 'bad_response']) {
      expect(text, `重试表缺少 ${code}`).toContain(`\`${code}\` | ❌`)
    }
  })

  it('plugin-api.md 不含解析不了的 import 路径', () => {
    const text = doc('plugin-api.md')
    // package.json 没有 exports、也不发 npm，所以任何 `qflarebot-plugin-agent/...` 的
    // import 在调用方里都解析不了（构建直接失败）。类型必须内联声明。
    // 允许在注释/说明里提到这个路径（要解释「为什么不能 import」），
    // 但真正的 import 语句一句都不能有
    // 只看真正的代码行（行首是 import），注释/说明里引用这个路径是允许的
    expect(text).not.toMatch(/^\s*import\s+[^\n]*from\s+['"]qflarebot-plugin-agent\//m)
    expect(text).toContain('interface AgentPromptService')
  })

  it('plugin-api.md 如实说明第三方工具受 depends 限制（不伪造可用性）', () => {
    const text = doc('plugin-api.md')
    expect(text).toContain('depends')
    expect(text).toContain('已知限制')
    // 服务名约定与 key 映射规则要写清楚（两处都踩过 bug）
    expect(text).toContain('tools')
    expect(text).toContain('规整')
  })

  it('tools.md 写明 SSRF 不解析 DNS、不防 rebinding', () => {
    const text = doc('tools.md')
    expect(text).toContain('不做 DNS 解析')
    expect(text).toContain('rebinding')
  })

  it('configuration.md 不再列出已删除的 search_api_key 配置项', () => {
    const text = doc('configuration.md')
    // 表格行与默认值块里都不该再出现
    expect(text).not.toContain('| `search_api_key` |')
    expect(text).not.toContain('"search_api_key"')
  })
})
