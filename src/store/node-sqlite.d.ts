/**
 * `node:sqlite` 的最小类型声明。
 *
 * 为什么需要它：本仓库的类型环境是 `@cloudflare/workers-types`（`tsconfig.json`
 * 的 `types` 只列了它），没有 `@types/node`，所以 `tsc --noEmit` 认不出
 * `node:sqlite`。而存储层的测试**必须**跑真实 SQL——手写内存假件会自己把
 * 「应该有的行为」实现一遍（比如自己算 parent、把 LIKE 转成 startsWith），
 * 于是真实 SQL 上的 bug 永远测不出来（见 src/tools/vfs/store.test.ts 的历史）。
 *
 * 只声明测试用到的那一小块 API：Node 22 的 `node:sqlite` 是实验特性，
 * 完整类型会随版本漂移，声明多了反而容易和运行时对不上。
 *
 * 注意：这是**测试专用**声明，生产代码不 import `node:sqlite`
 * （Worker 里没有这个模块，用了会在部署时炸）。
 */
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }

  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }

  export interface DatabaseSyncOptions {
    open?: boolean
    readOnly?: boolean
    enableForeignKeyConstraints?: boolean
    enableDoubleQuotedStringLiterals?: boolean
    allowExtension?: boolean
  }

  export class DatabaseSync {
    constructor(location?: string, options?: DatabaseSyncOptions)
    open(): void
    close(): void
    isOpen(): boolean
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}
