/**
 * 工具权限判定。照搬 serverless-agent 的 `src/tools/permissions/policy.ts`（57 行）。
 *
 * 三步：
 * 1. 策略检查（级别 + scope）——不过就拒。
 * 2. 危险工具要二次确认（`sideEffect: 'dangerous'` 或 `level >= 5`）。
 * 3. 允许。
 *
 * 与原文的差异：原文的二次确认走 `pending_actions` 表 + Queue 通知 + 面板确认，
 * 那套依赖 Queues（QFlareBot 没有）。这里改成把「需要确认」作为工具结果返回给模型，
 * 模型据此向用户要一句明确答复；用户确认后下一轮带上 `allowDangerous`，工具才真跑。
 */
import type { PolicyDecision } from './types.js'
import { checkToolPolicy } from './policy-resolver.js'
import type { ToolDefinition, ToolExecutionContext } from '../tools/types.js'

export async function evaluateToolPermission(
  tool: ToolDefinition,
  context: ToolExecutionContext,
): Promise<PolicyDecision> {
  const policy = await checkToolPolicy(context, tool.permission)

  if (!policy.allowed) {
    return {
      allowed: false,
      reason: policy.reason,
      policySources: policy.resolved.sources,
    }
  }

  if (requiresConfirmation(tool, context)) {
    return {
      allowed: false,
      needsConfirmation: true,
      reason: '这个操作需要用户明确确认后才能执行',
      policySources: policy.resolved.sources,
    }
  }

  return { allowed: true, policySources: policy.resolved.sources }
}

/**
 * 是否需要二次确认。
 *
 * 用户已经在本轮确认过时（`allowDangerous`）不再重复问——
 * 否则确认过的操作每轮都要再确认一次，永远执行不了。
 */
function requiresConfirmation(tool: ToolDefinition, context: ToolExecutionContext): boolean {
  if (context.allowDangerous) return false

  return (
    tool.permission.level >= 5 ||
    tool.permission.confirmationRequired === true ||
    tool.sideEffect === 'dangerous'
  )
}
