/**
 * 策略解析。照搬 serverless-agent 的 `src/permissions/policy-resolver.ts`（82 行）。
 *
 * 算法：先取角色基线（`resolveDefaultPolicy`），再把 D1 `{policies}` 表里
 * 命中 agent / user / role / platform / conversation 五种 subject 的策略**取并集**：
 * maxLevel 取最大、scopes 求并。所以策略表只能放宽、不能收紧——
 * 这与原文一致（原文注释也这么说：`reduce` 里用 `Math.max`）。
 *
 * **现状（须知）：本插件里这张表没有写入方**。全仓库只有 schema 的
 * `CREATE TABLE` 与下面这条 `SELECT`，没有任何 INSERT/UPDATE——面板也没有入口。
 * 想用「策略叠加」只能手工往 D1 写 `p_agent_policies`（`{policies}` 由框架展开成
 * `p_agent_<表名>`），且本插件的 README/面板都不提供指引。
 * 因此**当前的真实行为就是 `resolveDefaultPolicy` 的角色基线**（含单聊那一档），
 * 叠加逻辑只是「手工写了就生效」的预留通路，别把它当成已有能力。
 *
 * 需要「收紧」的场景（比如某个群禁用某工具）应该做成开关而不是策略级别。
 */
import type { PluginDB } from '@qqbot/sdk'
import { resolveDefaultPolicy } from './default-policy.js'
import type { PolicyCheck, PolicySubjectType, ResolvedPolicy } from './policy-types.js'
import type { PermissionRequirement, ToolExecutionContext } from '../tools/types.js'

export async function checkToolPolicy(
  context: ToolExecutionContext,
  requirement: PermissionRequirement,
): Promise<PolicyCheck> {
  const resolved = await resolvePolicy(context)

  if (requirement.level > resolved.maxLevel) {
    return {
      allowed: false,
      reason: `这个工具需要权限级别 ${requirement.level}，当前只有 ${resolved.maxLevel}`,
      resolved,
    }
  }

  const missingScope = requirement.scopes.find((scope) => !resolved.scopes.includes(scope))
  if (missingScope) {
    return {
      allowed: false,
      reason: `缺少权限：${missingScope}`,
      resolved,
    }
  }

  return { allowed: true, resolved }
}

async function resolvePolicy(context: ToolExecutionContext): Promise<ResolvedPolicy> {
  const baseline = resolveDefaultPolicy(context)

  let policies: Array<{ id: string; maxLevel: number; scopes: string[] }>
  try {
    // 每次工具调用都查一次 {policies}。看起来可以按 isolate 缓存「表是空的」，
    // 但那会让手工写进去的策略在 isolate 回收前一直不生效——而这张表本来就只能手工写，
    // 延迟生效比多一次 D1 读更糟（D1 读额度 500 万行/日，是写的 50 倍）。
    policies = await findMatchingPolicies(context.db, {
      conversationId: context.conversationId,
      subjects: buildSubjects(context),
    })
  } catch (error) {
    // 策略表读失败时退回基线，而不是让所有工具都不可用——
    // 读不到策略不等于用户没有权限
    context.logger.warn('权限策略读取失败，按角色基线处理', {
      error: error instanceof Error ? error.message : String(error),
    })
    return baseline
  }

  return policies.reduce<ResolvedPolicy>(
    (current, policy) => ({
      maxLevel: Math.max(current.maxLevel, policy.maxLevel) as ResolvedPolicy['maxLevel'],
      scopes: Array.from(new Set([...current.scopes, ...policy.scopes])),
      sources: [...current.sources, `policy:${policy.id}`],
    }),
    baseline,
  )
}

/** 一次查出所有命中的策略。subject 是 (type, id) 对，用 OR 拼 */
async function findMatchingPolicies(
  db: PluginDB,
  query: {
    conversationId?: string
    subjects: Array<{ type: PolicySubjectType; id: string }>
  },
): Promise<Array<{ id: string; maxLevel: number; scopes: string[] }>> {
  if (query.subjects.length === 0) return []

  const clauses = query.subjects.map(() => '(subject_type = ? AND subject_id = ?)').join(' OR ')
  const params = query.subjects.flatMap((s) => [s.type, s.id])

  const rows = await db.all<{
    id: string
    max_level: number
    scopes_json: string
  }>(
    `SELECT id, max_level, scopes_json FROM {policies} WHERE ${clauses}`,
    ...params,
  )

  return rows.map((row) => ({
    id: row.id,
    maxLevel: row.max_level,
    scopes: parseScopes(row.scopes_json),
  }))
}

function parseScopes(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    // 坏数据不该让工具全部不可用
    return []
  }
}

/**
 * 一个请求可能命中多条策略：agent / user / role / platform / conversation。
 *
 * 照搬原文的 buildSubjects，但去掉了 `conversationId.split("#")` 那段——
 * 那是原文为「子会话继承父会话」设计的，QFlareBot 的会话 id 没有这个结构。
 */
function buildSubjects(context: ToolExecutionContext): Array<{ type: PolicySubjectType; id: string }> {
  const subjects: Array<{ type: PolicySubjectType; id: string }> = [
    { type: 'user', id: context.actorId },
    { type: 'conversation', id: context.conversationId },
    { type: 'platform', id: 'qq' },
  ]

  if (context.actorRole && context.actorRole !== 'unknown') {
    subjects.push({ type: 'role', id: context.actorRole })
  }

  return subjects
}
