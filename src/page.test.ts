import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from './page.js'

/**
 * 管理页的结构契约。
 *
 * 页面是内联 HTML 字符串，没有浏览器就没法测真实布局。这里守的是
 * **规范层面的硬要求**——每一条都对应一次真实的踩坑，不是形式主义。
 */

describe('基本结构', () => {
  it('是完整的 HTML 文档', () => {
    expect(PAGE_HTML.startsWith('<!doctype html>')).toBe(true)
    expect(PAGE_HTML).toContain('</html>')
  })

  it('脚本样式全部内联（桥接令牌只在第一个请求里，外链会 401）', () => {
    const externalScripts = [...PAGE_HTML.matchAll(/<script[^>]+src=/g)]
    expect(externalScripts).toHaveLength(0)
    const externalStyles = [...PAGE_HTML.matchAll(/<link[^>]+href="(?!\/tokens\.css)[^"]*"/g)]
    expect(externalStyles).toHaveLength(0)
  })

  it('引宿主的 tokens.css 与 bridge.js', () => {
    expect(PAGE_HTML).toContain('href="/tokens.css"')
    expect(PAGE_HTML).toContain("import('/bridge.js')")
  })

  it('body 用宿主的 .qb-page 基线类', () => {
    // 规范：引 /tokens.css 即拿到同一组变量，.qb-page/.qb-card/.qb-btn/.qb-input 是最小基线
    expect(PAGE_HTML).toContain('<body class="qb-page">')
  })

  it('卡片和按钮用宿主类，不自己实现', () => {
    expect(PAGE_HTML).toContain('class="qb-card"')
    expect(PAGE_HTML).toContain('class="qb-btn')
    expect(PAGE_HTML).toContain('class="qb-input"')
  })
})

describe('iframe 约束（这是「页面显示不全」的根因）', () => {
  it('不用 100vh —— iframe 高度由 bridge.resize 决定，100vh 会互相拉扯', () => {
    // 允许注释里提到，但不允许出现在 CSS 声明中
    const css = PAGE_HTML.slice(PAGE_HTML.indexOf('<style>'), PAGE_HTML.indexOf('</style>'))
    expect(css).not.toMatch(/height:\s*100vh/)
    expect(css).not.toMatch(/min-height:\s*100vh/)
  })

  it('不用粘性/固定高度侧栏（会造成双层滚动）', () => {
    const css = PAGE_HTML.slice(PAGE_HTML.indexOf('<style>'), PAGE_HTML.indexOf('</style>'))
    expect(css).not.toMatch(/position:\s*sticky/)
    expect(css).not.toMatch(/height:\s*100dvh/)
  })

  it('内容高度变化后调用 resize', () => {
    expect(PAGE_HTML).toContain('function notifyResize')
    expect(PAGE_HTML).toContain('bridge?.resize?.()')
    // 切标签和加载数据后都要调
    expect(PAGE_HTML).toContain('notifyResize()')
  })

  it('内容区居中且限宽（规范：最宽 1152px）', () => {
    expect(PAGE_HTML).toContain('max-width: 1152px')
    expect(PAGE_HTML).toContain('margin-inline: auto')
  })
})

describe('交互结构：页内标签而不是侧边导航', () => {
  it('用页内标签（对标 QSegmented），不重复面板侧栏', () => {
    expect(PAGE_HTML).toContain('class="segmented"')
    expect(PAGE_HTML).toContain('id="segThumb"')
    // 不应该再有侧边栏
    expect(PAGE_HTML).not.toContain('<aside')
  })

  it('五个标签一一对应面板', () => {
    const tabs = [...PAGE_HTML.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]).sort()
    const panels = [...PAGE_HTML.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1]).sort()
    expect(tabs).toEqual(['behavior', 'data', 'model', 'skills', 'tools'])
    expect(panels).toEqual(tabs)
  })

  it('标签记在地址里，刷新不跳回第一个', () => {
    expect(PAGE_HTML).toContain('location.hash')
    expect(PAGE_HTML).toContain('history.replaceState')
  })

  it('标签有 ARIA 角色（屏幕阅读器可用）', () => {
    expect(PAGE_HTML).toContain('role="tablist"')
    expect(PAGE_HTML).toContain('role="tab"')
    expect(PAGE_HTML).toContain('role="tabpanel"')
    expect(PAGE_HTML).toContain('aria-selected')
  })
})

