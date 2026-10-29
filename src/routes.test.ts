/**
 * 路由契约：页面需要的接口都必须存在、且都是 admin。
 *
 * 之前发生过「overview 返回了 schedules 但页面不渲染」；现在是反向的风险——
 * 页面渲染 tools/skills，overview 却忘了返回，页面就显示空白且不报错。
 * 这里锁住「页面用到的接口与鉴权」这一层，字段级契约由 page.test.ts 覆盖。
 */
import { describe, expect, it } from 'vitest'
import { createPageRoutes } from './routes.js'
import type { Route } from '@qqbot/sdk'

function findRoute(method: string, path: string): Route<any> | undefined {
  return createPageRoutes().find((r) => r.method === method && r.path === path)
}

describe('overview 契约', () => {
  it('有 /api/overview 路由且是 admin', () => {
    const route = findRoute('GET', '/api/overview')
    expect(route).toBeDefined()
    expect(route?.auth).toBe('admin')
  })

  it('工具栏与技能路由都存在且是 admin', () => {
    for (const [method, path] of [
      ['GET', '/api/tools'],
      ['POST', '/api/tools'],
      ['GET', '/api/skills'],
      ['GET', '/api/skills/:id'],
      ['POST', '/api/skills'],
      ['DELETE', '/api/skills/:id'],
    ] as const) {
      const route = findRoute(method, path)
      expect(route, `${method} ${path}`).toBeDefined()
      expect(route?.auth, `${method} ${path}`).toBe('admin')
    }
  })
})
