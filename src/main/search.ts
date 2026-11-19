import type {
  KnowledgePair,
  KnowledgePairsResult,
  MessageSearchFilter,
  MessageSearchHit,
  Session,
  StoredMessage,
} from '../shared/types'

const MAX_QUERY_CHARS = 200
const MAX_HITS_PER_SESSION = 8

function pathKey(path: string): string {
  return path.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function searchableText(message: StoredMessage): string {
  if (message.role !== 'user' && message.role !== 'assistant') return ''
  if (message.control) return ''
  return message.content ?? ''
}

/** Keep line numbers irrelevant for snippets while preserving string indexes. */
function flatten(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ')
}

function snippetFor(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 48)
  const end = Math.min(text.length, index + length + 72)
  const piece = flatten(text.slice(start, end)).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${piece}${end < text.length ? '…' : ''}`
}

/**
 * Case-insensitive full-text search over user and assistant messages.
 * Sessions are consulted newest-first and each session contributes at most a
 * handful of hits, so a broad query cannot flood the sidebar.
 */
export function searchSessionMessages(
  sessions: Session[],
  query: string,
  limit = 40,
  filter: MessageSearchFilter = {},
): MessageSearchHit[] {
  const needle = query.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS).toLowerCase()
  if (!needle) return []
  const max = Math.max(1, Math.min(200, Math.round(limit) || 40))
  const workspace = filter.workspacePath ? pathKey(filter.workspacePath) : ''
  const sessionId = filter.sessionId ? filter.sessionId.trim() : ''
  const role = filter.role === 'user' || filter.role === 'assistant' ? filter.role : ''
  const since = filter.since ? new Date(filter.since).getTime() : 0
  const sinceAt = Number.isFinite(since) ? since : 0
  const ordered = [...sessions].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )
  const hits: MessageSearchHit[] = []

  for (const session of ordered) {
    if (sessionId && session.id !== sessionId) continue
    if (workspace && pathKey(session.workspacePath) !== workspace) continue
    let found = 0
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      if (hits.length >= max) return hits
      if (found >= MAX_HITS_PER_SESSION) break
      const message = session.messages[index]
      if (!message) continue
      if (role && message.role !== role) continue
      if (sinceAt) {
        const created = new Date(message.createdAt).getTime()
        if (!Number.isFinite(created) || created < sinceAt) continue
      }
      const text = searchableText(message)
      if (!text) continue
      const match = flatten(text).toLowerCase().indexOf(needle)
      if (match < 0) continue
      hits.push({
        sessionId: session.id,
        sessionTitle: session.title,
        workspacePath: session.workspacePath,
        messageId: message.id,
        role: message.role === 'user' ? 'user' : 'assistant',
        snippet: snippetFor(text, match, needle.length),
        createdAt: message.createdAt,
      })
      found += 1
    }
  }
  return hits
}

/**
 * Rebuild a conversation as instruction → reply pairs.
 *
 * Every visible user message opens a pair; the assistant text that follows
 * (until the next user message) becomes its reply. Tool calls, tool results,
 * reasoning and internal continuation prompts never enter the knowledge base.
 */
export function buildKnowledgePairs(messages: StoredMessage[]): KnowledgePair[] {
  const pairs: KnowledgePair[] = []
  let current: KnowledgePair | null = null

  for (const message of messages) {
    if (!message || message.control) continue
    if (message.role === 'user') {
      const text = String(message.content ?? '').trim()
      const images = Array.isArray(message.images) ? message.images.length : 0
      const instruction = text || (images > 0 ? '[图片]' : '')
      if (!instruction) {
        // 工具结果等空用户消息会结束上一条指令的回复范围。
        current = null
        continue
      }
      current = {
        key: message.id || `pair-${pairs.length + 1}`,
        index: pairs.length + 1,
        instructionId: message.id,
        instruction,
        instructionAt: message.createdAt,
        replyId: '',
        replyAt: '',
        reply: '',
        replyCount: 0,
      }
      pairs.push(current)
      continue
    }
    if (message.role !== 'assistant' || !current) continue
    const text = String(message.content ?? '').trim()
    if (!text) continue
    current.reply = current.reply ? `${current.reply}\n\n${text}` : text
    current.replyCount += 1
    if (!current.replyId) current.replyId = message.id
    if (!current.replyAt) current.replyAt = message.createdAt
  }

  return pairs
}

const INSTRUCTION_CLIP = 1_600
const REPLY_CLIP = 3_200

/**
 * Keep the relay payload bounded for long sessions. Search runs against the
 * full text; only the returned copy is clipped, and the phone can jump back
 * to the original message for the rest.
 */
export function clipKnowledgePair(pair: KnowledgePair): KnowledgePair {
  const instruction = pair.instruction.length > INSTRUCTION_CLIP
  const reply = pair.reply.length > REPLY_CLIP
  if (!instruction && !reply) return pair
  return {
    ...pair,
    instruction: instruction
      ? `${pair.instruction.slice(0, INSTRUCTION_CLIP)}…`
      : pair.instruction,
    reply: reply ? `${pair.reply.slice(0, REPLY_CLIP)}…` : pair.reply,
    ...(instruction ? { instructionTruncated: true } : {}),
    ...(reply ? { replyTruncated: true } : {}),
  }
}

/**
 * Browse or search one session's knowledge as instruction→reply pairs. Search
 * matches the full text, but only the newest `limit` pairs are returned, each
 * clipped, so a long session stays cheap to render.
 */
export function knowledgePairsFor(
  messages: StoredMessage[],
  query = '',
  limit = 200,
): KnowledgePairsResult {
  const all = buildKnowledgePairs(messages)
  const needle = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const matched = needle
    ? all.filter((pair) =>
        `${pair.instruction}\n${pair.reply}`
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .includes(needle),
      )
    : all
  const max = Math.max(1, Math.min(500, Math.round(limit) || 200))
  const selected = matched.slice(-max).map(clipKnowledgePair)
  return { pairs: selected, total: matched.length }
}
