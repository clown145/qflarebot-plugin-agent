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

  /* 表单布局 */
  .field { margin-top: var(--qb-space-3); }
  .field-label {
    display: block; color: var(--qb-fg-muted);
    font-size: var(--qb-text-xs); margin-bottom: var(--qb-space-1);
  }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--qb-space-3); }
  input[type="number"] {
    width: 100%; padding: var(--qb-space-2) var(--qb-space-3);
    border-radius: var(--qb-radius-sm); border: 1px solid var(--qb-border);
    background: var(--qb-input); color: var(--qb-fg); font-size: var(--qb-text-sm);
  }
  input[type="checkbox"] { width: 1rem; height: 1rem; accent-color: var(--qb-accent); cursor: pointer; }

  /* 人格编辑器 */
  .persona-list { display: flex; flex-direction: column; gap: var(--qb-space-3); }
  .persona-item {
    border: 1px solid var(--qb-border); border-radius: var(--qb-radius-sm);
    padding: var(--qb-space-3); background: var(--qb-surface-muted);
  }
  .persona-head { display: flex; gap: var(--qb-space-2); align-items: center; margin-bottom: var(--qb-space-2); }
  .persona-head input {
    flex: 1; padding: var(--qb-space-1) var(--qb-space-2); font-size: var(--qb-text-sm);
    border-radius: var(--qb-radius-sm); border: 1px solid var(--qb-border);
    background: var(--qb-input); color: var(--qb-fg); font-weight: 500;
  }
  .persona-item textarea { min-height: 4.5rem; margin-top: var(--qb-space-1); font-size: var(--qb-text-xs); }
  .persona-item .lbl { color: var(--qb-fg-muted); font-size: var(--qb-text-xs); }
  .badge-changed {
    display: inline-block; padding: 0 var(--qb-space-1);
    border-radius: var(--qb-radius-sm); font-size: var(--qb-text-xs);
    color: var(--qb-warning); border: 1px solid var(--qb-warning);
  }
</style>
</head>
<body>
<h1>Agent</h1>
<div class="sub">
  带工具调用的多轮对话。<strong>能在这里改的都在这里改</strong>——所有开关、人格、模型、会话。
  <span class="muted" id="overrideHint"></span>
</div>

<div class="card">
  <h2>模型</h2>
  <p class="hint">点一下就切换。别名来自「LLM 接口」插件，不用手打。</p>
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
  <h2>人格 <span class="muted small" id="personaCount"></span></h2>
  <p class="hint">
    多套人格并存，每个会话绑一套。每轮会插入「开场对话」锚定风格。
    不配人格时用下面的系统提示词。
  </p>
  <div id="personaList" class="persona-list"><div class="loading">加载中…</div></div>
  <div class="actions">
    <button class="small" id="addPersona">新增人格</button>
    <button class="ghost small" id="savePersonaList">保存人格</button>
    <span class="muted small">默认人格：
      <select class="select-inline" id="defaultPersona"></select>
    </span>
  </div>
</div>

<div class="card">
  <h2>系统提示词</h2>
  <p class="hint">没有人格时用它。改完点保存立即生效。</p>
  <textarea id="promptBox" placeholder="留空则用内置默认人格…"></textarea>
  <div class="actions">
    <button class="small" id="savePrompt">保存</button>
    <button class="ghost small" id="resetPrompt">恢复配置里的值</button>
    <span class="muted small" id="promptState"></span>
  </div>
</div>

<div class="card">
  <h2>群聊唤醒</h2>
  <p class="hint">
    群里<strong>只有两种情况</strong>会让机器人开口：<strong>@ 它</strong>，或以「唤醒前缀」开头。
    其余消息一律不理——这是刻意的，否则群里正常聊天都会被插嘴。
  </p>
  <div class="field">
    <label class="field-label">唤醒前缀 <span class="muted">（非 @ 时可触发）</span></label>
    <input id="wakePrefix" class="search" placeholder="/" />
  </div>
  <div class="row">
    <span class="k">单聊需要前缀才触发</span>
    <input type="checkbox" id="friendPrefix" />
  </div>
  <div class="field">
    <label class="field-label">机器人自身的指令前缀 <span class="muted">（这些消息交给指令，不进模型）</span></label>
    <input id="commandPrefixes" class="search" placeholder="/" />
  </div>
</div>

