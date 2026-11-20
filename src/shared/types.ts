/** Types shared by the main process, preload bridge and renderer. */

import type { FeedbackDraft, FeedbackRecord } from './feedback'
import type { AppLocale, LocaleSetting } from './i18n'
import type { MemoryCategory } from './memory'
import type { PreviewKind } from './media'
import type {
  ModuleCheckReport,
  ModuleCheckSettings,
  ModuleCheckState,
  ModuleTarget,
} from './module-check'
import type { QualityComparison, QualityMetricSet, QualityScore } from './quality'
import type { UploadBatch } from './uploads'

export type { ModuleCheckReport, ModuleCheckSettings, ModuleCheckState, ModuleTarget }

export type ToolRisk = 'read' | 'write' | 'exec' | 'control'

/**
 * Session execution modes. The UI exposes three canonical values:
 *
 * - auto: everything runs directly, including writes and commands.
 * - manual: reads run automatically; edits and commands ask first.
 * - ask: every read/write/command tool asks first (plan bookkeeping stays automatic).
 *
 * Legacy values are still accepted when loading old state so a migration can
 * map them onto the three canonical modes. Hard boundaries (workspace path
 * jail, protected config paths, explicit deny rules and blocked commands)
 * remain enforced in every mode, including auto.
 */
export type ApprovalMode =
  | 'auto'
  | 'manual'
  | 'ask'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
export type MessageDelivery = 'queue' | 'insert'
/**
 * 审批决定的来源：用户点击、审批超时自动拒绝、运行被中断（取消/暂停/退出）。
 * 审计日志靠它区分「人拍的」与「超时/中断代拍的」。
 */
export type ApprovalDecidedBy = 'user' | 'timeout' | 'interrupted'
export type ThemeMode = 'dark' | 'light'
/**
 * What Settings stores: a pinned mode, or `system` to follow the OS. The
 * renderer and the main process both resolve it, so `ThemeMode` stays the
 * value that actually paints.
 */
export type ThemePreference = ThemeMode | 'system'
/**
 * Text size for the whole UI. `standard` is the size the app has always used;
 * the other two scale every font-size declaration through `--font-scale`, so
 * spacing and control sizes stay put.
 */
export type FontSizePreference = 'standard' | 'large' | 'xlarge'
/**
 * Contrast between text and the page/card ladder. `standard` keeps the palette
 * as designed; `high` deepens the ladder and sharpens text, `low` softens both
 * without dropping below the 4.5:1 readability floor.
 */
export type ContrastPreference = 'low' | 'standard' | 'high'
/**
 * Saturation of accent and functional colors. Lightness and hue are kept, so
 * text contrast does not change; `standard` is the palette as designed.
 */
export type SaturationPreference = 'low' | 'standard' | 'high'
/**
 * Accent palette for the desktop UI. The default (`graphite`) is pure black
 * and white; the other presets are deliberately desaturated and only mark
 * selection, focus and progress. `claude` is a full warm palette: ivory
 * surfaces with Claude's terracotta accent.
 */
export type AccentPalette =
  | 'graphite'
  | 'pine'
  | 'indigo'
  | 'clay'
  | 'ocean'
  | 'moss'
  | 'plum'
  | 'rose'
  | 'sand'
  | 'orange'
  | 'celadon'
  | 'claude'
/**
 * Captcha handling for authorized test targets. `off` never injects a value;
 * `fixture` injects a fixed test code; `header` injects a header value the
 * owner's test environment accepts. Pilot never trains or defeats a captcha.
 */
export type TestCaptchaMode = 'off' | 'fixture' | 'header'

/**
 * A coding session may read and write its workspace. A review session is a
 * deliberate read-only analyst: it can read several explicitly allowed roots
 * and the selected session history, but it never receives write or exec tools.
 */
export type SessionKind = 'coding' | 'review'

export interface ReviewRoot {
  /** Short alias used by review tools, unique within the scope. */
  name: string
  /** Absolute, realpath-resolved directory. */
  path: string
}

/** `workspace` = the review's primary workspace; `all` = every stored session. */
export type ReviewSessionScope = 'workspace' | 'all' | string[]

export interface ReviewScope {
  roots: ReviewRoot[]
  sessions: ReviewSessionScope
  /** What the user wants evaluated, copied into the review prompt. */
  objective?: string
}

export interface ReviewSessionInput {
  workspacePath: string
  roots: Array<{ name?: string; path: string }>
  sessions?: ReviewSessionScope
  objective?: string
}

export type ReviewVerdict = 'pass' | 'needs_work' | 'blocked'
export type ReviewSeverity = 'high' | 'medium' | 'low'

export interface ReviewScores {
  /** 0-100 rubric scores. */
  correctness: number
  evidence: number
  safety: number
  efficiency: number
}

export interface ReviewEvidenceRef {
  kind: 'file' | 'session' | 'run'
  /** For files: `alias:relative/path:line`. For sessions/runs: their id. */
  ref: string
  note?: string
}

export interface ReviewFinding {
  title: string
  severity: ReviewSeverity
  facts: string[]
  evidence: ReviewEvidenceRef[]
  rootCause?: string
  recommendation: string
  /** 0-1 self-assessed confidence in the finding. */
  confidence: number
}

/**
 * Structured outcome of a review session. Only lessons and an optional profile
 * draft are persisted into memory/evolution; the report itself never changes
 * behavior until the user acts on it.
 */
export interface ReviewReport {
  objective: string
  verdict: ReviewVerdict
  summary: string
  scores: ReviewScores
  findings: ReviewFinding[]
  unknowns: string[]
  memoryLessons: string[]
  profileAddendum?: string
  profileRationale?: string
  createdAt: string
  model: string
}

/** Rules use Claude-style syntax: `Tool` or `Tool(specifier)`. */
export interface PermissionRules {
  allow: string[]
  ask: string[]
  deny: string[]
}

export type SandboxMode = 'off' | 'auto'
export type SandboxBackend = 'bwrap' | 'wsl-bwrap' | 'seatbelt' | 'none'

/**
 * Interpreter used by run_shell on Windows. `auto` prefers an installed Git
 * Bash, then WSL, and finally cmd.exe. On other platforms $SHELL is used and
 * this setting has no effect.
 */
export type ShellInterpreter = 'auto' | 'cmd' | 'bash' | 'wsl'

export interface SandboxStatus {
  mode: SandboxMode
  available: boolean
  backend: SandboxBackend
  detail: string
  /** Whether the active backend can block outbound network access. */
  networkIsolation: boolean
}

/** Free and total space on one volume; a null number means the reading failed. */
export interface DiskSpace {
  path: string
  freeBytes: number | null
  totalBytes: number | null
  /** True when free space is below the pre-check threshold (`DISK_LOW_BYTES`). */
  low: boolean
}

/**
 * Host facts that change how commands behave.
 *
 * Deliberately excludes host name, user name, MAC address, IP and serial
 * numbers: they identify the machine without helping to diagnose it.
 */
export interface SystemInfo {
  platform: string
  osRelease: string
  arch: string
  cpuCount: number
  cpuModel: string
  memoryTotalBytes: number
  memoryFreeBytes: number
  electron: string
  node: string
  chrome: string
  /** Volume holding the workspace (or the process cwd when none was given). */
  disk: DiskSpace | null
}

/**
 * 一条已落盘的应用日志。渲染进程只拿到这份投影：细节在写盘前已经过
 * `redactSecrets` 与截断，不存在正文与密钥。
 */
export interface AppLogView {
  at: string
  area: string
  event: string
  level: 'info' | 'warn' | 'error'
  detail?: Record<string, unknown>
}

export type CheckpointTrigger = 'prompt' | 'shell' | 'manual' | 'prerestore'
export type CheckpointRestoreMode = 'code' | 'conversation' | 'both'

export interface Checkpoint {
  id: string
  sessionId: string
  workspacePath: string
  label: string
  createdAt: string
  messageCount: number
  files: number
  bytes: number
  trigger: CheckpointTrigger
  /** False when the snapshot budget truncated the tree or a file could not be read. */
  complete: boolean
  skipped: number
  /** Files hashed for this snapshot (new or changed content). */
  hashed?: number
  /** Files restored from the workspace index without re-hashing. */
  reused?: number
  /**
   * True for the first snapshot of a session: the reference point for change
   * review and per-file revert. Pinned against retention and the size budget.
   */
  baseline?: boolean
}

export interface CheckpointRestoreResult {
  checkpoint: Checkpoint
  session: Session
  restoredFiles: number
  removedFiles: number
  truncatedMessages: number
  /** Snapshot taken automatically right before the restore, so it can be undone. */
  safetyCheckpointId?: string
}

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export interface UpdateRelease {
  version: string
  channel: string
  platform: string
  date: string
  url: string
  size: number
  sha256: string
  notes: string
}

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  release: UpdateRelease | null
  /** Download progress from 0 to 1. */
  progress: number
  transferred: number
  total: number
  message: string
  checkedAt: string | null
  canInstall: boolean
  /**
   * Windows will show a UAC prompt because Pilot is installed in a directory
   * the current user cannot write to (for example C:\Program Files). The phone
   * warns about it before asking the computer to install.
   */
  elevationRequired: boolean
  /**
   * The next install moves Pilot to the per-user programs folder
   * (%LOCALAPPDATA%\Programs\Pilot) instead of updating in place, so it needs
   * no UAC prompt. Settings, sessions and pairing data live in the user data
   * directory and are kept.
   */
  relocatingToUserDir: boolean
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  ok: boolean
  output: string
  error?: string | null
  durationMs?: number
  risk?: ToolRisk
  metadata?: Record<string, unknown>
}

export interface AgentToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  risk: ToolRisk
  source?: 'builtin' | 'control' | 'mcp'
  /**
   * Marks tools that ask in the read-only-auto fallback policy. The canonical
   * evaluatePermission path derives approval from the execution mode, so this
   * flag does not override 全部自动 mode.
   */
  alwaysAsk?: boolean
  /**
   * Write tools that only record configuration or documentation (for example
   * create_skill) do not create code to verify, so they do not arm the
   * verification gate.
   */
  noVerification?: boolean
}

