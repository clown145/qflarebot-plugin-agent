/**
 * 插件管理页。单文件 HTML，脚本样式全内联。
 *
 * 用 `/bridge.js` 拿桥接令牌并跟随面板主题；`bridge.fetch` 自动带令牌，
 * 相对路径以 `/p/agent` 解析（见 QFlareBot 的 docs/ui.md）。
 *
 * 四块内容：模型状态、能力开关、定时任务、工具调用记录。
 * 后两块的数据来自插件自己的 `auth: 'admin'` 接口，不是宿主面板。
 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent</title>
<link rel="stylesheet" href="/tokens.css">
<style>
  /* 宿主 tokens.css 里的变量全部带 --qb- 前缀（--qb-fg / --qb-surface / --qb-space-2 …）。
     早先这里用了 --bg / --fg / --card / --accent 这类不存在的名字，浏览器一律回退到空值，
     页面因此变成「白底黑字、没有间隙、按钮看不清」——这就是它看起来毫无可读性的原因。
     现在全部改用真实 token（与内置 t2i 插件页面同一套）。 */
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: var(--qb-space-5);
    background: var(--qb-bg); color: var(--qb-fg);
    font: var(--qb-text-sm) / var(--qb-leading) var(--qb-font-sans);
  }
  h1 { font-size: var(--qb-text-lg); margin: 0 0 var(--qb-space-1); }
  .sub {
    color: var(--qb-fg-muted); font-size: var(--qb-text-xs);
    margin-bottom: var(--qb-space-4); line-height: var(--qb-leading);
  }
  .card {
    background: var(--qb-surface); border: 1px solid var(--qb-border);
    border-radius: var(--qb-radius); padding: var(--qb-space-4);
    margin-bottom: var(--qb-space-4);
  }
  .card h2 { font-size: var(--qb-text-sm); margin: 0 0 var(--qb-space-1); font-weight: 600; }
  .card .hint {
    color: var(--qb-fg-muted); font-size: var(--qb-text-xs);
    margin: 0 0 var(--qb-space-3); line-height: var(--qb-leading);
  }
  .row {
    display: flex; justify-content: space-between; align-items: center; gap: var(--qb-space-3);
    padding: var(--qb-space-1) 0; border-bottom: 1px solid var(--qb-border);
  }
  .row:last-child { border-bottom: 0; }
  .row .k { color: var(--qb-fg-muted); }
  .ok { color: var(--qb-success); }
  .bad { color: var(--qb-danger); }
  .warn { color: var(--qb-warning); }

  table { width: 100%; border-collapse: collapse; font-size: var(--qb-text-xs); }
  th, td { text-align: left; padding: var(--qb-space-2) var(--qb-space-1); border-bottom: 1px solid var(--qb-border); }
  th { color: var(--qb-fg-muted); font-weight: 500; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.ops { text-align: right; white-space: nowrap; }

  /* 下拉选择器（模型）：触发器显示当前值，展开是带勾选的列表。
     与 AstrBot 面板的 ProviderModelMenu 同一套交互：点触发器 → 列表 → 点一项立即生效 */
  .picker { position: relative; max-width: 420px; }
  .trigger {
    width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--qb-space-2);
    background: var(--qb-input); color: var(--qb-fg);
    border: 1px solid var(--qb-border); border-radius: var(--qb-radius-sm);
    padding: var(--qb-space-2) var(--qb-space-3);
    font-size: var(--qb-text-sm); cursor: pointer; text-align: left; min-height: var(--qb-control-height);
  }
  .trigger:hover:not(:disabled) { border-color: var(--qb-border-strong); }
  .trigger:disabled { opacity: .6; cursor: default; }
  .trigger-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .trigger-meta { color: var(--qb-fg-muted); font-size: var(--qb-text-xs); }
  .trigger-chevron { color: var(--qb-fg-muted); }

  .menu {
    position: absolute; z-index: 20; left: 0; right: 0; margin-top: var(--qb-space-1);
    background: var(--qb-surface); border: 1px solid var(--qb-border);
    border-radius: var(--qb-radius-sm); box-shadow: var(--qb-shadow-overlay);
    padding: var(--qb-space-1); max-height: 320px; overflow: auto;
  }
  .options { display: flex; flex-direction: column; gap: 2px; }
  .opt {
    display: flex; align-items: center; justify-content: space-between; gap: var(--qb-space-2);
    width: 100%; background: transparent; color: var(--qb-fg); border: 0;
    border-radius: var(--qb-radius-sm); padding: var(--qb-space-2) var(--qb-space-3);
    font-size: var(--qb-text-sm); cursor: pointer; text-align: left;
  }
  .opt:hover { background: var(--qb-surface-muted); }
  .opt.on { color: var(--qb-accent); font-weight: 500; }
  .menu-empty { color: var(--qb-fg-muted); font-size: var(--qb-text-xs); padding: var(--qb-space-3); text-align: center; }

  .search, select.select-inline {
    background: var(--qb-input); color: var(--qb-fg);
    border: 1px solid var(--qb-border); border-radius: var(--qb-radius-sm);
    padding: var(--qb-space-2) var(--qb-space-3); font-size: var(--qb-text-xs);
    font-family: inherit;
  }
  .search { width: 100%; margin-bottom: var(--qb-space-1); }
  select.select-inline { width: auto; min-width: 7rem; }
  .search:focus, select.select-inline:focus {
    outline: none; border-color: var(--qb-accent); box-shadow: 0 0 0 2px var(--qb-ring);
  }

  textarea {
    width: 100%; padding: var(--qb-space-2) var(--qb-space-3); border-radius: var(--qb-radius-sm);
    border: 1px solid var(--qb-border); background: var(--qb-input); color: var(--qb-fg);
    font-size: var(--qb-text-sm); font-family: var(--qb-font-mono); line-height: var(--qb-leading);
    resize: vertical; min-height: 6rem;
  }
  textarea:focus { outline: none; border-color: var(--qb-accent); box-shadow: 0 0 0 2px var(--qb-ring); }

  button {
    background: var(--qb-accent); color: var(--qb-on-accent); border: 0;
    border-radius: var(--qb-radius-sm); padding: var(--qb-space-2) var(--qb-space-3);
    font-size: var(--qb-text-sm); cursor: pointer; font-family: inherit;
    min-height: var(--qb-control-height);
  }
  button:hover:not(:disabled) { background: var(--qb-primary-hover); }
  button.ghost {
    background: transparent; color: var(--qb-fg-muted); border: 1px solid var(--qb-border);
  }
  button.ghost:hover:not(:disabled) { background: var(--qb-surface-muted); color: var(--qb-fg); }
  button.small { padding: var(--qb-space-1) var(--qb-space-2); font-size: var(--qb-text-xs); min-height: 0; }
  button:disabled { opacity: .5; cursor: default; }

  .actions {
    display: flex; gap: var(--qb-space-2); flex-wrap: wrap;
    align-items: center; margin-top: var(--qb-space-3);
  }
  .muted { color: var(--qb-fg-muted); }
  .empty { color: var(--qb-fg-muted); padding: var(--qb-space-3) 0; line-height: var(--qb-leading); }
  .mono { font-family: var(--qb-font-mono); }
  .loading { color: var(--qb-fg-muted); }
  .small { font-size: var(--qb-text-xs); }

  /* 面板外独立打开时没有 bridge.toast，用页面内提示兜底 */
  .toast-wrap {
    position: fixed; right: var(--qb-space-4); bottom: var(--qb-space-4);
    display: flex; flex-direction: column; gap: var(--qb-space-2); z-index: 40;
  }
  .toast {
    background: var(--qb-surface); border: 1px solid var(--qb-border);
    border-left: 3px solid var(--qb-accent);
    border-radius: var(--qb-radius-sm); padding: var(--qb-space-2) var(--qb-space-3);
    font-size: var(--qb-text-sm); box-shadow: var(--qb-shadow-overlay);
    max-width: 22rem; line-height: var(--qb-leading);
  }
  .toast.error { border-left-color: var(--qb-danger); }
  .toast.success { border-left-color: var(--qb-success); }
