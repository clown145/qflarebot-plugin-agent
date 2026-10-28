/**
 * 默认权限策略。照搬 serverless-agent 的 `src/permissions/default-policy.ts`（43 行）。
 *
 * 核心设计：**按角色给基线**，再用 D1 里的策略表叠加。
 * 没配任何策略时也能跑——陌生人有 workspace:read，群成员能读写工作区，
 * 群主与管理员几乎全开，定时任务以 owner 级运行。
 *
 * 与原文的差异：原文有 `phone:*`（RayNeo 硬件），这里换成本插件实际有的 scope。
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

/** 陌生人（单聊里第一次说话的人、角色未知）：只读 */
const UNKNOWN_SCOPES = ['workspace:read']

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

  // 单聊没有群角色，走这一档：能读工作区，但建不了定时任务、发不了任意 HTTP
  return policy(1, UNKNOWN_SCOPES, 'default:unknown')
}

function policy(maxLevel: PermissionLevel, scopes: string[], source: string): ResolvedPolicy {
  return { maxLevel, scopes, sources: [source] }
}
