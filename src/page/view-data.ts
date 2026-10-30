/**
 * 渲染：运行数据与配置表单
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const VIEW_DATA = `
/* ---------------------------------------------------------------- 渲染：表格 */

function renderTable(tbody, rows, columns, emptyText) {
  tbody.innerHTML = ''
  if (!rows.length) {
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = columns.length
    td.className = 'qb-muted'
    td.style.textAlign = 'center'
    td.style.padding = 'var(--qb-space-5)'
    td.textContent = emptyText
    tr.appendChild(td)
    tbody.appendChild(tr)
    return
  }
  for (const row of rows) {
    const tr = document.createElement('tr')
    for (const column of columns) {
      const td = document.createElement('td')
      if (column.num) td.className = 'num'
      const value = column.render ? column.render(row) : row[column.key]
      if (value instanceof Node) td.appendChild(value)
      else td.textContent = value ?? ''
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
}

function renderData() {
  const personas = (state.config.personas ?? []).map((p) => p.name).filter(Boolean)

  const convKeyword = ($('convSearch').value ?? '').trim().toLowerCase()
  const bindings = (state.bindings ?? []).filter(
    (row) => !convKeyword || row.conversation.toLowerCase().includes(convKeyword),
  )
  renderTable(
    $('convRows'),
    bindings,
    [
      { key: 'conversation' },
      {
        key: 'persona',
        render: (row) => {
          const select = document.createElement('select')
          select.className = 'qb-input'
          const none = document.createElement('option')
          none.value = ''
          none.textContent = '（不绑定）'
          select.appendChild(none)
          for (const name of personas) {
            const option = document.createElement('option')
            option.value = name
            option.textContent = name
            if (name === row.persona) option.selected = true
            select.appendChild(option)
          }
          select.addEventListener('change', () => {
            void bindPersona(row.conversation, select.value)
          })
          return select
        },
      },
      { key: 'updatedAtLocal' },
      {
        key: 'ops',
        render: (row) => {
          const btn = document.createElement('button')
          btn.className = 'qb-btn'
          btn.type = 'button'
          btn.textContent = '清除绑定'
          btn.addEventListener('click', () => void bindPersona(row.conversation, ''))
          return btn
        },
      },
    ],
    '还没有会话绑定人格。在群里发「/agent persona 名字」就会出现在这里',
  )

  $('scheduleCount').textContent = (state.schedules ?? []).length
    ? '（' + state.schedules.length + '）'
    : ''
  renderTable(
    $('scheduleRows'),
    state.schedules ?? [],
    [{ key: 'dueAtLocal' }, { key: 'conversation' }, { key: 'prompt' }, { key: 'repeatText' }],
    '没有待触发的定时任务',
  )

  $('auditHint').textContent = state.config.enable_audit
    ? '最近 30 条'
    : '需要打开「记录工具调用」才会收集'
  renderTable(
    $('auditRows'),
    state.audits ?? [],
    [
      { key: 'createdAtLocal' },
      { key: 'toolName' },
      {
        key: 'status',
        render: (row) => {
          const badge = document.createElement('span')
          badge.className = 'badge ' + (row.status === 'success' ? 'badge--success' : 'badge--danger')
          badge.textContent = row.status
          return badge
        },
      },
      { key: 'durationMs', num: true, render: (row) => row.durationMs + ' ms' },
    ],
    state.config.enable_audit ? '还没有工具调用记录' : '审计未开启',
  )

  renderTable(
    $('stats'),
    state.stats ?? [],
    [
      { key: 'day' },
      { key: 'runs', num: true },
      { key: 'failed', num: true },
      { key: 'tool_calls', num: true },
    ],
    '还没有统计数据',
  )

  const keys = state.config.overriddenKeys ?? []
  $('overrideState').textContent = keys.length
    ? '已改 ' + keys.length + ' 项：' + keys.join('、')
    : '本页还没有改过任何项'
  notifyResize()
}

async function bindPersona(conversation, persona) {
  try {
    await postJson('/api/persona', { conversation, persona })
    notify(persona ? '已绑定 ' + persona : '已清除绑定', 'success')
    await load()
  } catch (e) {
    notify('保存失败：' + e.message, 'error')
  }
}

/* ---------------------------------------------------------------- 渲染：配置 */

function renderConfig() {
  const c = state.config

  $('promptBox').value = c.system_prompt ?? ''
  $('promptState').textContent = isOverridden('system_prompt')
    ? '已改（配置里是另一份）'
    : '来自插件配置'

  $('wakePrefix').value = c.wake_prefix ?? '/'
  setSwitch($('friendPrefix'), c.friend_needs_wake_prefix)

  for (const sw of document.querySelectorAll('[data-flag]')) {
    setSwitch(sw, c[sw.dataset.flag])
  }

  $('maxSteps').value = c.max_model_steps ?? ''
  $('maxToolCalls').value = c.max_tool_calls ?? ''
  $('historyLimit').value = c.history_limit ?? ''
  $('timeoutMs').value = c.request_timeout_ms ?? ''
  $('timezone').value = c.timezone ?? ''
  $('contextCompression').value = c.context_compression ?? 'truncate'
  $('maxContextTokens').value = c.max_context_tokens ?? ''
  $('rateLimit').value = c.rate_limit_per_minute ?? ''

  createListInput(
    $('filterKeywords'),
    splitKeywords(c.content_filter_keywords),
    (values) => void savePatch({ content_filter_keywords: values.join(',') }),
    '关键词回车',
  )
}

function splitKeywords(raw) {
  if (!raw) return []
  return String(raw)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}
`
