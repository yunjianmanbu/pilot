/**
 * Measured archive of profile variants, sampled instead of climbed linearly.
 *
 * The loop used to mutate only the profile that is currently in force and, when
 * a cycle regressed, roll back one step. That is bookkeeping, not search: the
 * moment the incumbent is a local optimum every later draft starts from the
 * same dead end. Darwin-Gödel-Machine style loops keep an archive of *measured*
 * variants alive and pick a parent from it, so a rule set that scored well
 * three generations ago can still be branched from after the incumbent lost
 * ground.
 *
 * Only variants with a persisted paired benchmark (or the incumbent itself)
 * enter the archive. An unmeasured draft is never a parent: that is exactly how
 * an unproven rule set becomes the ancestor of everything.
 *
 * Both hosts (desktop main and the phone/server shim) share this module, so it
 * carries no Node or Electron imports.
 */
import type { ProfileVersion } from '../shared/types'

export interface ArchiveCandidate {
  profile: ProfileVersion
  /** Signed measured margin per benchmark task: (wins - losses) / tasks. */
  margin: number
  /** False for the incumbent, which is a parent by default rather than by measurement. */
  measured: boolean
}

export interface ArchiveOptions {
  /** Injectable RNG so tests are exact instead of statistical. */
  random?: () => number
  /** Probability of exploring a uniformly random variant instead of the best. */
  explore?: number
  /** Softmax temperature over the margin; smaller concentrates on the best. */
  temperature?: number
  /** Multiplier that keeps the incumbent in play without drowning out winners. */
  incumbentBias?: number
}

const DEFAULT_EXPLORE = 0.2
const DEFAULT_TEMPERATURE = 0.35
const DEFAULT_INCUMBENT_BIAS = 1.5

/** Measured margin of a variant, or null when it was never benchmarked. */
export function archiveMargin(profile: ProfileVersion): number | null {
  const comparison = profile.review?.comparison
  if (!comparison || comparison.tasks <= 0) return null
  return (comparison.wins - comparison.losses) / comparison.tasks
}

/** A retired variant is only worth keeping alive when it actually won. */
function isProvenVariant(profile: ProfileVersion): boolean {
  if (profile.status !== 'retired') return false
  const comparison = profile.review?.comparison
  return Boolean(comparison && comparison.verdict === 'better' && archiveMargin(profile) !== null)
}

/**
 * Every variant eligible to seed the next proposal, best measured first.
 * The incumbent is always eligible, whether or not it was ever benchmarked.
 */
export function buildArchive(profiles: ProfileVersion[]): ArchiveCandidate[] {
  return profiles
    .filter((profile) => profile.status === 'active' || isProvenVariant(profile))
    .map((profile) => {
      const margin = archiveMargin(profile)
      return { profile, margin: margin ?? 0, measured: margin !== null }
    })
    .sort((left, right) => right.margin - left.margin)
}

/**
 * Pick the parent for the next draft. Most of the time this is the best measured
 * variant, sometimes a uniformly random one, which keeps a losing-but-different
 * branch reachable instead of pruning the tree down to one lineage.
 */
export function selectParentProfile(
  profiles: ProfileVersion[],
  options: ArchiveOptions = {},
): ProfileVersion | null {
  const archive = buildArchive(profiles)
  if (archive.length === 0) return null
  const first = archive[0]!
  if (archive.length === 1) return first.profile
  const random = options.random ?? Math.random
  const explore = options.explore ?? DEFAULT_EXPLORE
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE
  const incumbentBias = options.incumbentBias ?? DEFAULT_INCUMBENT_BIAS
  if (random() < explore) {
    const index = Math.min(archive.length - 1, Math.floor(random() * archive.length))
    return archive[index]!.profile
  }
  const weights = archive.map(
    (entry) =>
      Math.exp(entry.margin / temperature) *
      (entry.profile.status === 'active' ? incumbentBias : 1),
  )
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let ticket = random() * total
  for (let index = 0; index < archive.length; index += 1) {
    ticket -= weights[index]!
    if (ticket <= 0) return archive[index]!.profile
  }
  return archive[archive.length - 1]!.profile
}

/**
 * One-line provenance for the optimizer prompt: which variant seeds this draft
 * and what it measured, so the model mutates proven rules rather than guessing.
 */
export function describeParent(profile: ProfileVersion | null): string {
  if (!profile) return 'Parent for this draft: built-in defaults (no workspace profile yet)'
  const comparison = profile.review?.comparison
  const label = `Parent for this draft: v${profile.version} (${profile.status} archive variant)`
  if (!comparison) return `${label}; not benchmarked, it is the profile in force`
  return `${label}; measured ${comparison.wins}W/${comparison.losses}L/${comparison.ties}T over ${comparison.tasks} tasks (${comparison.verdict})`
}

export const MAX_PROFILES = 40

/**
 * Which profiles may never be dropped, lower wins: the profile in force, then
 * measured winners, then drafts still awaiting a verdict.
 */
function keepPriority(profile: ProfileVersion): number {
  if (profile.status === 'active') return 0
  if (isProvenVariant(profile)) return 1
  if (profile.status === 'draft') return 2
  return 3
}

/**
 * Keep the profile history bounded without throwing away the only good ancestors:
 * the incumbent, drafts still awaiting a decision, and every variant that proved
 * a measured improvement survive; the rest are dropped oldest first.
 *
 * Selection is by priority, not by list position. The list is newest-first, so a
 * plain `filter(pinned).slice(0, limit)` drops the *oldest* pinned entry once
 * drafts alone fill the quota — that entry is the active profile, whose rules
 * then silently stop reaching the prompt and the page shows no current version.
 * `sort` is stable, so within one priority the newest entries still win.
 */
export function pruneProfiles(profiles: ProfileVersion[], limit = MAX_PROFILES): ProfileVersion[] {
  if (profiles.length <= limit) return profiles
  const keep = new Set(
    [...profiles]
      .sort((left, right) => keepPriority(left) - keepPriority(right))
      .slice(0, limit)
      .map((profile) => profile.id),
  )
  // Order is preserved: prune removes entries, it does not re-sort history.
  return profiles.filter((profile) => keep.has(profile.id))
}
