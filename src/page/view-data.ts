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
          select.setAttribute('aria-label', row.conversation + ' 的人格')
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

function renderConfig(keepPrompt = false) {
  const c = state.config

  if (!keepPrompt) $('promptBox').value = c.system_prompt ?? ''
  // 「已改」由徽标统一表达，这里只说来源，不重复
  $('promptState').textContent = isOverridden('system_prompt')
    ? '本页的这份覆盖了插件配置里的值，点标题旁的 × 可恢复'
    : '来自插件配置'

  if (!localEdits.has('wake_prefix')) $('wakePrefix').value = c.wake_prefix ?? '/'
  if (!localEdits.has('friend_needs_wake_prefix')) setSwitch($('friendPrefix'), c.friend_needs_wake_prefix)

  for (const sw of document.querySelectorAll('[data-flag]')) {
    if (!localEdits.has(sw.dataset.flag)) setSwitch(sw, c[sw.dataset.flag])
  }

  if (!localEdits.has('max_model_steps')) $('maxSteps').value = c.max_model_steps ?? ''
  if (!localEdits.has('max_tool_calls')) $('maxToolCalls').value = c.max_tool_calls ?? ''
  if (!localEdits.has('history_limit')) $('historyLimit').value = c.history_limit ?? ''
  if (!localEdits.has('request_timeout_ms')) $('timeoutMs').value = c.request_timeout_ms ?? ''
  if (!localEdits.has('timezone')) $('timezone').value = c.timezone ?? ''
  if (!localEdits.has('context_compression')) $('contextCompression').value = c.context_compression ?? 'truncate'
  if (!localEdits.has('reply_mention')) $('replyMention').value = c.reply_mention ?? 'off'
  if (!localEdits.has('max_context_tokens')) $('maxContextTokens').value = c.max_context_tokens ?? ''
  if (!localEdits.has('rate_limit_per_minute')) $('rateLimit').value = c.rate_limit_per_minute ?? ''

  if (!localEdits.has('content_filter_keywords') && !($('filterKeywords').querySelector('input')?.value)) createListInput(
    $('filterKeywords'),
    splitKeywords(c.content_filter_keywords),
    (values) => void savePatch({ content_filter_keywords: values.join(',') }),
    '关键词回车',
  )

  // 最后统一打「已改」标记：它依赖上面所有控件的值都已渲染完
  renderOverrideBadges()
}

function splitKeywords(raw) {
  if (!raw) return []
  return String(raw)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 给「被页面改过」的配置项加「已改」标记 + 单项恢复。
 *
 * ## 为什么要做
 *
 * 之前只有底部一个「全部恢复成配置值」。用户改了某一项想单独退回去，
 * 只能全部重置再重改一遍——而面板配置是权威默认值，改坏了很难找回原样。
 * AstrBot 的做法是「改过的字段标圆点，和默认不一样的可以恢复默认」。
 *
 * ## 实现方式：幂等注入，不改 HTML 结构
 *
 * 标记不写死在 HTML 里，而是渲染时按 overriddenKeys 动态插到对应
 * setting-row 的标题旁。好处：
 * - 字段增减只改这张映射表，不用同时改模板
 * - 反复渲染不会重复插入（先清理再插）
 *
 * ## 为什么用「字段 → 控件 id」而不是反过来
 *
 * 一个配置项可能对应多个控件（比如 friend_needs_wake_prefix 是开关），
 * 反过来查需要遍历 DOM；用映射表直接定位更快也更明确。
 */
const FIELD_CONTROL = {
  model: 'modelSelect',
  system_prompt: 'promptBox',
  wake_prefix: 'wakePrefix',
  friend_needs_wake_prefix: 'friendPrefix',
  max_model_steps: 'maxSteps',
  max_tool_calls: 'maxToolCalls',
  history_limit: 'historyLimit',
  request_timeout_ms: 'timeoutMs',
  timezone: 'timezone',
  context_compression: 'contextCompression',
  reply_mention: 'replyMention',
  max_context_tokens: 'maxContextTokens',
  rate_limit_per_minute: 'rateLimit',
  enable_tools: null,
  enable_vfs: null,
  enable_schedule: null,
  enable_skills: null,
  enable_audit: null,
  show_typing: null,
  isolate_sessions: null,
  expose_sender_id: null,
  expose_datetime: null,
  content_filter_keywords: 'filterKeywords',
  personas: null,
  default_persona: 'defaultPersona',
}

/** 字段 → 人话名字。标在标记的 title 上，鼠标悬停能看到改的是哪一项 */
const FIELD_LABEL = {
  model: '模型',
  system_prompt: '系统提示词',
  wake_prefix: '唤醒前缀',
  friend_needs_wake_prefix: '单聊需要前缀',
  max_model_steps: '模型步数',
  max_tool_calls: '工具调用数',
  history_limit: '历史条数',
  request_timeout_ms: '模型超时',
  timezone: '时区',
  context_compression: '上下文压缩',
  reply_mention: '@ 说话人',
  max_context_tokens: '压缩阈值',
  rate_limit_per_minute: '每分钟上限',
  enable_tools: '工具调用',
  enable_vfs: '虚拟工作区',
  enable_schedule: '定时任务',
  enable_skills: '技能',
  enable_audit: '记录工具调用',
  show_typing: '正在输入',
  isolate_sessions: '会话隔离',
  expose_sender_id: '说话人 ID',
  expose_datetime: '当前时间',
  content_filter_keywords: '内容安全关键词',
  personas: '人格列表',
  default_persona: '默认人格',
}

/**
 * 把一个控件定位到它所在的 setting-row（或等价的容器）。
 *
 * 找不到就返回 null —— 标记是**增强**，不该因为 DOM 结构变化就报错。
 */
function rowOf(control) {
  if (!control) return null
  // 开关按钮的直接父级是 .setting-control，再往上是 .setting-row
  return control.closest('.setting-row') ?? control.closest('.field') ?? control.closest('.qb-card') ?? null
}

/** 清掉上一次渲染插入的标记（幂等的前提） */
function clearOverrideBadges() {
  for (const el of document.querySelectorAll('.override-badge')) el.remove()
}

/**
 * 给一个字段的控件加「已改」标记 + 恢复按钮。
 *
 * 标记挂在标题（.setting-label）后面而不是控件旁边：控件区通常已经
 * 很挤（输入框 + 单位），再塞按钮会换行。
 */
function markOverridden(field, control) {
  const row = rowOf(control)
  if (!row) return

  const host = control.matches('.card-title') ? control : row.querySelector('.setting-label, label, .card-title') ?? row
  const badge = document.createElement('span')
  badge.className = 'override-badge'
  badge.style.cssText = [
    'display: inline-flex',
    'align-items: center',
    'gap: 4px',
    'margin-left: 6px',
    'padding: 0 6px',
    'height: 18px',
    'border-radius: 999px',
    'border: 1px solid var(--qb-warning)',
    'color: var(--qb-warning)',
    'font-size: 11px',
    'font-weight: 500',
    'vertical-align: middle',
  ].join(';')
  badge.title = '「' + (FIELD_LABEL[field] ?? field) + '」被本页改过，点 × 恢复成插件配置里的值'

  const text = document.createElement('span')
  text.textContent = '已改'
  badge.appendChild(text)

  const undo = document.createElement('button')
  undo.type = 'button'
  undo.textContent = '×'
  undo.setAttribute('aria-label', '恢复「' + (FIELD_LABEL[field] ?? field) + '」为插件配置里的值')
  // 点击热区要够大：规范要求触控目标不小于 44px，但这个 × 很小，
  // 用 padding 把热区撑开（视觉上仍是小 ×，不会撑大徽标）
  undo.style.cssText = [
    'border: 0',
    'background: transparent',
    'color: inherit',
    'cursor: pointer',
    'font-size: 13px',
    'line-height: 1',
    'padding: 0 2px',
    'margin: -8px -4px -8px 0',
    'min-width: 44px',
    'min-height: 44px',
  ].join(';')
  undo.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    await resetField(field)
  })
  badge.appendChild(undo)

  host.appendChild(badge)
}

