import { describe, expect, it } from 'vitest'
import {
  SELF_CHECK_PROBE_IDS,
  buildSelfCheckReport,
  runSelfCheck,
  type SelfCheckContext,
} from '../src/main/self-check'
import {
  countSelfCheck,
  renderSelfCheckText,
  sanitizeSelfCheckReport,
  sortSelfCheckItems,
  worstSelfCheckStatus,
  type SelfCheckItem,
} from '../src/shared/self-check'
import type {
  DynamicToolInfo,
  PluginOverview,
  SandboxStatus,
  SettingsView,
  SystemInfo,
  UpdateState,
} from '../src/shared/types'
import { sanitizeReport } from '../src/shared/module-check'

/**
 * 内视的验收点：
 * - 每个模块都给结论和证据，不靠默认值把「没读到」说成正常；
 * - 一个来源失败只影响它自己那一项；
 * - 没有工作区时，按工作区存放的模块报「未启用」而不是报异常。
 */

function fakeSettings(overrides: Record<string, unknown> = {}): SettingsView {
  return {
    model: 'gpt-5',
    baseUrl: 'https://example.com/v1',
    defaultApprovalMode: 'ask',
    permissionRules: { allow: [], ask: [], deny: [] },
    trustedCommands: [],
    sandboxMode: 'process',
    shellMode: true,
    shellInterpreter: 'auto',
    ...overrides,
  } as unknown as SettingsView
}

const HEALTHY_SANDBOX = {
  mode: 'process',
  available: true,
  backend: 'process',
  detail: '进程策略可用',
  networkIsolation: true,
} as unknown as SandboxStatus

function fakeSystemInfo(diskLow = false): SystemInfo {
  return {
    platform: 'win32',
    osRelease: '10.0.26100',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCount: 8,
    memoryFreeBytes: 4 * 1024 ** 3,
    memoryTotalBytes: 16 * 1024 ** 3,
    disk: {
      path: 'C:\\data',
      freeBytes: diskLow ? 512 * 1024 ** 2 : 120 * 1024 ** 3,
      totalBytes: 512 * 1024 ** 3,
      low: diskLow,
    },
  } as unknown as SystemInfo
}

const HEALTHY_UPDATE: UpdateState = {
  status: 'idle',
  currentVersion: '0.13.0',
  release: null,
  progress: 0,
  transferred: 0,
  total: 0,
  message: '',
  checkedAt: null,
  canInstall: false,
  elevationRequired: false,
} as unknown as UpdateState

function fakeContext(overrides: Partial<SelfCheckContext> = {}): SelfCheckContext {
  return {
    version: '0.13.0',
    packaged: false,
    appPath: 'C:/pilot',
    userDataPath: 'C:/pilot-data',
    currentWorkspace: 'C:/ws',
    settings: fakeSettings(),
    workspaces: [],
    modelResources: [
      {
        id: 'r1',
        label: 'Main',
        baseUrl: 'https://example.com/v1',
        model: 'gpt-5',
        tag: '',
        enabled: true,
        hasKey: true,
        keyHint: '••••1234',
      },
    ],
    scheduled: [],
    moduleCheck: {
      settings: { enabled: false, intervalHours: 24, modules: [] },
      history: [],
      decisions: [],
      proposals: [],
    },
    sandbox: HEALTHY_SANDBOX,
    update: HEALTHY_UPDATE,
    systemInfo: fakeSystemInfo(),
    feedback: { dir: 'C:/pilot-data/feedback', pending: 3 },
    dynamicTools: [],
    plugins: {
      workspace: 'C:/ws',
      pluginsDir: 'C:/ws/.pilot/plugins',
      plugins: [],
      invalid: [],
      maxPlugins: 20,
    } as unknown as PluginOverview,
    mcpServers: {},
    errors: {},
    now: Date.UTC(2026, 10, 16, 7, 0, 0),
    ...overrides,
  }
}

function findItem(items: readonly SelfCheckItem[], id: string): SelfCheckItem {
  const found = items.find((item) => item.id === id)
  if (!found) throw new Error(`missing item ${id}`)
  return found
}

