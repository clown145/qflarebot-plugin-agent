/**
 * Vite 的 `?raw` 导入在测试里可用，但 `tsc` 需要类型声明。
 *
 * 只声明文档类资源的 `?raw`（`src/docs-consistency.test.ts` 用），
 * 不引入 `vite/client`：本项目运行在 Worker 里，编译期只认
 * `@cloudflare/workers-types`，装 Vite 的全局类型会把 DOM 全局混进来。
 */
declare module '*.md?raw' {
  const content: string
  export default content
}
