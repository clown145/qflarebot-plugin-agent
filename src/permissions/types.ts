/** 权限判定结果。照搬 serverless-agent 的 `PermissionDecision` */
export interface PolicyDecision {
  allowed: boolean
  needsConfirmation?: boolean
  reason?: string
  /** 命中的策略来源，排障用 */
  policySources?: string[]
}
