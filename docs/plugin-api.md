# 给其他插件用的接口

本插件通过 `ctx.service('agent')` 对外提供两块扩展能力：

1. **提示词**：往 system prompt 里插一段话
2. **工具**：把自己的函数交给模型调用

## 用法

### 1. 在调用方插件的 manifest 里声明依赖

```json
{ "depends": { "agent": "optional" } }
```

用 `optional` 而不是 `*`：没装 Agent 插件时你的插件也该能正常工作。

### 2. 注册片段

```ts
/**
 * 接口要**内联声明**，不能 import 本插件的源码路径。
 *
 * 为什么：本插件不发 npm 包、package.json 里也没有 `exports`，
 * 所以 `import ... from 'qflarebot-plugin-agent/src/...'` 在任何调用方里
 * 都解析不了（构建直接失败）。插件之间的类型对齐靠「各自声明同一份形状」，
 * 和 `llm` 服务的做法一致——这样两个插件可以独立发布、独立升级。
 */
interface AgentPromptService {
  registerPrompt(plugin: string, fragment: string, priority?: number): Promise<boolean>
  disablePrompt(plugin: string): Promise<boolean>
  clearPrompt(plugin: string): Promise<boolean>
  listPrompts(): Promise<Array<{ plugin: string; fragment: string; priority: number; enabled: boolean }>>
}

export default definePlugin({
  name: 'weather',
  commands: {
    setup: {
      async handler({ ctx }) {
        try {
          const agent = ctx.service<AgentPromptService>('agent')
          await agent.registerPrompt(
            ctx.plugin.name,                              // 用你自己的插件名
            '回答天气问题时，先调用 weather.query，不要凭记忆猜。',
            0,                                            // priority，越大越靠前
          )
          return '已接入 Agent 的提示词'
        } catch {
          // 没装 / 停用了 Agent 插件，按没有处理
          return 'Agent 插件未启用，提示词未注册'
        }
      },
    },
  },
})
```

> 同一份接口在源码里是 `src/agent-service.ts` 的 `AgentService`，
> 只作为**文档参考**——不要 import 它。

### 3. 之后每一轮

Agent 会把片段拼进 system prompt 末尾，模型就能看到你的指令了。

## 接口

| 方法 | 作用 |
| --- | --- |
| `registerPrompt(plugin, fragment, priority?)` | 注册/覆盖片段。内容没变时**不写库**（返回 `false`），可以放心在每个请求里调 |
| `disablePrompt(plugin)` | 停用但保留内容 |
| `clearPrompt(plugin)` | 彻底删除 |
| `listPrompts()` | 列出全部片段（含停用的），排障用 |

## 约束

| 项 | 限制 | 为什么 |
| --- | --- | --- |
| 单个片段 | **2000 字节** | 不设限的话一个插件塞几万字，别人的 token 账单直接爆掉 |
| 同时生效 | **最多 8 个** | 防止被插件刷屏 |
| 内容形式 | **纯文本** | 不做模板替换 —— 那等于给其他插件一个「在本插件上下文里求值」的口子 |
| 一个插件 | **一份片段** | 重复注册是覆盖而不是追加，避免无限增长 |

## 缓存影响

片段拼在 system prompt **末尾**，属于稳定内容 —— 只要你不改它，前缀缓存就命中。

**但如果你的插件每轮都改片段，会把整段 system 的缓存击穿**，所有对话都变贵。
所以：注册是**显式动作**，不要放进每轮都会跑的路径里。

## 排序

按 `priority` 降序，**同优先级按插件名升序**。

同优先级必须按名字而不是写入时间排：否则同样的片段集合每轮顺序可能不同，
system 前缀就抖了，缓存全废。

## 实测

- 跨时间、跨用户、跨会话时 system prompt **100% 相同**（有测试锁住）

---

# 工具扩展：把自己的函数交给模型调用

除了提示词，别的插件还可以注册**工具** —— 模型能直接调用你的函数。

## 两步

### 1. 注册工具元数据

```ts
const agent = ctx.service<AgentService>('agent')
await agent.registerTool(ctx.plugin.name, {
  name: 'query',                       // 短名，不需要前缀
  description: '查询某个城市当前的天气',  // 必填，模型靠它判断何时该用
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
  level: 2,                            // 可选，Agent 会强制抬到至少 2
  timeoutMs: 10_000,                   // 可选，1–30 秒
})
```

### 2. 通过 `services` 暴露执行函数

```ts
export default definePlugin({
  name: 'weather',
  services: {
    tools: () => ({
      query: async (input) => {
        const { city } = input as { city: string }
        return { city, temp: 21 }
      },
    }),
  },
})
```

服务名约定是 **`tools`**，对象的 key 是**工具短名**（不是 `plugin.weather.query`）。

