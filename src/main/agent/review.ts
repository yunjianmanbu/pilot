import type { AppLocale } from '../../shared/i18n'
import type {
  AgentToolDefinition,
  Plan,
  ProfileExplanation,
  ReviewEvidenceRef,
  ReviewFinding,
  ReviewReport,
  ReviewScope,
  Session,
  SessionSummary,
  ToolResult,
} from '../../shared/types'
import type { Store } from '../store'
import { sanitizeReviewReport } from '../store'
import { redactSecrets } from './redact'
import { reasoningLanguage, thinkingLanguageGuard } from './prompt'
import {
  executePilotTool,
  pilotTools,
  REVIEW_TOOL_ALLOWLIST,
  UPDATE_PLAN,
  type ToolHost,
} from './tools'

export const LIST_SESSIONS = 'list_sessions'
export const GET_SESSION = 'get_session'
export const SEARCH_SESSIONS = 'search_sessions'
export const LIST_RUNS = 'list_runs'
export const GET_RUN = 'get_run'
export const RECORD_REVIEW = 'record_review'

const SESSION_TOOLS = new Set([LIST_SESSIONS, GET_SESSION, SEARCH_SESSIONS, LIST_RUNS, GET_RUN, RECORD_REVIEW])

/** Every tool a review session may call. Write/exec/MCP tools are absent. */
export function isReviewToolName(name: string): boolean {
  return REVIEW_TOOL_ALLOWLIST.has(name) || SESSION_TOOLS.has(name)
}

export function redactReviewText(text: string): string {
  return redactSecrets(text)
}

function clip(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : ''
  return redactReviewText(text).trim().slice(0, limit)
}

function normalizePath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}

export function reviewScopeLabel(scope: ReviewScope): string {
  if (scope.sessions === 'all') return '所有已保存会话'
  if (scope.sessions === 'workspace') return '当前工作区会话'
  return `指定的 ${scope.sessions.length} 个会话`
}

function rootLabel(scope: ReviewScope, path: string): string {
  return scope.roots.find((root) => normalizePath(root.path) === normalizePath(path))?.name ?? path
}

