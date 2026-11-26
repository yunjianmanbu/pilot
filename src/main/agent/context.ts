import type { AgentMessage } from '../../shared/types'

/**
 * Conservative character-based estimate. ASCII/code averages ~3.6 chars per
 * token; CJK is close to one token per character. Counting them separately
 * keeps the budget honest for Chinese prompts and reports.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x80) ascii += 1
    else wide += 1
  }
  return Math.max(1, Math.ceil(ascii / 3.6 + wide * 1.1))
}

/**
 * Flat per-image charge. Providers bill an image by pixel tile count, which the
 * transcript cannot know; a conservative constant is enough to keep a
 * screenshot-heavy run from looking far cheaper than it is, because the data
 * URL itself is base64 and never measured by the character estimator.
 */
export const IMAGE_TOKEN_COST = 1_600

interface TokenCacheEntry {
  content: string
  callsRef: AgentMessage['toolCalls']
  callsLength: number
  imagesRef: AgentMessage['images']
  imagesLength: number
  tokens: number
}

/**
 * Per-message token memo. Transcripts are long and re-measured on every step
 * (the fitter runs a binary search over turn boundaries), so counting the same
 * characters again and again was the dominant cost of a long run. Message
 * objects are immutable in practice: any change replaces the object or its
 * content/toolCalls, and both are part of the cache key.
 */
const tokenCache = new WeakMap<AgentMessage, TokenCacheEntry>()

function cacheEntry(message: AgentMessage): TokenCacheEntry {
  const content = message.content
  const cached = tokenCache.get(message)
  const callsLength = message.toolCalls?.length ?? 0
  const imagesLength = message.images?.length ?? 0
  if (
    cached &&
    cached.content === content &&
    cached.callsRef === message.toolCalls &&
    cached.callsLength === callsLength &&
    cached.imagesRef === message.images &&
    cached.imagesLength === imagesLength
  ) {
    return cached
  }
  let tokens = estimateTokens(content) + 4
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)) + 6
  }
  // Screenshots ride along as user observations. Ignoring them made a
  // screenshot-heavy run measure far below what it actually sent, so the
  // fitter believed it had room it did not have.
  tokens += imagesLength * IMAGE_TOKEN_COST
  const entry: TokenCacheEntry = {
    content,
    callsRef: message.toolCalls,
    callsLength,
    imagesRef: message.images,
    imagesLength,
    tokens,
  }
  tokenCache.set(message, entry)
  return entry
}

export function messageTokens(message: AgentMessage): number {
  return cacheEntry(message).tokens
}

/**
 * Sum of `estimateTokens(message.content)` over the transcript. Same value the
 * loop used to compute by joining every content into one big string, without
 * allocating that string or rescanning unchanged messages.
 */
export function contentTokens(messages: AgentMessage[]): number {
  let ascii = 0
  let wide = 0
  let chars = 0
  for (const message of messages) {
    const counts = contentCounts(message)
    ascii += counts.ascii
    wide += counts.wide
    chars += counts.chars
  }
  // The joined string is the contents plus one newline per gap.
  const gaps = messages.length > 0 ? messages.length - 1 : 0
  if (chars + gaps === 0) return 0
  return Math.max(1, Math.ceil((ascii + gaps) / 3.6 + wide * 1.1))
}

interface CharCounts {
  ascii: number
  wide: number
  chars: number
}

const charCache = new WeakMap<AgentMessage, { content: string; counts: CharCounts }>()

function contentCounts(message: AgentMessage): CharCounts {
  const content = message.content ?? ''
  const cached = charCache.get(message)
  if (cached && cached.content === content) return cached.counts
  let ascii = 0
  let wide = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) < 0x80) ascii += 1
    else wide += 1
  }
  const counts: CharCounts = { ascii, wide, chars: content.length }
  charCache.set(message, { content, counts })
  return counts
}

export function messagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const message of messages) total += cacheEntry(message).tokens
  return total
}

export interface TrimResult {
  messages: AgentMessage[]
  droppedMessages: number
  estimatedTokens: number
}

export const COMPACTED_MARKER = '【早先工具输出已压缩'

