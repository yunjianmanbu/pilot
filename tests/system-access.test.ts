import { describe, expect, it } from 'vitest'
import type {
  EvolutionPolicy,
  EvolutionState,
  MemoryEntry,
  ProfileEvidence,
  ProfileVersion,
  RunRecord,
  SettingsView,
  WorkspaceSummary,
} from '../src/shared/types'
import {
  buildExecutionRecordsReport,
  buildSystemStrategyReport,
  grantCovers,
  parseAccessRequest,
  READ_EXECUTION_RECORDS,
  READ_SYSTEM_STRATEGY,
  REQUEST_SYSTEM_ACCESS,
  systemAccessPolicy,
  systemAccessTools,
  type SystemAccessGrant,
  type SystemAccessStore,
} from '../src/main/agent/system-access'

const NOW = Date.now()

function grant(overrides: Partial<SystemAccessGrant> = {}): SystemAccessGrant {
  return {
    id: 'grant-1',
    scopes: ['execution_records', 'system_strategy'],
    allWorkspaces: true,
    grantedAt: NOW - 60_000,
    expiresAt: NOW + 30 * 60_000,
    ...overrides,
  }
}

const evidence: ProfileEvidence = {
  runs: 12,
  failures: 3,
  avgSteps: 9.5,
  avgTokens: 15_000,
  positive: 4,
  negative: 1,
}

const policy: EvolutionPolicy = {
  autoApply: false,
  minRuns: 5,
  reviewScore: 80,
  cooldownRuns: 10,
  evidenceRuns: 20,
  watchRuns: 5,
  regressionDelta: 15,
  metaEvery: 8,
  focus: 'prefer narrower commands',
}

const evolution: EvolutionState = {
  policy,
  policyVersions: [],
  benchmarkSuiteVersion: 5,
  cycles: [
    {
      id: 'cycle-1',
      workspacePath: '/ws-a',
      trigger: 'manual',
      status: 'completed',
      startedAt: '2026-01-09T00:00:00.000Z',
      finishedAt: '2026-01-09T00:01:00.000Z',
      stages: [],
      score: 88,
      activated: true,
      summary: 'raised maxSteps and narrowed reads',
    },
  ],
}

const settings: SettingsView = {
  baseUrl: 'https://api.example.test/v1',
  model: 'deepseek-chat',
  maxSteps: 36,
  maxTokens: 0,
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
  temperature: 0.2,
  autoReflect: true,
  autoEvolve: false,
  autoContinue: true,
  autoContinueLimit: 2,
  screenshotFeedback: false,
  testTargets: [],
  testCaptchaMode: 'off',
  hasTestCaptcha: false,
  approvalTimeoutSec: 300,
  shellMode: true,
  shellInterpreter: 'auto',
  shellInterpreterDetail: 'Git Bash',
  defaultApprovalMode: 'auto',
  permissionRules: { allow: ['git status'], ask: [], deny: ['rm -rf /'] },
  trustedCommands: ['git status'],
  classifierModel: '',
  reviewModel: '',
  sandboxMode: 'off',
  sandboxNetwork: false,
  sandboxAutoAllow: false,
  allowUnattendedBuild: false,
  fullAutonomy: false,
  learningMode: false,
  learningHosts: [],
  learningShellIsolation: false,
  selfSourceMode: 'builtin',
  selfSourceGitUrl: '',
  selfSourceGitRef: 'main',
  selfSourceGitPath: '',
  selfSourceCustomPath: '',
  qualityGate: false,
  qualityPublishTarget: 'none',
  qualityTuneEvery: 5,
  checkpointRetention: 20,
  checkpointMaxBytes: 250 * 1024 * 1024,
  checkpointShell: true,
  checkpointIgnore: [],
  notifyDesktop: true,
  notifyEmailEnabled: false,
  notifyEmailEvents: ['reflect.report'],
  hooksEnabled: false,
  mcpEnabled: false,
  relayUrl: '',
  globalInstructionsPath: '/home/user/PILOT.md',
  theme: 'dark',
  fontSize: 'standard',
  locale: 'zh-CN',
  systemLocale: 'zh-CN',
  hasKey: true,
  keyHint: 'sk-…abcd',
  reflectEnabled: false,
  reflectModelId: '',
  reflectTriggers: { onError: true, onSchedule: true },
  reflectScheduleMode: 'daily',
  reflectIntervalMinutes: 1_440,
  reflectDailyTime: '09:00',
  reflectTopics: [
    'compaction-drift',
    'storage-performance',
    'page-design',
    'project-structure',
    'code-quality',
    'execution-efficiency',
    'output-quality',
    'interaction-experience',
  ],
  reflectLastRunAt: '',
  reflectLastVersion: '',
  reflectEmailEnabled: false,
  reflectEmailTo: '',
  reflectSmtpHost: '',
  reflectSmtpPort: 587,
  reflectSmtpSecurity: 'starttls',
  hasSmtpPassword: false,
  modelResources: [
    {
      id: 'primary',
      label: '默认模型',
      baseUrl: 'https://api.example.test/v1',
      model: 'deepseek-chat',
      tag: '',
      enabled: true,
      hasKey: true,
      keyHint: 'sk-…abcd',
    },
  ],
  sessionModelId: 'primary',
  evaluationModelIds: [],
  reviewModelId: '',
  judgeProviders: [],
  serverMode: false,
  serverPort: 4317,
}

