/**
 * 上下文压缩与消息序列修复。
 *
 * 两块能力都来自 AstrBot，但只搬了**能在 Worker 里成立**的部分：
 *
 * ## 1. `fixMessages` —— 保证工具调用与结果配对
 *
 * AstrBot 的 `ContextTruncator.fix_messages`
 * （`astrbot/core/agent/context/truncator.py`）做两件事：
 * - 每一条 `tool` 消息前面必须有一条带 `tool_calls` 的 `assistant`；
 * - 每条带 `tool_calls` 的 `assistant` 后面必须跟齐对应的 `tool` 结果。
 *
 * 这是 OpenAI Chat Completions 规范的要求，而 **Gemini 校验得更死**：序列不合法直接 400。
 * 当前这套代码自己拼序列，目前不会出错；但只要出现「压缩丢掉了 assistant 那一半」
 * 或者「历史里只存了 tool 结果」，就会发出一条必然被拒的请求。
 * 40 行纯函数换掉一整类协议错误，很划算。
 *
 * ## 2. `compactMessages` —— 按「轮」丢弃，而不是按消息条数
 *
 * AstrBot 的 `split_into_rounds`（`round_utils.py`）把消息分组：
 * **一个 user 段 + 紧随其后的所有 assistant/tool 段 = 一轮**。
 * 压缩时只丢**整轮**，所以 `tool_call` 永远不会和它的 `tool_result` 分家——
 * 配对是**结构上保证**的，不靠事后修补。
 *
 * 为什么不用 token 精确计数：Worker 里没有 tokenizer（装一个就是几百 KB 的包体积，
 * 而且每次调用都得算 CPU——免费版全机器人共享 10ms）。所以这里按字符估算：
 * CJK 每字约 0.6 token、其他每字符约 0.3 token（与 AstrBot 的 `token_counter.py` 同源），
 * 图片按 AstrBot 的经验值每张 765 token。
 *
 * **估算会被真实值覆盖**：`loop.ts` 拿得到 provider 返回的 `usage.inputTokens`，
 * 那是精确值。估算只在「还没调过模型」的第一次装配时用得上。
 *
 * ## 3. 与 serverless-agent 的差异
 *
 * serverless-agent 是「消息数超 historyLimit → 把超出的交给独立 summary 模型摘要 → 存 D1」。
 * 它需要一张表、一次额外 D1 写、一次额外模型调用。这里：
 * - `truncate` 模式：**零模型调用、零存储写入、零 D1/KV 额度**，纯内存。
 * - `summary` 模式：摘要存 **DO storage**（不碰 D1/KV），且默认关闭。
 *
 * 这样在免费版「D1 写 10 万行/日、KV 写 1 千次/日」的约束下，压缩本身不产生任何额度消耗。
 */
import type { ModelMessage } from '../types.js'

/** 估算一段文本的 token 数。CJK 约 0.6/字，其他约 0.3/字符（AstrBot 的经验值） */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    // CJK 统一表意文字、扩展 A、兼容表意、全角标点、日文假名、韩文
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk * 0.6 + other * 0.3)
}

/** 单条消息的 token 估算。图片按 AstrBot 的 765 经验值算 */
export function estimateMessageTokens(message: ModelMessage): number {
  if (message.role === 'tool') {
    return estimateTextTokens(message.content ?? '')
  }
  if (message.role === 'assistant') {
    const text = estimateTextTokens(message.content ?? '')
    // 工具调用的 JSON 也要算：参数经常比正文还长
    const calls = message.toolCalls?.length
      ? estimateTextTokens(
          message.toolCalls
            .map((call) => `${call.name}${JSON.stringify(call.arguments)}`)
            .join(''),
        )
      : 0
    return text + calls
  }
  const content = message.content
  if (typeof content === 'string') return estimateTextTokens(content)
  // 多模态：文本逐段算，图片用固定经验值
  let total = 0
  for (const part of content) {
    if (part.type === 'text') total += estimateTextTokens(part.text)
    else total += 765
  }
  return total
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return total
}

