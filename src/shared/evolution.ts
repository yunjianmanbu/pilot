import type { EvolutionPolicy } from './types'

/**
 * Hard bounds for every tunable of the self-evolution loop. The loop may
 * evolve these values, but the main process clamps them here, so a bad
 * proposal cannot disable review or open an unbounded spending loop.
 */
export const EVOLUTION_LIMITS = {
  minRuns: { min: 3, max: 50 },
  reviewScore: { min: 75, max: 95 },
  cooldownRuns: { min: 3, max: 50 },
  evidenceRuns: { min: 10, max: 100 },
  watchRuns: { min: 3, max: 50 },
  regressionDelta: { min: 5, max: 50 },
  metaEvery: { min: 3, max: 20 },
  focusChars: 400,
} as const

export const DEFAULT_EVOLUTION_POLICY: EvolutionPolicy = {
  autoApply: true,
  minRuns: 3,
  reviewScore: 75,
  cooldownRuns: 6,
  evidenceRuns: 30,
  watchRuns: 8,
  regressionDelta: 15,
  metaEvery: 5,
  focus: '',
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function clampBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Stable comparison key that ignores the timestamp. */
export function evolutionPolicyKey(policy: EvolutionPolicy): string {
  return JSON.stringify([
    policy.autoApply,
    policy.minRuns,
    policy.reviewScore,
    policy.cooldownRuns,
    policy.evidenceRuns,
    policy.watchRuns,
    policy.regressionDelta,
    policy.metaEvery,
    policy.focus,
  ])
}

/**
 * Merge a persisted or proposed policy onto a base policy and clamp every
 * field. Unknown fields are dropped.
 */
export function normalizeEvolutionPolicy(
  value: unknown,
  base: EvolutionPolicy = DEFAULT_EVOLUTION_POLICY,
): EvolutionPolicy {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const policy: EvolutionPolicy = {
    autoApply: clampBoolean(record['autoApply'], base.autoApply),
    minRuns: clampNumber(record['minRuns'], base.minRuns, EVOLUTION_LIMITS.minRuns.min, EVOLUTION_LIMITS.minRuns.max),
    reviewScore: clampNumber(
      record['reviewScore'],
      base.reviewScore,
      EVOLUTION_LIMITS.reviewScore.min,
      EVOLUTION_LIMITS.reviewScore.max,
    ),
    cooldownRuns: clampNumber(
      record['cooldownRuns'],
      base.cooldownRuns,
      EVOLUTION_LIMITS.cooldownRuns.min,
      EVOLUTION_LIMITS.cooldownRuns.max,
    ),
    evidenceRuns: clampNumber(
      record['evidenceRuns'],
      base.evidenceRuns,
      EVOLUTION_LIMITS.evidenceRuns.min,
      EVOLUTION_LIMITS.evidenceRuns.max,
    ),
    watchRuns: clampNumber(
      record['watchRuns'],
      base.watchRuns,
      EVOLUTION_LIMITS.watchRuns.min,
      EVOLUTION_LIMITS.watchRuns.max,
    ),
    regressionDelta: clampNumber(
      record['regressionDelta'],
      base.regressionDelta,
      EVOLUTION_LIMITS.regressionDelta.min,
      EVOLUTION_LIMITS.regressionDelta.max,
    ),
    metaEvery: clampNumber(
      record['metaEvery'],
      base.metaEvery,
      EVOLUTION_LIMITS.metaEvery.min,
      EVOLUTION_LIMITS.metaEvery.max,
    ),
    focus:
      typeof record['focus'] === 'string'
        ? record['focus'].replace(/\s+/g, ' ').trim().slice(0, EVOLUTION_LIMITS.focusChars)
        : base.focus,
  }
  if (typeof record['updatedAt'] === 'string') policy.updatedAt = record['updatedAt']
  else if (base.updatedAt) policy.updatedAt = base.updatedAt
  return policy
}
