import { describe, expect, it } from 'vitest'
import {
  QUALITY_METRIC_LIMITS,
  balanceWeights,
  compareQuality,
  defaultMetricSet,
  normalizeMetricSet,
  qualityPromptBlock,
  scoreMetrics,
  signalsFromRuns,
  tuneMetricSet,
  type QualityScore,
} from '../src/shared/quality'
import type { RunRecord } from '../src/shared/types'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: 's1',
    prompt: 'p',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    steps: 10,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    toolCalls: 10,
    toolErrors: 0,
    ...overrides,
  }
}

function scoreOf(total: number, overrides: Record<string, number> = {}): QualityScore {
  const base = {
    passRate: total,
    verification: total,
    toolHealth: total,
    satisfaction: total,
    reviewScore: total,
    efficiency: total,
    ...overrides,
  }
  return scoreMetrics(defaultMetricSet(), base, '2026-01-01T00:00:00.000Z')
}

describe('balanceWeights', () => {
  it('恒定为 100，单项不越界', () => {
    for (const input of [
      [100, 0, 0, 0, 0, 0],
      [1, 1, 1, 1, 1, 1],
      [999, 12, 3, 3, 3, 3],
      [25, 20, 15, 15, 15, 10],
    ]) {
      const weights = balanceWeights(input as number[])
      expect(weights.reduce((a, b) => a + b, 0)).toBe(QUALITY_METRIC_LIMITS.total)
      for (const weight of weights) {
        expect(weight).toBeGreaterThanOrEqual(QUALITY_METRIC_LIMITS.weight.min)
        expect(weight).toBeLessThanOrEqual(QUALITY_METRIC_LIMITS.weight.max)
      }
    }
  })

  it('保留相对大小：最大的输入仍拿最大权重', () => {
    const weights = balanceWeights([40, 20, 15, 15, 5, 5])
    expect(weights[0]).toBe(Math.max(...weights))
  })
})

describe('normalizeMetricSet', () => {
  it('丢弃未知指标、补回缺失维度、标签不受输入控制', () => {
    const set = normalizeMetricSet({
      version: 4,
      metrics: [
        { id: 'passRate', weight: 90, label: '被篡改的标签' },
        { id: 'hacked', weight: 50 },
      ],
      notes: ['a', 'b'],
    })
    expect(set.version).toBe(4)
    expect(set.metrics.map((metric) => metric.id)).toEqual([
      'passRate',
      'verification',
      'toolHealth',
      'satisfaction',
      'reviewScore',
      'efficiency',
    ])
    expect(set.metrics.find((metric) => metric.id === 'passRate')?.label).toBe('通过率')
    expect(set.metrics.reduce((acc, metric) => acc + metric.weight, 0)).toBe(100)
  })

  it('非法输入回退默认集', () => {
    expect(normalizeMetricSet(null).metrics).toHaveLength(6)
    expect(normalizeMetricSet('oops').version).toBe(1)
    expect(normalizeMetricSet({ metrics: [{ id: 'passRate', weight: Number.NaN }] }).metrics.reduce(
      (acc, metric) => acc + metric.weight,
      0,
    )).toBe(100)
  })
})

describe('scoreMetrics', () => {
  it('加权求和，缺失指标按已有权重分摊', () => {
    const set = defaultMetricSet()
    const full = scoreMetrics(set, {
      passRate: 100,
      verification: 100,
      toolHealth: 100,
      satisfaction: 100,
      reviewScore: 100,
      efficiency: 100,
    })
    expect(full.total).toBe(100)
    expect(full.missing).toEqual([])

    const partial = scoreMetrics(set, { passRate: 100 })
    expect(partial.total).toBe(100)
    expect(partial.missing).toHaveLength(5)
  })

  it('夹取越界值', () => {
    const set = defaultMetricSet()
    const score = scoreMetrics(set, {
      passRate: 200,
      verification: -50,
      toolHealth: 50,
      satisfaction: 50,
      reviewScore: 50,
      efficiency: 50,
    })
    expect(score.metrics.find((metric) => metric.id === 'passRate')?.value).toBe(100)
    expect(score.metrics.find((metric) => metric.id === 'verification')?.value).toBe(0)
  })
})

