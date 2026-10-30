/**
 * 渲染：技能
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const VIEW_SKILLS = `
/* ---------------------------------------------------------------- 渲染：技能 */

function renderSkills() {
  const all = state.skills ?? []
  const keyword = ($('skillSearch').value ?? '').trim().toLowerCase()
  const list = keyword
    ? all.filter(
        (s) =>
          s.id.toLowerCase().includes(keyword) ||
          (s.name ?? '').toLowerCase().includes(keyword) ||
          (s.description ?? '').toLowerCase().includes(keyword),
      )
    : all

  $('skillCount').textContent = all.length ? '（' + all.length + '）' : ''

  const box = $('skillList')
  box.innerHTML = ''
  if (!all.length) {
    box.innerHTML =
      '<div class="empty">' +
        '<p class="empty-title">还没有技能</p>' +
        '<p class="empty-desc">技能能把反复交代的做事流程固定下来，不用每轮都塞进系统提示词。</p>' +
      '</div>'
    notifyResize()
    return
  }
  if (!list.length) {
    box.innerHTML =
      '<div class="empty">' +
        '<p class="empty-title">没有匹配的技能</p>' +
        '<p class="empty-desc">试试别的关键词。</p>' +
      '</div>'
    notifyResize()
    return
  }

  for (const skill of list) {
    const item = document.createElement('div')
    item.className = 'item'

    const main = document.createElement('div')
    main.className = 'item-main'

    const title = document.createElement('div')
    title.className = 'item-title'
    title.textContent = skill.name || skill.id
    main.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'item-meta'
    meta.textContent = skill.id + (skill.description ? ' · ' + skill.description : '')
    main.appendChild(meta)

    item.appendChild(main)

    const actions = document.createElement('div')
    actions.style.display = 'flex'
    actions.style.gap = 'var(--qb-space-2)'
    actions.style.flexShrink = '0'

    const editBtn = document.createElement('button')
    editBtn.className = 'qb-btn'
    editBtn.type = 'button'
    editBtn.textContent = '编辑'
    editBtn.addEventListener('click', () => void openSkillEditor(skill.id))

    const delBtn = document.createElement('button')
    delBtn.className = 'qb-btn'
    delBtn.type = 'button'
    delBtn.textContent = '删除'
    delBtn.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: '删除技能',
        text: '确定删除「' + (skill.name || skill.id) + '」？',
        confirmText: '删除',
        danger: true,
      })
      if (!ok) return
      try {
        await request('/api/skills/' + encodeURIComponent(skill.id), { method: 'DELETE' })
        notify('已删除', 'success')
        await load()
      } catch (e) {
        notify('删除失败：' + e.message, 'error')
      }
    })

    actions.appendChild(editBtn)
    actions.appendChild(delBtn)
    item.appendChild(actions)
    box.appendChild(item)
  }
  notifyResize()
}
`
