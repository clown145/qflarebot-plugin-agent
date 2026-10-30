/**
 * 渲染：模型与人格
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const VIEW_PERSONA = `
/* ---------------------------------------------------------------- 渲染：模型 */

function renderModel() {
  const aliases = state.modelStatus?.models ?? []
  const current = state.config.model ?? ''
  const select = $('modelSelect')

  select.innerHTML = ''
  if (!aliases.length) {
    const option = document.createElement('option')
    option.textContent = state.modelStatus?.error ? '模型列表读取失败' : '未配置模型'
    option.value = ''
    select.appendChild(option)
    select.disabled = true
    $('modelHint').textContent = state.modelStatus?.error ?? '请先启用「LLM 接口」插件'
    return
  }
  select.disabled = false
  for (const alias of aliases) {
    const option = document.createElement('option')
    option.value = alias
    option.textContent = alias
    if (alias === current) option.selected = true
    select.appendChild(option)
  }
  // 「已改」由 renderOverrideBadges 统一打徽标，这里只说明来源；
  // 两边都说一遍是重复信息，用户会以为是两件事
  $('modelHint').textContent = '来自插件配置'
}

/* ---------------------------------------------------------------- 渲染：人格 */

function renderPersonas() {
  const list = state.config.personas ?? []
  draftPersonas = list.map((p) => ({ ...p }))
  $('personaCount').textContent = list.length ? '（' + list.length + ' 套）' : ''

  renderDefaultPersonaSelect(list)

  const box = $('personaList')
  box.innerHTML = ''
  if (!list.length) {
    box.innerHTML =
      '<div class="empty" style="margin-top: var(--qb-space-3)">' +
        '<p class="empty-title">还没有人格</p>' +
        '<p class="empty-desc">不配也能用——「对话行为」里的系统提示词就是默认人格。</p>' +
      '</div>'
    notifyResize()
    return
  }

  list.forEach((persona, index) => box.appendChild(personaEditor(persona, index)))
  notifyResize()
}

/**
 * 渲染「默认人格」下拉。
 *
 * 单独成函数是因为**改名后必须重刷**：人格按 name 绑定，如果用户把
 * cat 改成 kitty 而下拉还停在 cat，点保存时就会把 default_persona
 * 写成一个不存在的人格——看起来「默认人格没生效」，实际是被静默弄丢了。
 */
function renderDefaultPersonaSelect(list) {
  const defaultSelect = $('defaultPersona')
  const previous = defaultSelect.value || state.config.default_persona || ''
  defaultSelect.innerHTML = ''

  const noneOption = document.createElement('option')
  noneOption.value = ''
  noneOption.textContent = '（不设默认）'
  defaultSelect.appendChild(noneOption)

  for (const persona of list) {
    const name = (persona.name ?? '').trim()
    if (!name) continue
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    defaultSelect.appendChild(option)
  }

  // 之前选的那个还在就保留，不在了就回落到「不设默认」——
  // 不要偷偷改成第一项，那会让用户以为默认人格被人改了
  defaultSelect.value = [...defaultSelect.options].some((option) => option.value === previous)
    ? previous
    : ''
}

