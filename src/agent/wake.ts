/**
 * 唤醒判定：这条消息该不该进 Agent。
 *
 * 对标 AstrBot 的 `WakingCheckStage`（`core/pipeline/waking_check/stage.py`）。
 *
 * ## 前置事实（QFlareBot 侧）
 *
 * - `qq.group.at_message`（`GROUP_AT_MESSAGE_CREATE`）**只在 @机器人时**才推送；
 * - `qq.group.message`（`GROUP_MESSAGE_CREATE`，群全量消息）只有群主在 QQ 里给机器人
 *   开了「接收全部消息」才会推送，此时消息通常**没有** @ 机器人；
 * - `qq.c2c.message` 是私聊，没有 @ 的概念。
 *
 * 所以插件必须自己判断「这条该不该理」，否则开了全量消息的群会被刷屏。
 *
 * ## 判定顺序（与 AstrBot 一致，逐条短路）
 *
 * 1. 机器人自己发的消息 → 不理（避免自问自答）
 * 2. 空消息（正文与附件都没有）→ 不理
 * 3. **带指令前缀** → 交给指令路径，不进模型（`/agent status` 不该被当成聊天）
 * 4. **私聊**：默认全部唤醒；开了 `friend_needs_wake_prefix` 才要求前缀
 * 5. **群聊 / 频道**：
 *    - **@ 了机器人**（`atMe`）→ 唤醒
 *    - **以唤醒前缀开头**（`wake_prefix`，默认 `/`）→ 唤醒，并剥掉前缀
 *    - 其余 → **不理**
 *
 * ## 刻意不做的
 *
 * - **「引用消息就唤醒」不做了**。AstrBot 的语义是「引用了**机器人自己**的消息」才算，
 *   而 QFlareBot 的 `session.quote` **拿不到被引用消息的发送者**（QQ 官方推送里不带这个字段），
 *   所以精确判断做不到。退化成「有引用就唤醒」的后果是：群里两个人互相引用聊天，
 *   机器人也插嘴——这正是之前踩到的刷屏 bug。宁可漏触发（用户再 @ 一下），
 *   也不要误触发，因为误触发会打扰整个群。
 * - **不做「群里所有消息都回复」模式**。AstrBot 也没有这个模式；它只有默认关闭、
 *   概率 0.1 的「主动回复」。QFlareBot 侧更不适合：`qq.group.message` 依赖群主开启
 *   「接收全部消息」，且一次事件有 30 秒预算、被动回复最多 5 条。
 * - **`wake_mode` 枚举删掉了**。它是我自创的抽象，AstrBot 没有。三个开关
 *   （`wake_prefix` / `friend_needs_wake_prefix` / 指令前缀）已经够表达，
 *   多一层枚举只会让「@/前缀/引用」这种组合变得含义不清。
 *
 * ## 「没命中指令就该触发 Agent」
 *
 * 只要这条消息**被唤醒**且没命中任何指令，就该走 LLM——这正是 AstrBot 的行为
 * （判定在其 `process_stage/stage.py:56-66`）。QFlareBot 那边命令默认 `block: true`，
 * 命中命令后同一事件不再分发给后面的事件候选，所以「命中指令」与「聊天」天然互斥。
 */
import type { Session } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import { isPluginCommand } from './commands.js'

/** 唤醒结果：不唤醒时给出原因，便于日志与排障 */
export type WakeDecision =
  | { wake: false; reason: 'bot-self' | 'empty' | 'command' | 'not-mentioned' | 'not-woken' }
  | { wake: true; reason: 'at' | 'prefix' | 'private' | 'skill'; text: string }

/**
 * 识别技能激活，并返回该交给模型的正文。
 *
 * 为什么需要一个「剥前缀」而不是直接复用 `/skill` 原文：`runLoopOnce` 里的
 * `parseSkillCommand` 匹配的是 `^/skill ...`，所以这里**保留** `/skill` 开头，
 * 只把首尾空白清掉。这样两条路径共用同一个正则，不会出现「唤醒层认了、
 * 解析层不认」的错位。
 *
 * 返回 `undefined` = 不是技能激活。
 */
