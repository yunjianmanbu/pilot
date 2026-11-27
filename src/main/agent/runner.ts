import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import type {
  AgentMessage,
  AgentToolDefinition,
  ApprovalMode,
  ApprovalRequest as SharedApprovalRequest,
  CheckpointTrigger,
  MessageOptions,
  Plan,
  ProfileExplanation,
  ReviewRoot,
  RunEvent,
  RunRecord,
  RunStatus,
  Session,
  SettingsView,
  StoredMessage,
  TodoItem,
  ToolCall,
  ToolResult,
} from '../../shared/types'
import type { CheckpointService } from '../checkpoints'
import {
  loadGlobalInstructions,
  loadProjectInstructions,
  loadProjectInstructionsDetailed,
  type InstructionIssues,
} from '../instructions'
import type { Store } from '../store'
import { sandboxStatus } from '../sandbox'
import {
  autonomyAuditKind,
  autonomyPolicy,
  extraWritableRoots,
  type AutonomyAuditKind,
  type AutonomyPolicy,
} from '../../shared/autonomy'
import { autonomyAuditEntry } from '../app-audit'
import { writeAppLog } from '../app-state'
import { shellInterpreterLabel } from '../shell'
import { listDirectoryTree, resolveExisting } from '../workspace'
import { sanitizeImages, sanitizeReferences } from './attachments'
import { detectCheckCommands } from './checks'
import { createDeltaCoalescer, type DeltaCoalescer } from './delta-buffer'
import {
  CLASSIFIER_TRANSCRIPT_WINDOW,
  classifyToolCall,
  createClassifierMemo,
} from './classifier'
import { collapseCompletedTurns, estimateTokens, summaryMessageContent, truncateMiddle } from './context'
import { EvolutionService, formatToolFailures, type ProfileJudge } from './evolution'
import { QualityService } from './quality'
import { HookService } from './hooks'
import { extractContinueDirective } from './hook-rules'
import { effectiveContextTokens, subagentContextTokens } from '../../shared/modelLimits'
import { planStepBudget } from '../../shared/step-budget'
import { McpService, saveMcpServer } from './mcp'
import { runExploreSubagent } from './explore'
import { runAgentLoop, type ApprovalRequest, type LoopEvent, type ToolPolicyResult } from './loop'
import { SkillsService, writeSkill } from './skills'
import { runSubagent } from './subagent'
import { summarizeConversation } from './summarize'
import { DeepSeekClient, isFatalProviderError } from './model'
import { FAILURE_ACTION_TEXT, failureAction } from '../../shared/run-failure'
import { isEmptyAssistant } from './message-guard'
import { commandLine } from './permissions'
import { settlePlan, shouldResetPlan } from './plan'
import { createScheduleTaskBridge } from './schedule-bridge'
import { moveQueuedTask, sameQueueOrder, type QueueMoveDirection } from './queue-order'
import { shouldPromoteQueue, insertMustQueue } from './queue-policy'
import { buildSystemPrompt, wantsSelfUpdate } from './prompt'
import { looksLikeCorrection, selectMemories } from './memory'
import {
  buildFixPrompt,
  buildReviewSystemPrompt,
  executeReviewTool,
  isReviewToolName,
  reviewToolsFor,
  type ReviewRuntime,
} from './review'
import { resolveToolPolicy } from './permission-policy'
import { createSelfUpdateBridge } from './self-update-bridge'
import { ProcessManager } from './processes'
import { captureScreenshot, listCapturableWindows } from './screenshots'
import {
  buildExecutionRecordsReport,
  buildSystemStrategyReport,
  grantCovers,
  parseAccessRequest,
  READ_EXECUTION_RECORDS,
  READ_SYSTEM_STRATEGY,
  REQUEST_SYSTEM_ACCESS,
  type SystemAccessGrant,
} from './system-access'
import { ensureBuiltinTools } from './builtin-tools'
import { DynamicToolRegistry } from './toolsmith'
import { PluginToolBridge } from './plugin-tools'
import {
  executePilotTool,
  filterLearningTools,
  LEARNING_LOG,
  LEARNING_RESEARCH,
  pilotTools,
  RUN_SHELL,
  withAutonomyAccess,
  withReferenceRoots,
  withShellDescription,
  type PlanUpdate,
  type ToolHost,
} from './tools'
import {
  appendLearningEntry,
  fetchLearningSource,
  readLearningLedger,
  resolveLearningPolicy,
  sandboxNetworkFor,
  summarizeLearning,
} from './learning'

interface PendingSteer {
  message: AgentMessage
  stored: StoredMessage
  consumed: boolean
}

interface ActiveRun {
  runId: string
  sessionId: string
  workspacePath: string
  approvalMode: ApprovalMode
  instruction: string
  checkpointMessageCount: number
  paused: boolean
  /** 用户点了「停止」：与 paused 一起拦住队列推进，但没有可续跑的暂停态。 */
  stoppedByUser: boolean
  controller: AbortController
  pendingSteering: PendingSteer[]
  pendingApprovals: Set<string>
  startedAt: string
  /** User-approved, read-only access to Pilot's own records and strategy. */
  systemAccess?: SystemAccessGrant
}

interface PendingApproval {
  resolve: (decision: {
    approved: boolean
    reason?: string
    decidedBy?: 'user' | 'timeout' | 'interrupted'
  }) => void
  run: ActiveRun
  view: SharedApprovalRequest
  timer?: NodeJS.Timeout
}

const CONTINUE_PROMPT =
  '从上次中断的地方继续完成当前任务。先检查工作区当前状态，不要重复已经完成或已经验证过的步骤，直接推进剩余工作。'

const PLAN_CONTINUE_PROMPT =
  '继续完成当前计划中尚未完成的条目。先检查工作区现状，不要重复已完成的工作；每完成一部分就更新计划，最后按交付契约汇报结果、验证、使用方式和未验证项。'
const AUTO_CONTINUE_DELAY_MS = 5_000
/**
 * Streaming text is coalesced for this long before it is broadcast. Keeps the
 * stream visibly live (~16fps) while cutting IPC, renderer and companion
 * WebSocket traffic by roughly two orders of magnitude.
 */
const DELTA_FLUSH_INTERVAL_MS = 60

function now(): string {
  return new Date().toISOString()
}

function storedUser(
  content: string,
  runId: string,
  control = false,
  options: MessageOptions = {},
): StoredMessage {
  const images = options.images ?? []
  const references = options.references ?? []
  return {
    id: randomUUID(),
    role: 'user',
    content,
    createdAt: now(),
    runId,
    ...(control ? { control: true } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(references.length > 0 ? { references } : {}),
  }
}

function pathKey(value: string): string {
  const normalized = normalize(resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Stable alias per referenced workspace, independent of list order. */
function referenceAlias(path: string): string {
  const base =
    basename(path)
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'workspace'
  const digest = createHash('sha1').update(pathKey(path)).digest('hex').slice(0, 6)
  return `${base}-${digest}`
}

/** Absolute references name other workspaces; anything else is legacy. */
export function workspaceReferences(references: string[]): ReviewRoot[] {
  const roots: ReviewRoot[] = []
  const seen = new Set<string>()
  for (const path of references) {
    if (!isAbsolute(path)) continue
    const key = pathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({ name: referenceAlias(path), path })
  }
  return roots
}

function referenceBlock(references: string[]): string {
  const blocks: string[] = []
  const roots = workspaceReferences(references)
  if (roots.length > 0) {
    blocks.push(
      [
        '[用户参照了以下其他工作区（只读）。读取其中文件或目录时，把文件工具的 root 参数设为对应别名，path 仍相对该工作区]',
        ...roots.map((root) => `- ${root.name} → ${root.path}`),
      ].join('\n'),
    )
  }
  const files = references.filter((path) => !isAbsolute(path))
  if (files.length > 0) {
    blocks.push(
      [
        '[用户参照了当前工作区的以下文件，需要时请先用 read_file 查看再回答]',
        ...files.map((path) => `- ${path}`),
      ].join('\n'),
    )
  }
  return blocks.join('\n\n')
}

/** Referenced workspaces remain readable for later turns of the same session. */
function sessionReferenceRoots(session: Session): ReviewRoot[] {
  const paths: string[] = []
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]
    if (!message || message.role !== 'user' || message.control) continue
    paths.push(...(message.references ?? []))
    if (paths.length >= 24) break
  }
  const roots: ReviewRoot[] = []
  const seen = new Set<string>()
  for (const root of workspaceReferences(paths)) {
    const key = pathKey(root.path)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(root)
    if (roots.length >= 8) break
  }
  return roots
}

/**
 * Older sessions may already hold an assistant message with no content and no
 * tool calls (a reasoning-only turn the loop used to persist). Replaying it
 * makes the provider reject the whole request, so those turns are skipped on
 * the way back into the model context; the rest of the history still replays.
 */
function isReplayableMessage(message: StoredMessage): boolean {
  return !isEmptyAssistant(message)
}

/**
 * Rebuild the model-side transcript from storage. Exported for the regression
 * test that pins the `control` → `internal` round trip: losing it turned every
 * auto-resume prompt back into a brand new user task.
 */
export function toAgentMessage(message: StoredMessage): AgentMessage {
  const references = message.role === 'user' ? message.references ?? [] : []
  return {
    role: message.role,
    content: references.length > 0
      ? `${message.content}${message.content.trim() ? '\n\n' : ''}${referenceBlock(references)}`
      : message.content,
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.isError ? { isError: true } : {}),
    ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
    // A persisted continuation prompt (`control`) is the same thing the loop
    // marks as `internal` while running: the system wrote it, the user did not
    // open a task with it. Round-tripping it without the mark made the replayed
    // transcript hand "continue where you left off" back as a brand new user
    // task, so the real request was labelled closed work and every auto-resume
    // started from a one-line instruction with no task of its own.
    ...(message.control ? { internal: true } : {}),
  }
}

function toStoredMessages(
  produced: AgentMessage[],
  reasoningTurns: string[],
  runId: string,
  plan?: Plan | null,
): StoredMessage[] {
  let reasoningIndex = 0
  const messages: StoredMessage[] = produced.map((message) => {
    const reasoning =
      message.role === 'assistant' ? reasoningTurns[reasoningIndex++] ?? '' : ''
    return {
      id: randomUUID(),
      role: message.role,
      content:
        message.role === 'tool'
          ? truncateMiddle(message.content, 64_000)
          : truncateMiddle(message.content, 160_000),
      createdAt: now(),
      runId,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.name ? { name: message.name } : {}),
      ...(message.isError ? { isError: true } : {}),
      // Carried so a replayed execution box can print each step's duration.
      ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {}),
      ...(reasoning ? { reasoning } : {}),
    }
  })
  if (plan && plan.items.length > 0) {
    // Attach the plan to the final answer only, so the UI can offer "本轮计划"
    // under the conclusion without repeating it on every intermediate block.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message && message.role === 'assistant' && message.content.trim()) {
        message.plan = plan
        break
      }
    }
  }
  return messages
}

function reflectionFromProduced(prompt: string, produced: AgentMessage[]): string {
  const parts = [`USER: ${truncateMiddle(prompt, 1_800)}`]
  for (const message of produced) {
    if (message.role === 'assistant') {
      if (message.content.trim()) {
        parts.push(`ASSISTANT: ${truncateMiddle(message.content, 2_500)}`)
      }
      for (const call of message.toolCalls ?? []) {
        parts.push(
          `TOOL CALL ${call.name} ${truncateMiddle(JSON.stringify(call.arguments ?? {}), 400)}`,
        )
      }
    } else if (message.role === 'tool') {
      parts.push(
        `TOOL ${message.name ?? ''} ${message.isError ? 'ERROR' : 'OK'}: ${truncateMiddle(message.content, 800)}`,
      )
    }
  }
  return parts.join('\n')
}

/**
 * Simplified fallback policy for callers that do not have a workspace. The
 * real runner uses evaluatePermission so protected paths and deny rules still
 * apply in every mode.
 */
export function policyFor(mode: ApprovalMode) {
  return (tool: AgentToolDefinition): 'auto' | 'ask' | 'deny' => {
    if (mode === 'plan' || mode === 'dontAsk') {
      return tool.risk === 'read' || tool.risk === 'control' ? 'auto' : 'deny'
    }
    if (tool.risk === 'control') return 'auto'
    if (mode === 'ask') return 'ask'
    if (mode === 'auto') return 'auto'
    if (tool.alwaysAsk) return 'ask'
    if (tool.risk === 'read') return 'auto'
    if (mode === 'acceptEdits' && tool.risk === 'write') return 'auto'
    return 'ask'
  }
}

// Wording that asks for inspection rather than a workspace change. A prompt
// containing both kinds stays on the normal change path.
const ANALYSIS_INTENT =
  /(分析|梳理|评估|审计|解读|盘点|调研|审阅|评审|诊断|排查|讲解|介绍|架构|代码质量|技术债|看看|看下|看一下|了解一下|analy[sz]e|analysis|review|audit|assess|architecture|overview|walk me through|look at|find issues|what does .+ do|how does .+ work)/i
const MUTATION_INTENT =
  /(修改|修复|实现|重构|新增|删除|移除|发布|打包|提交|部署|升级|迁移|写入|创建|改成|改一下|加一个|去掉|fix|implement|refactor|add|remove|delete|build|release|deploy|commit|write|create|change|migrate|upgrade)/i

/**
 * Read-only analysis runs get a tighter loop: no plan, a smaller step ceiling
 * and an explicit wrap-up. A prompt that also asks for a change stays on the
 * normal path so the change still gets a plan and verification.
 */
export function isAnalysisRequest(prompt: string): boolean {
  const text = prompt.trim()
  if (!text) return false
  if (MUTATION_INTENT.test(text)) return false
  return ANALYSIS_INTENT.test(text)
}

/**
 * Decide whether a request is substantial enough to require a visible plan
 * before the first edit. Short one-line fixes stay frictionless; multi-step
 * or multi-clause requests must plan first.
 */
