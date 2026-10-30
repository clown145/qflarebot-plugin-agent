/**
 * 插件管理页的 HTML 外壳。样式与脚本分文件维护，最终拼成一个 HTML 字符串。
 *
 * ## 为什么拆文件
 *
 * 单文件一度涨到 2483 行（CSS 449 + HTML 427 + JS 1566），
 * 官方插件 t2i 的页面只有 115 行。这么大的文件有三个实际问题：
 * 改一处要滚很远、review 时看不出改动意图、多人同时改必然冲突。
 *
 * 现在按职责拆开，各自控制在合理规模：
 *
 * ```text
 * page.ts              组装（本文件）
 * page-css.ts          自有样式（宿主 .qb-* 之外的部分）
 * page-html.ts         结构
 * page/
 *   script-core.js     工具函数、请求、共享状态
 *   script-shell.js    桥、确认框、页内标签、开关
 *   script-inputs.js   列表值输入、结构化编辑器
 *   view-persona.js    模型与人格
 *   view-tools.js      工具与工具配置弹窗
 *   view-skills.js     技能
 *   view-data.js       表格与配置表单
 *   boot.js            加载、动作、事件绑定、启动
 * ```
 *
 * ## 拼装方式
 *
 * 所有 JS 片段是**同一作用域里的顺序拼接**（拼成一个 `<script type="module">`），
 * 不是 ES module —— 它们共享 `bridge` / `state` / `$` 这些变量。改用真正的 module
 * 需要引入 import/export 并处理加载顺序，而这里只有 8 个文件，且 `bridge` 是在
 * 脚本顶层 `await import()` 拿到的，用 module 反而更绕。
 *
 * 代价是变量落在模块作用域里而非严格隔离——但页面跑在 sandbox iframe 里
 * （opaque origin），不与面板共享作用域，所以这是可接受的。
 */
import { PAGE_CSS } from './page-css.js'
import { PAGE_HTML_BODY } from './page-html.js'
import { PAGE_SCRIPT } from './page/script.js'

export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent</title>
<link rel="stylesheet" href="/tokens.css" />
<style>
${PAGE_CSS}
</style>
</head>
<body class="qb-page">
${PAGE_HTML_BODY}
<script type="module">
${PAGE_SCRIPT}
</script>
</body>
</html>
`