/**
 * 修复工具调用配对。
 *
 * 规则（与 AstrBot 的 `fix_messages` 一致）：
 * 1. 孤立的 `tool` 消息（前面没有待配对的 assistant）→ **丢弃**。
 * 2. 带 `toolCalls` 的 assistant 若后面一个 `tool` 结果都没有 → **丢弃整组**
 *    （它要求了调用却没有结果，模型会以为调用失败了，比丢掉更糟）。
 * 3. 配对成功的组，assistant 与它的全部 tool 结果**相邻**输出。
 *
 * 顺带保证第一条非 system 消息是 `user`：不少 provider（智谱、Gemini）强制这个形状。
 */
export function fixMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages

  // 1) 先把开头的 system 段与其余分开（system 永远不动）
  const systemPart: ModelMessage[] = []
  let index = 0
  while (index < messages.length && messages[index]?.role === 'system') {
    const message = messages[index]
    if (message) systemPart.push(message)
    index += 1
  }

  const rest = messages.slice(index)
  const fixed: ModelMessage[] = []
  let pendingAssistant: ModelMessage | null = null
  let pendingTools: ModelMessage[] = []

  /** 只有真的配到工具结果，才把这一组写出去 */
  const flushIfValid = (): void => {
    if (pendingAssistant && pendingTools.length > 0) fixed.push(pendingAssistant, ...pendingTools)
    pendingAssistant = null
    pendingTools = []
  }

  for (const message of rest) {
    if (message.role === 'tool') {
      // 只有存在待配对的 assistant 时才收集，否则它就是孤儿，直接丢
      if (pendingAssistant) pendingTools.push(message)
      continue
    }

    // 遇到新的非 tool 消息：先结算上一组
    flushIfValid()

    if (message.role === 'assistant' && message.toolCalls?.length) {
      // 开一组新的，等它的工具结果
      pendingAssistant = message
      continue
    }

    // 普通 assistant / user 直接输出
    fixed.push(message)
  }

  // 收尾：最后一组也要结算
  flushIfValid()

  // 2) 保证 system 之后第一条是 user。智谱/Gemini 要求这个形状。
  //
  // **不能把后面第一个 user 提到最前**——那会打乱历史顺序，实测历史被
  // `history_limit` 截断后形状是 `[assistant, user, assistant]`，
  // 老写法输出 `user:问题2 / assistant:回答1 / assistant:回答2`：
  // 「回答1」被摆到了它**不应该回答**的「问题2」后面，模型看到一段答非所问的
  // 对话，实测会顺着这个错位继续答错。
  //
  // 正确修法是**丢掉开头的孤儿 assistant**：历史是从中间截断的，
  // 这些 assistant 回答的那个 user 已经不在数组里了，它们单独存在对模型没有意义
  // （留着反而制造错位）。这与 `persona.ts` 的 `finalizeBeginDialogs` 一致：
  // 那边对开头的 assistant 也是直接丢掉，直到遇到 user。
  //
  // 注意人格的 begin_dialogs 不靠这里兜底——`parseBeginDialogs` 已经保证以 user 开头。
  if (fixed.length > 0 && fixed[0]?.role !== 'user') {
    const firstUserIndex = fixed.findIndex((m) => m.role === 'user')
    // 完全没有 user：原样输出（调用方随后会补本轮 user 消息，这里不必强造）
    if (firstUserIndex < 0) return [...systemPart, ...fixed]
    return [...systemPart, ...fixed.slice(firstUserIndex)]
  }

  return [...systemPart, ...fixed]
}

/** 一轮 = 一个 user 段 + 紧随其后的所有非 user 段 */
export interface Round {
  messages: ModelMessage[]
  tokens: number
}

/**
 * 按 AstrBot 的 `split_into_rounds` 切分。
 *
 * 注意 system 段不参与：调用方已经把它分离出去了。
 * 如果开头有 assistant（比如人格的 begin_dialogs），它会自成一轮——
 * 这样丢轮时不会把它和后面的 user 拆开。
 */