export type DynamicToolRuntime = 'node' | 'python'
export type DynamicToolSource = 'workspace' | 'global'

/**
 * A tool the agent wrote for a repeated capability gap. The code lives in
 * `.pilot/tools/<name>/` (or userData for promoted global tools); approval and
 * run statistics stay in userData so editing a tool revokes its old approval.
 */
export interface DynamicToolVersion {
  version: number
  sha256: string
  approvedAt: string
  /** 'register' first approval, 'upgrade' changed code, 'rollback' restored snapshot. */
  action: 'register' | 'upgrade' | 'rollback'
}

export interface DynamicToolInfo {
  name: string
  description: string
  version: number
  /** Version recorded when the current code was approved. */
  approvedVersion?: number
  /** Approval history, oldest first (snapshots kept for rollback). */
  versions?: DynamicToolVersion[]
  runtime: DynamicToolRuntime
  risk: 'read' | 'exec'
  source: DynamicToolSource
  enabled: boolean
  approved: boolean
  sha256: string
  timeoutMs: number
  targets: string[]
  inputSchema: Record<string, unknown>
  /** A successful run counts as verification evidence for the current task. */
  verification: boolean
  createdAt: string
  promotedAt?: string
  lastRunAt?: string
  successCount: number
  failureCount: number
  lastError?: string
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
  isError?: boolean
  /** Provider reasoning text, kept separately from the visible answer. */
  reasoning?: string
  /** Inline image data URLs (data:image/...;base64,...) for vision models. */
  images?: string[]
  /** Internal model-written summary of earlier turns; never dropped by trimming. */
  contextSummary?: boolean
  /**
   * Internal digest that stands in for turns folded away at run start. It is
   * labelled as closed work on its own first line and must never be re-framed
   * (a later pass would strip that label and hand old tasks back as the task).
   */
  earlierWork?: boolean
  /**
   * A reminder the loop injected while running (reflection, wrap-up, plan
   * check, verification, output continuation). It is role 'user' so the model
   * reads it as an instruction, but the system wrote it: it is never a new task
   * the user opened, so it must not close the task this run is working on.
   */
  internal?: boolean
}

/** A message as persisted and rendered. */
export interface StoredMessage extends AgentMessage {
  id: string
  createdAt: string
  runId?: string
  /** Internal continuation prompt; rendered as a compact action instead of a user bubble. */
  control?: boolean
  /**
   * Other project workspaces the user referenced for this message, stored as
   * absolute paths. Messages written by older clients may still carry
   * workspace-relative file paths.
   */
  references?: string[]
  /**
   * Snapshot of the plan this run produced (settled after the run). Kept on the
   * final assistant message so the finished turn can show its plan even after
   * the session-level plan is replaced by a later turn.
   */
  plan?: Plan
}

/** Optional attachments sent with one user message. */
export interface MessageOptions {
  images?: string[]
  /** Referenced project workspaces (absolute paths), or legacy relative files. */
  references?: string[]
}

/** One file copied from this computer into the session workspace. */
export interface WorkspaceUploadFile {
  /** Path relative to the workspace root, POSIX separators. */
  path: string
  /** Final file name, already de-duplicated against existing files. */
  name: string
  size: number
}

/**
 * Spend of the evaluation models (judges), kept apart from `AgentUsage` because
 * a judge request never enters the agent loop and was previously not counted
 * anywhere. Field names deliberately avoid the word "token": the log redactor
 * masks any detail key containing it (main/app-log.ts SENSITIVE_KEY), which
 * would turn the numbers into `<redacted>`.
 */
export interface JudgeUsage {
  /** Prompt tokens billed across judge requests. */
  input: number
  /** Completion tokens, including any billed thinking before the verdict. */
  output: number
  /** Prompt tokens served from the provider's context cache (billed cheaper). */
  cacheHit: number
  /** Requests made. Stays above zero with empty numbers when an endpoint reports no usage. */
  calls: number
}

export interface AgentUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Prompt tokens served from the provider's context cache (billed cheaper). */
  cacheHitTokens?: number
  /** Prompt tokens that missed the cache. */
  cacheMissTokens?: number
}

export interface QueuedTask {
  id: string
  content: string
  createdAt: string
}

export interface TodoItem {
  id: string
  sessionId: string
  text: string
  status: 'pending' | 'sent'
  /** Who created the item: the desktop user, the phone, or the agent itself. */
  source: 'user' | 'phone' | 'agent'
  clientId?: string
  createdAt: string
  sentAt?: string
  sentRunId?: string
}

export interface SessionArtifact {
  path: string
  name: string
  action: 'write' | 'edit'
  tool: string
}

/** A message-content match returned by workspace-wide full-text search. */
export interface MessageSearchHit {
  sessionId: string
  sessionTitle: string
  workspacePath: string
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
  createdAt: string
}

/**
 * One user instruction paired with the assistant replies that followed it.
 * Used by the phone knowledge-base page, which shows the conversation as
 * instruction → reply instead of a flat message list.
 */
export interface KnowledgePair {
  key: string
  /** 1-based position in the whole session. */
  index: number
  instructionId: string
  instruction: string
  instructionAt: string
  instructionTruncated?: boolean
  replyId: string
  replyAt: string
  reply: string
  /** How many assistant messages contributed text to this reply. */
  replyCount: number
  replyTruncated?: boolean
}

/** Knowledge pairs returned for one session, newest pairs kept when clipped. */
export interface KnowledgePairsResult {
  pairs: KnowledgePair[]
  /** Total pairs matching the query before the limit is applied. */
  total: number
}

/** Optional narrowing for the session knowledge-base search. */
export interface MessageSearchFilter {
  workspacePath?: string
  sessionId?: string
  role?: 'user' | 'assistant'
  /** ISO timestamp; matches only messages created at or after it. */
  since?: string
}

/** A project instruction file loaded from the workspace root. */
export interface ProjectInstructionFile {
  name: string
  bytes: number
  truncated: boolean
}

/** One file changed by the agent in a session, compared to its baseline. */
export interface SessionChange {
  path: string
  name: string
  action: 'write' | 'edit'
  status: 'modified' | 'added' | 'deleted' | 'unreadable'
  diff: string
  added: number
  removed: number
  /** Whether the session has a checkpoint that can restore this file. */
  canRevert: boolean
  note?: string
}

export interface RevertChangeResult {
  path: string
  restored: boolean
  removed: boolean
}

