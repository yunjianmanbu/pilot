/**
 * Snapshot-only ignore patterns (Settings → 回退点).
 *
 * Why this is not `SKIP_DIRS`: that list means "the file tree, search, project
 * map and diff never look here". A build cache or a scratch directory is the
 * opposite — you want to read it, but hashing 19k of its files on every
 * snapshot turns a 0.14 s checkpoint into a 4.6 s one and pushes the source
 * files out of the snapshot budget.
 *
 * Pattern syntax (deliberately small):
 *   `tmp`          a directory or file named tmp at any depth
 *   `build-*`      glob within one path segment (`?` matches one character)
 *   `pilot/client/out`  resolved from the workspace root
 */
export const CHECKPOINT_IGNORE_LIMIT = 200

export function normalizeCheckpointIgnore(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    // Absolute patterns are rejected before trimming separators, otherwise
    // `/etc` would silently become the harmless relative pattern `etc`.
    if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) continue
    const pattern = trimmed
      .split('\\')
      .join('/')
      .split('/')
      .filter((segment) => segment.length > 0 && segment !== '.')
      .join('/')
    if (!pattern) continue
    // A pattern can narrow the snapshot, never widen it to a parent directory.
    if (pattern.split('/').includes('..')) continue
    if (out.includes(pattern)) continue
    out.push(pattern)
    if (out.length >= CHECKPOINT_IGNORE_LIMIT) break
  }
  return out
}

const matchers = new Map<string, RegExp>()

function segmentMatcher(segment: string): RegExp {
  const cached = matchers.get(segment)
  if (cached) return cached
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  const matcher = new RegExp(`^${source}$`)
  if (matchers.size < 512) matchers.set(segment, matcher)
  return matcher
}

/** True when `rel` (workspace-relative, forward slashes) matches a pattern. */
export function matchesCheckpointIgnore(rel: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  const segments = rel.split('/')
  for (const pattern of patterns) {
    const parts = pattern.split('/')
    if (parts.length === 1) {
      if (segments.some((segment) => segmentMatcher(pattern).test(segment))) return true
      continue
    }
    if (segments.length < parts.length) continue
    let matched = true
    for (let index = 0; index < parts.length; index += 1) {
      if (!segmentMatcher(parts[index]!).test(segments[index]!)) {
        matched = false
        break
      }
    }
    if (matched) return true
  }
  return false
}
