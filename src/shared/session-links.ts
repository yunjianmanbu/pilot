import type { SessionLink, StoredMessage } from './types'

const MAX_LINKS = 200
const MAX_CONTEXT = 120

/** Trailing punctuation that belongs to the sentence, not to the URL. */
const TRAILING = /[.,;:!?、，。；：！？"'”’）\]】」》>]+$/

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/g

/**
 * Drop sentence punctuation from the end of a captured URL. A closing paren is
 * only dropped when it has no opening partner, so wiki links such as
 * `.../Foo_(bar)` keep theirs.
 */
function tidyUrl(raw: string): string {
  let url = raw.trim()
  for (;;) {
    const opens = url.match(/\(/g)?.length ?? 0
    const closes = url.match(/\)/g)?.length ?? 0
    if (url.endsWith(')') && closes > opens) {
      url = url.slice(0, -1)
      continue
    }
    const stripped = url.replace(TRAILING, '')
    if (stripped === url) return url
    url = stripped
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** First real line of a message, with every URL taken out. */
function contextOf(content: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.replace(URL_PATTERN, ' ').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
  const first = lines.find((line) => line.replace(/[#>*\-\s]/g, '').length > 0) ?? ''
  return first.length > MAX_CONTEXT ? `${first.slice(0, MAX_CONTEXT)}…` : first
}

/**
 * Every http(s) link a session mentions, de-duplicated by URL and newest first.
 *
 * The transcript is the only source: nothing is fetched, so the preview pane can
 * describe a link without pretending to know what is behind it. Loop-injected
 * reminders and tool-result rows are skipped: they are not real work either.
 */
export function collectSessionLinks(messages: StoredMessage[], limit = MAX_LINKS): SessionLink[] {
  const byUrl = new Map<string, SessionLink>()
  const lastSeen = new Map<string, number>()
  let index = 0
  for (const message of messages) {
    index += 1
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (!message.content) continue
    if (message.role === 'user' && (message.internal || message.control)) continue
    for (const match of message.content.matchAll(URL_PATTERN)) {
      const url = tidyUrl(match[0])
      if (url.length <= 'https://'.length) continue
      const host = hostOf(url)
      if (!host) continue
      lastSeen.set(url, index)
      const existing = byUrl.get(url)
      if (existing) {
        existing.count += 1
        continue
      }
      byUrl.set(url, {
        url,
        host,
        role: message.role,
        messageId: message.id,
        createdAt: message.createdAt,
        context: contextOf(message.content),
        count: 1,
      })
    }
  }
  // Newest mention wins the top of the list, which is the link the user just saw.
  const ordered = [...byUrl.values()].sort(
    (left, right) => (lastSeen.get(right.url) ?? 0) - (lastSeen.get(left.url) ?? 0),
  )
  return ordered.slice(0, Math.max(1, limit))
}