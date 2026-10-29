import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from './page.js'

/**
 * 设计 token 白名单校验。
 *
 * 为什么必须守这一条：宿主 tokens.css 里的变量**全部**带 `--qb-` 前缀，
 * 用错名字（比如写过 `--qb-text-md`，而宿主只有 `--qb-text-base`）时，
 * CSS 变量会**静默回退成空值** —— 那一块样式直接消失，页面看起来"塌了"，
 * 而浏览器控制台不会报错、tsc 也看不见（它只是一段字符串）。
 *
 * 上一轮就踩过：`--qb-text-md` 和 `--qb-accent-muted` 都不存在。
 */
describe('只用宿主真实存在的设计 token', () => {
  /** 与 packages/ui/public/tokens.css 保持同步（宿主新增 token 时在这里补） */
  const KNOWN = new Set<string>([
    '--qb-accent',
    '--qb-bg',
    '--qb-bg-glow',
    '--qb-border',
    '--qb-border-strong',
    '--qb-brand',
    '--qb-card-border',
    '--qb-control-height',
    '--qb-danger',
    '--qb-danger-bg',
    '--qb-duration',
    '--qb-duration-slow',
    '--qb-duration-slower',
    '--qb-ease',
    '--qb-ease-out',
    '--qb-ease-spring',
    '--qb-fg',
    '--qb-fg-muted',
    '--qb-fg-subtle',
    '--qb-font-mono',
    '--qb-font-sans',
    '--qb-glass',
    '--qb-glass-blur',
    '--qb-glass-border',
    '--qb-input',
    '--qb-leading',
    '--qb-nav-active',
    '--qb-nav-active-shadow',
    '--qb-nav-hover',
    '--qb-on-accent',
    '--qb-on-primary',
    '--qb-overlay',
    '--qb-primary',
    '--qb-primary-hover',
    '--qb-radius',
    '--qb-radius-full',
    '--qb-radius-lg',
    '--qb-radius-sm',
    '--qb-radius-xl',
    '--qb-ring',
    '--qb-row-height',
    '--qb-shadow',
    '--qb-shadow-hover',
    '--qb-shadow-overlay',
    '--qb-space-1',
    '--qb-space-2',
    '--qb-space-3',
    '--qb-space-4',
    '--qb-space-5',
    '--qb-space-6',
    '--qb-space-8',
    '--qb-success',
    '--qb-success-bg',
    '--qb-surface',
    '--qb-surface-muted',
    '--qb-text-2xl',
    '--qb-text-base',
    '--qb-text-lg',
    '--qb-text-sm',
    '--qb-text-xl',
    '--qb-text-xs',
    '--qb-touch-min',
    '--qb-warning',
    '--qb-warning-bg',
  ])

  it('页面里所有 var(--qb-*) 都在白名单里', () => {
    const used = [...PAGE_HTML.matchAll(/var\((--qb-[a-z0-9-]+)/g)].map((m) => m[1]!)
    const unknown = [...new Set(used)].filter((name) => !KNOWN.has(name))
    expect(unknown, '这些 token 宿主没有，会静默回退成空值').toEqual([])
  })

  it('白名单不是空的且覆盖了常用 token', () => {
    expect(KNOWN.size).toBeGreaterThan(50)
    for (const must of ['--qb-fg', '--qb-bg', '--qb-surface', '--qb-border', '--qb-accent']) {
      expect(KNOWN.has(must)).toBe(true)
    }
  })
})