</style>
</head>
<body>
<h1>Agent</h1>
<div class="sub">
  带工具调用的多轮对话。下面的模型、人格、会话都<strong>点一下就切换</strong>；
  更细的开关（唤醒方式、步数上限、人格列表本身）在面板「插件 → Agent → 插件配置」。
  <span class="muted" id="inFrameHint"></span>
</div>

<div class="card">
  <h2>模型</h2>
  <div class="picker" id="modelPicker">
    <button class="trigger" id="modelTrigger" type="button" disabled>
      <span class="trigger-main"><span id="modelCurrent">加载中…</span></span>
      <span class="trigger-chevron">▾</span>
    </button>
    <div class="menu" id="modelMenu" hidden>
      <input class="search" id="modelSearch" placeholder="搜索别名…" />
      <div class="options" id="modelOptions"></div>
    </div>
  </div>
  <div class="actions">
    <button class="ghost small" id="testBtn">测试连通性</button>
    <span class="muted small" id="pingResult"></span>
  </div>
</div>

<div class="card">
  <h2>系统提示词</h2>
  <p class="hint">没有绑人格时用它。改完点保存立即生效，不必去配置页。</p>
  <textarea id="promptBox" placeholder="留空则用内置默认人格…"></textarea>
  <div class="actions">
    <button class="small" id="savePrompt">保存</button>
    <button class="ghost small" id="resetPrompt">恢复配置里的值</button>
    <span class="muted small" id="promptState"></span>
  </div>
