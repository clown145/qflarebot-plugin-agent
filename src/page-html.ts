/**
 * 管理页的 HTML 结构。
 *
 * 页内标签 + 五个面板（模型与人格 / 对话行为 / 工具 / 技能 / 运行数据）。
 * 一屏只做一件事，不用在一长条卡片里翻找。
 *
 * 结构上的约定（`page.test.ts` 守这些）：
 * - 标签与面板的 `data-tab` / `data-panel` 一一对应
 * - 每块内容在语义正确的面板里（「限额」属于对话行为，不是技能）
 * - 用 `<body class="qb-page">` 拿宿主的底色与字体基线
 */
export const PAGE_HTML_BODY = `
<div class="wrap">
  <header class="page-head">
    <h1 class="page-title">Agent</h1>
    <p class="page-sub">开关和选项自动保存；提示词与人格编辑后点击保存。</p>
    <div class="save-status-row"><span id="saveStatus" role="status" aria-live="polite">加载中…</span><button class="qb-btn" id="retrySave" type="button" hidden>重试</button></div>
  </header>

  <!-- 页内标签：记在 # 里，刷新和分享停在同一处 -->
  <div class="segmented" id="segmented" role="tablist" aria-label="分区">
    <span class="seg-thumb" id="segThumb" hidden></span>
    <button class="seg-btn" role="tab" id="tab-model" aria-controls="panel-model" tabindex="0" data-tab="model" type="button" aria-selected="true">模型与人格</button>
    <button class="seg-btn" role="tab" id="tab-behavior" aria-controls="panel-behavior" tabindex="-1" data-tab="behavior" type="button" aria-selected="false">对话行为</button>
    <button class="seg-btn" role="tab" id="tab-tools" aria-controls="panel-tools" tabindex="-1" data-tab="tools" type="button" aria-selected="false">工具</button>
    <button class="seg-btn" role="tab" id="tab-skills" aria-controls="panel-skills" tabindex="-1" data-tab="skills" type="button" aria-selected="false">技能</button>
    <button class="seg-btn" role="tab" id="tab-data" aria-controls="panel-data" tabindex="-1" data-tab="data" type="button" aria-selected="false">运行数据</button>
  </div>

  <!-- ==================== 模型与人格 ==================== -->
  <section class="panel is-active" data-panel="model" role="tabpanel" id="panel-model" aria-labelledby="tab-model">
    <div class="stack">
      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">模型</h2>
            <p class="card-desc">来自「LLM 接口」插件。</p>
          </div>
          <div class="card-actions">
            <button class="qb-btn" id="testBtn" type="button">测试连通性</button>
            <span class="qb-muted" style="font-size: var(--qb-text-xs)" id="pingResult"></span>
          </div>
        </div>
        <div class="rows">
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">当前模型</p>
              <p class="setting-hint" id="modelHint">加载中…</p>
            </div>
            <div class="setting-control">
              <select class="qb-input" id="modelSelect" style="min-width: 12rem"></select>
            </div>
          </div>
        </div>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">人格 <span class="qb-muted" style="font-size: var(--qb-text-xs)" id="personaCount"></span></h2>
            <p class="card-desc">每个会话绑一套；不配则用系统提示词。</p>
          </div>
          <div class="card-actions">
            <button class="qb-btn qb-btn--primary" id="addPersona" type="button">新增人格</button>
            <button class="qb-btn" id="savePersonaList" type="button">保存</button>
          </div>
        </div>
        <div class="rows">
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">默认人格</p>
              <p class="setting-hint">会话没有专门绑定时用这套。</p>
            </div>
            <div class="setting-control">
              <select class="qb-input" id="defaultPersona" style="min-width: 10rem"></select>
            </div>
          </div>
        </div>
        <p class="qb-muted" id="personaState" role="status"></p><div id="personaList"></div>
      </section>
    </div>
  </section>

  <!-- ==================== 对话行为 ==================== -->
  <section class="panel" data-panel="behavior" role="tabpanel" id="panel-behavior" aria-labelledby="tab-behavior">
    <div class="stack">
      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">系统提示词</h2>
            <p class="card-desc">人格提示词会追加在它后面，不覆盖。</p>
          </div>
          <div class="card-actions">
            <button class="qb-btn qb-btn--primary" id="savePrompt" type="button">保存</button>
            <button class="qb-btn" id="resetPrompt" type="button">恢复配置值</button>
          </div>
        </div>
        <textarea class="qb-textarea" id="promptBox" aria-label="系统提示词" aria-describedby="promptState" placeholder="留空则用内置默认人格…"></textarea>
        <p class="qb-muted" style="font-size: var(--qb-text-xs); margin: var(--qb-space-2) 0 0" id="promptState"></p>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">群聊唤醒</h2>
            <p class="card-desc">群里只有 @ 它或以唤醒前缀开头才会回应。</p>
          </div>
        </div>
        <div class="rows">
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">唤醒前缀</p>
              <p class="setting-hint">非 @ 时以此开头的消息也会触发，前缀会被剥掉。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input mono-input" id="wakePrefix" style="width: 8rem" placeholder="/" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">单聊需要前缀才触发</p>
              <p class="setting-hint">关掉时私聊任何消息都会触发。</p>
            </div>
            <div class="setting-control">
              <button class="switch" id="friendPrefix" role="switch" aria-checked="false" aria-label="单聊需要前缀才触发" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">指令前缀</p>
              <p class="setting-hint">
                由宿主面板统一管理（命令命中后不会再进模型），这里不需要配。
              </p>
            </div>
            <div class="setting-control">
              <span class="badge">跟随面板</span>
            </div>
          </div>
        </div>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">能力开关</h2>
            <p class="card-desc">额度全机器人共享，默认值偏保守。</p>
          </div>
        </div>
        <div class="rows">
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">工具调用</p>
              <p class="setting-hint">总开关。关掉就是纯聊天。</p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="enable_tools" role="switch" aria-checked="false" aria-label="工具调用" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">虚拟工作区</p>
              <p class="setting-hint">模型可读写工作区文件。需要绑定 R2。</p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="enable_vfs" role="switch" aria-checked="false" aria-label="虚拟工作区" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">动态定时任务</p>
              <p class="setting-hint">模型可以自己建提醒。</p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="enable_schedule" role="switch" aria-checked="false" aria-label="动态定时任务" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">技能</p>
              <p class="setting-hint">每轮注入技能目录，<code>/skill &lt;id&gt; &lt;任务&gt;</code> 激活后载入正文。</p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="enable_skills" role="switch" aria-checked="false" aria-label="技能" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">记录工具调用</p>
              <p class="setting-hint">写进 D1，方便排障。会消耗写入额度。</p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="enable_audit" role="switch" aria-checked="false" aria-label="记录工具调用" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">单聊显示「正在输入」</p>
              <p class="setting-hint">仅单聊有效。</p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="show_typing" role="switch" aria-checked="false" aria-label="单聊显示正在输入" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">回复时 @ 说话人</p>
              <p class="setting-hint">
                「仅群聊」在群和频道里 @ 说话人，单聊不 @。多人同时提问时能一眼看出在回谁。
              </p>
            </div>
            <div class="setting-control">
              <select class="qb-input" id="replyMention" style="min-width: 8rem">
                <option value="off">关</option>
                <option value="group">仅群聊</option>
                <option value="always">总是</option>
              </select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">群聊按成员隔离会话</p>
              <p class="setting-hint">
                打开后每个群成员拥有独立历史，互相看不到对方聊的内容；适合客服、多租户。
                关闭时整个群共享一段历史（默认）。
                <strong>切换后已有记忆查不到，等于所有人重新开始。</strong>
              </p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="isolate_sessions" role="switch" aria-checked="false" aria-label="群聊按成员隔离会话" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">让模型知道说话人 ID</p>
              <p class="setting-hint">
                提示词里带上说话人的 openid。开了模型才能区分群里不同的人；关掉时只给昵称。
                注意这不是 QQ 号——官方接口只给 openid，且按机器人隔离。
              </p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="expose_sender_id" role="switch" aria-checked="false" aria-label="让模型知道说话人 ID" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">让模型知道当前时间</p>
              <p class="setting-hint">模型没有时钟。关掉后它只能凭记忆猜日期。时间放在本轮消息里，不影响缓存。</p>
            </div>
            <div class="setting-control">
              <button class="switch" data-flag="expose_datetime" role="switch" aria-checked="false" aria-label="让模型知道当前时间" type="button">
                <span class="switch-track"><span class="switch-knob"></span></span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">限额</h2>
            <p class="card-desc">改动即时保存。</p>
          </div>
        </div>
        <div class="rows">
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">单次最多模型步数</p>
              <p class="setting-hint">一步 = 一次模型调用。建议 8–12。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input" type="number" id="maxSteps" min="1" max="30" style="width: 6rem" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">单次最多工具调用</p>
              <p class="setting-hint">失控的循环会烧光时长与 token。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input" type="number" id="maxToolCalls" min="1" max="50" style="width: 6rem" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">历史条数</p>
              <p class="setting-hint">每次带多少条历史给模型。条数越多越贵。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input" type="number" id="historyLimit" min="0" max="100" style="width: 6rem" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">模型调用超时</p>
              <p class="setting-hint">毫秒。默认 20000，接近事件预算 18 秒时容易走兜底。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input" type="number" id="timeoutMs" min="1000" max="25000" step="1000" style="width: 7rem" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">时区</p>
              <p class="setting-hint">用于 time 工具和提示词里的当前时间。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input mono-input" id="timezone" style="width: 10rem" placeholder="Asia/Shanghai" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">上下文压缩</p>
              <p class="setting-hint">按「轮」丢弃最旧内容，工具调用与结果永远成对。</p>
            </div>
            <div class="setting-control">
              <select class="qb-input" id="contextCompression" style="width: 9rem">
                <option value="truncate">丢整轮（推荐）</option>
                <option value="off">不压缩</option>
                <option value="summary">摘要（多一次模型调用）</option>
              </select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">压缩触发阈值</p>
              <p class="setting-hint">估算 token 超过它就开始压缩。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input" type="number" id="maxContextTokens" min="1000" max="200000" step="1000" style="width: 7rem" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">每会话每分钟上限</p>
              <p class="setting-hint">防刷屏。0 = 不限。</p>
            </div>
            <div class="setting-control">
              <input class="qb-input" type="number" id="rateLimit" min="0" max="100" style="width: 6rem" />
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <p class="setting-label">内容安全关键词</p>
              <p class="setting-hint">入站与出站都查。留空 = 关闭。</p>
            </div>
            <div class="setting-control" style="flex-direction: column; align-items: stretch; min-width: 16rem">
              <div class="list-input" id="filterKeywords"></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </section>

  <!-- ==================== 工具 ==================== -->
  <section class="panel" data-panel="tools" role="tabpanel" id="panel-tools" aria-labelledby="tab-tools">
    <section class="qb-card" style="padding: var(--qb-space-4)">
      <div class="card-head">
        <div>
          <h2 class="card-title">工具 <span class="qb-muted" style="font-size: var(--qb-text-xs)" id="toolCount"></span></h2>
          <p class="card-desc">关掉的工具不会注册，模型看不到。</p>
        </div>
        <div class="card-actions">
          <button class="qb-btn" id="toolEnableAll" type="button">全部启用</button>
          <button class="qb-btn" id="toolDisableAll" type="button">全部关闭</button>
        </div>
      </div>
      <div class="field" style="margin-bottom: var(--qb-space-3)">
        <input class="qb-input" id="toolSearch" placeholder="按名字或描述过滤…" style="max-width: 20rem" />
      </div>
      <div id="toolList"></div>
    </section>
  </section>

  <!-- ==================== 技能 ==================== -->
  <section class="panel" data-panel="skills" role="tabpanel" id="panel-skills" aria-labelledby="tab-skills">
    <section class="qb-card" style="padding: var(--qb-space-4)">
      <div class="card-head">
        <div>
          <h2 class="card-title">技能 <span class="qb-muted" style="font-size: var(--qb-text-xs)" id="skillCount"></span></h2>
          <p class="card-desc">每轮只注入目录，激活后才载入正文。</p>
        </div>
        <div class="card-actions">
          <button class="qb-btn qb-btn--primary" id="addSkill" type="button">新增技能</button>
        </div>
      </div>
      <div class="field" style="margin-bottom: var(--qb-space-3)">
        <input class="qb-input" id="skillSearch" placeholder="按 id 或描述过滤…" style="max-width: 20rem" />
      </div>
      <div id="skillList"></div>
    </section>
  </section>

  <!-- ==================== 运行数据 ==================== -->
  <section class="panel" data-panel="data" role="tabpanel" id="panel-data" aria-labelledby="tab-data">
    <div class="stack">
      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">会话</h2>
            <p class="card-desc">绑过人格的会话列在这里，可以直接改。</p>
          </div>
        </div>
        <div class="field" style="margin-bottom: var(--qb-space-3)">
          <input class="qb-input" id="convSearch" placeholder="按会话 id 过滤…" style="max-width: 20rem" />
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>会话</th><th>人格</th><th>更新时间</th><th></th></tr></thead>
            <tbody id="convRows"></tbody>
          </table>
        </div>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">定时任务 <span class="qb-muted" style="font-size: var(--qb-text-xs)" id="scheduleCount"></span></h2>
            <p class="card-desc">模型按你的要求建的提醒。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>触发时间</th><th>会话</th><th>内容</th><th>重复</th></tr></thead>
            <tbody id="scheduleRows"></tbody>
          </table>
        </div>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">工具调用</h2>
            <p class="card-desc" id="auditHint">需要打开「记录工具调用」才会收集。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>工具</th><th>状态</th><th class="num">耗时</th></tr></thead>
            <tbody id="auditRows"></tbody>
          </table>
        </div>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">最近 14 天</h2>
            <p class="card-desc">一天一行，写入量不随消息数增长。</p>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>日期</th><th class="num">对话</th><th class="num">失败</th><th class="num">工具调用</th></tr></thead>
            <tbody id="stats"></tbody>
          </table>
        </div>
      </section>

      <section class="qb-card" style="padding: var(--qb-space-4)">
        <div class="card-head">
          <div>
            <h2 class="card-title">覆盖状态</h2>
            <p class="card-desc">本页改过的项存在插件自己的存储里，覆盖面板配置。</p>
          </div>
          <div class="card-actions">
            <button class="qb-btn" id="resetAll" type="button">全部恢复成配置值</button>
          </div>
        </div>
        <p class="qb-muted" style="font-size: var(--qb-text-xs); margin: 0" id="overrideState"></p>
      </section>
    </div>
  </section>
</div>
`
