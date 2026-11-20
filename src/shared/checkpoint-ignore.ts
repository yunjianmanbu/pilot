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
 *   `pilot/pilot/out`  resolved from the workspace root
 */
export const CHECKPOINT_IGNORE_LIMIT = 200

/**
 * Scratch and generated directories a snapshot never captures.
 *
 * This is the third list, next to `SKIP_DIRS` and the user's patterns:
 *
 *   `SKIP_DIRS`        the file tree, search and project map never look here
 *   settings patterns  snapshots skip it, the file tree still shows it
 *   these names        same as a settings pattern, but always on
 *
 * A scratch tree is the case the settings list cannot cover for everyone: this
 * workspace holds 79 746 snapshottable files under `tmp/` and `.build/` against
 * ~2 700 source files, so a snapshot walk, a hash pass and a per-file blob
 * check ran over 30× more files than the code being protected. Rolling bad
 * build output back has no value, so the names below are excluded by default;
 * the agent can still read and edit them.
 *
 * Comparison is case-insensitive on every platform: `Temp` and `temp` are the
 * same scratch directory to the person who created it.
 */
export const EPHEMERAL_DIR_NAMES: readonly string[] = [
  'tmp',
  '.tmp',
  'temp',
  '.temp',
  '.build',
  'unpackage',
  '.pilot-checkpoints',
  'checkpoints',
  '.pnpm-store',
  '.parcel-cache',
  '.svelte-kit',
  '.dart_tool',
  '.gradle',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.eggs',
  '.webpack',
  'logs',
]

const ephemeralNames = new Set(EPHEMERAL_DIR_NAMES.map((name) => name.toLowerCase()))

/** True when one path segment names a scratch or generated directory. */
export function isEphemeralDirName(name: string): boolean {
  return ephemeralNames.has(name.toLowerCase())
}

/** The scratch/generated segment of a workspace-relative path, or null. */
export function ephemeralDirSegment(rel: string): string | null {
  for (const segment of rel.split(/[\\/]+/)) {
    if (segment && isEphemeralDirName(segment)) return segment
  }
  return null
}

// Names that look generated without being on the list above: `build-output`,
// `docs-cache`, `run-tmp`. Deliberately narrow — it only decides what happens
// to a directory a write is about to create, and a false positive would leave a
// real source tree out of every rollback point.
const EPHEMERAL_HINT = /(^|[._\- ])(tmp|temp|cache|build|dist|out|output|logs?|coverage|generated|scratch)([._\- ]|$)/i

/**
 * True when a newly created directory is probably scratch or generated, so the
 * caller can keep it out of snapshots before it ever enters a walk.
 */
export function looksEphemeralDirPath(rel: string): boolean {
  return rel
    .split(/[\\/]+/)
    .some(
      (segment) =>
        segment.length > 0 &&
        (isEphemeralDirName(segment) || EPHEMERAL_HINT.test(segment)),
    )
}

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
