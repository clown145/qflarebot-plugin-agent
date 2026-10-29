# qflarebot-plugin-agent

QFlareBot 的 Agent 插件：带工具调用的多轮对话、会话记忆、联网查资料、动态定时任务。

需要配合 [qflarebot-plugin-llm](https://github.com/clown145/qflarebot-plugin-llm) 使用——本插件不含模型接入，只通过它的 `llm` 服务调用模型。

**这是必需依赖**（`depends: { llm: '*' }`）：没装 LLM 插件时，面板安装会被直接拦下并提示先装提供者。装了之后如果又把它停用或卸载，Agent 会回复「需要的 LLM 接口插件没有启用」，而不是抛内部错误。

## 它做什么

- **多轮对话**：每个会话（群 / 单聊）一段独立记忆，存在 Durable Object 里。
- **工具调用**：模型可以联网查资料、发 HTTP 请求、看时间、读写工作区文件、建定时任务。每类工具都有独立的权限级别。
- **群聊/单聊都能用**：群里 @机器人 直接说话，不用打命令。

## 什么时候会回复（唤醒）

对标 AstrBot 的 waking check：**群里 @机器人 说人话就会回复，不需要打指令**。
没命中任何指令的消息走 Agent，命中指令的走指令——两者天然互斥（命令默认 `block`）。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `wake_mode` | `at` | 群聊触发方式：`at`（仅 @）/ `at_or_prefix`（@、前缀、或引用机器人）/ `all`（群里所有消息，需群主在 QQ 里给机器人开「接收全部消息」） |
| `wake_prefix` | `/` | `at_or_prefix` 模式下以此开头的消息也算唤醒 |
| `friend_needs_wake_prefix` | 关 | 单聊默认任何消息都触发；打开后单聊也要带前缀 |
| `command_prefixes` | `/` | 以此开头的消息交给指令，不会当聊天发给模型 |

> `all` 模式依赖 QQ 平台能力：群主必须给机器人开启「接收全部消息」，否则平台不推送非 @ 消息，
> 插件收不到也就谈不上唤醒。这是平台限制，不是配置问题。

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

面板侧栏「插件页面 → Agent」。**能点的都比去配置里填方便**：

| 区块 | 交互 |
| --- | --- |
| 模型 | 下拉选择器，别名来自 LLM 插件（不用手打），点一项立即生效；另有连通性测试 |
| 系统提示词 | 直接编辑保存，不必去配置页；可一键恢复成配置里的值 |
| 会话 | 列出最近绑定人格的会话，每行一个下拉，选了即生效 |

页面用宿主的 `--qb-*` 设计 token（同内置 t2i 插件），跟随面板主题。
真正细碎的开关（唤醒方式、步数上限、人格列表本身）仍在面板「插件 → Agent → 插件配置」。

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

tag 自己定，只要不与已有的重复；类名 `P_agent_Agent` 不能改——它由投影器按
`P_<插件名>_<类名>` 生成，插件里的导出类名与清单里的键都必须叫 `Agent`。

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
| `enable_vfs` | 关 | 虚拟工作区：模型可读写文件。小文本存 D1，>8KB 存 R2（**需要绑定 R2**，未绑定时整组工具不注册） |
| `enable_schedule` | 关 | 动态定时任务 |
| `enable_audit` | 关 | 工具调用写 D1，排障用 |
| `show_typing` | 开 | 单聊"正在输入" |
| `timezone` | Asia/Shanghai | 影响时间工具与提示词 |

## 工具与权限

权限是 6 级 + scope 的模型（照搬 serverless-agent），与 QFlareBot 的
「命令能不能触发」是三档是两回事：命令门槛决定插件能不能跑，
这里决定**模型能不能用某个工具**。

| 工具 | 级别 | scope | 谁能用 |
| --- | --- | --- | --- |
| `time.now` | 1 | — | 所有人 |
| `web.fetch_page` | 1 | — | 所有人（重定向逐跳校验，内网地址拒绝） |
| `vfs.read_file` / `list_dir` / `search` | 1 | `workspace:read` | 所有人（需开 `enable_vfs`） |
| `vfs.write_file` / `mkdir` | 2 | `workspace:write` | 群成员及以上 |
| `http.request` | 3 | `http:request` | 群主与管理员 |
| `vfs.delete` | 3 | `workspace:write` | 群主与管理员 |
| `schedule.create` / `cancel` | 3 | `schedule:write` | 群主与管理员（需开 `enable_schedule`） |
| `schedule.list` | 1 | — | 所有人（需开 `enable_schedule`） |

角色基线（`src/permissions/default-policy.ts`）：

| 角色 | 级别 | scope |
| --- | --- | --- |
| 群主 / 管理员 | 4 | workspace 读写 + web + http + schedule |
| 群成员 | 2 | workspace 读写 |
| 单聊 / 角色未知 | 1 | workspace 只读 |
| 定时任务（`actorId === 'scheduler'`） | 3 | 同群主 |

定时任务到点重放时以 `scheduler` 身份进 loop（不是创建者的 openid），所以管理员建的、
需要 `http.request` / `schedule.*` 的提醒到点不会被自己拦下。`created_by` 仍记在
`{schedules}` 表里，只是不参与权限判定。

单聊没有群角色，所以 `http.request` 和 `schedule.*` 在单聊里用不了——
这是有意的：单聊是陌生人就能触达的入口，不该让它直接发任意 HTTP 请求。

D1 里的 `{policies}` 表可以按 user / role / conversation / platform 叠加策略，
**只能放宽不能收紧**（`maxLevel` 取最大、scopes 求并）。目前没有管理页编辑入口，
需要手工写表。

`sideEffect: 'dangerous'` 或级别 5 的工具会先要求确认：模型会向用户要一句明确答复，
下一轮带上 `allowDangerous` 才真执行。目前没有这类工具，机制已就位。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/agent <问题>` | 问 Agent。群里 @机器人 直接说话也行 |
| `/agent reset` | 清空当前会话记忆 |
| `/agent persona` | 查看本会话的人格与可选列表 |
| `/agent persona <名字>` | 切换本会话的人格；`/agent persona off` 清除绑定 |
| `/agent status` | 查看模型别名、可用模型、开关状态 |
| `/agent schedule` | 查看本会话的定时任务 |
| `/agent schedule cancel <id>` | 取消本会话的一个定时任务 |

## 额度

按个人机器人的量级估算（免费版）：

| 项目 | 单次对话消耗 | 免费版额度 | 可支撑 |
| --- | --- | --- | --- |
| DO | 约 1–3 GB-s（8–25 秒），另加每 10 分钟一轮清理（每会话一次 RPC） | 13,000 GB-s/日 | 约 4,000–12,000 次/日 |
| D1 写 | 0 行（历史在 DO） | 100,000 行/日 | 不构成瓶颈 |
| KV 写 | 仅首次见到新会话时 | 1,000 次/日 | 够用 |
| Worker 请求 | 1 次/消息 + cron 1,440/日 | 100,000 次/日 | 够用 |

会话列表上限 20 个：每多记一个会话，清理轮就多一次 DO 唤醒（每天 144 次）。
个人机器人够用；被挤掉的会话下次有消息进来会重新记到列表末尾。

**免费版能用**。CPU 是唯一需要留意的：免费版 Worker 请求与 cron 都是 10 ms CPU（I/O 等待不计入），一次多步工具调用的 loop 可能接近这个量。真撞到限制（表现是整个 Worker 偶发 1102）有两个解法：

1. 调小 `max_model_steps`（默认 8，可以降到 4）。
2. 把 loop 挪进 DO 跑——DO 的 CPU 上限比 Worker 请求宽得多（serverless-agent 就是这么做的：它的 agent loop 跑在 DO 的 `alarm()` 里，所以免费版够用）。本插件目前 loop 在事件处理器与 cron 里跑，挪进 DO 需要框架再给 `DurableContext` 加 `service()`（现在只有 `api`），是后续可以做的优化。

付费版（$5/月）把这两个限制都放开，省心。

## 管理页

面板侧栏「插件页面 → Agent」，四块内容：

| 区块 | 内容 |
| --- | --- |
| 模型 | 当前别名、可用别名列表、连通性测试 |
| 能力 | 各开关状态、步数与工具上限、历史条数、时区 |
| 定时任务 | 全部会话的待触发任务：触发时间、会话、内容、是否重复 |
| 工具调用 | 最近的工具调用记录（需开 `enable_audit`） |
| 统计 | 最近 14 天的对话数、失败数、工具调用数 |

工具调用记录默认是空的——`enable_audit` 打开后才会往 D1 写。
每记一条约消耗 1 行 D1 写入额度（免费版 10 万行/日），所以默认关。

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
