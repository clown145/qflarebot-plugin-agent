/**
 * 渲染：工具与工具配置弹窗
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const VIEW_TOOLS = `
/* ---------------------------------------------------------------- 渲染：工具 */

let toolsBusy = false
const LEVEL_LABEL = { 0: '禁用', 1: '只读', 2: '写工作区', 3: '有副作用', 4: '群管理', 5: '需确认' }

function renderTools() {
  const all = state.tools?.list ?? []
  const disabled = new Set(state.tools?.disabled ?? [])
  const keyword = ($('toolSearch').value ?? '').trim().toLowerCase()
  const list = keyword
    ? all.filter(
        (t) =>
          t.name.toLowerCase().includes(keyword) ||
          (t.description ?? '').toLowerCase().includes(keyword),
      )
    : all

  $('toolCount').textContent = all.length
    ? '（' + (all.length - disabled.size) + '/' + all.length + ' 已启用）'
    : ''
  $('toolEnableAll').disabled = toolsBusy || disabled.size === 0
  $('toolDisableAll').disabled = toolsBusy || all.length === 0 || disabled.size === all.length

  const box = $('toolList')
  box.innerHTML = ''

  if (!all.length) {
    box.innerHTML =
      '<div class="empty">' +
        '<p class="empty-title">没有可用工具</p>' +
        '<p class="empty-desc">「对话行为 → 工具调用」这个总开关可能被关掉了。</p>' +
      '</div>'
    notifyResize()
    return
  }
  if (!list.length) {
    box.innerHTML =
      '<div class="empty">' +
        '<p class="empty-title">没有匹配的工具</p>' +
        '<p class="empty-desc">试试别的关键词。</p>' +
      '</div>'
    notifyResize()
    return
  }

  for (const tool of list) {
    const off = disabled.has(tool.name)
    const row = document.createElement('div')
    row.className = 'item' + (off ? ' is-off' : '')

    const main = document.createElement('div')
    main.className = 'item-main'

    const name = document.createElement('div')
    name.className = 'item-name'
    name.textContent = tool.name
    main.appendChild(name)

    if (tool.description) {
      const desc = document.createElement('div')
      desc.className = 'item-meta'
      desc.textContent = tool.description
      main.appendChild(desc)
    }

    const tags = document.createElement('div')
    tags.className = 'item-tags'
    const level = document.createElement('span')
    level.className = 'badge'
    level.textContent = '级别 ' + (LEVEL_LABEL[tool.permission?.level] ?? tool.permission?.level)
    tags.appendChild(level)
    if (tool.sideEffect === 'external_write' || tool.sideEffect === 'dangerous') {
      const effect = document.createElement('span')
      effect.className = 'badge ' + (tool.sideEffect === 'dangerous' ? 'badge--danger' : 'badge--warning')
      effect.textContent = tool.sideEffect === 'dangerous' ? '危险' : '外部写'
      tags.appendChild(effect)
    }
    for (const scope of tool.permission?.scopes ?? []) {
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = scope
      tags.appendChild(badge)
    }
    main.appendChild(tags)
    row.appendChild(main)

    // 有配置项的工具才显示「配置」按钮。按钮上标出有没有填过，
    // 用户不必点进去才知道「这个工具还缺 key」
    const fields = tool.configFields ?? []
    if (fields.length) {
      const configured = (tool.configuredKeys ?? []).length
      const missingRequired = fields.some(
        (field) => field.required && !(tool.configuredKeys ?? []).includes(field.key),
      )
      const cfgBtn = document.createElement('button')
      cfgBtn.className = 'qb-btn'
      cfgBtn.type = 'button'
      cfgBtn.textContent = configured ? '配置' : '需要配置'
      if (missingRequired) {
        cfgBtn.style.borderColor = 'var(--qb-warning)'
        cfgBtn.style.color = 'var(--qb-warning)'
      }
      cfgBtn.addEventListener('click', () => void openToolConfig(tool))
      row.appendChild(cfgBtn)
    }

    const sw = document.createElement('button')
    sw.className = 'switch'
    sw.type = 'button'
    sw.disabled = toolsBusy
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-label', tool.name)
    setSwitch(sw, !off)
    sw.innerHTML = '<span class="switch-track"><span class="switch-knob"></span></span>'
    sw.addEventListener('click', () => {
      const next = !switchOn(sw)
      setSwitch(sw, next)
      void saveToolSwitch(tool.name, next)
    })
    row.appendChild(sw)
    box.appendChild(row)
  }
  notifyResize()
}

