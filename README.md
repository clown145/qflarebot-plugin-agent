# qflarebot-plugin-agent

QFlareBot 的 Agent 插件：带工具调用的多轮对话、会话记忆、联网查资料、动态定时任务。

需要配合 [qflarebot-plugin-llm](https://github.com/clown145/qflarebot-plugin-llm) 使用——本插件不含模型接入，只通过它的 `llm` 服务调用模型。

**这是必需依赖**（`depends: { llm: '*' }`）：没装 LLM 插件时，面板安装会被直接拦下并提示先装提供者。装了之后如果又把它停用或卸载，Agent 会回复「需要的 LLM 接口插件没有启用」，而不是抛内部错误。

## 它做什么

- **多轮对话**：每个会话（群 / 单聊）一段独立记忆，存在 Durable Object 里。
- **工具调用**：模型可以联网查资料、发 HTTP 请求、看时间、读写工作区文件、建定时任务。每类工具都有独立的权限级别。
- **群聊/单聊都能用**：群里 @机器人 直接说话，不用打命令。

## 什么时候会回复（唤醒）

对标 AstrBot 的 waking check。群聊里**只有两种情况**会让机器人开口：

1. **@ 了机器人**
2. **以「唤醒前缀」开头**（`wake_prefix`，默认 `/`），前缀会被剥掉

其余消息一律**不理**。这是刻意的：群里正常聊天不该被插嘴。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `wake_prefix` | `/` | 以此开头的消息唤醒 Agent，并剥掉前缀再交给模型 |
| `friend_needs_wake_prefix` | 关 | 单聊默认任何消息都触发；打开后单聊也要带前缀 |
| `command_prefixes` | `/` | 以此开头的消息交给指令，**不进模型**（与 `wake_prefix` 是两回事） |

**没命中任何指令、但被唤醒的消息 → 走 Agent**。这是 AstrBot 的行为：用户 @ 机器人说「你好」，
不该要求他打 `/agent 你好`。命中指令的消息由命令路径处理（命令默认 `block`），
与聊天天然互斥，不会同一句话既执行指令又调模型。

> **不做「引用消息就唤醒」**。AstrBot 的语义是「引用了**机器人自己**的消息」，
> 而 QFlareBot 的 `session.quote` 拿不到被引用消息的发送者，精确判断做不到。
> 退化成「有引用就唤醒」会让机器人在群友互相引用聊天时插嘴——实测踩过这个坑。
>
> **不做「群里所有消息都回复」**。AstrBot 也没有这个模式（只有默认关闭、概率 0.1 的主动回复）。
> QFlareBot 侧更不适合：全量消息依赖群主开启「接收全部消息」，且一次事件有 30 秒预算。

## 人格（persona）

多套人格并存，按会话绑定（对标 AstrBot 的 persona）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `personas` | 空 | 每套含 `name`（绑定标识）、`prompt`（系统提示词）、`begin_dialogs`（开场对话） |
| `default_persona` | 空 | 会话没绑定时用哪套；留空则用 `system_prompt` |

优先级：**会话绑定 > `default_persona` > `system_prompt`**。绑定的那套被删掉时会回落，
不会让会话突然失去人格。

`begin_dialogs` 是 AstrBot 的同名字段：每轮插在历史最前面、用来锚定说话风格（不属于会话记忆），
每行一句，`user:` / `assistant:` 开头。

会话级别用 `/agent persona <名字>` 切换，也可以在插件管理页「会话」里直接下拉改绑。

## 管理页

面板侧栏「插件页面 → Agent」。**所有能改的都在这里改**——不必去面板的插件配置表单：

| 区块 | 交互 |
| --- | --- |
| 模型 | 下拉点选（别名来自 LLM 插件，不用手打），立即生效 |
| 人格 | 增删改每套人格（名字 / 提示词 / 开场对话），选默认人格；立即生效 |
| 系统提示词 | 直接编辑保存，可恢复成配置里的值 |
| 群聊唤醒 | 触发方式、唤醒前缀、单聊是否要前缀、指令前缀 |
| 能力开关 | 工具调用、虚拟工作区、定时任务、审计、正在输入 |
| 限额 | 步数、工具调用数、历史条数、超时、时区 |
| 会话 | 列出绑过人格的会话，每行下拉改绑或清除 |
| 定时任务 / 工具调用 / 统计 | 只读表格 |

页面的改动存在插件自己的存储里，**覆盖**面板配置（面板配置是权威默认值），
所以点完立即生效、不用等构建。每项都标「已改」，改回原值时标记自动消失；
底部可一键全部恢复。页面用宿主的 `--qb-*` 设计 token，跟随面板主题。

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

本插件的设计来自 [serverless-agent](https://github.com/clown145/serverless-agent)（GPL-3.0-or-later）。
**原样复制**的只有两个文件，其余是参考结构与思路后重写的：

| 来源 | 处理方式 | 说明 |
| --- | --- | --- |
| `src/tools/http/url-safety.ts` | 原样复制（151 行） | SSRF 黑名单，零依赖 |
| `src/tools/web/extract.ts` | 原样复制（172 行） | HTML → 文本，零依赖 |
| `src/vfs/core/path.ts` | 原样复制（69 行） | 路径归一化，改中文错误信息 |
| `src/core/agent-tool-loop.ts` | 参考结构重写 | 保留双限额、`sentMessageTool` 累加、超限抛错 |
| `src/core/agent-tool-executor.ts` | 参考结构重写 | 保留白名单、`preventsFinalResponse` |
| `src/core/agent-context.ts` | 参考结构重写 | 保留历史回放的两个细节 |
| `src/tools/registry/tool-registry.ts` | 参考结构重写 | 保留权限→执行→审计顺序，审计改可选 |
| `src/permissions/*` | 参考结构重写 | 6 级 + scope、角色基线、策略叠加 |
| `src/agents/agent-mailbox*` | 参考思路重写 | 租约、FIFO 队列、终态清理；恢复靠 cron 的 10 分钟清理轮而不是 `alarm()`（DO 里没有 `ctx.service()`，跑不了 loop） |
| `src/tools/time/tools.ts` | 参考重写 | 时区处理 |
| `src/tools/schedule/*` | 参考协议重写 | 去掉 Queue 依赖，改 cron 扫表 |
| `src/tools/vfs/*` | 参考设计重写 | 砍掉 revisions，小文本 D1 / 大文件 R2；覆盖大文件时会删掉旧 R2 对象 |

**没有搬**（约 24,000 行）：

- `src/adapters/`（5,741）——QFlareBot 的 `session` / `ctx.api` 更强
- `src/worker/`（5,866）——插件用 `routes` 与 `cron`
- `src/core/model/`（2,358）——plugin-llm 已覆盖
- `src/rayneo/`（1,390）、`src/platforms/`（1,260）——私有协议
- `apps/admin-web/`（13,670）——插件 UI 只能单 HTML

## 已知限制

- **Gemini 思考模型的多轮工具调用不可用**：plugin-llm 的契约要求把 `thought_signatures`
  原样回传（Gemini 2.5/3.x 对 functionCall part 的签名严格校验，缺了直接 400），
  而本插件的本地契约副本没有这个字段。用 Gemini 非思考模型或 OpenAI 兼容协议没影响。
- **没有 run/step 级可观测性**：不做 `runs` / `run_steps` / `tool_calls` 落库（D1 写额度是
  全机器人共享的 10 万行/日）。排障走 Workers Logs，工具调用记录是可选开关。
- **没有 web 搜索 / skills / MCP / pending-action 确认流**：见上表，属于没搬的部分。


许可证：本插件 MIT；serverless-agent 是 GPL-3.0-or-later，把它的代码复用到别的项目时注意兼容性。

## License

MIT
