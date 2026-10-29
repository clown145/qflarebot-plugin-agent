/**
 * 内容安全检查（入站 + 出站）。
 *
 * 对标 AstrBot 的 `ContentSafetyCheckStage`
 * （`astrbot/core/pipeline/content_safety_check/stage.py`）。AstrBot 那套是
 * 「可插拔策略 + 百度 AIP 审核 + 关键词」，这里只搬**最便宜、零外部依赖**的一层：
 * 纯文本关键词匹配。
 *
 * ## 为什么只做关键词
 *
 * 真正的审核要调外部 API —— 一次消息多一次出站请求，而免费版**每次调用只有 50 个子请求**、
 * 30 秒事件预算，且额度全机器人共享。为了审核花掉一个子请求 + 几百毫秒，
 * 在群聊高频场景下不划算。关键词匹配零成本、零请求、CPU 可以忽略，
 * 能挡住「明显不该出现」的内容。真需要严格审核的部署应该关掉 Agent 或换平台。
 *
 * ## 为什么入站和出站都要查
 *
 * AstrBot 在两个点都查（`ContentSafetyCheckStage` 查入站，
 * `ResultDecorateStage` 查出站）。只查入站不够：模型可能把用户诱导出的
 * 敏感内容再复述一遍，而那才是真正发到群里的东西。
 *
 * ## 匹配方式
 *
 * 大小写不敏感的子串包含。不做正则（配置里的正则一旦写错会抛异常，
 * 而这里失败应该「放行」而不是「500」）。也不做分词：
 * 中文关键词做子串匹配效果就够，而且不会因为分词库缺失而退化。
 */

export interface SafetyCheckResult {
  /** 是否命中 */
  blocked: boolean
  /** 命中的关键词（不返回给用户，只用于日志） */
  matched?: string
}

/**
 * 解析配置里的关键词串。
 *
 * 用中英文逗号都切，去空白，丢掉空项。允许全角逗号是因为
 * 中文输入法下很容易打成「，」。
 */
export function parseKeywords(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 检查一段文本。
 *
 * `keywords` 为空时直接放行（功能关闭）。这是默认状态：
 * 默认开启内容过滤会让用户莫名其妙被拒，而他们并没有配关键词。
 */
export function checkContent(text: string, keywords: string[]): SafetyCheckResult {
  if (keywords.length === 0) return { blocked: false }
  if (!text) return { blocked: false }

  const haystack = text.toLowerCase()
  for (const keyword of keywords) {
    // 关键词也转小写，让英文词大小写不敏感
    if (haystack.includes(keyword.toLowerCase())) {
      return { blocked: true, matched: keyword }
    }
  }
  return { blocked: false }
}

/** 给用户看的话。不暴露命中的关键词，避免被拿来试探规则 */
export const BLOCKED_REPLY = '这个话题我这边不处理，换个问题吧。'