describe('self-check report', () => {
  it('covers every probe and finds nothing broken on a healthy host', () => {
    const report = buildSelfCheckReport(fakeContext())
    expect(report.items.map((item) => item.id).sort()).toEqual([...SELF_CHECK_PROBE_IDS].sort())
    expect(report.counts.broken).toBe(0)
    expect(report.counts.warn).toBe(0)
    expect(findItem(report.items, 'runtime').status).toBe('ok')
    expect(findItem(report.items, 'model').status).toBe('ok')
    expect(findItem(report.items, 'sandbox').status).toBe('ok')
    expect(findItem(report.items, 'feedback').detail).toContain('3')
  })

  it('turns a failed source into a broken item instead of a sane-looking default', () => {
    const report = buildSelfCheckReport(
      fakeContext({ errors: { sandbox: 'detect() 抛错：spawn 失败' } }),
    )
    const sandbox = findItem(report.items, 'sandbox')
    expect(sandbox.status).toBe('broken')
    expect(sandbox.detail).toBe('取样失败')
    expect(sandbox.facts).toEqual(['detect() 抛错：spawn 失败'])
    expect(report.counts.broken).toBe(1)
    // 其余模块不受影响。
    expect(findItem(report.items, 'runtime').status).toBe('ok')
  })

  it('reports workspace-scoped modules as off when no workspace is open', () => {
    const report = buildSelfCheckReport(
      fakeContext({ currentWorkspace: null, plugins: null, mcpServers: null, dynamicTools: [] }),
    )
    for (const id of ['dynamicTools', 'mcp', 'plugins']) {
      expect(findItem(report.items, id).status).toBe('off')
      expect(findItem(report.items, id).detail).toBe('未打开工作区')
    }
  })

  it('warns on a nearly full volume and says what to do', () => {
    const report = buildSelfCheckReport(fakeContext({ systemInfo: fakeSystemInfo(true) }))
    const system = findItem(report.items, 'system')
    expect(system.status).toBe('warn')
    expect(system.hint).toBeTruthy()
    expect(system.facts.join('\n')).toContain('磁盘')
  })

  it('warns when approval rules can never match, and counts rules from any shape', () => {
    const report = buildSelfCheckReport(
      fakeContext({
        settings: fakeSettings({
          permissionRules: { allow: ['run_command:git status'], ask: [], deny: ['x', 'y'] },
        }),
      }),
    )
    const approval = findItem(report.items, 'approval')
    expect(approval.status).toBe('ok')
    expect(approval.facts.join('\n')).toContain('权限规则 3 条')
  })

  it('treats a workspace with no generated tools as off, not broken', () => {
    const report = buildSelfCheckReport(fakeContext())
    expect(findItem(report.items, 'dynamicTools').status).toBe('off')
    expect(findItem(report.items, 'mcp').status).toBe('off')
  })

  it('内视把行数与拆分决策分开说，并在报告未命中时退回仓库决策表', () => {
    const report = buildSelfCheckReport(fakeContext())
    const moduleCheck = findItem(report.items, 'moduleCheck')
    const text = moduleCheck.facts.join('\n')
    // 没有报告：行数与决策都该说“没有”，而不是把 0 条决策当成“不需要拆”。
    expect(text).toContain('超过 800 行的文件 0 个')
    expect(text).toContain('仓库记录')
    expect(text).toContain('src/main/agent/loop.ts')
  })

  it('已决策的大文件不计入“待决策”，未量过的与已有判据的分开说', () => {
    const report = buildSelfCheckReport(
      fakeContext({
        moduleCheck: {
          settings: { enabled: true, intervalHours: 24, modules: [] },
          history: [],
          decisions: [],
          proposals: [],
          lastRunAt: '2026-11-20T10:00:00.000Z',
          lastReport: {
            id: 'mr_1',
            trigger: 'manual',
            workspace: 'C:/ws',
            startedAt: '2026-11-20T09:59:00.000Z',
            finishedAt: '2026-11-20T10:00:00.000Z',
            modules: ['pilot'],
            targets: [],
            risks: [],
            scannedFiles: 10,
            scannedLines: 1000,
            score: 100,
            largeFiles: [
              { path: 'src/main/agent/runner.ts', lines: 1900, decided: true },
              { path: 'src/main/new-big.ts', lines: 900, decided: false },
            ],
          },
        },
      }),
    )
    const facts = findItem(report.items, 'moduleCheck').facts.join('\n')
    expect(facts).toContain('2 个：1 个待决策（0 个已有判据、1 个还没量过），1 个已有拆分决策')
    // 行数不是结论：没量过的文件要求先跑脚本，而不是直接建议拆。
    expect(facts).toContain('还没量过的：src/main/new-big.ts')
    expect(facts).toContain('split-candidates.mjs')
    // 实测判据分布作为背景，避免把行数读成拆分理由。
    expect(facts).toContain('实测判据分布')
    // 本次扫描没有命中任何决策，但决策表本身仍是事实，不能显示成“没有决策”。
    expect(facts).toContain('仓库记录')
  })

  it('旧报告没写 decided 时也认得仓库里的拆分决策', () => {
    const report = buildSelfCheckReport(
      fakeContext({
        moduleCheck: {
          settings: { enabled: true, intervalHours: 24, modules: [] },
          history: [],
          decisions: [],
          proposals: [],
          lastRunAt: '2026-11-20T10:00:00.000Z',
          // 上一版写盘的报告没有 decided 字段：不拿决策表兜底的话，
          // 已经拍过板的 runner.ts 会重新变成“待决策”。这里走真实读盘路径。
          lastReport: sanitizeReport({
            id: 'mr_legacy',
            trigger: 'manual',
            workspace: 'C:/ws',
            startedAt: '2026-11-20T09:59:00.000Z',
            finishedAt: '2026-11-20T10:00:00.000Z',
            modules: ['pilot'],
            targets: [],
            risks: [],
            scannedFiles: 10,
            scannedLines: 1000,
            score: 100,
            largeFiles: [{ path: 'src/main/agent/runner.ts', lines: 1900 }],
          })!,
        },
      }),
    )
    const facts = findItem(report.items, 'moduleCheck').facts.join('\n')
    expect(facts).toContain('1 个已有拆分决策')
    expect(facts).not.toContain('待决策（')
  })

  it('已量过判据但未决策的文件不再要求重跑脚本', () => {
    const report = buildSelfCheckReport(
      fakeContext({
        moduleCheck: {
          settings: { enabled: true, intervalHours: 24, modules: [] },
          history: [],
          decisions: [],
          proposals: [],
          lastRunAt: '2026-11-20T10:00:00.000Z',
          lastReport: {
            id: 'mr_2',
            trigger: 'manual',
            workspace: 'C:/ws',
            startedAt: '2026-11-20T09:59:00.000Z',
            finishedAt: '2026-11-20T10:00:00.000Z',
            modules: ['pilot'],
            targets: [],
            risks: [],
            scannedFiles: 10,
            scannedLines: 1000,
            score: 100,
            largeFiles: [{ path: 'src/main/new-big.ts', lines: 900, decided: false, verdict: 'SHARED' }],
          },
        },
      }),
    )
    const facts = findItem(report.items, 'moduleCheck').facts.join('\n')
    expect(facts).toContain('1 个待决策（1 个已有判据、0 个还没量过）')
    expect(facts).toContain('只差决策的：src/main/new-big.ts SHARED')
    expect(facts).not.toContain('还没量过的')
  })

  it('renders a copyable text report with groups, facts and hints', () => {
    const report = buildSelfCheckReport(fakeContext({ systemInfo: fakeSystemInfo(true) }))
    const text = renderSelfCheckText(report)
    expect(text).toContain('Pilot 内视')
    expect(text).toContain('[运行时]')
    expect(text).toContain('建议：')
    expect(text.split('\n')[1]).toBe(
      `正常 ${report.counts.ok} · 注意 ${report.counts.warn} · 未启用 ${report.counts.off} · 异常 ${report.counts.broken}`,
    )
  })
})

