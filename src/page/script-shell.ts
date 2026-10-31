/**
 * 外壳：桥接、确认框、页内标签、开关
 *
 * **这是浏览器要执行的纯 JS**，放在 TS 模板字符串里导出。
 * 不要在这里写 TypeScript 类型注解 —— 构建时不会剥离，浏览器拿到会语法错误。
 * 片段由 `src/page/script.ts` 按顺序拼装，共享同一作用域（见那里的说明）。
 */
export const SCRIPT_SHELL = `
/* ---------------------------------------------------------------- 桥 */

let bridge = null
try {
  const mod = await import('/bridge.js')
  bridge = await mod.createBridge()
  bridge.setTitle?.('Agent')
} catch {
  // 不在面板里打开时没有桥，退化成直接 fetch
}

/**
 * 保留高度上报以兼容旧版面板；新版面板让 iframe 独占剩余视口。
 */
function notifyResize() {
  requestAnimationFrame(() => {
    try {
      bridge?.resize?.()
    } catch {
      /* 桥不可用时忽略 */
    }
  })
}

function notify(message, level = 'info') {
  if (bridge?.embedded && bridge?.toast) {
    bridge.toast(message, level)
    return
  }
  let wrap = document.querySelector('.toast-wrap')
  if (!wrap) {
    wrap = document.createElement('div')
    wrap.className = 'toast-wrap'
    document.body.appendChild(wrap)
  }
  const item = document.createElement('div')
  item.className = 'toast ' + level
  item.textContent = message
  item.setAttribute('role', level === 'error' ? 'alert' : 'status')
  wrap.appendChild(item)
  setTimeout(() => item.remove(), 3600)
}

/* ---------------------------------------------------------------- 确认框 */

/**
 * 把焦点困在对话框里（规范要求：「对话框和抽屉能用 Esc 关、焦点困在里面」）。
 *
 * 为什么必须做：页面在 iframe 里，Tab 键跑出对话框后会落到后面的表单上，
 * 用户看不出焦点在哪，回车可能误触后面的按钮。确认框尤其危险 ——
 * 焦点跑到「删除」上再按回车就真删了。
 *
 * 返回一个解除函数，关闭对话框时调用。
 */
const modalStack = []
function trapFocus(container) {
  modalStack.push(container)
  const background = [...document.body.children].filter((el) => el !== container).map((el) => [el, el.inert])
  for (const [el] of background) el.inert = true
  const FOCUSABLE = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'a[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  const previous = document.activeElement

  const onKey = (e) => {
    if (e.key !== 'Tab' || modalStack.at(-1) !== container) return
    const items = [...container.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    // 只在边界处拦截：中间的正常 Tab 不必干预
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  document.addEventListener('keydown', onKey)
  return () => {
    document.removeEventListener('keydown', onKey)
    modalStack.splice(modalStack.indexOf(container), 1)
    for (const [el, inert] of background) el.inert = inert
    // 还给打开前的元素，键盘用户不会「丢了位置」
    if (previous && typeof previous.focus === 'function') previous.focus()
  }
}

/** 自绘确认框（规范：不用浏览器 confirm）。危险操作红按钮、默认聚焦取消、Esc 可关 */
function confirmAction({ title, text, confirmText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
        '<h3>' + esc(title) + '</h3>' +
        '<p>' + esc(text) + '</p>' +
        '<div class="modal-actions">' +
          '<button class="qb-btn" data-act="cancel" type="button">' + esc(cancelText) + '</button>' +
          '<button class="qb-btn ' + (danger ? 'qb-btn--danger' : 'qb-btn--primary') + '" data-act="ok" type="button">' +
            esc(confirmText) +
          '</button>' +
        '</div>' +
      '</div>'

    const releaseFocus = trapFocus(mask)
    const close = (result) => {
      document.removeEventListener('keydown', onKey)
      releaseFocus()
      mask.remove()
      resolve(result)
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && modalStack.at(-1) === mask) { e.preventDefault(); e.stopImmediatePropagation(); close(false) }
    }
    mask.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act
      if (act === 'ok') close(true)
      else if (act === 'cancel' || e.target === mask) close(false)
    })
    document.addEventListener('keydown', onKey)
    document.body.appendChild(mask)
    mask.querySelector('[data-act="cancel"]')?.focus()
  })
}

/* ---------------------------------------------------------------- 标签 */

const TABS = ['model', 'behavior', 'tools', 'skills', 'data']
let currentTab = 'model'

function applyTab(name, animate = true) {
  const tab = TABS.includes(name) ? name : 'model'
  currentTab = tab

  for (const panel of document.querySelectorAll('.panel')) {
    const active = panel.dataset.panel === tab
    panel.classList.toggle('is-active', active)
    panel.hidden = !active
    if (active && animate) {
      for (const child of panel.children) {
        child.style.animation = 'none'
        void child.offsetWidth
        child.style.animation = ''
      }
    }
  }
  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === tab))
    btn.tabIndex = btn.dataset.tab === tab ? 0 : -1
  }
  moveThumb()
  try { if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab) } catch { /* opaque iframe */ }
  notifyResize()
}

/** 选中块滑到当前标签下面（对标 QSegmented） */
function moveThumb() {
  const thumb = $('segThumb')
  const active = document.querySelector('.seg-btn[aria-selected="true"]')
  if (!thumb || !active) return
  thumb.hidden = false
  thumb.style.width = active.offsetWidth + 'px'
  thumb.style.transform = 'translateX(' + active.offsetLeft + 'px)'
}

function initTabs() {
  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => applyTab(btn.dataset.tab))
    btn.addEventListener('keydown', (event) => {
      const index = TABS.indexOf(btn.dataset.tab)
      const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1
      if (next < 0) return
      event.preventDefault()
      applyTab(TABS[next])
      $('tab-' + TABS[next]).focus()
    })
  }
  const fromHash = location.hash.slice(1)
  applyTab(TABS.includes(fromHash) ? fromHash : 'model', false)
  window.addEventListener('resize', moveThumb)
  // 字体加载完宽度会变，重新定位一次
  document.fonts?.ready?.then(moveThumb)
}

/* ---------------------------------------------------------------- 开关 */

function setSwitch(el, on) {
  el.setAttribute('aria-checked', String(Boolean(on)))
}
const switchOn = (el) => el.getAttribute('aria-checked') === 'true'

function labelControls() {
  for (const row of document.querySelectorAll('.setting-row')) {
    const label = row.querySelector('.setting-label')
    const control = row.querySelector('input, select, textarea')
    if (!label || !control) continue
    label.id ||= 'label-' + (++fieldSeed)
    control.setAttribute('aria-labelledby', label.id)
    const hint = row.querySelector('.setting-hint')
    if (hint) { hint.id ||= 'hint-' + (++fieldSeed); control.setAttribute('aria-describedby', hint.id) }
  }
  for (const [id, name] of [['toolSearch', '搜索工具'], ['skillSearch', '搜索技能'], ['convSearch', '搜索会话']]) $(id).setAttribute('aria-label', name)
}

`
