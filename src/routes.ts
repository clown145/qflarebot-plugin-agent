/**
 * 插件页面与 API 路由（组装入口）。
 *
 * 页面是**单个 HTML 文件**（脚本样式内联），因为 QFlareBot 的桥接令牌只在
 * iframe 的第一个请求里（`?token=`），页面再加载的 JS/CSS 带不上它。
 * 详见 QFlareBot 的 docs/ui.md 第 4 条。
 *
 * ## 为什么拆成四个模块
 *
 * 这个文件原本是 560 行、其中一个 `createPageRoutes` 函数独占 401 行
 * （12 个路由全塞在同一个 `return [...]` 里）。改任何一个路由都要在
 * 几百行里找位置，review 时也看不出改动落在哪个领域。
 *
 * 现在按领域拆分，各自一个文件：
 *
 * ```text
 * routes/page-routes.ts      页面 HTML + /api/overview
 * routes/settings-routes.ts  配置、人格、连通性测试
 * routes/tools-routes.ts     工具开关与单工具配置
 * routes/skills-routes.ts    技能 CRUD
 * routes/format.ts           时间格式化
 * routes/config-validation.ts 配置字段校验
 * ```
 *
 * 这里只负责把它们拼起来。顺序不影响语义（路由按 method + path 匹配），
 * 但保持「页面 → 配置 → 工具 → 技能」的阅读顺序。
 */
import type { Route } from '@qqbot/sdk'
import type { AgentConfig } from './config/index.js'
import { createPageRoutesPage } from './routes/page-routes.js'
import { createSettingsRoutes } from './routes/settings-routes.js'
import { createToolsRoutes } from './routes/tools-routes.js'
import { createSkillsRoutes } from './routes/skills-routes.js'

export function createPageRoutes(): Route<AgentConfig>[] {
  return [
    ...createPageRoutesPage(),
    ...createSettingsRoutes(),
    ...createToolsRoutes(),
    ...createSkillsRoutes(),
  ]
}
