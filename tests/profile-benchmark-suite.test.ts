import { describe, expect, it } from 'vitest'
import { DEFAULT_BENCHMARK_TASKS } from '../src/main/agent/profile-benchmark-tasks'
import {
  BENCHMARK_DIMENSIONS,
  BENCHMARK_SUITE_HISTORY,
  BENCHMARK_SUITE_VERSION,
  assessCeiling,
  describeCeiling,
  planSuiteUpgrade,
  summarizeSuite,
} from '../src/main/agent/profile-benchmark-suite'
import type { BenchmarkSample, BenchmarkTask } from '../src/main/agent/profile-benchmark'

function sample(taskId: string, ok: boolean, variant: 'current' | 'candidate' = 'current'): BenchmarkSample {
  return { taskId, variant, ok, steps: 5, tokens: 200, ms: 1000 }
}

function flakySample(taskId: string, variant: 'current' | 'candidate' = 'current'): BenchmarkSample {
  // Passed one attempt, failed another: not coverage, and not a clean failure.
  return { taskId, variant, ok: false, steps: 9, tokens: 400, ms: 2000, failedAttempts: 1, flaky: true }
}

const task = (id: string, extra: Partial<BenchmarkTask> = {}): BenchmarkTask => ({
  id,
  prompt: `do ${id}`,
  ...extra,
})

describe('benchmark suite metadata', () => {
  it('reports a versioned suite that reaches the open-ended tier', () => {
    const summary = summarizeSuite(DEFAULT_BENCHMARK_TASKS)
    expect(summary.version).toBe(BENCHMARK_SUITE_VERSION)
    expect(summary.tasks).toBe(DEFAULT_BENCHMARK_TASKS.length)
    expect(summary.byTier.L0).toBeGreaterThan(0)
    expect(summary.byTier.L2).toBeGreaterThan(0)
    // Without an L3 task the suite cannot say anything about the agent's ceiling.
    expect(summary.byTier.L3).toBeGreaterThanOrEqual(2)
    expect(summary.ceilingTier).toBe('L3')
    expect(summary.warnings).toEqual([])
  })

  it('covers every declared capability dimension', () => {
    const summary = summarizeSuite(DEFAULT_BENCHMARK_TASKS)
    expect(summary.blindSpots).toEqual([])
    for (const dimension of summary.dimensions) {
      expect(dimension.taskIds.length, dimension.label).toBeGreaterThan(0)
    }
    expect(summary.dimensions.map((entry) => entry.id)).toEqual(
      BENCHMARK_DIMENSIONS.map((entry) => entry.id),
    )
  })

  it('keeps an append-only revision log whose ids all exist in the suite', () => {
    const ids = new Set(DEFAULT_BENCHMARK_TASKS.map((entry) => entry.id))
    const added = new Set<string>()
    BENCHMARK_SUITE_HISTORY.forEach((revision, index) => {
      expect(revision.version).toBe(index + 1)
      expect(revision.change.trim().length).toBeGreaterThan(0)
      // A published revision may add tasks, never drop a passing check.
      expect(revision.retired).toEqual([])
      for (const id of revision.added) {
        expect(ids.has(id), `${revision.version} 引用了不存在的任务 ${id}`).toBe(true)
        expect(added.has(id), `任务 ${id} 被登记了两次`).toBe(false)
        added.add(id)
      }
    })
    expect([...ids].sort()).toEqual([...added].sort())
  })

  it('warns when a suite has a duplicate id, an unrated task or a blind spot', () => {
    const summary = summarizeSuite([
      task('a', { difficulty: 'L1', tags: ['read-before-edit'] }),
      task('a', { difficulty: 'L1', tags: ['read-before-edit'] }),
      task('b'),
    ])
    expect(summary.warnings.join()).toContain('任务 id 重复：a')
    expect(summary.warnings.join()).toContain('任务 b 没有难度分级')
    expect(summary.ceilingTier).toBe('L1')
    expect(summary.warnings.join()).toContain('测不出能力上限')
  })
})

