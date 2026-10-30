# 开发指南

## 环境准备

SDK 与构建工具不发布到 npm，需要先把 QFlareBot 克隆到旁边并构建：

```bash
git clone https://github.com/QFlareBot/QFlareBot ../qqbot-workers
(cd ../qqbot-workers && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)

npm install
npm run typecheck
npm test
npm run build
npm run sync     # 把 dist/manifest.json 复制到仓库根目录，需要提交
```

> **`npm run sync` 是必须的**。`manifest.json` 由构建生成，仓库根目录那份要提交。
> 忘了同步会让 `manifest.test.ts` 失败 —— 这是**刻意设计的哨兵**，
> 防止你改了 `index.ts` 的 commands/events/routes/cron 却忘了更新清单。

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

关键正确性细节：**内联超时不能丢弃 Promise**。上一版用 `Promise.race` 直接放弃等待，
结果原任务继续跑完并回复，同时 cron 因租约到期把同一个 run 重跑一遍 ——
用户收到两条回复、还写了两份历史。正确做法是超时只停止「等待」，
任务本身仍然跑完并自己 `release`。

### 为什么 DO 不跑 agent loop

试过，行不通，两层原因：

1. **DO 是独立 isolate**，Worker 侧无法把执行函数注入进去。
2. **DO 里拿不到 `ctx.service()`**（`DurableContext` 只有 `plugin/logger/kv/db/r2/api`），
   而 loop 要调 plugin-llm 的 `llm` 服务。

所以分工是：**DO 只做持久化状态**（锁、队列、历史、频次窗口），
**Worker/cron 跑 loop**（两处都有完整 `ctx`）。

## 存储分层

这是按宿主免费版额度反推出来的：

| 数据 | 存哪 | 为什么 |
| --- | --- | --- |
| 会话历史 / run 队列 / 频次窗口 | DO storage | 每条消息本来就要唤醒 DO，放这里**完全不碰 D1** |
| 定时任务 / 工具开关 / Skills / 统计 / 审计 | D1 | 需跨会话查询，写入频率低 |
| 会话清单 | KV | 只存一个列表，读多写少 |
| 大文件工作区内容 | R2 | >8KB 的文本进 R2，不占 D1 单值空间 |

**额度的硬约束**（免费版，全机器人所有插件共享）：

| 项 | 额度 | 对设计的影响 |
| --- | --- | --- |
| D1 写 | 10 万行/日 | 所以**不做 run_steps 逐步落库**；审计默认关；统计一天一行 |
| KV 写 | 1,000 次/日 | 所以会话清单只在收到消息时写、且有去重；频次计数放 DO 不放 KV |
| DO | 13,000 GB-s/日 | 所以 cron 清理节流到 10 分钟一次；空转不唤醒 |
| 每次调用 CPU | 10ms（全机器人共享） | 所以不装 tokenizer；压缩用字符估算 |
| 每次调用子请求 | 50 | 所以不调外部审核 API；媒体优先给 URL 不转 base64 |
| 一次事件 | 30 秒（所有插件合计） | 所以内联预算 18 秒、cron 整轮 20 秒 |

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

616 个测试分布在 36 个文件里，大致是：agent loop / 上下文 / 权限 / DO 队列 / D1 访问 /
唤醒回归 / 管理页结构 / cron / 压缩 / 内容安全 / 搜索。

**写测试时的约定**：
- 用 `vi.stubGlobal('fetch', ...)` mock 网络，不要真的发请求
- D1 用 `src/store/d1.test.ts` 里的 fake `PluginDB` 模式
- 断言「行为」而不是「实现细节」，否则重构会误报
- **改配置默认值时，记得同步改相关的硬上限**（例如 `history_limit` 与
  `MAX_HISTORY_ROWS` 有联动，写在注释里了）

## 来源与许可证

本插件的设计来自 [serverless-agent](https://github.com/clown145/serverless-agent)
（GPL-3.0-or-later）与 [AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0）。

**原样复制**的三个文件（都是 serverless-agent）：

| 文件 | 处理 |
| --- | --- |
| `src/tools/http/url-safety.ts` | 原样复制 151 行 + 5 行类型收窄 |
| `src/tools/web/extract.ts` | 原样复制 172 行，逐字节一致 |
| `src/tools/vfs/path.ts` | 原样复制 69 行，只改中文错误信息 |

> ⚠️ **许可证冲突**：本插件是 MIT，而这三个文件是 **GPL-3.0-or-later**。
> 把 GPL 代码并入 MIT 项目并以 MIT 分发，与 copyleft 要求冲突。
> 要合规，要么把这三个文件单独按 GPL 声明，要么重写它们 ——
> 三者都是零依赖的纯函数，重写成本很低。

其余部分是**参考结构重写**，不是复制。从 AstrBot 借的是**语义**（唤醒规则、
人格优先级、按轮压缩、内容安全双插入点），代码是重新写的。

## 提交前

```bash
npm run typecheck && npm test && npm run build && npm run sync
```

`manifest.test.ts` 会验证根目录的 `manifest.json` 与源码抽取结果逐字段一致。
