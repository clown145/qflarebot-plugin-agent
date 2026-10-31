/**
 * 加载、动作、事件、启动
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const SCRIPT_BOOT = `
/* ---------------------------------------------------------------- 加载 */

function skeletonHtml(lines = 3) {
  return (
    '<div class="skeleton">' +
    Array.from({ length: lines }, (_, i) =>
      '<div class="sk-line ' + (i === 0 ? 'w-40' : i % 2 ? 'w-80' : 'w-60') + '"></div>',
    ).join('') +
    '</div>'
  )
}

function showSkeleton() {
  $('personaList').innerHTML = skeletonHtml(3)
  $('toolList').innerHTML = skeletonHtml(3)
  $('skillList').innerHTML = skeletonHtml(2)
  for (const id of ['convRows', 'scheduleRows', 'auditRows', 'stats']) {
    $(id).innerHTML = '<tr><td colspan="4">' + skeletonHtml(2) + '</td></tr>'
  }
  notifyResize()
}

async function load(resetKeys = []) {
  const revision = savedRevision
  try {
    const data = await get('/api/overview')
    if (revision !== savedRevision) return load(resetKeys)
    const keepPrompt = promptDirty() && !resetKeys.includes('system_prompt')
    const keepPersonas = personasDirty() && !resetKeys.includes('personas')
    state = data
    loaded = true
    reloadFailed = false
    for (const key of resetKeys) { localEdits.delete(key); failedFields.delete(key) }
    if (!localEdits.has('model')) renderModel()
    if (!keepPersonas) { draftPersonas = copy(state.config.personas ?? []); personaTouched = false; renderPersonas() }
    renderConfig(keepPrompt)
    renderTools()
    renderSkills()
    renderData()
    updateSaveStatus()
    return true
  } catch (e) {
    notify('数据加载失败：' + e.message, 'error')
    reloadFailed = true
    if (!loaded) for (const id of ['personaList', 'toolList', 'skillList']) {
      $(id).innerHTML =
        '<div class="empty"><p class="empty-title">加载失败</p><p class="empty-desc">' +
        esc(e.message) +
        '</p></div>'
    }
    updateSaveStatus()
    return false
  }
}

/* ---------------------------------------------------------------- 动作 */

async function savePrompt() {
  await savePatch({ system_prompt: $('promptBox').value }, '提示词已保存')
}

async function resetPrompt() {
  await resetField('system_prompt')
}

async function saveScalar(id) {
  const key = Object.keys(FIELD_CONTROL).find((key) => FIELD_CONTROL[key] === id)
  if (!key) return
  const input = $(id)
  if (input.type === 'number' && (!input.value.trim() || !input.checkValidity() || !Number.isFinite(Number(input.value)))) {
    showFieldError(input, '请输入 ' + (input.min || '0') + '–' + (input.max || '允许上限') + ' 之间的整数')
    localEdits.set(key, input.value)
    updateSaveStatus()
    return
  }
  const value = input.type === 'number' ? Number(input.value) : input.value
  await savePatch({ [key]: value }, (FIELD_LABEL[key] ?? '设置') + '已保存')
}

async function savePersonas() {
  for (const pair of $('personaList').querySelectorAll('[data-dialog-pair]')) {
    const user = pair.querySelector('[data-dialog-role="用户"]')
    const assistant = pair.querySelector('[data-dialog-role="角色"]')
    if (Boolean(user.value.trim()) !== Boolean(assistant.value.trim())) {
      showFieldError(user.value.trim() ? assistant : user, '请补全这一对开场对话，或删除这一对')
      return
    }
  }
  const names = new Set()
  for (let i = 0; i < draftPersonas.length; i++) {
    const name = (draftPersonas[i].name ?? '').trim()
    if (!name || names.has(name)) {
      const input = $('personaList').querySelectorAll('[data-persona-name]')[i]
      showFieldError(input, !name ? '请填写人格名字' : '人格名字不能重复')
      return
    }
    names.add(name)
  }
  const cleaned = draftPersonas.map((p) => ({ ...p, name: p.name.trim() }))
  const before = copy(draftPersonas)
  const saved = await savePatch({ personas: cleaned, default_persona: $('defaultPersona').value }, '人格已保存')
  if (saved && same(draftPersonas, before)) {
    draftPersonas = copy(cleaned)
    personaTouched = false
    const inputs = $('personaList').querySelectorAll('[data-persona-name]')
    inputs.forEach((input, index) => { input.value = cleaned[index].name })
    updateSaveStatus()
  }
}

