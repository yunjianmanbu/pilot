/**
 * Project-memory vocabulary shared by the main process and the renderer.
 *
 * Only pure data and pure functions live here: the category list, the prompt
 * budget constants and the wording-based category inference. Everything that
 * ranks or selects entries belongs to main/agent/memory.ts, which imports these.
 */

import type { MemoryEntry, Session } from './types'

/**
 * Ordered by how much a category is worth when the prompt budget is scarce;
 * the injection quota pass and the UI filter both follow this order.
 */
export const MEMORY_CATEGORIES = [
  'invariant',
  'verification',
  'negative',
  'fact',
  'environment',
  'preference',
  'decision',
] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value)
}

/** How many entries may enter one system prompt. */
export const MEMORY_INJECT_LIMIT = 25
/** How many entries a workspace keeps on disk (older ones are dropped). */
export const MEMORY_STORE_LIMIT = 120
/** Target length of a single entry: the whole block must stay a small prompt. */
export const MEMORY_ENTRY_MAX_CHARS = 240

const NEGATIVE =
  /(没有|不存在|找不到|不支持|不能用|无法|不要|别用|避免|不能|禁止|no such|does not exist|not supported|cannot|can't|don't use|never|missing)/i
const VERIFICATION =
  /(tsc|vitest|jest|playwright|npm (run|test)|pnpm|yarn|--noemit|typecheck|lint|测试|用例|验证|校验|必须跑|exit code|退出码|build)/i
const INVARIANT =
  /(必须.{0,8}(同步|一致|相同|保留)|否则|会导致|不变量|保持同步|必须与|must (stay|remain)|otherwise|in sync|breaking)/i
const ENVIRONMENT =
  /(windows|macos|linux|git bash|powershell|cmd\.exe|平台|userData|环境变量|端口|port|node_modules)/i
const DECISION = /(曾(尝试|用|经)|放弃|不再使用|改为|换成|回退|废弃|abandoned|instead of|reverted)/i

/**
 * Derives the category from the wording of the entry. Inference is a fallback:
 * an explicit category from the caller always wins.
 */
export function inferMemoryCategory(
  content: string,
  source: 'user' | 'agent' | 'reflection' = 'agent',
): MemoryCategory {
  if (DECISION.test(content)) return 'decision'
  if (INVARIANT.test(content)) return 'invariant'
  if (NEGATIVE.test(content)) return 'negative'
  if (VERIFICATION.test(content)) return 'verification'
  if (ENVIRONMENT.test(content)) return 'environment'
  if (source === 'user') return 'preference'
  return 'fact'
}

/** Category of an entry, inferring it for memories written before categories existed. */
export function memoryCategoryOf(entry: {
  content: string
  source: 'user' | 'agent' | 'reflection'
  category?: MemoryCategory
}): MemoryCategory {
  return entry.category ?? inferMemoryCategory(entry.content, entry.source)
}

/** One entry of 「会话记忆」together with how it relates to this session. */
export interface SessionMemoryRow {
  entry: MemoryEntry
  /** The entry was placed into this session's system prompt at least once. */
  injected: boolean
  /** This session wrote the entry (via the remember tool). */
  written: boolean
}

/**
 * What one session remembers.
 *
 * Entries stay workspace-wide — only the session's own ids are stored — so this
 * filters the workspace store instead of keeping a second copy that could
 * diverge. Order: what the prompt carried first (newest run first), then what
 * the session wrote but never re-read, newest first.
 */
export function sessionMemories(
  memory: MemoryEntry[],
  session: Pick<Session, 'id' | 'memoryIds'> | null,
): SessionMemoryRow[] {
  if (!session) return []
  const byId = new Map(memory.map((entry) => [entry.id, entry]))
  const rows: SessionMemoryRow[] = []
  const seen = new Set<string>()
  for (const id of session.memoryIds ?? []) {
    const entry = byId.get(id)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    rows.push({ entry, injected: true, written: entry.sessionId === session.id })
  }
  const written = memory
    .filter((entry) => entry.sessionId === session.id && !seen.has(entry.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  for (const entry of written) {
    seen.add(entry.id)
    rows.push({ entry, injected: false, written: true })
  }
  return rows
}
