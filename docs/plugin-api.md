# 给其他插件用的接口

本插件通过 `ctx.service('agent')` 对外提供一个服务：**让别的插件往 Agent 的
system prompt 里插一段话**。

对标 AstrBot 的 `OnLLMRequestEvent`（插件能在每次 LLM 请求前修改请求）。
QFlareBot 没有钩子机制，所以做成服务。

## 用法

### 1. 在调用方插件的 manifest 里声明依赖

```json
{ "depends": { "agent": "optional" } }
```

用 `optional` 而不是 `*`：没装 Agent 插件时你的插件也该能正常工作。

### 2. 注册片段

```ts
import type { AgentPromptService } from 'qflarebot-plugin-agent/src/prompt-fragments'

export default definePlugin({
  name: 'weather',
  async hooks() { /* ... */ },
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

- 529 个测试通过
- 跨时间、跨用户、跨会话时 system prompt **100% 相同**