/**
 * 恢复单个字段。
 *
 * 走 POST /api/settings 的 reset: [字段] —— 后端早就支持，
 * 之前只是页面没用。patch: { 字段: null } 效果相同，用 reset 更直白。
 */
async function resetField(field) {
  if (pendingWrites) return
  const ok = await confirmAction({ title: '恢复配置值', text: '恢复「' + (FIELD_LABEL[field] ?? field) + '」并丢弃这一项的未保存修改？', confirmText: '恢复' })
  if (!ok || pendingWrites) return
  pendingWrites += 1
  updateSaveStatus()
  const release = lockResetFields([field])
  try {
    await queueSettings(() => postJson('/api/settings', { reset: [field] }))
    savedRevision += 1
    const refreshed = await load([field])
    notify(refreshed ? '已恢复「' + (FIELD_LABEL[field] ?? field) + '」' : '恢复已生效，但刷新失败；请重试刷新', refreshed ? 'success' : 'warning')
  } catch (e) {
    notify('恢复失败，修改已保留：' + e.message, 'error')
  } finally {
    release()
    pendingWrites -= 1
    updateSaveStatus()
  }
}

/**
 * 给所有被改过的项加标记。在 renderConfig 末尾调。
 *
 * 注意 personas / default_persona 这类也在 overriddenKeys 里，
 * 但它们没有单一控件，标记会挂在「人格」卡片的标题上。
 */
function renderOverrideBadges() {
  clearOverrideBadges()
  const keys = state.config.overriddenKeys ?? []
  if (!keys.length) return

  for (const field of keys) {
    const controlId = FIELD_CONTROL[field]
    if (controlId) {
      const control = $(controlId)
      if (control) markOverridden(field, control)
      continue
    }

    // 没有单一控件的（人格列表、默认人格）：挂到「人格」卡片的标题上。
    //
    // 用标题文本定位而不是「面板 + 第几个卡片」这种路径选择器：
    // 后者依赖 DOM 层级和顺序，改一下卡片布局就失效，
    // 而且选择器字符串会和结构测试里的面板统计互相干扰。
    if (field === 'personas' || field === 'default_persona') {
      const title = [...document.querySelectorAll('.card-title')].find((el) =>
        el.textContent.includes('人格'),
      )
      if (title) markOverridden(field, title)
      continue
    }
    const sw = document.querySelector('[data-flag="' + field + '"]')
    if (sw) markOverridden(field, sw)
  }
}

`
