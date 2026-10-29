import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from './page.js'

/**
 * 页面内联脚本的**语法**校验。
 *
 * 为什么需要这条：`PAGE_HTML` 是 TS 模板字符串，里面嵌着浏览器要执行的 JS。
 * 在模板字符串里写 `'\n'` 会被**构建时求值成真换行**，浏览器收到的就成了
 * 跨行的非法字符串字面量 —— 整个脚本直接 SyntaxError、页面全白，
 * 而 `tsc` 和其他测试都不会报错（它们只把整段当一个普通字符串看）。
 *
 * 这个坑本轮真实踩到过一次（技能编辑器的默认内容），所以留一条守卫。
 *
 * 做法不依赖 Node API（本项目 tsconfig 是 Workers 环境、没有 @types/node）：
 * 把脚本包进 `AsyncFunction` 构造函数——模块顶层允许 `await`，
 * 而 `AsyncFunction` 的函数体同样允许，所以这样能真实校验整段语法。
 */
describe('页面内联脚本语法', () => {
  const open = '<script type="module">'
  const start = PAGE_HTML.indexOf(open) + open.length
  const end = PAGE_HTML.indexOf('</script>', start)
  const body = PAGE_HTML.slice(start, end)

  it('能找到脚本段', () => {
    expect(start).toBeGreaterThan(open.length)
    expect(end).toBeGreaterThan(start)
    expect(body.length).toBeGreaterThan(1000)
  })

  it('整段脚本能被解析（任何语法错误都会在这里暴露）', () => {
    // AsyncFunction 的函数体允许顶层 await，正好匹配 `<script type="module">` 的语义。
    // 这里只构造、不执行，所以不会有副作用。
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    expect(() => new AsyncFunction(body)).not.toThrow()
  })

  it('新增的两块 UI 代码都在脚本里', () => {
    for (const name of ['renderTools', 'renderSkills', 'openSkillEditor', 'saveToolToggle']) {
      expect(body).toContain(name)
    }
  })
})
