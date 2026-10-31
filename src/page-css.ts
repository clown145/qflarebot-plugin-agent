/**
 * 管理页自有样式。
 *
 * **原则：能省则省。** 宿主 `/tokens.css` 已经提供 `.qb-page` / `.qb-card` /
 * `.qb-btn` / `.qb-input` / `.qb-muted` / `.qb-mono`，官方插件 t2i 只写了 16 行
 * 自有 CSS。这里只补宿主没提供、而本页需要的几样（页内标签、开关、徽标、
 * 骨架屏、空状态、确认框、toast、结构化编辑器）。
 *
 * 所有值一律走 `--qb-*` 变量，不写死颜色。用错变量名会**静默回退成空值**，
 * 那块样式直接消失且不报错 —— `page-tokens.test.ts` 守这条。
 */
export const PAGE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  /* ============================================================
     自有样式：能省则省。宿主 .qb-* 覆盖了底色、字体、卡片、按钮、输入框，
     这里只补宿主没提供、而本页需要的几样（标签条、开关、徽标、骨架屏、空状态）。
     所有值一律走 --qb-* 变量，不写死颜色。
     ============================================================ */

  /* 内容区：规范要求最宽 1152px 居中 */
  .wrap {
    max-width: 1152px;
    margin-inline: auto;
    padding: var(--qb-space-5) var(--qb-space-4);
    padding-left: max(var(--qb-space-4), env(safe-area-inset-left));
    padding-right: max(var(--qb-space-4), env(safe-area-inset-right));
  }
  @media (min-width: 768px) {
    .wrap { padding: var(--qb-space-8) var(--qb-space-6); }
  }

  /* 页头 */
  .page-head { margin-bottom: var(--qb-space-5); }
  .page-title {
    margin: 0;
    font-size: var(--qb-text-2xl);
    line-height: 1.2;
    font-weight: 650;
  }
  .page-sub {
    margin: var(--qb-space-1) 0 0;
    font-size: var(--qb-text-base);
    color: var(--qb-fg-muted);
  }

  /* ---------- 页内标签（对标 QSegmented） ----------
     选中块用 transform 滑动而不是换背景色，与面板动效一致 */
  .segmented {
    position: relative;
    display: flex;
    gap: 2px;
    margin-top: max(var(--qb-space-4), env(safe-area-inset-top));
    padding: 3px;
    overflow-x: auto;
    border-radius: var(--qb-radius-full);
    background: var(--qb-surface-muted);
    scrollbar-width: none;
  }
  .segmented::-webkit-scrollbar { display: none; }
  .seg-btn {
    position: relative;
    z-index: 1;
    flex: 0 0 auto;
    height: var(--qb-control-height);
    padding: 0 var(--qb-space-4);
    border: 0;
    border-radius: var(--qb-radius-full);
    background: transparent;
    color: var(--qb-fg-muted);
    font: inherit;
    font-size: var(--qb-text-sm);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: color var(--qb-duration) var(--qb-ease);
  }
  .seg-btn:hover { color: var(--qb-fg); }
  .seg-btn[aria-selected='true'] { color: var(--qb-fg); font-weight: 600; }
  .seg-thumb {
    position: absolute;
    top: 3px;
    bottom: 3px;
    border-radius: var(--qb-radius-full);
    background: var(--qb-surface);
    box-shadow: var(--qb-nav-active-shadow);
    transition:
      transform var(--qb-duration-slow) var(--qb-ease-out),
      width var(--qb-duration-slow) var(--qb-ease-out);
    will-change: transform, width;
    pointer-events: none;
  }

  /* ---------- 卡片：直接用宿主 .qb-card，只补标题区 ---------- */
  .stack { display: grid; gap: var(--qb-space-4); }
  /* 标题与操作按钮：窄屏换行，避免按钮被挤出屏幕 */
  .card-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--qb-space-2) var(--qb-space-3);
    margin-bottom: var(--qb-space-2);
  }
  .card-head > div:first-child { flex: 1 1 12rem; min-width: 0; }
  .card-title {
    margin: 0;
    font-size: var(--qb-text-base);
    font-weight: 600;
  }
  .card-desc {
    margin: var(--qb-space-1) 0 0;
    font-size: var(--qb-text-xs);
    color: var(--qb-fg-muted);
  }
  .card-actions {
    display: flex;
    flex-wrap: wrap;
    flex-shrink: 0;
    gap: var(--qb-space-2);
    align-items: center;
  }

  /* 卡片内的一行一项，行间一条分隔线（对标 QCard 的 divide-y） */
  .rows { display: grid; }
  .rows > * + * { border-top: 1px solid var(--qb-border); }

  /* ---------- 设置行（对标 QSettingRow） ----------
     左标题+说明，右控件；窄屏上下排 */
  .setting-row {
    display: flex;
    flex-direction: column;
    gap: var(--qb-space-3);
    padding: var(--qb-space-4) 0;
  }
  .setting-row:first-child { padding-top: 0; }
  .setting-row:last-child { padding-bottom: 0; }
  @media (min-width: 640px) {
    .setting-row {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: var(--qb-space-8);
    }
  }
  .setting-text { min-width: 0; }
  @media (min-width: 640px) { .setting-text { max-width: 30rem; } }
  .setting-label {
    margin: 0;
    font-size: var(--qb-text-base);
    font-weight: 500;
  }
  .setting-hint {
    margin: var(--qb-space-1) 0 0;
    font-size: var(--qb-text-xs);
    color: var(--qb-fg-muted);
  }
  .setting-control {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--qb-space-2);
  }

  /* ---------- 开关（对标 QSwitch） ----------
     视觉 20px，点击热区补到 44px；按住时圆钮拉长 */
  .switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .switch:disabled { cursor: not-allowed; opacity: 0.5; }
  .switch-track {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    border-radius: var(--qb-radius-full);
    background: var(--qb-border-strong);
    transition: background-color var(--qb-duration-slow) var(--qb-ease);
  }
  .switch[aria-checked='true'] .switch-track { background: var(--qb-accent); }
  .switch-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
    transition:
      transform var(--qb-duration-slow) var(--qb-ease-spring),
      width var(--qb-duration-slow) var(--qb-ease-spring);
  }
  .switch[aria-checked='true'] .switch-knob { transform: translateX(16px); }
  .switch:not(:disabled):active .switch-knob { width: 20px; }
  .switch:not(:disabled)[aria-checked='true']:active .switch-knob { transform: translateX(12px); }

  /* ---------- 徽标（对标 QBadge） ---------- */
  .badge {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 var(--qb-space-2);
    border-radius: var(--qb-radius-full);
    font-size: var(--qb-text-xs);
    font-weight: 500;
    white-space: nowrap;
    background: var(--qb-surface-muted);
    color: var(--qb-fg-muted);
  }
  .badge--success { background: var(--qb-success-bg); color: var(--qb-success); }
  .badge--warning { background: var(--qb-warning-bg); color: var(--qb-warning); }
  .badge--danger { background: var(--qb-danger-bg); color: var(--qb-danger); }
  .badge--accent { background: var(--qb-primary); color: var(--qb-on-primary); }

  /* ---------- 列表项（工具、技能） ---------- */
  .item {
    display: flex;
    align-items: flex-start;
    gap: var(--qb-space-3);
    padding: var(--qb-space-3);
    border: 1px solid var(--qb-border);
    border-radius: var(--qb-radius);
    background: var(--qb-surface);
  }
  .item + .item { margin-top: var(--qb-space-2); }
  .item-main { flex: 1; min-width: 0; }
  .item-name {
    font-family: var(--qb-font-mono);
    font-size: var(--qb-text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .item-title { font-size: var(--qb-text-sm); font-weight: 600; }
  .item-meta {
    margin-top: 2px;
    font-size: var(--qb-text-xs);
    color: var(--qb-fg-muted);
    overflow-wrap: anywhere;
  }
  .item-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--qb-space-1);
    margin-top: var(--qb-space-2);
  }
  .item.is-off { opacity: 0.55; }
  .item.is-off .item-name,
  .item.is-off .item-title { text-decoration: line-through; }

  /* ---------- 表格 ---------- */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--qb-text-sm); }
  th, td {
    padding: var(--qb-space-2) var(--qb-space-3);
    text-align: left;
    border-bottom: 1px solid var(--qb-border);
    overflow-wrap: anywhere;
  }
  th {
    font-size: var(--qb-text-xs);
    font-weight: 500;
    color: var(--qb-fg-muted);
  }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }

  /* ---------- 空状态（对标 QEmpty） ---------- */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--qb-space-1);
    padding: var(--qb-space-8) var(--qb-space-4);
    text-align: center;
    border: 1px dashed var(--qb-border-strong);
    border-radius: var(--qb-radius);
  }
  .empty-title {
    margin: 0;
    font-size: var(--qb-text-sm);
    font-weight: 500;
  }
  .empty-desc {
    margin: 0;
    max-width: 24rem;
    font-size: var(--qb-text-xs);
    color: var(--qb-fg-muted);
  }

  /* ---------- 骨架屏（规范：加载用骨架屏，不只放一行「加载中…」） ---------- */
  .skeleton { display: grid; gap: var(--qb-space-2); }
  .sk-line {
    height: 12px;
    border-radius: var(--qb-radius-sm);
    background: var(--qb-surface-muted);
    animation: sk-pulse 1.4s ease-in-out infinite;
  }
  .sk-line.w-40 { width: 40%; }
  .sk-line.w-60 { width: 60%; }
  .sk-line.w-80 { width: 80%; }
  @keyframes sk-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  /* ---------- 表单 ---------- */
  .field { display: grid; gap: var(--qb-space-1); }
  .field > label {
    font-size: var(--qb-text-xs);
    color: var(--qb-fg-muted);
  }
  .qb-input, .qb-textarea { width: 100%; }
  .qb-textarea {
    min-height: 5rem;
    padding: var(--qb-space-2) var(--qb-space-3);
    border: 1px solid var(--qb-border-strong);
    border-radius: var(--qb-radius);
    background: var(--qb-input);
    color: var(--qb-fg);
    font: inherit;
    font-size: var(--qb-text-sm);
    resize: vertical;
  }
  .qb-textarea:focus { outline: 2px solid var(--qb-ring); outline-offset: 1px; }
  .mono-input {
    font-family: var(--qb-font-mono);
    font-size: var(--qb-text-xs);
  }

  /* ---------- 列表值输入（对标 QListInput） ----------
     逐条回车新增、空行退格删除，对外仍是 string[] */
  .list-input {
    display: flex;
    flex-wrap: wrap;
    gap: var(--qb-space-1);
    min-height: var(--qb-control-height);
    padding: var(--qb-space-1);
    border: 1px solid var(--qb-border-strong);
    border-radius: var(--qb-radius);
    background: var(--qb-input);
  }
  .list-input:focus-within { border-color: var(--qb-accent); }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--qb-space-1);
    height: 24px;
    padding: 0 var(--qb-space-2);
    border-radius: var(--qb-radius-full);
    background: var(--qb-surface-muted);
    font-family: var(--qb-font-mono);
    font-size: var(--qb-text-xs);
  }
  .chip button {
    border: 0;
    background: transparent;
    color: var(--qb-fg-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  .chip button:hover { color: var(--qb-danger); }
  .list-input input {
    flex: 1;
    min-width: 8rem;
    border: 0;
    background: transparent;
    color: var(--qb-fg);
    font: inherit;
    font-size: var(--qb-text-xs);
    outline: 0;
  }

  /* ---------- 标签面板切换 ---------- */
  .panel { display: none; }
  .panel.is-active { display: block; }
  .panel.is-active > * { animation: rise var(--qb-duration-slow) var(--qb-ease-out) both; }
  .panel.is-active > *:nth-child(2) { animation-delay: 40ms; }
  .panel.is-active > *:nth-child(3) { animation-delay: 80ms; }
  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }

  /* ---------- toast：顶部，避开手机浏览器底部操作区 ---------- */
  .toast-wrap {
    position: fixed;
    right: var(--qb-space-4);
    top: max(var(--qb-space-4), env(safe-area-inset-top));
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: var(--qb-space-2);
    max-width: min(420px, calc(100vw - 32px));
  }
  .toast {
    padding: var(--qb-space-2) var(--qb-space-3);
    border-radius: var(--qb-radius);
    background: var(--qb-surface);
    color: var(--qb-fg);
    box-shadow: var(--qb-shadow-overlay);
    font-size: var(--qb-text-sm);
    border-left: 3px solid var(--qb-accent);
    animation: rise var(--qb-duration-slow) var(--qb-ease-out) both;
  }
  .toast.error { border-left-color: var(--qb-danger); }
  .toast.success { border-left-color: var(--qb-success); }

  /* ---------- 确认框（规范：不用浏览器 confirm） ---------- */
  .modal-mask {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: var(--qb-space-4);
    background: var(--qb-overlay);
    animation: fade var(--qb-duration-slow) var(--qb-ease) both;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    width: min(100%, 26rem);
    max-height: 90vh;
    overflow: auto;
    padding: var(--qb-space-5);
    border-radius: var(--qb-radius-xl);
    background: var(--qb-surface);
    box-shadow: var(--qb-shadow-overlay);
    animation: pop var(--qb-duration-slow) var(--qb-ease-spring) both;
  }
  @keyframes pop {
    from { opacity: 0; transform: scale(0.96) translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  .modal h3 { margin: 0 0 var(--qb-space-2); font-size: var(--qb-text-lg); }
  .modal p { margin: 0 0 var(--qb-space-4); font-size: var(--qb-text-sm); color: var(--qb-fg-muted); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--qb-space-2); }
  .qb-btn--danger { background: var(--qb-danger); color: #fff; }
  .qb-btn--danger:hover { background: var(--qb-danger); filter: brightness(0.95); }

  /* 减弱动态效果：全部关掉 */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* 长标识符不撑破容器 */
  .item-name, .item-meta, td { overflow-wrap: anywhere; }
  [hidden] { display: none !important; }
  .field-error { color: var(--qb-danger); font-size: var(--qb-text-sm); margin: var(--qb-space-2) 0 0; }
  [aria-invalid="true"] { border-color: var(--qb-danger); }
  .save-status-row { display: flex; align-items: center; gap: var(--qb-space-2); margin-top: var(--qb-space-2); font-size: var(--qb-text-sm); color: var(--qb-fg-muted); }
  .permission-field { padding: var(--qb-space-3); border: 1px solid var(--qb-border); border-radius: var(--qb-radius); }
  .permission-field > select { width: 100%; }
  @media (max-width: 767px), (pointer: coarse) {
    .qb-btn, .seg-btn, .qb-input, .chip button { min-height: 44px; }
    .chip button { min-width: 44px; }
    .modal { max-height: calc(100dvh - 32px); }
  }

`