describe('collecting sources', () => {
  it('keeps the rest of the report when one collector throws', async () => {
    const report = await runSelfCheck({
      version: '0.13.0',
      packaged: true,
      appPath: 'C:/pilot',
      userDataPath: 'C:/pilot-data',
      currentWorkspace: null,
      settings: () => fakeSettings(),
      workspaces: () => [],
      modelResources: () => [],
      scheduled: () => [],
      moduleCheck: () => ({
        settings: { enabled: false, intervalHours: 24, modules: [] },
        history: [],
        decisions: [],
        proposals: [],
      }),
      sandbox: async () => HEALTHY_SANDBOX,
      update: () => HEALTHY_UPDATE,
      systemInfo: async () => {
        throw new Error('statfs 不可用')
      },
      feedback: { dir: 'C:/pilot-data/feedback', list: async () => [] },
      dynamicTools: async () => [] as DynamicToolInfo[],
      plugins: async () => ({}) as PluginOverview,
      mcpServers: async () => ({}),
      now: () => 1_700_000_000_000,
    })
    expect(findItem(report.items, 'system').status).toBe('broken')
    expect(findItem(report.items, 'system').facts).toEqual(['statfs 不可用'])
    expect(findItem(report.items, 'runtime').status).toBe('ok')
    expect(findItem(report.items, 'store').status).toBe('ok')
    expect(report.at).toBe(1_700_000_000_000)
    expect(report.version).toBe('0.13.0')
  })
})