export interface PlanItem {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface Plan {
  goal: string
  items: PlanItem[]
  updatedAt: string
}

export type ScheduleKind = 'once' | 'interval' | 'daily'

/** A task that queues a normal agent run on a schedule. */
export interface ScheduledTask {
  id: string
  sessionId: string
  content: string
  kind: ScheduleKind
  /** Recurrence in minutes for kind=interval. */
  intervalMinutes?: number
  /** Local "HH:mm" for kind=daily. */
  timeOfDay?: string
  /** ISO timestamp for the next fire. */
  nextRunAt: string
  enabled: boolean
  createdAt: string
  lastRunAt?: string
  lastStatus?: 'queued' | 'failed'
  lastError?: string
}

export interface ScheduledTaskInput {
  content: string
  kind: ScheduleKind
  /** For kind=once: minutes from now before the single run. */
  delayMinutes?: number
  /** For kind=interval. */
  intervalMinutes?: number
  /** For kind=daily, local time as "HH:mm". */
  timeOfDay?: string
}

/**
 * A user-maintained quick prompt shown on the empty-chat welcome screen.
 * `null` from the bridge means the user has not customized the built-in list.
 */
export interface QuickCommand {
  id: string
  content: string
}

export interface QuickCommandInput {
  /** Existing id, when editing; omitted for new entries. */
  id?: string
  content: string
}

export interface SessionPage {
  session: Session
  hasMore: boolean
  /** Set when the page was centered on an older message and newer messages exist. */
  hasNewer?: boolean
}

export interface SessionSummary {
  id: string
  title: string
  workspacePath: string
  createdAt: string
  updatedAt: string
  running: boolean
  paused: boolean
  pausedAt?: string
  pauseInstruction?: string
  canContinue: boolean
  messageCount: number
  /**
   * Real user instructions in the session (internal continuation prompts are
   * excluded). Absent for summaries written by older clients, so the phone
   * omits the count instead of showing a wrong zero.
   */
  instructionCount?: number
  queueCount: number
  todoCount: number
  runInstruction?: string
  runStartedAt?: string
  approvalMode: ApprovalMode
  /**
   * 这个任务单独指定的会话模型（模型资源 id）。空串表示跟随全局会话模型。
   * 只在任务会话里选择，不在统一设置里配。
   */
  sessionModelId: string
  /** Latest agent plan, so the phone can render it without a full snapshot. */
  plan: Plan | null
  /** Coding (default) or the read-only multi-root review analyst. */
  kind: SessionKind
  /** Immutable review configuration; null for coding sessions. */
  review: ReviewScope | null
  /** Last structured report recorded by the review session. */
  reviewReport: ReviewReport | null
}

export interface Session extends SessionSummary {
  messages: StoredMessage[]
  queue: QueuedTask[]
  todos: TodoItem[]
  plan: Plan | null
  /**
   * Last model-written compaction summary of this session. It is the only
   * compact form of the turns a run folded away, so the next run re-injects it
   * instead of paying for another summarizer call over the same transcript.
   * Stored in the session shard, never sent to the renderer.
   */
  summary?: string
}

export interface WorkspaceSummary {
  path: string
  name: string
  addedAt: string
  lastOpenedAt: string
  sessionCount: number
  hasMemory: boolean
}

export interface SelfSourceResult {
  /** Workspace root that should be opened. */
  path: string
  /** True when the embedded source was copied into userData by this call. */
  copied: boolean
  /** True when the path is a userData copy instead of the live repository. */
  packaged: boolean
}

/**
 * What kind of fact a project-memory entry carries. The prompt budget is split
 * between categories so one noisy kind cannot crowd out the others.
 */
export type { MemoryCategory }

export interface MemoryEntry {
  id: string
  content: string
  source: 'user' | 'agent' | 'reflection'
  /** Missing on entries written before categories existed; inferred on read. */
  category?: MemoryCategory
  createdAt: string
  /** Times the same insight was re-derived, i.e. how strongly it proved useful. */
  reinforced?: number
  /** Times the entry was placed into a system prompt. */
  injected?: number
  lastUsedAt?: string
  runId?: string
}

export interface RunFeedback {
  rating: 'up' | 'down'
  note?: string
  at: string
}

export type RunStatus =
  | 'running'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'max_steps'

/** One model call inside a run: the unit cost attribution works on. */
export interface RunUsageSample {
  step: number
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  completionTokens: number
  /** Prompt tokens the request carried (transcript plus tool schemas). */
  contextTokens: number
}

export interface RunRecord {
  id: string
  sessionId: string
  prompt: string
  status: RunStatus
  startedAt: string
  finishedAt?: string
  steps: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Model that served this run; absent in records written before 0.1.30. */
  model?: string
  /** Prompt tokens billed at the cache-hit rate (DeepSeek context cache). */
  cacheHitTokens?: number
  /** Prompt tokens billed at the cache-miss rate; promptTokens is the sum. */
  cacheMissTokens?: number
  /**
   * Usage of every model call, oldest first and capped, so cost can be
   * attributed per step. Absent in records written before this version.
   */
  usageSteps?: RunUsageSample[]
  toolCalls: number
  toolErrors: number
  /** Wall time inside model requests. */
  modelMs?: number
  /** Sum of tool execution durations (parallel calls overlap in wall time). */
  toolMs?: number
  /** Time spent waiting for human approval decisions. */
  approvalMs?: number
  /** Time spent in pre-shell and pre-run workspace snapshots. */
  checkpointMs?: number
  /** Time spent writing context summaries. */
  summarizeMs?: number
  /** Best-effort count of files changed by write tools in this run. */
  filesChanged?: number
  /** True when a verification-like command succeeded after the last change. */
  checked?: boolean
  /** Nested subagent delegations (explore/general/toolsmith) in this run. */
  delegations?: number
  /** Steps spent inside delegated subagents, excluded from `steps`. */
  delegatedSteps?: number
  /** Summary characters returned by subagents, i.e. what entered the parent context. */
  delegatedSummaryChars?: number
  profileVersion?: number
  globalProfileVersion?: number
  feedback?: RunFeedback
  error?: string
}

export interface ProfileStrategy {
  maxSteps?: number
  temperature?: number
}

export interface ProfileEvidence {
  runs: number
  failures: number
  avgSteps: number
  avgTokens: number
  positive: number
  negative: number
  /** Completed runs that changed files and then ran a verification command. */
  verified?: number
}

/** A reviewer's justification for dropping one rule. */
export interface ProfileRuleRemovalVerdict {
  /** Exact rule text the reviewer was asked about. */
  rule: string
  justified: boolean
  reason: string
}

/** Verdict from one configured judge model. */
export interface ProfileJudgeVerdict {
  /** Judge provider id, or `default` when the run model reviewed itself. */
  id: string
  label: string
  model: string
  /** True when this judge does not share the execution model's endpoint. */
  external: boolean
  score: number
  pass: boolean
  notes: string
  risks: string[]
  /** One entry per rule removed relative to the version in use. */
  removals?: ProfileRuleRemovalVerdict[]
}

/** Aggregated deletion rationale across the reviewer panel. */
export interface ProfileRuleRemoval {
  rule: string
  /** True only when every reviewer covered the rule with a usable reason. */
  justified: boolean
  reason: string
  /** Reviewer labels that accepted the deletion. */
  judges: string[]
}

/**
 * The program's activation gate, separate from the rubric score. A profile may
 * pass review yet still be unready because a benchmark is missing, the measured
 * result is not better, or a deleted rule lacks a reviewer reason.
 */
export interface ProfileActivationGate {
  ready: boolean
  reasons: string[]
}

export interface ProfileReview {
  score: number
  pass: boolean
  notes: string
  risks: string[]
  at: string
  model: string
  /**
   * True when every judge ran on a model other than the execution model.
   * Absent in reviews written before multi-judge support; treat as false.
   */
  independent?: boolean
  /** Per-model verdicts. Absent when no judge provider is configured. */
  judges?: ProfileJudgeVerdict[]
  /** Judge failures. Any entry blocks activation for that review. */
  judgeErrors?: string[]
  /** What the review panel cost. Absent in reviews written before it was counted. */
  judgeUsage?: JudgeUsage
  /** Version the deletion list was compared against, when known. */
  baselineVersion?: number
  /** Deleted-rule rationale, one row per rule. Empty when nothing was removed. */
  removals?: ProfileRuleRemoval[]
  /**
   * Outcome of replaying the fixed benchmark under both versions. Review says
   * the rules read well; this says whether runs actually got better.
   */
  comparison?: ProfileComparison
  /** Final, program-enforced activation decision. */
  activation?: ProfileActivationGate
}

/** One row of the paired benchmark, as shown in the UI. */
export interface ProfileBenchmarkRow {
  taskId: string
  currentPassed: boolean
  candidatePassed: boolean
  currentSteps: number
  candidateSteps: number
  currentJudgeScore?: number
  candidateJudgeScore?: number
}

/** Result of replaying the fixed suite under both profiles. */
export interface ProfileBenchmarkReport {
  comparison: ProfileComparison
  rows: ProfileBenchmarkRow[]
}

/** Compact, persisted summary of a paired active-vs-candidate benchmark. */
export interface ProfileComparison {
  verdict: 'better' | 'worse' | 'inconclusive' | 'insufficient'
  tasks: number
  wins: number
  losses: number
  ties: number
  current: {
    successRate: number
    avgSteps: number
    avgTokens: number
    /** Mean wall-clock time per run; absent on comparisons recorded before it was tracked. */
    avgMs?: number
    avgJudgeScore?: number
  }
  candidate: {
    successRate: number
    avgSteps: number
    avgTokens: number
    /** Mean wall-clock time per run; absent on comparisons recorded before it was tracked. */
    avgMs?: number
    avgJudgeScore?: number
  }
  reasons: string[]
  at: string
  /** Revision of the task library this verdict was measured against. */
  suiteVersion?: number
  /** Hardest task tier that ran, and its pass rate: the top of the ruler. */
  ceilingTier?: string
  /** Share of runs that solved a task at `ceilingTier`; null when unmeasured. */
  ceilingPassRate?: number | null
  /** True when every run at the hardest tier passed *and* none was flaky: a
   * tier that only passes on some attempts still separates profiles. */
  suiteSaturated?: boolean
  /** Profile id the "current" side was measured under, when known. */
  currentId?: string
  /** Profile id the "candidate" side was measured under. */
  candidateId?: string
  /** Models of the third-party judges that scored the blind pairs. */
  judges?: string[]
  judgeErrors?: string[]
  /** What the blind grading cost; absent on comparisons recorded before it was counted. */
  judgeUsage?: JudgeUsage
}

/**
 * One model endpoint the user has configured. Session, review and evaluation
 * roles all point at these resources instead of carrying their own duplicate
 * endpoint/key fields.
 */
export interface ModelResource {
  id: string
  label: string
  baseUrl: string
  model: string
  /** 四字以内的短标签（「个人」「公司A」），只用于辨识，不参与路由。 */
  tag: string
  enabled: boolean
  hasKey: boolean
  keyHint: string
}

/** Write payload for one model resource. */
export interface ModelResourceInput {
  id?: string
  label?: string
  baseUrl?: string
  model?: string
  tag?: string
  enabled?: boolean
  /** New key. Empty string keeps the stored key; null clears it. */
  apiKey?: string | null
}

/** Public role selection for the unified model resources. */
export interface ModelSettingsView {
  resources: ModelResource[]
  sessionModelId: string
  evaluationModelIds: string[]
  /** Empty means review sessions follow the session model. */
  reviewModelId: string
}

/** A reviewer endpoint configured by the user (public view, no plaintext key). */
export interface JudgeProvider {
  id: string
  label: string
  baseUrl: string
  model: string
  enabled: boolean
  hasKey: boolean
  keyHint: string
}

/** Write payload for one judge provider. */
export interface JudgeProviderInput {
  id?: string
  label?: string
  baseUrl?: string
  model?: string
  enabled?: boolean
  /** New key. Empty string keeps the stored key; null clears it. */
  apiKey?: string | null
}

/** Ask for a reviewer's provider balance, before or after saving its row. */
export interface JudgeBalanceInput {
  /** Use the stored key/endpoint of this saved reviewer. */
  providerId?: string
  apiKey?: string
  baseUrl?: string
  model?: string
}

/**
 * Plain-language description of a profile change, written for a user who does
 * not read code or agent terminology. The decision only needs these fields;
 * the addendum, evidence and review scores belong in a technical appendix.
 */
export interface ProfileExplanation {
  /** One sentence in the user's own terms: which problem this change is about. */
  headline: string
  /** What changes, one short plain sentence per item. */
  changes: string[]
  /** What the user will actually notice afterwards. */
  impact: string
  /** What could get worse, and what to watch for. */
  risks: string[]
  /** `observe` means: keep the current version until there is more evidence. */
  recommend: 'enable' | 'observe'
  /** Why that recommendation, in one sentence. */
  reason: string
  /** Which model wrote it, so a stale summary is recognisable. */
  model?: string
  at: string
}

export interface ProfileVersion {
  id: string
  version: number
  status: 'draft' | 'active' | 'retired'
  promptAddendum: string
  strategy: ProfileStrategy
  rationale: string
  /** Absent in older stores and when the explanation call failed. */
  explanation?: ProfileExplanation
  /**
   * `promoted` means the rules were generalized from a workspace profile at
   * the user's request. Older stores only contain `user` and `self`.
   */
  source: 'user' | 'self' | 'promoted'
  /** Missing in older stores; those profiles belong to a workspace. */
  scope?: 'workspace' | 'global'
  evidence: ProfileEvidence
  review?: ProfileReview
  /** Version this draft was derived from, when the lineage is known. */
  basedOnVersion?: number
  createdAt: string
  activatedAt?: string
  retiredAt?: string
  /** Enables the automatic regression watch. Only set by the system loop. */
  autoActivated?: boolean
}

/**
 * Tunables of the self-evolution loop. The loop can propose changes to these
 * values, but every value is clamped in the main process, so a bad proposal
 * can never disable review or open an unbounded loop.
 */
export interface EvolutionPolicy {
  /** Apply a profile automatically when its independent review passes. */
  autoApply: boolean
  /** Completed runs required before a cycle may start. */
  minRuns: number
  /** Minimum reviewer score required for a pass. */
  reviewScore: number
  /** Runs since the last cycle before the automatic loop runs again. */
  cooldownRuns: number
  /** Recent runs shown to the optimizer and reviewer. */
  evidenceRuns: number
  /** Runs observed after an automatic activation before regression checks. */
  watchRuns: number
  /** Failure-rate increase (percentage points) that triggers auto-rollback. */
  regressionDelta: number
  /** Completed cycles between meta-evolution attempts. */
  metaEvery: number
  /** Extra optimizer guidance evolved by the loop itself. */
  focus: string
  updatedAt?: string
}

export interface EvolutionPolicyVersion {
  id: string
  version: number
  status: 'draft' | 'active' | 'retired'
  policy: EvolutionPolicy
  rationale: string
  evidence: ProfileEvidence
  review?: ProfileReview
  createdAt: string
  activatedAt?: string
  retiredAt?: string
}

export type EvolutionStageKey = 'evidence' | 'propose' | 'review' | 'apply' | 'watch'
export type EvolutionStageStatus = 'done' | 'skipped' | 'failed'

export interface EvolutionStage {
  key: EvolutionStageKey
  status: EvolutionStageStatus
  detail: string
  at: string
}

/**
 * One end-to-end pass of the system loop. Stages make the process readable to
 * users who never open the source or a transcript.
 */
export interface EvolutionCycle {
  id: string
  workspacePath: string
  trigger: 'manual' | 'auto' | 'meta' | 'watch'
  status: 'completed' | 'rejected' | 'failed'
  startedAt: string
  finishedAt: string
  stages: EvolutionStage[]
  profileId?: string
  profileVersion?: number
  score?: number
  activated: boolean
  summary: string
}

export interface EvolutionState {
  policy: EvolutionPolicy
  policyVersions: EvolutionPolicyVersion[]
  /** Recent cycles for the current workspace, newest first. */
  cycles: EvolutionCycle[]
}

export type QualityCandidateStatus =
  | 'recorded'
  | 'awaiting_user'
  | 'approved'
  | 'rejected'
  | 'publishing'
  | 'published'
  | 'failed'

/**
 * The only packaging commands the publish gate will ever run. A free-form
 * string would turn "授权后发布" into "an approved flag runs any command".
 */
export type QualityPublishTarget =
  | 'none'
  | 'package:dir'
  | 'package:win'
  | 'package:mac'
  | 'package:linux'

/** What the evaluation ran on, so a score can always be traced back. */
export interface QualityEvidence {
  runs: number
  failures: number
  /** `records` = run history, `learning` = learning ledger, `benchmark` = suite. */
  source: string
  samples: Partial<Record<string, number>>
}

/** One evaluated candidate version of the agent's own behaviour. */
export interface QualityCandidate {
  id: string
  workspacePath: string
  /** Monotonic per-workspace sequence number, shown in the bell. */
  version: number
  createdAt: string
  metricVersion: number
  score: QualityScore
  /** The score this candidate had to beat; null on a first measurement. */
  baseline: QualityScore | null
  comparison: QualityComparison
  /** Evaluation model's short written verdict; empty when it failed. */
  verdict: string
  evidence: QualityEvidence
  status: QualityCandidateStatus
  decidedAt?: string
  publishTarget?: string
  publishedAt?: string
  /** Bounded publish/decision log lines for the UI. */
  log: string[]
  failure?: string
}

export interface QualityState {  /** Weights are versioned: every tune bumps the version and records why. */
  metricSet: QualityMetricSet
  /** Score of the version currently in use; the bar a candidate must beat. */
  baseline: QualityScore | null
  candidates: QualityCandidate[]
}

/**
 * Phone-sized view of the desktop self-evolution panel. It carries only what
 * the phone needs to render status and decide which buttons are usable; full
 * transcripts, memory and run rows stay on the desktop.
 */
export interface EvolutionSnapshot {
  workspacePath: string
  workspaceName: string
  hasKey: boolean
  autoEvolve: boolean
  /** Long-running work started from the phone, so buttons can stay disabled. */
  busy: 'cycle' | 'policy' | null
  completedRuns: number
  failures: number
  avgSteps: number
  canRunCycle: boolean
  minRuns: number
  policy: EvolutionPolicy
  activePolicyVersion: EvolutionPolicyVersion | null
  canRollbackPolicy: boolean
  cycles: EvolutionCycle[]
  activeProfile: ProfileVersion | null
  profiles: ProfileVersion[]
  globalProfiles: ProfileVersion[]
  activeGlobalProfile: ProfileVersion | null
}

/** One file that differs between a user's personal source and the official base. */
export interface PersonalChangedFile {
  /** Path relative to the client source root, using forward slashes. */
  path: string
  status: 'added' | 'modified' | 'deleted'
  beforeSha256: string | null
  afterSha256: string | null
  size: number
  /** False when the file is binary; contributions still carry it as base64. */
  text: boolean
}

export interface PersonalVersion {
  id: string
  forkId: string
  name: string
  note: string
  /** Official version this fork started from. */
  baseVersion: string
  createdAt: string
  files: PersonalChangedFile[]
  /** Newest portable build produced from this source, when one was found. */
  buildPath?: string
  builtAt?: string
  /** Contribution bundles exported from this version. */
  contributionIds: string[]
}

export type PersonalContributionStatus = 'ready' | 'uploaded' | 'failed'

export interface PersonalContribution {
  id: string
  versionId: string
  forkId: string
  note: string
  createdAt: string
  status: PersonalContributionStatus
  /** Local contribution bundle. Always written before an upload is attempted. */
  path: string
  bytes: number
  sha256: string
  endpoint?: string
  error?: string
}

export type PersonalUpgradeConflictReason =
  | 'both-modified'
  | 'both-added'
  | 'deleted-by-you'
  | 'deleted-officially'
  | 'binary'
  | 'too-large'
  | 'already-conflicted'

export interface PersonalUpgradeConflict {
  path: string
  reason: PersonalUpgradeConflictReason
}

/** Shown in the panel; the detailed plan is computed only when requested. */
export interface PersonalUpgradeStatus {
  available: boolean
  fromVersion: string
  toVersion: string
  /**
   * True when the old official baseline was not captured before the update.
   * The personal source is still intact, but a three-way merge is impossible.
   */
  requiresManual: boolean
}

export interface PersonalUpgradePlan {
  available: boolean
  fromVersion: string
  toVersion: string
  requiresManual: boolean
  counts: { upstream: number; kept: number; merged: number; conflicts: number }
  conflicts: PersonalUpgradeConflict[]
  /** Relative path of the new official source copied into the workspace for manual migration. */
  officialCopyPath?: string
}

export type PersonalUpgradeValidation = 'pending' | 'passed' | 'failed' | 'skipped'

export interface PersonalUpgradeResult {
  id: string
  fromVersion: string
  toVersion: string
  /** Files written from the new official baseline or merged. */
  applied: number
  kept: number
  merged: number
  conflicts: PersonalUpgradeConflict[]
  /** Automatic backup of every personal file the merge touched. */
  backupPath: string
}

export interface PersonalUpgradeReport extends PersonalUpgradeResult {
  createdAt: string
  validation: PersonalUpgradeValidation
  validatedAt?: string
  /** Human-readable reason when validation failed or was skipped. */
  message?: string
  /** Tail of the failed command's output. */
  output?: string
}

/** Where the editable "self" source and its official baseline come from. */
export type SelfSourceMode = 'builtin' | 'custom'

export interface SelfSourceSettings {
  mode: SelfSourceMode
  /** Official remote for the built-in source. Empty means "not configured". */
  gitUrl: string
  /** Branch or tag of the official remote; `main` when unset. */
  gitRef: string
  /** Subdirectory inside the remote that holds this client (`pilot/pilot`). */
  gitPath: string
  /** Absolute path of the user's own checkout when mode is `custom`. */
  customPath: string
}

/** How the baseline tree was produced; shown verbatim in the panel. */
export type SourceBaseKind =
  | 'official-git'
  | 'custom-git'
  | 'installer-copy'
  | 'git-head'
  | 'none'

/**
 * Provenance of the baseline the evolution loop diffs against. `closed` means
 * the baseline is a real commit of the official remote and is current with it.
 */
export interface SourceProvenance {
  mode: SelfSourceMode
  sourcePath: string
  basePath: string
  baseKind: SourceBaseKind
  baseReadOnly: boolean
  gitUrl: string
  gitRef: string
  gitPath: string
  customPath: string
  /** Commit the baseline tree was extracted from. Empty when unknown. */
  revision: string
  committedAt: string
  summary: string
  /** Commits the baseline is behind the fetched remote tip; null when unknown. */
  behind: number | null
  fetchedAt: string
  gitAvailable: boolean
  /** True when the baseline is traceable to an official commit and current. */
  closed: boolean
  /** Why the loop is open (or how it closed), in Chinese, for the panel. */
  reason: string
  /** A hard failure such as "not a git repository" or a fetch error. */
  error?: string
}

export interface PersonalEvolutionState {
  forkId: string
  name: string
  createdAt: string
  baseVersion: string
  sourcePath: string
  basePath: string
  /** False until the embedded source has been copied / the workspace exists. */
  available: boolean
  /** True when the official source is a read-only copy inside the installer. */
  baseReadOnly: boolean
  /** Which source/commit the loop diffs against; absent on older records. */
  provenance?: SourceProvenance
  versions: PersonalVersion[]
  contributions: PersonalContribution[]
  /** Environment-provided upload endpoint; absent means export only. */
  uploadEndpoint?: string
  /** Whether the installed official version moved past the fork's baseline. */
  upgrade: PersonalUpgradeStatus
  /** Most recent merge that has not been rolled back, including its gate status. */
  lastUpgrade?: PersonalUpgradeReport
}

export interface PersonalVersionInput {
  name: string
  note?: string
}

/** Metadata included with each contribution so maintainers can judge it. */
export interface ContributionEvidence {
  policy?: EvolutionPolicy
  policyVersion?: number
  activeProfile?: string
  cycles?: string[]
}

export interface WorkspaceDetail {
  workspace: WorkspaceSummary
  memory: MemoryEntry[]
  profiles: ProfileVersion[]
  activeProfile: ProfileVersion | null
  /** Profiles that apply to every workspace, independent of this one. */
  globalProfiles: ProfileVersion[]
  activeGlobalProfile: ProfileVersion | null
  runs: RunRecord[]
  /** System-level loop state: policy, meta history and recent cycles. */
  evolution: EvolutionState
  /** Quality gate: tuned metric weights, current baseline and candidates. */
  quality: QualityState
}

export interface SettingsView {
  baseUrl: string
  model: string
  maxSteps: number
  /** Hard per-run token cap; 0 means no cap. */
  maxTokens: number
  maxContextTokens: number
  maxOutputTokens: number
  temperature: number
  autoReflect: boolean
  autoEvolve: boolean
  /** Auto-continue interrupted or failed runs, opt-in with a hard attempt cap. */
  autoContinue: boolean
  autoContinueLimit: number
  /** Feed screenshots back to the model as image observations. */
  screenshotFeedback: boolean
  /**
   * Hosts the agent may target with generated tools. Localhost is always
   * allowed; external targets must be listed here before a tool can run.
   */
  testTargets: string[]
  /** How generated test tools obtain a captcha value in an authorized test environment. */
  testCaptchaMode: TestCaptchaMode
  /** True when a test captcha fixture/header value is stored in safeStorage. */
  hasTestCaptcha: boolean
  /** Seconds before a pending approval auto-rejects; 0 disables the timeout. */
  approvalTimeoutSec: number
  /** Expose the run_shell tool. Unsandboxed calls still require approval. */
  shellMode: boolean
  /** Windows shell interpreter for run_shell; ignored on other platforms. */
  shellInterpreter: ShellInterpreter
  /** Human-readable result of shell detection, shown in Settings. */
  shellInterpreterDetail: string
  defaultApprovalMode: ApprovalMode
  /** Explicit deny > ask > allow rules, enforced by the harness. */
  permissionRules: PermissionRules
  /** Exact shell command lines the user chose to always allow. */
  trustedCommands: string[]
  /** Optional separate model for the auto-mode permission classifier. */
  classifierModel: string
  /** Separate model for review sessions; empty means the default model. */
  reviewModel: string
  sandboxMode: SandboxMode
  /** Block outbound network inside the sandbox when the backend supports it. */
  sandboxNetwork: boolean
  /** Auto-approve commands that run inside the OS sandbox. */
  sandboxAutoAllow: boolean
  /**
   * Let 全部自动 sessions build a personal experimental build without asking.
   * Off by default: that build turns editable source into a runnable program.
   * Only auto mode can use it; manual modes still ask.
   */
  allowUnattendedBuild: boolean
  /**
   * 自主探索学习：允许从白名单公开站点只读搜集资料、自选任务并把阶段成果记在本地账本。
   * 默认关；开启后也只允许 GET/HEAD，产物不出域。
   */
  learningMode: boolean
  /** 学习来源主机白名单（裸主机名，子域自动包含）；空表示用内置默认。 */
  learningHosts: string[]
  /**
   * 学习探索期间让 shell 沙箱断网。默认关：任务会话按 `sandboxNetwork` 联网，
   * 学习模式的白名单只约束 learning_research，不再波及任务会话。
   */
  learningShellIsolation: boolean
  /** 进化闭环的源码来源：内置源码（官方 git）或自定义路径。 */
  selfSourceMode: SelfSourceMode
  selfSourceGitUrl: string
  selfSourceGitRef: string
  selfSourceGitPath: string
  selfSourceCustomPath: string
  /**
   * 产出质量闸门：用配置的评估模型按可调优指标给候选版本打分，
   * 更优时在铃铛与桌面通知提醒；默认关。
   */
  qualityGate: boolean
  /** 授权后执行的打包命令；只接受内置白名单值。 */
  qualityPublishTarget: QualityPublishTarget
  /** 每评估几次重调一次指标权重；0 表示不自动调优。 */
  qualityTuneEvery: number
  /** Checkpoints kept per session. */
  checkpointRetention: number
  /** Total disk budget for all checkpoint snapshots, in bytes. */
  checkpointMaxBytes: number
  /** Snapshot the workspace before each run_shell call. */
  checkpointShell: boolean
  /**
   * Paths a snapshot skips, beyond the built-in ignore list. Generated output
   * (build caches, scratch directories) is expensive to hash and worthless to
   * restore, but it must stay visible in the file tree — so this list applies
   * to snapshots only.
   */
  checkpointIgnore: string[]
  /** Show a desktop notification when a run finishes or needs approval. */
  notifyDesktop: boolean
  /** Run workspace `.pilot/hooks.json` commands. Off by default. */
  hooksEnabled: boolean
  /** Connect stdio MCP servers from `.pilot/mcp.json`. Off by default. */
  mcpEnabled: boolean
  /** Self-hosted Pilot Link relay, e.g. `wss://relay.example.com/connector`. */
  relayUrl: string
  /** User-level PILOT.md loaded for every workspace. */
  globalInstructionsPath: string
  /** Saved preference; `system` follows the OS. */
  theme: ThemePreference
  /** Text size; `standard` keeps the original type scale. */
  fontSize: FontSizePreference
  /** Text/surface contrast; `standard` keeps the palette as designed. */
  contrast: ContrastPreference
  /** Accent and functional color saturation; `standard` keeps the palette. */
  saturation: SaturationPreference
  /** Accent palette; see `AccentPalette`. */
  accent: AccentPalette
  /** UI language: auto follows the OS, otherwise a pinned shipped locale. */
  locale: LocaleSetting
  /** The OS language as Electron reports it, for the "follow system" hint. */
  systemLocale: string
  hasKey: boolean
  keyHint: string
  /** Every configured endpoint. All model roles select from this list. */
  modelResources: ModelResource[]
  /** Resource used by ordinary sessions, analysis and tool calls. */
  sessionModelId: string
  /** Ordered evaluation panel; empty means the session model reviews itself. */
  evaluationModelIds: string[]
  /** Resource for review sessions; empty follows the session model. */
  reviewModelId: string
  /** Independent reviewer endpoints used by the self-evolution review step. */
  judgeProviders: JudgeProvider[]
}

export interface SettingsUpdate {
  baseUrl?: string
  model?: string
  maxSteps?: number
  /** Hard per-run token cap; 0 means no cap. */
  maxTokens?: number
  maxContextTokens?: number
  maxOutputTokens?: number
  temperature?: number
  autoReflect?: boolean
  autoEvolve?: boolean
  autoContinue?: boolean
  autoContinueLimit?: number
  screenshotFeedback?: boolean
  testTargets?: string[]
  testCaptchaMode?: TestCaptchaMode
  /** New test captcha value; empty string keeps it, null clears it. */
  testCaptcha?: string | null
  approvalTimeoutSec?: number
  shellMode?: boolean
  shellInterpreter?: ShellInterpreter
  defaultApprovalMode?: ApprovalMode
  permissionRules?: PermissionRules
  trustedCommands?: string[]
  classifierModel?: string
  /** Empty string keeps review sessions on the default model. */
  reviewModel?: string
  sandboxMode?: SandboxMode
  sandboxNetwork?: boolean
  sandboxAutoAllow?: boolean
  allowUnattendedBuild?: boolean
  learningMode?: boolean
  learningHosts?: string[]
  learningShellIsolation?: boolean
  selfSourceMode?: SelfSourceMode
  selfSourceGitUrl?: string
  selfSourceGitRef?: string
  selfSourceGitPath?: string
  selfSourceCustomPath?: string
  qualityGate?: boolean
  qualityPublishTarget?: QualityPublishTarget
  qualityTuneEvery?: number
  checkpointRetention?: number
  checkpointMaxBytes?: number
  checkpointShell?: boolean
  /** Patterns a snapshot skips; an empty array restores the built-in list only. */
  checkpointIgnore?: string[]
  notifyDesktop?: boolean
  hooksEnabled?: boolean
  mcpEnabled?: boolean
  /** Empty string disables the cloud path and keeps LAN-only pairing. */
  relayUrl?: string
  theme?: ThemePreference
  fontSize?: FontSizePreference
  contrast?: ContrastPreference
  saturation?: SaturationPreference
  accent?: AccentPalette
  /** UI language preference; `auto` follows the OS. */
  locale?: LocaleSetting
  /** A new key for the session resource. Empty keeps it; null clears it. */
  apiKey?: string | null
  /** Unified model endpoints; a missing id creates one, the list order is kept. */
  modelResources?: ModelResourceInput[]
  /** Resource used by ordinary sessions; must exist when provided. */
  sessionModelId?: string
  /** Ordered evaluation panel; unknown ids are rejected. Empty means self-review. */
  evaluationModelIds?: string[]
  /** Review-session resource; empty string follows the session model. */
  reviewModelId?: string
  /** Legacy reviewer endpoints, still accepted and migrated to model resources. */
  judgeProviders?: JudgeProviderInput[]
}

export interface BootstrapData {
  settings: SettingsView
  workspaces: WorkspaceSummary[]
  sessions: SessionSummary[]
  activeWorkspace: string | null
  activeSession: string | null
  version: string
  platform: string
}
export interface ConnectionTestResult {
  ok: boolean
  message: string
  models?: string[]
}

/** One currency row returned by the provider's balance endpoint. */
export interface ModelBalanceEntry {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

/** Why the provider balance could not be read. Translated by the UI. */
export type ModelBalanceError =
  | 'missing-key'
  | 'unauthorized'
  | 'unsupported'
  | 'network'
  | 'invalid-response'
  | 'error'

export interface ModelBalanceState {
  /** False when the balance request itself failed (no key, network, 401…). */
  ok: boolean
  /** Provider's own"can still serve requests"flag; meaningless when ok=false. */
  available: boolean
  entries: ModelBalanceEntry[]
  /** The provider endpoint that answered, for traceability. */
  source: string
  fetchedAt: string
  error?: ModelBalanceError
  /** Raw provider text (never contains the key) for troubleshooting. */
  errorDetail?: string
}

/** Token totals for one model, plus the cost estimate when prices are known. */
export interface ModelUsageRow {
  model: string
  runs: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  /** Provisional: standard (peak) list price, USD. Null when unpriced. */
  estimatedCostUsd: number | null
}

export interface ModelUsageSummary {
  rows: ModelUsageRow[]
  runs: number
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  estimatedCostUsd: number | null
  /** Models without a price entry are excluded from the cost estimate. */
  unpricedModels: string[]
}

/** One configured model endpoint and the provider balance it reports. */
export interface ModelBillingAccount {
  /** `primary` for the execution model, otherwise the reviewer provider id. */
  id: string
  /** Reviewer label; empty for the primary model. */
  label: string
  role: 'primary' | 'judge'
  baseUrl: string
  model: string
  /** False when a saved reviewer is disabled but still kept on file. */
  enabled: boolean
  balance: ModelBalanceState
}

export interface ModelBillingReport {
  hasKey: boolean
  baseUrl: string
  model: string
  balance: ModelBalanceState
  usage: ModelUsageSummary
  /** Every configured model, including disabled reviewers. */
  accounts?: ModelBillingAccount[]
  /** Where the price table came from, so the UI can label the estimate. */
  priceSource: string
  checkedAt: string
}

export interface CompanionPhone {
  phoneId: string
  name: string
  platform: string
  online: boolean
  pairedAt: string
  lastSeen: string | null
}

export interface CompanionStatus {
  enabled: boolean
  running: boolean
  address: string | null
  port: number | null
  deviceId: string
  deviceName: string
  phones: CompanionPhone[]
  pairingActive: boolean
  pairingExpiresAt: string | null
  /** A phone that scanned the QR code and is waiting for the desktop to confirm. */
  pairingRequest: CompanionPairRequest | null
  /** Public PWA URL shown in the app-download QR code. */
  appUrl: string | null
  /** Cloud connector endpoint, without any admission code. Null when LAN-only. */
  relayUrl: string | null
  /**
   * True when the stored connection string carries an L1 admission code
   * (`#k=`). The code itself is never sent to the renderer.
   */
  relayAccess: boolean
  /** Where the active relay address came from. */
  relaySource: 'env' | 'settings' | 'none'
  /** Paired phones whose link goes through the cloud relay. */
  cloudPhones: number
  /** Most recent cloud endpoint recorded from a paired phone, for restore. */
  lastRelayUrl: string | null
  /** True while at least one outbound host channel is registered. */
  relayConnected: boolean
  relayError: string | null
  error: string | null
}

export interface CompanionPairing {
  url: string
  qrDataUrl: string
  address: string
  expiresAt: string
  mode: 'cloud' | 'lan'
}

/**
 * One phone asking to pair. The desktop user must answer before the phone gets
 * a token, so a QR code photographed or shared on screen is not enough.
 */
export interface CompanionPairRequest {
  requestId: string
  /** Identifier the phone chose for itself; not trusted, only displayed. */
  phoneId: string
  /** Self-reported device name and platform, shown to the user verbatim. */
  name: string
  platform: string
  /** LAN address of the phone when it connected directly. */
  address: string | null
  /** Whether the phone reached the desktop directly or through the relay. */
  via: 'lan' | 'relay'
  requestedAt: string
  /** The request is dropped at this time unless the user answered. */
  expiresAt: string
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
}

export interface FilePreview {
  path: string
  size: number
  content: string
  language: string
  truncated: boolean
  /** How the renderer should present the file. */
  kind: PreviewKind
  /** `pilot-media://` address for media and web pages; absent for text. */
  url?: string
  /**
   * Base folder of an HTML page, already encoded as a `pilot-media://` URL, so
   * the sandboxed frame and the markdown body resolve relative assets.
   */
  baseUrl?: string
}

export interface DocumentWindowState {
  /** Stored preference; `system` still has to be resolved against the OS. */
  theme: ThemePreference
  accent: AccentPalette
  contrast: ContrastPreference
  saturation: SaturationPreference
  fontSize: FontSizePreference
  /** Concrete locale tag, already resolved by the main process. */
  locale: AppLocale
  version: string
  platform: string
}

export interface ApprovalRequest {
  callId: string
  runId: string
  sessionId: string
  tool: string
  risk: ToolRisk
  arguments: Record<string, unknown>
  /** Why the harness asked instead of auto-approving. */
  reason?: string
  /** The permission rule that matched, when one did. */
  rule?: string
  /** Absent when the approval timeout is disabled. */
  expiresAt?: string
}

export type RunEvent =
  | {
      type: 'run.started'
      sessionId: string
      runId: string
      profileVersion: number | null
      mode: ApprovalMode
    }
  | { type: 'step.started'; sessionId: string; runId: string; step: number }
  | { type: 'message.started'; sessionId: string; runId: string }
  | { type: 'message.delta'; sessionId: string; runId: string; text: string }
  | { type: 'reasoning.delta'; sessionId: string; runId: string; text: string }
  | { type: 'tool.call'; sessionId: string; runId: string; call: ToolCall; risk: ToolRisk }
  | {
      type: 'tool.approval_required'
      sessionId: string
      runId: string
      call: ToolCall
      risk: ToolRisk
      reason?: string
      rule?: string
      expiresAt?: string
    }
  | {
      type: 'tool.approval_resolved'
      sessionId: string
      runId: string
      callId: string
      approved: boolean
      reason?: string
      /** 工具名与风险等级，由运行器从 `tool.call` 补齐，供审计日志使用。 */
      name?: string
      risk?: ToolRisk
      decidedBy?: ApprovalDecidedBy
    }
  | {
      type: 'tool.result'
      sessionId: string
      runId: string
      callId: string
      name: string
      result: ToolResult
    }
  | {
      type: 'context.compacted'
      sessionId: string
      runId: string
      droppedMessages: number
      compactedResults: number
      estimatedTokens: number
    }
  | {
      type: 'run.completed'
      sessionId: string
      runId: string
      status: 'completed' | 'paused' | 'cancelled' | 'max_steps' | 'token_limit'
      steps: number
      usage: AgentUsage
      durationMs: number
    }
  | {
      type: 'run.failed'
      sessionId: string
      runId: string
      code: string
      message: string
    }
  | { type: 'queue.changed'; sessionId: string; queue: QueuedTask[] }
  | { type: 'todos.changed'; sessionId: string; todos: TodoItem[] }
  | { type: 'scheduled.changed'; sessionId: string }
  | { type: 'session.changed'; sessionId: string; plan?: Plan | null }
  | { type: 'memory.changed'; workspacePath: string }
  /** 手机端新建了工作区，电脑端侧栏需要刷新工作区列表。 */
  | { type: 'workspace.changed'; workspacePath: string }
  | { type: 'profile.changed'; workspacePath: string }
  /** A system-evolution cycle or the evolution policy itself changed. */
  | { type: 'evolution.changed'; workspacePath: string }
  /**
   * The quality gate produced a candidate, or one was approved/rejected/
   * published. `bell` is true only for the events the user must look at, so a
   * routine re-measurement does not raise a notification.
   */
  | {
      type: 'quality.changed'
      workspacePath: string
      candidateId?: string
      status?: QualityCandidateStatus
      /** Short human line for the bell and the desktop notification. */
      message?: string
      bell?: boolean
    }
  /** Settings changed on the phone; the desktop window should adopt them. */
  | { type: 'settings.changed'; settings: SettingsView }
  /** A generated workspace/global tool was registered, enabled or removed. */
  | { type: 'tools.changed'; workspacePath: string }
  /** An external plugin was installed, enabled, signed or removed. */
  | { type: 'plugins.changed'; workspacePath: string }
  | { type: 'companion.changed'; status: CompanionStatus }
  /** A phone scanned the QR code; the desktop must approve or reject it. */
  | { type: 'companion.pair_request'; request: CompanionPairRequest }
  /** The pairing request was answered, timed out or withdrawn. */
  | { type: 'companion.pair_resolved'; requestId: string; approved: boolean; reason?: string }
  /** Desktop in-app update progress, mirrored to paired phones. */
  | { type: 'update.changed'; state: UpdateState }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }

export interface SendMessageResult {
  queued: boolean
}

export interface ReviewProfileResult {
  profile: ProfileVersion
  activated: boolean
}

/** `off` only warns, `warn` shows a badge, `required` refuses untrusted plugins. */
export type PluginSignaturePolicy = 'off' | 'warn' | 'required'

/**
 * - `unsigned`  no `plugin.sig` next to the manifest
 * - `trusted`   signed by a key this workspace trusts, files unchanged since
 * - `untrusted` signed, but the signing key is not in `trusted-keys.json`
 * - `tampered`  signed by a trusted key, but the files changed afterwards
 * - `malformed` the signature file itself is unreadable
 */
export type PluginSignatureState =
  | 'unsigned'
  | 'trusted'
  | 'untrusted'
  | 'tampered'
  | 'malformed'

export type PluginTemplateId = 'http' | 'session' | 'webhook'

export type PluginMarketCategory = 'business' | 'data' | 'identity' | 'ops'

export interface PluginSignatureView {
  state: PluginSignatureState
  policy: PluginSignaturePolicy
  /** Digest of the manifest plus entry as they are on disk right now. */
  digest: string
  keyId: string | null
  label: string | null
  detail: string
}

export interface PluginRouteView {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  auth: 'public' | 'required'
  permission: string | null
  description: string
}

/** One plugin as it exists in the workspace, valid or not. */
export interface PluginRecordView {
  id: string
  name: string
  version: number
  description: string
  /** Absolute directory the plugin was loaded from. */
  dir: string
  entry: string
  permissions: string[]
  roles: { id: string; permissions: string[] }[]
  routes: PluginRouteView[]
  providesSession: boolean
  /** Explicit user approval to run this plugin (`grants.json`). */
  enabled: boolean
  /** Subset of `permissions` the user granted. */
  granted: string[]
  signature: PluginSignatureView | null
  /** Manifest validation error; when set the plugin cannot be enabled. */
  error: string | null
}

/** A curated market entry bundled with the app. */
export interface PluginMarketItem {
  id: string
  name: string
  summary: string
  category: PluginMarketCategory
  publisher: string
  version: number
  permissions: string[]
  template: PluginTemplateId
  routeCount: number
  installed: boolean
}

export interface PluginTrustedKeyView {
  keyId: string
  label: string
  addedAt: string
  publicKey: string
  /** Installed plugins currently signed by this key. */
  pluginIds: string[]
}

export interface PluginTemplateView {
  id: PluginTemplateId
  name: string
  summary: string
  permissions: string[]
  providesSession: boolean
  routeCount: number
}

export interface PluginOverview {
  workspace: string
  /** Absolute `<workspace>/.pilot/plugins`. */
  pluginsDir: string
  plugins: PluginRecordView[]
  /** Directories whose `plugin.json` failed validation. */
  invalid: { id: string; error: string }[]
  market: PluginMarketItem[]
  trustedKeys: PluginTrustedKeyView[]
  policy: PluginSignaturePolicy
  templates: PluginTemplateView[]
  maxPlugins: number
}

export interface PluginCreateInput {
  /** Directory the user picked; must be empty or not exist yet. */
  targetDir: string
  id: string
  name: string
  description: string
  template: PluginTemplateId
  /** Sign with a fresh key pair stored in `<targetDir>/.keys`. */
  sign: boolean
}

export interface PluginCreateResult {
  dir: string
  id: string
  /** Files written, relative to `dir`. */
  files: string[]
  signed: boolean
  keyId: string | null
  /** Vendor public key, so the user can paste it into another workspace. */
  publicKey: string | null
  privateKeyFile: string | null
  publicKeyFile: string | null
  signature: PluginSignatureView | null
}

export interface PluginInstallInput {
  sourceDir: string
  /** Add the signer's public key to this workspace's trust store. */
  trust?: boolean
  /** Public key pasted by the user when the folder carries no `.keys/`. */
  publicKey?: string
  /** Replace an already installed plugin with the same id. */
  force?: boolean
  label?: string
}

export interface PluginInstallResult {
  id: string
  /** Where the plugin was copied to. */
  dir: string
  signature: PluginSignatureView
  trustedKey: PluginTrustedKeyView | null
}

export interface PilotBridge {
  bootstrap(): Promise<BootstrapData>
  /**
   * 内视：检查 Pilot 自己的功能模块（模型、审批、沙箱、工具、MCP、插件、
   * 存储、任务、反馈、更新）。不接收工作区路径。
   */
  selfCheck(): Promise<import('./self-check').SelfCheckReport>
  updateSettings(input: SettingsUpdate): Promise<SettingsView>
  testConnection(input?: {
    apiKey?: string
    baseUrl?: string
    model?: string
    /** Use the stored key/endpoint of this judge provider. */
    providerId?: string
  }): Promise<ConnectionTestResult>
  /** Provider balance for the saved key plus local token usage and cost estimate. */
  modelBilling(refresh?: boolean): Promise<ModelBillingReport>
  /** Provider balance for one self-evolution reviewer. */
  judgeBalance(input: JudgeBalanceInput): Promise<ModelBalanceState>
  setTheme(theme: ThemePreference): Promise<void>

