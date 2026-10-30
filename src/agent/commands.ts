/**
 * 本插件声明的命令名（**供唤醒层判断「这条消息是命令，不该进模型」**）。
 *
 * ## 为什么需要这张表
 *
 * 命令和事件是**两套独立的分发**，不是「命中命令就跳过事件」：
 *
 * - 命令注册在 `commands`，默认 `block: true`
 * - 事件注册在 `events`，默认 `block: false`
 *
 * 两者都在同一个候选列表里竞争，`block` 只影响**它之后**的候选要不要继续跑。
 * 所以一条 `/reset` 会同时命中「命令」和「群消息事件」——命令照常执行，
 * 事件处理器也照样被调用。
 *
 * 而 Agent 的群消息事件里，唤醒判定把「以 `/` 开头」当成唤醒
 * （`wake_prefix` 默认就是 `/`），于是 `/reset` 被剥成 `reset` 送进了模型：
 * 用户看到的是「机器人在执行命令的同时，还回了一句莫名其妙的话」。
 *
 * ## 所以这里显式列一遍
 *
 * 唤醒层在剥前缀之前先问一句：首词是不是我的命令？是就**不唤醒**，
 * 交给命令那条路径。
 *
 * 代价是这张表要和 `index.ts` 的 `commands` 保持同步 ——
 * `commands.test.ts` 里有一条测试双向比对它们，漏一个就失败。
 */
export const PLUGIN_COMMANDS = [
  'ask',
  'reset',
  'stop',
  'new',
  'stats',
  'help',
  'schedule',
  'persona',
  'status',
  'skill',
] as const

/** 中文别名同样要挡：`/停`、`/帮助` 这些也不该进模型 */
export const PLUGIN_COMMAND_ALIASES = ['停', '别说了', '新对话', '用量', '帮助', '菜单'] as const

/**
 * 这条消息是不是本插件的命令？
 *
 * 判断依据是**首词**（不区分大小写），而不是「以斜杠开头」——
 * 因为斜杠是唤醒前缀，用户完全可能打 `/你好` 来聊天，那是正常用法。
 *
 * 注意：这里**不检查斜杠本身**。调用方（唤醒层）已经确认消息带前缀了；
 * 不带前缀的 `@机器人 help` 也走命令路径，那种情况本来就不该当成聊天。
 */
export function isPluginCommand(text: string): boolean {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!first) return false
  return (
    (PLUGIN_COMMANDS as readonly string[]).includes(first) ||
    (PLUGIN_COMMAND_ALIASES as readonly string[]).includes(first)
  )
}