</div>

<div class="card">
  <h2>会话</h2>
  <p class="hint">每个会话一段独立记忆。这里列出最近活跃的会话，可以直接切人格。</p>
  <input class="search" id="convSearch" placeholder="按会话 id 过滤…" style="margin-bottom:10px" />
  <table>
    <thead><tr><th>会话</th><th>人格</th><th>更新时间</th><th></th></tr></thead>
    <tbody id="convRows"><tr><td colspan="4" class="loading">加载中…</td></tr></tbody>
  </table>
  <div class="muted small" style="margin-top:10px" id="personaSummary"></div>
</div>

<div class="card">
  <h2>运行状态</h2>
  <div class="row"><span class="k">工具调用</span><span id="tools">-</span></div>
  <div class="row"><span class="k">虚拟工作区</span><span id="vfs">-</span></div>
  <div class="row"><span class="k">动态定时任务</span><span id="schedule">-</span></div>
  <div class="row"><span class="k">工具审计</span><span id="audit">-</span></div>
  <div class="row"><span class="k">步数 / 工具上限</span><span id="limits">-</span></div>
  <div class="row"><span class="k">历史条数</span><span id="history">-</span></div>
  <div class="row"><span class="k">时区</span><span id="tz">-</span></div>
</div>

<div class="card">
  <h2>定时任务 <span class="muted" id="scheduleCount"></span></h2>
  <table>
    <thead><tr><th>触发时间</th><th>会话</th><th>内容</th><th>重复</th></tr></thead>
    <tbody id="scheduleRows"><tr><td colspan="4" class="loading">加载中…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <h2>工具调用 <span class="muted" id="auditHint"></span></h2>
  <table>
    <thead><tr><th>时间</th><th>工具</th><th>状态</th><th class="num">耗时</th></tr></thead>
    <tbody id="auditRows"><tr><td colspan="4" class="loading">加载中…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <h2>最近 14 天</h2>
  <table>
    <thead><tr><th>日期</th><th class="num">对话</th><th class="num">失败</th><th class="num">工具调用</th></tr></thead>
    <tbody id="stats"><tr><td colspan="4" class="loading">加载中…</td></tr></tbody>
  </table>
</div>

<script type="module">
/**
 * 页面脚本。
 *
 * 交互照 AstrBot 面板的做法（见其 dashboard 的 ProviderModelMenu / ConfigSelector）：
 * - 模型：**下拉触发器 + 带勾选的列表 + 搜索 + 点一项立即生效**，不做「填输入框再点保存」；
 * - 人格：每行一个下拉，选完即生效；
 * - 反馈：能用 bridge.toast 就用它（和面板其它页面一致），独立打开时退化成页面内提示；
 * - 加载态与空态都要有明确文案，不能出现「一片空白」。
 */
const $ = (id) => document.getElementById(id)
const yes = (v) => v ? '<span class="ok">开</span>' : '<span class="bad">关</span>'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ---------------------------------------------------------------- 桥与请求 */

let bridge = null
try {
  const mod = await import('/bridge.js')
  bridge = await mod.createBridge()
  bridge.setTitle?.('Agent')
} catch {
  // 不在面板里打开（新窗口 / 直接访问）时没有桥，退化成直接 fetch
}
$('inFrameHint').textContent = bridge?.embedded ? '' : '（当前不在面板内嵌模式下打开）'