/**
 * A compacted result that only keeps head and tail throws away the part the
 * model actually needs next: what is *in* the file. Measured on this repo, a
 * 1300-character head/tail budget kept 0-2 of 5 sampled function declarations
 * (head went to the licence header and the import block), so a model that
 * needed a declaration in the middle had to re-read the whole file — paying
 * the full token cost again on top of an extra round trip.
 *
 * Declaration lines are the cheapest useful index of a source file: dense,
 * stable, and they never cost more than a fraction of the body they stand in
 * for. Content with no such structure (logs, HTML, JSON) yields nothing and
 * falls back to the plain head/tail rule.
 */
const DECLARATION_LINE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+[A-Za-z_$]/

export interface CompactOptions {
  /** Newest tool results that stay verbatim: they are the working set. */
  keepRecentToolResults?: number
  minToolChars?: number
  headChars?: number
  tailChars?: number
  /** Character budget for the declaration skeleton kept from the elided middle. 0 disables it. */
  skeletonChars?: number
  /**
   * Long assistant answers are re-sent on every step too. A pasted report or a
   * verbose explanation could dominate the window while compaction only ever
   * looked at tool-role messages, so the oldest over-long answers are elided
   * with the same head/tail rule. 0 keeps every answer verbatim.
   */
  maxAnswerChars?: number
}

export interface CompactResult {
  messages: AgentMessage[]
  compacted: number
  savedChars: number
  /** Over-long assistant answers elided by the same head/tail rule. */
  compactedAnswers?: number
}

/**
 * Top-level declaration lines of `content`, in file order, up to `maxChars`.
 *
 * Returns nothing when the content has no such structure (logs, HTML, JSON
 * blobs): those fall back to the plain head/tail rule rather than pretending
 * an arbitrary first line is a declaration.
 */
export function declarationSkeleton(content: string, maxChars: number): string[] {
  if (maxChars <= 0) return []
  const all: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    // A declaration line is short; anything longer is prose or minified code.
    if (line.length < 6 || line.length > 200) continue
    if (!DECLARATION_LINE.test(line)) continue
    all.push(line.length > 140 ? `${line.slice(0, 140)}…` : line)
  }
  // Two or fewer lines is not a skeleton, it is a coincidence; keep the plain
  // head/tail form so the output stays predictable.
  if (all.length < 3) return []
  const cost = (lines: string[]): number => lines.reduce((sum, line) => sum + line.length + 1, 0)
  if (cost(all) <= maxChars) return all
  // Over budget: keep every stride-th declaration, always including the first
  // and the last, so a 3000-line file still shows both ends of its shape
  // instead of only the exports that happen to sit near the top. Stride only
  // grows, so the first stride that fits is the densest one that fits.
  for (let stride = 2; stride <= all.length; stride += 1) {
    const picked: string[] = []
    for (let index = 0; index < all.length; index += stride) picked.push(all[index]!)
    const last = all[all.length - 1]!
    if (picked[picked.length - 1] !== last) picked.push(last)
    if (cost(picked) <= maxChars) return picked
  }
  return []
}

export interface ElideOptions {
  headChars: number
  tailChars: number
  skeletonChars: number
  /** `"tool_name target"` when the transcript still knows what produced this. */
  source?: string
}

/**
 * Replace the middle of a long tool result or answer.
 *
 * Head/tail alone preserved 0-2 of 5 sampled declarations on this repo; adding
 * the declaration skeleton keeps the model able to name what the file contains
 * without a re-read, for a few hundred extra tokens instead of thousands.
 */
export function elidedContent(content: string, options: ElideOptions): string {
  const skeleton = declarationSkeleton(content, options.skeletonChars)
  const hasSkeleton = skeleton.length > 0
  // With a skeleton the head only has to carry the header and the import block,
  // so it can give up characters to the part that carries real structure.
  const head = content.slice(0, hasSkeleton ? Math.min(options.headChars, 600) : options.headChars)
  const tail = content.slice(-(hasSkeleton ? Math.min(options.tailChars, 400) : options.tailChars))
  const omitted = content.length - head.length - tail.length
  const sourceLine = options.source
    ? `\n[来源] ${options.source} · 需要完整内容时请重新读取该路径`
    : ''
  const kept = hasSkeleton ? '仅保留首尾与声明骨架' : '仅保留首尾'
  if (!hasSkeleton) {
    return `${COMPACTED_MARKER}：原 ${content.length} 字符，${kept}】${sourceLine}\n${head}\n…（省略 ${omitted} 字符）…\n${tail}`
  }
  const already = new Set([...head.split('\n'), ...tail.split('\n')].map((line) => line.trim()))
  const lines = skeleton.filter((line) => !already.has(line))
  return (
    `${COMPACTED_MARKER}：原 ${content.length} 字符，${kept}】${sourceLine}\n${head}` +
    `\n…（中间省略 ${omitted} 字符，下面是它的声明骨架）…\n${lines.join('\n')}\n…（正文省略）…\n${tail}`
  )
}