/** 一套人格的折叠编辑器：默认收起，避免长表单铺满屏幕 */
function personaEditor(persona, index) {
  const wrap = document.createElement('details')
  wrap.className = 'item'
  wrap.style.display = 'block'
  wrap.style.marginTop = 'var(--qb-space-3)'

  const summary = document.createElement('summary')
  summary.style.cursor = 'pointer'
  summary.style.listStyle = 'none'
  summary.style.display = 'flex'
  summary.style.alignItems = 'center'
  summary.style.gap = 'var(--qb-space-2)'
  const isDefault = (persona.name ?? '') !== '' && persona.name === state.config.default_persona
  summary.innerHTML =
    '<span class="item-title">' + esc(persona.name || '(未命名人格)') + '</span>' +
    (isDefault ? '<span class="badge badge--accent">默认</span>' : '') +
    '<span class="badge">' + (persona.prompt ? '已配提示词' : '无提示词') + '</span>'
  wrap.appendChild(summary)

  const body = document.createElement('div')
  body.style.display = 'grid'
  body.style.gap = 'var(--qb-space-3)'
  body.style.marginTop = 'var(--qb-space-3)'

  const field = (label, control) => {
    const div = document.createElement('div')
    div.className = 'field'
    const lab = document.createElement('label')
    lab.textContent = label
    div.appendChild(lab)
    div.appendChild(control)
    return div
  }

  const nameInput = document.createElement('input')
  nameInput.className = 'qb-input mono-input'
  nameInput.value = persona.name ?? ''
  nameInput.placeholder = '如 cat'
  nameInput.addEventListener('input', () => {
    draftPersonas[index].name = nameInput.value
    summary.querySelector('.item-title').textContent = nameInput.value || '(未命名人格)'
    // 名字是绑定的键，改名会改变下拉里该有的选项 → 立刻重刷，
    // 否则保存时 default_persona 会写成一个不存在的名字（看起来像「默认人格没生效」）
    renderDefaultPersonaSelect(draftPersonas)
  })

  const promptInput = document.createElement('textarea')
  promptInput.className = 'qb-textarea'
  promptInput.value = persona.prompt ?? ''
  promptInput.placeholder = '这套人格的提示词。会追加在系统提示词后面。'
  promptInput.addEventListener('input', () => {
    draftPersonas[index].prompt = promptInput.value
  })

  // 开场对话：成对的「用户说 / 角色说」输入框，不让用户手打 user: 前缀。
  // 存储格式不变（还是那段文本），老配置原样兼容。
  const beginInput = createDialogPairs(
    parseDialogText(persona.begin_dialogs),
    (pairs) => {
      draftPersonas[index].begin_dialogs = serializeDialogPairs(pairs)
    },
  )

  // 工具与技能：从**已知清单勾选**，不让用户手打名字。
  // 手打必然拼错，而且用户根本不知道系统里有哪些可用。
  const toolsInput = createCheckList(
    '可用工具',
    (state.tools?.list ?? []).map((tool) => ({
      value: tool.name,
      label: tool.title && tool.title !== tool.name ? tool.title + ' · ' + tool.name : tool.name,
    })),
    persona.tools ?? [],
    (values) => {
      draftPersonas[index].tools = values
    },
    '留空 = 这套人格可以用全部工具',
  )

  const skillsInput = createCheckList(
    '可见技能',
    (state.skills ?? []).map((skill) => ({
      value: skill.id,
      label: skill.name && skill.name !== skill.id ? skill.name + ' · ' + skill.id : skill.id,
    })),
    persona.skills ?? [],
    (values) => {
      draftPersonas[index].skills = values
    },
    '留空 = 这套人格能看到全部技能',
  )

  const errorInput = document.createElement('textarea')
  errorInput.className = 'qb-textarea'
  errorInput.style.minHeight = '3.5rem'
  errorInput.value = persona.custom_error_message ?? ''
  errorInput.placeholder = '留空用通用错误文案'
  errorInput.addEventListener('input', () => {
    draftPersonas[index].custom_error_message = errorInput.value
  })

  body.appendChild(field('名字（会话按它绑定）', nameInput))
  body.appendChild(field('人格提示词', promptInput))
  body.appendChild(beginInput)
  body.appendChild(toolsInput)
  body.appendChild(skillsInput)
  body.appendChild(field('出错时的回复', errorInput))

  const del = document.createElement('div')
  del.style.display = 'flex'
  del.style.justifyContent = 'flex-end'
  const delBtn = document.createElement('button')
  delBtn.className = 'qb-btn'
  delBtn.type = 'button'
  delBtn.textContent = '删除这套人格'
  delBtn.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '删除人格',
      text: '删除「' + (draftPersonas[index].name || '未命名') + '」？绑过它的会话会自动回落到默认人格。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    draftPersonas.splice(index, 1)
    await savePatch({ personas: draftPersonas }, '已删除')
  })
  del.appendChild(delBtn)
  body.appendChild(del)

  wrap.appendChild(body)
  wrap.addEventListener('toggle', notifyResize)
  return wrap
}
`
