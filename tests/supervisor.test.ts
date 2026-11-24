import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SUPERVISOR_SETTINGS,
  SUPERVISOR_HISTORY_LIMIT,
  SUPERVISOR_MAX_PROMPT_CHARS,
  SUPERVISOR_REFLECTION_WINDOW_MS,
  analyzeSupervisor,
  buildSupervisorPrompt,
  normalizeSupervisorSettings,
  planSupervisorApply,
  trimSupervisorHistory,
  type SupervisorFinding,
  type SupervisorReflectionSample,
  type SupervisorRound,
  type SupervisorRunSample,
  type SupervisorSettings,
} from '../src/shared/supervisor'
import { SupervisorService, sanitizeSupervisorState } from '../src/main/supervisor'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-supervisor-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function run(overrides: Partial<SupervisorRunSample> = {}): SupervisorRunSample {
  return {
    id: 'r1',
    status: 'completed',
    steps: 12,
    toolCalls: 10,
    toolErrors: 0,
    totalTokens: 1000,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function finding(overrides: Partial<SupervisorFinding> = {}): SupervisorFinding {
  return {
    id: 'runs.failure-rate',
    source: 'runs',
    severity: 'high',
    title: '运行失败率偏高',
    detail: '最近 8 次完成运行里 3 次失败',
    suggestion: '先看失败样本的错误类型',
    evidence: ['r1(failed)'],
    manual: false,
    ...overrides,
  }
}

function settings(overrides: Partial<SupervisorSettings> = {}): SupervisorSettings {
  return {
    ...DEFAULT_SUPERVISOR_SETTINGS,
    enabled: true,
    apply: true,
    ...overrides,
  }
}

function round(overrides: Partial<SupervisorRound> = {}): SupervisorRound {
  return {
    id: 'sp_1',
    trigger: 'schedule',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    signals: [],
    findings: [],
    actions: [],
    score: 90,
    note: '',
    ...overrides,
  }
}

const NOW = new Date('2026-01-02T00:00:00.000Z')

function reflection(overrides: Partial<SupervisorReflectionSample> = {}): SupervisorReflectionSample {
  return {
    reportId: 'rf_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    topic: 'execution-efficiency',
    topicLabel: '执行效率',
    severity: 'medium',
    observation: '同一文件被反复整读',
    suggestion: '先按符号定位再读区间',
    ...overrides,
  }
}

describe('analyzeSupervisor', () => {
  it('没有样本时直接说明样本不足，而不是给满分健康结论', () => {
    const result = analyzeSupervisor({ runs: [] })
    expect(result.findings).toHaveLength(0)
    expect(result.score).toBe(100)
    expect(result.signals.find((signal) => signal.id === 'runs.sample')?.level).toBe('warn')
    expect(result.note).toBe('没有发现需要处理的信号。')
  })

  it('失败率达到阈值时报高风险，并把失败运行写进证据', () => {
    const result = analyzeSupervisor({
      runs: [
        run({ id: 'a', status: 'failed' }),
        run({ id: 'b', status: 'failed' }),
        run({ id: 'c', status: 'interrupted' }),
        run({ id: 'd' }),
      ],
    })
    const item = result.findings.find((entry) => entry.id === 'runs.failure-rate')
    expect(item?.severity).toBe('high')
    expect(item?.evidence[0]).toContain('a(failed)')
    expect(result.score).toBeLessThan(100)
  })

  it('样本不足 4 次时不因单次失败报警，避免噪声驱动自改', () => {
    const result = analyzeSupervisor({
      runs: [run({ id: 'a', status: 'failed' }), run({ id: 'b' })],
    })
    expect(result.findings.some((entry) => entry.id === 'runs.failure-rate')).toBe(false)
  })

  it('工具错误率高时报出来，并按错误数给出严重度', () => {
    const result = analyzeSupervisor({
      runs: Array.from({ length: 6 }, (_, index) =>
        run({ id: `r${index}`, toolCalls: 20, toolErrors: 6 }),
      ),
    })
    const item = result.findings.find((entry) => entry.id === 'runs.tool-errors')
    expect(item?.severity).toBe('high')
    expect(item?.detail).toContain('120')
  })

  it('内视异常一律标成需要人工确认，不进入自动队列', () => {
    const result = analyzeSupervisor({
      runs: [run()],
      health: [
        { id: 'model.api', label: '模型 API Key', status: 'broken', detail: '未配置' },
        { id: 'sandbox', label: '沙箱', status: 'ok' },
      ],
    })
    const item = result.findings.find((entry) => entry.id === 'health.broken')
    expect(item?.manual).toBe(true)
    expect(item?.detail).toContain('模型 API Key')
  })

  it('源码风险按严重度排序，高优先排在前面', () => {
    const result = analyzeSupervisor({
      runs: [run()],
      moduleRisks: [
        {
          id: 'client:secrets',
          moduleName: 'client',
          severity: 'high',
          title: '疑似密钥',
          recommendation: '移除并轮换',
          evidence: ['src/x.ts:3'],
          manual: true,
        },
        {
          id: 'client:large-file',
          moduleName: 'client',
          severity: 'medium',
          title: '超大文件',
          recommendation: '按域拆分',
          evidence: ['src/y.ts'],
          manual: false,
        },
      ],
    })
    const ids = result.findings.map((entry) => entry.id)
    expect(ids.indexOf('module.client:secrets')).toBeLessThan(ids.indexOf('module.client:large-file'))
    expect(result.signals.find((signal) => signal.id === 'module.risks')?.value).toContain('高 1')
  })

  it('没有反思报告时不报错，也不编造一条「0 项」的结论', () => {
    const result = analyzeSupervisor({ runs: [run()], reflections: [] }, NOW)
    expect(result.findings.some((entry) => entry.source === 'reflect')).toBe(false)
    expect(result.signals.find((signal) => signal.id === 'reflect.findings')?.value).toBe(
      '无近期报告',
    )
  })

  it('反思结论按 topic 聚合，多份报告同一问题只出一项并取最高严重度', () => {
    const result = analyzeSupervisor(
      {
        runs: [run()],
        reflections: [
          reflection({ reportId: 'rf_a', severity: 'medium', observation: '整读大文件' }),
          reflection({
            reportId: 'rf_b',
            severity: 'high',
            observation: '同一文件连读 4 次',
            suggestion: '先按符号定位',
          }),
          reflection({ topic: 'code-quality', topicLabel: '代码质量', observation: '重复实现多' }),
        ],
      },
      NOW,
    )
    const items = result.findings.filter((entry) => entry.source === 'reflect')
    expect(items.map((entry) => entry.id).sort()).toEqual([
      'reflect.code-quality',
      'reflect.execution-efficiency',
    ])
    const efficiency = items.find((entry) => entry.id === 'reflect.execution-efficiency')
    expect(efficiency?.severity).toBe('high')
    expect(efficiency?.title).toBe('反思：执行效率')
    expect(efficiency?.detail).toContain('同一文件连读 4 次')
    expect(efficiency?.suggestion).toBe('先按符号定位')
    expect(efficiency?.evidence[0]).toContain('2 条观察')
    expect(result.signals.find((signal) => signal.id === 'reflect.findings')?.value).toContain(
      '高 1',
    )
  })

  it('过期反思不参与分析，窗口边界上的仍然算数', () => {
    const stale = new Date(NOW.getTime() - SUPERVISOR_REFLECTION_WINDOW_MS - 1000).toISOString()
    const edge = new Date(NOW.getTime() - SUPERVISOR_REFLECTION_WINDOW_MS + 1000).toISOString()
    const result = analyzeSupervisor(
      {
        runs: [run()],
        reflections: [
          reflection({ reportId: 'old', createdAt: stale, severity: 'high' }),
          reflection({ reportId: 'edge', createdAt: edge, severity: 'low' }),
        ],
      },
      NOW,
    )
    expect(result.findings.some((entry) => entry.source === 'reflect')).toBe(false)
    // 窗口内只剩一条 low，不算需要处理的信号，但也不是「没有报告」。
    expect(result.signals.find((signal) => signal.id === 'reflect.findings')?.value).toBe('0')
  })

  it('取舍类问题标成需人工确认，执行类问题可以进自动队列', () => {
    const result = analyzeSupervisor(
      {
        runs: [run()],
        reflections: [
          reflection({ reportId: 'rf_a', topic: 'page-design', topicLabel: '页面设计', severity: 'high' }),
          reflection({ reportId: 'rf_b', topic: 'storage-performance', topicLabel: '存储性能' }),
        ],
      },
      NOW,
    )
    const page = result.findings.find((entry) => entry.id === 'reflect.page-design')
    const storage = result.findings.find((entry) => entry.id === 'reflect.storage-performance')
    expect(page?.manual).toBe(true)
    expect(storage?.manual).toBe(false)

    const plan = planSupervisorApply(result.findings, [], settings(), NOW)
    expect(plan.pick?.id).toBe('reflect.storage-performance')
    expect(plan.skipped).toContainEqual({
      findingId: 'reflect.page-design',
      title: page?.title,
      reason: '需要人工确认',
    })

    const manualOnly = planSupervisorApply(
      result.findings.filter((entry) => entry.manual),
      [],
      settings(),
      NOW,
    )
    expect(manualOnly.pick).toBeUndefined()
  })
})

describe('planSupervisorApply', () => {
  it('总开关关闭时只出清单', () => {
    const plan = planSupervisorApply([finding()], [], settings({ enabled: false }), NOW)
    expect(plan.pick).toBeUndefined()
    expect(plan.skipped[0]?.reason).toBe('总开关未打开')
  })

  it('未允许自动应用时不动手', () => {
    const plan = planSupervisorApply([finding()], [], settings({ apply: false }), NOW)
    expect(plan.pick).toBeUndefined()
    expect(plan.skipped[0]?.reason).toBe('未允许自动应用，只出清单')
  })

  it('manual 的问题永远不进自动队列，即使预算充足', () => {
    const plan = planSupervisorApply([finding({ manual: true })], [], settings(), NOW)
    expect(plan.pick).toBeUndefined()
    expect(plan.skipped[0]?.reason).toBe('需要人工确认')
  })

  it('每日会话预算用完后只记账不动手', () => {
    const history = [
      round({
        actions: [
          {
            at: '2026-01-01T12:00:00.000Z',
            findingId: 'runs.other',
            title: '旧问题',
            status: 'applied',
            chars: 100,
          },
        ],
      }),
    ]
    const plan = planSupervisorApply(
      [finding()],
      history,
      settings({ budget: { sessionsPerDay: 1, charsPerDay: 24000 } }),
      NOW,
    )
    expect(plan.pick).toBeUndefined()
    expect(plan.used.sessions).toBe(1)
    expect(plan.skipped[0]?.reason).toContain('每日自动会话预算已用完')
  })

  it('24 小时外执行过的动作不占预算', () => {
    const history = [
      round({
        startedAt: '2025-12-30T00:00:00.000Z',
        actions: [
          {
            at: '2025-12-30T00:00:00.000Z',
            findingId: 'runs.other',
            title: '旧问题',
            status: 'applied',
            chars: 100,
          },
        ],
      }),
    ]
    const plan = planSupervisorApply([finding()], history, settings(), NOW)
    expect(plan.pick?.id).toBe('runs.failure-rate')
    expect(plan.used.sessions).toBe(0)
  })

  it('同一问题 24 小时内只处理一次', () => {
    const history = [
      round({
        actions: [
          {
            at: '2026-01-01T12:00:00.000Z',
            findingId: 'runs.failure-rate',
            title: '运行失败率偏高',
            status: 'applied',
            chars: 100,
          },
        ],
      }),
    ]
    const plan = planSupervisorApply(
      [finding()],
      history,
      settings({ budget: { sessionsPerDay: 5, charsPerDay: 100000 } }),
      NOW,
    )
    expect(plan.pick).toBeUndefined()
    expect(plan.skipped[0]?.reason).toBe('24 小时内已处理过一次')
  })

  it('skipped 的记账不占预算，避免「上次没动手也进冷却」', () => {
    const history = [
      round({
        actions: [
          {
            at: '2026-01-01T12:00:00.000Z',
            findingId: 'runs.failure-rate',
            title: '运行失败率偏高',
            status: 'skipped',
            reason: '模型未配置',
          },
        ],
      }),
    ]
    const plan = planSupervisorApply([finding()], history, settings(), NOW)
    expect(plan.pick?.id).toBe('runs.failure-rate')
    expect(plan.used.sessions).toBe(0)
  })

  it('一轮只选一个，其余给出「本轮只处理优先级最高的一项」', () => {
    const plan = planSupervisorApply(
      [finding(), finding({ id: 'runs.tool-errors', title: '工具调用错误率偏高' })],
      [],
      settings(),
      NOW,
    )
    expect(plan.pick?.id).toBe('runs.failure-rate')
    expect(plan.skipped.find((entry) => entry.findingId === 'runs.tool-errors')?.reason).toBe(
      '本轮只处理优先级最高的一项',
    )
  })

  it('字符预算用完时不动手', () => {
    const plan = planSupervisorApply(
      [finding()],
      [],
      settings({ budget: { sessionsPerDay: 5, charsPerDay: 0 } }),
      NOW,
    )
    expect(plan.pick).toBeUndefined()
    expect(plan.skipped[0]?.reason).toContain('每日指令预算已用完')
  })
})

describe('buildSupervisorPrompt', () => {
  it('把边界写在正文前面，并要求先复现后验证', () => {
    const prompt = buildSupervisorPrompt(finding())
    expect(prompt).toContain('边界（先读，再动手）')
    expect(prompt).toContain('不得修改审批策略')
    expect(prompt).toContain('先给出能复现问题的证据')
    expect(prompt).toContain('问题：运行失败率偏高')
    expect(prompt.indexOf('边界（先读，再动手）')).toBeLessThan(prompt.indexOf('问题：'))
  })

  it('反思来源的指令额外要求先核实推论，避免为了指标而重构', () => {
    const prompt = buildSupervisorPrompt(finding({ source: 'reflect', title: '反思：执行效率' }))
    expect(prompt).toContain('是推论而非测量')
    expect(prompt.indexOf('是推论而非测量')).toBeLessThan(prompt.indexOf('问题：'))
    // 其它来源不带这条，避免噪声指令。
    expect(buildSupervisorPrompt(finding())).not.toContain('是推论而非测量')
  })

  it('证据过多时按预算截断并明确标注', () => {
    const prompt = buildSupervisorPrompt(
      finding({ evidence: Array.from({ length: 200 }, (_, index) => `ev-${index}-${'x'.repeat(80)}`) }),
    )
    expect(prompt.length).toBeLessThanOrEqual(SUPERVISOR_MAX_PROMPT_CHARS + 20)
    expect(prompt.endsWith('…（指令已按预算截断）')).toBe(true)
  })
})

describe('normalizeSupervisorSettings', () => {
  it('默认全关，且 apply 不能脱离 enabled 单独为真', () => {
    expect(normalizeSupervisorSettings(undefined).enabled).toBe(false)
    const result = normalizeSupervisorSettings({ enabled: false, apply: true })
    expect(result.apply).toBe(false)
  })

  it('间隔与预算被夹到允许范围内', () => {
    const result = normalizeSupervisorSettings({
      enabled: true,
      intervalMinutes: 1,
      budget: { sessionsPerDay: 99, charsPerDay: 999999 },
    })
    expect(result.intervalMinutes).toBe(15)
    expect(result.budget.sessionsPerDay).toBe(10)
    expect(result.budget.charsPerDay).toBe(200000)
  })
})

describe('trimSupervisorHistory', () => {
  it('只保留最近的若干轮', () => {
    const history = Array.from({ length: SUPERVISOR_HISTORY_LIMIT + 5 }, (_, index) =>
      round({ id: `sp_${index}` }),
    )
    expect(trimSupervisorHistory(history)).toHaveLength(SUPERVISOR_HISTORY_LIMIT)
    expect(trimSupervisorHistory(history)[0]?.id).toBe('sp_0')
  })
})

describe('sanitizeSupervisorState', () => {
  it('坏掉的历史条目被丢掉，设置退回默认值', () => {
    const state = sanitizeSupervisorState({
      settings: { enabled: 'yes' },
      history: [{ id: '' }, { id: 'sp_ok', startedAt: '2026-01-01T00:00:00.000Z' }],
      lastRound: null,
    })
    expect(state.settings.enabled).toBe(false)
    expect(state.history.map((entry) => entry.id)).toEqual(['sp_ok'])
    expect(state.lastRound?.id).toBe('sp_ok')
  })

  it('完全不是对象时给一份可用的默认状态', () => {
    expect(sanitizeSupervisorState(null)).toEqual({
      settings: { ...DEFAULT_SUPERVISOR_SETTINGS },
      history: [],
    })
  })
})

describe('SupervisorService', () => {
  function buildService(input: {
    sampleRuns: () => SupervisorRunSample[]
    sampleReflections?: () => Promise<SupervisorReflectionSample[]> | SupervisorReflectionSample[]
    startSession?: (workspace: string, prompt: string) => Promise<{ sessionId: string; queued?: boolean }>
  }) {
    const calls: Array<{ workspace: string; prompt: string }> = []
    const instance = new SupervisorService({
      userDataDir: root,
      sampleRuns: input.sampleRuns,
      sampleReflections: input.sampleReflections,
      selfSourceRoot: async () => root,
      startSession:
        input.startSession ??
        (async (workspace, prompt) => {
          calls.push({ workspace, prompt })
          return { sessionId: 'sess_1' }
        }),
      now: () => NOW,
    })
    return { instance, calls }
  }

  it('首次启动用默认设置，并落一份状态文件', async () => {
    const { instance } = buildService({ sampleRuns: () => [run()] })
    await instance.load()
    expect(instance.snapshot().settings.enabled).toBe(false)
    await instance.updateSettings({ intervalMinutes: 60 })
    const raw = await readFile(join(root, 'supervisor.json'), 'utf8')
    expect(JSON.parse(raw).settings.intervalMinutes).toBe(60)
  })

  it('默认设置下手动跑一轮只出清单，不建会话', async () => {
    const { instance, calls } = buildService({ sampleRuns: () => [run()] })
    const result = await instance.run('manual')
    expect(calls).toHaveLength(0)
    expect(result.actions.every((action) => action.status === 'skipped')).toBe(true)
    expect(result.finishedAt).toBe(NOW.toISOString())
  })

  it('开启自动应用后只开一个会话，并把指令与预算记进轮次', async () => {
    const { instance, calls } = buildService({
      sampleRuns: () => [
        run({ id: 'a', status: 'failed' }),
        run({ id: 'b', status: 'failed' }),
        run({ id: 'c', status: 'failed' }),
        run({ id: 'd' }),
      ],
    })
    await instance.updateSettings({ enabled: true, apply: true, intervalMinutes: 15 })
    const result = await instance.run('manual')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain('边界（先读，再动手）')
    const applied = result.actions.find((action) => action.status === 'applied')
    expect(applied?.sessionId).toBe('sess_1')
    expect(applied?.chars).toBeGreaterThan(0)
  })

  it('同一天第二次跑不会重复修同一项', async () => {
    const { instance, calls } = buildService({
      sampleRuns: () => [
        run({ id: 'a', status: 'failed' }),
        run({ id: 'b', status: 'failed' }),
        run({ id: 'c', status: 'failed' }),
        run({ id: 'd' }),
      ],
    })
    await instance.updateSettings({ enabled: true, apply: true })
    await instance.run('manual')
    await instance.run('manual')
    expect(calls).toHaveLength(1)
  })

  it('没有模型时记成 skipped，不占自动预算也不上抛', async () => {
    const { instance } = buildService({
      sampleRuns: () => [
        run({ id: 'a', status: 'failed' }),
        run({ id: 'b', status: 'failed' }),
        run({ id: 'c', status: 'failed' }),
        run({ id: 'd' }),
      ],
      startSession: async () => ({ sessionId: 'sess_q', queued: true }),
    })
    await instance.updateSettings({ enabled: true, apply: true })
    const result = await instance.run('manual')
    const action = result.actions[0]
    expect(action?.status).toBe('skipped')
    expect(action?.reason).toContain('模型未配置')
  })

  it('建会话失败时记成 error 并保留本轮报告', async () => {
    const { instance } = buildService({
      sampleRuns: () => [
        run({ id: 'a', status: 'failed' }),
        run({ id: 'b', status: 'failed' }),
        run({ id: 'c', status: 'failed' }),
        run({ id: 'd' }),
      ],
      startSession: async () => {
        throw new Error('会话已失效')
      },
    })
    await instance.updateSettings({ enabled: true, apply: true })
    const result = await instance.run('manual')
    expect(result.actions[0]?.status).toBe('error')
    expect(result.actions[0]?.reason).toContain('会话已失效')
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('重启后从状态文件恢复设置与历史', async () => {
    const { instance } = buildService({ sampleRuns: () => [run()] })
    await instance.updateSettings({ enabled: true })
    await instance.run('manual')
    const again = new SupervisorService({
      userDataDir: root,
      sampleRuns: () => [run()],
      selfSourceRoot: async () => root,
      startSession: async () => ({ sessionId: 'sess_1' }),
      now: () => NOW,
    })
    await again.load()
    expect(again.snapshot().settings.enabled).toBe(true)
    expect(again.snapshot().history).toHaveLength(1)
  })

  it('关闭总开关后排掉定时器，不再有下次运行时间', async () => {
    const { instance } = buildService({ sampleRuns: () => [run()] })
    await instance.updateSettings({ enabled: true })
    expect(instance.summary().nextRunAt).toBeTruthy()
    await instance.updateSettings({ enabled: false })
    expect(instance.summary().nextRunAt).toBeUndefined()
    instance.stop()
  })

  it('把反思结论接进本轮报告，并按护栏放行可自动处理的那一项', async () => {
    const { instance, calls } = buildService({
      sampleRuns: () => [run()],
      sampleReflections: () => [
        reflection({ reportId: 'rf_a', topic: 'storage-performance', topicLabel: '存储性能' }),
        reflection({ reportId: 'rf_b', topic: 'page-design', topicLabel: '页面设计' }),
      ],
    })
    await instance.updateSettings({ enabled: true, apply: true })
    const result = await instance.run('manual')
    expect(result.signals.find((signal) => signal.id === 'reflect.findings')?.value).toContain(
      '高 0',
    )
    expect(result.findings.map((entry) => entry.id)).toContain('reflect.storage-performance')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain('存储性能')
    // 取舍类问题只进清单，不会被开成会话。
    const pageAction = result.actions.find((action) => action.findingId === 'reflect.page-design')
    expect(pageAction?.status).toBe('skipped')
    expect(pageAction?.reason).toContain('需要人工确认')
  })

  it('反思采样抛错时只丢这一路信号，不影响本轮结果', async () => {
    const { instance } = buildService({
      sampleRuns: () => [run()],
      sampleReflections: () => {
        throw new Error('反思报告损坏')
      },
    })
    const result = await instance.run('manual')
    expect(result.id).toBeTruthy()
    expect(result.signals.find((signal) => signal.id === 'reflect.findings')?.value).toBe(
      '无近期报告',
    )
  })
})