/**
 * Old tool output is re-sent on every step. Keep the newest results intact,
 * elide the middle of older ones, and preserve head/tail evidence (paths,
 * errors) without paying for the whole file again.
 */
export function compactToolResults(
  messages: AgentMessage[],
  options: CompactOptions = {},
): CompactResult {
  const keepRecent = Math.max(0, options.keepRecentToolResults ?? 8)
  const minChars = Math.max(200, options.minToolChars ?? 1_500)
  const headChars = Math.max(200, options.headChars ?? 900)
  const tailChars = Math.max(100, options.tailChars ?? 400)
  const skeletonChars = Math.max(0, options.skeletonChars ?? 1_200)
  // Long answers count against the window as much as tool output does, but the
  // newest ones are still the thread the model is following. Anything within
  // the last few messages stays verbatim; older ones are elided.
  const maxAnswerChars = Math.max(0, options.maxAnswerChars ?? 0)
  const answerFloor = Math.max(0, messages.length - 4)
  // A compacted result that still names its source lets the model decide
  // whether a re-read is actually needed, instead of re-reading blindly.
  const sources = toolSources(messages)

  const toolIndexes: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'tool') toolIndexes.push(index)
  }
  const keepFrom = toolIndexes.length - keepRecent
  const stale = new Set(
    keepFrom > 0 ? toolIndexes.slice(0, keepFrom) : ([] as number[]),
  )
  if (stale.size === 0 && maxAnswerChars === 0) {
    return { messages, compacted: 0, savedChars: 0 }
  }

  let compacted = 0
  let compactedAnswers = 0
  let savedChars = 0
  const next = messages.map((message, index) => {
    if (stale.has(index)) {
      const content = message.content ?? ''
      if (content.length > minChars && !content.startsWith(COMPACTED_MARKER)) {
        const source = message.toolCallId ? sources.get(message.toolCallId) : undefined
        const replacement = elidedContent(content, {
          headChars,
          tailChars,
          skeletonChars,
          ...(source ? { source } : {}),
        })
        if (replacement.length < content.length) {
          compacted += 1
          savedChars += content.length - replacement.length
          return { ...message, content: replacement }
        }
      }
    }
    // An over-long answer is elided in place: the tool calls it carried stay
    // intact, because only the visible text is replaced.
    if (maxAnswerChars > 0 && index < answerFloor && message.role === 'assistant') {
      const content = message.content ?? ''
      if (content.length > maxAnswerChars && !content.startsWith(COMPACTED_MARKER)) {
        const replacement = elidedContent(content, { headChars, tailChars, skeletonChars })
        if (replacement.length < content.length) {
          compactedAnswers += 1
          savedChars += content.length - replacement.length
          return { ...message, content: replacement }
        }
      }
    }
    return message
  })
  const changed = compacted > 0 || compactedAnswers > 0
  return {
    messages: changed ? next : messages,
    compacted,
    savedChars,
    ...(compactedAnswers > 0 ? { compactedAnswers } : {}),
  }
}

/** `toolCallId -> "tool_name target"` for every call still present in the transcript. */
function toolSources(messages: AgentMessage[]): Map<string, string> {
  const sources = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const args = call.arguments ?? {}
      const target =
        typeof args['path'] === 'string'
          ? args['path']
          : typeof args['file'] === 'string'
            ? args['file']
            : typeof args['query'] === 'string'
              ? args['query']
              : typeof args['command'] === 'string'
                ? args['command'].slice(0, 120)
                : Array.isArray(args['args'])
                  ? args['args'].map(String).join(' ').slice(0, 120)
                  : ''
      sources.set(call.id, `${call.name}${target ? ` ${target}` : ''}`)
    }
  }
  return sources
}

