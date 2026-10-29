/**
 * 默认权限策略。照搬 serverless-agent 的 `src/permissions/default-policy.ts`（43 行）。
 *
 * 核心设计：**按角色给基线**，再用 D1 里的策略表叠加。
 * 没配任何策略时也能跑——群成员能读写工作区，群主与管理员几乎全开，
 * 定时任务以 owner 级运行。
 *
 * 与原文的最大差异：原文只有「角色」一个维度，而 QQ 的单聊**没有群角色**
 * （`memberRole` 为 undefined）。所以这里再按 `scene` 补一档：单聊 / 频道私信
 * 按 1:1 信道给可用基线，群里角色未知才按陌生人保守处理。
 * 另外原文有 `phone:*`（RayNeo 硬件），这里换成本插件实际有的 scope。
 */
import type { PermissionLevel } from '../tools/types.js'
import type { ToolExecutionContext } from '../tools/types.js'
import type { ResolvedPolicy } from './policy-types.js'

/** 群主与管理员：几乎全开 */
const OWNER_SCOPES = [
  'workspace:read',
  'workspace:write',
  'web:search',
  'http:request',
  'schedule:read',
  'schedule:write',
]

/** 普通成员：只能读写工作区，不能建定时任务、不能发任意 HTTP */
const MEMBER_SCOPES = ['workspace:read', 'workspace:write']

/**
 * 单聊（1:1 信道）用户的基线：能读写工作区，也能建定时任务、发 HTTP。
 *
 * 为什么给这么宽：能私聊机器人，说明对方要么把机器人加到了好友、要么是机器人
 * 主动发起过的会话——这是一条**已建立的点对点信道**，不是公开群。
 * 把单聊用户当陌生人（只给 level 1）会让最典型的单聊用法全部 `permission_denied`：
 * 「提醒我三小时后…」（`schedule.create` 是 level 3）、`http.request`、
 * `vfs.write_file` 全都用不了，连 Bot 管理员也一样。
 *
 * 档位取 level 3 而不是 4：单聊用户不是群主/管理员，不该顺手拿到群管理那档；
 * 只是「能正常干活」的最低档。需要更宽的照旧走 D1 策略表放宽。
 */
const DIRECT_CHAT_SCOPES = [
  'workspace:read',
  'workspace:write',
  'schedule:read',
  'schedule:write',
  'http:request',
]

/** 陌生人（群里角色未知）：只读 */
const UNKNOWN_SCOPES = ['workspace:read']

/**
 * 单聊 / 频道私信的 scene 值（见 `types.ts` 的 `ReplyScene`）。
 *
 * `guild_dm` 也是私信（QQ 频道的私信），权限语义与 `c2c` 一致；
 * `guild` 是频道公开帖，按群聊保守处理。
 */
const DIRECT_CHAT_SCENES = ['c2c', 'guild_dm']

export function resolveDefaultPolicy(context: ToolExecutionContext): ResolvedPolicy {
  // 定时任务由系统发起，按 owner 级处理——否则「提醒我」类任务到点会被自己拦下
  if (context.actorId === 'scheduler') {
    return policy(3, OWNER_SCOPES, 'default:scheduler')
  }

  if (context.actorRole === 'owner' || context.actorRole === 'admin') {
    return policy(4, OWNER_SCOPES, `default:role:${context.actorRole}`)
  }

  if (context.actorRole === 'member') {
    return policy(2, MEMBER_SCOPES, 'default:role:member')
  }

  // 单聊没有群角色，`run.ts` 会把 actorRole 兜底成 'unknown'——
  // 这一档以前也是 level 1，于是单聊里连「提醒我」都建不出来。
  // 现在按 scene 区分：1:1 信道给可用基线，群里的未知角色仍然只读。
  if (isDirectChat(context.scene)) {
    return policy(3, DIRECT_CHAT_SCOPES, 'default:direct-chat')
  }

  return policy(1, UNKNOWN_SCOPES, 'default:unknown')
}

function isDirectChat(scene: string): boolean {
  return DIRECT_CHAT_SCENES.includes(scene)
}

function policy(maxLevel: PermissionLevel, scopes: string[], source: string): ResolvedPolicy {
  return { maxLevel, scopes, sources: [source] }
}
