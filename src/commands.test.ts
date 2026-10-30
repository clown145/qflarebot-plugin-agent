import { describe, expect, it } from 'vitest'
import plugin from './index.js'
import { PLUGIN_COMMANDS, PLUGIN_COMMAND_ALIASES, isPluginCommand } from './agent/commands.js'

/**
 * 指令集的一致性契约。
 *
 * 对标 AstrBot 的 `/help`：它从**实时指令配置**生成清单，天然不会和实际
 * 注册的命令脱节。我们没有指令管理，help 是手写清单 —— 所以用测试守住
 * 「清单和实际注册的命令一致」这件事，否则加了命令忘了更新帮助，
 * 用户就永远不知道有那个命令。
 */

/** 实际注册的命令名（不含别名） */
function registeredCommands(): string[] {
  return Object.keys(plugin.commands ?? {})
}

describe('命令清单', () => {
  it('help 列出的命令都真实存在', async (ctx) => {
    const help = plugin.commands?.['help']
    expect(help).toBeTruthy()

    // 调真的 handler，拿它实际输出
    const output = String(
      await (help as { handler: (a: unknown) => Promise<unknown> }).handler({
        ctx: {
          db: {
            async all() {
              return []
            },
          },
          kv: { get: async () => null, getJSON: async () => null, put: async () => undefined },
          config: plugin.defaultConfig,
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          service: () => {
            throw new Error('no llm')
          },
        },
        session: {},
        argText: '',
      }),
    )

    // 从输出里抓所有 /agent xxx
    const listed = [...output.matchAll(/^\/([a-z]+)/gm)].map((m) => m[1] ?? '')
    const registered = registeredCommands()

    for (const name of listed) {
      expect(registered, `help 列了「${name}」但它没被注册`).toContain(name)
    }
  })

  it('注册的每个命令都出现在 help 里（除了 help 自己）', async () => {
    const help = plugin.commands?.['help']
    const output = String(
      await (help as { handler: (a: unknown) => Promise<unknown> }).handler({
        ctx: {
          // 造一条技能，让 `agent skill` 进入清单（没技能时它被有意隐藏）
          db: {
            async all() {
              return [{ id: 'x', name: 'x', description: 'd', body: 'b', updated_at: 1 }]
            },
          },
          kv: { get: async () => null, getJSON: async () => null, put: async () => undefined },
          // 打开技能开关，让 `agent skill` 进入清单
          config: { ...plugin.defaultConfig, enable_skills: true },
          logger: { debug() {}, info() {}, warn() {}, error() {} },
          service: () => {
            throw new Error('no llm')
          },
        },
        session: {},
        argText: '',
      }),
    )

    for (const name of registeredCommands()) {
      expect(output, `命令「${name}」没写进 help`).toContain(name)
    }
  })
})

describe('命令的权限门槛', () => {
  it('破坏性命令都要求群管理员', () => {
    // 清空记忆是不可逆的：群里任何人能做就会出事
    for (const name of ['reset', 'new']) {
      const cmd = plugin.commands?.[name] as { permission?: string } | undefined
      expect(cmd?.permission, `${name} 必须有权限门槛`).toBe('group_admin')
    }
  })

  it('改人格要求群管理员（人格是整群共享的）', () => {
    const cmd = plugin.commands?.['persona'] as { permission?: string } | undefined
    expect(cmd?.permission).toBe('group_admin')
  })

  it('只读命令不设门槛（人人可用）', () => {
    for (const name of ['stats', 'help', 'status', 'stop']) {
      const cmd = plugin.commands?.[name] as { permission?: string } | undefined
      expect(cmd?.permission, `${name} 是只读/无害操作，不该设门槛`).toBeUndefined()
    }
  })
})

describe('别名', () => {
  it('常用命令有中文别名（QQ 里打中文比打英文自然）', () => {
    const cases: Array<[string, string]> = [
      ['stop', '停'],
      ['help', '帮助'],
      ['stats', '用量'],
      ['new', '新对话'],
    ]
    for (const [name, alias] of cases) {
      const cmd = plugin.commands?.[name] as { aliases?: string[] } | undefined
      expect(cmd?.aliases, `${name} 缺少别名 ${alias}`).toContain(alias)
    }
  })

  it('别名不重复占用已有命令名', () => {
    const registered = new Set(registeredCommands())
    for (const [name, cmd] of Object.entries(plugin.commands ?? {})) {
      const aliases = (cmd as { aliases?: string[] }).aliases ?? []
      for (const alias of aliases) {
        expect(registered.has(alias), `${name} 的别名 ${alias} 撞了已有命令`).toBe(false)
      }
    }
  })
})

describe('stop 与 reset 的语义区分', () => {
  it('stop 不清历史，reset 清 —— 两者是不同命令', () => {
    // AstrBot: /stop 只打断当前回答，/reset 连记忆一起清
    expect(registeredCommands()).toContain('stop')
    expect(registeredCommands()).toContain('reset')
  })

  it('stop 的说明里明确「保留记忆」（用户要能预期到）', () => {
    const cmd = plugin.commands?.['stop'] as { description?: string } | undefined
    expect(cmd?.description).toContain('保留')
  })
})

/**
 * 唤醒层的命令黑名单必须和实际注册的命令同步。
 *
 * ## 为什么需要这条测试
 *
 * 命令(`commands`)和事件(`events`)是两套独立分发：一条 `/reset` 会**同时**
 * 命中两者。命令默认 `block: true` 只阻止它之后的候选，不影响已经排进来的事件。
 * 而唤醒层把 `/` 当前缀剥掉送模型 —— 于是用户会看到「执行了命令 + 模型又回一句」。
 *
 * 修法是唤醒层显式排除本插件的命令（`src/agent/commands.ts` 的
 * `PLUGIN_COMMANDS`）。但那是**手写清单**，和 `index.ts` 的 `commands`
 * 没有任何强关联 —— 加了命令忘了加进去，就又会漏进模型。
 */
describe('唤醒层的命令黑名单与实际注册一致', () => {
  it('注册的每个命令都在黑名单里', () => {
    const registered = Object.keys(plugin.commands ?? {})
    for (const name of registered) {
      expect(
        (PLUGIN_COMMANDS as readonly string[]).includes(name),
        `命令「${name}」没进 PLUGIN_COMMANDS，/ ${name} 会被当成聊天送进模型`,
      ).toBe(true)
    }
  })

  it('黑名单里没有已经不存在的命令（清理残留）', () => {
    const registered = new Set(Object.keys(plugin.commands ?? {}))
    for (const name of PLUGIN_COMMANDS) {
      expect(registered.has(name), `PLUGIN_COMMANDS 里的「${name}」已不是注册命令`).toBe(true)
    }
  })

  it('中文别名也在黑名单里', () => {
    for (const alias of PLUGIN_COMMAND_ALIASES) {
      expect(isPluginCommand(alias), `别名「${alias}」没被拦住`).toBe(true)
    }
  })

  it('isPluginCommand 只看首词，且不区分大小写', () => {
    expect(isPluginCommand('reset')).toBe(true)
    expect(isPluginCommand('RESET')).toBe(true)
    expect(isPluginCommand('  help  ')).toBe(true)
    // 不是命令的普通聊天不该被拦
    expect(isPluginCommand('你好')).toBe(false)
    expect(isPluginCommand('reset 一下你好')).toBe(true) // 首词是命令就按命令处理
    expect(isPluginCommand('')).toBe(false)
  })
})