describe('组件对齐面板的设计语言', () => {
  it('开关是 44px 热区的 role=switch，不是裸 checkbox', () => {
    expect(PAGE_HTML).toContain('role="switch"')
    expect(PAGE_HTML).toContain('aria-checked')
    expect(PAGE_HTML).toContain('.switch')
  })

  it('确认用自绘对话框，不用浏览器 confirm', () => {
    expect(PAGE_HTML).toContain('function confirmAction')
    expect(PAGE_HTML).not.toContain('window.confirm')
    // Esc 可关、默认聚焦取消
    expect(PAGE_HTML).toContain("e.key === 'Escape'")
    expect(PAGE_HTML).toContain('[data-act="cancel"]')
  })

  it('列表值用逐条输入的 chip，不用「一行一个」的文本框', () => {
    expect(PAGE_HTML).toContain('function createListInput')
    expect(PAGE_HTML).toContain('.chip')
  })

  it('加载用骨架屏，不是一行「加载中…」', () => {
    expect(PAGE_HTML).toContain('function skeletonHtml')
    expect(PAGE_HTML).toContain('.sk-line')
  })

  it('空状态有标题和下一步说明（对标 QEmpty）', () => {
    expect(PAGE_HTML).toContain('empty-title')
    expect(PAGE_HTML).toContain('empty-desc')
  })

  it('有动效，且遵守 prefers-reduced-motion', () => {
    expect(PAGE_HTML).toContain('--qb-duration')
    expect(PAGE_HTML).toContain('prefers-reduced-motion')
  })
})

describe('信息架构：每块内容在正确的标签里', () => {
  function panelContent(name: string): string {
    const start = PAGE_HTML.indexOf(`data-panel="${name}"`)
    const next = PAGE_HTML.indexOf('<section class="panel"', start + 1)
    return PAGE_HTML.slice(start, next === -1 ? undefined : next)
  }

  it.each([
    ['model', ['模型', '人格']],
    ['behavior', ['系统提示词', '群聊唤醒', '能力开关', '限额']],
    ['tools', ['工具']],
    ['skills', ['技能']],
    ['data', ['会话', '定时任务', '工具调用', '最近 14 天']],
  ])('%s 标签包含约定的卡片', (panel, titles) => {
    const content = panelContent(panel)
    for (const title of titles) {
      expect(content, `${panel} 应包含「${title}」`).toContain(`<h2 class="card-title">${title}`)
    }
  })

  it('「限额」不在技能面板里（曾经放错过）', () => {
    expect(panelContent('skills')).not.toContain('限额')
    expect(panelContent('behavior')).toContain('限额')
  })
})

describe('安全：用户数据不进 innerHTML', () => {
  it('有 esc() 供无法避免的模板拼接使用', () => {
    expect(PAGE_HTML).toContain('const esc =')
    expect(PAGE_HTML).toContain('esc(title)')
  })

  it('列表与表格用 createElement + textContent，而不是拼 innerHTML', () => {
    // 这是更强的保证：textContent 天然不解析标签，比事后 esc 更难写错
    expect(PAGE_HTML).toContain('textContent = tool.name')
    expect(PAGE_HTML).toContain('textContent = skill.name')
    expect(PAGE_HTML).toContain('textContent = value')
  })

  it('确认框与技能名等动态文本走 textContent 或 esc', () => {
    // 确认框正文用 esc 包过
    expect(PAGE_HTML).toMatch(/esc\(text\)/)
  })
})

describe('标签配平（手写模板最容易漏）', () => {
  const count = (tag: string) => ({
    open: [...PAGE_HTML.matchAll(new RegExp(`<${tag}\\b`, 'g'))].length,
    close: [...PAGE_HTML.matchAll(new RegExp(`</${tag}>`, 'g'))].length,
  })

  it.each(['div', 'section', 'main', 'body', 'html', 'table', 'tbody', 'thead', 'tr', 'button', 'nav'])(
    '<%s> 开闭配平',
    (tag) => {
      const { open, close } = count(tag)
      expect(open, tag).toBe(close)
    },
  )
})

/**
 * 本轮（v0.1.1）的可用性修复。
 *
 * 每一条都对应一个「用户看到才发现」的真实问题，不是形式主义。
 */
