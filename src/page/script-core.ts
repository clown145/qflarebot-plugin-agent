/**
 * 共享基础设施：DOM 助手、请求、状态
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const SCRIPT_CORE = `
/**
 * 页面脚本。
 *
 * 三条必须遵守的约束：
 * 1. **不写 innerHTML 拼用户数据** —— 页面在 iframe 里是 opaque origin，
 *    XSS 拿不到面板会话令牌，但能拿到本插件的桥接令牌，照样按这个规矩写。
 *    所有插值走 esc()。
 * 2. **内容高度一变就 resize** —— iframe 靠它撑高，漏一次就显示不全。
 * 3. **不自己实现宿主已有的东西** —— 卡片/按钮/输入框用 .qb-*。
 */
const $ = (id) => document.getElementById(id)
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ---------------------------------------------------------------- 请求 */

async function request(path, init) {
  const res = bridge ? await bridge.fetch(path, init) : await fetch('/p/agent' + path, init)
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.error ?? ''
    } catch {
      /* 响应不是 JSON 就用状态码 */
    }
    throw new Error(detail || 'HTTP ' + res.status)
  }
  return res.json()
}

const get = (path) => request(path)
const postJson = (path, body) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })

/* ---------------------------------------------------------------- 状态 */

let state = {
  config: {},
  modelStatus: {},
  personas: {},
  bindings: [],
  tools: { list: [], disabled: [] },
  skills: [],
  schedules: [],
  audits: [],
  stats: [],
}

let draftPersonas = []

const isOverridden = (key) => (state.config.overriddenKeys ?? []).includes(key)

async function savePatch(patch, successMessage) {
  try {
    await postJson('/api/settings', { patch })
    if (successMessage) notify(successMessage, 'success')
    await load()
  } catch (e) {
    notify('保存失败：' + e.message, 'error')
    await load()
  }
}
`
