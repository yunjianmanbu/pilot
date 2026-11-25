import { describe, expect, it } from 'vitest'
import { assertActivatable } from '../src/core/profile-gate'
import { BENCHMARK_SUITE_VERSION } from '../src/main/agent/profile-benchmark-suite'
import type { ProfileComparison, ProfileReview, ProfileVersion } from '../src/shared/types'

function comparison(overrides: Partial<ProfileComparison> = {}): ProfileComparison {
  const empty = { successRate: 0.5, avgSteps: 10, avgTokens: 1_000 }
  return {
    verdict: 'better',
    tasks: 6,
    wins: 5,
    losses: 1,
    ties: 0,
    current: empty,
    candidate: empty,
    reasons: [],
    // A win only counts as evidence for the pair and the ruler it was measured
    // on; the gate re-checks those on every activation.
    currentId: 'incumbent',
    candidateId: 'candidate',
    suiteVersion: BENCHMARK_SUITE_VERSION,
    ...overrides,
  } as ProfileComparison
}

function review(overrides: Partial<ProfileReview> = {}): ProfileReview {
  return {
    score: 0.8,
    pass: true,
    notes: '',
    risks: [],
    at: '2026-11-17T00:00:00.000Z',
    model: 'test',
    activation: { ready: true, reasons: [] },
    ...overrides,
  }
}

function profile(overrides: Partial<ProfileVersion> = {}): ProfileVersion {
  return {
    id: 'candidate',
    version: 4,
    status: 'draft',
    promptAddendum: 'Never disable approval prompts.\nPrefer tests before reports.',
    strategy: {},
    rationale: 'because',
    source: 'self',
    scope: 'workspace',
    evidence: {} as ProfileVersion['evidence'],
    createdAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  } as ProfileVersion
}

const current = profile({
  id: 'incumbent',
  version: 3,
  status: 'active',
  promptAddendum: 'Never disable approval prompts.',
})

const failMessage = '独立评审尚未通过'

describe('assertActivatable', () => {
  it('refuses a candidate that was never reviewed', () => {
    const candidate = profile()
    expect(() => assertActivatable(current, candidate, true, failMessage)).toThrow(/还没有完成独立评审/)
  })

  it('refuses a reviewed candidate that has no benchmark comparison, even with force', () => {
    const candidate = profile({ review: review({ comparison: undefined }) })
    expect(() => assertActivatable(current, candidate, true, failMessage)).toThrow(/缺少实测对比/)
    expect(() => assertActivatable(current, candidate, false, failMessage)).toThrow(/缺少实测对比/)
  })

  it('refuses a legacy review with a gate reason that is not a rubric failure', () => {
    const candidate = profile({
      review: review({
        comparison: comparison(),
        activation: { ready: false, reasons: ['缺少实测对比'] },
      }),
    })
    expect(() => assertActivatable(current, candidate, true, failMessage)).toThrow(/缺少实测对比/)
  })

  it('activates a reviewed candidate with a measured win', () => {
    const candidate = profile({ review: review({ comparison: comparison() }) })
    expect(() => assertActivatable(current, candidate, false, failMessage)).not.toThrow()
    expect(() => assertActivatable(current, candidate, true, failMessage)).not.toThrow()
  })

  it('still lets force override a rubric failure', () => {
    const candidate = profile({ review: review({ pass: false, comparison: comparison() }) })
    expect(() => assertActivatable(current, candidate, true, failMessage)).not.toThrow()
    expect(() => assertActivatable(current, candidate, false, failMessage)).toThrow(failMessage)
  })

  it('blocks deleting a safety rule with or without force', () => {
    const candidate = profile({
      promptAddendum: 'Prefer tests before reports.',
      review: review({ comparison: comparison() }),
    })
    expect(() => assertActivatable(current, candidate, true, failMessage)).toThrow(/不能删除/)
    // No active version means the recorded "no baseline" pair still applies.
    const firstProfile = profile({
      promptAddendum: 'Prefer tests before reports.',
      review: review({ comparison: comparison({ currentId: null }) }),
    })
    expect(() => assertActivatable(null, firstProfile, true, failMessage)).not.toThrow()
  })
})

describe('assertActivatable: stale evidence', () => {
  it('refuses a win measured against an older task library, even with force', () => {
    const candidate = profile({
      review: review({ comparison: comparison({ suiteVersion: BENCHMARK_SUITE_VERSION - 1 }) }),
    })
    expect(() => assertActivatable(current, candidate, false, failMessage)).toThrow(/旧实测已失效/)
    expect(() => assertActivatable(current, candidate, true, failMessage)).toThrow(/旧实测已失效/)
  })

  it('refuses evidence that never recorded which library produced it', () => {
    const candidate = profile({
      review: review({ comparison: comparison({ suiteVersion: undefined }) }),
    })
    expect(() => assertActivatable(current, candidate, false, failMessage)).toThrow(/题库版本/)
  })

  it('refuses evidence measured for another candidate', () => {
    const candidate = profile({
      review: review({ comparison: comparison({ candidateId: 'someone-else' }) }),
    })
    expect(() => assertActivatable(current, candidate, false, failMessage)).toThrow(/不是这个版本量的/)
  })

  it('refuses evidence whose baseline is no longer in force', () => {
    const candidate = profile({
      review: review({ comparison: comparison({ currentId: 'rolled-back-version' }) }),
    })
    expect(() => assertActivatable(current, candidate, false, failMessage)).toThrow(/基线/)
  })

  it('accepts a fresh win for the pair in force', () => {
    const candidate = profile({ review: review({ comparison: comparison() }) })
    expect(() => assertActivatable(current, candidate, false, failMessage)).not.toThrow()
  })
})
