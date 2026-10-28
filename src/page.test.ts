import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from './page.js'

/**
 * 页面是内联 HTML 字符串，没法在 Node 里真渲染。
 * 这里验证「结构与接口契约对得上」——上一版就是因为
 * overview 返回了 schedules 但页面根本不渲染，才白查了数据。
 */
describe('管理页', () => {
  it('是完整的 HTML 文档', () => {
    expect(PAGE_HTML.startsWith('<!doctype html>')).toBe(true)
    expect(PAGE_HTML).toContain('</html>')
  })

  it('脚本样式全部内联（桥接令牌只在第一个请求里，外链会 401）', () => {
    // 除了 /bridge.js 与 /tokens.css 这两个宿主提供的资源，不应有其他外链
    const externalScripts = [...PAGE_HTML.matchAll(/<script[^>]+src=/g)]
    expect(externalScripts).toHaveLength(0)
    const externalStyles = [...PAGE_HTML.matchAll(/<link[^>]+href="(?!\/tokens\.css)[^"]*"/g)]
    expect(externalStyles).toHaveLength(0)
  })

  it('调用的接口都在 routes 里提供', () => {
    expect(PAGE_HTML).toContain("'/api/overview'")
    expect(PAGE_HTML).toContain("'/api/test'")
  })

  it('四块内容都有容器：模型、能力、定时任务、工具调用', () => {
    for (const id of ['model', 'models', 'ping', 'tools', 'vfs', 'schedule', 'audit', 'scheduleRows', 'auditRows', 'stats']) {
      expect(PAGE_HTML).toContain(`id="${id}"`)
    }
  })

  it('渲染 schedules 与 audits —— 上一版这两个数据取回来就丢了', () => {
    expect(PAGE_HTML).toContain('data.schedules')
    expect(PAGE_HTML).toContain('data.audits')
    expect(PAGE_HTML).toContain('renderSchedules(')
    expect(PAGE_HTML).toContain('renderAudits(')
  })

  it('用户数据一律转义（公开页 XSS 能读到面板令牌，auth 页能读到桥接令牌）', () => {
    // 所有插值都应经过 esc()，不应出现裸的字符串拼接进 innerHTML
    expect(PAGE_HTML).toContain('const esc = (s) =>')
    expect(PAGE_HTML).toContain('esc(s.prompt')
    expect(PAGE_HTML).toContain('esc(a.toolName)')
  })

  it('审计未开启时给出提示，而不是显示空白表', () => {
    expect(PAGE_HTML).toContain('未开启审计')
  })

  it('定时任务为空时显示可读文案，不是空表', () => {
    expect(PAGE_HTML).toContain('没有待触发的定时任务')
  })

  it('长文本截断，避免撑破表格', () => {
    expect(PAGE_HTML).toContain('s.prompt.slice(0, 40)')
  })

  it('会话 id 缩写显示（openid 很长）', () => {
    expect(PAGE_HTML).toContain('shortConversation')
  })
})