function stripSkillPrefix(raw: string): string | undefined {
  const trimmed = raw.trim()
  // 只认 `/skill ` 后面还有内容的形式。光一个 `/skill` 当作普通指令，
  // 交给 `agent skill` 命令去列目录——那里能给出比「空任务」更有用的回复。
  if (!/^\/skill\s+\S/.test(trimmed)) return undefined
  return trimmed
}

/** 是否是机器自己发的消息 */
function isBotSelf(session: Session): boolean {
  return session.userId === session.botId
}

/**
 * 唤醒前缀。默认 `/`。
 *
 * 这是**唯一**的前缀：指令前缀由宿主框架管理（命令命中后不再进模型），
 * 插件不再单独配一份——两个真相必然对不上。
 */
function wakePrefix(config: AgentConfig): string {
  return (config.wake_prefix ?? '/').trim()
}

/**
 * 决定这条消息要不要唤醒 Agent。
 *
 * `text` 是剥掉唤醒前缀之后的正文。
 */
export function decideWake(session: Session, config: AgentConfig): WakeDecision {
  if (isBotSelf(session)) return { wake: false, reason: 'bot-self' }

  const raw = session.content ?? ''
  if (!raw.trim() && !(session.attachments?.length ?? 0)) return { wake: false, reason: 'empty' }

  // 技能激活是一条**特殊情况**：`/skill <id> <任务>` 必须进模型，
  // 因为技能正文只有模型才能用上。
  //
  // 它必须比普通唤醒更早判定：普通消息只剥前缀，而技能激活要**剥掉整段命令**
  // 换成任务正文（见 run.ts 的 parseSkillCommand）。
  const skillText = stripSkillPrefix(raw)
  if (skillText !== undefined) {
    return { wake: true, reason: 'skill', text: skillText }
  }

  const prefix = wakePrefix(config)
  const matched = prefix ? raw.startsWith(prefix) : false
  const stripped = matched ? raw.slice(prefix.length).trim() : raw.trim()

  // **是命令就不唤醒**，交给 `commands` 那条路径。
  //
  // 这里的注释曾经写错过（以为命令 `block:true` 就不会再分发到 events），
  // 实际不是：命令和事件是同一个候选列表里的竞争项，`block` 只影响它之后
  // 的候选。所以 `/reset` 会**同时**命中命令和群消息事件 —— 命令照常执行，
  // 事件处理器也照样被调用，而唤醒层又把 `/` 当成前缀剥掉送进模型，
  // 结果就是「执行命令的同时，模型还回一句莫名其妙的话」。
  //
  // 判断依据是**首词是否为本插件的命令**，而不是「以斜杠开头」：
  // `/你好` 是用户在用前缀聊天，不该被挡。
  // 带前缀（`/reset`）和 @ 机器人后直接打命令名（`@机器人 reset`）都会被命令路径
  // 接住，所以两种形状都要挡。前者已经剥了前缀，后者原文就是命令词。
  if (isPluginCommand(stripped)) {
    // 只有「带前缀」或「@ 了机器人」时才算命令 —— 群里别人说「help」
    // 不带前缀也没 @，不该被当成命令吞掉（它本来也不会唤醒，这里只是明确语义）
    if (matched || session.atMe) {
      return { wake: false, reason: 'command' }
    }
  }

  // 单聊：没有 @ 的概念，默认全部唤醒
  if (session.scene === 'c2c' || session.scene === 'guild_dm') {
    if (config.friend_needs_wake_prefix) {
      return matched
        ? { wake: true, reason: 'prefix', text: stripped }
        : { wake: false, reason: 'not-woken' }
    }
    return { wake: true, reason: 'private', text: stripped || raw.trim() }
  }

  // 群聊 / 频道：只认「@了机器人」与「唤醒前缀」，其余一律不理
  if (session.atMe) return { wake: true, reason: 'at', text: stripped || raw.trim() }
  if (matched) return { wake: true, reason: 'prefix', text: stripped }

  return { wake: false, reason: 'not-mentioned' }
}
