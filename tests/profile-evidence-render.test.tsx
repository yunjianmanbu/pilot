import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProfileCard } from '../src/renderer/src/components/evolution/cards'
import { BENCHMARK_SUITE_VERSION } from '../src/main/agent/profile-benchmark-suite'
import type { ProfileComparison, ProfileReview, ProfileVersion } from '../src/shared/types'

/**
 * Zero active versions used to make every stored comparison look reusable, and
 * the panel read "measured and voided" as "never measured". These tests render
 * the real card, so they check the sentence a user sees.
 */

const noop = (): void => {}

function comparison(overrides: Partial<ProfileComparison> = {}): ProfileComparison {
  const side = { successRate: 1, avgSteps: 5, avgTokens: 900 }
  return {
    verdict: 'better',
    tasks: 3,
    wins: 2,
    losses: 0,
    ties: 1,
    current: side,
    candidate: side,
    reasons: [],
    at: '2026-11-20T00:00:00.000Z',
    currentId: 'incumbent',
    candidateId: 'candidate',
    suiteVersion: BENCHMARK_SUITE_VERSION,
    ...overrides,
  }
}

function review(overrides: Partial<ProfileReview> = {}): ProfileReview {
  return {
    score: 0.9,
    pass: true,
    notes: '',
    risks: [],
    at: '2026-11-20T00:00:00.000Z',
    activation: { ready: true, reasons: [] },
    comparison: comparison(),
    ...overrides,
  } as ProfileReview
}

function profile(overrides: Partial<ProfileVersion> = {}): ProfileVersion {
  return {
    id: 'candidate',
    version: 4,
    status: 'draft',
    source: 'evolution',
    rationale: '更省时的验证顺序',
    promptAddendum: 'Run the narrowest check first.',
    strategy: {},
    evidence: { runs: 4, verified: 3, failures: 1, avgSteps: 6, avgTokens: 900, positive: 3, negative: 1 },
    createdAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  } as ProfileVersion
}

function incumbent(): ProfileVersion {
  return profile({
    id: 'incumbent',
    version: 3,
    status: 'active',
    rationale: '当前生效版本',
    review: undefined,
  })
}

function render(profileValue: ProfileVersion, suiteVersion?: number): string {
  return renderToStaticMarkup(
    <ProfileCard
      profile={profileValue}
      baseline={incumbent()}
      busy={null}
      runs={[]}
      onReview={noop}
      onBenchmark={noop}
      onActivate={noop}
      onDelete={noop}
      onLocalize={noop}
      onExplain={noop}
      {...(suiteVersion !== undefined ? { suiteVersion } : {})}
    />,
  )
}

describe('profile card evidence state', () => {
  it('offers activation when the stored win still describes the pair in force', () => {
    const html = render(profile({ review: review() }), BENCHMARK_SUITE_VERSION)
    expect(html).toContain('启用')
    expect(html).not.toContain('旧实测已失效')
  })

  it('says the old measurement is void, not that nothing was measured', () => {
    const stale = review({
      comparison: comparison({ suiteVersion: BENCHMARK_SUITE_VERSION - 1 }),
    })
    const html = render(profile({ review: stale }), BENCHMARK_SUITE_VERSION)
    expect(html).toContain('旧实测已失效')
    expect(html).toContain(`v${BENCHMARK_SUITE_VERSION - 1}`)
    // A stored `activation.ready: true` must not outvote the stale evidence.
    expect(html).not.toContain('>启用</button>')
  })

  it('keeps the void wording on a retired version instead of offering re-enable', () => {
    const stale = review({ comparison: comparison({ currentId: 'rolled-back' }) })
    const html = render(profile({ status: 'retired', review: stale }), BENCHMARK_SUITE_VERSION)
    expect(html).toContain('旧实测已失效')
    expect(html).not.toContain('>重新启用</button>')
  })
})