export interface FitOptions extends CompactOptions {
  keepRecent?: number
  /**
   * Opportunistic compaction only runs once the transcript is above this
   * fraction of the budget. Rewriting history mid-window invalidates the
   * provider's prompt cache from that point on, so a transcript that already
   * fits is left verbatim and keeps hitting. 0 restores the old
   * compact-on-every-step behaviour.
   */
  compactAbove?: number
}

/**
 * Fraction of the message budget above which the opportunistic pass may rewrite
 * history. 0.7 is deliberate, not a leftover: raising it to 0.8 was tried and
 * measured against a week of `deepseek-flash` runs.
 *
 * The rewrite frequency turns out not to depend on this number. In steady state
 * every new tool result pushes the oldest one out of `keepRecentToolResults`, so
 * the pass fires roughly once per growing step no matter where the gate sits;
 * raising it only moves the whole plateau ~9K higher, which buys no fewer
 * rewrites, charges those tokens on every step, and pushed the share of steps
 * that fall through to the aggressive pass (which does drop content) from 0.48%
 * to 2.4%. Lowering it trades the same way in reverse. The lesson: the cache
 * churn measured on this repo (~22.6M miss tokens a week) comes from rewriting
 * per step, not from the gate's position.
 */
export const DEFAULT_COMPACT_ABOVE = 0.7

export interface FitResult extends TrimResult {
  compacted: number
  savedChars: number
  compactedAnswers?: number
}

/**
 * Fit a transcript into a token budget. Immediate compaction removes old tool
 * output; aggressive and emergency passes shrink the working set; trimming
 * drops whole turns only at user-message boundaries.
 */
export function fitMessages(
  messages: AgentMessage[],
  maxTokens: number,
  options: FitOptions = {},
): FitResult {
  // Gate the first (lossless-looking) pass on real pressure: an unbounded
  // budget keeps the old behaviour, a budgeted run only rewrites history once
  // it is above the threshold.
  const compactAbove = Math.min(Math.max(options.compactAbove ?? DEFAULT_COMPACT_ABOVE, 0), 1)
  const underPressure =
    maxTokens <= 0 || messagesTokens(messages) > maxTokens * compactAbove
  const first = underPressure
    ? compactToolResults(messages, options)
    : { messages, compacted: 0, savedChars: 0 }
  let working = first.messages
  let compacted = first.compacted
  let compactedAnswers = first.compactedAnswers ?? 0
  let savedChars = first.savedChars

  if (maxTokens > 0 && messagesTokens(working) > maxTokens) {
    const aggressive = compactToolResults(working, {
      ...options,
      keepRecentToolResults: 2,
      minToolChars: 400,
      headChars: 400,
      tailChars: 200,
    })
    working = aggressive.messages
    compacted += aggressive.compacted
    compactedAnswers += aggressive.compactedAnswers ?? 0
    savedChars += aggressive.savedChars
  }

  let trimmed = trimMessages(working, maxTokens, options.keepRecent ?? 8)
  if (maxTokens > 0 && messagesTokens(trimmed.messages) > maxTokens) {
    const emergency = compactToolResults(trimmed.messages, {
      ...options,
      keepRecentToolResults: 0,
      minToolChars: 200,
      headChars: 400,
      tailChars: 200,
    })
    if (emergency.compacted > 0) {
      working = emergency.messages
      compacted += emergency.compacted
      savedChars += emergency.savedChars
      trimmed = trimMessages(working, maxTokens, options.keepRecent ?? 8)
    }
  }

  return { ...trimmed, compacted, savedChars }
}

/**
 * Header for a dropped task that is carried forward as background only. A bare
 * "original task" label gave work that already finished the same weight as the
 * instruction the user just sent, so a long session kept drifting back to its
 * first message.
 */
export const EARLIER_TASK_HEADER = '[更早的任务 · 已完成，除非用户重提否则忽略]'
export const CURRENT_TASK_HEADER = '[当前任务]'