export function splitIntoRounds(messages: ModelMessage[]): Round[] {
  const rounds: Round[] = []
  let current: ModelMessage[] = []

  const push = (): void => {
    if (current.length === 0) return
    rounds.push({
      messages: current,
      tokens: estimateMessagesTokens(current),
    })
    current = []
  }

  for (const message of messages) {
    if (message.role === 'user' && current.length > 0) push()
    current.push(message)
  }
  push()

  return rounds
}

export interface CompactResult {
  messages: ModelMessage[]
  /** 被丢掉的轮数。0 表示没压缩 */
  droppedRounds: number
  /**
   * 被截断的超大工具结果条数。
   *
   * 单独的计数，因为**截断不是丢轮**：单轮工具循环里（1 条 user + 一堆 tool 结果）
   * 一条轮都丢不了（丢了等于删掉本轮问题），只能截断体积。
   * 调用方（loop.ts）判断「要不要把压缩结果写回去」时必须两个都看：
   * 只看 `droppedRounds > 0` 会让单轮截断的结果被静默丢弃。
   */
  truncatedToolResults: number
  /**
   * 被丢掉的那些轮（按原顺序，展平成消息）。
   *
   * `summary` 模式要拿它去生成摘要——**丢弃的内容不该凭空消失**，
   * 否则会话一旦跨过压缩阈值，之前所有约定都真的没了。
   * 调用方不需要时忽略即可，不额外拷贝（`kept.slice` 本来就已经分出新数组）。
   */
  droppedMessages: ModelMessage[]
  /** 压缩前估算 */
  tokensBefore: number
  /** 压缩后估算 */
  tokensAfter: number
}

/**
 * 单条工具结果超过这个 token 估算就截断。
 *
 * 为什么卡在这个量级：一次 run 最多 12 个工具调用（`max_tool_calls` 默认值），
 * 每个都留 2000 token 就是 24k，已经超过默认阈值 `max_context_tokens: 12000`。
 * 但截断得太狠会让模型看不到关键字段（搜索结果、HTTP 响应体往往前面是正文、
 * 后面是噪声），所以保留头部 + 尾部，中间的省略号明确告诉模型「被截断了」。
 */
const TOOL_RESULT_TOKEN_LIMIT = 2_000

/** 截断时保留的头部/尾部比例（头 70%、尾 20%，中间省略 10%） */
const TOOL_RESULT_HEAD_RATIO = 0.7
const TOOL_RESULT_TAIL_RATIO = 0.2

/**
 * 把超大的工具结果截断到 `TOOL_RESULT_TOKEN_LIMIT` 以内。
 *
 * **只动 `tool` 消息的 content，不删消息、不动 toolCalls**：
 * 删掉 tool 消息会拆散 `tool_call` / `tool_result` 配对，上游直接 400
 * （Gemini 尤其严格），而截断内容对协议完全合法。
 *
 * 返回新数组（不改入参）：调用方拿到的 messages 可能还有别的引用。
 */
export function truncateOversizedToolResults(
  messages: ModelMessage[],
  limitTokens = TOOL_RESULT_TOKEN_LIMIT,
): { messages: ModelMessage[]; truncated: number } {
  let truncated = 0
  const out = messages.map((message) => {
    if (message.role !== 'tool') return message
    if (estimateTextTokens(message.content) <= limitTokens) return message

    // 按 token 估算反推字符预算：CJK 0.6/字、其它 0.3/字符。
    // 这里直接按「最坏情况」估：保守地多截一点没关系，多留一次请求可能就超上下文
    const chars = Math.max(256, Math.ceil(limitTokens / 0.6))
    const head = Math.floor(chars * TOOL_RESULT_HEAD_RATIO)
    const tail = Math.floor(chars * TOOL_RESULT_TAIL_RATIO)
    const content = message.content
    const omitted = content.length - head - tail
    truncated += 1
    return {
      ...message,
      content:
        `${content.slice(0, head)}\n\n…（工具结果过长，已省略中间的 ${omitted} 个字符；` +
        `如需完整内容请缩小查询范围后重试）…\n\n` +
        content.slice(content.length - tail),
    }
  })
  return { messages: out, truncated }
}

