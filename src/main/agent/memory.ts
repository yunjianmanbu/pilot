import type { MemoryCategory, MemoryEntry } from '../../shared/types'
import {
  MEMORY_CATEGORIES,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_INJECT_LIMIT,
  memoryCategoryOf,
} from '../../shared/memory'

/**
 * Ranking and selection for project memory. The vocabulary and the budget
 * constants live in shared/memory.ts so the renderer can show the same numbers.
 */

/**
 * Slots each category may claim in the first pass. A category that does not use
 * its slots leaves them for the overflow pass, where the best remaining value
 * wins regardless of category, so nothing is wasted on an empty bucket.
 */
export const MEMORY_QUOTAS: Record<MemoryCategory, number> = {
  invariant: 3,
  verification: 6,
  negative: 4,
  fact: 8,
  environment: 3,
  preference: 4,
  decision: 2,
}

/** Printed once above the memory block so the labels are not opaque. */
export const MEMORY_LABEL_LEGEND =
  'Label format is [category/source]; fact = a located code fact, verification = how to prove a change, negative = a path that does not work, invariant = something that must stay in sync, environment = platform or tool constraint, decision = an abandoned approach, preference = a user preference.'

const SOURCE_WEIGHT: Record<MemoryEntry['source'], number> = {
  user: 1.5,
  agent: 1.2,
  reflection: 1,
}

/**
 * Ranking score used to fill the prompt budget. A lesson that keeps being
 * re-derived (`reinforced`) is the strongest signal that it is worth the tokens;
 * recency breaks ties; an entry injected many times but never re-derived decays.
 */
export function memoryValue(entry: MemoryEntry, at = Date.now()): number {
  const reinforced = Math.max(0, entry.reinforced ?? 0)
  const injected = Math.max(0, entry.injected ?? 0)
  const created = Date.parse(entry.createdAt)
  const ageDays = Number.isFinite(created) ? Math.max(0, (at - created) / 86_400_000) : 30
  const recency = 1 / (1 + ageDays / 45)
  const stale = injected >= 8 && reinforced === 0 ? -0.6 : 0
  return (1 + Math.min(reinforced, 5) * 1.5) * SOURCE_WEIGHT[entry.source] + recency * 0.6 + stale
}

export function normalizeMemoryContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Picks the entries that go into the next system prompt: quota pass first, then
 * the best remaining values until the limit is reached.
 */
export function selectMemories(
  memory: MemoryEntry[],
  limit = MEMORY_INJECT_LIMIT,
  at = Date.now(),
): MemoryEntry[] {
  const seen = new Set<string>()
  const ranked = memory
    .map((entry) => ({ entry, value: memoryValue(entry, at) }))
    .sort((left, right) => right.value - left.value)
    .filter((item) => {
      const key = normalizeMemoryContent(item.entry.content)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })

  const picked: MemoryEntry[] = []
  const used = new Set<string>()
  for (const category of MEMORY_CATEGORIES) {
    let taken = 0
    for (const item of ranked) {
      if (taken >= MEMORY_QUOTAS[category] || picked.length >= limit) break
      if (used.has(item.entry.id) || memoryCategoryOf(item.entry) !== category) continue
      picked.push(item.entry)
      used.add(item.entry.id)
      taken += 1
    }
  }
  for (const item of ranked) {
    if (picked.length >= limit) break
    if (used.has(item.entry.id)) continue
    picked.push(item.entry)
    used.add(item.entry.id)
  }
  return picked.slice(0, limit)
}

/** Cuts long legacy entries at a word boundary so the prompt stays readable. */
export function shortenMemory(content: string, max = MEMORY_ENTRY_MAX_CHARS): string {
  if (content.length <= max) return content
  const head = content.slice(0, max)
  const cut = head.lastIndexOf(' ')
  return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd()}…`
}

/**
 * Age marker for an entry that has been carried along for a long time. Memory is
 * rendered as present-tense fact, so a lesson from months ago reads exactly like
 * one learned today; naming the age is what lets the model treat it as a lead to
 * re-verify instead of a current truth. Fresh entries stay unmarked.
 */
export const MEMORY_STALE_AFTER_DAYS = 30

export function memoryAgeLabel(entry: MemoryEntry, at = Date.now()): string {
  const created = Date.parse(entry.createdAt)
  if (!Number.isFinite(created)) return ''
  const days = Math.floor((at - created) / 86_400_000)
  if (days < MEMORY_STALE_AFTER_DAYS) return ''
  return days >= 365 ? `${Math.floor(days / 365)} 年前` : `${days} 天前`
}

/** One prompt line per entry, labelled so the model knows what kind of fact it is. */
export function memoryPromptLine(entry: MemoryEntry, at = Date.now()): string {
  const age = memoryAgeLabel(entry, at)
  const stamp = age ? ` · ${age}` : ''
  return `- [${memoryCategoryOf(entry)}/${entry.source}${stamp}] ${shortenMemory(entry.content)}`
}

const CORRECTION_PATTERNS: RegExp[] = [
  /不是[^。\n]{0,20}(而是|，|,)/,
  /不对|错了|搞错|误解|弄错/,
  /应该(是|用|先|把)/,
  /不(要|用|许)(再)?(用|这样|直接|动|碰|改|加|删)/,
  /别再|不要再用/,
  /(还是|仍然|又)(没|不)/,
  /为什么(还|又)/,
  /重新(做|来|改)/,
  /\b(nope|not what i|that('s| is) wrong|you missed|stop using|instead|should be|don't use)\b/i,
]

/**
 * Second extraction signal: the user is correcting earlier behaviour, which is
 * exactly the moment a durable constraint becomes visible.
 */
export function looksLikeCorrection(text: string): boolean {
  const body = text.trim()
  if (!body || body.length > 600) return false
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(body))
}