/**
 * A message that opens a task the user actually asked for. Role 'user' alone is
 * not enough: the loop pushes its own reminders (reflection, wrap-up, plan and
 * verification checks, output continuation) as role 'user' so the model reads
 * them as instructions, and the session carries model summaries and folded-turn
 * digests in the same role. Counting any of those as a new user turn closes the
 * task the run is working on and hands the reminder back as the current task.
 */
export function isUserTaskTurn(message: AgentMessage | undefined): boolean {
  return (
    message?.role === 'user' &&
    !message.contextSummary &&
    !message.earlierWork &&
    !message.internal
  )
}

/** Frame a carried-forward task as background for the current instruction. */
export function withEarlierTask(task: string, current: string): string {
  // A re-trimmed transcript already carries the header; nesting it would grow
  // the prompt on every pass.
  if (current.startsWith(EARLIER_TASK_HEADER)) return current
  // A folded-turns digest is itself a "closed work" block with its own header
  // on the first line. Wrapping it again would print the label twice.
  const body = task.startsWith(`${EARLIER_TASK_HEADER}\n`)
    ? task.slice(EARLIER_TASK_HEADER.length + 1)
    : task
  return `${EARLIER_TASK_HEADER}\n${body}\n\n${CURRENT_TASK_HEADER}\n${current}`
}

/**
 * Re-attach the live task when the cut had to drop the turns between it and the
 * retained tail. A single open task longer than the budget used to pin the cut
 * to its own boundary, so nothing could ever be dropped and the transcript kept
 * growing past the budget on every step of a long run.
 */
export function withCurrentTask(task: string): string {
  if (task.startsWith(`${CURRENT_TASK_HEADER}\n`)) return task
  return `${CURRENT_TASK_HEADER}\n${task}`
}

/**
 * Header for a model-written summary injected by the loop. It says which turn
 * the summary describes: the summary's own "Goal" is what the user was asking
 * when it was written, and a task a later message replaced is closed work, not
 * a second live instruction competing with this turn.
 */
export const EARLIER_WORK_HEADER = '[较早对话摘要 · 已关闭的旧工作与事实，不是本轮指令]'
export const EARLIER_WORK_NOTE =
  '本轮任务以本对话最后一条用户消息为准；下面写到的 Goal 是摘要生成时的任务，若与本轮不同即已关闭。'

/** Build the injected summary message body with its framing. */
export function summaryMessageContent(summary: string): string {
  return `${EARLIER_WORK_HEADER}\n${EARLIER_WORK_NOTE}\n${summary.trim()}`
}

/**
 * Recover the bare summary text from a message built by
 * `summaryMessageContent`, so a later compaction can merge it instead of
 * re-summarising the framing lines on every pass.
 */
export function stripSummaryFraming(content: string): string {
  let rest = content
  if (rest.startsWith(EARLIER_WORK_HEADER)) rest = rest.slice(EARLIER_WORK_HEADER.length)
  rest = rest.replace(/^\n+/, '')
  if (rest.startsWith(EARLIER_WORK_NOTE)) rest = rest.slice(EARLIER_WORK_NOTE.length)
  rest = rest.replace(/^\n+/, '')
  // Older messages carry only a bracketed header line.
  rest = rest.replace(/^\[[^\]]*\]\n?/, '')
  return rest.trim()
}

/**
 * Turns replayed verbatim when a run starts: the current one and the one before
 * it. Everything older is closed by the system prompt, and replaying it in full
 * is what kept pulling a long session back to its first request: that message
 * stayed the earliest and often the largest user instruction in the prompt, and
 * the model treated it as the task it was supposed to be working on.
 */
export const REPLAY_VERBATIM_TURNS = 2

/** Per-turn budget inside the collapsed digest, in characters. */
const DIGEST_TURN_CHARS = 320

/**
 * Default character cap for the folded-turns digest. It used to be 1_200, which
 * fits only one or two turns once the headers and the "N turns omitted" line are
 * in place: everything before that vanished from the prompt entirely, not just
 * its detail. 4_000 keeps a dozen closed turns named while staying far below the
 * space the verbatim transcript they replace used to take.
 */
export const DIGEST_MAX_CHARS = 4_000