describe('signalsFromRuns', () => {
  it('从记录算通过率、验证覆盖、工具健康、满意度、效率', () => {
    const signals = signalsFromRuns([
      run({ status: 'completed', filesChanged: 2, checked: true, steps: 6, feedback: { rating: 'up', at: 'x' } }),
      run({ status: 'completed', filesChanged: 1, checked: false, steps: 12 }),
      run({ status: 'failed', toolCalls: 4, toolErrors: 2 }),
      run({ status: 'cancelled' }),
    ])
    expect(signals.runs).toBe(3)
    expect(signals.failures).toBe(1)
    expect(signals.values.passRate).toBeCloseTo(66.7, 1)
    expect(signals.values.verification).toBe(50)
    // 只统计未被取消的运行，被取消的那次确实消耗了工具，但不代表质量
    expect(signals.values.toolHealth).toBeCloseTo(91.7, 1)
    expect(signals.values.satisfaction).toBe(100)
    expect(signals.samples.passRate).toBe(3)
  })

  it('没有可用记录时返回空指标，不编造 0 分', () => {
    const signals = signalsFromRuns([])
    expect(signals.values).toEqual({})
    expect(signals.runs).toBe(0)
  })
})

describe('tuneMetricSet', () => {
  it('低分维度加权、高分维度减权，并保持总和 100', () => {
    const set = defaultMetricSet()
    const signals = signalsFromRuns([
      ...Array.from({ length: 5 }, () => run({ status: 'failed' })),
      ...Array.from({ length: 5 }, () => run({ status: 'completed', steps: 8 })),
    ])
    const tuned = tuneMetricSet(set, signals, '2026-02-02T00:00:00.000Z')
    expect(tuned.set.version).toBe(set.version + 1)
    expect(tuned.set.metrics.reduce((acc, metric) => acc + metric.weight, 0)).toBe(100)
    expect(tuned.changes.length).toBeGreaterThan(0)
    expect(tuned.set.notes.length).toBe(tuned.changes.length)
    expect(tuned.set.notes.join('\n')).toContain('通过率')
  })

  it('样本不足的维度压到最小权重', () => {
    const set = normalizeMetricSet({
      version: 3,
      metrics: [{ id: 'satisfaction', weight: 30 }],
    })
    const tuned = tuneMetricSet(set, signalsFromRuns([run()]))
    const satisfaction = tuned.set.metrics.find((metric) => metric.id === 'satisfaction')
    expect(satisfaction?.weight).toBe(QUALITY_METRIC_LIMITS.weight.min)
  })

  it('没有任何指标越界时保持原对象与版本号', () => {
    const set = defaultMetricSet()
    const values = {
      passRate: 75,
      verification: 75,
      toolHealth: 75,
      satisfaction: 75,
      reviewScore: 75,
      efficiency: 75,
    }
    const tuned = tuneMetricSet(set, {
      values,
      samples: {
        passRate: 5,
        verification: 5,
        toolHealth: 5,
        satisfaction: 5,
        reviewScore: 5,
        efficiency: 5,
      },
      runs: 5,
      failures: 1,
    })
    expect(tuned.set).toBe(set)
    expect(tuned.changes).toEqual([])
  })
})

describe('compareQuality', () => {
  it('无基线时不宣称更优', () => {
    const result = compareQuality(null, scoreOf(70))
    expect(result.better).toBe(false)
    expect(result.reason).toContain('基线')
  })

  it('提升超过阈值且无单项大幅回退才算更优', () => {
    const baseline = scoreOf(80)
    const better = compareQuality(baseline, scoreOf(84))
    expect(better.better).toBe(true)
    expect(better.delta).toBe(4)

    const tooSmall = compareQuality(baseline, scoreOf(82))
    expect(tooSmall.better).toBe(false)
    expect(tooSmall.reason).toContain('阈值')
  })

  it('单项回退超过上限时，总分再高也不算更优', () => {
    const baseline = scoreOf(80)
    const candidate = scoreOf(90, { verification: 60 })
    const result = compareQuality(baseline, candidate)
    expect(result.better).toBe(false)
    expect(result.regressions).toEqual(['verification'])
    expect(result.reason).toContain('验证覆盖')
  })
})

describe('qualityPromptBlock', () => {
  it('写出指标、权重、现行分数与最弱项', () => {
    const block = qualityPromptBlock(defaultMetricSet(), scoreOf(70, { efficiency: 20 }), 2)
    expect(block).toContain('指标集 v1')
    expect(block).toContain('步数效率')
    expect(block).toContain('最弱项')
    expect(block).toContain('待授权候选：2 个')
  })

  it('没有基线时明说尚未建立', () => {
    expect(qualityPromptBlock(defaultMetricSet(), null, 0)).toContain('尚未建立基线')
  })
})