async function openSkillEditor(id) {
  let content = ['---', 'name: ', 'description: ', '---', '', ''].join(NEWLINE)
  let title = '新增技能'

  if (id) {
    title = '编辑技能 ' + id
    try {
      const data = await get('/api/skills/' + encodeURIComponent(id))
      content = data.content ?? content
    } catch (e) {
      notify('读取技能失败：' + e.message, 'error')
      return
    }
  }

  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" style="width: min(100%, 40rem)">' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>正文上限 32KB。<code>description</code> 必填，它会进模型目录。</p>' +
      '<div class="field" style="margin-bottom: var(--qb-space-3)">' +
        '<label for="skillIdInput">技能 id（字母数字 . _ -）</label>' +
        '<input class="qb-input mono-input" id="skillIdInput" placeholder="report" value="' + esc(id ?? '') + '"' +
          (id ? ' readonly' : '') + ' />' +
      '</div>' +
      '<div class="field">' +
        '<label for="skillBodyInput">SKILL.md 全文</label>' +
        '<textarea class="qb-textarea mono-input" id="skillBodyInput" style="min-height: 16rem"></textarea>' +
      '</div>' +
      '<p class="qb-muted" style="font-size: var(--qb-text-xs); margin: var(--qb-space-2) 0 0" id="skillErr" role="alert"></p>' +
      '<div class="modal-actions" style="margin-top: var(--qb-space-4)">' +
        '<button class="qb-btn" data-act="cancel" type="button">取消</button>' +
        '<button class="qb-btn qb-btn--primary" data-act="save" type="button">保存</button>' +
      '</div>' +
    '</div>'

  document.body.appendChild(mask)
  const bodyInput = mask.querySelector('#skillBodyInput')
  bodyInput.value = content

  // 焦点困在对话框里（规范要求）
  const releaseFocus = trapFocus(mask)
  bodyInput.focus()
  let saving = false
  let confirming = false
  const releaseDraft = trackDialogDraft(mask, () => saving || bodyInput.value !== content || (!id && mask.querySelector('#skillIdInput').value.trim()))
  const close = () => {
    if (saving) return
    document.removeEventListener('keydown', onKey)
    releaseFocus()
    releaseDraft()
    mask.remove()
    notifyResize()
  }
  const requestClose = async () => {
    if (saving || confirming) return
    if (bodyInput.value !== content || (!id && mask.querySelector('#skillIdInput').value)) {
      confirming = true
      const ok = await confirmAction({ title: '放弃修改', text: '技能有未保存的修改，关闭会丢弃这些修改。', confirmText: '放弃修改', cancelText: '继续编辑' })
      confirming = false
      if (!ok) return
    }
    close()
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && modalStack.at(-1) === mask) { e.preventDefault(); e.stopImmediatePropagation(); void requestClose() }
  }
  document.addEventListener('keydown', onKey)

  mask.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act
    if (act === 'cancel' || e.target === mask) return void requestClose()
    if (act !== 'save' || saving) return
    const skillIdValue = mask.querySelector('#skillIdInput').value.trim()
    if (!skillIdValue) {
      showFieldError(mask.querySelector('#skillIdInput'), '请填写技能 id')
      return
    }
    saving = true
    const controls = [...mask.querySelectorAll('button, input, textarea')]
    controls.forEach((el) => { el.disabled = true })
    try {
      await postJson('/api/skills', { id: skillIdValue, content: bodyInput.value })
      saving = false
      close()
      notify('技能已保存', 'success')
      await load()
    } catch (error) {
      mask.querySelector('#skillErr').textContent = '保存失败，输入已保留：' + error.message
    } finally {
      saving = false
      controls.forEach((el) => { el.disabled = false })
      publishDraftState()
    }
  })
}

async function resetAll() {
  const ok = await confirmAction({
    title: '恢复全部配置',
    text: '本页改过的所有项都会恢复成插件配置里的值，未保存的草稿也会被丢弃。',
    confirmText: '恢复',
  })
  if (!ok || pendingWrites) return
  pendingWrites += 1
  updateSaveStatus()
  const release = lockResetFields(Object.keys(FIELD_CONTROL))
  try {
    await queueSettings(() => postJson('/api/settings', { reset: true }))
    savedRevision += 1
    const refreshed = await load(Object.keys(FIELD_CONTROL))
    notify(refreshed ? '已全部恢复' : '恢复已生效，但刷新失败；请重试刷新', refreshed ? 'success' : 'warning')
  } catch (e) {
    notify('恢复失败：' + e.message, 'error')
  } finally {
    release()
    pendingWrites -= 1
    updateSaveStatus()
  }
}