  /**
   * Paint a candidate appearance in the window chrome while Settings previews
   * it; `null` restores the saved values. Nothing is persisted.
   */
  previewTheme(
    input: {
      theme: ThemePreference
      accent: AccentPalette
      contrast: ContrastPreference
      saturation: SaturationPreference
    } | null,
  ): Promise<void>

  /** Store one problem report, feature request or suggestion. */
  submitFeedback(input: FeedbackDraft): Promise<FeedbackRecord>
  /** `workspacePath` only selects which volume is reported; nothing identifying is read. */
  submitFeedback(input: FeedbackDraft, workspacePath?: string): Promise<FeedbackRecord>
  /** Open the folder that keeps every saved report. */
  openFeedbackFolder(): Promise<void>

  companionStatus(): Promise<CompanionStatus>
  setCompanionEnabled(enabled: boolean): Promise<CompanionStatus>
  setCompanionRelay(url: string): Promise<CompanionStatus>
  createCompanionPairing(): Promise<CompanionPairing>
  /** Answer a pending phone request; false when it already timed out. */
  companionPairDecision(requestId: string, approved: boolean): Promise<boolean>
  revokeCompanion(phoneId: string): Promise<CompanionStatus>
  companionLocalUrl(): Promise<string>
  companionAppQr(): Promise<{ url: string; qrDataUrl: string }>
  /** 手机端可以在这些目录下新建工作区。 */
  companionRoots(): Promise<string[]>
  addCompanionRoot(path: string): Promise<string[]>
  removeCompanionRoot(path: string): Promise<string[]>

