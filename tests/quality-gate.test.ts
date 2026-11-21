import { describe, expect, it, vi } from 'vitest'
import { QualityService, resolvePublishScript, type PackageRunResult } from '../src/main/agent/quality'
import { defaultMetricSet, normalizeMetricSet } from '../src/shared/quality'
import type { ProfileJudge } from '../src/main/agent/evolution'
import type { ModelClient } from '../src/main/agent/loop'
import type {
  QualityCandidate,
  QualityState,
  RunEvent,
  RunRecord,
  SettingsView,
} from '../src/shared/types'

/**
 * 这些用例是发布门禁的证据：无论评估模型说什么，打包命令只在
 * “候选已批准 + 判定更优 + 目标在白名单内”三条同时成立时才会被调用。
 */

function settings(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    shellMode: true,
    shellInterpreter: 'bash',
    approvalMode: 'auto',
    permissionRules: { allow: [], ask: [], deny: [] },
    trustedCommands: [],
    classifierModel: '',
    reviewModel: '',
    sandboxMode: 'off',
    sandboxNetwork: false,
    sandboxAutoAllow: false,
    allowUnattendedBuild: false,
    learningMode: true,
    learningHosts: [],
    learningShellIsolation: false,
    qualityGate: true,
    qualityPublishTarget: 'package:dir',
    qualityTuneEvery: 5,
    checkpointRetention: 20,
    checkpointMaxBytes: 1024,
    checkpointShell: true,
    checkpointIgnore: [],
    notifyDesktop: true,
    hooksEnabled: false,
    mcpEnabled: false,
    relayUrl: '',
    globalInstructionsPath: '',
    theme: 'dark',
    fontSize: 'standard',
    locale: 'zh-CN',
    systemLocale: 'zh-CN',
    hasKey: true,
    keyHint: '',
    modelResources: [],
    activeModelId: 'primary',
    model: 'test-model',
    judgeProviders: [],
    autoContinue: false,
    autoContinueLimit: 3,
    ...overrides,
  } as SettingsView
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId: 's',
    prompt: 'add a failing guard',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    steps: 8,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    toolCalls: 6,
    toolErrors: 0,
    filesChanged: 2,
    checked: true,
    ...overrides,
  }
}

interface Harness {
  service: QualityService
  events: RunEvent[]
  packages: string[]
  state: QualityState
  store: Record<string, unknown>
}

function harness(options: {
  runs?: RunRecord[]
  initial?: Partial<QualityState>
  settings?: Partial<SettingsView>
  judgeScore?: number | null
  judgeThrows?: boolean
  /** Add a second configured judge: quality only ever consults the first one. */
  secondJudge?: boolean
  packageResult?: PackageRunResult
}): Harness {
  const state: QualityState = {
    metricSet: options.initial?.metricSet ?? defaultMetricSet(),
    baseline: options.initial?.baseline ?? null,
    candidates: options.initial?.candidates ?? [],
  }
  const events: RunEvent[] = []
  const packages: string[] = []
  const current = settings(options.settings)

  const judgeClient: ModelClient = {
    complete: vi.fn(async () => {
      if (options.judgeThrows) throw new Error('judge offline')
      const score = options.judgeScore === undefined ? 88 : options.judgeScore
      return {
        content: JSON.stringify({ reviewScore: score, verdict: '输出可用且可验证' }),
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: 'stop',
      }
    }),
  } as unknown as ModelClient

  const judge: ProfileJudge = {
    id: 'judge-1',
    label: '评审模型',
    model: 'judge-model',
    external: true,
    client: judgeClient,
  }

  const store = {
    settings: () => current,
    uiLocale: () => 'zh-CN',
    runs: () => options.runs ?? [run(), run(), run({ status: 'failed' })],
    activeWorkspace: () => '/ws',
    qualityState: () => ({
      metricSet: state.metricSet,
      baseline: state.baseline,
      candidates: state.candidates.filter((candidate) => candidate.workspacePath === '/ws'),
    }),
    setQualityMetricSet: async (metricSet: QualityState['metricSet']) => {
      state.metricSet = metricSet
    },
    setQualityBaseline: async (score: QualityState['baseline']) => {
      state.baseline = score
    },
    addQualityCandidate: async (candidate: QualityCandidate) => {
      state.candidates = [candidate, ...state.candidates]
      return candidate
    },
    updateQualityCandidate: async (id: string, patch: Partial<QualityCandidate>) => {
      state.candidates = state.candidates.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      )
      return state.candidates.find((entry) => entry.id === id)!
    },
    nextQualityVersion: (path: string) =>
      state.candidates.filter((entry) => entry.workspacePath === path).length + 1,
  }

  const service = new QualityService({
    store: store as never,
    judges: () =>
      options.secondJudge
        ? [judge, { ...judge, id: 'judge-2', label: '第二个评审', model: 'judge-2' }]
        : [judge],
    makeClient: () => judgeClient,
    packageRoot: '/pilot/pilot',
    runPackage: async (target) => {
      packages.push(target)
      return options.packageResult ?? { code: 0, output: 'built' }
    },
    onEvent: (event) => events.push(event),
    now: () => '2026-03-03T00:00:00.000Z',
  })

  return { service, events, packages, state, store }
}