> **key 怎么写都能匹配上**：Agent 会依次尝试「你写的原始 key」→「规整后的 key
> （`weather.query` → `weather_query`）」→「把服务对象里的 key 规整后比对」。
> 这一层是补过一个真 bug 的：早期只按规整后的名字取，而服务对象用的是原始 key，
> 于是 `service[meta.name]` 恒为 `undefined`，工具**静默消失**。

## 为什么元数据和执行函数分两处

| 部分 | 存哪 | 为什么 |
| --- | --- | --- |
| 元数据（名字/描述/schema） | D1 | 构建工具列表时要**同步**拿到；模型得先知道有哪些工具 |
| 执行函数 | 你的 `services` | 函数没法序列化 |

宿主对 `services` 的约定是「工厂**每个请求**调用一次」。所以 Agent 只能在构建注册表
的那一刻去取执行函数 —— 元数据必须提前存好。

> **两条都必须做。** 只注册元数据不暴露执行函数，Agent 拿不到函数会**跳过这个工具**
> （而不是注册一个每次调用都报错的工具）。

## 名字规则

对外暴露成 **`plugin.<你的插件名>.<工具名>`**，强制带前缀：
- 防止你注册一个叫 `http.request` 的工具来冒充内置工具
- 两个插件撞名时天然区分

工具名会被规整：只留字母数字、下划线、连字符，其余转下划线。
模型侧的 function name 字符集有限，中文和空格会让 provider 直接 400。

## 权限

插件工具**最低 level 2**（提供者说 level 1 也不作数）——否则任何插件都能把
「发 HTTP 请求」这类能力降到人人可用。

工具使用通用 scope `plugin:use`，它已在各角色基线里。**各插件的权限差异由
`level` 表达**，不需要每个插件一个 scope（那样的话 scope 不在基线里，
工具注册了也永远 `permission_denied`）。

> 工具的启用/关闭也走 Agent 管理页的「工具」面板，和内置工具一起管理。

## 限制

| 项 | 上限 | 为什么 |
| --- | --- | --- |
| 单插件工具数 | 20 | 防止一个插件把模型淹了 |
| 全部插件工具数 | 50 | 同上 |
| description | 500 字符 | 它**每轮都进上下文**，太长会持续烧 token |
| 调用超时 | 30 秒 | 一个坏插件不能拖死整个 run |

## 失败处理

| 情况 | 行为 |
| --- | --- |
| 你被卸载/停用（服务取不到） | 你的工具**不注册**，不是每次调用报错 |
| 元数据在但执行函数缺失 | 跳过那个工具 |
| 执行抛错 | 返回可读的 `failed`，`retryable: false`（插件内部错误是否可重试我们知道不了，保守设为不可重试，避免模型反复重试） |
| 执行超时 | 返回 `timeout`，run 继续 |

任何一个插件出问题都**只影响它自己的工具**。

## 已知限制：第三方插件的工具当前不可用（框架约束，不是 bug）

宿主的 `ctx.service(name)` 只认**本插件 manifest 里 `depends` 声明过的服务**：

```ts
// packages/runtime/src/context.ts
if (!Object.hasOwn(plugin.manifest.depends ?? {}, serviceName)) {
  throw new Error(`插件 ${name} 没有在 depends 中声明服务 ${serviceName}`)
}
```

而 Agent 无法为「任意第三方插件」声明依赖——`depends` 是**静态清单**，
写死在 manifest 里，插件名在安装别的插件之前不可能知道。所以：

| 场景 | 现状 |
| --- | --- |
| 提供者把执行函数挂在 `services: { tools: () => … }` | **取不到**：`tools` 不在 Agent 的 depends 里，`ctx.service('tools')` 抛错 |
| 提供者按插件名暴露（`services: { weather: () => … }`） | 同样取不到：`weather` 也不在 depends 里 |
| 元数据注册成功（D1 里看得到） | ✅ 这一步是好的，管理页能看到 |
| 模型实际调用 | ❌ 执行函数取不到，工具不注册 |

代码的行为是**明确失败而不是伪造可用性**：

- 注册表里不出现这个工具（模型看不到，不会尝试调用后被拒）；
- 日志里记一条 `第三方插件工具当前不可用：宿主只允许取 depends 里声明的服务…`
  （按 owner 做 10 分钟节流，不会刷屏），带 owner 与内部错误原因；
- 有元数据但执行函数缺失时，另记一条 `插件工具没有对应的执行函数，已跳过`，
  并带上该服务对象实际有哪些 key。

### 会有解吗

需要宿主支持「动态/通配服务声明」，例如 `depends: { "tools:*": "optional" }`
或运行时的插件间事件总线。在那之前，**Agent 能可靠使用的外部工具只有内置的那些**，
以及未来如果宿主把工具扩展做成协议而不是 `services` 的时候。

如果你要接入自定义能力，目前可行的替代：
1. 用内置的 `http.request` / `vfs.*` 组合（不需要新插件）；
2. 把你的逻辑做成 Agent 的**提示词片段**（`registerPrompt`）来引导模型用内置工具；
3. 等宿主把这条链路补上。
