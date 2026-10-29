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
      'wakePrefix', 'friendPrefix', 'commandPrefixes',
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
      // 工具栏（单工具开关）
      'toolList', 'toolCount',
      // 技能（列表 + 编辑器）
      'skillList', 'skillCount', 'addSkill', 'skillEditor', 'skillId', 'skillBody', 'saveSkill', 'cancelSkill',
    ]) {
      expect(PAGE_HTML).toContain(`id="${id}"`)
    }
  })

  it('调用的接口都在 routes 里提供（含本轮新增的设置与会话端点）', () => {
    for (const path of ['/api/overview', '/api/test', '/api/settings', '/api/persona', '/api/tools']) {
      expect(PAGE_HTML).toContain(`'${path}'`)
    }
  })

  /**
   * 工具栏与技能是本轮新增的两块管理面。它们必须是**可操作的控件**，
   * 不是只读展示——这两个功能的 API 早就有了，但页面上没控件，
   * 使用门槛等于「手写 curl」。
   */
  it('工具栏：每个工具一个开关，且走事件委托（列表是渲染出来的）', () => {
    expect(PAGE_HTML).toContain('renderTools(')
    expect(PAGE_HTML).toContain('tool-toggle')
    expect(PAGE_HTML).toContain("postJson('/api/tools'")
    // 列表每次 load() 都重建，直接绑 id 会漏绑，所以必须委托到容器
    expect(PAGE_HTML).toContain("$('toolList').addEventListener('change'")
  })

  it('工具关掉后整行压暗，让「哪些没开」一眼可见', () => {
    expect(PAGE_HTML).toContain("' off'")
    expect(PAGE_HTML).toContain('.tool-row.off')
  })

  it('技能：列表 + 新增/编辑/删除，且编辑器接的是原始 SKILL.md', () => {
    expect(PAGE_HTML).toContain('renderSkills(')
    expect(PAGE_HTML).toContain("postJson('/api/skills'")
    // 编辑要拿原文，不能拿解析后的字段自己拼 frontmatter
    expect(PAGE_HTML).toContain('data?.content')
    expect(PAGE_HTML).not.toContain('data?.skill?.content')
  })

  it('技能列表只取目录，正文按需单独取（避免一次拖下所有 SKILL.md）', () => {
    expect(PAGE_HTML).toContain("'/api/skills/'")
    expect(PAGE_HTML).toContain('encodeURIComponent')
  })

  it('删除技能要二次确认（不可逆操作）', () => {
    expect(PAGE_HTML).toContain('confirm(')
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

/**
 * 布局：侧边栏 + 分面板（对标 serverless-agent 的 admin-web）。
 *
 * 上一版把 13 张卡片堆在单页里，要滚很久才能找到东西，且「配置」与「统计表」
 * 混在一起。这些用例锁住新结构：一屏只做一件事。
 */
describe('布局：侧边栏 + 分面板', () => {
  it('有侧边栏导航', () => {
    expect(PAGE_HTML).toContain('class="nav-list"')
    expect(PAGE_HTML).toContain('data-view="model"')
  })

  it('六个面板都在，且只有一个默认激活', () => {
    const panels = [...PAGE_HTML.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1])
    expect(panels.sort()).toEqual(['chat', 'data', 'model', 'skills', 'stats', 'tools'])
  })

  it('默认只激活第一个面板（其余 hidden）', () => {
    // 只应有一个 panel 同时带 active
    const active = [...PAGE_HTML.matchAll(/class="panel active"/g)]
    expect(active).toHaveLength(1)
  })

  it('导航项与面板一一对应（点得到、切得过去）', () => {
    const navViews = new Set(
      [...PAGE_HTML.matchAll(/data-view="(\w+)"/g)].map((m) => m[1]),
    )
    const panels = new Set([...PAGE_HTML.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1]))
    expect([...navViews].sort()).toEqual([...panels].sort())
  })

  it('有面板标题栏（切换时更新标题）', () => {
    expect(PAGE_HTML).toContain('id="viewTitle"')
    expect(PAGE_HTML).toContain('id="viewKicker"')
  })

  it('切换逻辑存在，且记住当前面板（刷新不跳回第一个）', () => {
    expect(PAGE_HTML).toContain('function applyView')
    expect(PAGE_HTML).toContain('function initNavigation')
    expect(PAGE_HTML).toContain('location.hash')
    // 启动时必须调用，否则导航是死的
    expect(PAGE_HTML).toContain('initNavigation()')
  })

  it('窄屏下侧边栏变横排（不是直接消失）', () => {
    expect(PAGE_HTML).toContain('@media (max-width: 860px)')
  })
})

