# 开发指南

## 环境准备

SDK 与构建工具不发布到 npm，需要先把 QFlareBot 克隆到旁边并构建：

```bash
git clone https://github.com/QFlareBot/QFlareBot ../QFlareBot
(cd ../QFlareBot && pnpm install && pnpm --filter '@qqbot/plugin-cli...' build)

npm install
npm run typecheck
npm test
npm run build
npm run sync     # 把 dist/manifest.json 复制到仓库根目录，需要提交
```

> **`npm run sync` 是必须的**。`manifest.json` 由构建生成，仓库根目录那份要提交。
> 忘了同步会让 `manifest.test.ts` 失败 —— 这是**刻意设计的哨兵**，
> 防止你改了 `index.ts` 的 commands/events/routes/cron 却忘了更新清单。

## 测试组织

- 测试就近放在被测模块旁，使用 `*.test.ts` 和 Vitest；用例名延续中文场景描述。
- `src/page.test.ts`、`src/page-syntax.test.ts` 检查静态页面和内联脚本；`src/page/interactions.test.ts` 在 jsdom 中执行页面脚本，检查保存、草稿和键盘操作。
- DOM 测试由 `src/page/tsconfig.json` 单独检查类型，Worker 代码仍使用根配置；`npm run typecheck` 会同时运行两套检查，`npm test` 会自动选择测试环境。
- `tests/integration/cross-plugin.test.ts` 通过测试入口使用相邻 `../QFlareBot` 的真实运行时和 T2I 提供者，覆盖事件入口、工具路由、SQLite 作用域、图片交付和冷恢复。模型、网络和平台存储绑定是测试替身；框架需安装完整工作区依赖，不能仅安装 SDK/CLI。
- DO 单测与队列集成测试共用 `src/do/agent-test-object.ts`；SQLite 替身沿用 `src/store/sqlite-test-db.ts`。每个用例自行创建状态，结束后清理计时器、监听器和模拟函数。

## 架构

```text
QQ 消息 ──> events 处理器（30 秒硬窗）
              │
              ├─ 内容安全检查（入站）
              ├─ wake 判定 → 剥前缀
              ├─ DO.submit()  ← 频率限制在这里
              │     ├─ 抢到执行权 → 立刻跑 loop（软预算 18 秒）
              │     └─ 没抢到     → 入队，等 cron
              │
cron（每分钟）──> ① 兜底捡队列里的 run
                  ② 触发到期的定时任务
                  ③ 清理过期数据（节流到 10 分钟）
```

### 双段式调度（这是本插件最核心的设计）

**同一个 `executeRun`，两个调用点**：事件处理器追求「秒回」，cron 负责兜底。

事件路径在 18 秒时提示仍在处理，按 24 秒预算预留保存和回复时间。`waitUntil`
不能重置原请求的后台时限，所以每次模型/工具调用前都会检查剩余预算；不足就保存检查点，
把同一个 run 放回队首。cron 每分钟扫描 D1 的 `{recovery}` 索引，整轮预算 55 秒。

检查点包含消息、模型结果、待执行工具、工具结果、累计步数/用量、回复投递游标和框架工具 ID/revision。原始调用凭据保存在入站消息中，跨请求继续使用，不传给模型。
恢复从未完成的位置继续；所有写回都带租约令牌，旧执行者不能覆盖新执行者。
工具开始前先记录意图，结果保存后才继续：中断时结果未知的写操作不会自动重试，
只读操作可重试。这不等于外部系统的 exactly-once，需要工具端幂等才能消除未知结果窗口。

恢复索引在入队前登记，扫描完成用令牌做条件更新，避免删除刚有新消息的会话。
新登记保留两分钟入队宽限期；终态 run 保留十分钟后清理，空闲会话随后移出索引。
KV 最近会话列表只用于管理页与旧版迁移，不再限制可恢复会话数量。

### 为什么 DO 不跑 agent loop

试过，行不通，两层原因：