<div class="card">
  <h2>能力开关</h2>
  <div class="row"><span class="k">工具调用</span><input type="checkbox" id="enableTools" /></div>
  <div class="row"><span class="k">虚拟工作区 <span class="muted small">（需绑定 R2）</span></span><input type="checkbox" id="enableVfs" /></div>
  <div class="row"><span class="k">动态定时任务</span><input type="checkbox" id="enableSchedule" /></div>
  <div class="row"><span class="k">记录工具调用（审计）</span><input type="checkbox" id="enableAudit" /></div>
  <div class="row"><span class="k">单聊显示「正在输入」</span><input type="checkbox" id="showTyping" /></div>
</div>

<div class="card">
  <h2>限额</h2>
  <p class="hint">额度是全机器人共享的，调小更省。</p>
  <div class="grid2">
    <div class="field">
      <label class="field-label">单次最多模型步数 <span class="muted">1–30</span></label>
      <input type="number" id="maxSteps" min="1" max="30" />
    </div>
    <div class="field">
      <label class="field-label">单次最多工具调用 <span class="muted">1–50</span></label>
      <input type="number" id="maxToolCalls" min="1" max="50" />
    </div>
    <div class="field">
      <label class="field-label">历史条数 <span class="muted">0–100</span></label>
      <input type="number" id="historyLimit" min="0" max="100" />
    </div>
    <div class="field">
      <label class="field-label">模型调用超时 <span class="muted">毫秒，1000–25000</span></label>
      <input type="number" id="timeoutMs" min="1000" max="25000" step="1000" />
    </div>
    <div class="field">
      <label class="field-label">时区</label>
      <input id="timezone" class="search" placeholder="Asia/Shanghai" />
    </div>
  </div>
  <p class="muted small">改动即时保存，不需要再点保存。</p>
</div>

<div class="card">
  <h2>会话</h2>
  <p class="hint">每个会话一段独立记忆。绑过人格的会话列在这里，可以直接改。</p>
  <input class="search" id="convSearch" placeholder="按会话 id 过滤…" style="margin-bottom:10px" />
  <table>
    <thead><tr><th>会话</th><th>人格</th><th>更新时间</th><th></th></tr></thead>
    <tbody id="convRows"><tr><td colspan="4" class="loading">加载中…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <h2>定时任务 <span class="muted small" id="scheduleCount"></span></h2>
  <table>
    <thead><tr><th>触发时间</th><th>会话</th><th>内容</th><th>重复</th></tr></thead>
    <tbody id="scheduleRows"><tr><td colspan="4" class="loading">加载中…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <h2>工具调用 <span class="muted small" id="auditHint"></span></h2>
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

<div class="card">
  <h2>恢复</h2>
  <p class="hint">本页改过的项存在插件自己的存储里，覆盖面板配置。这里可以一次清空。</p>
  <div class="actions">
    <button class="ghost small" id="resetAll">全部恢复成配置里的值</button>
    <span class="muted small" id="overrideState"></span>
  </div>
</div>

<script type="module">
/**
 * 页面脚本。
 *
 * 设计原则：**能在这里改的都在这里改**。所有配置项（模型、人格、提示词、唤醒方式、
 * 能力开关、限额）都可以在这个页面直接改，写入插件自己的覆盖层后立即生效，
 * 不需要回面板填表单。交互照 AstrBot 面板的做法：
 * - 选值用下拉/列表（不让人手打别名、不让人记 id）；
 * - 改完即时保存（或一个明确的保存按钮），成败都用 toast 说明；
 * - 每块都给出「已改 / 来自配置」的状态，可单项或整体恢复。
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
  // 不在面板里打开时没有桥，退化成直接 fetch
}

/** 统一提示：有桥走 toast（与面板一致），否则页面内浮层 */
function notify(message, level = 'info') {
  if (bridge?.toast) {
    bridge.toast(message, level)
    return
  }
  let wrap = document.querySelector('.toast-wrap')
  if (!wrap) {
    wrap = document.createElement('div')
    wrap.className = 'toast-wrap'
    document.body.appendChild(wrap)
  }
  const item = document.createElement('div')
  item.className = 'toast ' + level
  item.textContent = message
  wrap.appendChild(item)
  setTimeout(() => item.remove(), 3600)
}

