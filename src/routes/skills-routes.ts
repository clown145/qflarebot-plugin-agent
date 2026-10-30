/**
 * 技能的增删改查
 *
 * 保存时的校验错误（id 非法 / 超 32KB / 缺 description）**直接回给页面**，
 * 运维当场知道写漏了什么，而不是等某次对话才发现技能「消失」。
 */
import type { Route } from '@qqbot/sdk'
import type { AgentConfig } from '../config/index.js'
import {
  deleteSkill,
  getSkill,
  getSkillMarkdown,
  listSkills,
  upsertSkill,
} from '../skills/store.js'

export function createSkillsRoutes(): Route<AgentConfig>[] {
  return [
    {
      method: 'GET',
      path: '/api/skills',
      auth: 'admin',
      handler: async ({ ctx }) => {
        const skills = await listSkills(ctx.db).catch(() => [])
        return Response.json({ ok: true, skills })
      },
    },

    {
      method: 'GET',
      path: '/api/skills/:id',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        // assertSkillId 遇到非法 id 会抛，所以这里要 catch：
        // 一个乱填的 URL 不该打出 500
        try {
          const id = params['id'] ?? ''
          const [skill, content] = await Promise.all([
            getSkill(ctx.db, id),
            getSkillMarkdown(ctx.db, id),
          ])
          // content 是**原始 SKILL.md**（含 frontmatter），给编辑框用；
          // skill 是解析后的字段，给「只读展示」用。两者都返回，
          // 页面就不必再猜要不要自己拼 frontmatter。
          return skill
            ? Response.json({ ok: true, skill, content })
            : Response.json({ ok: false, error: '技能不存在' }, { status: 404 })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    },

    {
      method: 'POST',
      path: '/api/skills',
      auth: 'admin',
      handler: async ({ ctx, request }) => {
        let body: { id?: unknown; content?: unknown }
        try {
          body = (await request.json()) as { id?: unknown; content?: unknown }
        } catch {
          return Response.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
        }
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        const content = typeof body.content === 'string' ? body.content : ''
        if (!id || !content) {
          return Response.json({ ok: false, error: '缺少 id 或 content' }, { status: 400 })
        }
        // 校验错误（id 非法 / 超 32KB / 缺 description）直接把消息回给页面，
        // 运维当场知道写漏了什么，而不是等某次对话才发现技能「消失」
        try {
          const skill = await upsertSkill(ctx.db, { id, content })
          return Response.json({ ok: true, skill })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    },

    {
      method: 'DELETE',
      path: '/api/skills/:id',
      auth: 'admin',
      handler: async ({ ctx, params }) => {
        try {
          const removed = await deleteSkill(ctx.db, params['id'] ?? '')
          return removed
            ? Response.json({ ok: true })
            : Response.json({ ok: false, error: '技能不存在' }, { status: 404 })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    },
  ]
}