describe('可用性：不要让人手打机器该给的东西', () => {
  it('开场对话是成对输入，不是让人手打 user: 前缀', () => {
    expect(PAGE_HTML).toContain('function createDialogPairs')
    expect(PAGE_HTML).toContain('parseDialogText')
    expect(PAGE_HTML).toContain('serializeDialogPairs')
    // 存储格式仍然兼容（老配置原样读得出来）
    expect(PAGE_HTML).toContain('user: ')
  })

  it('开场对话一行用户一行角色（不是挤在同一行导致标签重叠）', () => {
    // 用纵向堆叠而不是 grid 单行多列：窄屏下 auto 列会被压缩，
    // 标签会溢出到前一个输入框的边框上，看着像重叠
    const fn = PAGE_HTML.slice(PAGE_HTML.indexOf('function createDialogPairs'))
    const body = fn.slice(0, fn.indexOf('\nfunction createCheckList'))
    expect(body).toContain("line('用户'")
    expect(body).toContain("line('角色'")
    // 不应该再有「一行塞两列输入」的 grid 模板
    expect(body).not.toContain('gridTemplateColumns = \'auto 1fr auto 1fr auto\'')
  })

  it('工具与技能是勾选清单，不是手打名字', () => {
    expect(PAGE_HTML).toContain('function createCheckList')
    // 选项来自实际注册的工具/已配置的技能
    expect(PAGE_HTML).toContain('state.tools?.list')
    expect(PAGE_HTML).toContain('state.skills')
  })

  it('指令前缀不再让用户配（由宿主统一管理）', () => {
    expect(PAGE_HTML).not.toContain('id="commandPrefixes"')
    expect(PAGE_HTML).toContain('跟随面板')
  })

  it('工具的配置在自己的弹窗里，不在通用设置里', () => {
    // api key 这类属于单个工具，页面按工具声明的 configFields 生成表单
    expect(PAGE_HTML).toContain('function openToolConfig')
    expect(PAGE_HTML).toContain('tool.configFields')
    expect(PAGE_HTML).toContain("'/api/tools/config'")
    // 插件通用设置里不该再有搜索 key
    expect(PAGE_HTML).not.toContain('id="searchApiKey"')
  })

  it('默认人格改名后会重刷下拉（否则保存时会写丢）', () => {
    expect(PAGE_HTML).toContain('function renderDefaultPersonaSelect')
    // 改名回调里要重刷
    expect(PAGE_HTML).toContain('renderDefaultPersonaSelect(draftPersonas)')
  })

  it('人格卡片上标出哪套是默认', () => {
    expect(PAGE_HTML).toContain('badge--accent">默认')
  })

  it('说明文字不写废话（不解释「点选即可」这种显然的事）', () => {
    expect(PAGE_HTML).not.toContain('点选即可')
    expect(PAGE_HTML).not.toContain('不用手打')
    expect(PAGE_HTML).not.toContain('不需要回面板填表单')
  })
})

/**
 * 单项「已改」标记 + 单项恢复。
 *
 * 之前只有底部一个「全部恢复成配置值」：改了某一项想单独退回去，
 * 只能全部重置再重改一遍。对标 AstrBot 的「改过的字段标圆点、可恢复默认」。
 *
 * 后端早就支持（`POST /api/settings` 的 `reset: [字段]`），
 * 这部分纯粹是 UI 没用足 —— 所以测试重点在「接线」而不是接口。
 */
describe('单项已改标记与恢复', () => {
  it('有渲染徽标的函数，且在 renderConfig 里被调用', () => {
    expect(PAGE_HTML).toContain('function renderOverrideBadges')
    expect(PAGE_HTML).toContain('renderOverrideBadges()')
  })

  it('每个配置项都有字段 → 控件的映射', () => {
    // 覆盖所有会进 overriddenKeys 的字段，漏一个就有一项恢复不了
    for (const field of [
      'model', 'system_prompt', 'wake_prefix', 'friend_needs_wake_prefix',
      'max_model_steps', 'max_tool_calls', 'history_limit', 'request_timeout_ms',
      'timezone', 'context_compression', 'max_context_tokens', 'rate_limit_per_minute',
      'enable_tools', 'enable_vfs', 'enable_schedule', 'enable_skills',
      'enable_audit', 'show_typing', 'content_filter_keywords',
      'personas', 'default_persona',
    ]) {
      expect(PAGE_HTML, `缺少 ${field} 的映射`).toContain(field + ':')
    }
  })

  it('恢复单个字段走 reset 数组，而不是整体重置', () => {
    expect(PAGE_HTML).toContain('function resetField')
    // 关键：只重置这一项，不能误用 reset: true 把全部清掉
    expect(PAGE_HTML).toContain('reset: [field]')
  })

  it('标记是幂等注入的（反复渲染不重复堆叠）', () => {
    // 每次都先清理再插，否则每轮 load() 都会多一层徽标
    expect(PAGE_HTML).toContain('function clearOverrideBadges')
    expect(PAGE_HTML).toContain('clearOverrideBadges()')
  })

  it('撤消按钮有可访问名（不是只有一个 × 符号）', () => {
    expect(PAGE_HTML).toContain('aria-label')
    expect(PAGE_HTML).toContain("'恢复「'")
  })

  it('标记有 title 说明它改的是哪一项', () => {
    expect(PAGE_HTML).toContain('被本页改过，点 × 恢复成插件配置里的值')
  })

  it('不再重复显示「已改」文字（徽标已经表达了）', () => {
    // 之前 modelHint / promptState 也写「已改」，和徽标重复
    expect(PAGE_HTML).not.toContain('本页覆盖</span>')
  })
})