/**
 * 按阈值丢轮（AstrBot 的 `truncate` 模式）。
 *
 * 关键行为：
 * - **只丢整轮**，所以工具配对是结构保证的；
 * - **至少保留最新一轮**：用户刚说的话不能丢，否则模型答非所问；
 * - 丢完再跑一次 `fixMessages` 兜底（比如开头是 assistant 被人格撑起来的情况）。
 *
 * 不做「一次丢到阈值以下」的断崖式清理：AstrBot 每次只丢最老的一轮（渐进棘轮），
 * 这样上下文是**缓慢变旧**而不是突然失去一大段。这里采用同样的策略：
 * 每轮丢掉最老的一轮直到低于阈值，但**一次调用最多丢一半的轮**，
 * 避免上下文抖动过大。
 */
export function compactMessages(
  messages: ModelMessage[],
  options: { maxTokens: number; systemTokens?: number },
): CompactResult {
  const tokensBefore = estimateMessagesTokens(messages)
  const totalBefore = tokensBefore + (options.systemTokens ?? 0)

  const none = (): CompactResult => ({
    messages,
    droppedRounds: 0,
    truncatedToolResults: 0,
    droppedMessages: [],
    tokensBefore,
    tokensAfter: tokensBefore,
  })

  if (totalBefore <= options.maxTokens) return none()

  const rounds = splitIntoRounds(messages)

  // 只有一轮时**不能丢轮**——丢了等于把本轮问题删了。
  //
  // 但「不丢轮」不等于「不压缩」：一次 run 里模型可以连着调十几个工具，
  // 每个结果都塞进 messages，全都属于同一轮。实测 1 条 user + 6 个巨大的
  // tool 结果 ≈ 72,063 token，而 maxTokens=1000，droppedRounds 却是 0——
  // 压缩形同虚设，下一次模型调用直接超上下文。
  //
  // 所以单轮时改为**截断超大的 tool 结果**：不删消息、不动 toolCalls，
  // 配对结构不变（不拆散成对），只是把每条 tool content 压到上限内。
  if (rounds.length <= 1) {
    const { messages: truncatedMessages, truncated } = truncateOversizedToolResults(messages)
    if (truncated === 0) return none()
    const truncatedAfter = estimateMessagesTokens(truncatedMessages)
    // 极端情况：截断后仍然超阈值（消息太多）。此时也没法再做什么——
    // 丢轮会丢问题、丢 tool 会破坏配对，只能交给调用方的 max_model_steps 兜住
    return {
      messages: truncatedMessages,
      droppedRounds: 0,
      truncatedToolResults: truncated,
      droppedMessages: [],
      tokensBefore,
      tokensAfter: truncatedAfter,
    }
  }

  let dropped = 0
  let kept = rounds
  const maxDrop = Math.max(1, Math.floor(rounds.length / 2))
  let used = totalBefore

  // 从最老的开始丢，直到低于阈值或达到丢弃上限，但始终保留最后 1 轮
  while (kept.length > 1 && used > options.maxTokens && dropped < maxDrop) {
    const removed = kept[0]
    if (!removed) break
    used -= removed.tokens
    kept = kept.slice(1)
    dropped += 1
  }

  if (dropped === 0) return none()

  // 丢完轮再截断剩下的超大工具结果：丢轮和截断是两件事，
  // 只丢轮可能仍然不够（最后一轮自己就超阈值），配合起来才真的能压住
  const keptMessages = kept.flatMap((round) => round.messages)
  const { messages: truncatedMessages, truncated } = truncateOversizedToolResults(keptMessages)
  const compacted = fixMessages(truncatedMessages)
  const droppedMessages = rounds
    .slice(0, dropped)
    .flatMap((round) => round.messages)
  return {
    messages: compacted,
    droppedRounds: dropped,
    truncatedToolResults: truncated,
    droppedMessages,
    tokensBefore,
    tokensAfter: estimateMessagesTokens(compacted),
  }
}