async function request(path, init) {
  const res = bridge ? await bridge.fetch(path, init) : await fetch('/p/agent' + path, init)
  if (!res.ok) {
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

/** 生效配置与覆盖信息；load() 时刷新 */
let state = { config: {}, modelStatus: {}, personas: {}, bindings: [] }

/**
 * 写配置覆盖。null 表示清除该字段覆盖、回落到插件配置。
 * 成功后会重新拉一次 overview 并把控件渲染成新状态。
 */
async function savePatch(patch, successMessage) {
  try {
    await postJson('/api/settings', { patch })
    if (successMessage) notify(successMessage, 'success')
    await load()
  } catch (e) {
    notify('保存失败：' + e.message, 'error')
    await load() // 失败也要把界面刷回真实值，否则控件会和实际不一致
  }
}

/** 某个字段是否被页面覆盖过 */
const isOverridden = (key) => (state.config.overriddenKeys ?? []).includes(key)

/** 给字段名加「已改」标记 */
function changedBadge(key) {
  return isOverridden(key) ? ' <span class="badge-changed">已改</span>' : ''
}

/* ---------------------------------------------------------------- 模型 */

function renderModelPicker() {
  const aliases = state.modelStatus.models ?? []
  const current = state.config.model ?? ''
  const configured = state.config.configured?.model ?? current

  $('modelTrigger').disabled = aliases.length === 0
  $('modelCurrent').textContent = current || '未配置模型'
  const main = $('modelTrigger').querySelector('.trigger-main')
  for (const meta of main.querySelectorAll('.trigger-meta')) meta.remove()
  if (isOverridden('model') && configured !== current) {
    const span = document.createElement('span')
    span.className = 'trigger-meta'
    span.textContent = '配置里是 ' + configured
    main.appendChild(span)
  }

  $('modelOptions').innerHTML = aliases.length
    ? aliases.map((alias) => {
        const on = alias === current
        return '<button type="button" class="opt ' + (on ? 'on' : '') + '" data-alias="' + esc(alias) + '">' +
          '<span>' + esc(alias) + '</span>' +
          (on ? '<span class="check">✓</span>' : '') +
          '</button>'
      }).join('')
    : '<div class="menu-empty">LLM 接口插件里还没有配置模型别名</div>'

  for (const btn of $('modelOptions').querySelectorAll('button.opt')) {
    btn.addEventListener('click', () => savePatch({ model: btn.dataset.alias }, '已切换到 ' + btn.dataset.alias))
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

/* ---------------------------------------------------------------- 人格 */

/** 页面里正在编辑的人格列表（与 state 同步，编辑时先放内存） */
let draftPersonas = []
/** 「新增 / 删除」之后的草稿；保存时才写回，避免每敲一下就打接口 */
let pendingPersona = []

function renderPersonas() {
  const list = state.config.personas ?? []
  draftPersonas = list.map((p) => ({ ...p }))
  pendingPersona = list.map((p) => ({ ...p }))

  const box = $('personaList')
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有人格。点「新增人格」建一套；不配的话用下面的系统提示词。</div>'
  } else {
    box.innerHTML = draftPersonas.map((p, i) => {
      const name = esc(p.name ?? '')
      const prompt = esc(p.prompt ?? '')
      const begin = esc(p.begin_dialogs ?? '')
      return '<div class="persona-item" data-index="' + i + '">' +
        '<div class="persona-head">' +
          '<input class="p-name" value="' + name + '" placeholder="名字（会话按它绑定，如 cat）" />' +
          '<button class="ghost small p-del" data-index="' + i + '">删除</button>' +
        '</div>' +
        '<label class="lbl">人格提示词</label>' +
        '<textarea class="p-prompt" placeholder="这套人格的系统提示词">' + prompt + '</textarea>' +
        '<label class="lbl">开场对话 <span class="muted">（每行一句，user: / assistant: 开头）</span></label>' +
        '<textarea class="p-begin" placeholder="user: 你好&#10;assistant: 你好呀～">' + begin + '</textarea>' +
        '</div>'
    }).join('')

    for (const item of box.querySelectorAll('.persona-item')) {
      const i = Number(item.dataset.index)
      item.querySelector('.p-name').addEventListener('input', (e) => { draftPersonas[i].name = e.target.value })
      item.querySelector('.p-prompt').addEventListener('input', (e) => { draftPersonas[i].prompt = e.target.value })
      item.querySelector('.p-begin').addEventListener('input', (e) => { draftPersonas[i].begin_dialogs = e.target.value })
    }
    for (const btn of box.querySelectorAll('.p-del')) {
      btn.addEventListener('click', () => {
        draftPersonas.splice(Number(btn.dataset.index), 1)
        pendingPersona = draftPersonas.map((p) => ({ ...p }))
        renderPersonaEditorFromDraft()
      })
    }
  }

  // 默认人格下拉
  const select = $('defaultPersona')
  const currentDefault = state.config.default_persona ?? ''
  select.innerHTML = '<option value="">（用系统提示词）</option>' +
    list.map((p) => {
      const name = esc(p.name ?? '')
      const selected = p.name === currentDefault ? ' selected' : ''
      return '<option value="' + name + '"' + selected + '>' + name + '</option>'
    }).join('')
  select.disabled = list.length === 0

  $('personaCount').textContent = list.length ? '（' + list.length + ' 套）' : ''
}

/** 删除后重绘（不重新拉数据，避免丢掉其它未保存的编辑） */
function renderPersonaEditorFromDraft() {
  const box = $('personaList')
  if (!pendingPersona.length) {
    box.innerHTML = '<div class="empty">还没有人格。点「新增人格」建一套。</div>'
    return
  }
  box.innerHTML = pendingPersona.map((p, i) => {
    const name = esc(p.name ?? '')
    const prompt = esc(p.prompt ?? '')
    const begin = esc(p.begin_dialogs ?? '')
    return '<div class="persona-item" data-index="' + i + '">' +
      '<div class="persona-head">' +
        '<input class="p-name" value="' + name + '" placeholder="名字" />' +
        '<button class="ghost small p-del" data-index="' + i + '">删除</button>' +
      '</div>' +
      '<label class="lbl">人格提示词</label>' +
      '<textarea class="p-prompt">' + prompt + '</textarea>' +
      '<label class="lbl">开场对话</label>' +
      '<textarea class="p-begin">' + begin + '</textarea>' +
      '</div>'
  }).join('')
  for (const item of box.querySelectorAll('.persona-item')) {
    const i = Number(item.dataset.index)
    item.querySelector('.p-name').addEventListener('input', (e) => { pendingPersona[i].name = e.target.value })
    item.querySelector('.p-prompt').addEventListener('input', (e) => { pendingPersona[i].prompt = e.target.value })
    item.querySelector('.p-begin').addEventListener('input', (e) => { pendingPersona[i].begin_dialogs = e.target.value })
  }
  for (const btn of box.querySelectorAll('.p-del')) {
    btn.addEventListener('click', () => {
      pendingPersona.splice(Number(btn.dataset.index), 1)
      renderPersonaEditorFromDraft()
    })
  }
}

async function savePersonas() {
  // 空名字的项直接丢掉，避免存进去一堆无效条目
  const cleaned = pendingPersona.filter((p) => (p.name ?? '').trim())
  await savePatch({ personas: cleaned }, '人格已保存')
}

/* ---------------------------------------------------------------- 其余配置 */

function renderScalarFields() {
  const c = state.config
  const configured = c.configured ?? {}

  // 提示词
  const box = $('promptBox')
  if (document.activeElement !== box) box.value = c.system_prompt ?? ''
  $('promptState').textContent = isOverridden('system_prompt')
    ? '已改（配置里是另一份）'
    : '来自插件配置'

  // 唤醒
  $('wakePrefix').value = c.wake_prefix ?? '/'
  $('friendPrefix').checked = Boolean(c.friend_needs_wake_prefix)
  $('commandPrefixes').value = c.command_prefixes ?? '/'

  // 能力开关
  $('enableTools').checked = Boolean(c.enable_tools)
  $('enableVfs').checked = Boolean(c.enable_vfs)
  $('enableSchedule').checked = Boolean(c.enable_schedule)
  $('enableAudit').checked = Boolean(c.enable_audit)
  $('showTyping').checked = Boolean(c.show_typing)

  // 限额
  if (document.activeElement !== $('maxSteps')) $('maxSteps').value = c.max_model_steps ?? ''
  if (document.activeElement !== $('maxToolCalls')) $('maxToolCalls').value = c.max_tool_calls ?? ''
  if (document.activeElement !== $('historyLimit')) $('historyLimit').value = c.history_limit ?? ''
  if (document.activeElement !== $('timeoutMs')) $('timeoutMs').value = c.request_timeout_ms ?? ''
  if (document.activeElement !== $('timezone')) $('timezone').value = c.timezone ?? ''

  const keys = c.overriddenKeys ?? []
  $('overrideHint').textContent = keys.length ? '（本页已改 ' + keys.length + ' 项）' : ''
  $('overrideState').textContent = keys.length ? '已改：' + keys.join('、') : '本页没有改过任何项'
  $('resetAll').disabled = keys.length === 0
  void configured
}

/* ---------------------------------------------------------------- 会话 */

function renderConversations() {
  const configuredNames = (state.config.personas ?? []).map((p) => p.name).filter(Boolean)
  const rows = state.bindings ?? []
  const keyword = $('convSearch').value.trim().toLowerCase()

  const visible = rows.filter((row) => !keyword || row.conversation.toLowerCase().includes(keyword))
  if (!visible.length) {
    const message = rows.length
      ? '没有匹配「' + esc(keyword) + '」的会话'
      : '还没有会话绑定人格。在群里发「/agent persona 名字」就会出现在这里'
    $('convRows').innerHTML = '<tr><td colspan="4" class="empty">' + message + '</td></tr>'
    return
  }

  $('convRows').innerHTML = visible.map((row) => {
    const options = '<option value="">（清除）</option>' + configuredNames
      .map((name) => '<option value="' + esc(name) + '"' + (name === row.persona ? ' selected' : '') + '>' + esc(name) + '</option>')
      .join('')
    return '<tr>' +
      '<td class="mono">' + esc(shortConversation(row.conversation)) + '</td>' +
      '<td><select class="select-inline" data-conv="' + esc(row.conversation) + '">' + options + '</select></td>' +
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
    await load()
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
    renderModelPicker()
    renderPersonas()
    renderScalarFields()
    renderConversations()
    renderSchedules(data.schedules ?? [])
    renderAudits(data.audits ?? [], data.config?.enable_audit)
    renderStats(data.stats ?? [])
    if (!data.modelStatus?.ok) {
      $('pingResult').innerHTML = '<span class="bad">' + esc(data.modelStatus?.error ?? '') + '</span>'
    }
  } catch (e) {
    notify('页面数据加载失败：' + e.message, 'error')
    for (const tbody of ['convRows', 'scheduleRows', 'auditRows', 'stats']) {
      $(tbody).innerHTML = '<tr><td colspan="4" class="bad">加载失败：' + esc(e.message) + '</td></tr>'
    }
  } finally {
    bridge?.resize?.()
  }
}

/* ---------------------------------------------------------------- 保存动作 */

async function savePrompt() {
  const text = $('promptBox').value
  await savePatch({ system_prompt: text }, '提示词已保存')
}

async function resetPrompt() {
  await savePatch({ system_prompt: null }, '已恢复成配置里的提示词')
}

async function saveScalars() {
  const patch = {
    wake_prefix: $('wakePrefix').value,
    friend_needs_wake_prefix: $('friendPrefix').checked,
    command_prefixes: $('commandPrefixes').value,
    enable_tools: $('enableTools').checked,
    enable_vfs: $('enableVfs').checked,
    enable_schedule: $('enableSchedule').checked,
    enable_audit: $('enableAudit').checked,
    show_typing: $('showTyping').checked,
    max_model_steps: Number($('maxSteps').value),
    max_tool_calls: Number($('maxToolCalls').value),
    history_limit: Number($('historyLimit').value),
    request_timeout_ms: Number($('timeoutMs').value),
    timezone: $('timezone').value,
  }
  await savePatch(patch, '配置已保存')
}

async function resetAll() {
  try {
    await postJson('/api/settings', { reset: true })
    notify('已全部恢复成插件配置里的值', 'success')
    await load()
  } catch (e) {
    notify('恢复失败：' + e.message, 'error')
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
// 能力开关与唤醒方式：改了就存（省得再点一次按钮）
for (const id of ['friendPrefix', 'enableTools', 'enableVfs', 'enableSchedule', 'enableAudit', 'showTyping']) {
  $(id).addEventListener('change', () => {
    void saveScalarsSilently()
  })
}
// 文本/数字类：失焦时保存，避免每敲一个字就打一次接口
for (const id of ['wakePrefix', 'commandPrefixes', 'maxSteps', 'maxToolCalls', 'historyLimit', 'timeoutMs', 'timezone']) {
  $(id).addEventListener('change', () => { void saveScalarsSilently() })
}
$('defaultPersona').addEventListener('change', () => {
  const value = $('defaultPersona').value
  void savePatch({ default_persona: value }, '默认人格已更新')
})
$('addPersona').addEventListener('click', () => {
  pendingPersona = draftPersonas.map((p) => ({ ...p }))
  pendingPersona.push({ name: '', prompt: '', begin_dialogs: '' })
  renderPersonaEditorFromDraft()
})
$('savePersonaList')?.addEventListener('click', savePersonas)
$('convSearch').addEventListener('input', renderConversations)
$('resetAll').addEventListener('click', resetAll)

/** 静默保存（不弹成功提示，失败才提示） */
async function saveScalarsSilently() {
  try {
    await saveScalars()
  } catch {
    /* savePatch 内部已经提示过 */
  }
}

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
