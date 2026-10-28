/**
 * 插件管理页。单文件 HTML，脚本样式全内联。
 *
 * 用 `/bridge.js` 拿桥接令牌并跟随面板主题；`bridge.fetch` 自动带令牌，
 * 相对路径以 `/p/agent` 解析（见 docs/ui.md）。
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
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--border); }
  th { color: var(--fg-muted); font-weight: 500; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #result { margin-top: 10px; font-size: 13px; }
  .muted { color: var(--fg-muted); }
</style>
</head>
<body>
<h1>Agent</h1>
<div class="sub">带工具调用的多轮对话。模型配置在「LLM 接口」插件里。</div>

<div class="card">
  <h2>模型</h2>
  <div class="row"><span class="k">模型别名</span><span id="model">-</span></div>
  <div class="row"><span class="k">可用别名</span><span id="models">-</span></div>
  <div class="row"><span class="k">连通性</span><span id="ping" class="muted">未测试</span></div>
  <div style="margin-top:12px"><button id="test">测试连通性</button></div>
  <div id="result"></div>
</div>

<div class="card">
  <h2>能力</h2>
  <div class="row"><span class="k">工具调用</span><span id="tools">-</span></div>
  <div class="row"><span class="k">虚拟工作区</span><span id="vfs">-</span></div>
  <div class="row"><span class="k">动态定时任务</span><span id="schedule">-</span></div>
  <div class="row"><span class="k">工具审计</span><span id="audit">-</span></div>
  <div class="row"><span class="k">步数上限</span><span id="steps">-</span></div>
  <div class="row"><span class="k">历史条数</span><span id="history">-</span></div>
</div>

<div class="card">
  <h2>最近 14 天</h2>
  <table>
    <thead><tr><th>日期</th><th>对话</th><th>失败</th><th>工具调用</th></tr></thead>
    <tbody id="stats"><tr><td colspan="4" class="muted">暂无数据</td></tr></tbody>
  </table>
</div>

<script type="module">
const $ = (id) => document.getElementById(id)
const yes = (v) => v ? '<span class="ok">开</span>' : '<span class="bad">关</span>'

let bridge = null
try {
  const mod = await import('/bridge.js')
  bridge = await mod.createBridge()
  bridge.setTitle?.('Agent')
} catch (e) {
  // 不在面板里打开时没有桥，退化成直接 fetch
}

async function get(path) {
  if (bridge) return (await bridge.fetch(path)).json()
  const res = await fetch('/p/agent' + path)
  return res.json()
}

async function post(path) {
  if (bridge) return (await bridge.fetch(path, { method: 'POST' })).json()
  const res = await fetch('/p/agent' + path, { method: 'POST' })
  return res.json()
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
    $('steps').textContent = c.maxModelSteps
    $('history').textContent = c.historyLimit + ' 条'

    if (data.modelStatus.ok) {
      $('models').textContent = data.modelStatus.models.join('、') || '（无）'
    } else {
      $('models').innerHTML = '<span class="bad">读取失败：' + data.modelStatus.error + '</span>'
    }

    if (data.stats.length) {
      $('stats').innerHTML = data.stats.map((s) =>
        '<tr><td>' + s.day + '</td><td>' + s.runs + '</td><td>' + s.failed +
        '</td><td>' + s.tool_calls + '</td></tr>').join('')
    }
  } catch (e) {
    $('result').innerHTML = '<span class="bad">加载失败：' + e.message + '</span>'
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
      $('result').innerHTML = '<span class="bad">' + (r.error || '未知错误') + '</span>'
    }
  } catch (e) {
    $('ping').innerHTML = '<span class="bad">失败</span>'
    $('result').innerHTML = '<span class="bad">' + e.message + '</span>'
  } finally {
    btn.disabled = false
  }
})

load()
bridge?.resize?.()
</script>
</body>
</html>`
