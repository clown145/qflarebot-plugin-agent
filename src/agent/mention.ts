/**
 * 回复时 @ 说话人。
 *
 * ## 为什么用 `<@openid>` 文本
 *
 * QQ 官方机器人接口没有「@某人」的独立字段 —— 它就是在正文里写
 * `<@openid>`，平台渲染成真正的 @ 提醒。宿主 SDK 提供 `qqAt(openid)`
 * 生成这个片段，这里不重复实现拼接格式。
 *
 * ## 为什么做成三态而不是开关
 *
 * 单聊里 @ 对方毫无意义（就两个人），甚至可能显示成一段裸露的
 * `<@xxx>` 文本。所以「仅群聊」是**最有用的默认中间档**：
 * 群里该 @ 的时候 @，单聊不折腾。
 *
 * ## 失败要静默
 *
 * @ 只是锦上添花。userId 缺失、或平台不认这个文本时，
 * 宁可退回不带 @ 的回复，也不能让整条消息发不出去。
 */

import { qqAt } from '@qqbot/sdk'

/** 与配置项 `reply_mention` 一致 */
export type MentionMode = 'off' | 'group' | 'always'

/** 这些场景算「多人场合」，@ 才有意义 */
const GROUP_SCENES = new Set(['group', 'guild'])

/**
 * 在正文前面拼上 @ 片段。不需要或做不到时返回原文。
 *
 * @param text 已经过内容安全与清洗的正文
 * @param userId 说话人的 openid；为空时无法 @
 * @param scene 回复场景
 * @param mode 配置项
 */
export function withMention(
  text: string,
  userId: string | undefined,
  scene: string,
  mode: MentionMode | undefined,
): string {
  if (!mode || mode === 'off') return text
  if (!userId) return text
  if (mode === 'group' && !GROUP_SCENES.has(scene)) return text

  // 用宿主的 qqAt 而不是自己拼字符串：@ 的格式是平台细节，
  // 将来变了只需要宿主改一处
  const at = qqAt(userId)
  if (!at) return text
  // 正文已经以同一个 @ 开头就不重复加（模型偶尔会自己写出来）
  if (text.startsWith(at)) return text

  return `${at} ${text}`
}