const workspace = (path: string): WorkspaceSummary => ({
  path,
  name: path.slice(1),
  addedAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-09T00:00:00.000Z',
  sessionCount: 1,
  hasMemory: false,
})

const workspaceProfile: ProfileVersion = {
  id: 'profile-1',
  version: 3,
  status: 'active',
  promptAddendum: 'Prefer focused checks. Never print token sk-abcdefghijklmnop.',
  strategy: { maxSteps: 32, temperature: 0.1 },
  rationale: 'Runs were slower than needed',
  source: 'self',
  evidence,
  createdAt: '2026-01-01T00:00:00.000Z',
  activatedAt: '2026-01-02T00:00:00.000Z',
}

const globalProfile: ProfileVersion = {
  ...workspaceProfile,
  id: 'profile-global-1',
  version: 2,
  scope: 'global',
  promptAddendum: 'Keep commands narrow.',
}

const run = (overrides: Partial<RunRecord> & Pick<RunRecord, 'id' | 'startedAt'>): RunRecord => ({
  sessionId: 'session-1',
  prompt: 'do the task',
  status: 'completed',
  steps: 5,
  promptTokens: 500,
  completionTokens: 100,
  totalTokens: 600,
  toolCalls: 3,
  toolErrors: 0,
  ...overrides,
})

const runsA: RunRecord[] = [
  run({
    id: 'run-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    status: 'completed',
    steps: 10,
    promptTokens: 800,
    completionTokens: 200,
    totalTokens: 1_000,
    cacheHitTokens: 400,
    toolCalls: 5,
    toolErrors: 1,
    modelMs: 30_000,
    toolMs: 5_000,
    checkpointMs: 1_000,
    approvalMs: 2_000,
    summarizeMs: 500,
    feedback: { rating: 'up', at: '2026-01-01T00:02:00.000Z' },
    prompt: 'fix the auth bug with sk-abcdefghijklmnop',
    error: undefined,
  }),
  run({
    id: 'run-2',
    startedAt: '2026-01-02T00:00:00.000Z',
    finishedAt: '2026-01-02T00:00:30.000Z',
    status: 'failed',
    steps: 4,
    promptTokens: 500,
    completionTokens: 100,
    totalTokens: 600,
    cacheHitTokens: 0,
    toolCalls: 2,
    toolErrors: 2,
    prompt: 'retry the failing build',
    error: 'auth failed with ghp_abcdefghijklmnop',
  }),
]

const runsB: RunRecord[] = [
  run({
    id: 'run-3',
    startedAt: '2026-01-03T00:00:00.000Z',
    finishedAt: '2026-01-03T00:02:00.000Z',
    status: 'max_steps',
    steps: 20,
    promptTokens: 2_000,
    completionTokens: 500,
    totalTokens: 2_500,
    toolCalls: 15,
    toolErrors: 3,
    prompt: 'migrate every module',
  }),
]