  pickFolder(title?: string): Promise<string | null>
  openWorkspace(path: string): Promise<{ workspace: WorkspaceSummary; sessions: SessionSummary[] }>
  removeWorkspace(path: string): Promise<void>
  /** 给单个任务指定会话模型；空串清除，回到全局设置。 */
  setSessionModel(sessionId: string, modelId: string): Promise<SessionSummary>
  openWorkspaceFolder(path: string): Promise<void>
  /** Resolve (and on first use copy) a workspace holding Pilot's own source. */
  prepareSelfSource(): Promise<SelfSourceResult>

  listSessions(workspacePath: string): Promise<SessionSummary[]>
  getSession(sessionId: string): Promise<Session | null>
  getSessionPage(sessionId: string, before?: string, limit?: number): Promise<SessionPage | null>
  getSessionAround(
    sessionId: string,
    messageId: string,
    limit?: number,
  ): Promise<SessionPage | null>
  getSessionTranscript(sessionId: string): Promise<string>
  /** Copy text through the main process (works without renderer permissions). */
  writeClipboard(text: string): Promise<boolean>
  searchMessages(
    query: string,
    limit?: number,
    filter?: MessageSearchFilter,
  ): Promise<MessageSearchHit[]>
  /** Session knowledge base: instruction→reply pairs, newest first page. */
  knowledgePairs(
    sessionId: string,
    query?: string,
    limit?: number,
  ): Promise<KnowledgePairsResult>
  createSession(workspacePath: string): Promise<Session>
  /** Create a read-only review session over explicit roots and session scope. */
  createReviewSession(input: ReviewSessionInput): Promise<Session>
  /** Turn a recorded review report into a normal coding/fix session. */
  handoffReview(sessionId: string): Promise<Session>
  /** 模块自检：当前设置、最近报告与历史。 */
  moduleCheckState(): Promise<ModuleCheckState>
  /** 列出当前工作区里可勾选的自检模块。 */
  moduleCheckDiscover(): Promise<ModuleTarget[]>
  /** 立即对选中模块跑一次自检；不传则扫描全部模块。 */
  moduleCheckRun(moduleIds?: string[]): Promise<ModuleCheckReport>
  moduleCheckSettings(input: Partial<ModuleCheckSettings>): Promise<ModuleCheckState>
  /**
   * 用户审核后确认：勾选的风险点会变成一条**改造提案**。
   *
   * `selfModify` 必须由用户显式勾选；不传（或为 false）时只落提案、不建会话、
   * 不改任何文件。只有 `selfModify: true` 才会创建编码会话改自身源码，
   * 会话结束后自动重跑自检刷新提案。
   */
  moduleCheckAccept(input: {
    reportId: string
    riskIds: string[]
    selfModify?: boolean
  }): Promise<{
    sessionId?: string
    prompt: string
    queued: boolean
    selfModify: boolean
    proposalId: string
  }>
  deleteSession(sessionId: string): Promise<void>
  updateSession(
    sessionId: string,
    input: { title?: string; approvalMode?: ApprovalMode },
  ): Promise<SessionSummary>

