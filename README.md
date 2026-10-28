# qflarebot-plugin-agent

QFlareBot 的 Agent 插件：带工具调用的多轮对话、会话记忆、联网查资料、动态定时任务。

需要配合 [qflarebot-plugin-llm](https://github.com/clown145/qflarebot-plugin-llm) 使用——本插件不含模型接入，只通过它的 `llm` 服务调用模型。

## 它做什么

- **多轮对话**：每个会话（群 / 单聊）一段独立记忆，存在 Durable Object 里。
- **工具调用**：模型可以联网查资料（`web.fetch_page`）、发 HTTP 请求（`http.request`）、看时间（`time.now`），可选开启动态定时任务。
- **群聊/单聊都能用**：群里 @机器人 直接说话，不用打命令。

## 它不做什么

- 不含模型接入。供应商、API Key、模型别名都在「LLM 接口」插件里配。
- 不做群管理、不做图像生成。那些是别的插件的事。
- 不做「模型改写工作区文档」那种 skill 机制——QFlareBot 的插件是部署单元，语义对不上。

## 安装

1. 先装 [qflarebot-plugin-llm](https://github.com/clown145/qflarebot-plugin-llm)，在里面配好供应商和模型别名。
2. 面板 → 插件 → 安装插件 → 粘贴本仓库地址。
3. 预检会提示**需要往机器人仓库补一条 DO migration**（见下）。
4. 装好后在插件设置里填「模型别名」（默认 `chat`）。

### 需要补 DO migration

本插件声明了一个 Durable Object 类 `Agent`，用来做会话串行化与历史存储。QFlareBot 的 DO 需要往宿主仓库补一条 migration（平台的 `migrations` 是只追加的历史，构建机造不出来，只能由人加）：

```jsonc
// apps/seed/wrangler.jsonc 的 migrations 末尾追加
{ "tag": "p-agent", "new_sqlite_classes": ["P_agent_Agent"] }
```

提交推送、等构建完成后，回面板点「已加好 migrations，确认安装」。

> 这是 QFlareBot 对所有 DO 插件的统一要求，不是本插件的特殊设计。不想要这个手工步骤的话，只能用不带 DO 的简化版（会失去会话串行化与历史）。

## 为什么用 Durable Object

会话串行化与对话历史需要强一致的单点存储。用 D1 做同样的事，每条消息要读写好几次 D1，而 D1 免费版只有 10 万行写/日，且是**全机器人所有插件共享**的池子——一个活跃群几天就能打满。

DO 按 GB-秒计费（128 MB × 墙上时间）：一次 8 秒的对话约 1 GB-s，免费版 13,000 GB-s/日能撑上万次对话。把历史与 run 队列放 DO 的 SQLite storage 之后，**每条消息完全不碰 D1 额度**。

D1 只用来存需要跨会话全局查询的东西：定时任务、按天统计、可选的工具审计。

## 双段式调度

一次事件只有 30 秒（QFlareBot 所有插件合计，框架 25 秒告警），而 agent 多轮工具调用很容易超过。所以分两段：

```text
① 事件处理器（软预算 18 秒）
   ├─ 向 DO 提交 run 并尝试认领
   ├─ 抢到 → 立刻跑 loop，用被动回复发出去（用户感知是秒回）
   └─ 没抢到 / 超预算 → 留在队列，交给 cron

② cron（每分钟）
   ├─ 兜底捡队列里的 run
   ├─ 触发到期的定时任务
   └─ 清理过期数据（节流，最多 10 分钟一次）
```

两条路径共用同一个 `executeRun`，不是两套逻辑。

被动回复凭据（`msg_id`）群聊 5 分钟、单聊 60 分钟内有效，所以 cron 段仍能用它回复，不消耗主动消息额度。

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `model` | `chat` | plugin-llm 里的模型别名 |
| `system_prompt` | 内置 | 留空用默认人格 |
| `max_model_steps` | 8 | 单次最多几步模型调用。失控的 loop 会烧光时长与 token |
| `max_tool_calls` | 12 | 单次最多几次工具调用 |
| `history_limit` | 20 | 每次带多少条历史。条数越多越贵 |
| `request_timeout_ms` | 20000 | 单次模型调用超时 |
| `enable_tools` | 开 | 工具调用总开关 |
| `enable_vfs` | 关 | 虚拟工作区（需要 R2） |
| `enable_schedule` | 关 | 动态定时任务 |
| `enable_mcp` | 关 | MCP 工具 |
| `enable_audit` | 关 | 工具调用写 D1，排障用 |
| `show_typing` | 开 | 单聊"正在输入" |
| `timezone` | Asia/Shanghai | 影响时间工具与提示词 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `/agent <问题>` | 问 Agent。群里 @机器人 直接说话也行 |
| `/agent reset` | 清空当前会话记忆 |
| `/agent status` | 查看模型别名、可用模型、开关状态 |

## 额度

按个人机器人的量级估算（免费版）：

| 项目 | 单次对话消耗 | 免费版额度 | 可支撑 |
| --- | --- | --- | --- |
| DO | 约 1–3 GB-s（8–25 秒） | 13,000 GB-s/日 | 约 4,000–12,000 次/日 |
| D1 写 | 0 行（历史在 DO） | 100,000 行/日 | 不构成瓶颈 |
| KV 写 | 仅首次见到新会话时 | 1,000 次/日 | 够用 |
| Worker 请求 | 1 次/消息 + cron 1,440/日 | 100,000 次/日 | 够用 |

**前提**：需要 Workers Paid（$5/月）。免费版 Worker 请求 CPU 只有 10 ms、子请求上限 50——一次带工具的 agent loop 跑不完。DO 的 CPU 上限是 30 秒，但事件处理器在 Worker 里，那一段仍然受限。

## 开发

```bash
# SDK 与构建工具不发布到 npm，需要先把 QFlareBot 克隆到旁边并构建
git clone https://github.com/QFlareBot/QFlareBot ../qqbot-workers
(cd ../qqbot-workers && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)

npm install
npm run typecheck
npm test
npm run build
npm run sync     # 把 dist/manifest.json 复制到仓库根目录，需要提交
```

## 目录结构

```text
src/
  index.ts            插件定义：命令、事件、cron、路由、DO 声明
  types.ts            内部类型（对齐 serverless-agent 的协议）
  config/index.ts     配置 schema 与默认值
  do/agent-object.ts  Durable Object：会话锁、run 队列、历史
  agent/
    inbound.ts        Session → InboundMessage 归一化
    context.ts        上下文装配（系统提示词 + 历史 + 本轮）
    loop.ts           agent loop（模型 → 工具 → 回填 → 再调）
    run.ts            一次 run 的完整编排
  llm/
    contract.ts       plugin-llm 的服务契约（本地声明）
    client.ts         契约适配 + 错误分类
  tools/
    registry.ts       工具注册表
    http.ts           http.request（含 SSRF 防护）
    web.ts            web.fetch_page
    time.ts           time.now
    schedule.ts       动态定时任务
  store/
    schema.ts         D1 表结构
    d1.ts             D1 数据访问
  routes.ts           管理页 API
  page.ts             管理页（单 HTML）
```

## 从 serverless-agent 搬了什么

本插件的 agent loop、工具协议、上下文装配、DO mailbox 思路来自 [serverless-agent](https://github.com/clown145/serverless-agent)（GPL-3.0-or-later）。按行数算，那边 36,487 行里约 5,500 行可零改动复制、13,000 行改存储后可用，其余（平台适配 5,741 行、Worker 路由 5,866 行、模型层 2,358 行、面板 13,670 行）没有迁移价值。

实际搬过来的：

| 来源 | 用途 |
| --- | --- |
| `src/tools/http/url-safety.ts` | SSRF 黑名单，原样复制 |
| `src/tools/web/extract.ts` | HTML → 文本，原样复制 |
| `src/core/agent-tool-loop.ts` | loop 结构（步数/工具数上限） |
| `src/core/agent-context.ts` | 上下文装配（历史回放） |
| `src/tools/time/` | 时间工具 |
| `src/agents/agent-mailbox*` | DO 队列/租约/恢复的思路 |

没有搬的：平台适配（QFlareBot 的 `session`/`ctx.api` 更强）、模型层（plugin-llm 已覆盖）、Admin WebUI（插件 UI 只能单 HTML）、RayNeo/WeCom/WeixinOC（私有协议或无价值）。

许可证：本插件 MIT；serverless-agent 是 GPL-3.0-or-later，如果你要复用它的代码到自己的 GPL 项目之外，注意许可证兼容性。

## License

MIT