function clipForDigest(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * One earlier turn as two lines: what was asked, and how it ended. The tool
 * calls and their results are deliberately dropped: they are re-readable, and
 * they were the bulk of what made finished turns outweigh the live one.
 */
function summarizeTurnForDigest(messages: AgentMessage[]): string {
  const asked = messages.find((message) => isUserTaskTurn(message) && message.content.trim())
  let answered = ''
  for (const message of messages) {
    if (message.role === 'assistant' && message.content.trim()) answered = message.content
  }
  if (!asked && !answered) return ''
  const lines = [`请求：${clipForDigest(asked?.content ?? '(未记录)', DIGEST_TURN_CHARS)}`]
  if (answered) lines.push(`结论：${clipForDigest(answered, DIGEST_TURN_CHARS)}`)
  return lines.join('\n')
}

export interface CollapseResult {
  messages: AgentMessage[]
  /** Earlier turns replaced by the digest. */
  collapsedTurns: number
  savedChars: number
}

/**
 * Replay only the newest `keepTurns` user turns verbatim and fold everything
 * older into one closed-work digest, pinned model summaries included. Stored
 * history is untouched: this shapes the request, not the session.
 */
export function collapseCompletedTurns(
  messages: AgentMessage[],
  keepTurns = REPLAY_VERBATIM_TURNS,
  maxDigestChars = DIGEST_MAX_CHARS,
): CollapseResult {
  const boundaries: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (isUserTaskTurn(messages[index])) boundaries.push(index)
  }
  const keep = Math.max(1, keepTurns)
  const unchanged: CollapseResult = { messages, collapsedTurns: 0, savedChars: 0 }
  if (boundaries.length <= keep) return unchanged
  const cutoff = boundaries[boundaries.length - keep]!
  const head = messages.slice(0, cutoff)
  const tail = messages.slice(cutoff)

  const pinned: AgentMessage[] = []
  const turns: string[] = []
  let segment: AgentMessage[] = []
  const flush = (): void => {
    if (segment.length > 0) {
      const turn = summarizeTurnForDigest(segment)
      if (turn) turns.push(turn)
      segment = []
    }
  }
  for (const message of head) {
    // A model summary already stands in for a long stretch of history; folding
    // it into a 320-character digest would throw those facts away twice.
    if (message.contextSummary) {
      flush()
      pinned.push(message)
      continue
    }
    // Each user message opens a turn, so a turn never swallows the next one.
    if (isUserTaskTurn(message)) flush()
    segment.push(message)
  }
  flush()

  if (turns.length === 0) return unchanged

  // Fill from the turn that closed most recently. Filling oldest-first spent
  // the whole cap on the session's first requests and dropped the turns that
  // had just ended, so the digest opened with the very task this fold exists to
  // get out of the way while hiding what the run had actually been doing.
  const body: string[] = []
  let used = 0
  let omitted = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const block = `回合 ${index + 1}\n${turns[index]}`
    if (body.length > 0 && used + block.length + 2 > maxDigestChars) {
      omitted = index + 1
      break
    }
    body.unshift(block)
    used += block.length + 2
  }
  const digest = [
    EARLIER_TASK_HEADER,
    `以下 ${turns.length} 个更早轮次已结束，只保留任务与结论；要用其中的细节，请用工具重新读取。`,
    ...(omitted > 0 ? [`（另有 ${omitted} 个更早轮次未列出，越早越先省略）`] : []),
    ...body,
  ].join('\n')
  const digestMessage: AgentMessage = { role: 'user', content: digest, earlierWork: true }

  const before = head.reduce((total, message) => total + message.content.length, 0)
  const savedChars = before - digest.length
  return {
    messages: [digestMessage, ...pinned, ...tail],
    collapsedTurns: turns.length,
    savedChars: Math.max(0, savedChars),
  }
}

/**
 * Drop the oldest turns until the budget fits. System messages stay; cuts are
 * made only at user-message boundaries so tool calls never lose their result.
 * The newest user message is always kept, because trimming cuts from the front.
 * A dropped head is carried forward as background labelled as finished work:
 * earlier versions re-injected it as "[原始任务]" next to "[当前任务]", which in a
 * long session put a task that ended days ago at the same weight as the message
 * the user just sent. The record stays (a wrong summary must not be the only
 * trace of what was asked) but it can no longer read as the active task.
 */
