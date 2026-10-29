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

  /**
   * 「所有能搬的操作都搬到 WebUI」——每个配置项都要在页面上有对应控件。
   * 这条测试把它变成契约：以后新增配置项忘了加控件，这里就会失败。
   */
  it('所有配置项都有对应控件（不再需要去面板填表单）', () => {
    for (const id of [
      // 模型
      'modelPicker', 'modelTrigger', 'modelCurrent', 'modelMenu', 'modelSearch', 'modelOptions',
      // 人格（增删改 + 默认人格）
      'personaList', 'personaCount', 'addPersona', 'savePersonaList', 'defaultPersona',
      // 提示词
      'promptBox', 'savePrompt', 'resetPrompt', 'promptState',
      // 唤醒
      'wakeMode', 'wakePrefix', 'friendPrefix', 'commandPrefixes',
      // 能力开关
      'enableTools', 'enableVfs', 'enableSchedule', 'enableAudit', 'showTyping',
      // 限额
      'maxSteps', 'maxToolCalls', 'historyLimit', 'timeoutMs', 'timezone',
      // 会话
      'convSearch', 'convRows',
      // 恢复
      'resetAll', 'overrideState',
      // 三张表
      'scheduleRows', 'auditRows', 'stats',
    ]) {
      expect(PAGE_HTML).toContain(`id="${id}"`)
    }
  })

  it('调用的接口都在 routes 里提供（含本轮新增的设置与会话端点）', () => {
    for (const path of ['/api/overview', '/api/test', '/api/settings', '/api/persona']) {
      expect(PAGE_HTML).toContain(`'${path}'`)
    }
  })

  /**
   * 本轮的核心诉求：「选可用模型别名居然要去配置里手填」。
   * 页面必须把别名做成可点选项，而不是让用户输入。
   */
  it('模型别名是可选列表，不是文本输入框', () => {
    expect(PAGE_HTML).toContain('modelStatus.models')
    expect(PAGE_HTML).toContain('/api/settings')
    // 下拉列表的搜索与勾选态
    expect(PAGE_HTML).toContain('modelSearch')
    expect(PAGE_HTML).toContain("class=\"check\"")
    // 不允许再用「手填别名」的输入框
    expect(PAGE_HTML).not.toContain('placeholder=\"模型别名')
  })

  it('保存失败时提示并把界面刷回真实值，不静默吞掉', () => {
    expect(PAGE_HTML).toContain("notify('保存失败：'")
    // 失败后要重新拉一次状态，否则控件会和实际配置不一致
    expect(PAGE_HTML).toContain('await load()')
  })

  it('用 bridge.toast 给反馈；独立打开时退化为页面内提示', () => {
    expect(PAGE_HTML).toContain('bridge?.toast')
    expect(PAGE_HTML).toContain('toast-wrap')
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
