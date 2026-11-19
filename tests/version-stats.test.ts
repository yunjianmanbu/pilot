import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../src/shared/types'
import {
  COMPARE_MIN_RUNS,
  compareVersions,
  summarizeComparison,
  versionMetrics,
} from '../src/shared/version-stats'

function run(partial: Partial<RunRecord> & { profileVersion: number; status: RunRecord['status'] }): RunRecord {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    sessionId: 's1',
    prompt: 'do something',
    startedAt: '2026-11-14T00:00:00.000Z',
    steps: 10,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolCalls: 1,
    toolErrors: 0,
    ...partial,
  }
}

describe('version metrics', () => {
  it('ignores runs that are still going and other versions', () => {
    const runs: RunRecord[] = [
      run({ profileVersion: 3, status: 'completed', steps: 10 }),
      run({ profileVersion: 3, status: 'running', steps: 99 }),
      run({ profileVersion: 2, status: 'completed', steps: 40 }),
    ]
    const metrics = versionMetrics(runs, 3)
    expect(metrics.finished).toBe(1)
    expect(metrics.avgSteps).toBe(10)
    expect(metrics.successRate).toBe(1)
  })

  it('counts step-cap endings, tool errors, checks and ratings', () => {
    const runs: RunRecord[] = [
      run({ profileVersion: 4, status: 'max_steps', steps: 60, toolErrors: 3, checked: false }),
      run({ profileVersion: 4, status: 'completed', steps: 20, toolErrors: 1, checked: true }),
      run({
        profileVersion: 4,
        status: 'completed',
        steps: 20,
        feedback: { rating: 'up', at: '2026-11-14T00:00:00.000Z' },
      }),
    ]
    const metrics = versionMetrics(runs, 4)
    expect(metrics.finished).toBe(3)
    expect(metrics.successRate).toBeCloseTo(2 / 3)
    expect(metrics.maxStepRate).toBeCloseTo(1 / 3)
    expect(metrics.avgSteps).toBeCloseTo(100 / 3)
    expect(metrics.avgToolErrors).toBeCloseTo(4 / 3)
    expect(metrics.checkedRate).toBe(0.5)
    expect(metrics.ratingUp).toBe(1)
    expect(metrics.ratingDown).toBe(0)
  })
})

describe('version comparison', () => {
  const baseline = Array.from({ length: 6 }, () =>
    run({ profileVersion: 5, status: 'max_steps', steps: 70, toolErrors: 2, checked: false }),
  )
  const improved = Array.from({ length: 6 }, () =>
    run({ profileVersion: 6, status: 'completed', steps: 30, toolErrors: 0, checked: true }),
  )

  it('reports an improvement with plain-language findings', () => {
    const comparison = compareVersions([...baseline, ...improved], 5, 6)
    expect(comparison.verdict).toBe('ready')
    expect(comparison.baseline.finished).toBe(6)
    expect(comparison.candidate.finished).toBe(6)
    expect(comparison.findings.length).toBeGreaterThan(0)
    expect(comparison.findings.join('\n')).toContain('撞到步数上限')
    expect(summarizeComparison(comparison)).toContain('v5')
  })

  it('says a never-run version cannot be compared yet', () => {
    const comparison = compareVersions(baseline, 5, 6)
    expect(comparison.verdict).toBe('untested')
    expect(comparison.findings).toEqual([])
  })

  it('refuses to draw conclusions from a handful of runs', () => {
    const comparison = compareVersions([...baseline.slice(0, 2), ...improved.slice(0, 2)], 5, 6, COMPARE_MIN_RUNS)
    expect(comparison.verdict).toBe('too-few')
    expect(comparison.findings).toEqual([])
  })

  it('reports a regression when the new version is worse', () => {
    const worse = Array.from({ length: 6 }, () => run({ profileVersion: 7, status: 'failed', steps: 90, toolErrors: 4 }))
    const comparison = compareVersions([...improved, ...worse], 6, 7)
    expect(comparison.verdict).toBe('ready')
    expect(comparison.findings.some((item) => item.includes('低于旧版'))).toBe(true)
  })
})
