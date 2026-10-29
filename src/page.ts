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
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--fg-muted); font-size: 13px; margin-bottom: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; color: var(--fg); font-weight: 600; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: 0; }
  .row .k { color: var(--fg-muted); }
  .ok { color: #16a34a; }
  .bad { color: #dc2626; }
  .warn { color: #d97706; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--border); }
  th { color: var(--fg-muted); font-weight: 500; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #result { margin-top: 10px; font-size: 13px; }
  .muted { color: var(--fg-muted); }
  .empty { color: var(--fg-muted); font-size: 13px; padding: 8px 0; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
</style>
</head>
<body>
<h1>Agent</h1>
<div class="sub">带工具调用的多轮对话。模型配置在「LLM 接口」插件里。</div>

<div class="card">
  <h2>模型</h2>
  <p class="muted" style="margin:0 0 12px">模型别名、系统提示词、人格、唤醒方式等<strong>配置</strong>都在面板「插件 → Agent → 插件配置」里改（保存即生效，不触发构建）。这里只做状态检查。</p>
  <div class="row"><span class="k">模型别名</span><span id="model">-</span></div>
  <div class="row"><span class="k">可用别名</span><span id="models">-</span></div>
  <div class="row"><span class="k">连通性</span><span id="ping" class="muted">未测试</span></div>
  <div style="margin-top:12px"><button id="test">测试连通性</button></div>
  <div id="result"></div>
</div>

<div class="card">
  <h2>运行状态</h2>
  <div class="row"><span class="k">工具调用</span><span id="tools">-</span></div>
  <div class="row"><span class="k">虚拟工作区</span><span id="vfs">-</span></div>
  <div class="row"><span class="k">动态定时任务</span><span id="schedule">-</span></div>
  <div class="row"><span class="k">工具审计</span><span id="audit">-</span></div>
  <div class="row"><span class="k">步数上限 / 工具上限</span><span id="limits">-</span></div>
  <div class="row"><span class="k">历史条数</span><span id="history">-</span></div>
  <div class="row"><span class="k">时区</span><span id="tz">-</span></div>
</div>

<div class="card">
  <h2>会话与人格</h2>
  <p class="muted" style="margin:0 0 12px">每个会话可以绑一套人格（会话里让机器人「/agent persona 名字」也能切）。这里是宿主面板没有的：面板只管插件配置，管不到「哪个会话用了哪套」。</p>
  <div class="row"><span class="k">已配置人格</span><span id="personaList">-</span></div>
  <div class="row"><span class="k">默认人格</span><span id="personaDefault">-</span></div>
  <table style="margin-top:12px">
    <thead><tr><th>会话</th><th>人格</th><th>更新时间</th><th></th></tr></thead>
    <tbody id="bindingRows"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
  </table>
  <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
    <input id="convInput" placeholder="会话 id，如 group:XXXXXX" style="flex:1;min-width:180px;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--fg);font-size:13px">
    <select id="personaSelect" style="padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--fg);font-size:13px">
      <option value="">（清除绑定）</option>
    </select>
    <button id="bindBtn">绑定</button>
  </div>
  <div id="bindResult" style="margin-top:10px;font-size:13px"></div>
</div>

<div class="card">
  <h2>定时任务 <span class="muted" id="scheduleCount"></span></h2>
  <table>
    <thead><tr><th>触发时间</th><th>会话</th><th>内容</th><th>重复</th></tr></thead>
    <tbody id="scheduleRows"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <h2>工具调用 <span class="muted" id="auditHint"></span></h2>
  <table>
    <thead><tr><th>时间</th><th>工具</th><th>状态</th><th class="num">耗时</th></tr></thead>
    <tbody id="auditRows"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
  </table>
</div>

<div class="card">
  <h2>最近 14 天</h2>
  <table>
    <thead><tr><th>日期</th><th class="num">对话</th><th class="num">失败</th><th class="num">工具调用</th></tr></thead>
    <tbody id="stats"><tr><td colspan="4" class="empty">加载中…</td></tr></tbody>
  </table>
</div>

<script type="module">
const $ = (id) => document.getElementById(id)
const yes = (v) => v ? '<span class="ok">开</span>' : '<span class="bad">关</span>'
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let bridge = null
try {
  const mod = await import('/bridge.js')
  bridge = await mod.createBridge()
  bridge.setTitle?.('Agent')
} catch (e) {
  // 不在面板里打开时没有桥，退化成直接 fetch
}

async function request(path, init) {
  if (bridge) {
    const res = await bridge.fetch(path, init)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  }
  const res = await fetch('/p/agent' + path, init)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

const get = (path) => request(path)
const post = (path) => request(path, { method: 'POST' })

/** 会话 id 形如 group:XXXX，太长，只留类型 + 尾部 */
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

/** 会话与人格：把这台机器人配了哪些人格、哪些会话绑了哪套列出来 */
function renderPersonas(data) {
  const configured = data.personas?.configured ?? []
  const fallback = data.personas?.default
  $('personaList').textContent = configured.length ? configured.join('、') : '（未配置，用系统提示词）'
  $('personaDefault').textContent = fallback || '（用系统提示词）'

  // 下拉选项：清空 + 每套人格
  const select = $('personaSelect')
  select.innerHTML = '<option value="">（清除绑定）</option>' +
    configured.map((name) => '<option value="' + esc(name) + '">' + esc(name) + '</option>').join('')
  select.disabled = configured.length === 0

  const rows = data.bindings ?? []
  if (!rows.length) {
    $('bindingRows').innerHTML = '<tr><td colspan="4" class="empty">还没有会话绑定人格——在会话里发「/agent persona 名字」即可</td></tr>'
    return
  }
  $('bindingRows').innerHTML = rows.map((row) =>
    '<tr>' +
      '<td class="mono">' + esc(shortConversation(row.conversation)) + '</td>' +
      '<td>' + esc(row.persona) + '</td>' +
      '<td class="muted">' + esc(row.updatedAtLocal) + '</td>' +
      '<td><button data-conv="' + esc(row.conversation) + '" class="clear">清除</button></td>' +
    '</tr>'
  ).join('')

  // 逐行「清除」按钮
  for (const btn of $('bindingRows').querySelectorAll('button.clear')) {
    btn.addEventListener('click', async () => {
      await bind(btn.dataset.conv, '')
    })
  }
}

/** 绑定 / 清除某个会话的人格 */
async function bind(conversation, persona) {
  try {
    const res = await request('/api/persona', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation, persona }),
    })
    if (!res.ok) throw new Error(res.error || '保存失败')
    $('bindResult').innerHTML = '<span class="ok">' +
      esc(conversation) + (persona ? ' → ' + esc(persona) : '：绑定已清除') + '</span>'
    await $('bindBtn').addEventListener('click', () => {
  const conversation = $('convInput').value.trim()
  if (!conversation) {
    $('bindResult').innerHTML = '<span class="bad">请先填会话 id</span>'
    return
  }
  bind(conversation, $('personaSelect').value)
})

load()
  } catch (e) {
    $('bindResult').innerHTML = '<span class="bad">' + esc(e.message) + '</span>'
  }
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
    const c = data.config

    $('model').textContent = c.model
    $('tools').innerHTML = yes(c.enableTools)
    $('vfs').innerHTML = yes(c.enableVfs)
    $('schedule').innerHTML = yes(c.enableSchedule)
    $('audit').innerHTML = yes(c.enableAudit)
    $('limits').textContent = c.maxModelSteps + ' 步 / ' + c.maxToolCalls + ' 次'
    $('history').textContent = c.historyLimit + ' 条'
    $('tz').textContent = c.timezone

    if (data.modelStatus.ok) {
      $('models').textContent = data.modelStatus.models.join('、') || '（无）'
    } else {
      $('models').innerHTML = '<span class="bad">读取失败：' + esc(data.modelStatus.error) + '</span>'
    }

    renderPersonas(data)
    renderSchedules(data.schedules ?? [])
    renderAudits(data.audits ?? [], c.enableAudit)
    renderStats(data.stats ?? [])
  } catch (e) {
    $('result').innerHTML = '<span class="bad">加载失败：' + esc(e.message) + '</span>'
  }
}

$('test').addEventListener('click', async () => {
  const btn = $('test')
  btn.disabled = true
  $('ping').textContent = '测试中…'
  $('result').textContent = ''
  try {
    const r = await post('/api/test')
    if (r.ok) {
      $('ping').innerHTML = '<span class="ok">正常（' + r.latencyMs + 'ms）</span>'
    } else {
      $('ping').innerHTML = '<span class="bad">失败</span>'
      $('result').innerHTML = '<span class="bad">' + esc(r.error || '未知错误') + '</span>'
    }
  } catch (e) {
    $('ping').innerHTML = '<span class="bad">失败</span>'
    $('result').innerHTML = '<span class="bad">' + esc(e.message) + '</span>'
  } finally {
    btn.disabled = false
  }
})

load()
bridge?.resize?.()
</script>
</body>
</html>`
