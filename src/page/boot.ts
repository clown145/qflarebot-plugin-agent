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

async function load() {
  try {
    const data = await get('/api/overview')
    state = data
    renderModel()
    renderPersonas()
    renderConfig()
    renderTools()
    renderSkills()
    renderData()
  } catch (e) {
    notify('数据加载失败：' + e.message, 'error')
    for (const id of ['personaList', 'toolList', 'skillList']) {
      $(id).innerHTML =
        '<div class="empty"><p class="empty-title">加载失败</p><p class="empty-desc">' +
        esc(e.message) +
        '</p></div>'
    }
    notifyResize()
  }
}

/* ---------------------------------------------------------------- 动作 */

async function savePrompt() {
  await savePatch({ system_prompt: $('promptBox').value }, '提示词已保存')
}

async function resetPrompt() {
  await savePatch({ system_prompt: null }, '已恢复成配置里的提示词')
}

async function saveScalars() {
  const patch = {
    wake_prefix: $('wakePrefix').value,
    friend_needs_wake_prefix: switchOn($('friendPrefix')),
    max_model_steps: Number($('maxSteps').value),
    max_tool_calls: Number($('maxToolCalls').value),
    history_limit: Number($('historyLimit').value),
    request_timeout_ms: Number($('timeoutMs').value),
    timezone: $('timezone').value,
    context_compression: $('contextCompression').value,
    reply_mention: $('replyMention').value,
    max_context_tokens: Number($('maxContextTokens').value),
    rate_limit_per_minute: Number($('rateLimit').value),
  }
  await savePatch(patch, '已保存')
}

async function saveScalarsSilently() {
  try {
    await saveScalars()
  } catch {
    /* savePatch 内部已提示 */
  }
}

async function savePersonas() {
  const cleaned = draftPersonas.filter((p) => (p.name ?? '').trim())
  if (!cleaned.length) {
    notify('至少要有一套有名字的人格', 'error')
    return
  }
  await savePatch({ personas: cleaned }, '人格已保存')
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
    '<div class="modal" role="dialog" aria-modal="true" style="width: min(100%, 40rem)">' +
      '<h3>' + esc(title) + '</h3>' +
      '<p>正文上限 32KB。<code>description</code> 必填，它会进模型目录。</p>' +
      '<div class="field" style="margin-bottom: var(--qb-space-3)">' +
        '<label>技能 id（字母数字 . _ -）</label>' +
        '<input class="qb-input mono-input" id="skillIdInput" placeholder="report" value="' + esc(id ?? '') + '"' +
          (id ? ' readonly' : '') + ' />' +
      '</div>' +
      '<div class="field">' +
        '<label>SKILL.md 全文</label>' +
        '<textarea class="qb-textarea mono-input" id="skillBodyInput" style="min-height: 16rem"></textarea>' +
      '</div>' +
      '<p class="qb-muted" style="font-size: var(--qb-text-xs); margin: var(--qb-space-2) 0 0" id="skillErr"></p>' +
      '<div class="modal-actions" style="margin-top: var(--qb-space-4)">' +
        '<button class="qb-btn" data-act="cancel" type="button">取消</button>' +
        '<button class="qb-btn qb-btn--primary" data-act="save" type="button">保存</button>' +
      '</div>' +
    '</div>'

  document.body.appendChild(mask)
  const bodyInput = mask.querySelector('#skillBodyInput')
  bodyInput.value = content
  bodyInput.focus()

  // 焦点困在对话框里（规范要求）
  const releaseFocus = trapFocus(mask)
  const close = () => {
    document.removeEventListener('keydown', onKey)
    releaseFocus()
    mask.remove()
    notifyResize()
  }
  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  mask.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act
    if (act === 'cancel' || e.target === mask) return close()
    if (act !== 'save') return
    const skillIdValue = mask.querySelector('#skillIdInput').value.trim()
    if (!skillIdValue) {
      mask.querySelector('#skillErr').textContent = '请填写技能 id'
      return
    }
    try {
      await postJson('/api/skills', { id: skillIdValue, content: bodyInput.value })
      close()
      notify('技能已保存', 'success')
      await load()
    } catch (error) {
      mask.querySelector('#skillErr').textContent = error.message
    }
  })
}

async function resetAll() {
  const ok = await confirmAction({
    title: '恢复全部配置',
    text: '本页改过的所有项都会恢复成插件配置里的值。',
    confirmText: '恢复',
  })
  if (!ok) return
  try {
    await postJson('/api/settings', { reset: true })
    notify('已全部恢复', 'success')
    await load()
  } catch (e) {
    notify('恢复失败：' + e.message, 'error')
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

  $('savePrompt').addEventListener('click', () => void savePrompt())
  $('resetPrompt').addEventListener('click', () => void resetPrompt())

  $('friendPrefix').addEventListener('click', () => {
    setSwitch($('friendPrefix'), !switchOn($('friendPrefix')))
    void saveScalarsSilently()
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
    $(id).addEventListener('change', () => void saveScalarsSilently())
  }

  $('defaultPersona').addEventListener('change', () => {
    void savePatch({ default_persona: $('defaultPersona').value }, '默认人格已更新')
  })

  $('addPersona').addEventListener('click', () => {
    draftPersonas.push({
      name: '',
      prompt: '',
      begin_dialogs: '',
      tools: [],
      skills: [],
      custom_error_message: '',
    })
    state.config.personas = draftPersonas
    renderPersonas()
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
await load()
moveThumb()
notifyResize()
`
