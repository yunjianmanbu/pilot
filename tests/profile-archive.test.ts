import { describe, expect, it } from 'vitest'
import {
  archiveMargin,
  buildArchive,
  describeParent,
  pruneProfiles,
  selectParentProfile,
} from '../src/core/profile-archive'
import type { ProfileComparison, ProfileReview, ProfileVersion } from '../src/shared/types'

function comparison(
  overrides: Partial<ProfileComparison> & Pick<ProfileComparison, 'verdict'>,
): ProfileComparison {
  const empty = { successRate: 0, avgSteps: 10, avgTokens: 1_000 }
  return {
    tasks: 6,
    wins: 0,
    losses: 0,
    ties: 0,
    current: empty,
    candidate: empty,
    reasons: [],
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
    ...overrides,
  }
}

function profile(overrides: Partial<ProfileVersion> & Pick<ProfileVersion, 'id' | 'version'>): ProfileVersion {
  return {
    status: 'draft',
    promptAddendum: `rules ${overrides.version}`,
    strategy: {},
    rationale: 'because',
    source: 'self',
    scope: 'workspace',
    evidence: {} as ProfileVersion['evidence'],
    createdAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  } as ProfileVersion
}

const active = profile({ id: 'p5', version: 5, status: 'active' })
const proven = profile({
  id: 'p3',
  version: 3,
  status: 'retired',
  review: review({ comparison: comparison({ verdict: 'better', wins: 5, losses: 1 }) }),
})
const loser = profile({
  id: 'p2',
  version: 2,
  status: 'retired',
  review: review({ comparison: comparison({ verdict: 'worse', wins: 1, losses: 4 }) }),
})
const unmeasured = profile({ id: 'p1', version: 1, status: 'retired', review: review() })

describe('archiveMargin', () => {
  it('returns the signed measured margin per task', () => {
    expect(archiveMargin(proven)).toBeCloseTo(4 / 6)
    expect(archiveMargin(loser)).toBeCloseTo(-3 / 6)
  })

  it('returns null when nothing was benchmarked', () => {
    expect(archiveMargin(unmeasured)).toBeNull()
    expect(
      archiveMargin(
        profile({
          id: 'p9',
          version: 9,
          review: review({ comparison: comparison({ verdict: 'insufficient', tasks: 0 }) }),
        }),
      ),
    ).toBeNull()
  })
})

describe('buildArchive', () => {
  it('keeps the incumbent and proven variants but never a losing or unmeasured one', () => {
    const archive = buildArchive([active, proven, loser, unmeasured])
    expect(archive.map((entry) => entry.profile.id)).toEqual(['p3', 'p5'])
    expect(archive[0]!.measured).toBe(true)
    expect(archive[1]!.measured).toBe(false)
  })

  it('sorts measured variants best first', () => {
    const weakWin = profile({
      id: 'p4',
      version: 4,
      status: 'retired',
      review: review({ comparison: comparison({ verdict: 'better', wins: 3, losses: 2 }) }),
    })
    const archive = buildArchive([weakWin, proven, active])
    expect(archive.map((entry) => entry.profile.version)).toEqual([3, 4, 5])
  })
})

describe('selectParentProfile', () => {
  it('returns null when only unmeasured drafts exist', () => {
    expect(selectParentProfile([profile({ id: 'd1', version: 1 })])).toBeNull()
  })

  it('samples the archived winner instead of always the active profile', () => {
    const parent = selectParentProfile([active, proven, loser], { random: () => 0.5, explore: 0 })
    expect(parent?.id).toBe('p3')
  })

  it('lets a strongly measured incumbent outrank an older winner', () => {
    const strongActive = profile({
      id: 'p7',
      version: 7,
      status: 'active',
      review: review({ comparison: comparison({ verdict: 'better', wins: 6, losses: 0 }) }),
    })
    const parent = selectParentProfile([strongActive, proven], {
      random: () => 0.5,
      explore: 0,
      temperature: 0.05,
    })
    expect(parent?.id).toBe('p7')
  })

  it('explores a uniformly random variant below the explore floor', () => {
    // First draw trips exploration, the second picks the last archive entry.
    const draws = [0.01, 0.99]
    let index = 0
    const parent = selectParentProfile([active, proven, loser], {
      random: () => draws[Math.min(index++, draws.length - 1)]!,
      explore: 0.2,
    })
    expect(parent?.id).toBe('p5')
  })

  it('never returns a losing or unmeasured variant', () => {
    for (let step = 0; step < 25; step += 1) {
      const value = step / 25
      const parent = selectParentProfile([active, proven, loser, unmeasured], { random: () => value })
      expect(['p3', 'p5']).toContain(parent?.id)
    }
  })
})

describe('describeParent', () => {
  it('states the measured record so the optimizer mutates proven rules', () => {
    expect(describeParent(proven)).toContain('5W/1L/0T')
    expect(describeParent(active)).toContain('not benchmarked')
    expect(describeParent(null)).toContain('built-in defaults')
  })
})

describe('pruneProfiles', () => {
  it('keeps active, draft and proven variants when the history overflows', () => {
    const draft = profile({ id: 'd6', version: 6 })
    const history: ProfileVersion[] = [
      active,
      draft,
      proven,
      ...Array.from({ length: 10 }, (_, index) =>
        profile({ id: `r${index}`, version: 100 + index, status: 'retired' }),
      ),
    ]
    const pruned = pruneProfiles(history, 6)
    expect(pruned).toHaveLength(6)
    expect(pruned.map((entry) => entry.id)).toContain('p5')
    expect(pruned.map((entry) => entry.id)).toContain('p3')
    expect(pruned.map((entry) => entry.id)).toContain('d6')
    // Order is preserved: prune removes entries, it does not re-sort history.
    const positions = pruned.map((entry) => history.indexOf(entry))
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('keeps proven variants that would otherwise age out', () => {
    const history = [
      ...Array.from({ length: 10 }, (_, index) =>
        profile({ id: `n${index}`, version: 200 + index, status: 'retired' }),
      ),
      proven,
    ]
    const pruned = pruneProfiles(history, 5)
    expect(pruned.map((entry) => entry.id)).toContain('p3')
  })

  it('is a no-op below the limit', () => {
    const small = [active, proven]
    expect(pruneProfiles(small, 40)).toBe(small)
  })
})
