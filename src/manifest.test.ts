import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractPluginManifest } from '@qqbot/plugin-cli'

/**
 * 仓库里的 `manifest.json` 必须与源码一致。
 *
 * 这是安装与构建的**声明文件**：面板读它做预检（权限、命令重名、依赖、DO 类），
 * 构建机读它和源码编译出来的清单比对，不一致就**直接构建失败**
 * （线上保持旧版本，用户看到的是「声明清单与源码不一致（字段：xxx）」）。
 *
 * 所以每次改 `src/index.ts` 里的 commands / events / routes / cron / ui，
 * 都必须重跑 `npm run build && npm run sync` 并把新的 manifest.json 提交进来。
 * 上一版就是改了 routes（新增 /api/settings）之后忘了 sync，导致线上构建失败。
 *
 * 这条测试把这件事变成 CI 能拦住的错误：忘记 sync 时本地 `npm test` 直接失败，
 * 而不是等用户去面板上撞一个看不懂的构建错误。
 */
describe('manifest.json 与源码一致', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))

  /** 只比对会被构建机校验的字段；跳过 version（由 package.json 补）等无关项 */
  const COMPARED = [
    'name',
    'apiVersion',
    'permissions',
    'depends',
    'conflicts',
    'commands',
    'regex',
    'events',
    'buttons',
    'cron',
    'routes',
    'ui',
    'hasMiddleware',
    'services',
    'durableObjects',
    'configSchema',
    'defaultConfig',
  ] as const

  it('仓库根目录的 manifest.json 与源码抽取结果逐字段一致', async () => {
    const declared = JSON.parse(await readFile(`${repoRoot}/manifest.json`, 'utf8')) as Record<string, unknown>

    // 用仓库自己那套 SDK/构建工具抽一遍，与构建机做的事完全相同
    const built = (await extractPluginManifest({ cwd: repoRoot })) as unknown as Record<string, unknown>

    const mismatched: string[] = []
    for (const key of COMPARED) {
      if (JSON.stringify(declared[key]) !== JSON.stringify(built[key])) mismatched.push(key)
    }

    expect(
      mismatched,
      mismatched.length
        ? `manifest.json 与源码不一致（字段：${mismatched.join('、')}）。` +
          '改过 src/index.ts 的 commands/events/routes/cron 之后，请运行 ' +
          '`npm run build && npm run sync` 并提交新的 manifest.json。'
        : '',
    ).toEqual([])
  })
})
