/**
 * 唤醒判定：这条消息该不该进 Agent。
 *
 * 对标 AstrBot 的 `WakingCheckStage`。前置事实（QFlareBot 侧）：
 *
 * - `qq.group.at_message`（GROUP_AT_MESSAGE_CREATE）**只在 @机器人时**才推送；
 * - `qq.group.message`（GROUP_MESSAGE_CREATE，群全量消息）只有群主在 QQ 里给机器人开了
 *   「接收全部消息」才会推送，此时消息不一定 @ 了机器人；
 * - `qq.c2c.message` 是私聊，没有 @ 的概念。
 *
 * 所以「唤醒」这件事在插件里要自己判，三种模式：
 *
 * | 模式 | 群聊 | 单聊 |
 * | --- | --- | --- |
 * | `at` | 只在 @ 时（订阅 at_message 就够） | 全部（除非开了 friend_needs_wake_prefix） |
 * | `at_or_prefix` | @、或以前缀开头、或引用了机器人 | 同上 |
 * | `all` | 群里所有消息 | 同上 |
 *
 * ## 「没命中指令就该触发 Agent」
 *
 * 这是本次改动的核心诉求：用户 @ 机器人说了句「你好」，不该要求他打 `/agent 你好`，
 * 更不该因为没有命中任何命令就毫无反应。
 *
 * 实现上分两层：
 *
 * 1. **本模块判定「这条消息够不够唤醒」**（@ / 前缀 / 引用 / 全量）；
 * 2. **`src/agent/inbound.ts` 里剥掉唤醒前缀**，把「/你好」还原成「你好」再交给模型。
 *
 * 至于「命中了命令就别再触发 Agent」——QFlareBot 的分发器里命令默认 `block: true`，
 * 命中命令的处理器返回后同一事件不再分发给后面的候选。本插件的 services 指令走命令、
 * 聊天走事件，天然不重叠；`command_prefixes` 只是额外兜住「带前缀但没命中命令」的情况，
 * 避免把 `/unknowncmd` 当成聊天内容发给模型。
 */
import type { Session } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'

/** 唤醒结果：不唤醒时给出原因，便于日志与排障 */
export type WakeDecision =
  | { wake: false; reason: 'bot-self' | 'empty' | 'not-mentioned' | 'command' | 'not-woken' }
  | { wake: true; reason: 'at' | 'prefix' | 'reply' | 'private' | 'all'; text: string }

/**
 * 消息是否引用了别的消息。
 *
 * 注意：`session.quote` **拿不到被引用消息的发送者**（QQ 官方推送里不带），
 * 所以无法判断「是不是回复了机器人」。这里退一步用「有引用」作为明确的对话意图信号——
 * AstrBot 也是把 `Reply` 消息段的存在本身当作唤醒条件之一。
 * 代价：引用别人的消息也会唤醒；在 `at_or_prefix` 模式下这是可接受的（比漏触发好）。
 */
function isQuoteMessage(session: Session): boolean {
  return session.quote !== undefined
}

/** 是否是机器自己发的消息（避免自问自答） */
function isBotSelf(session: Session): boolean {
  return session.userId === session.botId
}

/**
 * 决定这条消息要不要唤醒 Agent。
 *
 * `text` 是剥掉唤醒前缀之后的正文（前缀模式下才有意义）。
 */
export function decideWake(session: Session, config: AgentConfig): WakeDecision {
  if (isBotSelf(session)) return { wake: false, reason: 'bot-self' }

  const raw = session.content ?? ''
  if (!raw.trim() && !(session.attachments?.length ?? 0)) return { wake: false, reason: 'empty' }

  const prefixes = (config.command_prefixes ?? '/')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  // 带指令前缀的消息交给指令路径：即便没命中任何命令，也不该当成聊天内容
  // （否则模型会看到一句「/unknown」，答非所问）
  if (prefixes.some((prefix) => raw.startsWith(prefix))) {
    return { wake: false, reason: 'command' }
  }

  const wakePrefixes = [config.wake_prefix ?? '/', ...prefixes]
    .map((item) => item.trim())
    .filter(Boolean)
  const matchedPrefix = wakePrefixes.find((prefix) => raw.startsWith(prefix))
  const stripped = matchedPrefix ? raw.slice(matchedPrefix.length).trim() : raw.trim()

  // 单聊：没有 @ 的概念
  if (session.scene === 'c2c' || session.scene === 'guild_dm') {
    if (config.friend_needs_wake_prefix) {
      return matchedPrefix
        ? { wake: true, reason: 'prefix', text: stripped }
        : { wake: false, reason: 'not-woken' }
    }
    return { wake: true, reason: 'private', text: stripped || raw.trim() }
  }

  // 群聊 / 频道：@ 了一定唤醒（at_message 事件里 atMe 恒为真）
  if (session.atMe) return { wake: true, reason: 'at', text: stripped || raw.trim() }
  if (matchedPrefix && config.wake_mode !== 'at') {
    return { wake: true, reason: 'prefix', text: stripped }
  }
  if (config.wake_mode !== 'at' && isQuoteMessage(session)) {
    return { wake: true, reason: 'reply', text: stripped || raw.trim() }
  }
  if (config.wake_mode === 'all') return { wake: true, reason: 'all', text: stripped || raw.trim() }

  return { wake: false, reason: 'not-mentioned' }
}
