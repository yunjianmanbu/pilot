import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BENCHMARK_LIMITS,
  ProfileBenchmark,
  compareBenchmark,
  mustPassTaskIds,
  reusableComparison,
  sanitizeProfileComparison,
  toProfileComparison,
  type BenchmarkSample,
  type BenchmarkTask,
  type TaskRunner,
} from '../src/main/agent/profile-benchmark'
import { DEFAULT_BENCHMARK_TASKS } from '../src/main/agent/profile-benchmark-tasks'
import type { ModelClient } from '../src/main/agent/loop'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function sample(
  taskId: string,
  variant: 'current' | 'candidate',
  overrides: Partial<BenchmarkSample> = {},
): BenchmarkSample {
  return { taskId, variant, ok: true, steps: 6, tokens: 1_000, ms: 1_000, ...overrides }
}

function pair(
  taskId: string,
  current: Partial<BenchmarkSample>,
  candidate: Partial<BenchmarkSample>,
): BenchmarkSample[] {
  return [sample(taskId, 'current', current), sample(taskId, 'candidate', candidate)]
}

describe('benchmark comparison', () => {
  it('refuses to judge a suite smaller than the minimum task count', () => {
    const result = compareBenchmark(pair('one', {}, {}).concat(pair('two', {}, {})))
    expect(result.verdict).toBe('insufficient')
    expect(result.tasks).toBe(2)
    expect(result.reasons.join()).toContain('至少')
  })

  it('calls the candidate better when it wins by the required margin', () => {
    const samples = [
      ...pair('a', { ok: false }, { ok: true }),
      ...pair('b', { ok: false }, { ok: true }),
      ...pair('c', {}, {}),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('better')
    expect(result.wins).toBe(2)
    expect(result.ties).toBe(1)
    expect(result.candidate.successRate).toBeGreaterThan(result.current.successRate)
  })

  it('keeps a decisive win even when the candidate costs 5x the tokens and 10x the time', () => {
    const samples = [
      ...pair('a', { ok: false }, { ok: true, tokens: 5_000, ms: 10_000 }),
      ...pair('b', { ok: false }, { ok: true, tokens: 5_000, ms: 10_000 }),
      ...pair('c', { ok: false }, { ok: true, tokens: 5_000, ms: 10_000 }),
      ...pair('d', { ok: false }, { ok: true, tokens: 5_000, ms: 10_000 }),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('better')
  })

  it('downgrades a marginal win that needs 1.5x the tokens of the current version', () => {
    const samples = [
      ...pair('a', { ok: false }, { ok: true, tokens: 2_000 }),
      ...pair('b', { ok: false }, { ok: true, tokens: 2_000 }),
      ...pair('c', {}, {}),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons.join()).toContain('成本')
  })

  it('downgrades a marginal win that takes twice as long, even at the same token count', () => {
    const samples = [
      ...pair('a', { ok: false }, { ok: true, ms: 3_000 }),
      ...pair('b', { ok: false }, { ok: true, ms: 3_000 }),
      ...pair('c', {}, {}),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons.join()).toContain('耗时')
  })

  it('persists the measured cost and duration so a later review can quote them', () => {
    const comparison = toProfileComparison(
      {
        comparison: compareBenchmark([
          ...pair(
            'a',
            { ok: false, tokens: 900, ms: 800 },
            { ok: true, tokens: 4_000, ms: 9_000 },
          ),
          ...pair('b', {}, {}),
        ]),
        samples: [],
        judgeErrors: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:05:00.000Z',
        currentProfileId: null,
      },
      [],
    )
    expect(comparison.current.avgMs).toBeGreaterThan(0)
    expect(comparison.candidate.avgMs).toBeGreaterThan(comparison.current.avgMs ?? 0)
    const restored = sanitizeProfileComparison(JSON.parse(JSON.stringify(comparison)))
    expect(restored?.current.avgMs).toBe(comparison.current.avgMs)
    expect(restored?.candidate.avgMs).toBe(comparison.candidate.avgMs)
  })

  it('calls the candidate worse when it loses a task', () => {
    const samples = [
      ...pair('a', { ok: true }, { ok: false }),
      ...pair('b', {}, {}),
      ...pair('c', {}, {}),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('worse')
    expect(result.losses).toBe(1)
  })

  it('rejects a candidate that wins overall but breaks a must-pass task', () => {
    const samples = [
      ...pair('baseline', { ok: true }, { ok: false }),
      ...pair('a', { ok: false }, { ok: true }),
      ...pair('b', { ok: false }, { ok: true }),
      ...pair('c', { ok: false }, { ok: true }),
    ]
    // Without the baseline pin this suite reads as a clear upgrade.
    expect(compareBenchmark(samples).verdict).toBe('better')
    const result = compareBenchmark(samples, { mustPassTaskIds: ['baseline'] })
    expect(result.verdict).toBe('worse')
    expect(result.reasons.join()).toContain('baseline')
    expect(result.reasons.join()).toContain('必过任务')
  })

  it('refuses an upgrade while a must-pass task fails on both sides', () => {
    const samples = [
      ...pair('baseline', { ok: false }, { ok: false }),
      ...pair('a', { ok: false }, { ok: true }),
      ...pair('b', { ok: false }, { ok: true }),
    ]
    expect(compareBenchmark(samples).verdict).toBe('better')
    const result = compareBenchmark(samples, { mustPassTaskIds: ['baseline'] })
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons.join()).toContain('两边都没通过')
  })

  it('calls two identical variants a tie', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const samples = ids.flatMap((id) =>
      pair(id, { steps: 7, tokens: 900 }, { steps: 7, tokens: 900 }),
    )
    const result = compareBenchmark(samples, { mustPassTaskIds: ['a'] })
    expect(result.tasks).toBe(ids.length)
    expect(result.wins).toBe(0)
    expect(result.losses).toBe(0)
    expect(result.ties).toBe(ids.length)
    expect(result.verdict).not.toBe('better')
    expect(result.verdict).not.toBe('worse')
  })

  it('requires enough tasks or a net margin before accepting a completion gain', () => {
    const small = compareBenchmark([
      ...pair('a', { ok: false }, { ok: true }),
      ...pair('b', {}, {}),
      ...pair('c', {}, {}),
    ])
    expect(small.verdict).toBe('inconclusive')
    expect(small.wins).toBe(1)
    expect(small.reasons.join()).toContain('少于要求的 2 个')

    const wide = compareBenchmark([
      ...pair('a', { ok: false }, { ok: true }),
      ...pair('b', {}, {}),
      ...pair('c', {}, {}),
      ...pair('d', {}, {}),
      ...pair('e', { ok: false }, { ok: true }),
    ])
    expect(wide.verdict).toBe('better')
    expect(wide.reasons.join()).toContain('执行结果优先')
  })

  it('still requires a margin when both sides complete the same tasks', () => {
    const samples = [
      ...pair('a', { judgeScore: 60 }, { judgeScore: 90 }),
      ...pair('b', { judgeScore: 80 }, { judgeScore: 80 }),
      ...pair('c', { judgeScore: 80 }, { judgeScore: 80 }),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('inconclusive')
    expect(result.wins).toBe(1)
  })

  it('never lets judge scores lift a candidate that completes fewer tasks', () => {
    const samples = [
      ...pair('a', { ok: true, judgeScore: 10 }, { ok: false, judgeScore: 99 }),
      ...pair('b', { judgeScore: 10 }, { judgeScore: 99 }),
      ...pair('c', { judgeScore: 10 }, { judgeScore: 99 }),
      ...pair('d', { judgeScore: 10 }, { judgeScore: 99 }),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('worse')
    expect(result.reasons.join()).toContain('执行结果不允许回退')
  })

  it('lets a clear completion margin outrank judge preference', () => {
    const samples = [
      ...pair('a', { ok: false, judgeScore: 99 }, { ok: true, judgeScore: 10 }),
      ...pair('b', { ok: false, judgeScore: 99 }, { ok: true, judgeScore: 10 }),
      ...pair('c', { judgeScore: 99 }, { judgeScore: 10 }),
      ...pair('d', { judgeScore: 99 }, { judgeScore: 10 }),
      ...pair('e', { judgeScore: 99 }, { judgeScore: 10 }),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('better')
    expect(result.reasons.join()).toContain('执行结果优先')
  })

  it('does not let one rescued task outrank a large judge gap', () => {
    // Same shape as the test above with a single decided pair: a judge that
    // preferred the current profile by 89 points should not be overruled by
    // one task, because one task is the noise floor of this suite.
    const result = compareBenchmark([
      ...pair('a', { ok: false, judgeScore: 99 }, { ok: true, judgeScore: 10 }),
      ...pair('b', { judgeScore: 99 }, { judgeScore: 10 }),
      ...pair('c', { judgeScore: 99 }, { judgeScore: 10 }),
      ...pair('d', { judgeScore: 99 }, { judgeScore: 10 }),
      ...pair('e', { judgeScore: 99 }, { judgeScore: 10 }),
    ])
    expect(result.verdict).toBe('inconclusive')
  })

  it('needs a clear stability difference before judge scores when completion is equal', () => {
    const unstable = compareBenchmark([
      ...pair('a', { judgeScore: 60 }, { judgeScore: 90, error: 'retried twice' }),
      ...pair('b', { judgeScore: 60 }, { judgeScore: 90, error: 'crashed once' }),
      ...pair('c', { judgeScore: 60 }, { judgeScore: 90 }),
    ])
    expect(unstable.verdict).toBe('worse')
    expect(unstable.reasons.join()).toContain('稳定性明显更差')
    const stable = compareBenchmark([
      ...pair('a', { judgeScore: 90, error: 'retried twice' }, { judgeScore: 60 }),
      ...pair('b', { judgeScore: 90, error: 'crashed once' }, { judgeScore: 60 }),
      ...pair('c', { judgeScore: 90 }, { judgeScore: 60 }),
    ])
    expect(stable.verdict).toBe('better')
    expect(stable.reasons.join()).toContain('稳定性明显更好')
  })

  it('treats a single run error as a note, not a verdict', () => {
    const result = compareBenchmark([
      ...pair('a', { judgeScore: 60 }, { judgeScore: 90, error: 'one retry' }),
      ...pair('b', { judgeScore: 60 }, { judgeScore: 90 }),
      ...pair('c', { judgeScore: 60 }, { judgeScore: 90 }),
    ])
    expect(result.verdict).toBe('better')
    expect(result.reasons.join()).toContain('只作参考')
  })

  it('breaks a step-count difference of nothing, but a large one wins', () => {
    const flat = compareBenchmark([
      ...pair('a', { steps: 8 }, { steps: 7 }),
      ...pair('b', { steps: 8 }, { steps: 7 }),
      ...pair('c', { steps: 8 }, { steps: 7 }),
    ])
    expect(flat.verdict).toBe('inconclusive')
    const clear = compareBenchmark([
      ...pair('a', { steps: 10 }, { steps: 4 }),
      ...pair('b', { steps: 10 }, { steps: 4 }),
      ...pair('c', { steps: 10 }, { steps: 5 }),
    ])
    expect(clear.verdict).toBe('better')
  })

  it('lets a judge score decide a tie but never rescue a failed check', () => {
    const judged = compareBenchmark([
      ...pair('a', { judgeScore: 60 }, { judgeScore: 90 }),
      ...pair('b', { judgeScore: 60 }, { judgeScore: 90 }),
      ...pair('c', { judgeScore: 60 }, { judgeScore: 90 }),
    ])
    expect(judged.verdict).toBe('better')
    const rescued = compareBenchmark([
      ...pair('a', { ok: false, judgeScore: 95 }, { ok: true, judgeScore: 20 }),
      ...pair('b', { ok: false, judgeScore: 95 }, { ok: true, judgeScore: 20 }),
      ...pair('c', { ok: false, judgeScore: 95 }, { ok: true, judgeScore: 20 }),
    ])
    expect(rescued.verdict).toBe('better')
    const failed = compareBenchmark([
      ...pair('a', { ok: true, judgeScore: 95 }, { ok: false, judgeScore: 10 }),
      ...pair('b', { ok: true, judgeScore: 95 }, { ok: false, judgeScore: 10 }),
      ...pair('c', { ok: true, judgeScore: 95 }, { ok: false, judgeScore: 10 }),
    ])
    expect(failed.verdict).toBe('worse')
  })

  it('ignores a task that only ran under one variant', () => {
    const result = compareBenchmark(
      [
        ...pair('a', { ok: false }, { ok: true }),
        ...pair('b', { ok: false }, { ok: true }),
        ...pair('c', { ok: false }, { ok: true }),
        sample('crash', 'current', { ok: false, error: 'boom' }),
      ],
      { minTasks: 3, minWinMargin: 2 },
    )
    expect(result.tasks).toBe(3)
    expect(result.verdict).toBe('better')
  })

  it('keeps the documented thresholds in one place', () => {
    expect(BENCHMARK_LIMITS.minTasks).toBeGreaterThan(1)
    expect(BENCHMARK_LIMITS.minWinMargin).toBeGreaterThan(1)
    expect(BENCHMARK_LIMITS.completionMarginRatio).toBeGreaterThan(0)
    expect(BENCHMARK_LIMITS.completionMarginRatio).toBeLessThan(1)
    expect(BENCHMARK_LIMITS.stabilityErrorDelta).toBeGreaterThan(1)
  })

  it('keeps a one-task gain inconclusive however wide the suite is', () => {
    // Nine decided pairs, one win and no loss: the old rule accepted this as
    // soon as the suite reached five tasks, which is exactly how a noisy suite
    // promoted a version. The margin now has to scale with the decided pairs.
    const samples = [
      ...pair('w', { ok: false }, { ok: true }),
      ...Array.from({ length: 8 }, (_, index) =>
        pair(`t${index}`, { ok: false }, { ok: false }),
      ).flat(),
    ]
    expect(compareBenchmark(samples).verdict).toBe('inconclusive')
  })

  it('accepts a wide net margin on a wide suite', () => {
    const samples = [
      ...Array.from({ length: 3 }, (_, index) => pair(`w${index}`, { ok: false }, { ok: true })).flat(),
      ...Array.from({ length: 9 }, (_, index) => pair(`t${index}`, { ok: true }, { ok: true })).flat(),
    ]
    const result = compareBenchmark(samples)
    expect(result.verdict).toBe('better')
    expect(result.wins).toBe(3)
  })

  it('treats every L0 task as a must-pass baseline', () => {
    expect(
      mustPassTaskIds([
        { id: 'smoke', prompt: 'x', difficulty: 'L0' },
        { id: 'flagged', prompt: 'x', difficulty: 'L2', mustPass: true },
        { id: 'plain', prompt: 'x', difficulty: 'L1' },
      ]),
    ).toEqual(['smoke', 'flagged'])
  })

  it('rejects a candidate that breaks an L0 smoke task', () => {
    const samples = [
      ...pair('smoke', { ok: true }, { ok: false }),
      ...pair('a', { ok: false }, { ok: true }),
      ...pair('b', { ok: false }, { ok: true }),
      ...pair('c', { ok: false }, { ok: true }),
    ]
    const result = compareBenchmark(samples, { mustPassTaskIds: ['smoke'] })
    expect(result.verdict).toBe('worse')
    expect(result.reasons.join()).toContain('smoke')
  })

  it('compacts a run into the shape persisted on a review', () => {
    const comparison = toProfileComparison(
      {
        comparison: compareBenchmark([
          ...pair('a', { ok: false }, { ok: true }),
          ...pair('b', { ok: false }, { ok: true }),
          ...pair('c', {}, {}),
        ]),
        samples: [],
        judgeErrors: ['glm: timeout'],
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:05:00.000Z',
        currentProfileId: null,
      },
      ['qwen/qwen-plus'],
    )
    expect(comparison.verdict).toBe('better')
    expect(comparison.judges).toEqual(['qwen/qwen-plus'])
    expect(comparison.judgeErrors).toEqual(['glm: timeout'])
    expect(comparison.reasons.length).toBeGreaterThan(0)
    expect(comparison.at).toBe('2026-01-01T00:05:00.000Z')
  })
})

describe('persisted comparison', () => {
  const recorded = {
    verdict: 'better' as const,
    tasks: 3,
    wins: 2,
    losses: 0,
    ties: 1,
    current: { successRate: 0.67, avgSteps: 7, avgTokens: 1_240, avgJudgeScore: 62 },
    candidate: { successRate: 1, avgSteps: 5, avgTokens: 930, avgJudgeScore: 88 },
    reasons: ['通过率 67% → 100%'],
    at: '2026-01-01T00:00:00.000Z',
    judges: ['qwen/qwen-plus', 'glm/glm-4-plus'],
    judgeErrors: ['glm/glm-4-plus: 超过 120 秒未响应'],
  }

  it('round-trips a recorded comparison through JSON', () => {
    const restored = sanitizeProfileComparison(JSON.parse(JSON.stringify(recorded)))
    expect(restored).toEqual(recorded)
  })

  it('drops an entry with no usable verdict instead of guessing one', () => {
    expect(sanitizeProfileComparison({ ...recorded, verdict: 'great' })).toBeUndefined()
    expect(sanitizeProfileComparison(null)).toBeUndefined()
    expect(sanitizeProfileComparison('better')).toBeUndefined()
  })

  it('keeps the ruler a verdict was measured against', () => {
    // Dropping these on load made every stored verdict look like it came from
    // an unknown ruler, so the suite-version check could never fire.
    const restored = sanitizeProfileComparison({
      ...recorded,
      suiteVersion: 5,
      ceilingTier: 'L3',
      ceilingPassRate: 0.25,
      suiteSaturated: false,
      currentId: null,
    })
    expect(restored?.suiteVersion).toBe(5)
    expect(restored?.ceilingTier).toBe('L3')
    expect(restored?.ceilingPassRate).toBe(0.25)
    expect(restored?.suiteSaturated).toBe(false)
    // Null means "measured with no active profile", which is not the same as a
    // legacy record that never wrote the field.
    expect(restored?.currentId).toBeNull()
    expect(restored && 'currentId' in restored).toBe(true)
  })

  it('clamps numbers and drops non-string reasons from a hand-edited file', () => {
    const restored = sanitizeProfileComparison({
      ...recorded,
      tasks: -5,
      wins: 'many',
      current: { successRate: 900, avgSteps: 1e9, avgTokens: -1, avgJudgeScore: 'high' },
      reasons: ['ok', 42, null, 'also ok'],
      judgeErrors: 'not a list',
    })
    expect(restored?.tasks).toBe(0)
    expect(restored?.wins).toBe(0)
    expect(restored?.current.successRate).toBe(100)
    expect(restored?.current.avgSteps).toBe(1_000)
    expect(restored?.current.avgTokens).toBe(0)
    expect(restored?.current.avgJudgeScore).toBeUndefined()
    expect(restored?.reasons).toEqual(['ok', 'also ok'])
    expect(restored?.judgeErrors).toBeUndefined()
  })
})

describe('comparison ids', () => {
  it('records which two profiles were compared', () => {
    const comparison = toProfileComparison(
      {
        comparison: compareBenchmark([
          ...pair('a', { ok: false }, { ok: true }),
          ...pair('b', { ok: false }, { ok: true }),
        ]),
        samples: [],
        judgeErrors: [],
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:05:00.000Z',
        currentProfileId: 'profile-active',
      },
      [],
      { currentId: 'profile-active', candidateId: 'profile-candidate' },
    )
    expect(comparison.currentId).toBe('profile-active')
    expect(comparison.candidateId).toBe('profile-candidate')
  })
})

describe('reusable measurement', () => {
  const measured = {
    verdict: 'better' as const,
    tasks: 3,
    wins: 2,
    losses: 0,
    ties: 1,
    current: { successRate: 1, avgSteps: 5, avgTokens: 100 },
    candidate: { successRate: 1, avgSteps: 4, avgTokens: 90 },
    reasons: [],
    at: '2026-01-01T00:00:00.000Z',
    suiteVersion: 4,
    currentId: 'v2',
    candidateId: 'v3',
  }

  it('keeps a measurement of the same pair', () => {
    expect(reusableComparison(measured, 'v3', 'v2', 4)).toBe(measured)
  })

  it('drops a measurement taken against a different active version', () => {
    expect(reusableComparison(measured, 'v3', 'v1', 4)).toBeUndefined()
    expect(reusableComparison(measured, 'v3', null, 4)).toBeUndefined()
  })

  it('drops a measurement of a different candidate', () => {
    expect(reusableComparison(measured, 'v4', 'v2', 4)).toBeUndefined()
  })

  it('drops a legacy entry that never recorded what it compared', () => {
    expect(
      reusableComparison(
        { ...measured, currentId: undefined, candidateId: undefined },
        'v3',
        'v2',
        4,
      ),
    ).toBeUndefined()
  })

  it('drops a verdict measured against another revision of the library', () => {
    expect(reusableComparison(measured, 'v3', 'v2', 5)).toBeUndefined()
  })

  it('drops a verdict that never recorded which library produced it', () => {
    // This is the shape of every comparison written before revisions were
    // recorded: 55 of the 58 stored ones had no version at all, and treating
    // them as valid is what kept every later candidate gated shut.
    expect(reusableComparison({ ...measured, suiteVersion: undefined }, 'v3', 'v2', 5)).toBeUndefined()
  })
})

describe('built-in benchmark tasks', () => {
  async function seed(task: BenchmarkTask, edits: Record<string, string> = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pilot-task-fixture-'))
    cleanups.push(dir)
    for (const [path, content] of Object.entries({ ...(task.files ?? {}), ...edits })) {
      const target = join(dir, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    return dir
  }

  function check(task: BenchmarkTask, cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        task.check!.command,
        task.check!.args ?? [],
        { cwd, timeout: 60_000 },
        (error) => resolve(!error),
      )
    })
  }

  // Both tests spawn one node process per task (two for an L3 CLI task), so they
  // scale with the suite size and must not inherit the 5s default timeout.
  it('fails every task on its untouched fixture', async () => {
    for (const task of DEFAULT_BENCHMARK_TASKS) {
      const dir = await seed(task)
      expect(await check(task, dir), task.id).toBe(false)
    }
  }, 180_000)

  it('passes each task after its intended fix', async () => {
    const fixes: Record<string, Record<string, string>> = {
      'fix-bug': {
        'util.js': ['function sum(a, b) {', '  return a + b', '}', '', 'module.exports = { sum }', ''].join(
          '\n',
        ),
      },
      'finish-feature': {
        'store.js': [
          'class Store {',
          '  constructor() {',
          '    this.items = []',
          '  }',
          '',
          '  add(item) {',
          '    this.items.push(item)',
          '    return this.items.length',
          '  }',
          '',
          '  remove(item) {',
          '    const index = this.items.indexOf(item)',
          '    if (index < 0) return false',
          '    this.items.splice(index, 1)',
          '    return true',
          '  }',
          '}',
          '',
          'module.exports = { Store }',
          '',
        ].join('\n'),
      },
      'respect-format': {
        'notes.md': ['# 记录', '', '- 第一点', '- 第二点', '## 结论', ''].join('\n'),
      },
      'fix-rounding': {
        'price.js': [
          'function finalPrice(price, rate) {',
          '  return Number((price * (1 - rate)).toFixed(2))',
          '}',
          '',
          'module.exports = { finalPrice }',
          '',
        ].join('\n'),
      },
      'fix-format': {
        'format.js': [
          'function formatName(first, last) {',
          "  return last + ', ' + first",
          '}',
          '',
          'module.exports = { formatName }',
          '',
        ].join('\n'),
      },
      'multifile-port-bug': {
        'src/config.js': [
          "const port = Number(process.env.PORT) || 3000",
          '',
          'module.exports = { port }',
          '',
        ].join('\n'),
      },
      'cross-file-rename': {
        'lib/a.js': [
          'function totalPrice(items) {',
          '  return items.reduce((sum, value) => sum + value, 0)',
          '}',
          '',
          'module.exports = { totalPrice }',
          '',
        ].join('\n'),
        'lib/b.js': [
          "const { totalPrice } = require('./a')",
          '',
          'function summarize(items) {',
          '  return { total: totalPrice(items), count: items.length }',
          '}',
          '',
          'module.exports = { summarize }',
          '',
        ].join('\n'),
      },
      'harden-validation': {
        'validate.js': [
          'function isEmail(value) {',
          "  if (typeof value !== 'string') return false",
          "  return /^[^\\s@]+@[^\\s@]+$/.test(value.trim())",
          '}',
          '',
          'module.exports = { isEmail }',
          '',
        ].join('\n'),
        'validate.test.js': [
          "const test = require('node:test')",
          "const assert = require('node:assert')",
          "const { isEmail } = require('./validate')",
          '',
          "test('accepts a normal address', () => {",
          "  assert.equal(isEmail('user@example.com'), true)",
          '})',
          '',
          "test('rejects a missing @', () => {",
          "  assert.equal(isEmail('plainaddress'), false)",
          '})',
          '',
          "test('rejects a missing local part', () => {",
          "  assert.equal(isEmail('@example.com'), false)",
          '})',
          '',
          "test('rejects a missing domain', () => {",
          "  assert.equal(isEmail('user@'), false)",
          '})',
          '',
        ].join('\n'),
      },
      'fix-broken-json': {
        'data.json': ['{', '  "items": [1, 2, 3]', '}', ''].join('\n'),
      },
      // L3: async entry points delegate to the single sync implementation, so
      // JSON.parse / JSON.stringify each appear exactly once.
      'budget-free-refactor': {
        'store.js': [
          "const fs = require('node:fs')",
          "const path = require('node:path')",
          '',
          'function pathFor(dir, key) {',
          "  return path.join(dir, key + '.json')",
          '}',
          '',
          'function getSync(dir, key) {',
          "  return JSON.parse(fs.readFileSync(pathFor(dir, key), 'utf8'))",
          '}',
          '',
          'function setSync(dir, key, value) {',
          "  fs.writeFileSync(pathFor(dir, key), JSON.stringify(value))",
          '}',
          '',
          'async function get(dir, key) {',
          '  return getSync(dir, key)',
          '}',
          '',
          'async function set(dir, key, value) {',
          '  setSync(dir, key, value)',
          '}',
          '',
          'module.exports = { get, set, getSync, setSync }',
          '',
        ].join('\n'),
      },
      // L3: one argument, finite non-negative amount, one-line stderr and a
      // non-zero exit code for everything else.
      'harden-cli-input': {
        'amount.js': [
          'function parseAmount(raw) {',
          "  if (typeof raw !== 'string' || raw.trim() === '') ",
          "    throw new Error('缺少金额参数')",
          '  const value = Number(raw)',
          "  if (!Number.isFinite(value) || value < 0) throw new Error('金额必须是不小于 0 的有限数字')",
          '  return value / 100',
          '}',
          '',
          'module.exports = { parseAmount }',
          '',
        ].join('\n'),
        'cli.js': [
          "const { parseAmount } = require('./amount')",
          '',
          'try {',
          '  if (process.argv.length > 3) throw new Error("只接受一个参数")',
          '  const amount = parseAmount(process.argv[2])',
          "  console.log('amount=' + amount.toFixed(2))",
          '} catch (error) {',
          '  console.error(error instanceof Error ? error.message : String(error))',
          '  process.exit(1)',
          '}',
          '',
        ].join('\n'),
      },
      // L3 combined: hourly.js delegates to the single summarize in metrics.js,
      // and cli.js owns the input contract (no stack, one stderr line).
      'compose-refactor-and-contract': {
        'hourly.js': [
          "const { summarize } = require('./metrics')",
          '',
          'function summarizeHours(values) {',
          '  return summarize(values)',
          '}',
          '',
          'module.exports = { summarizeHours }',
          '',
        ].join('\n'),
        'cli.js': [
          "const fs = require('node:fs')",
          "const { loadDaily } = require('./metrics')",
          "const { summarizeHours } = require('./hourly')",
          '',
          'try {',
          "  if (process.argv.length > 3) throw new Error('只接受一个文件参数')",
          '  const file = process.argv[2]',
          "  if (!file) throw new Error('缺少文件参数')",
          "  if (!fs.existsSync(file)) throw new Error('文件不存在：' + file)",
          '  const values = loadDaily(file)',
          '  if (values.some((value) => !Number.isFinite(value) || value < 0))',
          "    throw new Error('每行必须是不小于 0 的有限数字')",
          '  const summary = summarizeHours(values)',
          "  console.log(summary.count + ' ' + summary.total + ' ' + summary.average)",
          '} catch (error) {',
          '  console.error(error instanceof Error ? error.message : String(error))',
          '  process.exit(1)',
          '}',
          '',
        ].join('\n'),
      },
    }
    for (const task of DEFAULT_BENCHMARK_TASKS) {
      const dir = await seed(task, fixes[task.id] ?? {})
      expect(await check(task, dir), task.id).toBe(true)
    }
  }, 180_000)

  it('rejects a plausible but wrong change in respect-format', async () => {
    const task = DEFAULT_BENCHMARK_TASKS.find((entry) => entry.id === 'respect-format')!
    const dir = await seed(task, {
      'notes.md': ['# 记录', '', '- 第一点', '- 第二点', '', '## 结论', '上面是全部内容。', ''].join('\n'),
    })
    expect(await check(task, dir)).toBe(false)
  })

  it('rejects a rewrite that keeps the shape but rewords an existing line', async () => {
    const task = DEFAULT_BENCHMARK_TASKS.find((entry) => entry.id === 'respect-format')!
    // Four non-empty lines, opening heading intact, last line is the heading:
    // the old line-count check accepted this even though `第二点` was changed.
    const dir = await seed(task, {
      'notes.md': ['# 记录', '', '- 第一点', '- 二', '## 结论', ''].join('\n'),
    })
    expect(await check(task, dir)).toBe(false)
  })
})

describe('benchmark execution', () => {
  const task = (id: string, extra: Partial<BenchmarkTask> = {}): BenchmarkTask => ({
    id,
    prompt: `do ${id}`,
    ...extra,
  })

  it('runs both variants in isolated directories and alternates the order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-exec-'))
    cleanups.push(root)
    const order: string[] = []
    const runTask: TaskRunner = async ({ task: current, variant, workspacePath }) => {
      order.push(`${current.id}:${variant}`)
      // Each run sees a fresh workspace: the fixture is there, nothing else.
      await writeFile(join(workspacePath, `${current.id}-${variant}.txt`), 'x', 'utf8')
      return { ok: true, steps: 3, tokens: 100, output: variant }
    }
    const benchmark = new ProfileBenchmark(runTask)
    const run = await benchmark.run({
      tasks: [task('first'), task('second')],
      currentProfile: 'a',
      candidateProfile: 'b',
      rootDir: root,
    })
    expect(order).toEqual([
      'first:current',
      'first:candidate',
      'second:candidate',
      'second:current',
    ])
    expect(run.samples).toHaveLength(4)
    expect(run.comparison.verdict).toBe('insufficient')
  })

  it('retries a repeated task and marks a half-passing sample as flaky', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-flaky-'))
    cleanups.push(root)
    const seen = new Map<string, number>()
    const runner: TaskRunner = async ({ variant, workspacePath }) => {
      const attempt = (seen.get(variant) ?? 0) + 1
      seen.set(variant, attempt)
      // The current profile only passes its second attempt; the candidate is stable.
      if (variant === 'current' && attempt === 1) {
        await writeFile(join(workspacePath, 'first-attempt.txt'), 'x', 'utf8')
        return { ok: true, steps: 2, tokens: 10 }
      }
      await mkdir(join(workspacePath, 'done'), { recursive: true })
      return { ok: true, steps: 2, tokens: 10 }
    }
    const checked: BenchmarkTask = {
      id: 'needs-file',
      prompt: 'create the done directory',
      attempts: 2,
      check: { command: process.execPath, args: ['-e', "require('fs').statSync('done')"] },
    }
    const benchmark = new ProfileBenchmark(runner)
    const run = await benchmark.run({
      tasks: [checked],
      currentProfile: '',
      candidateProfile: 'x',
      rootDir: root,
    })
    expect(seen.get('current')).toBe(2)
    expect(seen.get('candidate')).toBe(2)
    const current = run.samples.find((entry) => entry.variant === 'current')!
    const candidate = run.samples.find((entry) => entry.variant === 'candidate')!
    // One failed attempt out of two is not a pass; the candidate passed twice.
    expect(current.ok).toBe(false)
    expect(current.flaky).toBe(true)
    expect(current.failedAttempts).toBe(1)
    expect(candidate.ok).toBe(true)
    expect(candidate.flaky).toBeUndefined()
    // Steps are averaged per attempt (2 per try), while spend is summed over the
    // attempts: a retried solve costs twice, it does not look shorter.
    expect(current.steps).toBe(2)
    expect(current.tokens).toBe(20)
  })

  it('overrides the variant verdict with the task check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-check-'))
    cleanups.push(root)
    const runner: TaskRunner = async ({ variant, workspacePath }) => {
      if (variant === 'candidate') await mkdir(join(workspacePath, 'done'), { recursive: true })
      return { ok: true, steps: 2, tokens: 50 }
    }
    const checked: BenchmarkTask = {
      id: 'needs-file',
      prompt: 'create the done directory',
      check: { command: process.execPath, args: ['-e', "require('fs').statSync('done')"] },
    }
    const benchmark = new ProfileBenchmark(runner)
    const run = await benchmark.run({
      tasks: [checked],
      currentProfile: '',
      candidateProfile: 'x',
      rootDir: root,
    })
    const current = run.samples.find((entry) => entry.variant === 'current')!
    const candidate = run.samples.find((entry) => entry.variant === 'candidate')!
    expect(current.ok).toBe(false)
    expect(candidate.ok).toBe(true)
  })

  it('judges pairs blindly and keeps the direction of each score', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-judge-'))
    cleanups.push(root)
    const prompts: string[] = []
    const judgeClient: ModelClient = {
      complete: async (request) => {
        const content = request.messages[1]?.content ?? ''
        prompts.push(content)
        // Content-aware judge: the transcript that says BETTER scores higher,
        // which is only meaningful if the A/B mapping is applied correctly.
        const aSection = content.split('Transcript B')[0] ?? ''
        const aIsBetter = aSection.includes('BETTER')
        return {
          content: JSON.stringify({
            a: { score: aIsBetter ? 90 : 40 },
            b: { score: aIsBetter ? 40 : 90 },
            better: aIsBetter ? 'a' : 'b',
          }),
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          toolCalls: [],
        }
      },
    }
    const runner: TaskRunner = async ({ variant }) => ({
      ok: true,
      steps: 3,
      tokens: 100,
      output: variant === 'candidate' ? 'BETTER work' : 'weaker work',
    })
    const benchmark = new ProfileBenchmark(runner, () => [
      { label: 'qwen/qwen-plus', client: judgeClient },
    ])
    const run = await benchmark.run({
      tasks: [task('t')],
      currentProfile: '',
      candidateProfile: 'x',
      rootDir: root,
    })
    expect(run.judgeErrors).toEqual([])
    const current = run.samples.find((entry) => entry.variant === 'current')!
    const candidate = run.samples.find((entry) => entry.variant === 'candidate')!
    // The judge scores whichever transcript scored better, so the mapping back
    // to a variant has to give the candidate the higher score.
    expect(candidate.judgeScore!).toBeGreaterThan(current.judgeScore!)
    expect(prompts).toHaveLength(1)
  })

  it('still compares outcomes when every judge fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-judgefail-'))
    cleanups.push(root)
    const broken: ModelClient = {
      complete: async () => {
        throw new Error('judge offline')
      },
    }
    const benchmark = new ProfileBenchmark(
      async ({ variant }) => ({ ok: variant === 'candidate', steps: 2, tokens: 10, output: 'x' }),
      () => [{ label: 'glm/glm-4', client: broken }],
    )
    const run = await benchmark.run({
      tasks: [task('a'), task('b'), task('c')],
      currentProfile: '',
      candidateProfile: 'x',
      rootDir: root,
    })
    expect(run.judgeErrors).toHaveLength(3)
    expect(run.comparison.verdict).toBe('better')
  })

  it('reports what the blind grading cost, per pair and per judge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-judgeusage-'))
    cleanups.push(root)
    const judgeClient: ModelClient = {
      complete: async () => ({
        content: JSON.stringify({ a: 80, b: 70 }),
        usage: { promptTokens: 1_000, completionTokens: 40, totalTokens: 1_040, cacheHitTokens: 600 },
        toolCalls: [],
      }),
    }
    const benchmark = new ProfileBenchmark(
      async ({ variant }) => ({ ok: true, steps: 1, tokens: 10, output: variant }),
      () => [{ label: 'qwen/qwen-plus', client: judgeClient }],
    )
    const run = await benchmark.run({
      tasks: [task('a'), task('b')],
      currentProfile: '',
      candidateProfile: 'x',
      rootDir: root,
    })
    // Two tasks, one configured judge: two billed requests, summed not averaged.
    expect(run.judgeUsage).toEqual({ input: 2_000, output: 80, cacheHit: 1_200, calls: 2 })
  })

  it('counts a judge call that never returned as a call without tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-judgeusage-err-'))
    cleanups.push(root)
    const broken: ModelClient = {
      complete: async () => {
        throw new Error('judge offline')
      },
    }
    const benchmark = new ProfileBenchmark(
      async ({ variant }) => ({ ok: variant === 'candidate', steps: 2, tokens: 10, output: 'x' }),
      () => [{ label: 'glm/glm-4', client: broken }],
    )
    const run = await benchmark.run({
      tasks: [task('a')],
      currentProfile: '',
      candidateProfile: 'x',
      rootDir: root,
    })
    expect(run.judgeUsage).toEqual({ input: 0, output: 0, cacheHit: 0, calls: 1 })
  })
})