// ---------------------------------------------------------------- 摘要压缩

/** 摘要在 DO 里的存储键 */
export const SUMMARY_KEY = 'summary'

/** 一条已生成的会话摘要 */
export interface StoredSummary {
  /** 摘要正文（模型输出） */
  content: string
  /** 这份摘要覆盖到什么时候（毫秒时间戳），用来排障与展示 */
  generatedAt: number
  /** 被摘要掉的消息条数，用于日志与「摘要是否划算」的判断 */
  coveredMessages: number
}

/**
 * 摘要在上下文里的位置：紧跟 system 与人格开场白之后、真实历史之前。
 *
 * 用 `user` + `assistant` 这一对而不是塞进 system，理由和 AstrBot 一样：
 * - **system 要保持稳定**，否则前缀缓存每轮失效（摘要变了就整段作废，
 *   但摘要本身是低频变化，塞 system 反而每次改都击穿缓存）；
 * - 摘要属于「对历史的重述」，不是人格设定，放 system 会污染人格层。
 *
 * `assistant` 的回应是固定的一小句：让模型知道「这段摘要已经被接受了」，
 * 而不是把它当成本轮待回答的问题。
 */
const SUMMARY_ACK = 'Acknowledged the summary of our previous conversation history.'

/** 把摘要包成一对模型消息 */
export function summaryMessages(summary: StoredSummary): ModelMessage[] {
  return [
    {
      role: 'user',
      content: `Our previous history conversation summary: ${summary.content}`,
    },
    { role: 'assistant', content: SUMMARY_ACK },
  ]
}

/**
 * 生成摘要的提示词。结构参考 AstrBot 的 `LLMSummaryCompressor.instruction_text`，
 * 但**砍掉了它面向开发场景的部分**（文件路径、材料清单——个人机器人的群聊用不上），
 * 保留对闲聊同样重要的三条：核心话题与结论、工具用过的结论、用户最初想要什么。
 */
export const SUMMARY_INSTRUCTION = [
  '把下面这段对话历史压缩成一份摘要，供你自己在后续对话里回忆用。要求：',
  '1. 覆盖提到的主要话题和各自的结论，最新的重点放前面；',
  '2. 如果用过工具，写出用过什么、拿到了什么关键结果（不要复述工具参数）；',
  '3. 如果用户提过目标或偏好（称呼、语气、禁忌），明确写出来；',
  '4. **结尾写明当前进展和下一步该做什么**（如果当时有任务在进行中）；',
  '5. 用对话原来的语言写，控制在 400 字以内；',
  '6. 只输出摘要正文，不要任何前缀、解释或格式标记。',
].join('\n')

/** 把任意消息的正文摊成纯文本（多模态内容取其中的文本段，图片只留占位） */
function plainText(content: ModelMessage['content'] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : '[图片]'))
    .join('')
}

/**
 * 把被丢弃的消息拼成一条摘要请求。
 *
 * 只发一次模型调用：把历史按 `role: 正文` 摊平成文本，再追加摘要指令。
 * 不重放原始消息数组，因为被丢弃的轮次里可能带工具配对，直接发容易触发
 * provider 对序列的严格校验（Gemini 对 functionCall 签名极敏感），
 * 而摘要根本用不上那层结构 —— 摊平更稳，token 也更省。
 */
export function buildSummaryRequest(dropped: ModelMessage[]): ModelMessage[] {
  const body = dropped
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const text = plainText(message.content)
      const calls =
        message.role === 'assistant' && message.toolCalls?.length
          ? `（调用了工具：${message.toolCalls.map((call) => call.name).join('、')}）`
          : ''
      // 工具结果是 JSON，截断一下：摘要不需要逐字复述，只要结论
      const trimmed = message.role === 'tool' ? text.slice(0, 500) : text
      return `${message.role}: ${trimmed}${calls}`
    })
    .join('\n')

  return [
    {
      role: 'user',
      content: `${SUMMARY_INSTRUCTION}\n\n<conversation_history>\n${body}\n</conversation_history>`,
    },
  ]
}
