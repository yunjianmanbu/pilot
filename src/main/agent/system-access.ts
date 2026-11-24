import type {
  AgentToolDefinition,
  ApprovalMode,
  EvolutionState,
  MemoryEntry,
  ProfileEvidence,
  ProfileVersion,
  RunRecord,
  SettingsView,
  WorkspaceSummary,
} from '../../shared/types'
import { compareVersions, summarizeComparison, versionMetrics } from '../../shared/version-stats'
import { EPHEMERAL_DIR_NAMES } from '../../shared/checkpoint-ignore'
import { redactSecrets } from './redact'

export const REQUEST_SYSTEM_ACCESS = 'request_system_access'
export const READ_EXECUTION_RECORDS = 'read_execution_records'
export const READ_SYSTEM_STRATEGY = 'read_system_strategy'

export type SystemAccessScope = 'execution_records' | 'system_strategy'

const SCOPES: SystemAccessScope[] = ['execution_records', 'system_strategy']
const MAX_PURPOSE_CHARS = 300
const MAX_SOURCE_CHARS = 1_200
const MAX_RUNS_SCANNED = 300
const DEFAULT_GRANT_MINUTES = 30
const MAX_GRANT_MINUTES = 120

export interface SystemAccessGrant {
  id: string
  scopes: SystemAccessScope[]
  allWorkspaces: boolean
  grantedAt: number
  expiresAt: number
}

export const systemAccessTools: AgentToolDefinition[] = [
  {
    name: REQUEST_SYSTEM_ACCESS,
    description:
      'Ask the user for permission to read Pilot\'s own execution records (runs: status, steps, tokens, tool errors, phase timings, failures, feedback) and/or its execution strategy (model limits, approval policy, checkpoints, active profiles, evolution policy and cycles, skills, registered tools, memory). Call this only when the task is to diagnose or optimize Pilot itself and the user asked for that. The user sees an approval card with the purpose and scope; approval is bound to this run, expires, and grants read access only. Reads are refused without a grant. Never claim access before the user approves.',
    inputSchema: {
      type: 'object',
      properties: {
        scopes: {
          type: 'array',
          items: { type: 'string', enum: SCOPES },
          description: 'Which data to read: execution_records, system_strategy, or both.',
        },
        workspaces: {
          type: 'string',
          enum: ['current', 'all'],
          description:
            'current (default) limits execution records to this workspace; all covers every workspace known to Pilot. The approval card shows the choice.',
        },
        purpose: {
          type: 'string',
          description:
            'One sentence shown to the user: what you will inspect and what optimization it feeds (max 300 chars).',
        },
        minutes: {
          type: 'number',
          description: 'Grant lifetime in minutes, 5-120 (default 30). The grant also ends when the run ends.',
        },
      },
      required: ['scopes', 'purpose'],
      additionalProperties: false,
    },
    risk: 'control',
    source: 'control',
    alwaysAsk: true,
  },
  {
    name: READ_EXECUTION_RECORDS,
    description:
      'Read Pilot\'s stored run records. Requires a grant from request_system_access with the execution_records scope. Returns aggregate outcome/timing statistics and recent failure or slow-run samples (including prompt excerpts and errors); transcripts are not returned. Optionally read one run by id. Secrets are redacted.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          enum: ['current', 'all'],
          description: 'Current workspace (default) or all workspaces if the grant allows it.',
        },
        runId: { type: 'string', description: 'Read one run by id instead of the aggregate view.' },
        sessionId: { type: 'string', description: 'Only runs from this session.' },
        status: {
          type: 'string',
          description: 'Only this status: completed, failed, interrupted, max_steps, paused, running.',
        },
        since: { type: 'string', description: 'ISO timestamp; ignore runs started before it.' },
        limit: { type: 'number', description: 'Sample size, 1-50 (default 20).' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
  {
    name: READ_SYSTEM_STRATEGY,
    description:
      'Read Pilot\'s effective execution strategy: model limits, run limits, approval and sandbox policy, checkpoint settings, active workspace/global profiles, evolution policy and recent cycles, skills, registered dynamic tools, instruction files and recent project memory. Requires a grant from request_system_access with the system_strategy scope. No credentials are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'model',
              'limits',
              'approval',
              'checkpoints',
              'profiles',
              'evolution',
              'skills',
              'tools',
              'memory',
              'instructions',
            ],
          },
          description: 'Sections to return; default all.',
        },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
]