  sendMessage(
    sessionId: string,
    content: string,
    delivery: MessageDelivery,
    options?: MessageOptions,
  ): Promise<SendMessageResult>
  pickImages(): Promise<string[]>
  /** Copy files picked on this computer into the workspace, newest last. */
  pickFiles(workspacePath: string): Promise<WorkspaceUploadFile[]>
  /**
   * 拖拽或粘贴上传：有磁盘路径的只传路径，没有路径的传字节，
   * 两者都会落在工作区的 uploads/ 目录。
   */
  uploadFiles(workspacePath: string, input: UploadBatch): Promise<WorkspaceUploadFile[]>
  /** 把剪贴板里的一张图片压成可以随消息发送的 data URL。 */
  pasteImage(input: { name?: string; data: ArrayBuffer }): Promise<string>
  /** 问 Chromium 要拖拽/粘贴来的 File 的真实磁盘路径；虚拟文件返回空串。 */
  pathForFile(file: unknown): string
  cancelRun(sessionId: string): Promise<void>
  pauseRun(sessionId: string): Promise<void>
  continueRun(sessionId: string): Promise<SendMessageResult>
  removeQueueItem(sessionId: string, taskId: string): Promise<void>
  insertQueueItem(sessionId: string, taskId: string): Promise<void>
  updateQueueItem(sessionId: string, taskId: string, content: string): Promise<void>
  convertQueueItemToTodo(sessionId: string, taskId: string): Promise<TodoItem | null>
  decideApproval(
    callId: string,
    approved: boolean,
    reason?: string,
    remember?: boolean,
  ): Promise<void>