/** 统一的提示：有桥走 toast（与面板一致），否则页面内浮层 */
function notify(message, level = 'info') {
  if (bridge?.toast) {
    bridge.toast(message, level)
    return
  }
  const wrap = document.querySelector('.toast-wrap') ?? (() => {
    const el = document.createElement('div')
    el.className = 'toast-wrap'
    document.body.appendChild(el)
    return el
  })()
  const item = document.createElement('div')
  item.className = 'toast ' + level
  item.textContent = message
  wrap.appendChild(item)
  setTimeout(() => item.remove(), 3600)
}

async function request(path, init) {
  const res = bridge ? await bridge.fetch(path, init) : await fetch('/p/agent' + path, init)
  if (!res.ok) {
    // 尽量把服务端给的原因读出来，比「HTTP 400」有用得多
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.error ?? ''
    } catch {}
    throw new Error(detail || ('HTTP ' + res.status))
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

/* ---------------------------------------------------------------- 模型下拉 */

/** 最近一次 overview 数据；下拉与其它区块共用 */
let state = { config: {}, modelStatus: {}, bindings: [], personas: {} }

/**
 * 模型下拉：照 AstrBot 的 ProviderModelMenu —— 触发器显示当前值，展开是列表。
 * 点一项就发请求切过去，成功才把选中态更新过去（失败保留原值并提示）。
 */
function renderModelPicker() {
  const aliases = state.modelStatus.models ?? []
  const current = state.config.model ?? ''
  const configured = state.config.configuredModel ?? current

  $('modelTrigger').disabled = aliases.length === 0
  $('modelCurrent').innerHTML = current
    ? esc(current)
    : '<span class="bad">未配置模型</span>'
  const meta = $('modelTrigger').querySelector('.trigger-meta')
  if (meta) meta.remove()
  if (state.config.modelOverridden && configured !== current) {
    const span = document.createElement('span')
    span.className = 'trigger-meta'
    span.textContent = '配置里是 ' + configured
    $('modelTrigger').querySelector('.trigger-main').appendChild(span)
  }

  const options = aliases.length
    ? aliases.map((alias) => {
        const on = alias === current
        return '<button type="button" class="opt ' + (on ? 'on' : '') + '" data-alias="' + esc(alias) + '">' +
          '<span>' + esc(alias) + '</span>' +
          (on ? '<span class="check">✓</span>' : '') +
          '</button>'
      }).join('')
    : '<div class="menu-empty">LLM 接口插件里还没有配置模型别名</div>'

  $('modelOptions').innerHTML = options
  for (const btn of $('modelOptions').querySelectorAll('button.opt')) {
    btn.addEventListener('click', () => pickModel(btn.dataset.alias))
  }
}

async function pickModel(alias) {
  if (!alias || alias === state.config.model) {
    $('modelMenu').hidden = true
    return
  }
  try {
    await postJson('/api/settings', { model: alias })
    $('modelMenu').hidden = true
    notify('已切换到 ' + alias, 'success')
    await load()
  } catch (e) {
    notify('切换失败：' + e.message, 'error')
  }
}

function toggleModelMenu(open) {
  const menu = $('modelMenu')
  const next = open ?? menu.hidden
  menu.hidden = !next
  if (next) {
    $('modelSearch').value = ''
    filterModelOptions('')
    $('modelSearch').focus()
  }
}

function filterModelOptions(keyword) {
  const needle = keyword.trim().toLowerCase()
  for (const opt of $('modelOptions').querySelectorAll('button.opt')) {
    opt.hidden = Boolean(needle) && !opt.textContent.toLowerCase().includes(needle)
  }
}

/* ---------------------------------------------------------------- 提示词 */

function renderPrompt() {
  const box = $('promptBox')
  if (document.activeElement === box) return // 正在编辑时不要被刷新覆盖
  box.value = state.config.systemPrompt ?? ''
  $('promptState').textContent = state.config.promptOverridden
    ? '（已覆盖配置里的值）'
    : '（来自插件配置）'
}

async function savePrompt() {
  try {
    await postJson('/api/settings', { systemPrompt: $('promptBox').value })
    notify('提示词已保存，立即生效', 'success')
    await load()
  } catch (e) {
    notify('保存失败：' + e.message, 'error')
  }
}

async function resetPrompt() {
  try {
    await postJson('/api/settings', { systemPrompt: '' })
    notify('已恢复成插件配置里的提示词', 'success')
    await load()
  } catch (e) {
    notify('恢复失败：' + e.message, 'error')
  }
}

/* ---------------------------------------------------------------- 会话 */

/**
 * 会话列表每行一个下拉，选完即生效（AstrBot 的人格绑定也是「选了就写」）。
 * 人格列表来自插件配置，这里只负责绑定关系。
 */
function renderConversations() {
  const configured = state.personas.configured ?? []
  const rows = state.bindings ?? []
  const keyword = $('convSearch').value.trim().toLowerCase()

  $('personaSummary').textContent = configured.length
    ? '已配置人格：' + configured.join('、')
    : '还没有配置任何人格（在插件配置里添加，或在会话里发「/agent persona 名字」）'

  const visible = rows.filter((row) => !keyword || row.conversation.toLowerCase().includes(keyword))
  if (!visible.length) {
    const message = rows.length
      ? '没有匹配「' + esc(keyword) + '」的会话'
      : '还没有会话绑定人格。在群里发一句「/agent persona 名字」就会出现在这里'
    $('convRows').innerHTML = '<tr><td colspan="4" class="empty">' + message + '</td></tr>'
    return
  }

  $('convRows').innerHTML = visible.map((row) => {
    const options = configured
      .map((name) => '<option value="' + esc(name) + '"' + (name === row.persona ? ' selected' : '') + '>' + esc(name) + '</option>')
      .join('')
    return '<tr>' +
      '<td class="mono">' + esc(shortConversation(row.conversation)) + '</td>' +
      '<td><select class="select-inline" data-conv="' + esc(row.conversation) + '">' +
        '<option value="">（清除）</option>' + options +
      '</select></td>' +
      '<td class="muted small">' + esc(row.updatedAtLocal) + '</td>' +
      '<td class="ops"><button class="ghost small" data-clear="' + esc(row.conversation) + '">清除</button></td>' +
      '</tr>'
  }).join('')

  for (const select of $('convRows').querySelectorAll('select.select-inline')) {
    select.addEventListener('change', () => bindPersona(select.dataset.conv, select.value))
  }
  for (const btn of $('convRows').querySelectorAll('button[data-clear]')) {
    btn.addEventListener('click', () => bindPersona(btn.dataset.clear, ''))
  }
}

async function bindPersona(conversation, persona) {
  try {
    await postJson('/api/persona', { conversation, persona })
    notify(persona
      ? shortConversation(conversation) + ' → ' + persona
      : shortConversation(conversation) + '：已清除', 'success')
    await load()
  } catch (e) {
    notify('绑定失败：' + e.message, 'error')
  }
}

function shortConversation(id) {
  if (!id) return '-'
  const [kind, ...rest] = String(id).split(':')
  const tail = rest.join(':')
  const label = { group: '群', c2c: '单聊', guild: '频道', guild_dm: '频道私信' }[kind] ?? kind
  return label + ' ' + (tail.length > 8 ? tail.slice(0, 8) + '…' : tail)
}

function formatRepeat(seconds) {
  if (!seconds) return '一次性'
  if (seconds % 86400 === 0) return '每 ' + seconds / 86400 + ' 天'
  if (seconds % 3600 === 0) return '每 ' + seconds / 3600 + ' 小时'
  if (seconds % 60 === 0) return '每 ' + seconds / 60 + ' 分钟'
  return '每 ' + seconds + ' 秒'
}

function renderSchedules(rows) {
  $('scheduleCount').textContent = rows.length ? '（' + rows.length + ' 个）' : ''
  if (!rows.length) {
    $('scheduleRows').innerHTML = '<tr><td colspan="4" class="empty">没有待触发的定时任务</td></tr>'
    return
  }
  $('scheduleRows').innerHTML = rows.map((s) =>
    '<tr>' +
      '<td class="mono">' + esc(s.dueAtLocal) + '</td>' +
      '<td class="muted">' + esc(shortConversation(s.conversation)) + '</td>' +
      '<td>' + esc(s.prompt.length > 40 ? s.prompt.slice(0, 40) + '…' : s.prompt) + '</td>' +
      '<td class="muted">' + esc(formatRepeat(s.repeatSeconds)) + '</td>' +
    '</tr>').join('')
}

function renderAudits(rows, auditEnabled) {
  $('auditHint').textContent = auditEnabled ? '' : '（未开启审计，在插件设置里打开）'
  if (!rows.length) {
    $('auditRows').innerHTML = '<tr><td colspan="4" class="empty">' +
      (auditEnabled ? '还没有工具调用记录' : '审计未开启') + '</td></tr>'
    return
  }
  const statusClass = (s) => s === 'success' ? 'ok' : s === 'failed' ? 'bad' : 'warn'
  $('auditRows').innerHTML = rows.map((a) =>
    '<tr>' +
      '<td class="mono muted">' + esc(a.createdAtLocal) + '</td>' +
      '<td class="mono">' + esc(a.toolName) + '</td>' +
      '<td class="' + statusClass(a.status) + '">' + esc(a.status) + '</td>' +
      '<td class="num muted">' + (a.durationMs == null ? '-' : a.durationMs + ' ms') + '</td>' +
    '</tr>').join('')
}

function renderStats(rows) {
  if (!rows.length) {
    $('stats').innerHTML = '<tr><td colspan="4" class="empty">还没有统计数据</td></tr>'
    return
  }
  $('stats').innerHTML = rows.map((s) =>
    '<tr>' +
      '<td>' + esc(s.day) + '</td>' +
      '<td class="num">' + s.runs + '</td>' +
      '<td class="num">' + (s.failed ? '<span class="bad">' + s.failed + '</span>' : '0') + '</td>' +
      '<td class="num">' + s.tool_calls + '</td>' +
    '</tr>').join('')
}

async function load() {
  try {
    const data = await get('/api/overview')
    state = data
    const c = data.config ?? {}

    $('tools').innerHTML = yes(c.enableTools)
    $('vfs').innerHTML = yes(c.enableVfs)
    $('schedule').innerHTML = yes(c.enableSchedule)
    $('audit').innerHTML = yes(c.enableAudit)
    $('limits').textContent = (c.maxModelSteps ?? '-') + ' 步 / ' + (c.maxToolCalls ?? '-') + ' 次'
    $('history').textContent = (c.historyLimit ?? '-') + ' 条'
    $('tz').textContent = c.timezone ?? '-'

    if (!data.modelStatus?.ok) {
      $('modelCurrent').innerHTML = '<span class="bad">读取模型列表失败</span>'
      $('pingResult').innerHTML = '<span class="bad">' + esc(data.modelStatus?.error ?? '') + '</span>'
    }
    renderModelPicker()
    renderPrompt()
    renderConversations()
    renderSchedules(data.schedules ?? [])
    renderAudits(data.audits ?? [], c.enableAudit)
    renderStats(data.stats ?? [])
  } catch (e) {
    notify('页面数据加载失败：' + e.message, 'error')
    for (const tbody of ['convRows', 'scheduleRows', 'auditRows', 'stats']) {
      $(tbody).innerHTML = '<tr><td colspan="4" class="bad">加载失败：' + esc(e.message) + '</td></tr>'
    }
  } finally {
    bridge?.resize?.()
  }
}

/* ---------------------------------------------------------------- 事件绑定 */

$('modelTrigger').addEventListener('click', () => toggleModelMenu())
$('modelSearch').addEventListener('input', (e) => filterModelOptions(e.target.value))
document.addEventListener('click', (e) => {
  if (!$('modelPicker').contains(e.target)) $('modelMenu').hidden = true
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('modelMenu').hidden = true
})

$('savePrompt').addEventListener('click', savePrompt)
$('resetPrompt').addEventListener('click', resetPrompt)
$('convSearch').addEventListener('input', renderConversations)

$('testBtn').addEventListener('click', async () => {
  const btn = $('testBtn')
  btn.disabled = true
  $('pingResult').textContent = '测试中…'
  try {
    const r = await request('/api/test', { method: 'POST' })
    if (r.ok) {
      $('pingResult').innerHTML = '<span class="ok">正常（' + r.latencyMs + 'ms）</span>'
    } else {
      $('pingResult').innerHTML = '<span class="bad">失败：' + esc(r.error || '未知错误') + '</span>'
    }
  } catch (e) {
    $('pingResult').innerHTML = '<span class="bad">失败：' + esc(e.message) + '</span>'
  } finally {
    btn.disabled = false
  }
})

load()
bridge?.resize?.()
</script>
</body>
</html>`