export const SYSTEM_ACCESS_TOOL_NAMES = new Set([
  REQUEST_SYSTEM_ACCESS,
  READ_EXECUTION_RECORDS,
  READ_SYSTEM_STRATEGY,
])

export function isSystemAccessTool(name: string): boolean {
  return SYSTEM_ACCESS_TOOL_NAMES.has(name)
}

export function parseAccessRequest(args: Record<string, unknown>): {
  scopes: SystemAccessScope[]
  allWorkspaces: boolean
  purpose: string
  minutes: number
} {
  const raw = Array.isArray(args['scopes']) ? args['scopes'] : []
  const scopes = [...new Set(raw.filter((entry): entry is SystemAccessScope =>
    typeof entry === 'string' && (SCOPES as string[]).includes(entry),
  ))]
  if (scopes.length === 0) {
    throw new Error(`scopes is required (${SCOPES.join(', ')})`)
  }
  const workspaces = typeof args['workspaces'] === 'string' ? args['workspaces'] : 'current'
  if (workspaces !== 'current' && workspaces !== 'all') {
    throw new Error('workspaces must be current or all')
  }
  const purpose = typeof args['purpose'] === 'string' ? args['purpose'].trim() : ''
  if (!purpose) throw new Error('purpose is required so the user knows what is being read')
  const requestedMinutes =
    typeof args['minutes'] === 'number' && Number.isFinite(args['minutes'])
      ? Math.round(args['minutes'])
      : DEFAULT_GRANT_MINUTES
  return {
    scopes,
    allWorkspaces: workspaces === 'all',
    purpose: purpose.slice(0, MAX_PURPOSE_CHARS),
    minutes: Math.min(MAX_GRANT_MINUTES, Math.max(5, requestedMinutes)),
  }
}

export function grantIsValid(grant: SystemAccessGrant | undefined, nowMs = Date.now()): boolean {
  return Boolean(grant && grant.expiresAt > nowMs)
}

export function grantCovers(
  grant: SystemAccessGrant | undefined,
  scopes: SystemAccessScope[],
  allWorkspaces: boolean,
  nowMs = Date.now(),
): boolean {
  if (!grantIsValid(grant, nowMs)) return false
  if (allWorkspaces && !grant!.allWorkspaces) return false
  return scopes.every((scope) => grant!.scopes.includes(scope))
}

/**
 * Approval policy for the introspection tools. Requesting access always needs
 * a human (except when an unexpired grant already covers the request). The
 * read tools themselves are ordinary reads; their execution checks the grant.
 */
export function systemAccessPolicy(
  mode: ApprovalMode,
  grant: SystemAccessGrant | undefined,
  args: Record<string, unknown>,
  fullAutonomy = false,
): { decision: 'auto' | 'ask' | 'deny'; reason: string } | null {
  if (mode !== 'plan' && mode !== 'dontAsk') {
    let request: ReturnType<typeof parseAccessRequest> | null = null
    try {
      request = parseAccessRequest(args)
    } catch {
      request = null
    }
    if (request && grantCovers(grant, request.scopes, request.allWorkspaces)) {
      return {
        decision: 'auto',
        reason: '本次运行已获得对应的系统信息授权。',
      }
    }
    // 完全自主档：授权仍会自动过期、仍然只读，只是不再弹卡片。
    if (fullAutonomy) {
      return {
        decision: 'auto',
        reason: '完全自主档：系统信息授权默认授予本次运行，只读且随运行结束失效。',
      }
    }
    return {
      decision: 'ask',
      reason:
        '这是读取 Pilot 自身运行记录与执行策略的系统级授权，需要你确认；授权只读、绑定本次运行并会自动过期。',
    }
  }
  return {
    decision: 'deny',
    reason:
      mode === 'plan'
        ? '计划模式只读工作区，不能申请系统级信息授权；请切到普通会话后再申请。'
        : '当前审批模式不会询问用户，无法获得系统级信息授权。',
  }
}