1. **DO 是独立 isolate**，Worker 侧无法把执行函数注入进去。
2. **DO 里拿不到 `ctx.service()`**（`DurableContext` 只有 `plugin/logger/kv/db/r2/api`），
   而 loop 要调 plugin-llm 的 `llm` 服务。

所以分工是：**DO 只做持久化状态**（锁、队列、历史、摘要、检查点、频次窗口），
**Worker/cron 跑 loop**（两处都有完整 `ctx`）。

## 存储分层

这是按宿主免费版额度反推出来的：

| 数据 | 存哪 | 为什么 |
| --- | --- | --- |
| 会话历史 / run 队列 / 检查点 / 摘要 / 频次窗口 | DO storage | 保留逐步进度；图片与较大 JSON 分片写入，事务保证原子性 |
| 待恢复会话索引 | D1 | 每次入队登记，跨会话查询可恢复的工作，空闲后移除 |
| 定时任务 / 工具开关 / Skills / 统计 / 审计 | D1 | 需跨会话查询，写入频率低 |
| 最近会话清单 | KV | 管理页展示和旧版迁移，不承担新任务恢复 |
| 大文件工作区内容 | R2 | >8KB 的文本进 R2，不占 D1 单值空间 |

**额度的硬约束**（免费版，全机器人所有插件共享）：

| 项 | 额度 | 对设计的影响 |
| --- | --- | --- |
| D1 写 | 10 万行/日 | 所以**不做 run_steps 逐步落库**；审计默认关；统计一天一行 |
| KV 写 | 1,000 次/日 | 所以会话清单只在收到消息时写、且有去重；频次计数放 DO 不放 KV |
| DO | 13,000 GB-s/日 | 按恢复索引唤醒到期会话；清理完成后不再每分钟唤醒 |
| 每次调用 CPU | 10ms（全机器人共享） | 所以不装 tokenizer；压缩用字符估算 |
| 每次调用子请求 | 50 | 所以不调外部审核 API；媒体优先给 URL 不转 base64 |
| 一次事件 | 后台窗口 30 秒（所有插件共享） | 18 秒提示等待、24 秒执行预算；cron 独立采用 55 秒预算 |

> **D1 写入是按「改动的行数」算的，不是按语句条数**：`INSERT OR REPLACE` 带一个索引
> 算 3 行，UPSERT 改同一行算 2 行，`WITHOUT ROWID` 无额外索引的表插入算 1 行。
> 所有表都用 `WITHOUT ROWID` 就是这个原因。

## 目录结构

```text
src/
  index.ts            插件定义：命令、事件、cron、路由、DO 声明
  types.ts            内部类型（对齐 serverless-agent 的协议）
  config/index.ts     配置 schema 与默认值
  effective-config.ts ctx.config + KV 覆盖层
  runtime-config.ts   KV 覆盖层的读写
  do/agent-object.ts  DO：会话锁、run 队列、历史、频次窗口
  agent/
    inbound.ts        Session → InboundMessage
    context.ts        上下文装配
    context-size.ts   压缩 + 工具配对修复（纯函数，零存储）
    loop.ts           agent loop
    run.ts            一次 run 的编排
    safety.ts         内容安全
    wake.ts           唤醒判定
    media.ts          图片下载转 base64
    tool-executor.ts  单次工具调用
  skills/             SKILL.md 解析、存储、上下文注入
  llm/                plugin-llm 契约与适配
  permissions/        角色基线 + 策略解析
  tools/              工具实现 + catalog
  store/              D1 schema 与访问
  routes.ts           管理页 API
  page.ts             管理页（单 HTML）
docs/                 本文档
```

## 加一个新工具

1. 新建 `src/tools/xxx.ts`，导出 `createXxxTools(): RegisteredTool[]`
2. 照着 `src/tools/web.ts` 填 `definition`（**权限级别、sideEffect、timeoutMs 必须都填**）
3. 在 `src/agent/run.ts` 的 `buildRegistry` 里 push 进去
4. 写测试（用 `vi.stubGlobal('fetch', ...)` mock 网络）
5. `npm run typecheck && npm test`