function betterCandidate(): QualityCandidate {
  const score = {
    total: 92,
    metrics: [
      { id: 'passRate' as const, label: '通过率', weight: 70, value: 92 },
      { id: 'toolHealth' as const, label: '工具健康', weight: 30, value: 92 },
    ],
    missing: [],
    at: '2026-01-01T00:00:00.000Z',
    metricVersion: 1,
  }
  return {
    id: 'cand-1',
    workspacePath: '/ws',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    metricVersion: 1,
    score,
    baseline: { ...score, total: 70 },
    comparison: { better: true, delta: 22, regressions: [], reason: '总分 70 → 92' },
    verdict: '',
    evidence: { runs: 3, failures: 1, source: 'records+judge', samples: {} },
    status: 'awaiting_user',
    log: [],
  }
}

describe('resolvePublishScript', () => {
  it('只放行白名单脚本', () => {
    expect(resolvePublishScript('package:dir')).toBe('package:dir')
    expect(resolvePublishScript('package:win')).toBe('package:win')
    expect(resolvePublishScript('none')).toBeNull()
    // 任何试图夹带参数或换脚本的输入都会被拒
    expect(resolvePublishScript('package:dir && rm -rf /' as never)).toBeNull()
    expect(resolvePublishScript('deploy' as never)).toBeNull()
  })
})

