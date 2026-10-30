import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from './page.js'

/**
 * 页面内联脚本的语法校验。
 *
 * 为什么必须守：`PAGE_HTML` 是 TS 模板字符串，里面嵌着浏览器要执行的 JS。
 * 在模板字符串里写反斜杠-n（两个字符）会在**构建时**被求值成真换行，
 * 浏览器收到的就成了跨行的非法字符串字面量 —— 整段脚本 SyntaxError、
 * 页面全白，而 `tsc` 和其它测试都不会报错（它们只把整段当一个普通字符串看）。
 *
 * 这个坑已经踩过两次（技能编辑器、开场对话编辑器），所以留两道守卫。
 */
const open = '<script type="module">'
const start = PAGE_HTML.indexOf(open) + open.length
const end = PAGE_HTML.indexOf('</script>', start)
const body = PAGE_HTML.slice(start, end)

describe('页面内联脚本语法', () => {
  it('能找到脚本段', () => {
    expect(start).toBeGreaterThan(open.length)
    expect(end).toBeGreaterThan(start)
    expect(body.length).toBeGreaterThan(1000)
  })

  it('整段脚本能被解析（任何语法错误都会在这里暴露）', () => {
    // AsyncFunction 的函数体允许顶层 await，正好匹配 <script type="module"> 的语义。
    // 只构造、不执行，所以没有副作用。
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    expect(() => new AsyncFunction(body)).not.toThrow()
  })

  it('脚本里没有会被构建时求值的换行字面量', () => {
    // 匹配「反斜杠 + n」紧贴引号的形式。正确写法是用 NEWLINE 常量。
    const offenders = body
      .split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter((item) => item.line.includes("\\n'") || item.line.includes('\\n"'))
    expect(
      offenders.map((o) => '第 ' + o.no + ' 行: ' + o.line.trim().slice(0, 60)),
      '这些行的反斜杠-n 会在构建时变成真换行，必须改用 NEWLINE 常量',
    ).toEqual([])
  })

  it('提供了 NEWLINE 常量供页面脚本使用', () => {
    expect(body).toContain('const NEWLINE = String.fromCharCode(10)')
  })

  it('关键 UI 代码都在脚本里', () => {
    for (const name of [
      'renderTools',
      'renderSkills',
      'openSkillEditor',
      'openToolConfig',
      'createDialogPairs',
      'createCheckList',
      'confirmAction',
    ]) {
      expect(body).toContain(name)
    }
  })
})
