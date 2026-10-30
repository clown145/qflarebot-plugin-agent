/**
 * 页面提交的配置字段校验。
 *
 * 和面板表单是同一套约束（这里手写一遍是因为页面走的是自己的接口）：
 * 越界、类型不对、枚举不认识的值，都在保存时就拒掉 —— 而不是等下一次对话
 * 才炸一个看不懂的错误。
 */
import type { AgentConfig } from '../config/index.js'

export function validateConfigField(
  key: string,
  value: unknown,
  ctx: { service: <T>(name: string) => T; kv: unknown },
  config: AgentConfig,
): string | null {
  /** 数值字段的上下限，与 configSchema 保持一致 */
  const RANGES: Record<string, [number, number]> = {
    max_model_steps: [1, 30],
    max_tool_calls: [1, 50],
    history_limit: [0, 100],
    request_timeout_ms: [1000, 25000],
    max_context_tokens: [1000, 200000],
    rate_limit_per_minute: [0, 100],
  }
  const BOOLEANS = [
    'enable_tools',
    'enable_vfs',
    'enable_schedule',
    'enable_skills',
    'enable_audit',
    'show_typing',
    'friend_needs_wake_prefix',
  ]
  const STRINGS = [
    'model',
    'system_prompt',
    'default_persona',
    'wake_prefix',
    'timezone',
    'search_api_key',
    'content_filter_keywords',
  ]
  /** 枚举字段：只能取这几值 */
  const ENUMS: Record<string, readonly string[]> = {
    context_compression: ['off', 'truncate', 'summary'],
  }

  if (!(key in config) && !['personas'].includes(key)) return `未知配置项：${key}`

  if (key === 'personas') {
    if (!Array.isArray(value)) return 'personas 必须是数组'
    for (const item of value) {
      if (!item || typeof item !== 'object') return 'personas 的每一项必须是对象'
      const persona = item as Record<string, unknown>
      if (typeof persona['name'] !== 'string' || !persona['name'].trim()) return '人格必须有 name'
      if (typeof persona['prompt'] !== 'string') return '人格的 prompt 必须是字符串'
      if (persona['begin_dialogs'] !== undefined && typeof persona['begin_dialogs'] !== 'string') {
        return '人格的 begin_dialogs 必须是字符串'
      }
      // tools：留空 = 不限。页面传空数组是合法的，表示「这套人格不能用任何工具」
      if (persona['tools'] !== undefined) {
        if (!Array.isArray(persona['tools'])) return '人格的 tools 必须是数组'
        for (const tool of persona['tools']) {
          if (typeof tool !== 'string' || !tool.trim()) return '人格的 tools 里必须是非空字符串'
        }
      }
      // skills：与 tools 同构（留空 = 不限，[] = 一个都不给）
      if (persona['skills'] !== undefined) {
        if (!Array.isArray(persona['skills'])) return '人格的 skills 必须是数组'
        for (const skill of persona['skills']) {
          if (typeof skill !== 'string' || !skill.trim()) return '人格的 skills 里必须是非空字符串'
        }
      }
      if (
        persona['custom_error_message'] !== undefined &&
        typeof persona['custom_error_message'] !== 'string'
      ) {
        return '人格的 custom_error_message 必须是字符串'
      }
    }
    // 名字不能重复：会话按名字绑定，重名等于绑不准
    const names = (value as Array<{ name: string }>).map((p) => p.name.trim())
    if (new Set(names).size !== names.length) return '人格名字不能重复'
    return null
  }

  if (key === 'model') {
    if (typeof value !== 'string' || !value.trim()) return 'model 不能为空'
    // 只接受真实存在的别名：手打错一个字母，运行时才炸 unknown_model 太难查
    return null
  }

  const allowed = ENUMS[key]
  if (allowed) {
    return typeof value === 'string' && allowed.includes(value)
      ? null
      : `${key} 只能是 ${allowed.join(' / ')}`
  }

  if (BOOLEANS.includes(key)) {
    return typeof value === 'boolean' ? null : `${key} 必须是布尔值`
  }

  if (STRINGS.includes(key)) {
    return typeof value === 'string' ? null : `${key} 必须是字符串`
  }

  const range = RANGES[key]
  if (range) {
    const num = value as number
    if (typeof num !== 'number' || !Number.isInteger(num)) return `${key} 必须是整数`
    if (num < range[0] || num > range[1]) return `${key} 应在 ${range[0]}–${range[1]} 之间`
    return null
  }

  return null
}