function makeStore(): SystemAccessStore & { runsByPath: Record<string, RunRecord[]> } {
  const runsByPath: Record<string, RunRecord[]> = { '/ws-a': runsA, '/ws-b': runsB }
  const memory: MemoryEntry[] = [
    { id: 'm1', content: 'build with pnpm', source: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
  ]
  return {
    runsByPath,
    workspaces: () => [workspace('/ws-a'), workspace('/ws-b')],
    runs: (path) => runsByPath[path] ?? [],
    run: (path, runId) => (runsByPath[path] ?? []).find((entry) => entry.id === runId),
    evidence: () => evidence,
    activeProfile: (path) => (path === '/ws-a' ? workspaceProfile : null),
    workspaceDetail: () => ({ profiles: [workspaceProfile] }),
    activeGlobalProfile: () => globalProfile,
    globalProfiles: () => [globalProfile],
    evolutionState: () => evolution,
    memory: () => memory,
  }
}

describe('parseAccessRequest', () => {
  it('normalizes scopes, workspace choice, purpose and lifetime', () => {
    expect(
      parseAccessRequest({
        scopes: ['execution_records', 'system_strategy', 'execution_records', 'unknown'],
        workspaces: 'all',
        purpose: '  speed up slow runs  ',
        minutes: 999,
      }),
    ).toEqual({
      scopes: ['execution_records', 'system_strategy'],
      allWorkspaces: true,
      purpose: 'speed up slow runs',
      minutes: 120,
    })
  })

  it('defaults to 30 minutes on the current workspace and clamps short lifetimes', () => {
    expect(
      parseAccessRequest({ scopes: ['execution_records'], purpose: 'inspect failures' }),
    ).toMatchObject({ allWorkspaces: false, minutes: 30 })
    expect(
      parseAccessRequest({ scopes: ['execution_records'], purpose: 'inspect', minutes: 1 }).minutes,
    ).toBe(5)
  })

  it('requires valid scopes, a purpose and a known workspace choice', () => {
    expect(() => parseAccessRequest({ purpose: 'x' })).toThrow(/scopes/)
    expect(() => parseAccessRequest({ scopes: ['bogus'], purpose: 'x' })).toThrow(/scopes/)
    expect(() => parseAccessRequest({ scopes: ['execution_records'] })).toThrow(/purpose/)
    expect(() =>
      parseAccessRequest({ scopes: ['execution_records'], purpose: 'x', workspaces: 'everywhere' }),
    ).toThrow(/workspaces/)
  })
})

describe('grant coverage', () => {
  it('requires an unexpired grant with every requested scope', () => {
    expect(grantCovers(undefined, ['execution_records'], false, NOW)).toBe(false)
    expect(
      grantCovers(grant({ expiresAt: NOW - 1 }), ['execution_records'], false, NOW),
    ).toBe(false)
    expect(
      grantCovers(grant({ scopes: ['system_strategy'] }), ['execution_records'], false, NOW),
    ).toBe(false)
    expect(grantCovers(grant(), ['execution_records', 'system_strategy'], true, NOW)).toBe(true)
  })

  it('does not widen a current-workspace grant to every workspace', () => {
    expect(grantCovers(grant({ allWorkspaces: false }), ['execution_records'], true, NOW)).toBe(false)
    expect(grantCovers(grant({ allWorkspaces: false }), ['execution_records'], false, NOW)).toBe(true)
  })
})

describe('systemAccessPolicy', () => {
  it('always asks a human in auto mode when no grant exists', () => {
    expect(
      systemAccessPolicy('auto', undefined, {
        scopes: ['execution_records'],
        purpose: 'inspect',
      })?.decision,
    ).toBe('ask')
  })

  it('reuses a covering grant instead of prompting again', () => {
    const decision = systemAccessPolicy('auto', grant(), {
      scopes: ['execution_records'],
      purpose: 'inspect',
    })
    expect(decision?.decision).toBe('auto')
  })

  it('prompts in manual and acceptEdits modes', () => {
    for (const mode of ['manual', 'acceptEdits', 'ask'] as const) {
      expect(
        systemAccessPolicy(mode, undefined, { scopes: ['execution_records'], purpose: 'x' })
          ?.decision,
      ).toBe('ask')
    }
  })

  it('denies when the mode cannot ask the user', () => {
    for (const mode of ['plan', 'dontAsk'] as const) {
      expect(
        systemAccessPolicy(mode, undefined, { scopes: ['execution_records'], purpose: 'x' })
          ?.decision,
      ).toBe('deny')
    }
  })
})

describe('tool registration', () => {
  it('marks the request as a control action that always asks, and reads as reads', () => {
    const request = systemAccessTools.find((tool) => tool.name === REQUEST_SYSTEM_ACCESS)
    expect(request?.risk).toBe('control')
    expect(request?.alwaysAsk).toBe(true)
    expect(request?.inputSchema.required).toEqual(['scopes', 'purpose'])
    expect(systemAccessTools.find((tool) => tool.name === READ_EXECUTION_RECORDS)?.risk).toBe('read')
    expect(systemAccessTools.find((tool) => tool.name === READ_SYSTEM_STRATEGY)?.risk).toBe('read')
  })
})

describe('buildExecutionRecordsReport', () => {
  it('summarizes outcomes, averages, phases and cache for the current workspace', () => {
    const report = buildExecutionRecordsReport(makeStore(), {
      workspacePath: '/ws-a',
      grant: grant({ allWorkspaces: false }),
      args: {},
    })
    expect(report).toContain('observed 2 run(s)')
    expect(report).toContain('completed 1, failed 1')
    expect(report).toContain('Averages: 7.0 steps')
    expect(report).toContain('cache hits')
    expect(report).toContain('31%')
    expect(report).toContain('Phase averages: model 30.0s')
    expect(report).toContain('Slowest finished runs:')
    expect(report).toContain('run-2')
    expect(report).not.toContain('run-3')
  })

  it('redacts credential-shaped strings from prompts and errors', () => {
    const report = buildExecutionRecordsReport(makeStore(), {
      workspacePath: '/ws-a',
      grant: grant({ allWorkspaces: false }),
      args: {},
    })
    expect(report).toContain('<redacted>')
    expect(report).not.toContain('sk-abcdefghijklmnop')
    expect(report).not.toContain('ghp_abcdefghijklmnop')
  })

  it('refuses all workspaces unless the grant covers them', () => {
    expect(() =>
      buildExecutionRecordsReport(makeStore(), {
        workspacePath: '/ws-a',
        grant: grant({ allWorkspaces: false }),
        args: { workspace: 'all' },
      }),
    ).toThrow(/workspaces=all/)
  })

  it('aggregates every granted workspace when the grant allows it', () => {
    const report = buildExecutionRecordsReport(makeStore(), {
      workspacePath: '/ws-a',
      grant: grant(),
      args: { workspace: 'all' },
    })
    expect(report).toContain('all 2 workspaces')
    expect(report).toContain('run-3')
    expect(report).toContain('max_steps 1')
  })

  it('returns one full record by id with feedback and redacted text', () => {
    const report = buildExecutionRecordsReport(makeStore(), {
      workspacePath: '/ws-a',
      grant: grant({ allWorkspaces: false }),
      args: { runId: 'run-1' },
    })
    expect(report).toContain('Run run-1')
    expect(report).toContain('Status: completed')
    expect(report).toContain('Feedback: up')
    expect(report).toContain('<redacted>')
    expect(report).not.toContain('sk-abcdefghijklmnop')
  })

  it('honors the sample limit and says how many matched', () => {
    const report = buildExecutionRecordsReport(makeStore(), {
      workspacePath: '/ws-a',
      grant: grant({ allWorkspaces: false }),
      args: { limit: 1 },
    })
    expect(report).toContain('observed 1 of 2 run(s)')
    expect(report).toContain('newest 1 of 2 matching run(s)')
    // Newest first: run-2, not run-1.
    expect(report).not.toContain('run-1')
  })

  it('reports an empty sample instead of an empty string', () => {
    const store = { ...makeStore(), runs: () => [] }
    expect(
      buildExecutionRecordsReport(store, {
        workspacePath: '/ws-a',
        grant: grant({ allWorkspaces: false }),
        args: { status: 'failed' },
      }),
    ).toContain('No runs matched the filters')
  })
})

describe('buildSystemStrategyReport', () => {
  it('returns only the requested sections', () => {
    const report = buildSystemStrategyReport(makeStore(), {
      workspacePath: '/ws-a',
      settings,
      skills: [{ name: 'release', description: 'Ship a build', whenToUse: 'release' }],
      dynamicTools: [
        { name: 'probe', description: 'probe a port', enabled: true, approved: true, risk: 'read' },
      ],
      globalInstructions: [{ name: 'PILOT.md' }],
      projectInstructions: [{ name: 'AGENTS.md' }],
      args: { sections: ['model', 'approval', 'skills'] },
    })
    expect(report).toContain('[Model]')
    expect(report).toContain('keyConfigured=yes')
    expect(report).toContain('[Approval and sandbox]')
    expect(report).toContain('[Skills] 1')
    expect(report).not.toContain('[Checkpoints]')
    expect(report).not.toContain('[Profiles]')
    expect(report).not.toContain('[Evolution]')
  })

  it('describes the effective profiles, evolution policy and containers', () => {
    const report = buildSystemStrategyReport(makeStore(), {
      workspacePath: '/ws-a',
      settings,
      skills: [],
      dynamicTools: [],
      globalInstructions: [],
      projectInstructions: [],
      args: {},
    })
    expect(report).toContain('[Profiles]')
    expect(report).toContain('workspace: v3 [active]')
    expect(report).toContain('global: v2 [active]')
    expect(report).toContain('[Evolution]')
    expect(report).toContain('policy: autoApply=false; minRuns=5')
    expect(report).toContain('raised maxSteps and narrowed reads')
    expect(report).toContain('propose_self_update (scope=workspace or global)')
  })

  it('reports per-version measurements so a draft can be compared with the live version', () => {
    const store = makeStore()
    store.runsByPath['/ws-a'] = [
      run({ id: 'a1', startedAt: '2026-01-01T00:00:00.000Z', profileVersion: 3, status: 'completed', steps: 20, checked: true }),
      run({ id: 'a2', startedAt: '2026-01-01T00:05:00.000Z', profileVersion: 3, status: 'max_steps', steps: 80 }),
    ]
    const report = buildSystemStrategyReport(store, {
      workspacePath: '/ws-a',
      settings,
      skills: [],
      dynamicTools: [],
      globalInstructions: [],
      projectInstructions: [],
      args: { sections: ['profiles'] },
    })
    expect(report).toContain('[Profile measurements]')
    expect(report).toContain('v3: finished=2; completed=50%; hitStepCap=50%')
    expect(report).toContain('avgSteps=50.0')
    expect(report).toContain('verifiedBeforeFinish=100%')
  })

  it('strips userinfo, query and fragment from the endpoint', () => {
    const report = buildSystemStrategyReport(makeStore(), {
      workspacePath: '/ws-a',
      settings: {
        ...settings,
        baseUrl: 'https://user:sk-secretpass@api.example.test/v1?key=sk-abcdefghijklmnop#frag',
      },
      skills: [],
      dynamicTools: [],
      globalInstructions: [],
      projectInstructions: [],
      args: { sections: ['model'] },
    })
    expect(report).toContain('baseUrl=https://api.example.test/v1')
    expect(report).not.toContain('user:sk-secretpass')
    expect(report).not.toContain('sk-abcdefghijklmnop')
    expect(report).not.toContain('frag')
  })

  it('redacts credentials in profile rules and never returns a key', () => {
    const report = buildSystemStrategyReport(makeStore(), {
      workspacePath: '/ws-a',
      settings,
      skills: [],
      dynamicTools: [],
      globalInstructions: [],
      projectInstructions: [],
      args: { sections: ['profiles'] },
    })
    expect(report).toContain('<redacted>')
    expect(report).not.toContain('sk-abcdefghijklmnop')
    expect(report).not.toContain('sk-…abcd')
  })
})
