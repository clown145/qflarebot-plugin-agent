/**
 * 页面脚本的组装入口。
 *
 * 把 `page/` 下的片段按**依赖顺序**拼成一个 `<script type="module">` 的内容。
 *
 * ## 为什么要按顺序
 *
 * 片段之间共享同一作用域，且部分是**顶层语句**（`const $ = ...`、
 * 顶层的 `await import('/bridge.js')`、末尾的 `await load()`）。
 * 顺序错了会直接 `ReferenceError` 或 `TDZ` 报错，所以顺序在这里显式写死：
 *
 * ```text
 * core → shell → inputs → views → boot
 * ```
 *
 * - `core` 定义 `$` / `esc` / `request` / `state`，后面全都要用
 * - `shell` 用 `$`，定义 `bridge` 与 `notifyResize`，视图渲染时会调
 * - `inputs` 是通用控件，视图会调
 * - `views` 是各面板渲染函数，`boot` 会调
 * - `boot` 做事件绑定与启动（含末尾的 `await load()`）
 *
 * ## 为什么不用 ES module
 *
 * 用 import/export 就得处理「谁先执行」，而这些片段里有顶层 `await`。
 * 拼成一段反而让顺序一目了然，也避免为了共享 `state` 去搞依赖注入。
 * 页面跑在 sandbox iframe 里，变量不泄漏到面板作用域，所以可接受。
 *
 * 每个片段文件是 `.js`（不是 `.ts`）——它们是浏览器要执行的纯 JS，
 * 放 `.ts` 会让人以为可以写类型注解，而那是**构建时不会被剥离**的，
 * 浏览器拿到会直接语法错误。`page-syntax.test.ts` 守这条。
 */
import { SCRIPT_CORE } from './script-core.js'
import { SCRIPT_SHELL } from './script-shell.js'
import { SCRIPT_INPUTS } from './script-inputs.js'
import { VIEW_PERSONA } from './view-persona.js'
import { VIEW_TOOLS } from './view-tools.js'
import { VIEW_SKILLS } from './view-skills.js'
import { VIEW_DATA } from './view-data.js'
import { SCRIPT_BOOT } from './boot.js'

export const PAGE_SCRIPT = [
  SCRIPT_CORE,
  SCRIPT_SHELL,
  SCRIPT_INPUTS,
  VIEW_PERSONA,
  VIEW_TOOLS,
  VIEW_SKILLS,
  VIEW_DATA,
  SCRIPT_BOOT,
].join('\n\n')