describe('benchmark ceiling', () => {
  const suiteTasks = [
    task('easy', { difficulty: 'L0', tags: ['instruction-following'] }),
    task('hard-a', { difficulty: 'L3', tags: ['refactor'] }),
    task('hard-b', { difficulty: 'L3', tags: ['error-contract'] }),
  ]
  const summary = summarizeSuite(suiteTasks)

  it('treats an all-pass hardest tier as a saturated ruler, not as equality', () => {
    const samples = [
      sample('easy', true),
      sample('easy', true, 'candidate'),
      sample('hard-a', true),
      sample('hard-a', true, 'candidate'),
      sample('hard-b', true),
      sample('hard-b', true, 'candidate'),
    ]
    const ceiling = assessCeiling(summary, samples, suiteTasks)
    expect(ceiling.ceilingTier).toBe('L3')
    expect(ceiling.ceilingPassRate).toBe(1)
    expect(ceiling.saturated).toBe(true)
    expect(ceiling.tiers.map((entry) => entry.tier)).toEqual(['L0', 'L3'])
    expect(ceiling.recommendations.join()).toContain('题库已饱和')
    expect(describeCeiling(ceiling)).toContain('再比较版本需要先升级题库')
  })

  it('keeps the ceiling open while a hardest task still fails', () => {
    const samples = [
      sample('easy', true),
      sample('hard-a', true),
      sample('hard-a', true, 'candidate'),
      sample('hard-b', false),
      sample('hard-b', false, 'candidate'),
    ]
    const ceiling = assessCeiling(summary, samples, suiteTasks)
    expect(ceiling.saturated).toBe(false)
    expect(ceiling.ceilingPassRate).toBe(0.5)
    expect(ceiling.recommendations.join()).toContain('能力上限仍在题库覆盖范围内')
    expect(describeCeiling(ceiling)).toContain('50%')
  })

  it('counts an unstable hardest task as unfinished instead of a pass', () => {
    const samples = [
      sample('easy', true),
      sample('hard-a', true),
      sample('hard-a', true, 'candidate'),
      flakySample('hard-b'),
      sample('hard-b', true, 'candidate'),
    ]
    const ceiling = assessCeiling(summary, samples, suiteTasks)
    const l3 = ceiling.tiers.find((entry) => entry.tier === 'L3')!
    expect(l3.flaky).toBe(1)
    expect(l3.runs).toBe(4)
    // The flaky sample is not a pass: 3 of 4 runs passed.
    expect(l3.passed).toBe(3)
    expect(l3.passRate).toBe(0.75)
    expect(ceiling.saturated).toBe(false)
    expect(describeCeiling(ceiling)).toContain('重复运行中不稳定')
  })

  it('asks for a higher tier when the hardest tier is covered but passing', () => {
    const shallow = [task('easy', { difficulty: 'L0', tags: ['instruction-following'] })]
    const shallowSummary = summarizeSuite(shallow)
    const ceiling = assessCeiling(shallowSummary, [sample('easy', true)], shallow)
    expect(ceiling.saturated).toBe(true)
    expect(ceiling.recommendations.join()).toContain('补 L1')
  })

  it('says the ceiling is unmeasured when no sample has a rated task', () => {
    const ceiling = assessCeiling(summarizeSuite([task('x')]), [sample('x', true)], [task('x')])
    expect(ceiling.ceilingTier).toBeNull()
    expect(ceiling.ceilingPassRate).toBeNull()
    expect(describeCeiling(ceiling)).toContain('尚未测出')
  })

  it('flags a single-task top tier because one result would be the whole verdict', () => {
    const single = [task('only', { difficulty: 'L3', tags: ['refactor'] })]
    const ceiling = assessCeiling(summarizeSuite(single), [sample('only', true)], single)
    expect(ceiling.recommendations.join()).toContain('只有 1 组任务')
  })
})

describe('benchmark suite upgrade plan', () => {
  // Every declared dimension is covered here, so the only remaining question in
  // these tests is the ceiling tier; a blind spot would raise a plan of its own.
  const suiteTasks = [
    task('easy', { difficulty: 'L0', tags: ['instruction-following', 'read-before-edit', 'write-tests'] }),
    task('hard-a', { difficulty: 'L3', tags: ['refactor', 'implement-method'] }),
    task('hard-b', { difficulty: 'L3', tags: ['error-contract', 'input-validation', 'edge-cases'] }),
  ]
  const summary = summarizeSuite(suiteTasks)

  it('has no blind spot of its own', () => {
    expect(summary.blindSpots).toEqual([])
  })
  it('proposes the next revision when the top tier saturates', () => {
    const samples = suiteTasks.flatMap((entry) => [sample(entry.id, true), sample(entry.id, true, 'candidate')])
    const ceiling = assessCeiling(summary, samples, suiteTasks)
    const plan = planSuiteUpgrade(summary, ceiling, suiteTasks)
    expect(plan.fromVersion).toBe(summary.version)
    expect(plan.toVersion).toBe(summary.version + 1)
    expect(plan.addTier).toBeNull()
    expect(plan.addProbes.length).toBeGreaterThan(0)
    expect(plan.reason).toContain('必须提高难度')
    // Existing tasks must keep running: shrinking the suite is not an upgrade.
    expect(plan.keepForRegression).toEqual(suiteTasks.map((entry) => entry.id))
  })

  it('leaves the version alone while the top tier still separates versions', () => {
    const samples = [
      sample('easy', true),
      sample('hard-a', true),
      sample('hard-a', true, 'candidate'),
      sample('hard-b', false),
      sample('hard-b', true, 'candidate'),
    ]
    const plan = planSuiteUpgrade(summary, assessCeiling(summary, samples, suiteTasks), suiteTasks)
    expect(plan.toVersion).toBe(summary.version)
    expect(plan.addTier).toBeNull()
    expect(plan.reason).toContain('保留现状')
  })

  it('asks for the next tier when the library stops at L2', () => {
    const shallow = [task('only', { difficulty: 'L2', tags: ['refactor'] })]
    const shallowSummary = summarizeSuite(shallow)
    const plan = planSuiteUpgrade(shallowSummary, assessCeiling(shallowSummary, [sample('only', true)], shallow), shallow)
    expect(plan.toVersion).toBe(shallowSummary.version + 1)
    expect(plan.addTier).toBe('L3')
    expect(plan.addProbes.join()).toContain('L3')
  })

  it('asks for coverage where a dimension has no task', () => {
    const narrow = [task('only', { difficulty: 'L3', tags: ['refactor'] })]
    const narrowSummary = summarizeSuite(narrow)
    const plan = planSuiteUpgrade(narrowSummary, assessCeiling(narrowSummary, [sample('only', false)], narrow), narrow)
    expect(narrowSummary.blindSpots.length).toBeGreaterThan(0)
    expect(plan.addProbes.join()).toContain('指令遵循')
    expect(plan.toVersion).toBe(narrowSummary.version + 1)
  })
})
