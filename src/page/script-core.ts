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
 * 2. **状态变化要上报草稿** —— 面板才能在离开时保护未保存的编辑。
 * 3. **不自己实现宿主已有的东西** —— 卡片/按钮/输入框用 .qb-*。
 */
const $ = (id) => document.getElementById(id)
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ---------------------------------------------------------------- 请求 */

let activeMutations = 0
async function request(path, init) {
  const writing = init?.method && !['GET', 'HEAD'].includes(init.method) && path !== '/api/test'
  if (writing) { activeMutations += 1; publishDraftState() }
  try {
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
    return await res.json()
  } finally {
    if (writing) { activeMutations -= 1; publishDraftState() }
  }
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

const copy = (value) => JSON.parse(JSON.stringify(value))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
let loaded = false
let savedRevision = 0
let settingsQueue = Promise.resolve()
let pendingWrites = 0
const pendingFields = new Map()
const localEdits = new Map()
const failedFields = new Map()
let reloadFailed = false
let personaTouched = false

const promptDirty = () => loaded && $('promptBox').value !== (state.config.system_prompt ?? '')
const personasDirty = () => loaded && (personaTouched || !same(draftPersonas, state.config.personas ?? []))
const dialogDraftChecks = new Set()
const keywordDirty = () => Boolean($('filterKeywords').querySelector('input')?.value.trim())
const hasDrafts = () => promptDirty() || personasDirty() || localEdits.size > 0 || pendingWrites > 0 || activeMutations > 0 || keywordDirty() || [...dialogDraftChecks].some((check) => Boolean(check()))

function publishDraftState() {
  bridge?.setDirty?.(hasDrafts())
}

function trackDialogDraft(mask, check) {
  dialogDraftChecks.add(check)
  mask.addEventListener('input', updateSaveStatus)
  mask.addEventListener('change', updateSaveStatus)
  mask.addEventListener('click', updateSaveStatus)
  updateSaveStatus()
  return () => { dialogDraftChecks.delete(check); updateSaveStatus() }
}

function updateSaveStatus() {
  const dirty = hasDrafts()
  $('saveStatus').textContent = pendingWrites ? '保存中…' : failedFields.size ? '保存失败，修改已保留' : reloadFailed ? '刷新失败，当前内容已保留' : dirty ? '有未保存的修改' : '已保存'
  $('retrySave').hidden = !failedFields.size && !reloadFailed
  $('retrySave').disabled = pendingWrites > 0
  $('savePrompt').disabled = pendingFields.has('system_prompt') || !promptDirty()
  $('savePersonaList').disabled = pendingFields.has('personas') || !personasDirty()
  $('promptState').textContent = promptDirty() ? '未保存 · 点击保存后生效' : '已保存 · 人格提示词会追加在它后面'
  $('personaState').textContent = personasDirty() ? '未保存 · 新增、删除和权限修改都需要保存' : '已保存'
  for (const [key, id] of Object.entries(FIELD_CONTROL)) {
    if (key === 'system_prompt' || key === 'personas') continue
    const control = id ? $(id) : document.querySelector('[data-flag="' + key + '"]')
    if (control && 'disabled' in control) control.disabled = pendingFields.has(key) || !loaded
  }
  $('promptBox').disabled = !loaded
  $('addPersona').disabled = !loaded
  if (!(state.modelStatus?.models ?? []).length) $('modelSelect').disabled = true
  $('resetAll').disabled = pendingWrites > 0 || !loaded
  $('resetPrompt').disabled = pendingFields.has('system_prompt') || !loaded
  publishDraftState()
  notifyResize()
}

function queueSettings(task) {
  const result = settingsQueue.then(task, task)
  settingsQueue = result.catch(() => {})
  return result
}

function savePatch(patch, successMessage) {
  const submitted = copy(patch)
  const keys = Object.keys(submitted)
  for (const key of keys) {
    localEdits.set(key, submitted[key])
    failedFields.delete(key)
    pendingFields.set(key, (pendingFields.get(key) ?? 0) + 1)
  }
  pendingWrites += 1
  updateSaveStatus()
  return queueSettings(async () => {
    try {
      const result = await postJson('/api/settings', { patch: submitted })
      savedRevision += 1
      // Only advance the saved baseline. Never replace another form's draft.
      for (const key of keys) {
        state.config[key] = copy(submitted[key])
        if (same(localEdits.get(key), submitted[key])) localEdits.delete(key)
        failedFields.delete(key)
      }
      if (keys.includes('personas') && same(draftPersonas, submitted.personas)) personaTouched = false
      state.config.overriddenKeys = result.overriddenKeys ?? [...new Set([...(state.config.overriddenKeys ?? []), ...keys])]
      renderOverrideBadges()
      if (keys.includes('personas')) renderDefaultPersonaSelect(draftPersonas)
      if (keys.some((key) => ['enable_tools', 'enable_skills', 'enable_schedule', 'enable_vfs'].includes(key))) await load()
      if (successMessage) notify(successMessage, 'success')
      return true
    } catch (e) {
      for (const key of keys) failedFields.set(key, submitted[key])
      notify('保存失败，修改已保留：' + e.message, 'error')
      return false
    } finally {
      pendingWrites -= 1
      for (const key of keys) {
        const count = pendingFields.get(key) - 1
        if (count) pendingFields.set(key, count)
        else pendingFields.delete(key)
      }
      updateSaveStatus()
    }
  })
}

function showFieldError(control, message) {
  const container = control.closest('.field, .setting-row') ?? control.parentElement
  let error = container.querySelector('.field-error')
  if (!error) {
    error = document.createElement('p')
    error.className = 'field-error'
    error.id = 'error-' + (control.id || ++fieldSeed)
    error.setAttribute('role', 'alert')
    container.appendChild(error)
  }
  error.textContent = message
  control.setAttribute('aria-invalid', 'true')
  control.setAttribute('aria-errormessage', error.id)
  control.addEventListener('input', () => {
    error.remove()
    control.removeAttribute('aria-invalid')
    control.removeAttribute('aria-errormessage')
  }, { once: true })
  control.closest('details')?.setAttribute('open', '')
  control.focus()
  notifyResize()
}
let fieldSeed = 0

function lockResetFields(keys) {
  const controls = new Set()
  for (const key of keys) {
    const id = FIELD_CONTROL[key]
    const control = id ? $(id) : key === 'personas' ? $('personaList') : document.querySelector('[data-flag="' + key + '"]')
    if (!control) continue
    const host = key === 'personas' || key === 'system_prompt' ? control.closest('.qb-card') : control
    if ('disabled' in host) controls.add(host)
    for (const el of host.querySelectorAll('input, select, textarea, button')) controls.add(el)
  }
  const previous = [...controls].map((el) => [el, el.disabled])
  for (const [el] of previous) el.disabled = true
  return () => { for (const [el, disabled] of previous) el.disabled = disabled }
}

`