/* ---------------------------------------------------------------- 事件 */

function bindEvents() {
  $('testBtn').addEventListener('click', async () => {
    const btn = $('testBtn')
    btn.disabled = true
    $('pingResult').textContent = '测试中…'
    try {
      const result = await request('/api/test', { method: 'POST' })
      $('pingResult').textContent = result.ok
        ? '正常（' + result.latencyMs + 'ms）'
        : '失败：' + (result.error ?? '未知')
    } catch (e) {
      $('pingResult').textContent = '失败：' + e.message
    } finally {
      btn.disabled = false
      notifyResize()
    }
  })

  $('modelSelect').addEventListener('change', () => {
    void savePatch({ model: $('modelSelect').value }, '模型已切换')
  })

  $('promptBox').addEventListener('input', updateSaveStatus)
  $('personaList').addEventListener('input', () => { personaTouched = true; updateSaveStatus() })
  $('personaList').addEventListener('change', () => { personaTouched = true; updateSaveStatus() })
  $('retrySave').addEventListener('click', async () => {
    if (failedFields.size) {
      const retry = Object.fromEntries(failedFields)
      if ('system_prompt' in retry) retry.system_prompt = $('promptBox').value
      if ('personas' in retry) { delete retry.personas; delete retry.default_persona; await savePersonas() }
      if (Object.keys(retry).length) await savePatch(retry, '已重新保存')
    }
    else if (reloadFailed) await load()
  })
  window.addEventListener('beforeunload', (event) => {
    if (hasDrafts()) { event.preventDefault(); event.returnValue = '' }
  })

  $('savePrompt').addEventListener('click', () => void savePrompt())
  $('resetPrompt').addEventListener('click', () => void resetPrompt())

  $('friendPrefix').addEventListener('click', () => {
    setSwitch($('friendPrefix'), !switchOn($('friendPrefix')))
    void savePatch({ friend_needs_wake_prefix: switchOn($('friendPrefix')) }, '单聊前缀设置已保存')
  })

  for (const sw of document.querySelectorAll('[data-flag]')) {
    sw.addEventListener('click', () => {
      setSwitch(sw, !switchOn(sw))
      void savePatch({ [sw.dataset.flag]: switchOn(sw) })
    })
  }

  for (const id of [
    'wakePrefix', 'maxSteps', 'maxToolCalls', 'historyLimit',
    'timeoutMs', 'timezone', 'contextCompression', 'maxContextTokens', 'rateLimit',
    'replyMention',
  ]) {
    $(id).addEventListener('change', () => void saveScalar(id))
    $(id).addEventListener('input', () => {
      const key = Object.keys(FIELD_CONTROL).find((key) => FIELD_CONTROL[key] === id)
      if (key) { localEdits.set(key, $(id).value); failedFields.delete(key) }
      updateSaveStatus()
    })
  }

  $('defaultPersona').addEventListener('change', () => {
    if (personasDirty()) { personaTouched = true; updateSaveStatus(); return }
    void savePatch({ default_persona: $('defaultPersona').value }, '默认人格已更新')
  })

  $('addPersona').addEventListener('click', () => {
    draftPersonas.push({
      name: '',
      prompt: '',
      begin_dialogs: '',
      custom_error_message: '',
    })
    personaTouched = true
    renderPersonas()
    updateSaveStatus()
    const details = $('personaList').querySelectorAll('details')
    details[details.length - 1]?.setAttribute('open', '')
    notifyResize()
  })
  $('savePersonaList').addEventListener('click', () => void savePersonas())

  $('toolSearch').addEventListener('input', renderTools)
  $('skillSearch').addEventListener('input', renderSkills)
  $('convSearch').addEventListener('input', renderData)
  $('toolEnableAll').addEventListener('click', () => void saveAllTools([]))
  $('toolDisableAll').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '关闭全部工具',
      text: '模型将不能再调用任何工具，只剩纯聊天。',
      confirmText: '全部关闭',
      danger: true,
    })
    if (!ok) return
    void saveAllTools((state.tools?.list ?? []).map((t) => t.name))
  })

  $('addSkill').addEventListener('click', () => void openSkillEditor())
  $('resetAll').addEventListener('click', () => void resetAll())

  // 宿主切主题时跟着变
  bridge?.onTheme?.((theme) => {
    if (theme) document.documentElement.dataset.theme = theme
  })
}

/* ---------------------------------------------------------------- 启动 */

showSkeleton()
initTabs()
bindEvents()
labelControls()
updateSaveStatus()
await load()
moveThumb()
notifyResize()
`