**权限级别怎么选**：1 = 只读外部信息；2 = 写自己的工作区；3 = 对外产生副作用
（发 HTTP、建定时任务、删文件）；4 = 群管理；5 = 需要二次确认。
**给 3 以上就要想清楚**：目前二次确认闭环是断的（见 [工具与权限](./tools.md#二次确认当前是半成品)）。

## 加一个新配置项

1. 在 `src/config/index.ts` 加到 `AgentConfig` 接口
2. 加到 `defaultConfig`（**默认值要保守**，见上面的额度约束）
3. 加到 `configSchema`（面板用它渲染表单）
4. `npm run build && npm run sync` 更新 `manifest.json`
5. 生产代码里**一律用 `resolveConfig(ctx)`**，不要直接用 `ctx.config`

## 测试

```bash
npm test              # 全部
npx vitest run src/agent/context-size.test.ts   # 单个文件
npm run typecheck
```

测试覆盖 agent loop / 上下文 / 权限 / DO 队列 / D1 访问 / 唤醒 / 管理页 / cron /
压缩 / 内容安全 / 搜索，以及冷启动后的历史、摘要与检查点恢复。

**写测试时的约定**：
- 用 `vi.stubGlobal('fetch', ...)` mock 网络，不要真的发请求
- D1 用 `src/store/d1.test.ts` 里的 fake `PluginDB` 模式
- 断言「行为」而不是「实现细节」，否则重构会误报
- **改配置默认值时，记得同步改相关的硬上限**（例如 `history_limit` 与
  `MAX_HISTORY_ROWS` 有联动，写在注释里了）

## 来源

本插件的设计参考了 [serverless-agent](https://github.com/clown145/serverless-agent)
与 [AstrBot](https://github.com/AstrBotDevs/AstrBot)。

**三个原样复用的文件**（都来自 serverless-agent）：

| 文件 | 处理 |
| --- | --- |
| `src/tools/http/url-safety.ts` | 复用 151 行 + 5 行类型收窄 |
| `src/tools/web/extract.ts` | 复用 172 行，逐字节一致 |
| `src/tools/vfs/path.ts` | 复用 69 行，只改中文错误信息 |

serverless-agent 与 AstrBot 都是各自形态下的完整实现，直接照搬会水土不服，
所以其余部分是**参考结构重写**：从 AstrBot 借的是**语义**（唤醒规则、人格优先级、
按轮压缩、内容安全双插入点），代码是重新写的。

## 提交前

```bash
npm run typecheck && npm test && npm run build && npm run sync
```

`manifest.test.ts` 会验证根目录的 `manifest.json` 与源码抽取结果逐字段一致。


## 跨仓库工具集成测试

普通 `npm test` / `npm run typecheck` 只需要 SDK/CLI，不加载框架 runtime。
`npm run test:integration` 和 `npm run typecheck:integration` 单独验证真实框架服务解析、T2I、Agent loop 与 DO 恢复；仅替代平台绑定、LLM 和网络，未访问线上 T2I 服务。

框架与插件按 CI 布局并排放置（`../QFlareBot`）。先在框架执行 `pnpm install --frozen-lockfile` 和 `pnpm --filter '@qqbot/plugin-cli...' --filter '@qqbot/projector...' build`，再运行集成检查。测试通过公开的 `@qqbot/runtime/testing` 入口加载框架，不在普通单元测试中深层导入 runtime 内部文件。

CI 将集成测试放在独立 job，安装完整框架依赖；两个 job 默认固定使用已验证的框架提交 `da54b159b7a0321c0a54075b33fa2fcc6fd257d1`，可通过 `QFLAREBOT_REF` 仓库变量覆盖。联合发布时先合入并推送框架，再更新两处默认 ref 和此处记录，随后合入 Agent，保证干净环境能取得配套的 SDK 与测试入口。覆盖 ref 时也应使用已验证的 commit/tag；旧框架缺少新 SDK 类型和测试入口，CI 会失败。