async function saveToolSwitch(name, enabled) {
  if (toolsBusy) return
  const disabled = new Set(state.tools?.disabled ?? [])
  if (enabled) disabled.delete(name)
  else disabled.add(name)
  await saveAllTools([...disabled])
  const control = [...$('toolList').querySelectorAll('[role="switch"]')].find((el) => el.getAttribute('aria-label') === name)
  control?.focus()
}

async function saveAllTools(disabledList) {
  if (toolsBusy) return
  toolsBusy = true
  renderTools()
  try {
    await postJson('/api/tools', { disabled: disabledList })
    state.tools.disabled = [...disabledList]
    notify('工具开关已保存', 'success')
  } catch (e) {
    notify('保存失败，已恢复之前的工具开关：' + e.message, 'error')
  } finally {
    toolsBusy = false
    renderTools()
  }
}

/* ---------------------------------------------------------------- 工具配置弹窗 */

/**
 * 打开某个工具的配置弹窗。
 *
 * **表单由工具自己声明的 configFields 生成**，页面不写死任何字段名。
 * 这样加一个需要 api key 的工具时，只需工具里写 configFields，
 * 页面、接口、存储都不用改。
 */
async function openToolConfig(tool) {
  const fields = tool.configFields ?? []
  if (!fields.length) return

  const mask = document.createElement('div')
  mask.className = 'modal-mask'

  const modal = document.createElement('div')
  modal.className = 'modal'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.setAttribute('aria-label', (tool.title || tool.name) + ' · 配置')

  const title = document.createElement('h3')
  title.textContent = (tool.title || tool.name) + ' · 配置'
  modal.appendChild(title)

  const desc = document.createElement('p')
  desc.textContent = '这些配置只属于这个工具，点击保存后生效。'
  modal.appendChild(desc)

  const inputs = {}
  const cleared = new Set()
  let saving = false
  let confirming = false

  for (const field of fields) {
    const wrap = document.createElement('div')
    wrap.className = 'field'
    wrap.style.marginBottom = 'var(--qb-space-3)'

    const label = document.createElement('label')
    label.textContent = field.label + (field.required ? '（必填）' : '')
    wrap.appendChild(label)

    // secret 类型：已经配过时**不回显**，用占位符说明「已设置」，
    // 留空提交等于不改；要清空就明文写一个减号？——不，用单独的「清除」按钮更明确
    const isSecretSet = field.type === 'secret' && (tool.configuredKeys ?? []).includes(field.key)

    const input = document.createElement('input')
    input.id = 'tool-field-' + (++fieldSeed)
    label.htmlFor = input.id
    input.className = 'qb-input' + (field.type === 'secret' ? ' mono-input' : '')
    input.type = field.type === 'secret' ? 'password' : 'text'
    input.placeholder = isSecretSet ? '已设置（留空则不修改）' : (field.placeholder ?? '')
    if (!isSecretSet && field.type !== 'secret') {
      input.value = tool.config?.[field.key] ?? ''
    }
    inputs[field.key] = input
    wrap.appendChild(input)

    if (field.hint) {
      const hint = document.createElement('p')
      hint.className = 'qb-muted'
      hint.style.fontSize = 'var(--qb-text-xs)'
      hint.style.margin = 'var(--qb-space-1) 0 0'
      hint.textContent = field.hint
      wrap.appendChild(hint)
    }

    if (isSecretSet) {
      const clear = document.createElement('button')
      clear.className = 'qb-btn'
      clear.type = 'button'
      clear.textContent = '清除已保存的值'
      clear.style.marginTop = 'var(--qb-space-1)'
      clear.addEventListener('click', () => {
        if (cleared.has(field.key)) cleared.delete(field.key)
        else cleared.add(field.key)
        input.value = ''
        input.placeholder = cleared.has(field.key) ? '保存后清除' : '已设置（留空则不修改）'
        clear.textContent = cleared.has(field.key) ? '撤销清除' : '清除已保存的值'
      })
      wrap.appendChild(clear)
    }

    modal.appendChild(wrap)
  }

  const err = document.createElement('p')
  err.className = 'field-error'
  err.setAttribute('role', 'alert')
  err.style.fontSize = 'var(--qb-text-xs)'
  err.style.margin = '0'
  modal.appendChild(err)

  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  actions.style.marginTop = 'var(--qb-space-4)'

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'qb-btn'
  cancelBtn.type = 'button'
  cancelBtn.textContent = '取消'
  cancelBtn.addEventListener('click', () => void requestClose())

  const saveBtn = document.createElement('button')
  saveBtn.className = 'qb-btn qb-btn--primary'
  saveBtn.type = 'button'
  saveBtn.textContent = '保存'
  saveBtn.addEventListener('click', async () => {
    if (saving) return
    const values = {}
    for (const [key, input] of Object.entries(inputs)) {
      const value = input.value.trim()
      // 留空 = 不改（对 secret）或不填（对普通字段），都不写库
      const field = fields.find((item) => item.key === key)
      if (value || cleared.has(key) || (field?.type !== 'secret' && value !== (tool.config?.[key] ?? ''))) values[key] = value
    }
    if (!Object.keys(values).length) {
      err.textContent = '没有要保存的内容'
      return
    }
    saving = true
    for (const el of mask.querySelectorAll('input, button')) el.disabled = true
    saveBtn.textContent = '保存中…'
    try {
      await postJson('/api/tools/config', { tool: tool.name, values })
      saving = false
      close()
      notify('配置已保存', 'success')
      await load()
    } catch (e) {
      err.textContent = '保存失败，输入已保留：' + e.message
    } finally {
      saving = false
      for (const el of mask.querySelectorAll('input, button')) el.disabled = false
      saveBtn.textContent = '保存'
      publishDraftState()
    }
  })

  actions.appendChild(cancelBtn)
  actions.appendChild(saveBtn)
  modal.appendChild(actions)
  mask.appendChild(modal)
  document.body.appendChild(mask)

  // 焦点困在对话框里（规范要求）：Tab 不会跑到后面的表单上
  const releaseFocus = trapFocus(mask)

  const baseline = JSON.stringify(Object.values(inputs).map((input) => input.value))
  const releaseDraft = trackDialogDraft(mask, () => saving || cleared.size > 0 || baseline !== JSON.stringify(Object.values(inputs).map((input) => input.value)))
  async function requestClose() {
    if (saving || confirming) return
    if (cleared.size || baseline !== JSON.stringify(Object.values(inputs).map((input) => input.value))) {
      confirming = true
      const ok = await confirmAction({ title: '放弃修改', text: '工具配置有未保存的修改。', confirmText: '放弃修改', cancelText: '继续编辑' })
      confirming = false
      if (!ok) return
    }
    close()
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && modalStack.at(-1) === mask) { e.preventDefault(); e.stopImmediatePropagation(); void requestClose() }
  }
  document.addEventListener('keydown', onKey)

  function close() {
    if (saving) return
    document.removeEventListener('keydown', onKey)
    releaseFocus()
    releaseDraft()
    mask.remove()
    notifyResize()
  }

  mask.addEventListener('click', (e) => {
    if (e.target === mask) void requestClose()
  })

  // 聚焦第一个空输入框
  const firstEmpty = Object.values(inputs).find((input) => !input.value)
  firstEmpty?.focus()
  notifyResize()
}
`