  /** Edit an earlier user message and regenerate everything after it. */
  editMessage(sessionId: string, messageId: string, content: string): Promise<void>
  /** Delete a final user instruction that has not received a reply yet. */
  deleteMessage(sessionId: string, messageId: string): Promise<void>
  /** Drop the last answer and run the same user message again. */
  regenerate(sessionId: string): Promise<void>
  /** Retry a failed or interrupted run from its last user message. */
  retryRun(sessionId: string): Promise<void>

  projectInstructions(workspacePath: string): Promise<ProjectInstructionFile[]>

  reviewSessionChanges(sessionId: string): Promise<SessionChange[]>
  revertSessionFile(sessionId: string, path: string): Promise<RevertChangeResult>

  forkSession(sessionId: string): Promise<Session>
  getSessionArtifacts(sessionId: string): Promise<SessionArtifact[]>

  sandboxStatus(): Promise<SandboxStatus>
  /** Host environment facts; `workspacePath` only selects which volume is measured. */
  systemInfo(workspacePath?: string): Promise<SystemInfo>
  /**
   * 应用日志（已脱敏的元数据记录，不含正文）。`limit` 为最近条数，上限 2000。
   * 日志目录不可读时返回空数组，不抛错。
   */
  recentLogs(limit?: number): Promise<AppLogView[]>
  /** 当前日志目录的绝对路径；日志还没初始化时返回空字符串。 */
  logDir(): Promise<string>
  /** 在文件管理器里打开日志目录。 */
  openLogs(): Promise<void>
  /** 渲染进程未捕获异常转发给主进程写日志。 */
  reportRendererError(input: { summary: string; stack?: string; source?: string }): Promise<void>
  listCheckpoints(sessionId: string): Promise<Checkpoint[]>
  createCheckpoint(sessionId: string, label?: string): Promise<Checkpoint>
  restoreCheckpoint(
    sessionId: string,
    checkpointId: string,
    mode: CheckpointRestoreMode,
  ): Promise<CheckpointRestoreResult>

