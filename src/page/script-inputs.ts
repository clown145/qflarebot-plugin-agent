/**
 * 输入控件：列表值、结构化编辑器
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const SCRIPT_INPUTS = `
/* ---------------------------------------------------------------- 列表值输入 */

/**
 * 逐条输入的列表控件（对标 QListInput）：回车新增、空行退格删掉、
 * 粘贴多行自动拆开。对外仍是 string[]。
 */
function createListInput(container, values, onChange, placeholder = '输入后回车') {
  container.innerHTML = ''

  const current = () => [...container.querySelectorAll('.chip')].map((c) => c.firstChild.textContent)

  const addChip = (value) => {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.textContent = value
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', '删除 ' + value)
    remove.addEventListener('click', () => {
      chip.remove()
      onChange(current())
    })
    chip.appendChild(remove)
    container.insertBefore(chip, container.querySelector('input'))
  }

  const input = document.createElement('input')
  input.placeholder = placeholder
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const value = input.value.trim()
      if (value) {
        addChip(value)
        input.value = ''
        onChange(current())
      }
    } else if (e.key === 'Backspace' && !input.value) {
      const chips = container.querySelectorAll('.chip')
      chips[chips.length - 1]?.remove()
      onChange(current())
    }
  })
  input.addEventListener('change', () => {
    const parts = input.value.split(/[,，\\s]+/).map((s) => s.trim()).filter(Boolean)
    if (parts.length > 1) {
      for (const part of parts) addChip(part)
      input.value = ''
      onChange(current())
    }
  })
  container.appendChild(input)
  for (const value of values) addChip(value)
}

/* ---------------------------------------------------------------- 结构化的值编辑器 */

/**
 * 换行符常量。
 *
 * **必须这样写**：本文件是 TS 模板字符串，直接在页面脚本里写 '\n' 会在**构建时**
 * 被求值成真的换行符，浏览器收到的就变成跨行的非法字符串字面量，整段脚本
 * SyntaxError、页面全白。这个坑已经踩过两次（技能编辑器、这里）。
 */
const NEWLINE = String.fromCharCode(10)

/**
 * 解析「user: … / assistant: …」文本 → 成对数组。
 *
 * 存储格式不变（还是那段文本），只是**编辑方式**从「手打前缀」换成界面上的成对输入。
 * 老配置里那些手写的行能原样读出来，不需要迁移。
 */
function parseDialogText(text) {
  const pairs = []
  let current = null
  for (const raw of String(text ?? '').split(NEWLINE)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(user|assistant|系统|助手)\s*[:：]\s*(.*)$/i.exec(line)
    const role = match
      ? (match[1].toLowerCase() === 'assistant' || match[1] === '助手' ? 'assistant' : 'user')
      : 'user'
    const content = match ? match[2].trim() : line
    if (!content) continue
    if (role === 'user') {
      current = { user: content, assistant: '' }
      pairs.push(current)
    } else if (current && !current.assistant) {
      current.assistant = content
    } else {
      // 连续两条 assistant（或开头就是 assistant）：补一个空的 user 占位，
      // 序列化时会跳过空行，所以不会往存储里写脏数据
      current = { user: '', assistant: content }
      pairs.push(current)
    }
  }
  return pairs
}

/** 成对数组 → 存储文本。空的半对直接跳过（AstrBot 要求成对出现） */
function serializeDialogPairs(pairs) {
  const lines = []
  for (const pair of pairs) {
    if (!pair.user.trim() || !pair.assistant.trim()) continue
    lines.push('user: ' + pair.user.trim())
    lines.push('assistant: ' + pair.assistant.trim())
  }
  return lines.join(NEWLINE)
}

/**
 * 开场对话编辑器：一行一对「用户说 / 角色说」。
 *
 * 用户不需要知道 user: 这种存储格式——那是实现细节。
 */