/** Build read/session tool definitions, adding the root selector to file tools. */
export function reviewToolsFor(scope: ReviewScope): AgentToolDefinition[] {
  const names = scope.roots.map((root) => root.name)
  const fileTools = pilotTools
    .filter((tool) => tool.risk === 'read' && REVIEW_TOOL_ALLOWLIST.has(tool.name))
    .map((tool) => {
      const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, unknown>
      return {
        ...tool,
        description: `${tool.description} This is a read-only review session: pass root to select one of the allowed roots; it defaults to "${names[0] ?? 'primary'}".`,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...properties,
            root: {
              type: 'string',
              enum: names,
              description: `Allowed root alias: ${names.join(', ')}.`,
            },
          },
        },
      }
    })
  return [
    ...fileTools,
    {
      name: LIST_SESSIONS,
      description:
        'List stored sessions in this review scope with id, title, workspace, kind, time and message count. Use it first when you need to choose which sessions to inspect.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional case-insensitive title/path filter.' },
          limit: { type: 'number', description: 'Max sessions, default 30, max 100.' },
        },
        additionalProperties: false,
      },
      risk: 'read',
      source: 'builtin',
    },
    {
      name: GET_SESSION,
      description:
        'Read one stored session in the review scope, paginated. Returns metadata, recent runs and messages with stable message ids plus tool calls and truncated tool output. Use offset/limit to page instead of re-reading the same slice.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          offset: { type: 'number', description: 'Message offset, default 0.' },
          limit: { type: 'number', description: 'Messages to return, default 30, max 60.' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      risk: 'read',
      source: 'builtin',
    },
    {
      name: SEARCH_SESSIONS,
      description:
        'Full-text search inside stored session messages in the review scope. Returns session id, message id, role and a short snippet. Use it to locate a failure or decision, then read the surrounding messages with get_session.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text; matching is case-insensitive.' },
          limit: { type: 'number', description: 'Max hits, default 20, max 50.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      risk: 'read',
      source: 'builtin',
    },
    {
      name: LIST_RUNS,
      description:
        'List run records in the review scope (newest first), optionally for one session and/or status. Runs carry steps, tokens, tool counts, errors, feedback and the final error.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional session id in scope.' },
          status: {
            type: 'string',
            description: 'Optional run status filter, e.g. failed or completed.',
          },
          limit: { type: 'number', description: 'Max runs, default 40, max 100.' },
        },
        additionalProperties: false,
      },
      risk: 'read',
      source: 'builtin',
    },
    {
      name: GET_RUN,
      description:
        'Read one run record by id, including its prompt, status, usage, error and user feedback. Use it together with get_session to tie a failure to the transcript.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string' } },
        required: ['runId'],
        additionalProperties: false,
      },
      risk: 'read',
      source: 'builtin',
    },
    {
      name: RECORD_REVIEW,
      description:
        'Record the final structured review report. Call this exactly once when the investigation is complete, then give the user a short summary. The report is a draft: lessons are saved to project memory and an optional profile addendum becomes an inactive evolution draft; nothing changes behavior automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'What was evaluated.' },
          verdict: {
            type: 'string',
            enum: ['pass', 'needs_work', 'blocked'],
            description: 'pass = no validated actionable issue; blocked = evidence was inaccessible.',
          },
          summary: { type: 'string', description: '2-6 sentences, evidence-grounded.' },
          scores: {
            type: 'object',
            description: 'Rubric scores 0-100.',
            properties: {
              correctness: { type: 'number' },
              evidence: { type: 'number' },
              safety: { type: 'number' },
              efficiency: { type: 'number' },
            },
            required: ['correctness', 'evidence', 'safety', 'efficiency'],
          },
          findings: {
            type: 'array',
            description: 'Validated issues. Leave empty only when the verdict is pass.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                facts: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Observed facts, not recommendations.',
                },
                evidence: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', enum: ['file', 'session', 'run'] },
                      ref: {
                        type: 'string',
                        description:
                          'For file: "alias:relative/path:line"; for session/run: the exact id.',
                      },
                      note: { type: 'string' },
                    },
                    required: ['kind', 'ref'],
                  },
                },
                rootCause: { type: 'string' },
                recommendation: { type: 'string' },
                confidence: { type: 'number', description: '0-1.' },
              },
              required: ['title', 'severity', 'recommendation', 'confidence'],
            },
          },
          unknowns: { type: 'array', items: { type: 'string' } },
          memoryLessons: {
            type: 'array',
            items: { type: 'string' },
            description: '0-8 durable, actionable lessons for future runs (max 500 chars each).',
          },
          profileAddendum: {
            type: 'string',
            description:
              'Optional operating-rule addition for an evolution draft. Never weaken safety, evidence or approval rules.',
          },
          profileRationale: { type: 'string' },
        },
        required: ['objective', 'verdict', 'summary', 'scores', 'findings'],
        additionalProperties: false,
      },
      risk: 'control',
      source: 'control',
    },
    ...pilotTools.filter((tool) => tool.name === UPDATE_PLAN),
  ]
}

export interface ReviewRecordResult {
  memoryCount: number
  profileVersion?: number
  /** Plain-language summary of the draft, for the chat reply. */
  profileSummary?: ProfileExplanation
}

export interface ReviewRuntime {
  store: Store
  session: Session
  scope: ReviewScope
  model: string
  record(report: ReviewReport): Promise<ReviewRecordResult>
}

