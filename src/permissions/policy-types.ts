/**
 * 权限策略类型。照搬 serverless-agent 的 `src/permissions/policy-types.ts`。
 *
 * 6 级 + scope 的模型，比 QFlareBot 自带的 3 档（bot_admin / group_admin / member）
 * 细得多。两者的关系是：QFlareBot 的档位决定「能不能触发这条命令」，
 * 这里的级别决定「模型能不能用这个工具、用到什么程度」——是两个不同的关卡。
 */
import type { PermissionLevel } from '../tools/types.js'

export type PolicySubjectType = 'agent' | 'user' | 'role' | 'platform' | 'conversation'

/** 一次策略解析的结果：允许的最高级别 + 可用 scope 集合 */
export interface ResolvedPolicy {
  maxLevel: PermissionLevel
  scopes: string[]
  /** 命中的策略来源，排障用 */
  sources: string[]
}

export interface PolicyCheck {
  allowed: boolean
  reason?: string
  resolved: ResolvedPolicy
}
