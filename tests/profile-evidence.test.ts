import { describe, expect, it } from 'vitest'
import { comparisonVoidReason } from '../src/shared/profile-evidence'
import type { ProfileComparison } from '../src/shared/types'

function comparison(overrides: Partial<ProfileComparison> = {}): ProfileComparison {
  const side = { successRate: 0.5, avgSteps: 10, avgTokens: 1_000 }
  return {
    verdict: 'better',
    tasks: 6,
    wins: 5,
    losses: 1,
    ties: 0,
    current: side,
    candidate: side,
    reasons: [],
    at: '2026-11-20T00:00:00.000Z',
    currentId: 'incumbent',
    candidateId: 'candidate',
    suiteVersion: 5,
    ...overrides,
  }
}

const context = { candidateId: 'candidate', activeProfileId: 'incumbent', suiteVersion: 5 }

describe('comparisonVoidReason', () => {
  it('says nothing about a measurement that still describes the pair in force', () => {
    expect(comparisonVoidReason(comparison(), context)).toBeUndefined()
  })

  it('says nothing when there is no measurement at all', () => {
    // "never measured" is a different fact from "measured and voided"; only the
    // second one has a reason, and only it may produce the void wording.
    expect(comparisonVoidReason(undefined, context)).toBeUndefined()
  })

  it('names the task-library revision when the ruler changed', () => {
    const reason = comparisonVoidReason(comparison({ suiteVersion: 4 }), context)
    expect(reason).toContain('v4')
    expect(reason).toContain('v5')
  })

  it('flags a measurement that never recorded its revision', () => {
    expect(comparisonVoidReason(comparison({ suiteVersion: undefined }), context)).toContain(
      '没有记录题库版本',
    )
  })

  it('flags a measurement taken for another candidate', () => {
    expect(comparisonVoidReason(comparison({ candidateId: 'other' }), context)).toContain(
      '不是这个版本量的',
    )
  })

  it('flags a measurement taken under a baseline that is gone', () => {
    expect(comparisonVoidReason(comparison({ currentId: 'prev' }), context)).toContain('基线')
    expect(
      comparisonVoidReason(comparison({ currentId: 'prev' }), { ...context, activeProfileId: null }),
    ).toContain('基线')
  })

  it('keeps a "no baseline" measurement valid while the workspace still has none', () => {
    expect(
      comparisonVoidReason(comparison({ currentId: null }), { ...context, activeProfileId: null }),
    ).toBeUndefined()
  })

  it('flags a "no baseline" measurement once a baseline exists', () => {
    expect(comparisonVoidReason(comparison({ currentId: null }), context)).toContain('没有生效版本')
  })
})
