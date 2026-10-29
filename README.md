# qflarebot-plugin-agent

QFlareBot 的 Agent 插件：带工具调用的多轮对话、会话记忆、联网查资料、动态定时任务。

需要配合 [qflarebot-plugin-llm](https://github.com/clown145/qflarebot-plugin-llm) 使用——本插件不含模型接入，只通过它的 `llm` 服务调用模型。

**这是必需依赖**（`depends: { llm: '*' }`）：没装 LLM 插件时，面板安装会被直接拦下并提示先装提供者。装了之后如果又把它停用或卸载，Agent 会回复「需要的 LLM 接口插件没有启用」，而不是抛内部错误。

## 它做什么

- **多轮对话**：每个会话（群 / 单聊）一段独立记忆，存在 Durable Object 里。
- **工具调用**：模型可以联网搜索、抓网页、发 HTTP 请求、看时间、读写工作区文件、建定时任务。每类工具都有独立的权限级别。
- **群聊/单聊都能用**：群里 @机器人 直接说话，不用打命令。
- **长会话不爆炸**：上下文超阈值时按「轮」压缩（丢最老的整轮），工具调用与结果永远成对。
- **防刷屏**：每会话每分钟有频次上限；可选关键词内容安全（入站 + 出站都查）。
- **工具可逐个开关**：管理页里关掉的工具**根本不注册**，模型看不到也就不会去试。
- **Skills**：可复用的能力包。每轮只注入目录（≤40 行），`/skill <id> <任务>` 激活后才载入全文。

## 文档

完整文档在 [`docs/`](./docs/)：

| 文档 | 内容 |
| --- | --- |
| [快速开始](./docs/quickstart.md) | 装、配、跑起来 |
| [配置说明](./docs/configuration.md) | 每个配置项的含义与取舍 |
| [工具与权限](./docs/tools.md) | 工具清单、权限怎么算、工具栏、安全防线 |
| [Skills](./docs/skills.md) | 渐进披露、SKILL.md 格式、接口 |
| [开发指南](./docs/development.md) | 架构、存储分层、加工具/配置、来源与许可证 |
| [排障](./docs/troubleshooting.md) | 症状 → 原因、日志说明、已知限制 |

## 上下文压缩

长会话的上下文会一直变长，直到一次请求贵到不可接受。这里按 AstrBot 的做法**按「轮」压缩**：
一轮 = 一个用户消息 + 紧随其后的所有 assistant/tool 消息，所以丢轮时
**工具调用和它的结果永远不会分家**（配对是结构上保证的，不靠事后修补）。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `context_compression` | `truncate` | `truncate` 丢最老整轮；`summary` 目前同样退化为丢轮；`off` 只按历史条数截断 |
| `max_context_tokens` | `12000` | 估算超过就压缩。真实用量由模型返回后覆盖估算 |

**不消耗 D1 / KV 额度**：压缩是纯内存计算，零额外模型调用、零额外存储写入。
token 按字符估算（CJK 约 0.6/字、其他约 0.3/字符，与 AstrBot 同源），
不需要装 tokenizer —— 那会让 Worker 包体积涨几百 KB，还要花 CPU 去算。

## 防滥用

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `rate_limit_per_minute` | `10` | 每会话每分钟最多几次对话，0 = 不限。被限时回一句提示，不静默丢弃 |
| `content_filter_keywords` | 空 | 命中即拒绝（逗号分隔），留空 = 关闭。入站和出站都查 |

频次计数放在 **Durable Object 里**，不放 KV / D1：这是每条消息都要读写的热路径，
免费版 KV 写只有 1,000 次/日、D1 写 10 万行/日（全机器人共享），放上去会直接打满额度；
DO storage 按 GB-秒计费，而每条消息本来就要唤醒一次 DO，计数等于零额外成本。

内容安全只做**纯文本关键词**：真审核要调外部 API，而免费版每次调用只有 50 个子请求、
一次事件 30 秒预算，为审核花一个子请求在群聊高频场景下不划算。

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
| `personas` | 空 | 每套含 `name`、`prompt`、`begin_dialogs`、`tools`、`skills`、`custom_error_message` |
| `default_persona` | 空 | 会话没绑定时用哪套；留空则不加人格段落 |

优先级：**会话绑定 > `default_persona`**。绑定的那套被删掉时会回落，
不会让会话突然失去人格。

**人格提示词是追加，不是替换**（与 AstrBot 一致）：系统提示词 = 基础提示词
+ `# Persona Instructions` 段落 + 运行时环境（时间/会话/工具规范/回复格式）。
配人格不会丢掉落这些运行时约定。详见 [配置说明](./docs/configuration.md#人格提示词是追加不是替换)。

**每套人格可以限制工具与技能**（`tools` / `skills`，留空 = 不限，`[]` = 一个都不给），
并自定义出错文案（`custom_error_message`）。

`begin_dialogs` 是 AstrBot 的同名字段：每轮插在历史最前面、用来锚定说话风格（不属于会话记忆），
每行一句，`user:` / `assistant:` 开头。

会话级别用 `/agent persona <名字>` 切换，也可以在插件管理页「会话」里直接下拉改绑。

> **命令权限**：`/agent reset` 与 `/agent persona` 是 `group_admin` 门槛
> （清空记忆、改整群人格都是影响所有人的操作）；其余命令人人可用。

## 管理页

面板侧栏「插件页面 → Agent」。**所有能改的都在这里改**——不必去面板的插件配置表单：

| 区块 | 交互 |
| --- | --- |
| 模型 | 下拉点选（别名来自 LLM 插件，不用手打），立即生效 |
| 人格 | 增删改每套人格（名字 / 提示词 / 开场对话），选默认人格；立即生效 |
| 系统提示词 | 直接编辑保存，可恢复成配置里的值 |
| 群聊唤醒 | 唤醒前缀、单聊是否要前缀、指令前缀 |
| 能力开关 | 工具调用、虚拟工作区、定时任务、技能、审计、正在输入 |
| **工具** | 每个工具一个开关；关掉的整行压暗划线，立即生效 |
| **技能** | 卡片列表 + 新增/编辑/删除；编辑器里写完整 SKILL.md |
| 限额 | 步数、工具调用数、历史条数、超时、时区 |
| 会话 | 列出绑过人格的会话，每行下拉改绑或清除 |
| 定时任务 / 工具调用 / 统计 | 只读表格 |

页面的改动存在插件自己的存储里，**覆盖**面板配置（面板配置是权威默认值），
所以点完立即生效、不用等构建。改回原值时覆盖自动消失；
底部可一键全部恢复。页面用宿主的 `--qb-*` 设计 token，跟随面板主题。

> **说明**：只有「系统提示词」和「模型」两项在字段旁显示「已改」标记，
> 其余字段的覆盖状态体现在页面顶部的汇总计数里。
> 压缩、频次、内容安全、搜索 Key 这几项目前只能在面板的插件配置表单里改（页面还没做控件）。

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
  do/agent-object.ts  Durable Object：会话锁、run 队列、历史、频次窗口
  agent/
    inbound.ts        Session → InboundMessage 归一化
    context.ts        上下文装配（系统提示词 + 历史 + 本轮）
    context-size.ts   上下文压缩 + 工具调用配对修复（纯函数，零存储）
    loop.ts           agent loop（模型 → 工具 → 回填 → 再调）
    run.ts            一次 run 的完整编排
    safety.ts         内容安全（入站 + 出站关键词）
    wake.ts           唤醒判定
    media.ts          图片下载转 base64
    tool-executor.ts  单次工具调用（白名单 + 结果回填）
  llm/
    contract.ts       plugin-llm 的服务契约（本地声明）
    client.ts         契约适配 + 错误分类
  permissions/
    default-policy.ts 角色基线（群主/管理员/成员/单聊）
    policy-resolver.ts 策略解析（策略表无写入方）
  tools/
    registry.ts       工具注册表
    http.ts           http.request（含 SSRF 防护）
    web.ts            web.fetch_page
    search.ts         search.web（Tavily）
    time.ts           time.now
    schedule.ts       动态定时任务
    vfs/              虚拟工作区
  skills/
    frontmatter.ts    SKILL.md 解析
    store.ts          技能 CRUD（D1 单表）
    context.ts        目录 / 正文的提示词注入
  tools/
    catalog.ts        工具目录投影 + 单工具开关
  store/
    schema.ts         D1 表结构
    d1.ts             D1 数据访问
  routes.ts           管理页 API
  page.ts             管理页（单 HTML）
docs/                 完整文档
```

## 从 serverless-agent 搬了什么

本插件的设计来自 [serverless-agent](https://github.com/clown145/serverless-agent)（GPL-3.0-or-later）。
**原样复制**的是下面三个文件，其余是参考结构与思路后重写的：

| 来源 | 处理方式 | 说明 |
| --- | --- | --- |
| `src/tools/http/url-safety.ts` | 原样复制（151 行）+ 5 行类型收窄 | SSRF 黑名单，零依赖 |
| `src/tools/web/extract.ts` | 原样复制（172 行） | HTML → 文本，零依赖 |
| `src/vfs/core/path.ts` | 原样复制（69 行） | 路径归一化，改中文错误信息 |
| `src/core/agent-tool-loop.ts` | 参考结构重写 | 保留双限额、超限抛错 |
| `src/core/agent-tool-executor.ts` | 参考结构重写 | 保留白名单、`preventsFinalResponse`（**机制在位，当前没有工具用它**） |
| `src/core/agent-context.ts` | 参考结构重写 | 历史回放；**工具调用改为存摘要**（见下） |
| `src/context/context-loader.ts` | 参考思路重写 | 压缩改为**纯内存丢轮**，不落 D1、不调摘要模型 |
| `src/tools/registry/tool-registry.ts` | 参考结构重写 | 保留权限→执行→审计顺序，审计改可选 |
| `src/permissions/*` | 参考结构重写 | 6 级 + scope 类型、角色基线；**策略叠加没有写入方**（见下） |
| `src/agents/agent-mailbox*` | 参考思路重写 | 租约、FIFO 队列、终态清理；恢复靠 cron 的 10 分钟清理轮而不是 `alarm()`（DO 里没有 `ctx.service()`，跑不了 loop） |
| `src/tools/time/tools.ts` | 参考重写 | 时区处理 |
| `src/tools/schedule/*` | 参考协议重写 | 去掉 Queue 依赖，改 cron 扫表 |
| `src/tools/search/*` | 参考协议重写 | 只实现 Tavily；结果信封带 `index`（可引用） |
| `src/tools/vfs/*` | 参考设计重写 | 砍掉 revisions，小文本 D1 / 大文件 R2；覆盖大文件时会删掉旧 R2 对象 |

**没有搬**（约 16,600 行代码 + 约 11,200 行管理前端）：

- `src/adapters/`（5,741）——QFlareBot 的 `session` / `ctx.api` 更强
- `src/worker/`（5,866）——插件用 `routes` 与 `cron`
- `src/core/model/`（2,358）——plugin-llm 已覆盖
- `src/rayneo/`（1,390）、`src/platforms/`（1,260）——私有协议
- `apps/admin-web/`（11,165）——插件 UI 走单 HTML 起步；多文件也可行（宿主有 `serveAssets`），只是要自己打包

## 已知限制

- **Gemini 思考模型的多轮工具调用不可用**：plugin-llm 的契约要求把 `thought_signatures`
  原样回传（Gemini 2.5/3.x 对 functionCall part 的签名严格校验，缺了直接 400），
  而本插件的本地契约副本没有这个字段。用 Gemini 非思考模型或 OpenAI 兼容协议没影响。
- **没有 run/step 级可观测性**：不做 `runs` / `run_steps` / `tool_calls` 落库（D1 写额度是
  全机器人共享的 10 万行/日）。排障走 Workers Logs，工具调用记录是可选开关。
  换来的是每条消息**完全不碰 D1**——这是按宿主额度做的刻意取舍，不是妥协。
- **没有 skills / MCP / pending-action 确认闭环**。
  - skills：QFlareBot 的「插件」是部署单元，没有「模型运行时改写工作区文档」的语义。
  - MCP：stdio 传输在 Worker 里结构上不可能（没有子进程）；HTTP 传输可行但要维护
    一整套传输/会话代码，为一个部署不值。`ToolSourceType` 已预留 `'mcp'`。
  - 二次确认：**协议实现了一半**。`needs_confirmation` 状态、`requiresConfirmation()`、
    registry 提前返回都在，但没有把用户答复变回 `allowDangerous: true` 的通道，
    所以任何 `sideEffect: 'dangerous'` 的工具会永久卡在待确认。目前没有这种工具，
    因此是潜在问题而非现行故障。
- **`{policies}` 策略表没有写入方**：全仓库只有建表和查询，没有 INSERT/UPDATE，
  面板也没有入口。真实行为就是 `default-policy.ts` 的角色基线
  （群主/管理员/成员/单聊各一档）。想用策略叠加只能手工往 `p_agent_policies` 写。
- **单聊权限已放宽到 level 3**：早期单聊用户因为「没有群角色」被判成陌生人（level 1），
  导致「提醒我三小时后…」这类最典型的单聊用法反而用不了。现在 1:1 信道按可用基线处理，
  但**仍然不给 level 4**（单聊用户不是群主）。

## 许可证提示

本插件是 MIT，而 serverless-agent 是 **GPL-3.0-or-later**。上面三个「原样复制」的文件
是 GPL 代码，被并入并分发在 MIT 项目里 —— 这与 GPL 的 copyleft 要求冲突。
要合规，要么把这三个文件按 GPL 单独声明，要么重写它们（都是零依赖的纯函数，重写成本很低）。

## License

MIT