export interface SystemAccessStore {
  workspaces(): WorkspaceSummary[]
  runs(workspacePath: string): RunRecord[]
  run(workspacePath: string, runId: string): RunRecord | undefined
  evidence(workspacePath: string): ProfileEvidence
  activeProfile(workspacePath: string): ProfileVersion | null
  workspaceDetail(workspacePath: string): { profiles: ProfileVersion[] }
  activeGlobalProfile(): ProfileVersion | null
  globalProfiles(): ProfileVersion[]
  evolutionState(workspacePath: string): EvolutionState
  memory(workspacePath: string): MemoryEntry[]
}

function clip(value: unknown, limit = MAX_SOURCE_CHARS): string {
  const text = typeof value === 'string' ? value : ''
  return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Endpoint shown without userinfo, query or fragment, so keys in a URL never leak. */
function safeUrl(value: string, limit = 200): string {
  try {
    const url = new URL(redactSecrets(value))
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().slice(0, limit)
  } catch {
    return clip(value, limit)
  }
}

function pct(value: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.round((value / total) * 100)}%`
}

function durationMs(run: RunRecord): number | null {
  if (!run.finishedAt) return null
  const start = Date.parse(run.startedAt)
  const end = Date.parse(run.finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return end - start
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function allowedWorkspaces(
  store: SystemAccessStore,
  workspacePath: string,
  allWorkspaces: boolean,
): string[] {
  const paths = allWorkspaces ? store.workspaces().map((workspace) => workspace.path) : [workspacePath]
  return [...new Set(paths)]
}

function collectRuns(
  store: SystemAccessStore,
  paths: string[],
  args: Record<string, unknown>,
): RunRecord[] {
  const status = typeof args['status'] === 'string' ? args['status'].trim() : ''
  const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'].trim() : ''
  const since = typeof args['since'] === 'string' ? Date.parse(args['since']) : Number.NaN
  const runs = paths
    .flatMap((path) => store.runs(path))
    .filter((run) => {
      if (status && run.status !== status) return false
      if (sessionId && run.sessionId !== sessionId) return false
      if (Number.isFinite(since) && Date.parse(run.startedAt) < since) return false
      return true
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, MAX_RUNS_SCANNED)
  return runs
}

function formatRunDetail(run: RunRecord, workspacePath?: string): string {
  const wall = durationMs(run)
  return [
    `Run ${run.id}`,
    `Status: ${run.status}; session: ${run.sessionId}${workspacePath ? `; workspace: ${workspacePath}` : ''}`,
    `Started: ${run.startedAt}; finished: ${run.finishedAt ?? '(not finished)'}; wall: ${
      wall === null ? 'n/a' : seconds(wall)
    }`,
    `Steps: ${run.steps}; tool calls: ${run.toolCalls}; tool errors: ${run.toolErrors}; changed files: ${run.filesChanged ?? 0}; verified: ${run.checked === true ? 'yes' : 'no'}`,
    `Tokens: ${run.totalTokens} (prompt ${run.promptTokens}, completion ${run.completionTokens}${
      run.cacheHitTokens !== undefined ? `, cache hit ${pct(run.cacheHitTokens, run.promptTokens)}` : ''
    })`,
    run.modelMs !== undefined
      ? `Phase timings: model ${seconds(run.modelMs)}; tools ${seconds(run.toolMs ?? 0)}; checkpoints ${seconds(run.checkpointMs ?? 0)}; approvals ${seconds(run.approvalMs ?? 0)}; summaries ${seconds(run.summarizeMs ?? 0)}`
      : 'Phase timings: (not recorded for this run)',
    run.profileVersion !== undefined ? `Workspace profile: v${run.profileVersion}` : '',
    run.globalProfileVersion !== undefined ? `Global profile: v${run.globalProfileVersion}` : '',
    run.delegations
      ? `Delegations: ${run.delegations} (${run.delegatedSteps ?? 0} steps, ${run.delegatedSummaryChars ?? 0} summary chars)`
      : '',
    run.feedback
      ? `Feedback: ${run.feedback.rating}${run.feedback.note ? ` — ${clip(run.feedback.note, 400)}` : ''}`
      : 'Feedback: (none)',
    `Prompt: ${clip(run.prompt, 800)}`,
    run.error ? `Error: ${clip(run.error, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Aggregate run records plus a small failure/slow-run sample. */
export function buildExecutionRecordsReport(
  store: SystemAccessStore,
  input: {
    workspacePath: string
    grant: SystemAccessGrant
    args: Record<string, unknown>
  },
): string {
  const requestedAll = input.args['workspace'] === 'all'
  if (requestedAll && !input.grant.allWorkspaces) {
    throw new Error('授权只覆盖当前工作区；重新申请时选择 workspaces=all')
  }
  const paths = allowedWorkspaces(store, input.workspacePath, requestedAll)

  const runId = typeof input.args['runId'] === 'string' ? input.args['runId'].trim() : ''
  if (runId) {
    for (const path of paths) {
      const run = store.run(path, runId)
      if (run) return formatRunDetail(run, path)
    }
    throw new Error(`Run not found in the granted scope: ${runId}`)
  }

  const matched = collectRuns(store, paths, input.args)
  const limit = Math.min(50, Math.max(1, Math.round(Number(input.args['limit']) || 20)))
  const runs = matched.slice(0, limit)
  if (runs.length === 0) {
    return `Execution records · ${paths.length === 1 ? paths[0] : `${paths.length} workspaces`}\nNo runs matched the filters.`
  }

  const count = (status: string) => runs.filter((run) => run.status === status).length
  const sums = (pick: (run: RunRecord) => number) =>
    runs.reduce((total, run) => total + (Number.isFinite(pick(run)) ? pick(run) : 0), 0)
  const withTiming = runs.filter((run) => run.modelMs !== undefined)
  const feedbackUp = runs.filter((run) => run.feedback?.rating === 'up').length
  const feedbackDown = runs.filter((run) => run.feedback?.rating === 'down').length
  const wallTimes = runs.map(durationMs).filter((value): value is number => value !== null)
  const walls = runs
    .map((run) => ({ run, wall: durationMs(run) }))
    .filter((entry): entry is { run: RunRecord; wall: number } => entry.wall !== null)
    .sort((left, right) => right.wall - left.wall)
    .slice(0, 5)
  const failures = runs
    .filter((run) => run.status === 'failed' || run.status === 'interrupted' || run.status === 'max_steps')
    .slice(0, 8)
  const evidence = paths
    .map((path) => store.evidence(path))
    .reduce(
      (total, entry) => ({
        runs: total.runs + entry.runs,
        failures: total.failures + entry.failures,
        positive: total.positive + entry.positive,
        negative: total.negative + entry.negative,
      }),
      { runs: 0, failures: 0, positive: 0, negative: 0 },
    )

  const lines = [
    `Pilot execution records · ${paths.length === 1 ? paths[0] : `all ${paths.length} workspaces`} · observed ${runs.length}${matched.length > runs.length ? ` of ${matched.length}` : ''} run(s)`,
    `Outcomes: completed ${count('completed')}, failed ${count('failed')}, interrupted ${count('interrupted')}, max_steps ${count('max_steps')}, paused ${count('paused')}, running ${count('running')}`,
    `Averages: ${(sums((run) => run.steps) / runs.length).toFixed(1)} steps · ${Math.round(sums((run) => run.totalTokens) / runs.length)} tokens · ${(sums((run) => run.toolCalls) / runs.length).toFixed(1)} tool calls · ${(sums((run) => run.toolErrors) / runs.length).toFixed(2)} tool errors`,
    `Wall time: ${wallTimes.length ? seconds(wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length) : 'n/a'} average over ${wallTimes.length} finished run(s)`,
    withTiming.length > 0
      ? `Phase averages: model ${seconds(sums((run) => run.modelMs ?? 0) / withTiming.length)} · tools ${seconds(sums((run) => run.toolMs ?? 0) / withTiming.length)} · checkpoints ${seconds(sums((run) => run.checkpointMs ?? 0) / withTiming.length)} · approvals ${seconds(sums((run) => run.approvalMs ?? 0) / withTiming.length)} · summaries ${seconds(sums((run) => run.summarizeMs ?? 0) / withTiming.length)} (${withTiming.length} run(s))`
      : 'Phase averages: not recorded in this sample',
    `Cache: ${pct(sums((run) => run.cacheHitTokens ?? 0), sums((run) => run.promptTokens))} of prompt tokens were cache hits`,
    `Feedback: ${feedbackUp} up / ${feedbackDown} down · evidence window: ${evidence.runs} runs, ${evidence.failures} failures`,
    '',
    'Slowest finished runs:',
    ...(walls.length > 0
      ? walls.map(
          (entry) =>
            `- ${entry.run.id} | ${entry.run.status} | ${seconds(entry.wall)} | ${entry.run.steps} steps | ${entry.run.totalTokens} tokens | ${clip(entry.run.prompt, 160)}`,
        )
      : ['(none finished)']),
    '',
    'Recent failures:',
    ...(failures.length > 0
      ? failures.map(
          (run) =>
            `- ${run.id} | ${run.status} | ${run.startedAt} | steps=${run.steps} tools=${run.toolCalls} errors=${run.toolErrors} | ${clip(run.prompt, 160)}${run.error ? ` | error=${clip(run.error, 240)}` : ''}`,
        )
      : ['(none in this sample)']),
    '',
    `Sample: newest ${runs.length} of ${matched.length} matching run(s); limit=${limit}. Use runId for a full record, or status/sessionId/since to narrow.`,
  ]
  return lines.join('\n')
}

export interface StrategyContext {
  workspacePath: string
  settings: SettingsView
  skills: Array<{ name: string; description: string; whenToUse?: string }>
  dynamicTools: Array<{
    name: string
    description: string
    enabled: boolean
    approved: boolean
    risk: string
  }>
  globalInstructions: Array<{ name: string }>
  projectInstructions: Array<{ name: string }>
}

const ALL_SECTIONS = [
  'model',
  'limits',
  'approval',
  'checkpoints',
  'profiles',
  'evolution',
  'skills',
  'tools',
  'memory',
  'instructions',
]

function profileLine(profile: ProfileVersion | null, label: string): string {
  if (!profile) return `${label}: (none active)`
  return [
    `${label}: v${profile.version} [${profile.status}] source=${profile.source}`,
    `  strategy: maxSteps=${profile.strategy.maxSteps ?? 'default'}, temperature=${profile.strategy.temperature ?? 'default'}`,
    `  evidence: ${profile.evidence.runs} runs, ${profile.evidence.failures} failures, ${profile.evidence.positive} up / ${profile.evidence.negative} down`,
    `  rules: ${clip(profile.promptAddendum, 1_200)}`,
  ].join('\n')
}

/** Effective strategy configuration, sized for one tool result. */
export function buildSystemStrategyReport(
  store: SystemAccessStore,
  input: StrategyContext & { args: Record<string, unknown> },
): string {
  const requested = Array.isArray(input.args['sections'])
    ? input.args['sections'].filter((entry): entry is string => typeof entry === 'string')
    : []
  const sections = new Set(requested.length > 0 ? requested : ALL_SECTIONS)
  const settings = input.settings
  const evolution = store.evolutionState(input.workspacePath)
  const memory = store.memory(input.workspacePath)
  const workspaceProfiles = store.workspaceDetail(input.workspacePath).profiles
  const globalProfiles = store.globalProfiles()
  const lines: string[] = [
    `Pilot execution strategy · ${input.workspacePath}`,
    'Data: read-only, bound to this run, credentials redacted.',
  ]

  if (sections.has('model')) {
    lines.push(
      '',
      '[Model]',
      `model=${clip(settings.model, 120)}; baseUrl=${safeUrl(settings.baseUrl)}`,
      `classifierModel=${clip(settings.classifierModel || '(same as model)', 120)}; reviewModel=${clip(settings.reviewModel || '(same as model)', 120)}`,
      `maxOutputTokens=${settings.maxOutputTokens}; temperature=${settings.temperature}`,
      `keyConfigured=${settings.hasKey ? 'yes' : 'no'}`,
    )
  }
  if (sections.has('limits')) {
    lines.push(
      '',
      '[Run limits]',
      `maxSteps=${settings.maxSteps}; maxContextTokens=${settings.maxContextTokens}; maxOutputTokens=${settings.maxOutputTokens}`,
      `autoReflect=${settings.autoReflect}; autoEvolve=${settings.autoEvolve}; autoContinue=${settings.autoContinue}(${settings.autoContinueLimit}); screenshotFeedback=${settings.screenshotFeedback}`,
      `shellMode=${settings.shellMode}; shellInterpreter=${settings.shellInterpreter}; hooksEnabled=${settings.hooksEnabled}; mcpEnabled=${settings.mcpEnabled}`,
    )
  }
  if (sections.has('approval')) {
    lines.push(
      '',
      '[Approval and sandbox]',
      `defaultMode=${settings.defaultApprovalMode}; timeout=${settings.approvalTimeoutSec}s; defaultApproval=${settings.defaultApprovalMode}`,
      `permissionRules: deny=${settings.permissionRules.deny.length}, ask=${settings.permissionRules.ask.length}, allow=${settings.permissionRules.allow.length}`,
      `trustedCommands=${settings.trustedCommands.length}; sandboxMode=${settings.sandboxMode}; sandboxNetwork=${settings.sandboxNetwork}; sandboxAutoAllow=${settings.sandboxAutoAllow}`,
      `allowUnattendedBuild=${settings.allowUnattendedBuild}`,
    )
  }
  if (sections.has('checkpoints')) {
    lines.push(
      '',
      '[Checkpoints]',
      `retention=${settings.checkpointRetention}; maxBytes=${settings.checkpointMaxBytes}; beforeShell=${settings.checkpointShell}`,
      `snapshotIgnore=${settings.checkpointIgnore.length > 0 ? settings.checkpointIgnore.join(',') : '(none)'} (snapshots only; the file tree still shows these paths)`,
      `alwaysIgnoredDirs=${EPHEMERAL_DIR_NAMES.join(',')} (scratch/generated names, never snapshotted)`,
    )
  }
  if (sections.has('profiles')) {
    lines.push('', '[Profiles]')
    const activeWorkspace =
      workspaceProfiles.find((profile) => profile.status === 'active') ?? null
    lines.push(profileLine(activeWorkspace, 'workspace'))
    const activeGlobal = store.activeGlobalProfile()
    lines.push(profileLine(activeGlobal, 'global'))
    const workspaceDrafts = workspaceProfiles.filter((profile) => profile.status === 'draft')
    const globalDrafts = globalProfiles.filter((profile) => profile.status === 'draft')
    const latestDraft = [...workspaceDrafts, ...globalDrafts].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0]
    lines.push(
      `drafts: ${workspaceDrafts.length} workspace, ${globalDrafts.length} global`,
      latestDraft
        ? `latest draft: v${latestDraft.version} ${clip(latestDraft.rationale, 300)}`
        : 'latest draft: (none)',
    )
    // Measured behaviour per version: the only evidence for "is the new one better".
    const runs = store.runs(input.workspacePath)
    const activeVersion = activeWorkspace?.version
    const measured = (activeVersion !== undefined ? [activeVersion] : []).concat(
      latestDraft && latestDraft.version !== activeVersion ? [latestDraft.version] : [],
    )
    lines.push('', '[Profile measurements] (from recorded runs, not from the change summary)')
    for (const version of measured) {
      const metrics = versionMetrics(runs, version)
      lines.push(
        `- v${version}: finished=${metrics.finished}; completed=${metrics.successRate === null ? 'n/a' : `${Math.round(metrics.successRate * 100)}%`}; hitStepCap=${metrics.maxStepRate === null ? 'n/a' : `${Math.round(metrics.maxStepRate * 100)}%`}; avgSteps=${metrics.avgSteps === null ? 'n/a' : metrics.avgSteps.toFixed(1)}; toolErrorsPerRun=${metrics.avgToolErrors === null ? 'n/a' : metrics.avgToolErrors.toFixed(1)}; verifiedBeforeFinish=${metrics.checkedRate === null ? 'n/a' : `${Math.round(metrics.checkedRate * 100)}%`}; ratings=${metrics.ratingUp}/${metrics.ratingDown}`,
      )
    }
    if (activeVersion !== undefined && latestDraft && latestDraft.version !== activeVersion) {
      const comparison = compareVersions(runs, activeVersion, latestDraft.version)
      lines.push(
        comparison.verdict === 'untested'
          ? `comparison: v${latestDraft.version} has not run yet, so no difference is measurable`
          : comparison.verdict === 'too-few'
            ? `comparison: fewer than ${comparison.minRuns} finished runs on each side, differences are noise`
            : `comparison: ${summarizeComparison(comparison)}${comparison.findings.length > 0 ? ` · ${comparison.findings.join(' · ')}` : ' · no clear difference'}`,
      )
    }
  }
  if (sections.has('evolution')) {
    lines.push(
      '',
      '[Evolution]',
      `policy: autoApply=${evolution.policy.autoApply}; minRuns=${evolution.policy.minRuns}; reviewScore=${evolution.policy.reviewScore}; cooldownRuns=${evolution.policy.cooldownRuns}; evidenceRuns=${evolution.policy.evidenceRuns}; watchRuns=${evolution.policy.watchRuns}; regressionDelta=${evolution.policy.regressionDelta}; metaEvery=${evolution.policy.metaEvery}`,
      `policy focus: ${clip(evolution.policy.focus || '(none)', 600)}`,
      `policy versions: ${evolution.policyVersions.length}`,
      `recent cycles: ${evolution.cycles.length}`,
      ...evolution.cycles.slice(0, 5).map(
        (cycle) =>
          `- ${cycle.trigger}/${cycle.status} ${cycle.startedAt} score=${cycle.score ?? 'n/a'} activated=${cycle.activated} ${clip(cycle.summary, 240)}`,
      ),
    )
  }
  if (sections.has('skills')) {
    lines.push('', `[Skills] ${input.skills.length}`)
    lines.push(
      ...input.skills
        .slice(0, 20)
        .map(
          (skill) =>
            `- ${clip(skill.name, 80)}: ${clip(skill.description, 200)}${
              skill.whenToUse ? ` (when: ${clip(skill.whenToUse, 160)})` : ''
            }`,
        ),
    )
  }
  if (sections.has('tools')) {
    lines.push('', `[Dynamic tools] ${input.dynamicTools.length}`)
    lines.push(
      ...input.dynamicTools
        .slice(0, 20)
        .map(
          (tool) =>
            `- ${clip(tool.name, 80)} [${tool.risk}] enabled=${tool.enabled} approved=${tool.approved}: ${clip(tool.description, 200)}`,
        ),
    )
  }
  if (sections.has('memory')) {
    lines.push('', `[Project memory] ${memory.length} entries`)
    lines.push(
      ...memory
        .slice(0, 10)
        .map((entry) => `- [${entry.source}] ${clip(entry.content, 240)}`),
    )
  }
  if (sections.has('instructions')) {
    lines.push(
      '',
      '[Instructions]',
      `global: ${input.globalInstructions.length > 0 ? input.globalInstructions.map((file) => clip(file.name, 80)).join(', ') : `(none; path ${clip(settings.globalInstructionsPath, 200)})`}`,
      `project: ${input.projectInstructions.length > 0 ? input.projectInstructions.map((file) => clip(file.name, 80)).join(', ') : '(none)'}`,
    )
  }
  lines.push(
    '',
    'To optimize from this evidence: call propose_self_update (scope=workspace or global) to create an inactive draft, or remember for a durable lesson. Drafts never change behavior until the user activates them.',
  )
  return lines.join('\n')
}