describe('helpers', () => {
  function item(overrides: Partial<SelfCheckItem> = {}): SelfCheckItem {
    return {
      id: 'probe',
      group: 'exec',
      title: '沙箱',
      status: 'ok',
      detail: 'ok',
      facts: [],
      durationMs: 0,
      ...overrides,
    }
  }

  it('counts statuses and picks the worst one for the header', () => {
    const counts = countSelfCheck([
      item({ status: 'ok' }),
      item({ status: 'warn' }),
      item({ status: 'off' }),
      item({ status: 'broken' }),
    ])
    expect(counts).toEqual({ ok: 1, warn: 1, off: 1, broken: 1 })
    expect(worstSelfCheckStatus(counts)).toBe('broken')
    expect(worstSelfCheckStatus({ ok: 0, warn: 0, off: 2, broken: 0 })).toBe('off')
    expect(worstSelfCheckStatus({ ok: 2, warn: 0, off: 0, broken: 0 })).toBe('ok')
  })

  it('sorts by group, then by worst status inside the group', () => {
    const sorted = sortSelfCheckItems([
      item({ id: 'a', group: 'data', status: 'ok' }),
      item({ id: 'b', group: 'runtime', status: 'ok' }),
      item({ id: 'c', group: 'runtime', status: 'broken' }),
    ])
    expect(sorted.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
  })

  it('drops a malformed report instead of rendering half of it', () => {
    expect(sanitizeSelfCheckReport(null)).toBeNull()
    expect(sanitizeSelfCheckReport({ at: 1, version: 'x', items: 'nope' })).toBeNull()
    expect(
      sanitizeSelfCheckReport({
        at: 1,
        version: 'x',
        durationMs: 5,
        items: [{ id: 'a', group: 'exec', title: 't', status: 'weird', detail: 'd', facts: [] }],
      }),
    ).toBeNull()

    const safe = sanitizeSelfCheckReport({
      at: 1,
      version: 'x',
      durationMs: 5,
      items: [
        { id: 'a', group: 'exec', title: 't', status: 'warn', detail: 'd', facts: ['f', 3], durationMs: 2 },
      ],
    })
    expect(safe?.items).toHaveLength(1)
    expect(safe?.items[0]?.facts).toEqual(['f'])
    expect(safe?.counts.warn).toBe(1)
  })
})