export function trimMessages(
  messages: AgentMessage[],
  maxTokens: number,
  keepRecent = 8,
): TrimResult {
  if (maxTokens <= 0) {
    return { messages, droppedMessages: 0, estimatedTokens: messagesTokens(messages) }
  }
  const initial = messagesTokens(messages)
  if (initial <= maxTokens) {
    return { messages, droppedMessages: 0, estimatedTokens: initial }
  }

  const system = messages.filter((message) => message.role === 'system')
  const conversation = messages.filter((message) => message.role !== 'system')
  // Model-written summaries are pinned: dropping them would undo the point of
  // compaction and lose the durable state they capture. The folded-turns digest
  // is pinned for the same reason, and because it must keep its own "closed
  // work" header instead of being re-framed as a task every pass.
  const digests = conversation.filter((message) => message.earlierWork)
  const summaries = conversation.filter((message) => message.contextSummary && !message.earlierWork)
  const turns = conversation.filter((message) => !message.contextSummary && !message.earlierWork)
  const base = [...system, ...digests, ...summaries]
  const boundaries: number[] = []
  for (let index = 0; index < turns.length; index += 1) {
    // Every user-role message stays a safe cut point, reminders included: they
    // carry no tool call, so cutting there never orphans a result, and keeping
    // them as cut points is what lets a long single task still be trimmed.
    if (turns[index]?.role === 'user') boundaries.push(index)
  }
  if (boundaries.length === 0) {
    return { messages, droppedMessages: 0, estimatedTokens: initial }
  }

  const minimumKeep = Math.min(Math.max(0, keepRecent), turns.length)
  // Suffix sums turn each boundary probe from a full re-count of the remaining
  // turns into an O(1) lookup, which is what made long transcripts quadratic.
  const baseTokens = messagesTokens(base)
  const suffixTokens = new Array<number>(turns.length + 1).fill(0)
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    suffixTokens[index] = (suffixTokens[index + 1] ?? 0) + messageTokens(turns[index]!)
  }
  const fitsAt = (index: number): boolean => baseTokens + (suffixTokens[index] ?? 0) <= maxTokens

  let chosen = -1
  for (const index of boundaries) {
    if (turns.length - index < minimumKeep) continue
    if (fitsAt(index)) {
      chosen = index
      break
    }
  }
  if (chosen === -1) {
    for (const index of boundaries) {
      if (fitsAt(index)) {
        chosen = index
        break
      }
    }
  }
  if (chosen === -1) chosen = boundaries[boundaries.length - 1] ?? 0

  const firstBoundary = boundaries[0] ?? 0
  const pinned = turns[firstBoundary]
  // A newer *task* turn anywhere in the conversation closes the head, even when
  // the cut landed on a loop reminder. Asking instead whether the retained first
  // message was a user turn answered "nothing newer survived" whenever the cut
  // began with system-written text, and the session's first request then sat
  // bare in the prompt as the only instruction the model could see.
  let lastTask = turns.length - 1
  while (lastTask > firstBoundary && !isUserTaskTurn(turns[lastTask])) lastTask -= 1
  const closedByNewerTask = lastTask > firstBoundary && isUserTaskTurn(turns[lastTask])
  // Trimming the instruction this run is working on is what let the model fall
  // back to an old task, so the live turn is never dropped while older turns
  // remain above it.
  if (closedByNewerTask && chosen > lastTask) chosen = lastTask
  if (!closedByNewerTask) {
    // Nothing from the user closed the head, so the head itself is this run's
    // instruction. Cutting to a later boundary here only kept a reminder and an
    // assistant reply, dropping the task the model was supposed to act on.
    if (fitsAt(firstBoundary)) {
      chosen = firstBoundary
    } else {
      // The single open task alone exceeds the budget. Pinning the cut to its
      // own boundary made trimming a no-op for the whole run (614k tokens of
      // history came back untouched under a 20k budget), so the transcript only
      // ever grew and every step paid for a re-read. Keep the head as the live
      // task and cut at the shallowest index that still fits with it, so the run
      // keeps as much of its recent work as the budget allows instead of
      // jumping to the last reminder.
      const headTokens = pinned ? messageTokens(pinned) : 0
      let cut = -1
      for (let index = firstBoundary + 1; index < turns.length; index += 1) {
        // Cutting in front of a tool result would orphan it from the call that
        // asked for it, so only call-free messages are valid cut points here.
        if (turns[index]?.role === 'tool') continue
        if (baseTokens + headTokens + (suffixTokens[index] ?? 0) <= maxTokens) {
          cut = index
          break
        }
      }
      // Nothing fits with the head attached: cut as deep as possible and let
      // compaction shrink the remainder on the next pass.
      if (cut === -1) cut = boundaries[boundaries.length - 1] ?? firstBoundary
      chosen = cut
    }
  }

  let trimmed = turns.slice(chosen)
  const current = trimmed[0]
  // The head only counts as the current task when nothing newer from the user
  // exists; otherwise it is finished work kept for the record.
  if (chosen > firstBoundary && pinned) {
    const bareTask = pinned.content.startsWith(`${CURRENT_TASK_HEADER}\n`)
      ? pinned.content.slice(CURRENT_TASK_HEADER.length + 1)
      : pinned.content
    const fullTask =
      bareTask.length > 4_000 ? `${bareTask.slice(0, 4_000)}…` : bareTask
    const wrapped = (task: string): AgentMessage =>
      closedByNewerTask
        ? isUserTaskTurn(current)
          ? { ...current!, content: withEarlierTask(task, current!.content) }
          : { role: 'user', content: `${EARLIER_TASK_HEADER}\n${task}`, earlierWork: true }
        : { role: 'user', content: withCurrentTask(task) }
    // `wrapped` replaces the retained head only when that head is itself a user
    // task turn; otherwise it is prepended and the head message stays in the
    // tail. Counting the tail from the wrong side made the fit probe optimistic
    // by one message and let the result land just over budget.
    const dropsCurrent = closedByNewerTask && isUserTaskTurn(current)
    const tailTokens = suffixTokens[chosen + (dropsCurrent ? 1 : 0)] ?? 0
    const fits = (task: string): boolean =>
      baseTokens + messageTokens(wrapped(task)) + tailTokens <= maxTokens

    let task = fullTask
    if (!fits(task)) {
      // The pinned task must not push an otherwise fitting history over budget.
      // Keep the longest prefix that still fits instead of dropping the task.
      let low = 0
      let high = fullTask.length
      let best = 0
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        if (fits(fullTask.slice(0, middle))) {
          best = middle
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      while (best > 0 && !fits(`${fullTask.slice(0, best)}…`)) best -= 1
      task = best > 0 ? `${fullTask.slice(0, best).trimEnd()}…` : ''
    }
    if (task) {
      trimmed = dropsCurrent ? [wrapped(task), ...trimmed.slice(1)] : [wrapped(task), ...trimmed]
    }
  }

  const result = [...base, ...trimmed]
  return {
    messages: result,
    droppedMessages: turns.length - trimmed.length,
    estimatedTokens: messagesTokens(result),
  }
}

/**
 * Characters a single tool result may occupy for a given prompt budget.
 *
 * A flat cap is right only for a big window. 16k chars is ~4k tokens against a
 * 1M-token model, but a quarter of the prompt in the 8k-token subagent window,
 * where one large `read_file` then pushes out the task the subagent was given.
 * Sizing the cap from the budget keeps one result from crowding out the reason
 * the agent is reading. The chars-per-token factor is deliberately pessimistic
 * (0.9, the CJK rate of `estimateTokens`): under-shooting the budget is a
 * smaller problem than a result that silently overflows it.
 */
export function toolOutputCharsFor(
  maxContextTokens: number | undefined,
  cap: number,
  share = 0.25,
): number {
  const budget = Math.floor((maxContextTokens ?? 0) * share)
  if (!Number.isFinite(budget) || budget <= 0) return cap
  return Math.max(1_000, Math.min(cap, Math.floor(budget * 0.9)))
}

/** Keep both ends of long output: the tail usually carries the failure. */
export function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text
  if (limit < 256) return text.slice(0, limit)
  const head = Math.floor(limit * 0.62)
  const tail = Math.floor(limit * 0.3)
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n…（已截断 ${omitted} 字符，保留结尾）…\n${text.slice(-tail)}`
}