/**
 * 结构完整性：标签必须配平。
 *
 * 页面是手写模板字符串，少一个 `</div>` 浏览器会「自动修正」——
 * 但修正的结果往往是整块内容跑到错误的位置，而字符串断言完全看不出来。
 */
describe('结构完整性', () => {
  const count = (tag: string) => {
    const open = [...PAGE_HTML.matchAll(new RegExp(`<${tag}\\b`, 'g'))].length
    const close = [...PAGE_HTML.matchAll(new RegExp(`</${tag}>`, 'g'))].length
    return { open, close }
  }

  it.each(['div', 'section', 'aside', 'main', 'header', 'body', 'html', 'table', 'tbody', 'thead', 'tr', 'nav', 'button'])(
    '<%s> 开闭配平',
    (tag) => {
      const { open, close } = count(tag)
      expect(open, `${tag} 标签数量`).toBe(close)
      expect(open).toBeGreaterThan(0)
    },
  )

  it('aside/main 包在 app-shell 里，面板包在 main 里', () => {
    const shell = PAGE_HTML.indexOf('class="app-shell"')
    const aside = PAGE_HTML.indexOf('<aside')
    const main = PAGE_HTML.indexOf('<main')
    const firstPanel = PAGE_HTML.indexOf('data-panel=')
    expect(shell).toBeGreaterThan(-1)
    expect(aside).toBeGreaterThan(shell)
    expect(main).toBeGreaterThan(aside)
    expect(firstPanel).toBeGreaterThan(main)
  })
})

/**
 * 面板归属：每张卡片必须在**语义正确**的面板里。
 *
 * 这不是吹毛求疵——上一版把「限额」漏在了技能面板里，用户想调步数上限
 * 会去「对话行为」里找，找不到。这类错误靠"页面能打开"是发现不了的。
 */
describe('卡片归属正确', () => {
  /** 从 HTML 里切出每个面板的内容，断言每张卡片落在哪个面板 */
  function panelContent(name: string): string {
    const start = PAGE_HTML.indexOf(`data-panel="${name}"`)
    const next = PAGE_HTML.indexOf('<section class="panel', start + 1)
    return PAGE_HTML.slice(start, next === -1 ? undefined : next)
  }

  const expectations: Array<[string, string[]]> = [
    ['model', ['模型', '人格']],
    ['chat', ['系统提示词', '群聊唤醒', '能力开关', '限额']],
    ['tools', ['工具']],
    ['skills', ['技能']],
    ['data', ['会话', '定时任务', '工具调用']],
    ['stats', ['最近 14 天']],
  ]

  it.each(expectations)('%s 面板包含约定的区块', (panel, sections) => {
    const content = panelContent(panel)
    for (const section of sections) {
      expect(content, `${panel} 面板应包含「${section}」`).toContain(`<h2>${section}`)
    }
  })

  it('「限额」不能落在技能面板（曾经落错过）', () => {
    expect(panelContent('skills')).not.toContain('<h2>限额')
    expect(panelContent('chat')).toContain('<h2>限额')
  })
})

/**
 * 响应式：窄屏不许把内容顶出屏幕。
 *
 * 这类问题只能靠要素层面的规则来守（没有浏览器就没法测真实布局）：
 * - `grid-template-columns: 1fr` 的最小值是 `auto`，内容会撑破列 → 必须用 `minmax(0,1fr)`
 * - 长工具名/长 URL 不会自动断行 → 必须声明 `overflow-wrap`
 * - 兜底 `overflow-x: hidden`，避免任何情况整页横滚
 */
describe('响应式布局', () => {
  it('窄屏用 minmax(0, 1fr) 而不是 1fr（否则长内容会撑破列）', () => {
    expect(PAGE_HTML).toContain('minmax(0, 1fr)')
  })

  it('有 overflow-x 兜底，任何情况都不整页横向滚动', () => {
    expect(PAGE_HTML).toContain('overflow-x: hidden')
  })

  it('长标识符能断行（工具名/技能 id/表格单元格）', () => {
    expect(PAGE_HTML).toContain('overflow-wrap: anywhere')
  })

  it('窄屏下侧边栏变成横向导航而不是消失', () => {
    // 不能 display:none 掉导航——那样窄屏就没法切面板了
    expect(PAGE_HTML).toContain('.nav-list {')
    expect(PAGE_HTML).toContain('overflow-x: auto')
  })

  it('窄屏下卡片/输入框取消固定最大宽度', () => {
    expect(PAGE_HTML).toContain('.card { max-width: 100%')
  })
})