  /** `null` means the built-in quick prompts have never been customized. */
  quickCommands(): Promise<QuickCommand[] | null>
  saveQuickCommands(items: QuickCommandInput[]): Promise<QuickCommand[]>

  listScheduledTasks(sessionId: string): Promise<ScheduledTask[]>
  addScheduledTask(sessionId: string, input: ScheduledTaskInput): Promise<ScheduledTask>
  updateScheduledTask(
    sessionId: string,
    taskId: string,
    input: Partial<ScheduledTaskInput> & { enabled?: boolean },
  ): Promise<ScheduledTask>
  removeScheduledTask(sessionId: string, taskId: string): Promise<void>
  /** Turn a pending todo into a scheduled task and remove the todo. */
  convertTodoToSchedule(
    sessionId: string,
    todoId: string,
    input: ScheduledTaskInput,
  ): Promise<ScheduledTask>
  /** Move a scheduled task back into the session's todo list. */
  convertScheduledTaskToTodo(sessionId: string, taskId: string): Promise<TodoItem>

  listTodos(sessionId: string): Promise<TodoItem[]>
  addTodo(sessionId: string, text: string, clientId?: string): Promise<TodoItem>
  updateTodo(sessionId: string, todoId: string, text: string): Promise<TodoItem>
  removeTodo(sessionId: string, todoId: string): Promise<void>
  clearSentTodos(sessionId: string): Promise<void>
  sendTodo(sessionId: string, todoId: string): Promise<SendMessageResult & { todo: TodoItem }>
  sendAllTodos(sessionId: string): Promise<{ sent: number; failed: number }>

  getWorkspaceDetail(path: string): Promise<WorkspaceDetail>
  addMemory(path: string, content: string): Promise<MemoryEntry>
  deleteMemory(path: string, memoryId: string): Promise<void>
  setFeedback(
    sessionId: string,
    runId: string,
    rating: 'up' | 'down',
    note?: string,
  ): Promise<void>
  reflectRun(sessionId: string, runId: string): Promise<MemoryEntry[]>

  proposeEvolution(path: string): Promise<ProfileVersion>
  /** Run the full propose → review → apply loop once. */
  runSystemEvolution(path: string): Promise<EvolutionCycle>
  /** Ask the loop to improve its own policy (thresholds, cadence, focus). */
  improveEvolutionFlow(): Promise<EvolutionPolicyVersion | null>
  rollbackEvolutionPolicy(): Promise<EvolutionPolicyVersion | null>
  reviewProfile(path: string, profileId: string): Promise<ReviewProfileResult>
  /** Replay the fixed benchmark under the active and the candidate profile. */
  benchmarkProfile(path: string, profileId: string): Promise<ProfileBenchmarkReport>
  activateProfile(path: string, profileId: string, force?: boolean): Promise<ProfileVersion>
  rollbackProfile(path: string): Promise<ProfileVersion | null>
  deleteProfile(path: string, profileId: string): Promise<void>

  /** Generalize a workspace profile into a global candidate. */
  promoteProfile(path: string, profileId: string): Promise<ProfileVersion>
  /**
   * Create a Simplified-Chinese draft copy of a workspace or global profile.
   * The active version is left untouched; the copy must be reviewed again.
   */
  localizeProfile(
    scope: 'workspace' | 'global',
    path: string,
    profileId: string,
  ): Promise<ProfileVersion>
  /**
   * Write or rewrite the plain-language explanation of a draft, so a user who
   * does not read rules or scores can still decide whether to enable it.
   */
  explainProfile(
    scope: 'workspace' | 'global',
    path: string,
    profileId: string,
  ): Promise<ProfileVersion>
  /** Compare the global candidate against the global version in use. */
  benchmarkGlobalProfile(profileId: string): Promise<ProfileBenchmarkReport>
  reviewGlobalProfile(profileId: string): Promise<ReviewProfileResult>
  activateGlobalProfile(profileId: string, force?: boolean): Promise<ProfileVersion>
  rollbackGlobalProfile(): Promise<ProfileVersion | null>
  deleteGlobalProfile(profileId: string): Promise<void>
  /** Create the user-level PILOT.md when missing, then open it. */
  openGlobalInstructions(): Promise<string>

  /** Generated tools for this workspace, including promoted global tools. */
  listTools(path: string): Promise<DynamicToolInfo[]>
  setToolEnabled(
    path: string,
    source: DynamicToolSource,
    name: string,
    enabled: boolean,
  ): Promise<DynamicToolInfo[]>
  removeTool(path: string, source: DynamicToolSource, name: string): Promise<DynamicToolInfo[]>
  /** Copy a workspace tool into userData so every workspace can use it. */
  promoteTool(path: string, name: string): Promise<DynamicToolInfo[]>

  /** Plugin market and plugin assistant (external `.pilot/plugins`). */
  plugins: {
    overview(workspace: string): Promise<PluginOverview>
    /** Write a scaffolded plugin into a directory the user picked. */
    create(input: PluginCreateInput): Promise<PluginCreateResult>
    install(workspace: string, input: PluginInstallInput): Promise<PluginInstallResult>
    installMarket(workspace: string, id: string): Promise<PluginInstallResult>
    remove(workspace: string, id: string): Promise<PluginOverview>
    setEnabled(workspace: string, id: string, enabled: boolean): Promise<PluginOverview>
    sign(workspace: string, id: string): Promise<PluginSignatureView>
    trust(workspace: string, publicKey: string, label?: string): Promise<PluginOverview>
    untrust(workspace: string, keyId: string): Promise<PluginOverview>
    setPolicy(workspace: string, policy: PluginSignaturePolicy): Promise<PluginOverview>
    /** Native folder picker used by the plugin assistant and the importer. */
    pickDir(title?: string): Promise<string | null>
    /** Show a plugin directory in the OS file manager. */
    reveal(dir: string): Promise<void>
  }

  /** Personal fork: the user's own editable version of Pilot. */
  personalEvolution(): Promise<PersonalEvolutionState>
  /** 进化闭环的源码来源：状态、配置、同步官方基线、选择目录。 */
  selfSource: {
    status(): Promise<SourceProvenance>
    configure(input: SelfSourceSettings): Promise<SourceProvenance>
    sync(): Promise<SourceProvenance>
    pick(): Promise<string | null>
  }
  savePersonalVersion(input: PersonalVersionInput): Promise<PersonalVersion>
  /** Write the saved snapshot back into the personal source workspace. */
  restorePersonalVersion(versionId: string): Promise<void>
  /** Export a contribution bundle and upload it when an endpoint is configured. */
  submitPersonalVersion(
    versionId: string,
    note: string,
    evidence?: ContributionEvidence,
  ): Promise<PersonalContribution>
  revealPersonalContribution(contributionId: string): Promise<void>
  /** Dry-run a three-way merge of the new official baseline into the personal source. */
  preparePersonalUpgrade(): Promise<PersonalUpgradePlan>
  /** Apply the clean parts of the merge; conflicts remain marked in the source. */
  applyPersonalUpgrade(): Promise<PersonalUpgradeResult>
  /** Run typecheck and tests on the merged source; textual merges alone are not trusted. */
  validatePersonalUpgrade(): Promise<PersonalUpgradeReport>
  /** Restore the backup taken immediately before the last merge. */
  rollbackPersonalUpgrade(): Promise<void>

  /**
   * Quality gate. `evaluate` scores the current state with the configured
   * evaluation model and records a candidate; nothing is published until the
   * user decides.
   */
  qualityEvaluate(path: string): Promise<QualityState>
  qualityDecide(
    path: string,
    candidateId: string,
    decision: 'approve' | 'reject',
  ): Promise<QualityState>
  /** Package and publish an approved candidate with the configured script. */
  qualityPublish(path: string, candidateId: string): Promise<QualityState>
  /** Re-tune metric weights now instead of waiting for the automatic pass. */
  qualityTune(path: string): Promise<QualityState>

  listFiles(path: string, directory: string): Promise<FileNode[]>
  previewFile(path: string, file: string): Promise<FilePreview>
  revealFile(path: string, file: string): Promise<void>
  /**
   * Open one workspace file in a standalone window, so reading a long report
   * never competes with the transcript (or pauses a running task).
   */
  openDocument(workspace: string, file: string): Promise<void>
  /** Palette a standalone document window paints itself with. */
  documentState(): Promise<DocumentWindowState>
  closeDocument(): Promise<void>
  /**
   * Open a link: web pages render in an in-app preview window, media files
   * play in the same window, `external: true` hands it to the system browser.
   */
  openLink(url: string, external?: boolean): Promise<void>

  updates: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
    onState(listener: (state: UpdateState) => void): () => void
  }

  onEvent(listener: (event: RunEvent) => void): () => void
  /** Fired when the user clicks a desktop notification. */
  onFocusSession(listener: (sessionId: string) => void): () => void
  /** Fired when a quality notification is clicked: open the bell for this workspace. */
  onFocusQuality(listener: (workspacePath: string) => void): () => void
}