export function shouldRequirePlan(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (!trimmed) return false
  const multiStep =
    /(依次|全部|所有|多个|端到端|重构|迁移|发布|打包|实现.+并|新增.+并|修复.+并|排查.+并|依次做|一项一项|逐一|然后|接着|最后|同时|multi-step|end[- ]to[- ]end)/i.test(
      trimmed,
    )
  // A single short instruction ("run the tests", "open the app and screenshot
  // it") does not need a plan round trip, even when the user pasted context
  // that makes the prompt long. Explicit multi-step wording still wins.
  const oneShot =
    /^(?:请|帮我|麻烦|先)?\s*(?:运行|执行|跑一下|跑|启动|打开|查看|看下|看一下|查询|搜索|找出|读取|检查|验证|测试|构建|安装|格式化|列出|打印|显示|统计|git|npm|pnpm|npx|node|python|pytest|cargo|go|dotnet)/i.test(
      trimmed,
    )
  if (oneShot && !multiStep && trimmed.split(/\n+/).filter((line) => line.trim()).length <= 2) {
    return false
  }
  if (trimmed.length >= 180) return true
  if (trimmed.split(/\n+/).filter((line) => line.trim()).length >= 3) return true
  return multiStep
}

/**
 * 按完整 id 或唯一前缀找一条定时任务（实现见 schedule-bridge，供测试与工具两侧共用）。
 */
export { matchScheduledTask } from './schedule-bridge'

export class AgentRunner {
  private readonly active = new Map<string, ActiveRun>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly evolving = new Set<string>()
  private readonly autoContinueAttempts = new Map<string, number>()
  private readonly autoContinueTimers = new Map<string, NodeJS.Timeout>()
  private readonly classifierBlocks = new Map<
    string,
    { consecutive: number; total: number }
  >()
  /**
   * Streaming deltas arrive once per token. Each one used to become an IPC
   * message, a renderer state update and a WebSocket frame per companion
   * device. They are accumulated here and flushed on a short timer, and always
   * flushed before any non-streaming event so ordering and content stay exact.
   */
  private readonly deltaBuffers = new Map<string, DeltaCoalescer>()
  readonly evolution: EvolutionService
  /**
   * 产出质量闸门。和进化服务一样独占一份状态：评估用配置的评估模型，
   * 发布只跑白名单里的打包脚本，两者都不直接动现行版本。
   */
  readonly quality: QualityService

  /**
   * 质量闸门只对“要动产出质量”的运行注入提示：开启闸门即生效，
   * 但只在学习模式下的探索任务里额外点明本轮该盯哪一指标。
   */
  private qualityPromptInput(workspacePath: string, learning: boolean): { block: string; focusMetric?: string } | null {
    if (!this.store.settings().qualityGate) return null
    const status = this.quality.state(workspacePath)
    const block = this.quality.promptBlock(workspacePath)
    const weakest = status.baseline
      ? [...status.baseline.metrics].sort((left, right) => left.value - right.value)[0]
      : undefined
    return learning && weakest ? { block, focusMetric: weakest.label } : { block }
  }

  constructor(
    private readonly store: Store,
    private readonly emit: (event: RunEvent) => void,
    private readonly checkpoints: CheckpointService | null = null,
    private readonly userDataDir = '',
    private readonly getWindow: (() => BrowserWindow | null) | null = null,
    private readonly packageRoot = '',
  ) {
    this.evolution = new EvolutionService(
      store,
      () => this.makeClient(),
      () => this.store.sessionModelTarget()?.model ?? this.store.settings().model,
      () => this.judgeClients(),
    )
    this.quality = new QualityService({
      store,
      judges: () => this.judgeClients(),
      makeClient: () => this.makeClient(),
      packageRoot: this.packageRoot,
      onEvent: (event) => this.emit(event),
    })
  }

  /**
   * Reviewer clients for the self-evolution review step. Each configured judge
   * provider keeps its own key and endpoint; a provider that resolves to the
   * run model is still allowed but flagged so the review is not called
   * independent. The flag is not advisory only: a review with no external judge
   * is recorded as a self-check and carries a suggestion to add a judge from
   * another source. It never blocks the review by itself.
   */
  judgeModels(): string[] {
    return this.judgeClients().map((judge) => `${judge.label}/${judge.model}`)
  }

  private judgeClients(): ProfileJudge[] {
    const execution = this.store.sessionModelTarget()
    const executionBaseUrl = (execution?.baseUrl ?? '').trim().replace(/\/+$/, '')
    return this.store.evaluationTargets().map((target) => ({
      id: target.id,
      label: target.label,
      model: target.model,
      external:
        !execution ||
        target.model !== execution.model ||
        target.baseUrl.trim().replace(/\/+$/, '') !== executionBaseUrl,
      client: new DeepSeekClient({
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        model: target.model,
        // Review verdicts are short JSON, but Qwen3.8-Max and GLM-5.3 spend
        // output tokens on thinking before the answer. A truncation here looks
        // like "the reviewer returned nothing", so give reasoning room; the
        // client still clamps this to each model's own output ceiling.
        maxOutputTokens: 32_000,
        temperature: 0.1,
      }),
    }))
  }

  /**
   * Attach a plain-language summary to a freshly created draft so the chat can
   * answer in everyday words instead of repeating rule text. A model failure
   * is not fatal: the draft is still usable, it just has no summary yet.
   */
  private async explainDraft(
    scope: 'workspace' | 'global',
    workspacePath: string,
    profileId: string,
  ): Promise<{ explanation?: ProfileExplanation }> {
    try {
      const profile = await this.evolution.explain(scope, workspacePath, profileId)
      return profile.explanation ? { explanation: profile.explanation } : {}
    } catch {
      return {}
    }
  }

  private makeClient(modelOverride?: string, sessionId?: string): DeepSeekClient {
    const target = this.store.sessionModelTarget(sessionId)
    if (!target) {
      throw new Error('No API key is configured for the session model. Open Settings and add one.')
    }
    const settings = this.store.settings()
    return new DeepSeekClient({
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      model: modelOverride?.trim() || target.model,
      maxOutputTokens: settings.maxOutputTokens,
      temperature: settings.temperature,
    })
  }

  /** Review sessions can select a different resource, falling back to the session one. */
  private makeReviewClient(): DeepSeekClient {
    const target = this.store.reviewModelTarget()
    if (!target) {
      throw new Error('No API key is configured for the review model. Open Settings and add one.')
    }
    const settings = this.store.settings()
    return new DeepSeekClient({
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      model: target.model,
      maxOutputTokens: settings.maxOutputTokens,
      temperature: 0.1,
    })
  }

  private reviewModelName(): string {
    return (
      this.store.settings().reviewModel.trim() ||
      this.store.reviewModelTarget()?.model ||
      this.store.sessionModelTarget()?.model ||
      this.store.settings().model
    )
  }

  private makeClassifierClient(model: string, sessionId?: string): DeepSeekClient {
    const target = this.store.sessionModelTarget(sessionId)
    if (!target) {
      throw new Error('No API key is configured for the session model. Open Settings and add one.')
    }
    const settings = this.store.settings()
    return new DeepSeekClient({
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      model: model || target.model,
      maxOutputTokens: 600,
      temperature: 0,
    })
  }

  private ensureReady(sessionId?: string): void {
    if (!this.store.sessionModelTarget(sessionId)) {
      throw new Error('No API key is configured for the session model. Open Settings and add one.')
    }
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** Active runs across all sessions. Used to gate restarts such as updates. */
  activeRunCount(): number {
    return this.active.size
  }

  private async resolveReferences(root: string, references: string[]): Promise<string[]> {
    if (references.length === 0) return references
    const current = pathKey(root)
    const workspaces = this.store.workspaces()
    for (const path of references) {
      if (isAbsolute(path)) {
        // A reference is another project workspace the user has already
        // opened. The path arrives from the renderer or the phone, so it is
        // matched against the store instead of being trusted.
        const key = pathKey(path)
        if (key === current) throw new Error('参照的是当前工作区，不需要重复添加')
        const known = workspaces.find((entry) => pathKey(entry.path) === key)
        if (!known) throw new Error(`这个项目还没有在工作区列表里打开过：${path}`)
        const resolved = await realpath(known.path).catch(() => '')
        if (!resolved || pathKey(resolved) !== key) {
          throw new Error(`参照的项目已不可用：${path}`)
        }
        continue
      }
      const target = await resolveExisting(root, path)
      const info = await stat(target)
      if (!info.isFile()) throw new Error(`参照路径不是文件：${path}`)
    }
    return references
  }

  async sendMessage(
    sessionId: string,
    content: string,
    delivery: 'queue' | 'insert',
    options: MessageOptions = {},
  ): Promise<{ queued: boolean }> {
    const text = content.trim()
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.workspacePath) throw new Error('Session has no workspace')
    const images = sanitizeImages(options.images)
    const references = await this.resolveReferences(
      session.workspacePath,
      sanitizeReferences(options.references),
    )
    if (!text && images.length === 0 && references.length === 0) {
      throw new Error('Message is empty')
    }
    this.clearAutoContinue(sessionId)
    this.autoContinueAttempts.delete(sessionId)

    if (this.active.has(sessionId)) {
      // Queue entries only carry text; attachments stay with the finished run.
      if (images.length > 0 || references.length > 0) {
        throw new Error('任务执行中无法附带图片或参照项目，请等当前任务结束后再发送')
      }
      const live = this.active.get(sessionId)
      // 这一轮已经被用户暂停/停止了，只剩收尾：插进去的消息会跟着旧 run 一起
      // 消失，用户看到的是「发了却没执行」。降级成排队任务，等这一轮收尾后按序跑。
      if (delivery === 'insert' && insertMustQueue(live)) {
        const task = { id: randomUUID(), content: text, createdAt: now() }
        const queue = [...session.queue, task].slice(-20)
        await this.store.setQueue(sessionId, queue)
        this.emit({ type: 'queue.changed', sessionId, queue })
        this.emit({ type: 'session.changed', sessionId })
        this.emit({
          type: 'notice',
          level: 'info',
          message: '这一轮已暂停/停止，消息改为排队，等这一轮收尾后按序开始。',
        })
        return { queued: true }
      }
      if (delivery === 'insert') {
        await this.insertIntoRun(sessionId, text)
        return { queued: false }
      }
      const task = { id: randomUUID(), content: text, createdAt: now() }
      const queue = [...session.queue, task].slice(-20)
      await this.store.setQueue(sessionId, queue)
      this.emit({ type: 'queue.changed', sessionId, queue })
      this.emit({ type: 'session.changed', sessionId })
      return { queued: true }
    }

    this.ensureReady(sessionId)
    if (session.paused) {
      // 用户在有待续跑的任务时直接发了新消息：他要做的是新指令，先清掉暂停态，
      // 否则旧任务的「继续」按钮会留在界面上，点下去只会收到「任务还在运行」。
      await this.store.setPaused(sessionId, null)
    }
    // Attachments can carry the whole message: files and images on their own
    // still need an instruction the model can act on.
    const instruction =
      text ||
      (images.length > 0
        ? '请查看这张图片，并说明你看到的内容。'
        : '请读取我参照的文件，并说明你看到的内容。')
    const ctx = this.newContext(session, session.approvalMode, instruction)
    this.active.set(sessionId, ctx)
    try {
      const stored = storedUser(text, ctx.runId, false, { images, references })
      await this.store.addMessage(sessionId, stored)
      this.emit({ type: 'session.changed', sessionId })
      void this.execute(ctx, instruction, stored)
    } catch (error) {
      this.active.delete(sessionId)
      this.store.setRunning(sessionId, false)
      throw error
    }
    return { queued: false }
  }

  async cancelRun(sessionId: string): Promise<void> {
    this.clearAutoContinue(sessionId)
    this.autoContinueAttempts.delete(sessionId)
    const ctx = this.active.get(sessionId)
    if (!ctx) return
    // 停止是用户把这一轮按住：收尾时不推进队列，等的入口在队列面板上。
    ctx.stoppedByUser = true
    ctx.controller.abort()
    for (const callId of [...ctx.pendingApprovals]) {
      this.settleApproval(callId, {
        approved: false,
        reason: 'Run cancelled',
        decidedBy: 'interrupted',
      })
    }
    const queued = this.store.session(sessionId)?.queue.length ?? 0
    if (queued > 0) {
      this.emit({
        type: 'notice',
        level: 'info',
        message: `任务已停止；排队中的 ${queued} 条任务不会自动开始，点队列里的“执行”或发一条新消息后再按序运行。`,
      })
    }
  }

  /**
   * Stop the run at the next safe boundary but keep it resumable: the finished
   * run is recorded as paused and a continuation prompt can pick it back up.
   */
  async pauseRun(sessionId: string): Promise<void> {
    this.clearAutoContinue(sessionId)
    const ctx = this.active.get(sessionId)
    if (!ctx || ctx.paused) return
    ctx.paused = true
    this.store.setRunInfo(sessionId, {
      runId: ctx.runId,
      instruction: ctx.instruction,
      startedAt: ctx.startedAt,
    })
    ctx.controller.abort()
    for (const callId of [...ctx.pendingApprovals]) {
      this.settleApproval(callId, { approved: false, reason: 'Run paused', decidedBy: 'interrupted' })
    }
    this.emit({ type: 'session.changed', sessionId })
    const queued = this.store.session(sessionId)?.queue.length ?? 0
    this.emit({
      type: 'notice',
      level: 'info',
      message:
        queued > 0
          ? `任务已暂停，排队中的 ${queued} 条任务会等你点“继续”后按序开始；也可以在队列里手动执行某一条。`
          : '任务已暂停，可在输入框或会话列表点击“继续”从中断处接着做。',
    })
  }

  /** Resume a paused or interrupted session with a continuation prompt. */
  async continueRun(sessionId: string): Promise<{ queued: boolean }> {
    this.clearAutoContinue(sessionId)
    this.autoContinueAttempts.delete(sessionId)
    return this.resumeSession(sessionId)
  }

