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

interface TokenCacheEntry {
  content: string
  callsRef: AgentMessage['toolCalls']
  callsLength: number
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
  if (
    cached &&
    cached.content === content &&
    cached.callsRef === message.toolCalls &&
    cached.callsLength === callsLength
  ) {
    return cached
  }
  let tokens = estimateTokens(content) + 4
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)) + 6
  }
  const entry: TokenCacheEntry = {
    content,
    callsRef: message.toolCalls,
    callsLength,
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

export interface CompactOptions {
  /** Newest tool results that stay verbatim: they are the working set. */
  keepRecentToolResults?: number
  minToolChars?: number
  headChars?: number
  tailChars?: number
}

export interface CompactResult {
  messages: AgentMessage[]
  compacted: number
  savedChars: number
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
  // A compacted result that still names its source lets the model decide
  // whether a re-read is actually needed, instead of re-reading blindly.
  const sources = toolSources(messages)

  const toolIndexes: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'tool') toolIndexes.push(index)
  }
  const keepFrom = toolIndexes.length - keepRecent
  if (keepFrom <= 0) return { messages, compacted: 0, savedChars: 0 }

  const stale = new Set(toolIndexes.slice(0, keepFrom))
  let compacted = 0
  let savedChars = 0
  const next = messages.map((message, index) => {
    if (!stale.has(index)) return message
    const content = message.content ?? ''
    if (content.length <= minChars || content.startsWith(COMPACTED_MARKER)) return message
    const head = content.slice(0, headChars)
    const tail = content.slice(-tailChars)
    const omitted = content.length - head.length - tail.length
    const source = message.toolCallId ? sources.get(message.toolCallId) : undefined
    const sourceLine = source ? `\n[来源] ${source} · 需要完整内容时请重新读取该路径` : ''
    const replacement = `${COMPACTED_MARKER}：原 ${content.length} 字符，仅保留首尾】${sourceLine}\n${head}\n…（省略 ${omitted} 字符）…\n${tail}`
    if (replacement.length >= content.length) return message
    compacted += 1
    savedChars += content.length - replacement.length
    return { ...message, content: replacement }
  })
  return { messages: compacted > 0 ? next : messages, compacted, savedChars }
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

export interface FitResult extends TrimResult {
  compacted: number
  savedChars: number
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
  const compactAbove = Math.min(Math.max(options.compactAbove ?? 0.7, 0), 1)
  const underPressure =
    maxTokens <= 0 || messagesTokens(messages) > maxTokens * compactAbove
  const first = underPressure
    ? compactToolResults(messages, options)
    : { messages, compacted: 0, savedChars: 0 }
  let working = first.messages
  let compacted = first.compacted
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
 * Drop the oldest turns until the budget fits. System messages stay; cuts are
 * made only at user-message boundaries so tool calls never lose their result.
 * The first user message (the original task) is carried forward.
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
  // compaction and lose the durable state they capture.
  const summaries = conversation.filter((message) => message.contextSummary)
  const turns = conversation.filter((message) => !message.contextSummary)
  const base = [...system, ...summaries]
  const boundaries: number[] = []
  for (let index = 0; index < turns.length; index += 1) {
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

  let trimmed = turns.slice(chosen)
  const firstBoundary = boundaries[0] ?? 0
  const pinned = turns[firstBoundary]
  const current = trimmed[0]
  if (chosen > firstBoundary && pinned && current?.role === 'user') {
    const fullTask =
      pinned.content.length > 4_000 ? `${pinned.content.slice(0, 4_000)}…` : pinned.content
    const wrapped = (task: string): AgentMessage => ({
      ...current,
      content: `[原始任务]\n${task}\n\n[当前任务]\n${current.content}`,
    })
    // trimmed.slice(1) is a suffix of `turns`, so this stays O(1) per probe
    // instead of re-counting the whole retained transcript on every step of
    // the binary search.
    const tailTokens = suffixTokens[chosen + 1] ?? 0
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
    if (task) trimmed = [wrapped(task), ...trimmed.slice(1)]
  }

  const result = [...base, ...trimmed]
  return {
    messages: result,
    droppedMessages: turns.length - trimmed.length,
    estimatedTokens: messagesTokens(result),
  }
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