function createDialogPairs(pairs, onChange) {
  const wrap = document.createElement('div')
  wrap.className = 'field'
  wrap.style.marginTop = 'var(--qb-space-2)'

  const label = document.createElement('label')
  label.textContent = '开场对话（锚定说话风格，每轮都会带上）'
  wrap.appendChild(label)

  const list = document.createElement('div')
  list.style.display = 'grid'
  list.style.gap = 'var(--qb-space-2)'
  wrap.appendChild(list)

  let current = pairs.map((pair) => ({ ...pair }))

  const commit = () => onChange(current)
  const rerender = () => {
    list.innerHTML = ''
    current.forEach((pair, i) => {
      // 一对 = 一个小卡片，**用户一行、角色一行**。
      //
      // 之前是「用户 [输入] 角色 [输入] ×」排成一行，用 grid 的 auto 列放标签。
      // 窄屏下 auto 列被压缩，标签会溢出到前一个输入框的边框上（看着像重叠）。
      // 改成一列两行后，任何宽度都不会挤，而且阅读顺序就是对话顺序。
      const group = document.createElement('div')
      group.style.border = '1px solid var(--qb-border)'
      group.style.borderRadius = 'var(--qb-radius)'
      group.style.padding = 'var(--qb-space-2)'
      group.style.display = 'grid'
      group.style.gap = 'var(--qb-space-2)'

      const line = (role, placeholder, value, tone) => {
        const row = document.createElement('div')
        row.style.display = 'flex'
        row.style.gap = 'var(--qb-space-2)'
        row.style.alignItems = 'center'
        row.style.minWidth = '0'

        const tag = document.createElement('span')
        tag.className = 'badge' + (tone ? ' ' + tone : '')
        tag.style.flexShrink = '0'
        tag.style.minWidth = '3rem'
        tag.style.justifyContent = 'center'
        tag.textContent = role
        row.appendChild(tag)

        const input = document.createElement('input')
        input.className = 'qb-input'
        input.placeholder = placeholder
        input.value = value
        input.style.minWidth = '0'
        input.addEventListener('input', () => {
          if (role === '用户') current[i].user = input.value
          else current[i].assistant = input.value
          commit()
        })
        row.appendChild(input)
        return row
      }

      group.appendChild(line('用户', '你好', pair.user, ''))
      group.appendChild(line('角色', '你好呀～', pair.assistant, 'badge--accent'))

      // 删除按钮单独一行右对齐，不和数据行抢宽度
      const foot = document.createElement('div')
      foot.style.display = 'flex'
      foot.style.justifyContent = 'flex-end'
      const del = document.createElement('button')
      del.className = 'qb-btn'
      del.type = 'button'
      del.textContent = '删除这一对'
      del.addEventListener('click', () => {
        current.splice(i, 1)
        commit()
        rerender()
        notifyResize()
      })
      foot.appendChild(del)
      group.appendChild(foot)

      list.appendChild(group)
    })
  }

  const addBtn = document.createElement('button')
  addBtn.className = 'qb-btn'
  addBtn.type = 'button'
  addBtn.textContent = '新增一对'
  addBtn.style.marginTop = 'var(--qb-space-2)'
  addBtn.style.justifySelf = 'start'
  addBtn.addEventListener('click', () => {
    current.push({ user: '', assistant: '' })
    commit()
    rerender()
    notifyResize()
  })
  wrap.appendChild(addBtn)

  rerender()
  return wrap
}

/**
 * 多选清单：从**已知清单**里勾选，而不是让用户手打名字。
 *
 * 手打名字必然拼错（time.now / time now / Time.now），而且用户不知道
 * 系统里到底有哪些可用。留空 = 不限（语义由 persona.tools / persona.skills 定义）。
 */
function createCheckList(title, options, selected, onChange, hint) {
  const wrap = document.createElement('div')
  wrap.className = 'field'
  wrap.style.marginTop = 'var(--qb-space-3)'

  const label = document.createElement('label')
  label.textContent = title
  wrap.appendChild(label)

  const hintEl = document.createElement('p')
  hintEl.className = 'qb-muted'
  hintEl.style.fontSize = 'var(--qb-text-xs)'
  hintEl.style.margin = '0 0 var(--qb-space-2)'
  hintEl.textContent = hint
  wrap.appendChild(hintEl)

  const box = document.createElement('div')
  box.style.display = 'flex'
  box.style.flexWrap = 'wrap'
  box.style.gap = 'var(--qb-space-2)'

  const chosen = new Set(selected ?? [])

  if (!options.length) {
    const empty = document.createElement('p')
    empty.className = 'qb-muted'
    empty.style.fontSize = 'var(--qb-text-xs)'
    empty.style.margin = '0'
    empty.textContent = '（这里还没有可选项）'
    box.appendChild(empty)
  }

  for (const option of options) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'qb-btn'
    chip.style.fontFamily = 'var(--qb-font-mono)'
    chip.style.fontSize = 'var(--qb-text-xs)'
    chip.textContent = option.label
    const sync = () => {
      const on = chosen.has(option.value)
      chip.style.background = on ? 'var(--qb-primary)' : ''
      chip.style.color = on ? 'var(--qb-on-primary)' : ''
      chip.setAttribute('aria-pressed', String(on))
    }
    sync()
    chip.addEventListener('click', () => {
      if (chosen.has(option.value)) chosen.delete(option.value)
      else chosen.add(option.value)
      sync()
      onChange([...chosen])
    })
    box.appendChild(chip)
  }

  wrap.appendChild(box)
  return wrap
}
`