describe('evaluate', () => {
  it('第一次评估建立基线，不宣称更优，也不打扰用户', async () => {
    const h = harness({})
    const state = await h.service.evaluate('/ws')
    expect(state.baseline?.total).toBeGreaterThan(0)
    expect(state.candidates).toHaveLength(1)
    expect(state.candidates[0]!.status).toBe('recorded')
    expect(state.candidates[0]!.comparison.better).toBe(false)
    const bell = h.events.filter((event) => event.type === 'quality.changed' && event.bell)
    expect(bell).toHaveLength(0)
  })

  it('高质量评估 + 已有基线 → awaiting_user 并亮铃铛', async () => {
    const first = harness({ judgeScore: 20 })
    const baselineState = await first.service.evaluate('/ws')
    const baseline = baselineState.baseline!

    const h = harness({
      initial: {
        baseline,
        candidates: baselineState.candidates,
        metricSet: first.state.metricSet,
      },
      judgeScore: 100,
      runs: [
        run(),
        run(),
        run(),
        run({ steps: 4 }),
        run({ steps: 4 }),
      ],
    })
    const state = await h.service.evaluate('/ws')
    const candidate = state.candidates[0]!
    expect(candidate.status).toBe('awaiting_user')
    expect(candidate.comparison.better).toBe(true)
    const bell = h.events.filter(
      (event): event is Extract<RunEvent, { type: 'quality.changed' }> =>
        event.type === 'quality.changed' && event.bell === true,
    )
    expect(bell).toHaveLength(1)
    expect(bell[0]!.message).toContain('等待授权')
    // 基线在用户授权前不变
    expect(state.baseline!.total).toBe(baseline.total)
  })

  it('评估模型挂掉时仍记录，但 reviewScore 缺失并在日志里说明', async () => {
    const h = harness({ judgeThrows: true })
    const state = await h.service.evaluate('/ws')
    const candidate = state.candidates[0]!
    expect(candidate.score.missing).toContain('reviewScore')
    expect(candidate.log.join('\n')).toContain('评估模型异常')
  })

  it('记录本轮评估模型的消耗与参与范围', async () => {
    const h = harness({ judgeScore: 90 })
    const state = await h.service.evaluate('/ws')
    const log = state.candidates[0]!.log.join('\n')
    // The harness judge reports 1 prompt + 1 completion token per call.
    expect(log).toContain('评估消耗：输入 1 / 输出 1')
    expect(log).toContain('共 1 次请求')
  })

  it('配置多个评估模型时明说只用第 1 个', async () => {
    const h = harness({ judgeScore: 90, secondJudge: true })
    const state = await h.service.evaluate('/ws')
    expect(state.candidates[0]!.log.join('\n')).toContain('已配置 2 个评估模型，本次只用第 1 个')
  })

  it('闸门关闭时拒绝评估', async () => {
    const h = harness({ settings: { qualityGate: false } })
    await expect(h.service.evaluate('/ws')).rejects.toThrow(/未开启/)
  })

  it('没有运行记录时给出明确错误，而不是造一个 0 分', async () => {
    const h = harness({ runs: [] })
    await expect(h.service.evaluate('/ws')).rejects.toThrow(/没有可评估/)
  })

  it('并发评估被同一道 busy 门挡住', async () => {
    const h = harness({})
    const [first, second] = await Promise.allSettled([
      h.service.evaluate('/ws'),
      h.service.evaluate('/ws'),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second.status).toBe('rejected')
  })
})

describe('decide + publish', () => {
  it('拒绝候选不会改基线，也不会打包', async () => {
    const h = harness({ initial: { candidates: [betterCandidate()] } })
    const state = await h.service.decide('/ws', 'cand-1', 'reject')
    expect(state.candidates[0]!.status).toBe('rejected')
    expect(state.baseline).toBeNull()
    expect(h.packages).toEqual([])
  })

  it('批准后更新基线并按设置的脚本打包', async () => {
    const h = harness({ initial: { candidates: [betterCandidate()] } })
    const state = await h.service.decide('/ws', 'cand-1', 'approve')
    expect(state.baseline!.total).toBe(92)
    const candidate = state.candidates[0]!
    expect(candidate.status).toBe('published')
    expect(h.packages).toEqual(['package:dir'])
    expect(candidate.log.join('\n')).toContain('pnpm package:dir')
  })

  it('批准但目标为 none 时停在 approved，不跑任何命令', async () => {
    const h = harness({
      initial: { candidates: [betterCandidate()] },
      settings: { qualityPublishTarget: 'none' },
    })
    const state = await h.service.decide('/ws', 'cand-1', 'approve')
    expect(state.candidates[0]!.status).toBe('approved')
    expect(h.packages).toEqual([])
  })

  it('打包失败保留已批准状态并通知回滚，基线已在批准时更新', async () => {
    const h = harness({
      initial: { candidates: [betterCandidate()] },
      packageResult: { code: 2, output: 'electron-builder failed' },
    })
    const state = await h.service.decide('/ws', 'cand-1', 'approve')
    const candidate = state.candidates[0]!
    expect(candidate.status).toBe('failed')
    expect(candidate.failure).toContain('2')
    expect(state.baseline!.total).toBe(92)
    const bell = h.events.filter(
      (event): event is Extract<RunEvent, { type: 'quality.changed' }> =>
        event.type === 'quality.changed' && event.bell === true,
    )
    expect(bell.some((event) => (event.message ?? '').includes('打包失败'))).toBe(true)
  })

  it('未批准的候选无法直接发布', async () => {
    const h = harness({ initial: { candidates: [{ ...betterCandidate(), status: 'recorded' }] } })
    await expect(h.service.publish('/ws', 'cand-1')).rejects.toThrow(/已批准/)
    expect(h.packages).toEqual([])
  })

  it('被判为不更优的候选即使被标记 approved 也不能发布', async () => {
    const h = harness({
      initial: {
        candidates: [
          {
            ...betterCandidate(),
            status: 'approved',
            comparison: { better: false, delta: 1, regressions: [], reason: '未达阈值' },
          },
        ],
      },
    })
    await expect(h.service.publish('/ws', 'cand-1')).rejects.toThrow(/更优/)
    expect(h.packages).toEqual([])
  })

  it('已有裁决的候选不能重复裁决', async () => {
    const h = harness({ initial: { candidates: [{ ...betterCandidate(), status: 'published' }] } })
    await expect(h.service.decide('/ws', 'cand-1', 'approve')).rejects.toThrow(/不需要裁决/)
  })
})

describe('tune', () => {
  it('手动调优写入新指标集版本并记录理由', async () => {
    const h = harness({
      runs: Array.from({ length: 8 }, () => run({ status: 'failed' })),
      initial: { metricSet: normalizeMetricSet({ version: 2, metrics: [{ id: 'satisfaction', weight: 40 }] }) },
    })
    const state = await h.service.tune('/ws')
    expect(state.metricSet.version).toBeGreaterThan(2)
    expect(state.metricSet.notes.length).toBeGreaterThan(0)
    // 通过率全是失败，权重应被抬高；总和仍为 100
    const passRate = state.metricSet.metrics.find((metric) => metric.id === 'passRate')!
    expect(passRate.weight).toBeGreaterThan(25)
    expect(state.metricSet.metrics.reduce((acc, metric) => acc + metric.weight, 0)).toBe(100)
  })

  it('只从运行记录调优时，评审分（模型给的）固定到最小权重并写明理由', async () => {
    // evaluate 是先调优再请模型打分，所以调优时 reviewScore 永远“暂无测量”。
    // 这是有意的：模型分不能在没有证据时占大权重。
    const h = harness({ runs: Array.from({ length: 4 }, () => run()) })
    const state = await h.service.tune('/ws')
    const reviewScore = state.metricSet.metrics.find((metric) => metric.id === 'reviewScore')!
    expect(reviewScore.weight).toBeLessThanOrEqual(10)
    expect(state.metricSet.notes.some((note) => note.includes('评审分'))).toBe(true)
  })
})