function allowedSession(runtime: ReviewRuntime, sessionId: string): Session {
  const session = runtime.store.session(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  const scope = runtime.scope.sessions
  if (Array.isArray(scope) && !scope.includes(sessionId)) {
    throw new Error('That session is outside this review scope')
  }
  if (
    scope === 'workspace' &&
    normalizePath(session.workspacePath) !== normalizePath(runtime.session.workspacePath)
  ) {
    throw new Error('That session belongs to another workspace and is outside this review scope')
  }
  return session
}

function allowedSessions(runtime: ReviewRuntime): SessionSummary[] {
  const scope = runtime.scope.sessions
  let entries: SessionSummary[] = []
  if (Array.isArray(scope)) {
    entries = scope
      .map((id) => runtime.store.session(id))
      .filter((session): session is Session => Boolean(session))
  } else if (scope === 'workspace') {
    entries = runtime.store.sessions(runtime.session.workspacePath)
  } else {
    entries = runtime.store
      .workspaces()
      .flatMap((workspace) => runtime.store.sessions(workspace.path))
  }
  const seen = new Set<string>()
  return entries
    .filter((entry) => {
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function sessionLine(session: SessionSummary, scope: ReviewScope): string {
  return [
    session.id,
    session.kind === 'review' ? '[review]' : '[coding]',
    clip(session.title, 120) || '(untitled)',
    rootLabel(scope, session.workspacePath),
    session.updatedAt,
    `${session.messageCount} msgs`,
    `mode=${session.approvalMode}`,
  ].join(' | ')
}

function listSessions(runtime: ReviewRuntime, args: Record<string, unknown>): string {
  const query = clip(args['query'], 200).toLowerCase()
  const limit = integer(args['limit'], 30, 1, 100)
  const all = allowedSessions(runtime)
  const filtered = query
    ? all.filter((session) =>
        [session.id, session.title, session.workspacePath, session.kind]
          .join('\n')
          .toLowerCase()
          .includes(query),
      )
    : all
  const shown = filtered.slice(0, limit)
  const lines = [
    `Scope: ${reviewScopeLabel(runtime.scope)}. ${filtered.length} session(s) matched; showing ${shown.length}.`,
    ...shown.map((session) => `- ${sessionLine(session, runtime.scope)}`),
  ]
  if (filtered.length > shown.length) {
    lines.push(`(${filtered.length - shown.length} more not shown; narrow the query or raise limit.)`)
  }
  return lines.join('\n')
}

function formatMessage(message: Session['messages'][number], index: number): string {
  const head = [
    `[#${index}] ${message.role.toUpperCase()}`,
    `id=${message.id}`,
    message.runId ? `run=${message.runId}` : '',
    message.control ? 'control=true' : '',
    message.createdAt,
  ]
    .filter(Boolean)
    .join(' ')
  const lines = [head]
  if (message.role === 'assistant') {
    if (message.content.trim()) lines.push(clip(message.content, 5_000))
    for (const call of message.toolCalls ?? []) {
      const serialized = redactReviewText(JSON.stringify(call.arguments ?? {}))
      lines.push(`  tool_call ${call.name} id=${call.id} ${serialized.slice(0, 800)}`)
    }
  } else if (message.role === 'tool') {
    lines.push(
      `  ${message.name ?? 'tool'} ${message.isError ? 'ERROR' : 'OK'}: ${clip(message.content, 1_500)}`,
    )
  } else if (message.role === 'user') {
    lines.push(clip(message.content, 3_500))
    if (message.references && message.references.length > 0) {
      lines.push(`  references: ${message.references.slice(0, 8).join(', ')}`)
    }
    if (message.images && message.images.length > 0) {
      lines.push(`  images: ${message.images.length} attached`)
    }
  } else {
    lines.push(clip(message.content, 2_000))
  }
  return lines.join('\n')
}

/**
 * The plan a specific run ended with. `toStoredMessages` attaches it to that
 * run's final answer, so it survives later turns replacing the session plan.
 */
function runPlanSnapshot(session: Session, runId: string): Plan | null {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]
    if (!message || message.runId !== runId) continue
    if (message.plan && message.plan.items.length > 0) return message.plan
  }
  return null
}

function getSession(runtime: ReviewRuntime, args: Record<string, unknown>): string {
  const sessionId = clip(args['sessionId'], 200)
  if (!sessionId) throw new Error('sessionId is required')
  const session = allowedSession(runtime, sessionId)
  const offset = integer(args['offset'], 0, 0, 1_000_000)
  const limit = integer(args['limit'], 30, 1, 60)
  const messages = session.messages.slice(offset, offset + limit)
  const runs = runtime.store
    .runs(session.workspacePath)
    .filter((run) => run.sessionId === session.id)
    .slice(0, 5)
  const header = [
    `Session ${session.id}`,
    `Title: ${clip(session.title, 200)}`,
    `Workspace: ${session.workspacePath} (root alias: ${rootLabel(runtime.scope, session.workspacePath)})`,
    `Kind: ${session.kind}; approval mode: ${session.approvalMode}`,
    `Messages: ${session.messages.length}; showing ${offset + 1}-${offset + messages.length}`,
  ]
  // The session-level plan belongs to the newest turn, not to the run under
  // review, and loading an old store settles it (an in_progress item is turned
  // into done or pending). Reviewing historical work therefore reads the plan
  // that run recorded on its own final answer, and the live plan is only shown
  // as a marked fallback so nobody mistakes it for that run's state.
  const snapshots = runs
    .map((run) => ({ run, plan: runPlanSnapshot(session, run.id) }))
    .filter((entry) => entry.plan !== null)
  if (snapshots.length > 0) {
    for (const { run, plan } of snapshots) {
      if (!plan) continue
      header.push(
        `Plan recorded by run ${run.id} (${run.status}, snapshot taken when it ended): ${clip(plan.goal, 200) || '(no goal)'} — ${plan.items
          .map((item) => `[${item.status}] ${clip(item.text, 160)}`)
          .join('; ')}`,
      )
    }
  } else if (session.plan && session.plan.items.length > 0) {
    header.push(
      `Session plan (current turn; no per-run snapshot was recorded, so this may not be the state during the run you are reviewing): ${clip(session.plan.goal, 200) || '(no goal)'} — ${session.plan.items
        .map((item) => `[${item.status}] ${clip(item.text, 160)}`)
        .join('; ')}`,
    )
  }
  if (runs.length > 0) {
    header.push(
      'Recent runs:',
      ...runs.map(
        (run) =>
          `- ${run.id} status=${run.status} started=${run.startedAt} steps=${run.steps} tools=${run.toolCalls} errors=${run.toolErrors} tokens=${run.totalTokens}${run.error ? ` error=${clip(run.error, 300)}` : ''}`,
      ),
    )
  }
  header.push('', 'Messages:')
  header.push(
    ...(messages.length > 0
      ? messages.map((message, index) => formatMessage(message, offset + index))
      : ['(no messages in this range)']),
  )
  return header.join('\n')
}

function searchSessions(runtime: ReviewRuntime, args: Record<string, unknown>): string {
  const query = clip(args['query'], 400)
  if (query.trim().length < 2) throw new Error('query must be at least 2 characters')
  const limit = integer(args['limit'], 20, 1, 50)
  const allowed = new Set(allowedSessions(runtime).map((session) => session.id))
  const hits = runtime.store
    .searchSessions(query, Math.min(200, limit * 4))
    .filter((hit) => allowed.has(hit.sessionId))
    .slice(0, limit)
  if (hits.length === 0) return 'No matching messages inside this review scope.'
  return [
    `Matches: ${hits.length}`,
    ...hits.map(
      (hit) =>
        `- session=${hit.sessionId} message=${hit.messageId} role=${hit.role} at=${hit.createdAt}\n  title=${clip(hit.sessionTitle, 120)}\n  ${clip(hit.snippet, 500)}`,
    ),
  ].join('\n')
}

function allowedRuns(runtime: ReviewRuntime) {
  const sessions = allowedSessions(runtime)
  const allowedIds = new Set(sessions.map((session) => session.id))
  const paths = [...new Set(sessions.map((session) => session.workspacePath))]
  const runs = paths.flatMap((path) => runtime.store.runs(path))
  return runs
    .filter((run) => allowedIds.has(run.sessionId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function listRuns(runtime: ReviewRuntime, args: Record<string, unknown>): string {
  const sessionId = clip(args['sessionId'], 200)
  if (sessionId) allowedSession(runtime, sessionId)
  const status = clip(args['status'], 40)
  const limit = integer(args['limit'], 40, 1, 100)
  const runs = allowedRuns(runtime).filter(
    (run) => (!sessionId || run.sessionId === sessionId) && (!status || run.status === status),
  )
  if (runs.length === 0) return 'No runs matched inside this review scope.'
  return [
    `Runs: ${runs.length}; showing ${Math.min(limit, runs.length)}.`,
    ...runs.slice(0, limit).map(
      (run) =>
        `- ${run.id} | ${run.status} | session=${run.sessionId} | ${run.startedAt} | steps=${run.steps} tools=${run.toolCalls} errors=${run.toolErrors} tokens=${run.totalTokens} | prompt=${clip(run.prompt, 300)}${run.error ? ` | error=${clip(run.error, 300)}` : ''}`,
    ),
  ].join('\n')
}

function getRun(runtime: ReviewRuntime, args: Record<string, unknown>): string {
  const runId = clip(args['runId'], 200)
  if (!runId) throw new Error('runId is required')
  const allowedIds = new Set(allowedSessions(runtime).map((session) => session.id))
  for (const workspace of runtime.store.workspaces()) {
    const run = runtime.store.run(workspace.path, runId)
    if (!run) continue
    if (!allowedIds.has(run.sessionId)) {
      throw new Error('That run is outside this review scope')
    }
    return [
      `Run ${run.id}`,
      `Status: ${run.status}; session: ${run.sessionId}; workspace: ${workspace.path}`,
      `Started: ${run.startedAt}; finished: ${run.finishedAt ?? '(not finished)'}`,
      `Steps: ${run.steps}; tool calls: ${run.toolCalls}; tool errors: ${run.toolErrors}`,
      `Tokens: ${run.totalTokens} (prompt ${run.promptTokens}, completion ${run.completionTokens})`,
      run.modelMs !== undefined
        ? `Timing: model ${run.modelMs}ms; tools ${run.toolMs ?? 0}ms; checkpoints ${run.checkpointMs ?? 0}ms; approvals ${run.approvalMs ?? 0}ms; summaries ${run.summarizeMs ?? 0}ms`
        : '',
      run.profileVersion !== undefined ? `Profile version: ${run.profileVersion}` : '',
      run.feedback
        ? `Feedback: ${run.feedback.rating}${run.feedback.note ? ` — ${clip(run.feedback.note, 500)}` : ''}`
        : 'Feedback: (none)',
      `Prompt:\n${clip(run.prompt, 4_000)}`,
      run.error ? `Error:\n${clip(run.error, 2_000)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  throw new Error(`Run not found: ${runId}`)
}

export function buildReviewReport(
  runtime: Pick<ReviewRuntime, 'scope' | 'model'>,
  args: Record<string, unknown>,
): ReviewReport {
  const fallbackObjective =
    runtime.scope.objective?.trim() || '(the user did not specify an objective)'
  const report = sanitizeReviewReport({
    ...args,
    objective: clip(args['objective'], 4_000) || fallbackObjective,
    createdAt: new Date().toISOString(),
    model: runtime.model,
  })
  if (!report) throw new Error('The review report is empty; include a summary and findings')
  if (report.verdict === 'needs_work' && report.findings.length === 0) {
    throw new Error('verdict=needs_work requires at least one validated finding')
  }
  for (const finding of report.findings) {
    if (finding.evidence.length === 0) {
      throw new Error(`Finding "${finding.title}" has no evidence; cite a file, session or run`)
    }
  }
  if (report.profileAddendum && !report.profileRationale) {
    throw new Error('profileAddendum also needs profileRationale')
  }
  return report
}

function recordReview(runtime: ReviewRuntime, args: Record<string, unknown>): Promise<ToolResult> {
  return (async () => {
    const report = buildReviewReport(runtime, args)
    const result = await runtime.record(report)
    const parts = [
      `Report recorded: verdict=${report.verdict}, findings=${report.findings.length}, scores=${report.scores.correctness}/${report.scores.evidence}/${report.scores.safety}/${report.scores.efficiency}.`,
    ]
    if (result.memoryCount > 0) {
      parts.push(`${result.memoryCount} durable lesson(s) saved to project memory as reference.`)
    }
    if (result.profileVersion !== undefined) {
      parts.push(
        `Evolution draft v${result.profileVersion} created (inactive until the user reviews and activates it).`,
      )
    }
    if (result.profileSummary) {
      const summary = result.profileSummary
      parts.push(
        [
          'Plain-language summary of that draft — tell the user this, not the rule text:',
          `- change: ${summary.headline}`,
          ...summary.changes.map((item) => `- behaviour: ${item}`),
          `- impact: ${summary.impact}`,
          ...summary.risks.map((item) => `- risk: ${item}`),
          `- recommendation: ${summary.recommend === 'enable' ? 'enable now' : 'keep the current version for now'}`,
          summary.reason ? `- why: ${summary.reason}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      )
    }
    parts.push(
      'Now give the user a concise summary in everyday Chinese: what changes for them, what they will notice, what could get worse, and whether you suggest enabling it. Do not paste rules, scores, step or token numbers. Do not claim anything was changed automatically.',
    )
    return { ok: true, output: parts.join(' ') }
  })()
}

export async function executeReviewTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
  runtime: ReviewRuntime,
): Promise<ToolResult> {
  if (REVIEW_TOOL_ALLOWLIST.has(name)) {
    const result = await executePilotTool(name, args, host, signal)
    if (!result.ok || !result.output) return result
    const redacted = redactReviewText(result.output)
    return redacted === result.output ? result : { ...result, output: redacted }
  }
  switch (name) {
    case LIST_SESSIONS:
      return { ok: true, output: listSessions(runtime, args) }
    case GET_SESSION:
      return { ok: true, output: getSession(runtime, args) }
    case SEARCH_SESSIONS:
      return { ok: true, output: searchSessions(runtime, args) }
    case LIST_RUNS:
      return { ok: true, output: listRuns(runtime, args) }
    case GET_RUN:
      return { ok: true, output: getRun(runtime, args) }
    case RECORD_REVIEW:
      return recordReview(runtime, args)
    default:
      return {
        ok: false,
        output: '',
        error: `Unknown review tool: ${name}`,
      }
  }
}

export interface ReviewPromptInput {
  scope: ReviewScope
  primaryRoot: string
  topLevel: string
  plan: Plan | null
  /** Effective app/UI language; the review's thinking text follows it. */
  locale?: AppLocale
}

/**
 * Independent reviewer prompt. It deliberately omits the coding agent's
 * active profile and self-update instructions so the review is not graded by
 * the same rules that produced the behavior.
 */
export function buildReviewSystemPrompt(input: ReviewPromptInput): string {
  const scope = input.scope
  const roots = scope.roots
    .map(
      (root) =>
        `- ${root.name}: ${root.path}${normalizePath(root.path) === normalizePath(input.primaryRoot) ? ' (primary; the default root)' : ''}`,
    )
    .join('\n')
  const lines = [
    'You are Pilot\'s independent review analyst. You examine delivered work and stored runs with an evidence-first, objective stance. You are not the agent that did the work, and you do not defend it.',
    `Thinking language: write every reasoning/thinking block in ${reasoningLanguage(input.locale)}, the language the app UI and system use, even when the transcript, the code or the objective is written in another language. ${thinkingLanguageGuard(input.locale)} Keep file paths, identifiers, commands and quoted text exactly as written.`,
    '',
    'READ-ONLY BOUNDARY:',
    '- You have no write, edit, shell, network, MCP or memory-management tools. Never claim you changed a file, ran a test, installed anything or fixed a problem.',
    '- You may read only the roots and sessions listed below. If evidence is outside them, record it as an unknown instead of guessing.',
    '- Never print a password, API key, token, cookie, private key or .env value. Tool output may show <redacted>; that is expected.',
    '',
    'Allowed roots (pass `root` to file and git tools; the primary root is the default):',
    roots,
    '',
    `Session scope: ${reviewScopeLabel(scope)}. Use list_sessions, get_session, search_sessions, list_runs and get_run to inspect the actual transcript and run records.`,
    '',
    `Objective: ${scope.objective?.trim() || '(not specified; infer it from the user messages, but say so in the report)'}`,
    '',
    'Rubric (score each 0-100):',
    '- correctness: did the delivered behavior match the request; are claims supported by the code and transcript?',
    '- evidence: are conclusions grounded in cited files, message ids and run ids rather than summaries?',
    '- safety: were path, approval, sandbox, credential and destructive-operation boundaries respected?',
    '- efficiency: was the approach reasonably direct, without repeated failures or unnecessary work?',
    '',
    'Evidence rules:',
    '- Inspect before judging. Read the relevant files and session messages; do not rely on the agent\'s final summary alone.',
    '- Separate observed facts from inferences and unknowns. A fact needs a citation. An inference says what it is based on and carries a confidence.',
    '- Actively look for disconfirming evidence: failing runs, skipped checks, tool errors, reverted files, unresolved warnings.',
    '- A tool failure alone is not a defect if the agent diagnosed it and recovered. A green summary is not proof if no check ran.',
    '- Cite files as `alias:relative/path:line` (for example `app:src/main.rs:42`), sessions by exact session id plus message id, and runs by exact run id.',
    '- If a file or session cannot be read, say so; do not invent contents or counts.',
    '',
    'Report protocol:',
    '- For multi-step reviews, use update_plan to keep the visible plan current.',
    '- When the investigation is complete, call record_review exactly once with the structured rubric, findings, unknowns, durable lessons and (only if justified) a cautious profile addendum.',
    '- verdict=pass only when no validated actionable issue remains; verdict=blocked when missing access prevented a conclusion; otherwise needs_work.',
    '- Findings must be real and actionable, with evidence and a recommendation that a coding session can execute. Do not pad the list.',
    '- memoryLessons and profileAddendum are drafts. They never take effect automatically.',
    '- After record_review, answer the user with a short, direct summary of the verdict, the strongest evidence and what remains unknown. Do not repeat the whole report.',
  ]
  if (input.topLevel) {
    lines.push('', 'Primary root top level (use list_directory for more):', input.topLevel)
  }
  if (input.plan && input.plan.items.length > 0) {
    lines.push(
      '',
      `Current review plan${input.plan.goal ? ` — ${input.plan.goal}` : ''}:`,
      ...input.plan.items.map(
        (item, index) =>
          `${index + 1}. [${item.status === 'done' ? 'x' : item.status === 'in_progress' ? '>' : ' '}] ${item.text}`,
      ),
    )
  }
  return lines.join('\n')
}

function evidenceText(evidence: ReviewEvidenceRef[]): string {
  return evidence
    .map((entry) => `${entry.kind}:${entry.ref}${entry.note ? ` (${entry.note})` : ''}`)
    .join('; ')
}

function findingText(finding: ReviewFinding, index: number): string {
  return [
    `${index + 1}. [${finding.severity}] ${finding.title} (confidence ${finding.confidence})`,
    ...finding.facts.map((fact) => `   事实：${fact}`),
    `   证据：${evidenceText(finding.evidence) || '(missing)'}`,
    finding.rootCause ? `   根因：${finding.rootCause}` : '',
    `   建议：${finding.recommendation}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Build the prompt for the normal coding session that receives a review
 * report. The report is a lead, not proof: the fix session must re-verify it.
 */
export function buildFixPrompt(session: Session): string {
  const report = session.reviewReport
  if (!report) throw new Error('This review session has no recorded report yet')
  const scope = session.review
  const primary = scope?.roots[0]
  const otherRoots =
    scope?.roots.filter(
      (root) => normalizePath(root.path) !== normalizePath(session.workspacePath),
    ) ?? []
  const ordered = [...report.findings].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 }
    return rank[a.severity] - rank[b.severity]
  })
  return [
    '【复盘交接】请处理下面的独立复盘报告。报告是线索而不是结论：每个问题都要先用读取工具核实，再决定是否修改。',
    '',
    `来源复盘会话：${session.id}`,
    `复盘目标：${report.objective || scope?.objective || '(未指定)'}`,
    `复盘结论：${report.verdict}`,
    `评分：正确性 ${report.scores.correctness} · 证据 ${report.scores.evidence} · 安全 ${report.scores.safety} · 效率 ${report.scores.efficiency}`,
    `报告模型：${report.model || '(unknown)'}；生成时间：${report.createdAt}`,
    '',
    `摘要：${report.summary}`,
    '',
    ordered.length > 0 ? '需要核实和处理的问题（按严重度排序）：' : '没有需要处理的问题。',
    ...ordered.map((finding, index) => findingText(finding, index)),
    '',
    ...(report.unknowns.length > 0
      ? ['尚未确认的信息：', ...report.unknowns.map((item) => `- ${item}`), '']
      : []),
    '工作要求：',
    '- 先读取每个证据指向的文件和会话消息，确认问题真实存在；如果证据不足或已经修复，直接说明并跳过，不要为了“完成任务”制造改动。',
    '- 修复时遵守仓库现有约定，优先最小改动；不要顺带重构无关代码。',
    '- 每项改动后用最窄的测试、类型检查或构建命令验证；未验证的项目要在最终回复中明确列出。',
    '- 不要削弱路径、审批、沙箱、凭据或破坏性操作的安全边界。',
    '- 最终回复按问题列出：已修复 / 未复现 / 证据不足 / 未处理，并附上验证命令和结果。',
    ...(otherRoots.length > 0
      ? [
          '',
          `注意：本会话只能写入主项目 ${primary?.path ?? session.workspacePath}。以下其他复盘根目录中的问题无法在本会话安全修改，请在最终回复中列出，交由用户分别处理：`,
          ...otherRoots.map((root) => `- ${root.name}: ${root.path}`),
        ]
      : []),
  ]
    .join('\n')
}
