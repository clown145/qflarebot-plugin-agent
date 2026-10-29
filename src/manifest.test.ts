import { describe, expect, it } from 'vitest'
import { extractPluginManifest } from '@qqbot/plugin-cli'
import declared from '../manifest.json'

/**
 * 仓库里的 `manifest.json` 必须与源码一致。
 *
 * 这是安装与构建的**声明文件**：面板读它做预检（权限、命令重名、依赖、DO 类），
 * 构建机读它、与源码编译出的清单比对，不一致就**直接构建失败**
 * （线上保持旧版本，用户看到的是「声明清单与源码不一致（字段：xxx）」）。
 *
 * 所以每次改 `src/index.ts` 里的 commands / events / routes / cron / ui，
 * 都必须重跑 `npm run build && npm run sync` 并把新的 manifest.json 提交进来。
 * 上一版就是改了 routes（新增 /api/settings）之后忘了 sync，导致线上构建失败。
 *
 * 这条测试把这件事变成能拦住的错误：忘记 sync 时本地 `npm test` 直接失败，
 * 而不是等用户去面板上撞一个看不懂的构建错误。
 *
 * 注意：这里 import 的是**仓库根目录**那份（`../manifest.json`），不是
 * `dist/manifest.json`——后者是构建产物、被 gitignore，正好不会替我们掩盖问题。
 */
describe('manifest.json 与源码一致', () => {
  /** 这些字段构建机会校验，必须逐字段对得上 */
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
    // 用仓库自己的构建工具抽一遍，与构建机做的事完全相同
    const built = (await extractPluginManifest()) as unknown as Record<string, unknown>
    const committed = declared as unknown as Record<string, unknown>

    const mismatched = COMPARED.filter(
      (key) => JSON.stringify(committed[key]) !== JSON.stringify(built[key]),
    )

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