  private async resumeSession(sessionId: string): Promise<{ queued: boolean }> {
    // 暂停后这一轮还在收尾（写盘、审计、快照）。以前这里直接抛“任务还在
    // 运行”，用户看到的是自己刚点过暂停却续不上；收尾通常几百毫秒内结束。
    if (this.active.has(sessionId)) {
      if (this.active.get(sessionId)?.paused !== true) throw new Error('The task is still running')
      await this.waitForIdle(sessionId, 15_000)
      if (this.active.has(sessionId)) throw new Error('The task is still running')
    }
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.workspacePath) throw new Error('Session has no workspace')
    if (!session.paused && !session.canContinue) {
      throw new Error('当前任务没有需要继续的中断')
    }
    this.ensureReady(sessionId)
    await this.store.setPaused(sessionId, null)
    const instruction = session.pauseInstruction?.trim() || CONTINUE_PROMPT
    const ctx = this.newContext(session, session.approvalMode, instruction)
    this.active.set(sessionId, ctx)
    try {
      const stored = storedUser(CONTINUE_PROMPT, ctx.runId, true)
      await this.store.addMessage(sessionId, stored)
      this.emit({ type: 'session.changed', sessionId })
      void this.execute(ctx, CONTINUE_PROMPT, stored)
    } catch (error) {
      this.active.delete(sessionId)
      this.store.setRunning(sessionId, false)
      throw error
    }
    return { queued: false }
  }

  /** 等一轮 run 收尾完成（active 被清掉），给暂停后续跑用。 */
  private async waitForIdle(sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.active.has(sessionId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Continue a finished run with a specific instruction, used by the stop
   * hook's `CONTINUE:` directive. Same guards as resumeSession; nothing has to
   * be paused because the run completed and the hook decided it is not done.
   */
  private async continueWithInstruction(sessionId: string, instruction: string): Promise<void> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.workspacePath) throw new Error('Session has no workspace')
    if (this.active.has(sessionId) || session.queue.length > 0) return
    this.ensureReady(sessionId)
    await this.store.setPaused(sessionId, null)
    const ctx = this.newContext(session, session.approvalMode, instruction)
    this.active.set(sessionId, ctx)
    try {
      const stored = storedUser(instruction, ctx.runId, true)
      await this.store.addMessage(sessionId, stored)
      this.emit({ type: 'session.changed', sessionId })
      void this.execute(ctx, instruction, stored)
    } catch (error) {
      this.active.delete(sessionId)
      this.store.setRunning(sessionId, false)
      throw error
    }
  }

  /**
   * Continue a completed execution run that left plan items unfinished.
   * Unlike resumeSession this does not require a paused session: the run
   * finished normally, it simply stopped before completing the plan.
   */
  private async continueFromPlan(sessionId: string, instruction: string): Promise<void> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.workspacePath) throw new Error('Session has no workspace')
    if (this.active.has(sessionId) || session.queue.length > 0) return
    this.ensureReady(sessionId)
    const ctx = this.newContext(session, session.approvalMode, instruction)
    this.active.set(sessionId, ctx)
    try {
      const stored = storedUser(instruction, ctx.runId, true)
      await this.store.addMessage(sessionId, stored)
      this.emit({ type: 'session.changed', sessionId })
      void this.execute(ctx, instruction, stored)
    } catch (error) {
      this.active.delete(sessionId)
      this.store.setRunning(sessionId, false)
      throw error
    }
  }

  /** Edit an earlier user message and regenerate from that point. */
  async editMessage(sessionId: string, messageId: string, content: string): Promise<void> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    const target = session.messages.find((message) => message.id === messageId)
    if (!target) throw new Error('Message not found')
    if (target.role !== 'user') throw new Error('Only user messages can be edited')
    if (target.control) throw new Error('Continuation markers cannot be edited')
    await this.restartFromUserMessage(sessionId, messageId, content)
  }

  /** Delete the final user instruction when nothing has replied to it yet. */
  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    if (this.active.has(sessionId)) {
      throw new Error('当前任务仍在执行，请先等待完成或暂停')
    }
    await this.store.removeUnansweredMessage(sessionId, messageId)
    this.emit({ type: 'session.changed', sessionId })
  }

  /** Drop the last answer and run the most recent user message again. */
  async regenerate(sessionId: string): Promise<void> {
    await this.restartFromUserMessage(sessionId)
  }

  /** Retry a failed run from its last user message. */
  async retryRun(sessionId: string): Promise<void> {
    await this.restartFromUserMessage(sessionId)
  }

  private async restartFromUserMessage(
    sessionId: string,
    messageId?: string,
    content?: string,
  ): Promise<void> {
    if (this.active.has(sessionId)) {
      throw new Error('当前任务仍在执行，请先等待完成或暂停')
    }
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.workspacePath) throw new Error('Session has no workspace')

    let index = -1
    if (messageId) {
      index = session.messages.findIndex((message) => message.id === messageId)
    } else {
      for (let cursor = session.messages.length - 1; cursor >= 0; cursor -= 1) {
        const message = session.messages[cursor]
        if (message?.role === 'user' && !message.control) {
          index = cursor
          break
        }
      }
    }
    if (index < 0) throw new Error('没有可重新运行的用户消息')
    const target = session.messages[index]!
    if (target.role !== 'user' || target.control) {
      throw new Error('Only user messages can be rerun')
    }
    const text = (content ?? target.content).trim()
    if (!text) throw new Error('Message is empty')

    this.ensureReady(sessionId)
    this.clearAutoContinue(sessionId)
    this.autoContinueAttempts.delete(sessionId)
    const ctx = this.newContext(session, session.approvalMode, text)
    ctx.checkpointMessageCount = index + 1
    this.active.set(sessionId, ctx)
    try {
      const stored = await this.store.rewriteUserMessage(
        sessionId,
        target.id,
        text,
        ctx.runId,
      )
      this.emit({ type: 'session.changed', sessionId })
      void this.execute(ctx, text, stored, { skipUserMessage: true })
    } catch (error) {
      this.active.delete(sessionId)
      this.store.setRunning(sessionId, false)
      throw error
    }
  }

  /** Apply a mode switch to the active run without waiting for the next task. */
  setApprovalMode(sessionId: string, mode: ApprovalMode): void {
    const session = this.store.session(sessionId)
    if (session?.kind === 'review') return
    const ctx = this.active.get(sessionId)
    if (ctx) ctx.approvalMode = mode
  }

  async decideApproval(
    callId: string,
    approved: boolean,
    reason?: string,
    remember = false,
  ): Promise<void> {
    const pending = this.pendingApprovals.get(callId)
    if (approved && remember && pending) {
      // Only run_shell keeps one verbatim command string. run_command argv is
      // displayed as a joined line that different argv arrays can collide on,
      // so it must not be remembered by that representation.
      const command = pending.view.tool === 'run_shell' ? commandLine(pending.view.arguments) : ''
      if (command) {
        // Remembering is a convenience; a disk error must not leave the user's
        // approval unanswered until the timeout fires.
        await this.store.addTrustedCommand(command).catch(() => undefined)
      }
    }
    const settled = this.settleApproval(callId, {
      approved,
      decidedBy: 'user',
      ...(reason ? { reason } : {}),
    })
    if (!settled) throw new Error('Approval request is no longer pending')
  }

  private settleApproval(
    callId: string,
    decision: {
      approved: boolean
      reason?: string
      decidedBy?: 'user' | 'timeout' | 'interrupted'
    },
  ): boolean {
    const pending = this.pendingApprovals.get(callId)
    if (!pending) return false
    this.pendingApprovals.delete(callId)
    pending.run.pendingApprovals.delete(callId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(decision)
    return true
  }

  private approvalTimeout(): { ms: number; expiresAt?: string; label: string } {
    const seconds = Math.max(0, Math.round(this.store.settings().approvalTimeoutSec))
    if (seconds === 0) return { ms: 0, label: '永不' }
    return {
      ms: seconds * 1_000,
      expiresAt: new Date(Date.now() + seconds * 1_000).toISOString(),
      label: seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`,
    }
  }

  private clearAutoContinue(sessionId: string): void {
    const timer = this.autoContinueTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.autoContinueTimers.delete(sessionId)
  }

  /**
   * After a failed/interrupted/max-steps run, give the agent one more attempt
   * on the same session. This is opt-in, capped, and never runs while the user
   * has queued work waiting.
   */
  private scheduleAutoContinue(
    sessionId: string,
    reason: string,
    options: { planInstruction?: string; instruction?: string } = {},
  ): boolean {
    const settings = this.store.settings()
    if (!settings.autoContinue || !this.store.getApiKey()) return false
    if (this.active.has(sessionId) || this.autoContinueTimers.has(sessionId)) return false
    const session = this.store.session(sessionId)
    if (!session || session.queue.length > 0) return false
    const attempted = this.autoContinueAttempts.get(sessionId) ?? 0
    if (attempted >= settings.autoContinueLimit) {
      this.emit({
        type: 'notice',
        level: 'warn',
        message: `已自动继续 ${attempted} 次仍未完成，先停下等待你处理。`,
      })
      return false
    }
    this.autoContinueAttempts.set(sessionId, attempted + 1)
    const attempt = attempted + 1
    this.emit({
      type: 'notice',
      level: 'warn',
      message: `${reason}，将在 5 秒后自动继续（第 ${attempt}/${settings.autoContinueLimit} 次）。`,
    })
    const timer = setTimeout(() => {
      this.autoContinueTimers.delete(sessionId)
      const current = this.store.session(sessionId)
      if (!current || this.active.has(sessionId)) return
      if (!this.store.settings().autoContinue) {
        this.emit({
          type: 'notice',
          level: 'info',
          message: '自动继续已关闭，本次不再重试。',
        })
        this.autoContinueAttempts.delete(sessionId)
        return
      }
      const continuation = options.planInstruction
        ? this.continueFromPlan(sessionId, options.planInstruction)
        : options.instruction
          ? // A stop-hook directive is a plain instruction for the same session,
            // so it skips the generic resume prompt.
            this.continueWithInstruction(sessionId, options.instruction)
          : this.resumeSession(sessionId)
      void continuation.catch((error) => {
        this.emit({
          type: 'notice',
          level: 'warn',
          message: `自动继续失败：${error instanceof Error ? error.message : String(error)}`,
        })
      })
    }, AUTO_CONTINUE_DELAY_MS)
    timer.unref?.()
    this.autoContinueTimers.set(sessionId, timer)
    return true
  }

  async removeQueueItem(sessionId: string, taskId: string): Promise<void> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    const queue = session.queue.filter((item) => item.id !== taskId)
    await this.store.setQueue(sessionId, queue)
    this.emit({ type: 'queue.changed', sessionId, queue })
    this.emit({ type: 'session.changed', sessionId })
  }

  async updateQueueItem(sessionId: string, taskId: string, content: string): Promise<void> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    // Keep line breaks: a queued task may be several lines long, and editing it
    // should not flatten it into one paragraph.
    const text = content
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4_000)
    if (!text) throw new Error('排队消息内容不能为空')
    const task = session.queue.find((item) => item.id === taskId)
    if (!task) throw new Error('Queued task not found')
    const queue = session.queue.map((item) =>
      item.id === taskId ? { ...item, content: text } : item,
    )
    await this.store.setQueue(sessionId, queue)
    this.emit({ type: 'queue.changed', sessionId, queue })
    this.emit({ type: 'session.changed', sessionId })
  }

  /** Move one queued task one slot up or down; a move past either end is a no-op. */
  async moveQueueItem(
    sessionId: string,
    taskId: string,
    direction: QueueMoveDirection,
  ): Promise<void> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (direction !== 'up' && direction !== 'down') throw new Error('Unsupported queue move')
    const queue = moveQueuedTask(session.queue, taskId, direction)
    if (sameQueueOrder(queue, session.queue)) return
    await this.store.setQueue(sessionId, queue)
    this.emit({ type: 'queue.changed', sessionId, queue })
    this.emit({ type: 'session.changed', sessionId })
  }

  /** Move one queued message into the todo list without executing it. */
  async convertQueueItemToTodo(sessionId: string, taskId: string): Promise<TodoItem> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    const task = session.queue.find((item) => item.id === taskId)
    if (!task) throw new Error('Queued task not found')
    const todo = await this.store.addTodo(sessionId, task.content, 'user')
    const queue = session.queue.filter((item) => item.id !== taskId)
    await this.store.setQueue(sessionId, queue)
    this.emit({ type: 'queue.changed', sessionId, queue })
    this.emit({ type: 'todos.changed', sessionId, todos: this.store.todos(sessionId) })
    this.emit({ type: 'session.changed', sessionId })
    return todo
  }

  async insertQueueItem(sessionId: string, taskId: string): Promise<void> {
    const session = this.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    const task = session.queue.find((item) => item.id === taskId)
    if (!task) throw new Error('Queued task not found')
    const queue = session.queue.filter((item) => item.id !== taskId)
    await this.store.setQueue(sessionId, queue)
    this.emit({ type: 'queue.changed', sessionId, queue })
    if (this.active.has(sessionId)) {
      const live = this.active.get(sessionId)
      // 已暂停/已停止的那一轮只是还在收尾，插入到这个 run 里会随着旧 run 一起
      // 消失；等它收尾完毕再当作新任务跑。
      if (live?.paused === true || live?.stoppedByUser === true) {
        await this.waitForIdle(sessionId, 15_000)
        if (this.active.has(sessionId)) {
          // 还没收完：把任务放回队首，不能让它消失在旧 run 里。
          const restored = await this.store.session(sessionId)
          if (restored) {
            const back = [task, ...restored.queue]
            await this.store.setQueue(sessionId, back)
            this.emit({ type: 'queue.changed', sessionId, queue: back })
          }
          throw new Error('上一轮还在收尾，稍后再执行这条排队任务')
        }
      }
    }
    if (this.active.has(sessionId)) {
      await this.insertIntoRun(sessionId, task.content)
    } else {
      this.ensureReady(sessionId)
      const fresh = await this.store.session(sessionId)
      if (!fresh) throw new Error('Session not found')
      // 手动执行一条排队任务 = 用这个消息替代暂停中的继续，清掉暂停态以免两条
      // “下一步做什么”同时挂在同一个会话上。
      if (fresh.paused) await this.store.setPaused(sessionId, null)
      const ctx = this.newContext(fresh, fresh.approvalMode, task.content)
      this.active.set(sessionId, ctx)
      const stored = storedUser(task.content, ctx.runId)
      await this.store.addMessage(sessionId, stored)
      this.emit({ type: 'session.changed', sessionId })
      void this.execute(ctx, task.content, stored)
    }
  }

  private async insertIntoRun(sessionId: string, text: string): Promise<void> {
    const ctx = this.active.get(sessionId)
    if (!ctx) {
      throw new Error('The current task has already finished; send the message instead.')
    }
    // 已暂停/已停止的 run 只剩收尾，什么都插不进去了：消息会随着旧 run 一起
    // 消失，用户却看到它已经写进对话。这里直接拒，让调用方改走排队。
    if (insertMustQueue(ctx)) {
      throw new Error('这一轮已暂停/停止，消息需要排队，等这一轮收尾后按序开始')
    }
    const stored = storedUser(text, ctx.runId)
    await this.store.addMessage(sessionId, stored)
    ctx.pendingSteering.push({
      message: { role: 'user', content: text },
      stored,
      consumed: false,
    })
    this.emit({ type: 'session.changed', sessionId })
    this.emit({
      type: 'notice',
      level: 'info',
      message: 'Message inserted into the running task; it will be applied at the next step.',
    })
  }

  private newContext(
    session: Session,
    approvalMode: ApprovalMode,
    instruction: string,
  ): ActiveRun {
    return {
      runId: randomUUID(),
      sessionId: session.id,
      workspacePath: session.workspacePath,
      // Review sessions only expose read/control tools; read-only-auto keeps
      // evidence gathering frictionless without enabling any mutation.
      approvalMode: session.kind === 'review' ? 'manual' : approvalMode,
      instruction: instruction.slice(0, 4_000),
      checkpointMessageCount: session.messages.length,
      paused: false,
      stoppedByUser: false,
      controller: new AbortController(),
      pendingSteering: [],
      pendingApprovals: new Set(),
      startedAt: now(),
    }
  }

  private async snapshot(
    ctx: ActiveRun,
    label: string,
    trigger: CheckpointTrigger,
    messageCount: number,
  ): Promise<number> {
    if (!this.checkpoints) return 0
    const startedAt = Date.now()
    try {
      await this.checkpoints.create({
        sessionId: ctx.sessionId,
        workspacePath: ctx.workspacePath,
        label,
        messageCount,
        trigger,
        retention: this.store.settings().checkpointRetention,
        maxBytes: this.store.settings().checkpointMaxBytes,
        ignore: this.store.settings().checkpointIgnore,
        scope: this.store.settings().checkpointScope,
      })
    } catch (error) {
      this.emit({
        type: 'notice',
        level: 'warn',
        message: `无法创建回退点：${error instanceof Error ? error.message : String(error)}`,
      })
    }
    // 耗时由调用方记账：运行前快照现在与模型首轮并行，不能再拿「等待前后之差」
    // 计时，否则会把模型往返时间算进回退点耗时。
    return Date.now() - startedAt
  }

  private recordClassifierBlock(
    sessionId: string,
  ): { consecutive: number; total: number; pause: boolean } {
    const current = this.classifierBlocks.get(sessionId) ?? { consecutive: 0, total: 0 }
    const next = {
      consecutive: current.consecutive + 1,
      total: current.total + 1,
    }
    this.classifierBlocks.set(sessionId, next)
    return { ...next, pause: next.consecutive >= 3 || next.total >= 20 }
  }

  private recordClassifierAllow(sessionId: string): void {
    const current = this.classifierBlocks.get(sessionId)
    if (current && current.consecutive > 0) {
      this.classifierBlocks.set(sessionId, { ...current, consecutive: 0 })
    }
  }

  private async execute(
    ctx: ActiveRun,
    prompt: string,
    userStored: StoredMessage | null,
    options: { skipUserMessage?: boolean } = {},
  ): Promise<void> {
    const sessionId = ctx.sessionId
    const workspacePath = ctx.workspacePath
    let runStarted = false
    const reasoningTurns: string[] = []
    let toolCalls = 0
    let toolErrors = 0
    let produced: AgentMessage[] = []
    let steps = 0
    let totalTokens = 0
    let promptTokens = 0
    let completionTokens = 0
    let cacheHitTokens = 0
    let cacheMissTokens = 0
    let checkpointMs = 0
    /**
     * 运行前快照的句柄。它与首轮模型请求并行跑，但任何工具执行前必须落定：
     * 回退点要覆盖「这一轮改动之前」的状态，晚于第一个写操作就没有回退意义了。
     * 之所以不在这里 await，是因为大工作区走一遍要几秒，而用户感知的「开始」
     * 是模型先开口——把这段等待从首轮路径上挪走，模型思考与快照同时进行。
     */
    let baselineSnapshot: Promise<number> | null = null
    let baselineWait: Promise<void> | null = null
    let delegations = 0
    let delegatedSteps = 0
    let delegatedSummaryChars = 0
    let usageModel = ''
    let finalStatus: RunStatus = 'failed'
    let finalError: string | undefined
    let finalContent = ''
    let messagesHandled = false
    // Set from the stop hook's `CONTINUE:` line; consumed once the run settles.
    let stopDirective: string | null = null
    let mcp: McpService | null = null
    // 插件工具桥：每个 run 重建，run 结束就释放；finally 里要读它，故在 try 外声明。
    let pluginTools: PluginToolBridge | null = null
    // One manager per run. Whatever the model starts is killed when this run
    // reaches any terminal state, including a pause or a provider error.
    const processes = new ProcessManager()
    const startedAt = ctx.startedAt

    this.store.setRunning(sessionId, true)
    this.store.setRunInfo(sessionId, {
      runId: ctx.runId,
      instruction: ctx.instruction,
      startedAt,
    })
    // A new run supersedes any previous pause marker.
    try {
      await this.store.setPaused(sessionId, null)
    } catch {
      // Best-effort cleanup.
    }
    try {
      let session = this.store.session(sessionId)
      if (!session) throw new Error('Session not found')
      const review = session.kind === 'review' ? session.review : null
      if (!options.skipUserMessage && !userStored) {
        throw new Error('Missing user message')
      }
      // A new user instruction opens a new turn, so the previous turn's plan is
      // history: it already lives on that turn's final answer. Keeping it on the
      // session showed the old plan for an instruction that produced none (plan
      // panel, session list and the phone) and told the model to keep a finished
      // plan current. Continuations (pause/resume, auto-continue) keep the plan.
      if (shouldResetPlan({ plan: session.plan, isReview: Boolean(review), userMessage: userStored })) {
        try {
          await this.store.setPlan(sessionId, null)
          session = this.store.session(sessionId) ?? session
          this.emit({ type: 'session.changed', sessionId, plan: null })
        } catch {
          // Clearing is best-effort and must not stop the run.
        }
      }
      if (ctx.approvalMode !== 'plan' && !review) {
        baselineSnapshot = this.snapshot(
          ctx,
          prompt.replace(/\s+/g, ' ').trim().slice(0, 60) || '运行前快照',
          'prompt',
          ctx.checkpointMessageCount,
        )
      }
      /** 只在第一次需要时等待一次；之后复用同一个 promise。 */
      const ensureBaseline = (): Promise<void> => {
        if (!baselineSnapshot) return Promise.resolve()
        if (!baselineWait) {
          baselineWait = baselineSnapshot.then(
            (ms) => {
              checkpointMs += ms
            },
            () => undefined,
          )
        }
        return baselineWait
      }
      const settings = this.store.settings()
      // Agent-written tools are scoped to this workspace and this run's abort
      const autonomy = autonomyPolicy({
        fullAutonomy: settings.fullAutonomy,
        approvalMode: ctx.approvalMode,
        maxTokens: settings.maxTokens,
        maxSteps: settings.maxSteps,
      })
      // 完全自主档：设置开启 + 全部自动 + token/步数上限达标才生效。
      // 生效时把「自视/自检」所需的系统授权预置到本次运行（只读、随运行结束失效），
      // 并让沙箱网络无条件联网；未生效时下面每一处都退回原行为。
      if (autonomy.active && !review && ctx.systemAccess === undefined) {
        const nowMs = Date.now()
        ctx.systemAccess = {
          id: randomUUID().slice(0, 8),
          scopes: ['execution_records', 'system_strategy'],
          allWorkspaces: true,
          grantedAt: nowMs,
          expiresAt: nowMs + 60 * 60_000,
        }
        this.auditAutonomy(ctx, {
          kind: 'system-access',
          tool: 'session',
          detail: 'scopes=execution_records,system_strategy; workspaces=all',
          settings,
        })
      }
      /**
       * 越界读取与自身配置写入的留痕。同一个工具一次运行内只记前 20 条：
       * 模型可能连读几十个工作区外文件，记到底只会把日志推向保留上限。
       */
      const autonomyAuditCounts = new Map<string, number>()
      const auditCall = (call: { name: string; arguments: Record<string, unknown> }, risk: string): void => {
        if (!autonomy.active) return
        const kind = autonomyAuditKind(
          { name: call.name, risk },
          call.arguments ?? {},
          workspacePath,
        )
        if (!kind) return
        const key = `${kind}:${call.name}`
        const seen = autonomyAuditCounts.get(key) ?? 0
        if (seen >= 20) return
        autonomyAuditCounts.set(key, seen + 1)
        // 只留元数据：路径取前 200 字符；命令只取首个词（程序名），
        // 因为命令行里可能带密钥或业务参数，全文写进日志没有审计价值。
        const args = call.arguments ?? {}
        const raw =
          typeof args['path'] === 'string'
            ? args['path']
            : typeof args['command'] === 'string'
              ? (args['command'].trim().split(/\s+/)[0] ?? '')
              : ''
        this.auditAutonomy(ctx, {
          kind,
          tool: call.name,
          detail: raw.slice(0, 200),
          settings,
        })
      }
      // Agent-written tools are scoped to this workspace and this run's abort
      // signal. Registration runs the declared self-test; editing any tool file
      // changes its hash and revokes approval until it is registered again.
      const toolRegistry = review
        ? null
        : new DynamicToolRegistry({
            workspacePath,
            userDataDir: this.userDataDir,
            testTargets: settings.testTargets,
            testCaptchaMode: settings.testCaptchaMode,
            testCaptcha: this.store.getTestCaptcha(),
            signal: ctx.controller.signal,
            onChange: () => this.emit({ type: 'tools.changed', workspacePath }),
          })
      if (toolRegistry) {
        // Tools shipped inside the release package are adopted on the first run
        // after an install or upgrade: the bundle carries the SHA-256 the pack
        // script recorded after running each self-test, and adoption re-hashes
        // the copied bytes. A missing bundle or a copy the user edited is
        // reported in the summary, never thrown into the run.
        await ensureBuiltinTools(toolRegistry).catch(() => null)
      }
      const dynamicTools = toolRegistry
        ? (await toolRegistry.list().catch(() => [])).filter(
            (tool) => tool.approved && tool.enabled,
          )
        : []
      const referenceRoots = review ? [] : sessionReferenceRoots(session)
      // 学习探索是显式开关（默认关）：关闭时学习类工具根本不出现，
      // 工具列表本身就是“已关”的证据。它只影响学习类工具，不影响任务会话联网。
      const learning = review ? null : resolveLearningPolicy(settings)
      const learningEnabled = learning?.enabled === true
      let tools = review
        ? reviewToolsFor(review)
        : withReferenceRoots(
            filterLearningTools(
              settings.shellMode
                ? pilotTools
                : pilotTools.filter((tool) => tool.name !== RUN_SHELL),
              learningEnabled,
            ),
            referenceRoots,
          )
      if (!review && ctx.approvalMode === 'plan') {
        // Plan mode is enforced twice: mutating tools are not offered to the
        // model, and evaluatePermission denies them if they are called anyway.
        tools = tools.filter((tool) => tool.risk !== 'write' && tool.risk !== 'exec')
      }
      // Plugin tools join before the plan filter so a plugin's own `risk`
      // decides whether plan mode sees them. The bridge is rebuilt per run, so
      // enabling or reconfiguring a plugin takes effect on the next turn.
      pluginTools = review
        ? null
        : await PluginToolBridge.create({
            workspacePath,
            notify: (message) => this.emit({ type: 'notice', level: 'info', message }),
            onPluginEvent: (pluginId, event, payload) =>
              this.emit({
                type: 'notice',
                level: 'info',
                message: `插件 ${pluginId} 发出事件 ${event}${summarizePluginPayload(payload)}`,
              }),
          }).catch(() => null)
      if (pluginTools) {
        tools = [...tools, ...pluginTools.tools()]
        if (!review && ctx.approvalMode === 'plan') {
          tools = tools.filter((tool) => tool.risk !== 'write' && tool.risk !== 'exec')
        }
      }
      // Tools are re-read per step: a server created later in the run extends
      // the MCP part only, so builtins and their prompt-synced descriptions
      // survive untouched.
      const pullTools = (): AgentToolDefinition[] => [
        ...tools.filter((tool) => tool.source !== 'mcp'),
        ...(mcp?.listTools() ?? []),
      ]
      mcp =
        !review &&
        settings.mcpEnabled &&
        ctx.approvalMode !== 'plan' &&
        ctx.approvalMode !== 'dontAsk'
          ? new McpService()
          : null
      if (mcp) {
        await mcp.connect(workspacePath).catch((error) => {
          this.emit({
            type: 'notice',
            level: 'warn',
            message: `MCP 初始化失败：${error instanceof Error ? error.message : String(error)}`,
          })
        })
        for (const failure of mcp.connectionErrors()) {
          this.emit({ type: 'notice', level: 'warn', message: `MCP 服务器未连接：${failure}` })
        }
        tools = [...tools, ...mcp.listTools()]
      }
      const sandbox = await sandboxStatus()
      const sandboxEnabled = settings.sandboxMode === 'auto' && sandbox.available
      // Keep the tool description in sync with the interpreter the system
      // prompt announces, so the model does not guess between cmd and bash.
      if (!review && settings.shellMode) {
        tools = withShellDescription(
          tools,
          sandboxEnabled
            ? 'bash inside the OS sandbox (POSIX syntax)'
            : shellInterpreterLabel(settings.shellInterpreter),
        )
      }
      // 完全自主档：读类工具确实接受工作区外绝对路径，描述要与实现一致，
      // 否则模型会以为只能读工作区而放弃调用。
      if (autonomy.active && !review) {
        tools = withAutonomyAccess(tools, true)
      }
      // Review must be independent of the profiles that shaped the work under
      // review, so it runs without the active global or workspace profile.
      const profile = review ? null : this.store.activeProfile(workspacePath)
      const globalProfile = review ? null : this.store.activeGlobalProfile()
      const run: RunRecord = {
        id: ctx.runId,
        sessionId,
        prompt: prompt.slice(0, 4_000),
        status: 'running',
        startedAt,
        steps: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        toolCalls: 0,
        toolErrors: 0,
        ...(profile ? { profileVersion: profile.version } : {}),
        ...(globalProfile ? { globalProfileVersion: globalProfile.version } : {}),
      }
      await this.store.startRun(workspacePath, run)
      runStarted = true
      this.emit({
        type: 'run.started',
        sessionId,
        runId: ctx.runId,
        profileVersion: profile?.version ?? null,
        mode: ctx.approvalMode,
      })

      let topLevel = ''
      try {
        topLevel = await listDirectoryTree(workspacePath, '.', 1)
      } catch {
        topLevel = '(workspace listing unavailable)'
      }
      let globalInstructions: Awaited<ReturnType<typeof loadGlobalInstructions>> = []
      try {
        globalInstructions = review ? [] : await loadGlobalInstructions(this.userDataDir)
      } catch {
        // The user-level instruction file is optional.
      }
      let projectInstructions: Awaited<ReturnType<typeof loadProjectInstructions>> = []
      let instructionIssues: InstructionIssues | null = null
      try {
        if (!review) {
          const loaded = await loadProjectInstructionsDetailed(workspacePath)
          projectInstructions = loaded.files
          const { truncated, unreadable } = loaded.issues
          if (truncated.length > 0 || unreadable.length > 0) instructionIssues = loaded.issues
        }
      } catch {
        // Instruction files are optional; a broken one must not stop the run.
      }
      if (instructionIssues) {
        const parts: string[] = []
        for (const entry of instructionIssues.truncated) {
          parts.push(`${entry.name} 超过 24 KB，只注入了开头部分（${entry.bytes} 字节）`)
        }
        for (const entry of instructionIssues.unreadable) {
          parts.push(`${entry.name} 无法读取（${entry.reason}）`)
        }
        this.emit({
          type: 'notice',
          level: 'warn',
          message: `项目指令文件未完整加载，本轮可能缺少这些约定：${parts.join('；')}。可把关键规则收紧到 24 KB 以内或改成普通文件。`,
        })
      }
      const skills = new SkillsService(workspacePath)
      let skillList: Awaited<ReturnType<SkillsService['load']>> = []
      try {
        skillList = review ? [] : await skills.load()
      } catch {
        // A broken skills directory must not stop the run.
      }
      const reviewModel = this.reviewModelName()
      // A read-only analysis must not inherit a plan left by earlier work: the
      // system prompt would tell it to keep that stale plan current.
      const analysisRun = review === null && isAnalysisRequest(prompt)
      // Ranking happens once here so the same ids can be recorded as injected;
      // a review run gets no project memory.
      const injectedMemory = review === null ? selectMemories(this.store.memory(workspacePath)) : []
      const system =
        review && session.review
          ? buildReviewSystemPrompt({
              scope: session.review,
              primaryRoot: workspacePath,
              topLevel,
              plan: session.plan,
              locale: this.store.uiLocale(),
            })
          : buildSystemPrompt({
              root: workspacePath,
              topLevel,
              memory: injectedMemory,
              profile,
              globalProfile,
              globalInstructions,
              // Thinking text follows the app/UI language; the answer keeps
              // following the user's language.
              locale: this.store.uiLocale(),
              plan: analysisRun ? null : session.plan,
              // Only the analysis rules (read-only, ~20 tool calls) are gated:
              // sending them on a change request was telling the model not to
              // edit files while the user asked for an edit.
              analysis: analysisRun,
              // A control message (resume / plan carry-on) exists to finish the
              // previous task, so the "earlier turns are closed" rule must not
              // be sent with it.
              continuation: Boolean(userStored?.control),
              selfUpdate: wantsSelfUpdate(prompt),
              projectInstructions,
              skills: skillList,
              dynamicTools: dynamicTools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                source: tool.source,
                risk: tool.risk,
                version: tool.approvedVersion ?? tool.version,
              })),
              shellMode: settings.shellMode,
              shellInterpreter: sandboxEnabled
                ? undefined
                : shellInterpreterLabel(settings.shellInterpreter),
              approvalMode: ctx.approvalMode,
              sandboxed: sandboxEnabled && settings.shellMode,
              fullAutonomy: autonomy.active,
              ...(learningEnabled && learning
                ? {
                    learning: {
                      hosts: learning.hosts,
                      summary: summarizeLearning(await readLearningLedger(workspacePath)),
                      // 如实反映本轮 shell 是否真能联网：只在隔离开关开着且沙箱生效时为 false。
                      shellNetwork: sandboxEnabled
                        ? sandboxNetworkFor(
                            learning,
                            settings.sandboxNetwork,
                            settings.learningShellIsolation,
                          )
                        : true,
                    },
                  }
                : {}),
              ...(() => {
                const quality = this.qualityPromptInput(workspacePath, learningEnabled)
                return quality ? { quality } : {}
              })(),
            })
      // Second extraction signal: a correction from the user is the moment a
      // durable constraint becomes visible, so ask for it to be captured — but
      // only after the corrected fact is verified, never as a guess.
      const correctionNote =
        review === null && looksLikeCorrection(prompt)
          ? [
              '',
              'User correction detected in this turn. Once the corrected fact is verified with a tool, save the durable part with the remember tool as one short sentence (what is true, not what happened). Do not save anything you have not confirmed in this run.',
            ].join('\n')
          : ''
      if (injectedMemory.length > 0) {
        void this.store
          .noteMemoryInjected(
            workspacePath,
            injectedMemory.map((entry) => entry.id),
            session.id,
          )
          .catch(() => undefined)
      }
      // Only the newest turns replay verbatim. Replaying a whole long session
      // kept its first instruction — often the largest user message — in every
      // prompt, and the model kept working on it instead of on the message the
      // user just sent. Older turns become one closed-work digest; the session
      // record itself is untouched.
      const replayed = collapseCompletedTurns(
        session.messages.filter(isReplayableMessage).map(toAgentMessage),
      )
      // The summary the last run wrote is the only compact form of the turns
      // that have already been folded away, and it cannot be rebuilt from the
      // stored transcript (which keeps every message). Re-injecting it is what
      // stops a long session from paying for the same summarizer call on every
      // turn. It is only used once turns are actually being folded: with a short
      // transcript there is nothing it stands in for, and it would duplicate
      // history the prompt still carries verbatim. Review runs keep their own
      // scoped prompt, so they neither write nor receive it.
      const storedSummary =
        review === null && replayed.collapsedTurns > 0
          ? this.store.contextSummary(sessionId)
          : null
      const summaryMessages: AgentMessage[] = storedSummary
        ? [
            {
              role: 'user',
              content: summaryMessageContent(storedSummary),
              contextSummary: true,
            },
          ]
        : []
      const messages: AgentMessage[] = [
        { role: 'system', content: `${system}${correctionNote}` },
        ...summaryMessages,
        ...replayed.messages,
      ]

      // Whether this run created or changed the plan. Only those turns get a
      // per-answer plan snapshot; unrelated follow-ups stay clean.
      let planTouched = false

      // 完全自主档的写边界：工作区之外只允许多改自身源码（自定义路径优先，
      // 否则就是打包脚本 / 安装后自带的 self-src）。文件工具与 shell 沙箱共用
      // 这一个值，免得「写文件能改、shell 改不了」这种漂移。
      const selfSourceRoot = !autonomy.active
        ? ''
        : settings.selfSourceMode === 'custom' && settings.selfSourceCustomPath.trim() !== ''
          ? settings.selfSourceCustomPath.trim()
          : this.packageRoot
      const sandboxWritableRoots = autonomy.active
        ? extraWritableRoots(workspacePath, selfSourceRoot)
        : []

      const host: ToolHost = {
        root: workspacePath,
        ...(review ? { roots: review.roots } : {}),
        ...(referenceRoots.length > 0 ? { referenceRoots } : {}),
        ...(autonomy.active ? { fullAutonomy: true } : {}),
        ...(selfSourceRoot !== '' ? { selfSourceRoot } : {}),
        sandbox: sandboxEnabled
          ? {
              // 完全自主档要求能联网：学习隔离在这里不再把网络关掉。
              network:
                autonomy.network === 'allow'
                  ? true
                  : sandboxNetworkFor(
                      learning,
                      settings.sandboxNetwork,
                      settings.learningShellIsolation,
                    ),
              // 沙箱默认只给工作区写权限；自身源码在工作区外时要显式加进来。
              ...(sandboxWritableRoots.length > 0
                ? { writableRoots: sandboxWritableRoots }
                : {}),
            }
          : null,
        shellInterpreter: settings.shellInterpreter,
        shellEnabled: settings.shellMode,
        ...(learning
          ? {
              learning: {
                policy: learning,
                research: (url: string) =>
                  fetchLearningSource({ root: workspacePath, url, policy: learning }),
                log: async (entry) => {
                  await appendLearningEntry(workspacePath, entry)
                  return summarizeLearning(await readLearningLedger(workspacePath))
                },
              },
            }
          : {}),
        ...(review ? {} : { processes }),
        ...(toolRegistry ? { toolRegistry } : {}),
        ...(review
          ? {}
          : {
              screenshotDir: join(this.userDataDir, 'screenshots'),
              listWindows: () => listCapturableWindows(),
              screenshot: async (request) => {
                if (ctx.controller.signal.aborted) throw new Error('Run cancelled')
                const shot = await captureScreenshot({
                  window: this.getWindow?.() ?? null,
                  saveDir: join(this.userDataDir, 'screenshots'),
                  request,
                })
                return {
                  ok: true,
                  output: `Captured ${shot.target} ${shot.width}x${shot.height} (${Math.round(
                    shot.bytes / 1024,
                  )} KB).${shot.path ? `\nSaved: ${shot.path}` : ''}`,
                  metadata: {
                    images: [shot.dataUrl],
                    screenshot: {
                      target: shot.target,
                      width: shot.width,
                      height: shot.height,
                      path: shot.path,
                    },
                  },
                }
              },
            }),
        remember: async (content, reason) => {
          const entry = await this.store.addMemory(
            workspacePath,
            content,
            'agent',
            ctx.runId,
            undefined,
            ctx.sessionId,
          )
          this.emit({ type: 'memory.changed', workspacePath })
          this.emit({
            type: 'notice',
            level: 'info',
            message: `Saved to project memory${reason ? `: ${reason}` : ''}`,
          })
          return { id: entry.id }
        },
        updatePlan: (update: PlanUpdate) => {
          planTouched = true
          const plan = { goal: update.goal, items: update.items, updatedAt: now() }
          void this.store
            .setPlan(sessionId, plan)
            .then(() => this.emit({ type: 'session.changed', sessionId, plan }))
            .catch(() => undefined)
        },
        addTodos: async (items) => {
          const pending = new Set(
            this.store
              .todos(sessionId)
              .filter((todo) => todo.status === 'pending')
              .map((todo) => todo.text),
          )
          const created: Array<{ id: string; text: string }> = []
          // addTodo unshifts, so add the last item first to keep the caller's order.
          for (const text of [...items].reverse()) {
            if (pending.has(text)) continue
            const todo = await this.store.addTodo(sessionId, text, 'agent')
            pending.add(todo.text)
            created.unshift({ id: todo.id, text: todo.text })
          }
          if (created.length > 0) {
            this.emit({ type: 'todos.changed', sessionId, todos: this.store.todos(sessionId) })
          }
          return created
        },
        scheduleTasks: createScheduleTaskBridge(this.store, sessionId, () =>
          this.emit({ type: 'scheduled.changed', sessionId }),
        ),
        proposeSelfUpdate: createSelfUpdateBridge({
          store: this.store,
          workspacePath,
          onProfileChanged: () => this.emit({ type: 'profile.changed', workspacePath }),
          explainDraft: (scope, path, profileId) => this.explainDraft(scope, path, profileId),
        }),
        explore: async (request, signal) => {
          const result = await runExploreSubagent({
            client: this.makeClient(undefined, sessionId),
            workspacePath,
            task: request.task,
            ...(request.path ? { scope: request.path } : {}),
            ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
            maxContextTokens: subagentContextTokens(settings.maxContextTokens, settings.model),
            locale: this.store.uiLocale(),
            // 完全自主档：只读探索也能读工作区之外（隐私路径仍在权限层被拒）。
            fullAutonomy: autonomy.active,
            signal,
          })
          delegations += 1
          delegatedSteps += result.steps
          delegatedSummaryChars += result.summary.length
          return `[只读探索 · ${result.steps} 步 · 结论 ${result.summary.length} 字符]\n${result.summary}`
        },
        subagent: async (request, signal) => {
          if (request.mode !== 'explore' && ctx.approvalMode !== 'auto') {
            throw new Error(
              '写文件的子智能体只在全部自动模式下可用；其他模式会绕过逐次审批，请直接执行或切换为全部自动。',
            )
          }
          const result = await runSubagent({
            client: this.makeClient(undefined, sessionId),
            workspacePath,
            mode: request.mode,
            task: request.task,
            ...(request.path ? { scope: request.path } : {}),
            ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
            maxContextTokens: subagentContextTokens(settings.maxContextTokens, settings.model),
            locale: this.store.uiLocale(),
            // Same switch as the parent's run_shell: turning the shell off must
            // not leave a whitelisted executor behind in the nested loop.
            shellEnabled: settings.shellMode,
            fullAutonomy: autonomy.active,
            signal,
          })
          const label =
            request.mode === 'general'
              ? '通用子智能体'
              : request.mode === 'toolsmith'
                ? '工具匠子智能体'
                : '只读子智能体'
          delegations += 1
          delegatedSteps += result.steps
          delegatedSummaryChars += result.summary.length
          return `[${label} · ${result.steps} 步 · 结论 ${result.summary.length} 字符]\n${result.summary}`
        },
        useSkill: async (name) => {
          const skill = skills.read(name)
          if (!skill) return null
          const resources =
            skill.resources.length > 0
              ? `\n\nResource files (read them with read_file if needed): ${skill.resources.join(', ')}`
              : ''
          return `# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}${resources}`
        },
        createSkill: async (request) => {
          const created = await writeSkill(workspacePath, request)
          // Reload so use_skill can read the new skill in this same run.
          skillList = await skills.reload()
          this.emit({
            type: 'notice',
            level: 'info',
            message: `${created.overwritten ? '已更新' : '已创建'}技能 ${created.name}（${created.path}）`,
          })
          return created
        },
        createMcpServer: async (request) => {
          const saved = await saveMcpServer(workspacePath, request)
          if (request.enable === false) {
            return { ...saved, enabled: false, tools: [] }
          }
          if (!mcp) {
            // Writing the config is useless while MCP is off, so the tool that
            // created the server also turns the switch on and says so.
            if (!settings.mcpEnabled) {
              await this.store.updateSettings({ mcpEnabled: true })
            }
            mcp = new McpService()
          }
          try {
            const added = await mcp.connectServer(workspacePath, saved.name)
            this.emit({
              type: 'notice',
              level: 'info',
              message: `已连接 MCP 服务 ${saved.name}（${added.length} 个工具）`,
            })
            return { ...saved, enabled: true, tools: added.map((tool) => tool.name) }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.emit({ type: 'notice', level: 'warn', message: `MCP ${saved.name} 连接失败：${message}` })
            return { ...saved, enabled: true, tools: [], error: message }
          }
        },
      }

      const reviewRuntime: ReviewRuntime | null = review
        ? {
            store: this.store,
            session,
            scope: review,
            model: reviewModel,
            record: async (report) => {
              await this.store.setReviewReport(sessionId, report)
              let memoryCount = 0
              for (const lesson of report.memoryLessons) {
                try {
                  await this.store.addMemory(workspacePath, lesson, 'reflection', ctx.runId)
                  memoryCount += 1
                } catch {
                  // A rejected lesson (secret/empty) must not fail the review.
                }
              }
              let profileVersion: number | undefined
              let summary: ProfileExplanation | undefined
              if (report.profileAddendum && report.profileRationale) {
                try {
                  const draft = await this.store.createProfileDraft(workspacePath, {
                    promptAddendum: report.profileAddendum,
                    rationale: report.profileRationale,
                    source: 'self',
                    evidence: this.store.evidence(workspacePath),
                  })
                  profileVersion = draft.version
                  // The reviewer wrote rule text, not a decision the user can
                  // read; add the plain-language summary while the run is still
                  // open, so the panel never shows a bare draft.
                  const explained = await this.explainDraft('workspace', workspacePath, draft.id)
                  summary = explained.explanation
                } catch {
                  // A rejected draft must not lose the report itself.
                }
              }
              if (memoryCount > 0) this.emit({ type: 'memory.changed', workspacePath })
              if (profileVersion !== undefined) this.emit({ type: 'profile.changed', workspacePath })
              this.emit({ type: 'session.changed', sessionId })
              return {
                memoryCount,
                ...(profileVersion !== undefined ? { profileVersion } : {}),
                ...(summary ? { profileSummary: summary } : {}),
              }
            },
          }
        : null

      // A read-only analysis should stop searching long before the normal
      // ceiling. Change requests keep the full budget.
      //
      // The ceiling is derived from the request itself instead of one global
      // number: an instruction listing five tasks gets room for five tasks, a
      // one-line fix does not. `stepBudget` then extends the allowance while the
      // run keeps producing new evidence and asks for a close-out when it stalls,
      // so a static cap no longer truncates work that is still making progress.
      const profileSteps = profile?.strategy.maxSteps
      const budget = planStepBudget({
        prompt,
        configured:
          profileSteps && profileSteps > 0
            ? Math.min(settings.maxSteps > 0 ? settings.maxSteps : profileSteps, profileSteps)
            : settings.maxSteps,
        analysis: analysisRun,
        review: Boolean(review),
        planItems: session.plan?.items.length ?? 0,
      })
      const maxSteps = budget.ceiling
      const temperature = review ? 0.1 : profile?.strategy.temperature ?? settings.temperature
      const client = review
        ? this.makeReviewClient()
        : this.makeClient(undefined, sessionId)
      // 会话模型可能被任务覆盖，分类器必须跟随本次真正使用的端点，
      // 否则会把别的模型名发给这个端点。
      const sessionModelName =
        review
          ? this.store.reviewModelTarget()?.model || settings.model
          : this.store.sessionModelTarget(sessionId)?.model || settings.model
      const classifierModel = sessionModelName
      let classifierClient: DeepSeekClient | null = null
      // The classifier only ever sees the trailing window of the transcript with
      // tool results stripped, so an identical prompt is the same question. A
      // long run re-runs the same test/edit commands many times; memoizing on
      // the exact prompt removes those round trips without changing a verdict.
      const classifier = createClassifierMemo((query) => {
        classifierClient ??= this.makeClassifierClient(query.model, sessionId)
        return classifyToolCall({ ...query, client: classifierClient })
      })
      const classifierTranscript = (): AgentMessage[] => {
        const window = CLASSIFIER_TRANSCRIPT_WINDOW
        if (produced.length >= window) return produced.slice(-window)
        const need = window - produced.length
        const history = session.messages
          .filter(isReplayableMessage)
          .slice(-need)
          .map(toAgentMessage)
        return [...history, ...produced]
      }
      const permissionPolicy = (
        tool: AgentToolDefinition,
        call: ToolCall,
      ): Promise<ToolPolicyResult> =>
        resolveToolPolicy({
          tool,
          call,
          review,
          approvalMode: () => ctx.approvalMode,
          systemAccess: ctx.systemAccess,
          workspacePath,
          settings,
          sandboxEnabled,
          learningEnabled,
          classify: classifier.classify,
          classifierModel,
          prompt,
          transcript: classifierTranscript,
          signal: ctx.controller.signal,
          onClassifierAllow: () => this.recordClassifierAllow(sessionId),
          onClassifierBlock: () => this.recordClassifierBlock(sessionId),
          onPauseAllAuto: async () => {
            ctx.approvalMode = 'manual'
            await this.store.updateSession(sessionId, { approvalMode: 'manual' })
            this.emit({ type: 'session.changed', sessionId })
            this.emit({
              type: 'notice',
              level: 'warn',
              message:
                '权限分类器连续拦截了多次操作，已暂停全部自动并切回“只读自动”；后续写入和命令会逐次询问你。',
            })
          },
        })
      const verificationHint = review
        ? ''
        : await detectCheckCommands(workspacePath).catch(() => '')
      // Review must not run workspace hooks: they can execute arbitrary commands
      // and would turn a read-only session into a side-effecting one.
      const hooks = new HookService(workspacePath, settings.hooksEnabled && !review)
      if (!review) await hooks.load().catch(() => undefined)
      const result = await runAgentLoop({
        model: client,
        messages,
        tools,
        pullTools,
        maxSteps,
        // Start lower than the ceiling and grow with evidence. Review runs keep a
        // fixed allowance (`extension: 0`), analysis keeps its early wrap-up.
        stepBudget: budget,
        // A budget of 0 means "no cap". Review runs keep their own small step
        // ceiling, so no separate token budget is applied there. 完全自主档下
        // 0 会被 autonomyPolicy 换成一份兜底预算，所以这里用它的值。
        maxTokens: review ? 0 : autonomy.active ? autonomy.tokenBudget : settings.maxTokens,
        maxContextTokens: effectiveContextTokens(
          settings.maxContextTokens,
          review ? reviewModel : sessionModelName,
        ),
        // Older tool output is compacted aggressively. The model usually needs
        // the last few results, not a replayed transcript; keeping 8 large
        // results (up to 48k chars each) dominated the context window. Analysis
        // and review keep one extra result because their conclusions must cite
        // file:line evidence gathered across several reads.
        keepRecentToolResults: review || analysisRun ? 5 : 3,
        maxToolOutputChars: 16_000,
        temperature,
        signal: ctx.controller.signal,
        requirePlan: review || analysisRun ? false : shouldRequirePlan(prompt),
        hasPlan: Boolean(session.plan && session.plan.items.length > 0),
        planReminderEvery: analysisRun ? 0 : 20,
        ...(analysisRun ? { wrapUpAt: 24 } : {}),
        // Normal runs used to hit the hard cap with no warning and then auto-
        // continue into another full budget. Give the model one turn before the
        // cap to close out with what is done and what is left; the analysis and
        // review paths have their own wrap-up rules.
        budgetWrapUp: !review && !analysisRun && maxSteps >= 20,
        // Independent reads are the cheapest step to batch: one model round
        // trip instead of four. The cap still bounds concurrent disk work.
        maxParallelReadTools: 8,
        screenshotFeedback: settings.screenshotFeedback,
        verificationGate: !review,
        verificationHint,
        // Names the project's own entry points when a command is not found.
        workspaceRoot: workspacePath,
        toolsmith: !review,
        summarize: (history, previousSummary, onUsage) =>
          summarizeConversation(
            client,
            history,
            ctx.controller.signal,
            previousSummary,
            onUsage,
          ),
        preTool: async (call, tool) => {
          const outcome = await hooks.beforeTool(call, tool, ctx.controller.signal)
          if (outcome.blocked) {
            this.emit({
              type: 'notice',
              level: 'warn',
              message: 'pre_tool hook 阻止了一次工具调用。',
            })
            return { blocked: true, output: outcome.output }
          }
          if (outcome.output) {
            this.emit({
              type: 'notice',
              level: 'info',
              message: `pre_tool hook: ${outcome.output.slice(0, 400)}`,
            })
          }
          return undefined
        },
        postEdit: async (call) => {
          const output = await hooks.afterEdit(call, ctx.controller.signal)
          if (output) {
            this.emit({
              type: 'notice',
              level: 'info',
              message: 'post_edit hook 已运行。',
            })
          }
          return output
        },
        emit: (event: LoopEvent) => {
          this.forwardLoopEvent(ctx, event, reasoningTurns, () => {
            toolCalls += 1
          }, () => {
            toolErrors += 1
          }, auditCall)
        },
        pullMessages: async () => {
          const pending = ctx.pendingSteering.filter((entry) => !entry.consumed)
          for (const entry of pending) entry.consumed = true
          return pending.map((entry) => entry.message)
        },
        policy: permissionPolicy,
        requestApproval: (request) => this.requestApproval(ctx, request),
        executeTool: async ({ call, signal }) => {
          if (review) {
            if (!reviewRuntime || !isReviewToolName(call.name)) {
              return {
                ok: false,
                output: '',
                error: '复盘会话是只读的，只能使用允许的读取与会话检索工具。',
              }
            }
            return executeReviewTool(call.name, call.arguments, host, signal, reviewRuntime)
          }
          // 第一个工具（含只读工具）执行前，运行前快照必须已经落定：这段等待通常
          // 已被首轮模型往返覆盖，只有工作区特别大时才会真正等一会儿。
          await ensureBaseline()
          if (
            call.name === RUN_SHELL &&
            settings.checkpointShell &&
            ctx.approvalMode !== 'plan'
          ) {
            const command =
              typeof call.arguments['command'] === 'string'
                ? call.arguments['command'].slice(0, 60)
                : ''
            const checkpointStartedAt = Date.now()
            await this.snapshot(
              ctx,
              `Shell 前：${command.replace(/\s+/g, ' ').trim()}`,
              'shell',
              this.store.session(sessionId)?.messages.length ?? ctx.checkpointMessageCount,
            )
            checkpointMs += Date.now() - checkpointStartedAt
          }
          if (call.name === REQUEST_SYSTEM_ACCESS) {
            return this.grantSystemAccess(ctx, call.arguments ?? {})
          }
          if (call.name === READ_EXECUTION_RECORDS) {
            return this.readExecutionRecords(ctx, call.arguments ?? {})
          }
          if (call.name === READ_SYSTEM_STRATEGY) {
            return this.readSystemStrategy(ctx, call.arguments ?? {}, {
              settings: this.store.settingsView(),
              skills: skillList,
              dynamicTools,
              globalInstructions,
              projectInstructions,
            })
          }
          if (mcp?.has(call.name)) {
            return mcp.call(call.name, call.arguments)
          }
          if (pluginTools?.has(call.name)) {
            return pluginTools.call(call.name, call.arguments ?? {})
          }
          const result = await executePilotTool(call.name, call.arguments, host, signal)
          // A write that just created a generated directory registers it before
          // the next snapshot, so that tree never joins a snapshot walk.
          const newDir =
            typeof result.metadata?.['newDir'] === 'string' ? result.metadata['newDir'] : ''
          if (newDir && this.checkpoints) {
            const excluded = this.checkpoints.noteEphemeralDir(ctx.workspacePath, newDir)
            if (excluded) {
              this.emit({
                type: 'notice',
                level: 'info',
                message: `新目录 ${excluded} 像是生成目录，已排除在回退点之外（可在设置→回退点里调整）。`,
              })
            }
          }
          return result
        },
      })
      await mcp?.dispose()
      mcp = null

      produced = result.produced
      steps = result.steps
      totalTokens = result.usage.totalTokens
      promptTokens = result.usage.promptTokens
      completionTokens = result.usage.completionTokens
      // Record the cache split and the serving model so the billing view can
      // price this run without re-reading the settings that may have changed.
      cacheHitTokens = result.usage.cacheHitTokens ?? 0
      cacheMissTokens =
        result.usage.cacheMissTokens ?? Math.max(0, result.usage.promptTokens - cacheHitTokens)
      usageModel = review ? reviewModel : sessionModelName
      finalContent = result.content
      if (result.status === 'completed') finalStatus = 'completed'
      else if (result.status === 'cancelled') finalStatus = ctx.paused ? 'paused' : 'cancelled'
      else if (result.status === 'max_steps') finalStatus = 'max_steps'
      else if (result.status === 'token_limit') {
        finalStatus = 'failed'
        finalError = result.error?.message ?? 'Token budget exhausted'
      } else {
        finalStatus = 'failed'
        finalError = result.error?.message ?? 'Agent run failed'
      }

      // A batch instruction is settled conservatively: an item still marked
      // in_progress may be the one the model abandoned when it answered, and
      // inferring done would report work that never happened.
      await this.settleSessionPlan(sessionId, finalStatus, { inferDone: budget.taskCount < 2 })

      // Snapshot after settling so the stored answer shows the terminal state
      // (no lingering spinner) even if a later turn replaces session.plan.
      const turnPlan = planTouched ? this.store.session(sessionId)?.plan ?? null : null
      const storedMessages = toStoredMessages(produced, reasoningTurns, ctx.runId, turnPlan)
      if (storedMessages.length > 0) {
        messagesHandled = true
        await this.store.addMessages(sessionId, storedMessages)
      }
      // Persist the compaction summary for the next run. A run that never
      // compacted has nothing to add, and the stored one is kept: it still
      // describes work that is already out of the prompt.
      if (review === null && result.summary) {
        await this.store
          .setContextSummary(sessionId, result.summary)
          .catch(() => undefined)
      }
      await this.store.finishRun(workspacePath, ctx.runId, {
        status: finalStatus,
        finishedAt: now(),
        steps,
        promptTokens,
        completionTokens,
        totalTokens,
        ...(usageModel ? { model: usageModel } : {}),
        cacheHitTokens,
        cacheMissTokens,
        ...(result.usageSteps.length > 0 ? { usageSteps: result.usageSteps } : {}),
        ...(delegations > 0 ? { delegations, delegatedSteps, delegatedSummaryChars } : {}),
        modelMs: Math.round(result.timings.modelMs),
        toolMs: Math.round(result.timings.toolMs),
        approvalMs: Math.round(result.timings.approvalMs),
        summarizeMs: Math.round(result.timings.summarizeMs),
        checkpointMs: Math.round(checkpointMs),
        toolCalls,
        toolErrors,
        filesChanged: result.filesChanged,
        checked: result.checked,
        ...(finalError ? { error: finalError } : {}),
      })
      this.store.setRunning(sessionId, false)
      this.store.setRunInfo(sessionId, null)
      // 暂停请求可能落在收尾窗口里（模型刚答完、还没写盘）：这时 finalStatus
      // 会是 completed，但用户确实按了暂停。暂停态必须保留，否则「继续」入口
      // 直接消失，而队列会被当成“任务已结束”推上来。
      await this.store.setPaused(
        sessionId,
        finalStatus === 'paused' || ctx.paused ? ctx.instruction || prompt : null,
      )
      this.active.delete(sessionId)
      this.closeDeltas(ctx)
      this.emit({ type: 'session.changed', sessionId })

      if (finalStatus === 'failed') {
        this.emit({
          type: 'run.failed',
          sessionId,
          runId: ctx.runId,
          code: 'AGENT_ERROR',
          message: finalError ?? 'Agent run failed',
        })
      } else {
        this.emit({
          type: 'run.completed',
          sessionId,
          runId: ctx.runId,
          status:
            finalStatus === 'completed'
              ? 'completed'
              : finalStatus === 'paused'
                ? 'paused'
                : finalStatus === 'cancelled'
                  ? 'cancelled'
                  : finalStatus === 'max_steps'
                    ? 'max_steps'
                    : 'token_limit',
          steps,
          usage: { promptTokens, completionTokens, totalTokens },
          durationMs: Date.now() - new Date(startedAt).getTime(),
        })
      }

      if (!ctx.controller.signal.aborted) {
        // The stop hook sees the final assistant message so rules and hooks can
        // judge the outcome. A `CONTINUE:` line asks for one more turn.
        const stopOutput = await hooks
          .stop(ctx.controller.signal, finalContent)
          .catch(() => null)
        if (stopOutput) {
          this.emit({
            type: 'notice',
            level: 'info',
            message: `stop hook: ${stopOutput.slice(0, 400)}`,
          })
        }
        stopDirective = extractContinueDirective(stopOutput)
      }

      // A user cancellation is not evidence of a bad approach; skip the
      // reflection call so stopping a run never spends more tokens. Review runs
      // already produce structured lessons, so they skip background reflection.
      if (!review && finalStatus !== 'cancelled' && finalStatus !== 'paused') {
        this.autoReflect(workspacePath, ctx.runId, prompt, produced)
      }
      if (!review && settings.autoEvolve) {
        // 自我进化是纯副线：它要读这个工作区的全部运行记录并生成草稿。
        // 抛出来的错只能记一条日志，不能变成未处理的 rejection 挂在收尾上。
        void this.maybeAutoEvolve(workspacePath).catch((error) => {
          this.emit({
            type: 'notice',
            level: 'warn',
            message: `自我进化跳过：${error instanceof Error ? error.message : String(error)}`,
          })
        })
      }

      const pending = ctx.pendingSteering.filter((entry) => !entry.consumed)
      if (
        finalStatus === 'completed' &&
        pending.length > 0 &&
        this.store.getApiKey() &&
        !this.active.has(sessionId)
      ) {
        const followPrompt = pending.map((entry) => entry.message.content).join('\n\n')
        const fresh = this.store.session(sessionId)
        if (fresh) {
          const next = this.newContext(fresh, fresh.approvalMode, followPrompt)
          this.active.set(sessionId, next)
          void this.execute(next, followPrompt, null, { skipUserMessage: true })
          return
        }
      }
      if (pending.length > 0) {
        this.emit({
          type: 'notice',
          level: 'warn',
          message:
            'An inserted message arrived after the task stopped and was not consumed. It is in the transcript; send it again to continue.',
        })
      }
      // A completed run that left plan items unfinished stopped early. In the
      // two execution modes, keep going once the project is done, bounded by
      // the same auto-continue limit. Never do this when the model asked the
      // user a question or requested a confirmation.
      const remainingPlan =
        this.store.session(sessionId)?.plan?.items.some((item) => item.status !== 'done') ?? false
      const asksUser = /(?:\?\s*$)|(?:请(?:你)?确认|需要你(?:确认|提供|选择|授权))/i.test(
        finalContent.trim(),
      )
      const executionMode = ctx.approvalMode === 'auto' || ctx.approvalMode === 'acceptEdits'
      const planContinues =
        finalStatus === 'completed' &&
        remainingPlan &&
        executionMode &&
        !asksUser &&
        // A leftover plan from earlier work must not turn a read-only analysis
        // into an automatic continuation loop.
        !analysisRun
      if (finalStatus === 'completed' && !planContinues) {
        this.autoContinueAttempts.delete(sessionId)
        this.clearAutoContinue(sessionId)
      }
      const fatalError =
        finalStatus === 'failed' && isFatalProviderError(result.error?.message ?? result.error)
      const autoEligible =
        (finalStatus === 'failed' ||
          (finalStatus === 'max_steps' && !analysisRun) ||
          planContinues) &&
        result.status !== 'token_limit' &&
        // A wrong key, an empty balance or a model the account cannot use fails
        // identically on every replay; auto-continue would only spend the same
        // tokens again (and, on 402, keep failing while the user is unaware).
        !fatalError &&
        !ctx.controller.signal.aborted
      if (fatalError) {
        this.autoContinueAttempts.delete(sessionId)
        this.clearAutoContinue(sessionId)
        this.emit({
          type: 'notice',
          level: 'error',
          message: `模型侧错误，重试不会改变结果，已停止自动继续：${(finalError ?? '').slice(0, 200)} ${FAILURE_ACTION_TEXT[failureAction(finalError) ?? 'config']}`,
        })
      }
      const autoScheduled =
        autoEligible &&
        this.scheduleAutoContinue(
          sessionId,
          planContinues
            ? '计划还有未完成项'
            : finalStatus === 'max_steps'
              ? '达到步数上限'
              : '任务执行失败',
          planContinues ? { planInstruction: PLAN_CONTINUE_PROMPT } : {},
        )
      // A stop hook that printed `CONTINUE: ...` gets one more turn, under the
      // same auto-continue cap, and only when nothing else already scheduled a
      // retry: two continuations on one run would double the token spend.
      const stopScheduled =
        !autoScheduled &&
        stopDirective !== null &&
        finalStatus === 'completed' &&
        !fatalError &&
        !ctx.controller.signal.aborted &&
        this.scheduleAutoContinue(sessionId, 'stop hook 要求继续', {
          instruction: stopDirective,
        })
      const continued = autoScheduled || stopScheduled
      // 暂停/停止由用户发起时队列必须原地等（见 queue-policy）：否则暂停后点
      // 「继续」的那一刻，队列里的任务已经占住了 run。
      if (
        shouldPromoteQueue({
          finalStatus,
          continued,
          pausedByUser: ctx.paused,
          stoppedByUser: ctx.stoppedByUser,
        })
      ) {
        // 推进队列属于收尾的副线：读不到队列只该记一条日志，不能让本轮收尾炸掉。
        void this.promoteNext(sessionId).catch((error) => {
          this.emit({
            type: 'notice',
            level: 'warn',
            message: `队列推进失败：${error instanceof Error ? error.message : String(error)}`,
          })
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finalError = message
      // Keep the work the model and tools already completed visible even when
      // the run aborts between steps (network error, provider 5xx, etc.).
      if (!messagesHandled) {
        const storedMessages = toStoredMessages(produced, reasoningTurns, ctx.runId)
        if (storedMessages.length > 0) {
          messagesHandled = true
          try {
            await this.store.addMessages(sessionId, storedMessages)
          } catch {
            // Preserve the original failure; a save retry happens on next write.
          }
        }
      }
      if (runStarted) {
        await this.settleSessionPlan(sessionId, 'failed')
        try {
          await this.store.finishRun(workspacePath, ctx.runId, {
            status: 'failed',
            finishedAt: now(),
            steps,
            promptTokens,
            completionTokens,
            totalTokens,
            ...(usageModel ? { model: usageModel } : {}),
            cacheHitTokens,
            cacheMissTokens,
            ...(delegations > 0 ? { delegations, delegatedSteps, delegatedSummaryChars } : {}),
            ...(checkpointMs > 0 ? { checkpointMs: Math.round(checkpointMs) } : {}),
            toolCalls,
            toolErrors,
            error: message,
          })
        } catch {
          // Persistence failure must not hide the original error.
        }
      }
      this.store.setRunning(sessionId, false)
      this.store.setRunInfo(sessionId, null)
      try {
        await this.store.setPaused(sessionId, ctx.paused ? ctx.instruction || prompt : null)
      } catch {
        // Pause metadata is best-effort; the failure itself must stay visible.
      }
      this.active.delete(sessionId)
      this.closeDeltas(ctx)
      this.emit({ type: 'session.changed', sessionId })
      this.emit({
        type: 'run.failed',
        sessionId,
        runId: ctx.runId,
        code: 'AGENT_ERROR',
        message,
      })
      // Hard failures (provider errors, aborts between steps) still carry
      // evidence worth learning from. The run record now exists, so reflect on
      // it unless the user stopped the run themselves.
      if (
        runStarted &&
        !ctx.controller.signal.aborted &&
        this.store.session(sessionId)?.kind !== 'review'
      ) {
        this.autoReflect(workspacePath, ctx.runId, prompt, produced)
      }
      const fatalError = isFatalProviderError(error)
      const autoScheduled =
        !fatalError &&
        !ctx.paused &&
        !ctx.controller.signal.aborted &&
        !/token/i.test(message) &&
        this.scheduleAutoContinue(sessionId, '运行时出错')
      if (fatalError) {
        this.autoContinueAttempts.delete(sessionId)
        this.clearAutoContinue(sessionId)
        this.emit({
          type: 'notice',
          level: 'error',
          message: `模型侧错误，重试不会改变结果，已停止自动继续：${message.slice(0, 200)} ${FAILURE_ACTION_TEXT[failureAction(message) ?? 'config']}`,
        })
      }
      if (
        shouldPromoteQueue({
          finalStatus: 'failed',
          continued: autoScheduled,
          pausedByUser: ctx.paused,
          stoppedByUser: ctx.stoppedByUser,
        })
      ) {
        void this.promoteNext(sessionId).catch((error) => {
          this.emit({
            type: 'notice',
            level: 'warn',
            message: `队列推进失败：${error instanceof Error ? error.message : String(error)}`,
          })
        })
      }
    } finally {
      if (mcp) await mcp.dispose().catch(() => undefined)
      if (pluginTools) {
        // 插件只收到“这一轮结束了”这一事实；失败原因也可能被它记录下来。
        await pluginTools
          .emit('run.completed', {
            sessionId,
            runId: ctx.runId,
            status: finalStatus,
            error: finalError ?? null,
            steps,
            toolCalls,
          })
          .catch(() => undefined)
        await pluginTools.dispose()
        pluginTools = null
      }
      await processes.stopAll().catch(() => undefined)
      for (const callId of [...ctx.pendingApprovals]) {
        this.settleApproval(callId, { approved: false, reason: 'Run ended', decidedBy: 'interrupted' })
      }
      void finalContent
    }
  }

  /**
   * 完全自主档的审计：越界读取、自身配置写入、无人授权、无人值守构建。
   *
   * 只记录元数据（工具名 + 一句摘要 + 当次预算），不记文件内容、命令原文或输出；
   * `app-log.ts` 写盘前还会再按 `SENSITIVE_KEY` 做一次脱敏。
   */
  private auditAutonomy(
    ctx: ActiveRun,
    input: {
      kind: AutonomyAuditKind
      tool: string
      detail: string
      settings: { maxTokens: number; maxSteps: number }
    },
  ): void {
    const entry = autonomyAuditEntry({
      kind: input.kind,
      tool: input.tool,
      detail: input.detail,
      budget: Number(input.settings.maxTokens ?? 0),
      steps: Number(input.settings.maxSteps ?? 0),
    })
    writeAppLog({
      ...entry,
      detail: { ...entry.detail, sessionId: ctx.sessionId, runId: ctx.runId },
    })
  }

  private deltaKey(ctx: ActiveRun): string {
    return `${ctx.sessionId}:${ctx.runId}`
  }

  private queueDelta(ctx: ActiveRun, kind: 'message' | 'reasoning', text: string): void {
    if (!text) return
    const key = this.deltaKey(ctx)
    let coalescer = this.deltaBuffers.get(key)
    if (!coalescer) {
      coalescer = createDeltaCoalescer({
        intervalMs: DELTA_FLUSH_INTERVAL_MS,
        emit: (deltaKind, burst) =>
          this.emit({
            sessionId: ctx.sessionId,
            runId: ctx.runId,
            type: deltaKind === 'message' ? 'message.delta' : 'reasoning.delta',
            text: burst,
          }),
      })
      this.deltaBuffers.set(key, coalescer)
    }
    coalescer.push(kind, text)
  }

  /** Emit whatever text is buffered for this run, in message-then-reasoning order. */
  private flushDeltas(ctx: ActiveRun): void {
    this.deltaBuffers.get(this.deltaKey(ctx))?.flush()
  }

  /** Flush the tail of the stream and forget the buffer for this run. */
  private closeDeltas(ctx: ActiveRun): void {
    const key = this.deltaKey(ctx)
    const coalescer = this.deltaBuffers.get(key)
    if (!coalescer) return
    coalescer.dispose()
    this.deltaBuffers.delete(key)
  }

  /**
   * The model often ends a run with the last plan item still in_progress.
   * Settle it once the run reaches a terminal state so the UI cannot keep
   * showing a spinner for a finished task.
   */
  private async settleSessionPlan(
    sessionId: string,
    status: RunStatus,
    options: { inferDone?: boolean } = {},
  ): Promise<void> {
    const current = this.store.session(sessionId)?.plan
    if (!current) return
    const next = settlePlan(current, status, now(), options)
    if (!next) return
    try {
      await this.store.setPlan(sessionId, next)
      this.emit({ type: 'session.changed', sessionId, plan: next })
    } catch {
      // Plan cleanup is best-effort and must not fail the run itself.
    }
  }

  private forwardLoopEvent(
    ctx: ActiveRun,
    event: LoopEvent,
    reasoningTurns: string[],
    countCall: () => void,
    countError: () => void,
    onCall?: (call: { name: string; arguments: Record<string, unknown> }, risk: string) => void,
  ): void {
    const base = { sessionId: ctx.sessionId, runId: ctx.runId }
    // Anything that is not a raw token must arrive after the text produced so
    // far, so a buffered burst is flushed before it.
    if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') {
      this.flushDeltas(ctx)
    }
    switch (event.type) {
      case 'step.started':
        this.emit({ ...base, type: 'step.started', step: event.step })
        return
      case 'message.started':
        this.emit({ ...base, type: 'message.started' })
        return
      case 'message.delta':
        this.queueDelta(ctx, 'message', event.text)
        return
      case 'reasoning.delta':
        this.queueDelta(ctx, 'reasoning', event.text)
        return
      case 'message.completed':
        reasoningTurns.push(event.reasoning)
        return
      case 'tool.call':
        countCall()
        onCall?.(event.call, event.risk)
        this.emit({ ...base, type: 'tool.call', call: event.call, risk: event.risk })
        return
      case 'tool.approval_required': {
        const timeout = this.approvalTimeout()
        this.emit({
          ...base,
          type: 'tool.approval_required',
          call: event.call,
          risk: event.risk,
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.rule ? { rule: event.rule } : {}),
          ...(timeout.expiresAt ? { expiresAt: timeout.expiresAt } : {}),
        })
        return
      }
      case 'tool.approval_resolved':
        this.emit({
          ...base,
          type: 'tool.approval_resolved',
          callId: event.call.id,
          name: event.call.name,
          approved: event.approved,
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.decidedBy ? { decidedBy: event.decidedBy } : {}),
        })
        return
      case 'tool.result':
        if (!event.result.ok) countError()
        this.emit({
          ...base,
          type: 'tool.result',
          callId: event.call.id,
          name: event.call.name,
          result: event.result,
        })
        return
      case 'context.compacted':
        this.emit({
          ...base,
          type: 'context.compacted',
          droppedMessages: event.droppedMessages,
          compactedResults: event.compactedResults,
          estimatedTokens: event.estimatedTokens,
        })
        return
      case 'notice':
        this.emit({ type: 'notice', level: event.level, message: event.message })
        return
      case 'usage':
        return
      default:
        return
    }
  }

  /**
   * Record the user's approval as a run-scoped, expiring, read-only grant.
   * The approval itself already happened in the loop; this only stores the
   * scope so later reads do not prompt again for the same data.
   */
  private grantSystemAccess(ctx: ActiveRun, args: Record<string, unknown>): ToolResult {
    try {
      const request = parseAccessRequest(args)
      const nowMs = Date.now()
      const previous =
        ctx.systemAccess && ctx.systemAccess.expiresAt > nowMs ? ctx.systemAccess : undefined
      const scopes = [...new Set([...(previous?.scopes ?? []), ...request.scopes])]
      const allWorkspaces = Boolean(previous?.allWorkspaces || request.allWorkspaces)
      const expiresAt = nowMs + request.minutes * 60_000
      ctx.systemAccess = {
        id: randomUUID().slice(0, 8),
        scopes,
        allWorkspaces,
        grantedAt: nowMs,
        expiresAt,
      }
      this.emit({
        type: 'notice',
        level: 'info',
        message: `已授权本次运行读取 ${request.scopes.join(' + ')}（${
          request.allWorkspaces ? '全部工作区' : '当前工作区'
        }），有效至 ${new Date(expiresAt).toLocaleTimeString()}。`,
      })
      return {
        ok: true,
        output: [
          `Access granted: grant=${ctx.systemAccess.id}; scopes=${scopes.join(', ')}; workspaces=${
            allWorkspaces ? 'all' : 'current'
          }; expires=${new Date(expiresAt).toISOString()}.`,
          scopes.includes('execution_records')
            ? 'Run records: call read_execution_records (aggregate statistics, failures, slow runs, or one runId).'
            : '',
          scopes.includes('system_strategy')
            ? 'Strategy: call read_system_strategy (limits, approval policy, checkpoints, profiles, evolution, skills, tools, memory).'
            : '',
          `Purpose recorded: ${request.purpose}`,
          'The grant is read-only and ends with this run. To change anything, use propose_self_update (draft) or remember; the user activates drafts.',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private requireSystemGrant(
    ctx: ActiveRun,
    scope: 'execution_records' | 'system_strategy',
    allWorkspaces: boolean,
  ): SystemAccessGrant {
    if (!ctx.systemAccess) {
      throw new Error('没有系统信息授权。请先调用 request_system_access，等用户批准后再读取。')
    }
    if (ctx.systemAccess.expiresAt <= Date.now()) {
      throw new Error('系统信息授权已过期。请重新调用 request_system_access。')
    }
    if (!grantCovers(ctx.systemAccess, [scope], allWorkspaces)) {
      throw new Error(
        allWorkspaces
          ? '当前授权不包含全部工作区。请重新申请并把 workspaces 设为 all。'
          : '当前授权不包含这项数据。请重新申请对应的 scopes。',
      )
    }
    return ctx.systemAccess
  }

  private readExecutionRecords(ctx: ActiveRun, args: Record<string, unknown>): ToolResult {
    try {
      const grant = this.requireSystemGrant(ctx, 'execution_records', args['workspace'] === 'all')
      return {
        ok: true,
        output: buildExecutionRecordsReport(this.store, {
          workspacePath: ctx.workspacePath,
          grant,
          args,
        }),
      }
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private readSystemStrategy(
    ctx: ActiveRun,
    args: Record<string, unknown>,
    context: {
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
    },
  ): ToolResult {
    try {
      this.requireSystemGrant(ctx, 'system_strategy', false)
      return {
        ok: true,
        output: buildSystemStrategyReport(this.store, {
          workspacePath: ctx.workspacePath,
          settings: context.settings,
          skills: context.skills,
          dynamicTools: context.dynamicTools,
          globalInstructions: context.globalInstructions,
          projectInstructions: context.projectInstructions,
          args,
        }),
      }
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private requestApproval(ctx: ActiveRun, request: ApprovalRequest): Promise<{
    approved: boolean
    reason?: string
    decidedBy?: 'user' | 'timeout' | 'interrupted'
  }> {
    return new Promise((resolve) => {
      const callId = request.call.id
      if (ctx.controller.signal.aborted) {
        resolve({ approved: false, reason: 'Run cancelled', decidedBy: 'interrupted' })
        return
      }
      const timeout = this.approvalTimeout()
      let timer: NodeJS.Timeout | undefined
      if (timeout.ms > 0) {
        timer = setTimeout(() => {
          const settled = this.settleApproval(callId, {
            approved: false,
            reason: `审批超时（${timeout.label}），已自动拒绝；可以继续任务后再试。`,
            decidedBy: 'timeout',
          })
          if (settled) {
            this.emit({
              type: 'notice',
              level: 'warn',
              message: `审批等待超过 ${timeout.label}，本次工具调用已自动拒绝。`,
            })
          }
        }, timeout.ms)
        timer.unref?.()
      }
      this.pendingApprovals.set(callId, {
        resolve,
        run: ctx,
        view: {
          callId,
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          tool: request.tool.name,
          risk: request.tool.risk,
          arguments: request.arguments,
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.rule ? { rule: request.rule } : {}),
          ...(timeout.expiresAt ? { expiresAt: timeout.expiresAt } : {}),
        },
        ...(timer ? { timer } : {}),
      })
      ctx.pendingApprovals.add(callId)
    })
  }

  private async promoteNext(sessionId: string): Promise<void> {
    if (this.active.has(sessionId)) return
    const session = this.store.session(sessionId)
    if (!session || session.queue.length === 0) return
    // 会话停在「等用户继续」的状态时队列不自动开始。这是用户按暂停/停止后的
    // 显式意图，任何收尾竞态都不该越过它；入口在队列面板的「执行」按钮上。
    if (session.paused) return
    if (!this.store.getApiKey()) {
      this.emit({
        type: 'notice',
        level: 'error',
        message: 'A queued task is waiting, but no API key is configured.',
      })
      return
    }
    const task = session.queue[0]
    if (!task) return
    const queue = session.queue.slice(1)
    await this.store.setQueue(sessionId, queue)
    this.emit({ type: 'queue.changed', sessionId, queue })
    const fresh = this.store.session(sessionId)
    if (!fresh) return
    const ctx = this.newContext(fresh, fresh.approvalMode, task.content)
    this.active.set(sessionId, ctx)
    try {
      const stored = storedUser(task.content, ctx.runId)
      await this.store.addMessage(sessionId, stored)
      this.emit({ type: 'session.changed', sessionId })
      void this.execute(ctx, task.content, stored)
    } catch (error) {
      this.active.delete(sessionId)
      this.emit({
        type: 'notice',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Post-run reflection grounded in the actual failure text. Fire-and-forget:
   * a reflection failure must never change the run outcome.
   */
  private autoReflect(
    workspacePath: string,
    runId: string,
    prompt: string,
    produced: AgentMessage[],
  ): void {
    if (!this.store.settings().autoReflect) return
    const transcript = reflectionFromProduced(prompt, produced)
    void this.evolution
      .reflect(workspacePath, runId, false, transcript, formatToolFailures(produced))
      .then((entries) => {
        if (entries.length > 0) {
          this.emit({ type: 'memory.changed', workspacePath })
        }
      })
      .catch(() => undefined)
  }

  private async maybeAutoEvolve(workspacePath: string): Promise<void> {
    if (this.evolving.has(workspacePath)) return
    const policy = this.store.evolutionPolicy()
    const detail = this.store.workspaceDetail(workspacePath)
    const completed = detail.runs.filter((run) => run.status !== 'running')
    if (completed.length < policy.minRuns) return
    const lastCycle = detail.evolution.cycles[0]
    const since = lastCycle
      ? completed.filter((run) => run.startedAt.localeCompare(lastCycle.startedAt) > 0).length
      : completed.length
    if (since < policy.cooldownRuns) return
    this.evolving.add(workspacePath)
    try {
      const cycle = await this.evolution.runCycle(workspacePath, 'auto')
      this.emit({ type: 'evolution.changed', workspacePath })
      if (cycle.activated) this.emit({ type: 'profile.changed', workspacePath })
      this.emit({
        type: 'notice',
        level: cycle.status === 'failed' ? 'warn' : 'info',
        message: `Pilot 自我进化：${cycle.summary}`,
      })
    } catch (error) {
      this.emit({
        type: 'notice',
        level: 'warn',
        message: `Automatic self-optimization skipped: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      this.evolving.delete(workspacePath)
    }
  }

  /**
   * Turn a recorded review report into a normal coding session. The report is
   * passed as a lead to verify, not as proof, and the new session uses the
   * regular approval/path-jail rules for its primary workspace.
   */
  async handoffReview(sessionId: string): Promise<Session> {
    const review = this.store.session(sessionId)
    if (!review || review.kind !== 'review' || !review.review) {
      throw new Error('这不是复盘会话')
    }
    if (!review.reviewReport) {
      throw new Error('复盘还没有生成结构化报告，先完成评估再交接修复。')
    }
    const prompt = buildFixPrompt(review)
    const title = `修复：${review.reviewReport.summary.replace(/\s+/g, ' ').trim().slice(0, 40) || '复盘问题'}`
    const created = await this.store.createSession(review.workspacePath, { title })
    try {
      await this.sendMessage(created.id, prompt, 'queue')
    } catch (error) {
      await this.store.deleteSession(created.id)
      throw error
    }
    return this.store.session(created.id)!
  }

  async shutdown(): Promise<void> {
    for (const timer of this.autoContinueTimers.values()) clearTimeout(timer)
    this.autoContinueTimers.clear()
    for (const ctx of this.active.values()) {
      ctx.controller.abort()
      for (const callId of [...ctx.pendingApprovals]) {
        this.settleApproval(callId, { approved: false, reason: 'Application closing', decidedBy: 'interrupted' })
      }
    }
  }

  getEstimatedPrompt(sessionId: string): number {
    const session = this.store.session(sessionId)
    if (!session) return 0
    return estimateTokens(session.messages.map((message) => message.content).join('\n'))
  }

  /** Exposed only for diagnostics; no transcript contents are returned. */
  activeRun(sessionId: string): { runId: string; startedAt: string } | null {
    const ctx = this.active.get(sessionId)
    return ctx ? { runId: ctx.runId, startedAt: ctx.startedAt } : null
  }

  /** Pending tool approvals, used by the companion UI to recover after reconnect. */
  pendingApprovalList(sessionId?: string): SharedApprovalRequest[] {
    return [...this.pendingApprovals.values()]
      .filter((entry) => !sessionId || entry.view.sessionId === sessionId)
      .map((entry) => entry.view)
  }
}

export type { ToolCall, ToolResult }

/** One line describing a plugin's `host.emit` payload without dumping it. */
function summarizePluginPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return ''
  try {
    const text = JSON.stringify(payload)
    return text && text !== '{}' ? `：${text.slice(0, 200)}` : ''
  } catch {
    return ''
  }
}
