# 给其他插件用的接口

本插件通过 `ctx.service('agent')` 提供提示词扩展。工具扩展改用框架的 `definePlugin.tools` / `core.tools`，同一份能力可供所有 Agent 使用。

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
  depends: { agent: 'optional' },
  commands: {
    setup: {
      async handler({ ctx }) {
        try {
          const agent = ctx.service<AgentPromptService>('agent')
          await agent.registerPrompt(
            ctx.plugin.name,                              // 用你自己的插件名
            '回答天气问题时，先调用 plugin.weather.query，不要凭记忆猜。',
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

# 工具扩展：框架统一协议

要求框架 SDK 契约 v5。提供者优先复用已暴露的服务方法，补上用途、输入与结果说明，无需依赖任何特定 Agent：

```ts
import { definePlugin } from '@qqbot/sdk'

export default definePlugin({
  name: 'weather',
  apiVersion: 5,
  services: {
    weather: ctx => ({
      async query(city: string) {
        return { city, weather: await ctx.kv.getJSON(`weather:${city}`) }
      },
    }),
  },
  tools: {
    query: {
      service: 'weather',
      method: 'query',
      description: '读取某城市最近缓存的天气，用于回答天气问题。返回 city 和 weather；weather 为 null 表示暂无数据，不能当作实时天气。',
      inputSchema: {
        type: 'object', required: ['city'], additionalProperties: false,
        properties: {
          city: { type: 'string', description: '城市名称，例如上海。', minLength: 1 },
        },
      },
      permission: 'member',
      sideEffect: 'none',
      version: 1,
      timeoutMs: 10_000,
      mapInput: ({ input }) => [(input as { city: string }).city],
      mapOutput: output => ({ status: 'success', output }),
    },
  },
})
```

`service/method` 只公开明确选择的方法，原 `services` 工厂和方法签名保留。`mapInput` 将模型输入转为位置参数（省略时默认 `[input]`）；`mapOutput` 必须明确解释旧方法的返回值和错误，避免把业务失败当成功。框架复用同一请求内的服务实例，保留 `this`。没有现成方法时也可直接使用 `handler`，两种方式二选一。

说明需要回答“做什么、什么时候用、输入什么、返回什么”，参数的含义和单位写进 Schema 的 `description`；不能指望模型只看方法名猜用途。T2I 已绑定现有 `t2i.renderBase64`，并提供图片附件的结果映射。

转换函数中的 `ctx` 是提供者自己的数据库、配置和服务上下文；`actor` 是框架签发的原始发起人，`caller.plugin` 是消费 Agent。模型只能填写 `input`，不能填写调用者身份。目录来自构建生成的 manifest，部署后自动发现。

框架 ID 是 `weather.query`，本 Agent 暴露为 `plugin.weather.query`；长名称超过 64 字符时附摘要避免截断碰撞。Agent 只需可选依赖 `core.tools`，无需逐个依赖提供者。T2I 已接入 `t2i.render`，可直接请求 Agent 把内容渲染成图片。

## 权限与结果

- 框架执行前复核提供者/消费者启用状态、群范围、场景、用户权限、工具策略、Schema 和 revision。
- `permission` 使用 `member` / `group_admin` / `bot_admin`。Agent 管理页显示这一权限，现有总开关、单工具开关、人格白名单和危险操作确认继续收窄能力。
- 返回 `status: success/failed/permission_denied/cancelled/timeout/unknown`，失败带 `{ code, message, retryable }`，不会把失败对象包装为成功。
- 图片等通过 `artifacts: [{ type: 'image', url: 'https://…' }]` 或 base64 返回。Agent 保存附件并由回复通道交付，仍可同时发送模型的文字说明。
- 超时默认 10 秒、上限 30 秒。输入最大 64 KiB、结果最大 2.5 MB/10 个附件。提供者应遵守 signal/deadline。
- v1 Schema 是显式子集；不支持 `$ref`、`format` 等约束，不支持的声明会被拒绝。完整契约见框架仓库 `docs/tools.md`。

## 恢复

聊天入口签发的调用凭据与入站消息一起保存，24 小时内可以由新 Worker 请求继续执行；不会进入 LLM 提示词或展示历史。cron 恢复的是原始身份，不能把 scheduler 当成管理员重新授权。

检查点绑定工具 ID/revision 和稳定调用 ID。已完成结果直接复用；工具更新、停用或权限变化时停止旧调用。写操作超时或中断而结果未知时停止自动重试，并提示核对结果。框架传递稳定幂等键，但跨请求的持久幂等仍由提供者实现。

以下情况不能调用新的框架工具：旧框架没有 `core.tools`、没有原始凭据的旧任务、独立触发的新定时任务。内置工具继续可用，旧静态服务接线保留兼容路径。凭据过期后旧任务不能继续调用外部工具，需要用户重新发起。工具 handler 内递归公开工具调用暂不支持；多个 Agent 之间的任务委派不在这一版范围。

## 从旧注册方式迁移

1. 保留原有服务方法，在 `definePlugin.tools` 中补充说明、Schema 和 service/method 绑定；需要时转换参数和结果。
2. 将旧 Agent 数字 level 转为明确的框架权限；返回结构化结果，声明真实副作用等级。
3. 不再需要为了提供工具而依赖 Agent；如果仍需提示词扩展，可保留该依赖。
4. 用新 SDK/CLI 构建，提交并部署包含 tools 的 manifest；先升级框架，再升级 Agent 和提供者。

旧 `registerTool()` 保留写入能力并记录弃用提示，不会打断旧启动钩子；重复注册不重置禁用状态。旧的静态 `depends` 接线继续可执行，但无法借自报 owner 获得动态服务权限。原本未声明依赖、只能登记却无法执行的旧工具仍需迁移，框架不会根据旧表自动公开所有方法。

现代声明优先，旧记录只收窄禁用状态和自定义等级，不覆盖新用途或 Schema。框架停用的现代工具也不能通过旧适配器绕回。旧长名称开关继续有效；截断名称有碰撞时禁用所有候选，白名单需要明确选择新名称，不能自动扩大权限。工具页可以重新启用旧禁用项。`unregisterTool` / `listTools` 只操作旧记录，卸载现代工具请修改提供者声明或框架策略。

Agent 根据副作用映射本地等级：只读 1、工作区写入 2、外部写入与危险操作 3；保留 `plugin:use` scope，旧自定义等级只会继续收窄。危险操作还需确认，确认不会绕过角色或等级限制。

框架提供 `GET /admin/tools` 和 `PUT /admin/tools/policy` 管理全局策略；本 Agent 的 `/api/tools` 返回框架接入是否可用及当前目录。插件处于同一 isolate，这套入口不是恶意代码的隔离沙箱。
