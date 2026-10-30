# qflarebot-plugin-agent

给 QFlareBot 用的 AI 对话插件：接上大模型后，机器人在群里 @ 一下就能聊，能联网查资料、读写文件、自己建定时任务，每个会话有一段独立记忆。

## 前置条件

| 项 | 要求 |
| --- | --- |
| QFlareBot | **0.7.0 或更新**（原因见下） |
| LLM 插件 | **必需**，装 [`qflarebot-plugin-llm`](https://github.com/clown145/qflarebot-plugin-llm) |
| 数据库 | D1、KV |
| 可选绑定 | R2（虚拟工作区放较大文件）、Images / Browser Run（本插件暂未用） |

本插件不含模型接入，只通过 LLM 插件的 `llm` 服务调用模型。没装它时面板会直接拦下安装；装了之后又把它停用，Agent 会回「需要的 LLM 接口插件没有启用」，而不是抛内部错误。

> **为什么必须 0.7.0+**：本插件靠群消息事件把「没命中指令的话」送进模型，依赖框架「命令优先于消息事件」这条语义。0.7.0 之前命令和事件按注册顺序竞争，命令消息可能先被执行事件的插件当成聊天，于是 `/reset` 会命令照常执行、模型再回一句。
>
> 装在 0.6.x 及更早的机器人上**不会报错**，只是功能是坏的；安装检查也拦不住（`apiVersion` 管的是「有没有用到新能力」，管不了语义依赖）。请先升级机器人。

## 安装

1. 装 LLM 插件并配好模型（见它的 README）。
2. 装本插件。
3. 打开**面板 → 插件页面 → Agent**，选一个模型别名，点「测试」确认连通。

群聊要用起来，需要在 QQ 里给机器人开启「接收全部消息」；不开启也能用，只是必须 @ 机器人才有反应。

## 它能做什么

- **多轮对话**：每个会话（群 / 单聊）一段独立记忆，存在 Durable Object 里。
- **工具调用**：联网搜索、抓网页、发 HTTP 请求、查时间、读写工作区文件、建定时任务，每类工具可单独开关、各自有权限级别。
- **人格**：多套人格并存、按会话绑定，每套可以限制能用哪些工具和技能。
- **Skills**：可复用的能力包。平时只把目录注入提示词（≤40 行），用 `/skill <id> <任务>` 激活后才载入全文。
- **长会话不爆炸**：上下文超阈值时按「轮」压缩，工具调用和它的结果永远成对丢弃。
- **防刷屏**：每会话每分钟有次数上限，可选关键词内容安全（入站出站都查）。

## 用法

群里 **@机器人** 直接说话，不用打命令：

```
@机器人 帮我查一下 Cloudflare Workers 的免费额度
```

也可以用 `/` 前缀（默认，可在面板改）唤醒，前缀会被剥掉再交给模型：

```
/ 今天北京天气怎么样
```

**只有 @机器人 或带唤醒前缀的消息会让它开口**，群里其他聊天一律不理——这是刻意的，避免插嘴。

### 指令

| 指令 | 作用 | 权限 |
| --- | --- | --- |
| `/ask <问题>` | 直接提问（等价于 @机器人 说话） | 所有人 |
| `/reset` | 清空当前会话记忆 | 群管理员 |
| `/new` | 开始新对话（同 reset） | 群管理员 |
| `/stop` | 打断正在进行的回答（保留记忆） | 所有人 |
| `/persona <名字>` | 切换本会话的人格 | 群管理员 |
| `/stats` | 看本会话用量 | 所有人 |
| `/status` | 看当前模型与状态 | 所有人 |
| `/help` | 列出所有指令 | 所有人 |
| `/skill <id> [任务]` | 激活一个技能 | 所有人 |
| `/schedule` | 管理定时任务 | 所有人 |

指令和聊天互斥：命中指令的消息不会再进模型。

### 常用配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `wake_prefix` | `/` | 以此开头的消息唤醒 Agent，并剥掉前缀 |
| `friend_needs_wake_prefix` | 关 | 单聊默认任何消息都触发；打开后单聊也要带前缀 |
| `rate_limit_per_minute` | `10` | 每会话每分钟最多几次对话，0 = 不限 |
| `max_context_tokens` | `12000` | 上下文估算超过就压缩 |
| `content_filter_keywords` | 空 | 命中即拒绝（逗号分隔），入站出站都查 |
| `personas` | 空 | 多套人格，每套含提示词、开场对话、工具/技能限制 |

完整配置见[配置说明](./docs/configuration.md)，管理页里能改的项比配置表单更全。

## 管理页

面板侧栏「**插件页面 → Agent**」。模型、人格、工具开关、技能、会话绑定、定时任务都在这里改，点完立即生效，不用重新构建。

需要直接改配置表单的只有几项：压缩、频次、内容安全、搜索 Key。

## 文档

| 文档 | 内容 |
| --- | --- |
| [快速开始](./docs/quickstart.md) | 从零装起来 |
| [配置说明](./docs/configuration.md) | 每个配置项的含义与取舍 |
| [工具与权限](./docs/tools.md) | 工具清单、权限怎么算、安全防线 |
| [Skills](./docs/skills.md) | 渐进披露、SKILL.md 格式 |
| [开发指南](./docs/development.md) | 架构、存储分层、加工具/配置、来源与许可 |
| [排障](./docs/troubleshooting.md) | 症状 → 原因、日志说明、已知限制 |

遇到问题先看[排障](./docs/troubleshooting.md)，已知限制（Gemini 思考模型、MCP、可观测性等）也都记在那里。

## 开发

SDK 和构建工具不发 npm，要先把 QFlareBot 克隆到旁边：

```bash
git clone https://github.com/QFlareBot/QFlareBot ../qqbot-workers
(cd ../qqbot-workers && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)

npm install
npm run typecheck
npm test
npm run build
npm run sync     # 生成 manifest.json 并提交
```

架构说明、目录结构、怎么加工具和配置项，见[开发指南](./docs/development.md)。

## License

MIT。本插件参考了 [serverless-agent](https://github.com/clown145/serverless-agent)（GPL-3.0-or-later）的结构，其中三个零依赖的纯函数文件是原样复制的——**存在许可证冲突，详见[开发指南的「来源与许可证」](./docs/development.md#来源与许可证)**。
