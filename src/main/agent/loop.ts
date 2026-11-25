import { detectEntryPoints, isVerificationCommand, looksLikeTestOutput } from './checks'
import { isDeliverableText } from '../../shared/deliverable'
import {
  COMPACTED_MARKER,
  CURRENT_TASK_HEADER,
  EARLIER_TASK_HEADER,
  EARLIER_WORK_HEADER,
  contentTokens,
  estimateTokens,
  fitMessages,
  messagesTokens,
  stripSummaryFraming,
  summaryMessageContent,
  truncateMiddle,
} from './context'
import type {
  AgentMessage,
  AgentToolDefinition,
  AgentUsage,
  RunUsageSample,
  ToolCall,
  ToolResult,
} from '../../shared/types'

import type {
  ApprovalDecision,
  LoopOptions,
  LoopResult,
  LoopStatus,
  ModelResponse,
  ToolPolicyDecision,
  ToolPolicyResult,
} from './loop/types'
import { MAX_USAGE_SAMPLES } from './loop/types'
import {
  MAX_VERIFICATION_REMINDERS,
  canExtend,
  createProgressState,
  extendLimit,
  needsItemRotation,
  noteStepObservations,
  shouldStallCloseOut,
  type StepBudget,
  type StepObservation,
} from '../../shared/step-budget'

export type {
  AgentTimings,  ApprovalDecision,
  ApprovalRequest,
  LoopEvent,
  LoopOptions,
  LoopResult,
  LoopStatus,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ToolExecution,
  ToolPolicyDecision,
  ToolPolicyResult,
} from './loop/types'

const ZERO_USAGE: AgentUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
const MAX_OUTPUT_CONTINUATIONS = 3
const CONTINUE_OUTPUT_PROMPT =
  'Your previous message was cut off by the model output limit. Continue from the exact character where it stopped. Do not repeat anything you already wrote and do not add a preamble.'
const EMPTY_RESPONSE_PROMPT =
  'Your last turn returned no visible text and no tool call. Reply now with your actual answer, or call the tool you need.'

const REPLAYABLE_READS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'get_file_info',
  'repo_map',
  'git_log',
  'git_diff',
  'git_status',
  'git_show',
])

function addUsage(total: AgentUsage, next: AgentUsage | undefined): AgentUsage {
  if (!next) return total
  const cacheHitTokens = Math.max(
    0,
    (total.cacheHitTokens ?? 0) + (next.cacheHitTokens ?? 0),
  )
  const cacheMissTokens = Math.max(
    0,
    (total.cacheMissTokens ?? 0) + (next.cacheMissTokens ?? 0),
  )
  return {
    promptTokens: total.promptTokens + Math.max(0, next.promptTokens || 0),
    completionTokens: total.completionTokens + Math.max(0, next.completionTokens || 0),
    totalTokens: total.totalTokens + Math.max(0, next.totalTokens || 0),
    ...(cacheHitTokens + cacheMissTokens > 0 ? { cacheHitTokens, cacheMissTokens } : {}),
  }
}

function normalizeUsage(usage: AgentUsage | undefined): AgentUsage {
  if (!usage) return { ...ZERO_USAGE }
  const total = usage.totalTokens || usage.promptTokens + usage.completionTokens
  return {
    promptTokens: Math.max(0, usage.promptTokens || 0),
    completionTokens: Math.max(0, usage.completionTokens || 0),
    totalTokens: Math.max(0, total),
    ...(usage.cacheHitTokens !== undefined
      ? { cacheHitTokens: Math.max(0, usage.cacheHitTokens) }
      : {}),
    ...(usage.cacheMissTokens !== undefined
      ? { cacheMissTokens: Math.max(0, usage.cacheMissTokens) }
      : {}),
  }
}

function abortError(): Error {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message === 'This operation was aborted' ||
      error.message.toLowerCase().includes('aborted'))
  )
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function callKey(call: ToolCall): string {
  return `${call.name}:${stable(call.arguments ?? {})}`
}

function toolMessage(
  call: ToolCall,
  result: ToolResult,
  maxChars: number,
  hint?: string,
): AgentMessage {
  // A failed command usually explains itself on stdout/stderr (test failures,
  // compiler errors, stack traces). Dropping that output leaves the model with
  // only "exit code 1" and forces blind retries, so keep both parts.
  const output = result.output?.trim()
  const failure = result.error || 'tool execution failed'
  const body = result.ok
    ? result.output || '(no output)'
    : output
      ? `ERROR: ${failure}\n\n${output}`
      : `ERROR: ${failure}`
  const content = truncateMiddle(body, maxChars)
  return {
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    // Appended after truncation so a long log cannot push the hint out.
    content: hint ? `${content}\n\n${hint}` : content,
    isError: !result.ok,
  }
}

function decisionOf(
  raw: ToolPolicyDecision | ToolPolicyResult | undefined,
): ToolPolicyDecision {
  if (!raw) return 'ask'
  return typeof raw === 'string' ? raw : raw.decision
}

function policyMeta(
  raw: ToolPolicyDecision | ToolPolicyResult | undefined,
): { reason?: string; rule?: string } {
  if (!raw || typeof raw === 'string') return {}
  return {
    ...(raw.reason ? { reason: raw.reason } : {}),
    ...(raw.rule ? { rule: raw.rule } : {}),
  }
}

/** Run `worker` over `items` with at most `limit` in flight, preserving result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const count = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: count }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await worker(item, index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Runs a complete agent turn: model -> tool calls -> results -> model, until
 * the model answers without tools, a limit is reached, or the user cancels.
 * The loop is transport- and UI-agnostic; callers supply the model and tools.
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  // A dynamic budget replaces the static cap: `maxSteps` here is the *current*
  // allowance, which grows as the run keeps producing new evidence. `stepCeiling`
  // is the real stop. Without a budget the old fixed behaviour is unchanged.
  const stepBudget: StepBudget | undefined = options.stepBudget
  const stepCeiling = Math.max(
    1,
    stepBudget ? stepBudget.ceiling : (options.maxSteps ?? 200),
  )
  let maxSteps = Math.max(
    1,
    stepBudget ? Math.min(stepBudget.initial, stepCeiling) : stepCeiling,
  )
  const progress = createProgressState()
  let stallCloseOutSent = false
  let stepObservations: StepObservation[] = []
  const maxTokens = options.maxTokens ?? 0
  const maxToolOutputChars = Math.max(1_000, options.maxToolOutputChars ?? 48_000)
  const emit = options.emit ?? (() => undefined)
  const signal = options.signal
  const toolSignal = signal ?? new AbortController().signal
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  let toolDefs = options.tools
  const maxContextTokens = Math.max(0, options.maxContextTokens ?? 0)
  const keepRecentToolResults = Math.max(2, options.keepRecentToolResults ?? 8)
  let toolsTokens = options.tools.length ? estimateTokens(JSON.stringify(options.tools)) : 0
  let messageBudget = maxContextTokens > 0 ? Math.max(500, maxContextTokens - toolsTokens) : 0
  const planTool = options.planToolName ?? 'update_plan'
  const maxParallelReadTools = Math.max(
    1,
    Math.min(8, Math.round(options.maxParallelReadTools ?? 8)),
  )
  const summaryThreshold = Math.min(
    0.95,
    Math.max(0.5, options.contextSummaryThreshold ?? 0.75),
  )

  let messages: AgentMessage[] = [...options.messages]
  // A multi-task instruction gets the discipline that splitting it into several
  // turns would have imposed: one item at a time, each closed out with its own
  // evidence before the next starts. Without this, a five-task prompt tends to
  // be worked on in five interleaved threads, and none of them finishes.
  if (stepBudget && stepBudget.taskCount >= 2) {
    messages.push({
      role: 'user',
      internal: true,
      content:
        `[分批执行] 本轮指令包含约 ${stepBudget.taskCount} 个独立任务。按拆分执行的同一套纪律处理：` +
        '用 update_plan 为每一项列一条（不要合并，也不要额外扩张）；' +
        // 一次发给五条时，顺序是模型自己定的：拆分执行时这份顺序由用户在每一轮里
        // 给出，单轮批量没有这个输入。不写这一条，模型会按收到的编号排（实测见
        // tests/plan-order.test.ts 注释），于是「先改依赖、再改被它影响的」这种
        // 真实前置关系被忽略。默认保序是故意的：用户编号常自带优先级，重排只在
        // 依赖确定时发生，且必须说明原因。
        '顺序按依赖而不是按收到的编号：别的项要等它的放前面，互不依赖的保持原顺序，顺序与指令不同就在 goal 里说明原因；' +
        '一次只推进一项，当前项验证通过就标记 done 再进入下一项；' +
        '不要在不同任务之间来回切换上下文。' +
        '全部任务都处理完后，收尾报告里逐项给出「已完成（怎么验证的）/ 未完成（缺什么）」。',
    })
  }
  const produced: AgentMessage[] = []
  const priorReads = new Map<string, { callId: string; mutationSeq: number }>()
  const decisionCache = new Map<string, ToolPolicyDecision | ToolPolicyResult>()
  let mutationSeq = 0

  // Reads from earlier user turns remain in the transcript. Remember them so a
  // new run can re-read the file, compare the result, and reuse the earlier
  // output when nothing changed instead of paying for the same content twice.
  // The comparison is against the file system, so shell mutations between runs
  // do not invalidate a genuinely unchanged read.
  const historicalReads = new Map<string, { callId: string; messageIndex: number }>()
  {
    const readCalls = new Map<string, ToolCall>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const call of message.toolCalls ?? []) {
        if (REPLAYABLE_READS.has(call.name)) readCalls.set(call.id, call)
      }
    }
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!
      if (message.role !== 'tool' || message.isError || !message.toolCallId) continue
      const call = readCalls.get(message.toolCallId)
      if (!call) continue
      const content = message.content ?? ''
      if (!content || content.startsWith(COMPACTED_MARKER) || content.startsWith('[重复读取已省略]')) {
        continue
      }
      historicalReads.set(callKey(call), { callId: call.id, messageIndex: index })
    }
  }
  let usage: AgentUsage = { ...ZERO_USAGE }
  let lastContent = ''
  let answer = ''
  let answerReasoning = ''
  let answerMessage: AgentMessage | null = null
  // Set once the model has delivered a report-shaped answer. The verification
  // gate reads it: past that point asking for a check no longer prevents an
  // unverified claim, it only makes the model re-open finished work.
  let deliveredReport = false
  let continuations = 0
  let step = 0
  let planSeen = options.hasPlan === true
  let planGateUsed = false
  let lastPlanStep = 1
  let lastPlanReminderStep = 0
  let wrapUpSent = false
  let closeOutSent = false
  let dirty = false
  let checkRan = false
  // One reminder per task item, not one per run: a batch that edits for task 1,
  // checks it, then edits for task 2 must be asked again, exactly as five
  // separate turns would have been. A single request keeps the old behaviour.
  // Capped: every reminder is an extra model request, and a write re-arms the
  // gate, so an unchecked batch of twelve items would otherwise spend a tenth
  // of its steps on the same question. Past the cap the close-out still reports
  // the run as unverified, so the gap stays visible instead of being dropped.
  let verificationReminders = 0
  const verificationReminderLimit =
    options.stepBudget && options.stepBudget.taskCount >= 2
      ? Math.min(options.stepBudget.taskCount, MAX_VERIFICATION_REMINDERS)
      : 1
  // A multi-task instruction relies on the plan having one item per task: the
  // per-item verification reminders and the close-out check below both count
  // plan items. Track the plan the model actually submitted instead of trusting
  // the first "list every task" instruction to have been followed.
  const batchTaskCount = stepBudget && stepBudget.taskCount >= 2 ? stepBudget.taskCount : 0
  // A split batch produces one final answer per task, so a single run is allowed
  // the same number of close-out attempts instead of one. Capped at three: a
  // model that refuses to update its plan gets a few chances, not a loop.
  const itemCloseOutLimit = Math.min(batchTaskCount, 3)
  let plannedItems: { text: string; status: string }[] = []
  let planCoverageAsked = false
  // Nudging for rotation is not a one-shot: with five tasks the third can still
  // eat the pool after the second was rotated to. The allowance matches the
  // close-out asks, and a repeat is only allowed once the open-item count has
  // actually dropped — otherwise the notice would fire on every step.
  const itemRotationLimit = Math.min(batchTaskCount, 3)
  let itemRotationAsks = 0
  let itemRotationOpenAtAsk = Number.POSITIVE_INFINITY
  let itemCloseOutAsks = 0
  let lastSummaryStep = 0
  let lastSummaryLength = 0
  let lastSummaryText: string | undefined
  let summarizeFailures = 0
  const changedPaths = new Set<string>()
  let modelMs = 0
  let toolMs = 0
  let approvalMs = 0
  let summarizeMs = 0
  /** Per-call usage samples, so a run's cost can be attributed to its steps. */
  const usageSamples: RunUsageSample[] = []

  // Failure tracking powers the in-run reflection prompt and the repeated-call
  // guard. Both are feedback signals for the model, never a reason to weaken
  // policy, approval or sandbox checks.
  const reflectionAfterFailures = Math.max(0, Math.round(options.reflectionAfterFailures ?? 2))
  const maxReflections = Math.max(0, Math.round(options.maxReflections ?? 2))
  const maxRepeatedFailures = Math.max(0, Math.round(options.maxRepeatedFailures ?? 2))
  const failureCounts = new Map<string, number>()
  const failureLog: string[] = []
  let failureTotal = 0
  let stepFailures = 0
  let emptyResponses = 0
  let reflections = 0
  let reflectedAtFailure = 0
  let toolsmithHintSent = false

  const finish = (
    status: LoopStatus,
    error?: { code: string; message: string },
  ): LoopResult => ({
    status,
    content: lastContent,
    steps: step,
    usage,
    usageSteps: usageSamples,
    produced,
    filesChanged: changedPaths.size,
    checked: checkRan,
    timings: { modelMs, toolMs, approvalMs, summarizeMs },
    summarizeFailures,
    ...(lastSummaryText ? { summary: lastSummaryText } : {}),
    ...(error ? { error } : {}),
  })

  /**
   * Screenshot images cannot live in a tool-role message, so they are attached
   * as a user observation right after the tool result. Only the two most recent
   * observations stay in the model context; older ones remain on disk and in
   * the tool output. They are not persisted to the transcript.
   */
  const attachScreenshots = (result: ToolResult): void => {
    if (options.screenshotFeedback === false) return
    const raw = result.metadata?.['images']
    if (!Array.isArray(raw)) return
    const images = raw
      .filter((item): item is string => typeof item === 'string' && item.startsWith('data:image/'))
      .slice(0, 3)
    if (images.length === 0) return
    const shot = result.metadata?.['screenshot']
    const detail =
      shot && typeof shot === 'object'
        ? (shot as Record<string, unknown>)
        : ({} as Record<string, unknown>)
    const target = typeof detail['target'] === 'string' ? detail['target'] : 'window'
    const width = typeof detail['width'] === 'number' ? detail['width'] : null
    const height = typeof detail['height'] === 'number' ? detail['height'] : null
    const size = width && height ? ` ${width}x${height}` : ''
    const path = typeof detail['path'] === 'string' ? ` Saved at ${detail['path']}.` : ''
    const note: AgentMessage = {
      role: 'user',
      content: `[screenshot observation] ${target}${size}. This is the current rendered state of the target you captured; use it to check layout, colors, text and visible errors.${path}`,
      images,
      internal: true,
    }
    messages.push(note)
    const prior = messages.filter(
      (message) =>
        message.role === 'user' &&
        message.images !== undefined &&
        message.images.length > 0 &&
        message.content.startsWith('[screenshot observation]'),
    )
    while (prior.length > 2) {
      const oldest = prior.shift()
      const index = oldest ? messages.lastIndexOf(oldest) : -1
      if (index !== -1) messages.splice(index, 1)
    }
  }

  // A command that is "not found" (127 / Windows 9009, or spawn ENOENT) means
  // the toolchain the model assumed is not on this machine. The project usually
  // ships its own entry point; naming it costs one line and saves the probing
  // loop (find /, ls /usr/bin, retries with node/python/py). Detection is lazy
  // and cached per run: nothing touches the disk until a command really fails
  // this way, and the failure text itself is never modified.
  let entryPoints: Promise<string[]> | null = null
  let notFoundFailures = 0
  const entryPointHint = async (result: ToolResult): Promise<string | undefined> => {
    const root = options.workspaceRoot
    if (!root || result.ok) return undefined
    const exitCode = result.metadata?.['exitCode']
    const missing =
      exitCode === 127 ||
      exitCode === 9009 ||
      // spawn() reports a missing executable as an error event, not an exit code.
      (exitCode === null && /ENOENT/.test(result.error ?? ''))
    if (!missing) return undefined
    entryPoints ??= detectEntryPoints(root).catch(() => [])
    const found = await entryPoints
    if (found.length === 0) return undefined
    notFoundFailures += 1
    const lines = [`本项目可用入口：${found.join('、')}`]
    if (notFoundFailures >= 2) {
      lines.push('工具链不在 PATH，改用入口脚本：不要再试 node/python/py 等解释器，也不要扫描磁盘找二进制。')
    }
    return lines.join('\n')
  }

  const appendResult = async (call: ToolCall, result: ToolResult): Promise<void> => {
    const message = toolMessage(call, result, maxToolOutputChars, await entryPointHint(result))
    messages.push(message)
    produced.push(message)
    await emit({ type: 'tool.result', call, result })
    attachScreenshots(result)
  }

  const recordFailure = (call: ToolCall, result: ToolResult): void => {
    if (result.ok) return
    const key = callKey(call)
    failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1)
    failureTotal += 1
    stepFailures += 1
    const detail = (result.error || result.output || 'tool failed').replace(/\s+/g, ' ').trim()
    failureLog.push(
      `${call.name}(${truncateMiddle(JSON.stringify(call.arguments ?? {}), 160)}) → ${truncateMiddle(detail || 'no detail', 240)}`,
    )
    if (failureLog.length > 12) failureLog.shift()
  }

  const appendFailure = async (call: ToolCall, result: ToolResult): Promise<void> => {
    recordFailure(call, result)
    await appendResult(call, result)
  }

  const repeatedFailureError = (call: ToolCall, tool: AgentToolDefinition): ToolResult => ({
    ok: false,
    output: '',
    error: `[运行反思] ${call.name} 以相同参数已连续失败 ${failureCounts.get(callKey(call)) ?? 0} 次，本次不再重复执行。请先分析报错原因，改变参数、路径或方案后再试。`,
    risk: tool.risk,
    metadata: { repeatedFailureBlocked: true },
  })

  // The prior read result is only a safe substitute while it is still sent to
  // the model verbatim. Old tool results get compacted to head/tail once newer
  // results push them out of the working set (or when the prompt is over
  // budget), and then the model must see the real content again.
  /**
   * Compaction and trimming rewrite the transcript, so a remembered index can
   * point at a different message afterwards. Re-resolve every remembered prior
   * read by tool call id (and forget the ones whose result is gone): a stale
   * index would compare a fresh read against unrelated content and report it
   * as unchanged.
   */
  const reindexHistoricalReads = (): void => {
    if (historicalReads.size === 0) return
    for (const [key, seeded] of [...historicalReads]) {
      const index = messages.findIndex(
        (message) => message.role === 'tool' && message.toolCallId === seeded.callId,
      )
      if (index < 0) historicalReads.delete(key)
      else historicalReads.set(key, { callId: seeded.callId, messageIndex: index })
    }
  }

  const seededReadStillVisible = (messageIndex: number): boolean => {
    const seeded = messages[messageIndex]
    if (!seeded || seeded.role !== 'tool') return false
    // A compacted result keeps only head/tail; "use the result above" would then
    // point at content the model can no longer read.
    if (seeded.content.startsWith(COMPACTED_MARKER)) return false
    let newerToolResults = 0
    for (let index = messageIndex + 1; index < messages.length; index += 1) {
      if (messages[index]?.role === 'tool') newerToolResults += 1
    }
    if (newerToolResults >= keepRecentToolResults) return false
    if (messageBudget > 0 && messagesTokens(messages) > messageBudget) return false
    return true
  }

  /**
   * Same-run dedupe asks the model to reuse the result of an earlier call in
   * this run, so that result has to still be in the prompt verbatim. The
   * cross-run path checks this; without the same check here a read that was
   * compacted or pushed out of the working set was replaced by a pointer to
   * content the model could not see any more.
   */
  const readResultStillVisible = (callId: string): boolean => {
    const index = messages.findIndex(
      (message) => message.role === 'tool' && message.toolCallId === callId,
    )
    return index >= 0 && seededReadStillVisible(index)
  }

  const reusedReadResult = (
    call: ToolCall,
    priorCallId: string,
    tool: AgentToolDefinition,
  ): ToolResult => ({
    ok: true,
    output: `[重复读取已省略] 上次运行已用相同参数成功执行过 ${call.name}（调用 ${priorCallId}），结果没有变化。请直接使用上下文中的已有结果；如需不同内容，请缩小路径/范围或换参数。`,
    risk: tool.risk,
    metadata: { cached: true, reused: true },
  })

  /**
   * Pick up tools that appeared during the run. Called once per step so a tool
   * the model just gained (for example an MCP tool from a server created in
   * this same run) is offered from the next step on.
   *
   * The tool list is the first block of the provider payload, so touching it
   * invalidates the prompt cache from there on. Compare the tool name sets, not
   * the length: one MCP server leaving while another arrives keeps the count
   * identical, and an equal count with different names used to go unnoticed.
   */
  const refreshTools = async (): Promise<void> => {
    if (!options.pullTools) return
    const next = await Promise.resolve()
      .then(() => options.pullTools!())
      .catch(() => null)
    if (!next) return
    const offered = new Set(tools.keys())
    const nextNames = new Set(next.map((tool) => tool.name))
    let added = 0
    for (const name of nextNames) if (!offered.has(name)) added += 1
    let removed = 0
    for (const name of offered) if (!nextNames.has(name)) removed += 1
    // Same set: keep the very same array so the sent prefix stays identical and
    // the cache keeps hitting. A description-only change cannot happen here —
    // pullTools re-derives the builtins from the same objects every step.
    if (added === 0 && removed === 0) return
    tools.clear()
    for (const tool of next) tools.set(tool.name, tool)
    // Pure append keeps every already-offered definition at the same index, so
    // only the new tools at the tail miss the cache. A removal or a swap moves
    // or drops entries mid-list: nothing in the loop can repair that prefix, so
    // take the new array as-is and accept the one-time miss.
    toolDefs =
      removed === 0 ? [...toolDefs, ...next.filter((tool) => !offered.has(tool.name))] : next
    toolsTokens = toolDefs.length > 0 ? estimateTokens(JSON.stringify(toolDefs)) : 0
    messageBudget = maxContextTokens > 0 ? Math.max(500, maxContextTokens - toolsTokens) : 0
  }

  const noteResult = (call: ToolCall, result: ToolResult): void => {
    // Every tool outcome is evidence for the progress detector: a repeated read
    // of an unchanged file yields the same signature, while a retry that fails
    // differently does not. Collected per step and folded in once, so one step
    // with eight parallel reads counts as one step, not eight stalls.
    if (stepBudget) {
      let args = ''
      try {
        args = JSON.stringify(call.arguments ?? {})
      } catch {
        args = ''
      }
      stepObservations.push({
        name: call.name,
        args,
        output: result.ok ? result.output : (result.error ?? ''),
      })
    }
    if (!result.ok) return
    if (call.name === planTool) {
      planSeen = true
      lastPlanStep = step
      const rawItems = Array.isArray(call.arguments['items']) ? call.arguments['items'] : []
      const parsed: { text: string; status: string }[] = []
      for (const item of rawItems) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const text = typeof record['text'] === 'string' ? record['text'].trim() : ''
        if (!text) continue
        const status = record['status']
        parsed.push({
          text,
          status: status === 'done' || status === 'in_progress' ? status : 'pending',
        })
      }
      if (parsed.length > 0) plannedItems = parsed
    }
    if (result.risk === 'write' || result.risk === 'exec') {
      const path = call.arguments['path']
      if (typeof path === 'string' && path.trim()) changedPaths.add(path.trim())
    }
    if (result.risk === 'write') {
      // Documentation-only writes (a skill, an MCP config entry) add no code to
      // verify, so they must not arm the verification gate.
      if (tools.get(call.name)?.noVerification === true) return
      dirty = true
      checkRan = false
      // A new edit after a delivered report is a new unverified change: the
      // gate has to speak again, otherwise "report, then keep editing" would
      // end as verified just because something was reported earlier.
      deliveredReport = false
    } else if (result.risk === 'exec' && dirty && !checkRan) {
      if (result.metadata?.['verification'] === true) {
        checkRan = true
        return
      }
      const command = typeof call.arguments['command'] === 'string' ? call.arguments['command'] : ''
      const extra = Array.isArray(call.arguments['args'])
        ? call.arguments['args'].map(String).join(' ')
        : ''
      // A runner summary in the output is proof the suite really executed, even
      // when the command is a wrapper (`docker exec …`, a Makefile target, a
      // project script) that no pattern can recognise from its name alone.
      checkRan =
        isVerificationCommand(`${command} ${extra}`) || looksLikeTestOutput(result.output)
    }
  }

  const resolvePolicy = async (
    tool: AgentToolDefinition,
    call: ToolCall,
  ): Promise<ToolPolicyDecision | ToolPolicyResult> => {
    const cached = decisionCache.get(call.id)
    if (cached) return cached
    const raw = options.policy
      ? await options.policy(tool, call)
      : tool.alwaysAsk
        ? 'ask'
        : tool.risk === 'read' || tool.risk === 'control'
          ? 'auto'
          : 'ask'
    decisionCache.set(call.id, raw)
    return raw
  }

  const cancelRemaining = async (calls: ToolCall[]): Promise<void> => {
    for (const call of calls) {
      const result: ToolResult = {
        ok: false,
        output: '',
        error: 'Run cancelled',
        risk: tools.get(call.name)?.risk,
      }
      await appendResult(call, result)
    }
  }

  /** Execute one tool call through policy, approval, dedupe and execution. */
  const runOne = async (call: ToolCall): Promise<void> => {
    const tool = tools.get(call.name)
    if (!tool) {
      const result: ToolResult = {
        ok: false,
        output: '',
        error: `Unknown tool: ${call.name}`,
      }
      await emit({ type: 'tool.call', call, risk: 'read' })
      await appendFailure(call, result)
      return
    }

    await emit({ type: 'tool.call', call, risk: tool.risk })

    // Soft plan gate: one blocked call, never a hard failure.
    if (
      options.requirePlan &&
      !planSeen &&
      !planGateUsed &&
      (tool.risk === 'write' || tool.risk === 'exec')
    ) {
      planGateUsed = true
      const result: ToolResult = {
        ok: false,
        output: '',
        error:
          '计划门：这是本轮第一次修改操作。请先调用 update_plan 列出 3-6 个步骤（包含验证步骤），然后再重试这个操作。若任务确实只需一步，可忽略本提示直接重试。',
        risk: tool.risk,
      }
      await appendResult(call, result)
      await emit({
        type: 'notice',
        level: 'info',
        message: '已提醒模型先建立任务计划。',
      })
      return
    }

    const rawDecision = await resolvePolicy(tool, call)
    const decision = decisionOf(rawDecision)
    const meta = policyMeta(rawDecision)

    if (decision === 'deny') {
      const result: ToolResult = {
        ok: false,
        output: '',
        error: meta.reason
          ? `Tool call denied by policy: ${meta.reason}`
          : 'Tool call denied by policy',
        risk: tool.risk,
      }
      await appendFailure(call, result)
      return
    }

    if (decision === 'ask') {
      if (!options.requestApproval) {
        const result: ToolResult = {
          ok: false,
          output: '',
          error: 'Approval is required, but no approval handler is connected',
          risk: tool.risk,
        }
        await appendFailure(call, result)
        return
      }
      await emit({
        type: 'tool.approval_required',
        call,
        risk: tool.risk,
        ...meta,
      })
      const approvalStartedAt = Date.now()
      let approval: ApprovalDecision
      try {
        approval = await options.requestApproval({
          call,
          tool,
          arguments: call.arguments ?? {},
          ...meta,
        })
      } finally {
        approvalMs += Date.now() - approvalStartedAt
      }
      await emit({
        type: 'tool.approval_resolved',
        call,
        approved: approval.approved,
        reason: approval.reason,
        decidedBy: approval.decidedBy,
      })
      if (!approval.approved) {
        const result: ToolResult = {
          ok: false,
          output: '',
          error: approval.reason ? `User denied: ${approval.reason}` : 'User denied this tool call',
          risk: tool.risk,
        }
        await appendFailure(call, result)
        return
      }
    }

    const key = callKey(call)
    const prior = priorReads.get(key)
    if (
      REPLAYABLE_READS.has(call.name) &&
      prior &&
      prior.mutationSeq === mutationSeq &&
      readResultStillVisible(prior.callId)
    ) {
      const result: ToolResult = {
        ok: true,
        output: `[重复读取已省略] 本次运行已用相同参数成功执行过 ${call.name}（调用 ${prior.callId}）。请使用已有结果；如需不同内容，请缩小路径/范围或换参数。`,
        risk: tool.risk,
        metadata: { cached: true },
      }
      await appendResult(call, result)
      return
    }

    // A model can loop on an identical failing read. Let it retry once (the
    // failure may be transient), then refuse to re-execute the same call and
    // force a different approach or a user question. Exec and write calls are
    // intentionally exempt: the same test command legitimately fails again
    // after an edit, and blocking it would remove real capability.
    if (
      maxRepeatedFailures > 0 &&
      tool.risk === 'read' &&
      (failureCounts.get(key) ?? 0) >= maxRepeatedFailures
    ) {
      await appendResult(call, repeatedFailureError(call, tool))
      return
    }

    if (options.preTool) {
      const hook = await options.preTool(call, tool).catch(() => null)
      if (hook?.blocked) {
        const result: ToolResult = {
          ok: false,
          output: '',
          error: hook.output || 'Blocked by a pre_tool hook',
          risk: tool.risk,
        }
        await appendFailure(call, result)
        return
      }
    }

    const startedAt = Date.now()
    let result: ToolResult
    try {
      result = await options.executeTool({ call, tool, signal: toolSignal })
    } catch (error) {
      result = {
        ok: false,
        output: '',
        error: isAbort(error, signal)
          ? 'Run cancelled'
          : error instanceof Error
            ? error.message
            : String(error),
        risk: tool.risk,
      }
    }
    result.risk = tool.risk
    result.durationMs ??= Date.now() - startedAt
    toolMs += result.durationMs

    const seeded = historicalReads.get(key)
    if (seeded) {
      historicalReads.delete(key)
      const priorContent = messages[seeded.messageIndex]?.content ?? ''
      const rendered = truncateMiddle(result.output || '(no output)', maxToolOutputChars)
      if (
        result.ok &&
        !result.metadata?.['truncated'] &&
        priorContent &&
        rendered === priorContent &&
        seededReadStillVisible(seeded.messageIndex)
      ) {
        await appendResult(call, reusedReadResult(call, seeded.callId, tool))
        return
      }
    }

    if (result.ok && tool.risk === 'write' && options.postEdit) {
      const hookOutput = await options.postEdit(call, tool, result).catch(() => null)
      if (hookOutput) {
        result.output = `${result.output}\n\n${hookOutput}`
        result.metadata = { ...(result.metadata ?? {}), hookOutput: true }
      }
    }

    if (REPLAYABLE_READS.has(call.name) && result.ok && !result.metadata?.['truncated']) {
      priorReads.set(key, { callId: call.id, mutationSeq })
    }
    if (!REPLAYABLE_READS.has(call.name)) mutationSeq += 1
    noteResult(call, result)
    if (result.ok) await appendResult(call, result)
    else await appendFailure(call, result)
    if (signal?.aborted) throw abortError()
  }

  /**
   * The longest prefix of the remaining calls that is read-only and
   * auto-approved, capped at `maxParallelReadTools`. Two or more are executed
   * concurrently; policy verdicts are cached so a fallback to the sequential
   * path does not re-classify.
   *
   * Deliberately a *prefix*: a read that follows a write in the same block must
   * still observe the written file, so crossing a mutating call would change
   * what the model sees.
   */
  const takeParallelPrefix = async (
    calls: ToolCall[],
  ): Promise<Array<{ call: ToolCall; tool: AgentToolDefinition }>> => {
    if (maxParallelReadTools < 2) return []
    const prefix: Array<{ call: ToolCall; tool: AgentToolDefinition }> = []
    for (const call of calls) {
      const tool = tools.get(call.name)
      if (!tool || tool.risk !== 'read') break
      const raw = await resolvePolicy(tool, call)
      if (decisionOf(raw) !== 'auto') break
      prefix.push({ call, tool })
      if (prefix.length >= maxParallelReadTools) break
    }
    return prefix.length >= 2 ? prefix : []
  }

  const runParallel = async (
    entries: Array<{ call: ToolCall; tool: AgentToolDefinition }>,
  ): Promise<void> => {
    const prepared: Array<{
      call: ToolCall
      tool: AgentToolDefinition
      result?: ToolResult
      deduped?: boolean
    }> = []
    for (const entry of entries) {
      await emit({ type: 'tool.call', call: entry.call, risk: entry.tool.risk })
      const key = callKey(entry.call)
      const prior = priorReads.get(key)
      if (
        REPLAYABLE_READS.has(entry.call.name) &&
        prior &&
        prior.mutationSeq === mutationSeq &&
        readResultStillVisible(prior.callId)
      ) {
        prepared.push({
          ...entry,
          deduped: true,
          result: {
            ok: true,
            output: `[重复读取已省略] 本次运行已用相同参数成功执行过 ${entry.call.name}（调用 ${prior.callId}）。请使用已有结果；如需不同内容，请缩小路径/范围或换参数。`,
            risk: entry.tool.risk,
            metadata: { cached: true },
          },
        })
      } else if (
        maxRepeatedFailures > 0 &&
        (failureCounts.get(key) ?? 0) >= maxRepeatedFailures
      ) {
        prepared.push({ ...entry, result: repeatedFailureError(entry.call, entry.tool) })
      } else {
        prepared.push(entry)
      }
    }

    const runnable = prepared.filter((entry) => !entry.result)
    await mapLimit(runnable, maxParallelReadTools, async (entry) => {
      if (options.preTool) {
        const hook = await options.preTool(entry.call, entry.tool).catch(() => null)
        if (hook?.blocked) {
          entry.result = {
            ok: false,
            output: '',
            error: hook.output || 'Blocked by a pre_tool hook',
            risk: entry.tool.risk,
          }
          recordFailure(entry.call, entry.result)
          return entry.result
        }
      }
      const startedAt = Date.now()
      try {
        const result = await options.executeTool({
          call: entry.call,
          tool: entry.tool,
          signal: toolSignal,
        })
        result.risk = entry.tool.risk
        result.durationMs ??= Date.now() - startedAt
        entry.result = result
        if (!result.ok) recordFailure(entry.call, result)
      } catch (error) {
        entry.result = {
          ok: false,
          output: '',
          error: isAbort(error, signal)
            ? 'Run cancelled'
            : error instanceof Error
              ? error.message
              : String(error),
          risk: entry.tool.risk,
          durationMs: Date.now() - startedAt,
        }
        recordFailure(entry.call, entry.result)
      }
      return entry.result
    })
    for (const entry of runnable) toolMs += entry.result?.durationMs ?? 0

    for (const entry of prepared) {
      const key = callKey(entry.call)
      const seeded = historicalReads.get(key)
      if (!seeded) continue
      historicalReads.delete(key)
      if (entry.deduped || !entry.result) continue
      const priorContent = messages[seeded.messageIndex]?.content ?? ''
      const rendered = truncateMiddle(entry.result.output || '(no output)', maxToolOutputChars)
      if (
        entry.result.ok &&
        !entry.result.metadata?.['truncated'] &&
        priorContent &&
        rendered === priorContent &&
        seededReadStillVisible(seeded.messageIndex)
      ) {
        entry.result = reusedReadResult(entry.call, seeded.callId, entry.tool)
        entry.deduped = true
      }
    }

    for (const entry of prepared) {
      const result =
        entry.result ??
        ({ ok: false, output: '', error: 'Tool did not return a result', risk: entry.tool.risk } satisfies ToolResult)
      entry.result = result
      if (
        !entry.deduped &&
        REPLAYABLE_READS.has(entry.call.name) &&
        result.ok &&
        !result.metadata?.['truncated']
      ) {
        priorReads.set(callKey(entry.call), {
          callId: entry.call.id,
          mutationSeq,
        })
      }
      noteResult(entry.call, result)
    }

    // Append in the original call order, even though execution completed out of order.
    for (const entry of prepared) {
      await appendResult(entry.call, entry.result!)
    }
  }

  try {
    for (step = 1; step <= maxSteps; step += 1) {
      stepFailures = 0
      await refreshTools()
      if (signal?.aborted) throw abortError()
      if (maxTokens > 0 && usage.totalTokens >= maxTokens) {
        await emit({
          type: 'notice',
          level: 'warn',
          message: `Token budget of ${maxTokens} exhausted`,
        })
        return finish('token_limit', {
          code: 'AGENT_TOKEN_LIMIT',
          message: 'Token budget exhausted',
        })
      }

      // Token budget close-out. Running out of tokens is a budget event like
      // running out of steps, and the recording showed runs where the token cap
      // arrived first and cut the answer off mid-sentence. One warning at 85%
      // lets the final turns say what is done and what is left instead of the
      // run ending with a bare `AGENT_TOKEN_LIMIT`. Shares `closeOutSent` with
      // the step reminder below so a run that is short on both pays for one
      // extra message, not two.
      const tokenWrapAt = maxTokens > 0 ? maxTokens * 0.85 : 0
      if (
        options.budgetWrapUp &&
        !closeOutSent &&
        tokenWrapAt > 0 &&
        usage.totalTokens >= tokenWrapAt
      ) {
        closeOutSent = true
        messages.push({
          role: 'user',
          internal: true,
          content:
            `[额度预算] 本轮已用 ${usage.totalTokens} / ${maxTokens} token，剩余约 ${maxTokens - usage.totalTokens}。` +
            '不要再开启新的调查或大改：先把当前这一步的验证跑完，然后给出收尾报告：' +
            '1) 已完成（含怎么验证的）；2) 未完成与原因；3) 下一步要做的第一条具体动作。',
        })
        await emit({
          type: 'notice',
          level: 'warn',
          message: `已用 ${usage.totalTokens}/${maxTokens} token，已提醒模型收尾并列出剩余项。`,
        })
      }

      await emit({ type: 'step.started', step })
      // Observations are folded at the end of the step; reset here so a step that
      // ends with `continue` (output continuation, empty response) cannot leak
      // its results into the next step's progress verdict.
      stepObservations = []
      if (options.pullMessages) {
        try {
          for (const message of await options.pullMessages()) messages.push(message)
        } catch {
          // Steering is best-effort and must never end a run.
        }
      }

      await emit({ type: 'message.started' })
      if (continuations > 0 && answer) {
        // Re-render the partial answer in the live view before continuing it.
        await emit({ type: 'message.delta', text: answer })
      }

      // Model-written compaction runs before the mechanical fitter. It is
      // attempted once per growth burst so a long run does not pay for a
      // summary on every step.
      if (
        options.summarize &&
        maxContextTokens > 0 &&
        messages.length > 8 &&
        messages.length >= lastSummaryLength + 4 &&
        (lastSummaryStep === 0 || step - lastSummaryStep >= 4) &&
        // Same unit the fitter budgets against: per-message overhead, tool-call
        // arguments and inline images included, tool schemas charged on top.
        // contentTokens ignored all of those, so the trigger stayed quiet in
        // exactly the runs that were already over the window.
        messagesTokens(messages) + toolsTokens > maxContextTokens * summaryThreshold
      ) {
        const summarizeStartedAt = Date.now()
        const priorSummaryMessage = messages.find((message) => message.contextSummary)
        const priorSummary = priorSummaryMessage
          ? stripSummaryFraming(priorSummaryMessage.content) || undefined
          : undefined
        // The summarizer is a full model call over the whole excerpt. Its cost
        // is real even though it never shows up as a step, so it is folded into
        // the run usage and sample list instead of being free.
        const summaryUsage: AgentUsage[] = []
        const nextSummary = await options
          .summarize(messages, priorSummary || undefined, (sample) => {
            summaryUsage.push(normalizeUsage(sample))
          })
          .catch(() => null)
        for (const sample of summaryUsage) {
          usage = addUsage(usage, sample)
          if (usageSamples.length < MAX_USAGE_SAMPLES) {
            usageSamples.push({
              step,
              promptTokens: sample.promptTokens,
              cacheHitTokens: sample.cacheHitTokens ?? 0,
              cacheMissTokens: sample.cacheMissTokens ?? 0,
              completionTokens: sample.completionTokens,
              contextTokens: 0,
            })
          }
        }
        if (summaryUsage.length > 0) await emit({ type: 'usage', usage })
        summarizeMs += Date.now() - summarizeStartedAt
        // A failed summary must not advance the throttle: the next step gets to
        // try again instead of waiting another 4 steps behind a shrinking
        // window. It is also reported, because a silent fallback leaves the
        // model with mechanical compaction it cannot tell apart from a summary.
        if (!nextSummary) {
          summarizeFailures += 1
          await emit({
            type: 'notice',
            level: 'warn',
            message: `上下文摘要失败（第 ${summarizeFailures} 次），已改用机械压缩并将在下一步重试`,
          })
        } else {
          lastSummaryStep = step
          lastSummaryLength = messages.length
        }
        if (nextSummary) {
          const system = messages.filter((message) => message.role === 'system')
          const conversation = messages.filter((message) => message.role !== 'system')
          // Internal blocks (the earlier summary, the folded-turns digest) are
          // not user turns: picking one as `firstUser` would let a summary or a
          // closed-work digest be framed as the task the run is working on. The
          // same goes for the reminders the loop injects itself: they are role
          // 'user' but the system wrote them, so they do not close this task.
          const isTaskTurn = (message: AgentMessage): boolean =>
            message.role === 'user' &&
            !message.contextSummary &&
            !message.earlierWork &&
            !message.internal
          const firstUser = conversation.findIndex(isTaskTurn)
          // The instruction this run is working on is the newest real user
          // message anywhere in the conversation, not merely in the retained
          // tail. A long turn is assistant and tool traffic, so the last eight
          // messages routinely hold no user message at all; asking the tail
          // "did something newer survive?" then answered no, and the session's
          // first instruction stayed bare directly above the summary. The rules
          // make the newest user message the task, so the model went back to it
          // — which is how a one-word "修复" turn turned into a theme plan.
          let lastTask = conversation.length - 1
          while (lastTask >= 0 && !isTaskTurn(conversation[lastTask]!)) lastTask -= 1
          const currentTask = lastTask >= 0 ? conversation[lastTask] : undefined
          const digests = conversation.filter((message) => message.earlierWork)
          const keepFrom = findSummaryBoundary(conversation, 8)
          const tailStart = Math.max(keepFrom, firstUser + 1, 0)
          // The earlier summary is already merged into `nextSummary` by the
          // model; keeping a copy in the tail would duplicate it and inflate the
          // prompt it was meant to shrink.
          const tail = (
            tailStart > 0 ? conversation.slice(tailStart) : conversation.slice(-8)
          ).filter((message) => !message.contextSummary && !message.earlierWork)
          // The session's first message is kept for the record (a summary can
          // omit a detail). It is only *background* when a newer user turn
          // exists anywhere in the conversation: an unlabelled "分析项目" above
          // the summary reads like a live instruction and pulled long sessions
          // back to a task that ended days ago. In a single-task run nothing
          // newer exists, so the same message is the task being worked on and
          // must not be labelled as finished work.
          const head =
            firstUser >= 0
              ? [
                  {
                    ...conversation[firstUser]!,
                    content: frameFirstUserTurn(
                      conversation[firstUser]!,
                      lastTask > firstUser,
                    ),
                  },
                ]
              : []
          const summaryMessage: AgentMessage = {
            role: 'user',
            content: summaryMessageContent(nextSummary),
            contextSummary: true,
          }
          // A closed-work digest survives compaction: it is the only trace of
          // turns that were folded away, and unlike the first user message it
          // cannot be rebuilt from the stored session. The live instruction is
          // restated last when the retained tail no longer holds it: the newest
          // user message in the request is then the one this run is working on,
          // instead of the summary (and a labelled first turn) being all the
          // model can see.
          const pinnedTask: AgentMessage[] =
            currentTask && lastTask > firstUser && !tail.some(isTaskTurn)
              ? [{ ...currentTask, content: `${CURRENT_TASK_HEADER}\n${currentTask.content}` }]
              : []
          const nextMessages = [
            ...system,
            ...digests,
            ...head,
            summaryMessage,
            ...tail,
            ...pinnedTask,
          ]
          const before = contentTokens(messages)
          const after = contentTokens(nextMessages)
          // Never let a summary that is larger than what it replaces grow the
          // context; mechanical trimming would only drop more of the tail.
          if (after < before) {
            messages = nextMessages
            // The rewritten transcript invalidates remembered message indexes,
            // and the next summary should be allowed once the new tail grows,
            // not only after the pre-summary length is reached again.
            lastSummaryLength = messages.length
            // Kept so the caller can persist it: the summary is the only
            // compact form of the turns that were just folded away, and
            // rebuilding it needs a model call.
            lastSummaryText = nextSummary
            reindexHistoricalReads()
            // 压缩属于后台优化，不再额外 emit notice：notice 在桌面端和手机端都会
            // 弹 toast，打断正在进行的操作。裁剪结果由下面的 context.compacted 上报。
          }
        }
      }

      if (messageBudget > 0) {
        // fitMessages gates the opportunistic compaction pass on real pressure
        // (see FitOptions.compactAbove): rewriting history every step would
        // invalidate the provider's prompt cache from the rewrite point on.
        const fit = fitMessages(messages, messageBudget, { keepRecentToolResults })
        if (fit.compacted > 0 || fit.droppedMessages > 0) {
          messages = fit.messages
          reindexHistoricalReads()
          await emit({
            type: 'context.compacted',
            droppedMessages: fit.droppedMessages,
            compactedResults: fit.compacted,
            estimatedTokens: fit.estimatedTokens,
          })
        }
      }

      // Prompt footprint actually sent with this call: what the provider bills
      // and what the cache can hit on.
      const stepContextTokens = contentTokens(messages)
      let stepReasoning = ''
      const modelStartedAt = Date.now()
      let response: ModelResponse
      try {
        response = await options.model.complete({
          messages,
          tools: toolDefs,
          signal,
          temperature: options.temperature,
          onTextDelta: async (delta) => {
            if (signal?.aborted) return
            await emit({ type: 'message.delta', text: delta })
          },
          onReasoningDelta: async (delta) => {
            if (signal?.aborted) return
            stepReasoning += delta
            await emit({ type: 'reasoning.delta', text: delta })
          },
        })
      } finally {
        modelMs += Date.now() - modelStartedAt
      }
      if (signal?.aborted) throw abortError()

      const stepUsage = normalizeUsage(response.usage)
      usage = addUsage(usage, stepUsage)
      if (usageSamples.length < MAX_USAGE_SAMPLES) {
        usageSamples.push({
          step,
          promptTokens: stepUsage.promptTokens,
          cacheHitTokens: stepUsage.cacheHitTokens ?? 0,
          cacheMissTokens: stepUsage.cacheMissTokens ?? 0,
          completionTokens: stepUsage.completionTokens,
          contextTokens: stepContextTokens,
        })
      }
      const content = response.content ?? ''
      const toolCalls = response.toolCalls ?? []
      const reasoning = response.reasoning || stepReasoning

      const continuing = toolCalls.length === 0 && continuations > 0 && answerMessage !== null
      if (toolCalls.length > 0) {
        answer = ''
        answerReasoning = ''
        answerMessage = null
        continuations = 0
        lastContent = content
        const assistantMessage: AgentMessage = { role: 'assistant', content, toolCalls }
        messages.push(assistantMessage)
        produced.push(assistantMessage)
      } else {
        answer = continuing ? answer + content : content
        answerReasoning = continuing ? answerReasoning + reasoning : reasoning
        lastContent = answer
        if (continuing && answerMessage) answerMessage.content = answer
        else if (answer.trim()) {
          answerMessage = { role: 'assistant', content: answer }
          messages.push(answerMessage)
          produced.push(answerMessage)
        } else {
          // Reasoning-only turn. It carries nothing the provider will accept, so
          // it must not become an assistant message: an empty one poisons every
          // later turn of the session (DeepSeek: "Invalid assistant message").
          answerMessage = null
        }
      }

        if (answerMessage && isDeliverableText(answerMessage.content)) deliveredReport = true

      const willContinue =
        toolCalls.length === 0 &&
        response.finishReason === 'length' &&
        continuations < MAX_OUTPUT_CONTINUATIONS &&
        step < maxSteps &&
        !(maxTokens > 0 && usage.totalTokens >= maxTokens)

      if (!willContinue && (toolCalls.length > 0 || answerMessage !== null)) {
        await emit({
          type: 'message.completed',
          content: toolCalls.length > 0 ? content : answer,
          toolCalls,
          reasoning: toolCalls.length > 0 ? reasoning : answerReasoning,
          usage: stepUsage,
        })
      }
      await emit({ type: 'usage', usage })

      if (maxTokens > 0 && usage.totalTokens > maxTokens) {
        return finish('token_limit', {
          code: 'AGENT_TOKEN_LIMIT',
          message: 'Token budget exceeded',
        })
      }

      if (toolCalls.length === 0) {
        if (willContinue) {
          continuations += 1
          messages.push({ role: 'user', content: CONTINUE_OUTPUT_PROMPT, internal: true })
          continue
        }
        // A turn with reasoning but no visible text and no tool call leaves
        // nothing to store. Ask once for a real answer instead of ending the
        // run silently with an empty result.
        if (answerMessage === null && emptyResponses < 1 && step < maxSteps) {
          emptyResponses += 1
          messages.push({ role: 'user', content: EMPTY_RESPONSE_PROMPT, internal: true })
          await emit({
            type: 'notice',
            level: 'info',
            message: '模型本轮没有返回内容，已提醒它给出结论。',
          })
          continue
        }
        // Verification runs before the per-item close-out. Closing out a batch
        // while the current edit is still unverified would invite the model to
        // report an item as done on work nobody checked.
        // A run that already put its report on screen is not asked again. The
        // reminder exists so a change is never announced as done before it is
        // checked; once the answer is delivered, asking makes the model reopen
        // the work and write a second answer, and the reader cannot tell which
        // of the two is the conclusion. The gap stays visible instead: the
        // close-out below still reports the run as unverified.
        if (
          options.verificationGate !== false &&
          dirty &&
          !checkRan &&
          !deliveredReport &&
          verificationReminders < verificationReminderLimit
        ) {
          verificationReminders += 1
          const paths = [...changedPaths].slice(0, 6)
          const hint = options.verificationHint
            ? `\n建议运行的检查：${options.verificationHint}`
            : ''
          messages.push({
            role: 'user',
            internal: true,
            content:
              `[验证检查] 你修改了 ${paths.length > 0 ? paths.join('、') : '工作区文件'}，但之后没有成功运行任何验证命令。` +
              `请现在运行最窄的检查（单个测试文件、类型检查或 lint）确认改动；如果确实无法验证，请明确说明原因并直接给出结论。${hint}`,
          })
          await emit({
            type: 'notice',
            level: 'info',
            message: '改动尚未验证，已提醒模型运行检查。',
          })
          continue
        }
        // Batch close-out. Splitting a five-task instruction into five turns
        // gives every item its own final answer; a single batch run must not
        // report once at the end and silently drop the rest. When the plan
        // still shows unfinished items — or no per-item plan exists at all —
        // ask for a per-item close-out before the run can finish. Several asks
        // are allowed (one per task, capped) because splitting into turns gives
        // every task its own chance to be reported.
        if (batchTaskCount >= 2 && itemCloseOutAsks < itemCloseOutLimit && step < maxSteps) {
          const open = plannedItems.filter((item) => item.status !== 'done')
          const missingPlan = plannedItems.length === 0
          if (missingPlan || open.length > 0) {
            itemCloseOutAsks += 1
            // Name both counts, not just the open ones: a plan that listed two
            // of five tasks also has three items nobody is tracking, and that
            // gap used to stay invisible.
            const listed = missingPlan
              ? `本轮指令包含 ${batchTaskCount} 个独立任务，但还没有用 update_plan 逐项列出（当前计划 0/${batchTaskCount} 项）。`
              : `本轮共 ${batchTaskCount} 项任务，计划列了 ${plannedItems.length} 项，其中 ${open.length} 项没有标记 done：${open
                  .map((item) => item.text)
                  .slice(0, 6)
                  .join('；')}。`
            messages.push({
              role: 'user',
              internal: true,
              content:
                `[分项收口] ${listed}` +
                '按拆分执行的同一套标准收尾：' +
                '1) 先用 update_plan 把每一项的真实状态写出来（已完成 done / 仍在做 in_progress / 没开始 pending），不要把没有验证过的项标成 done；' +
                '2) 对每一项各给一句结论——已完成的写清怎么验证的，未完成的写清缺什么、卡在哪；' +
                '3) 某一项如果还能在当前这一轮内做完并验证，先做完它再回答，不要先回答再补。',
            })
            await emit({
              type: 'notice',
              level: 'warn',
              message: missingPlan
                ? '批量任务还没有分项计划，已请模型先逐项列出并交代进度。'
                : `批量任务还有 ${open.length} 项未收口，已请模型逐项交代后再结束。`,
            })
            continue
          }
        }
        // Out of close-out asks and items are still open. A split run would have
        // a separate answer for each of them; here the gap must at least be
        // visible instead of the run ending as if everything were done.
        if (batchTaskCount >= 2) {
          const stillOpen = plannedItems.filter((item) => item.status !== 'done')
          if (stillOpen.length > 0) {
            await emit({
              type: 'notice',
              level: 'warn',
              message:
                `批量任务的 ${stillOpen.length} 项仍未收口：${stillOpen
                  .map((item) => item.text)
                  .slice(0, 6)
                  .join('；')}——最终回答可能只覆盖已完成部分。`,
            })
          }
        }
        if (options.verificationGate !== false && dirty && !checkRan) {
          // The gate already asked once. Never end silently as if the change
          // were verified: the UI and the run record both keep this visible.
          await emit({
            type: 'notice',
            level: 'warn',
            message: '任务结束时改动仍未运行验证命令；这次结果按“未验证”处理。',
          })
        }
        return finish('completed')
      }

      continuations = 0
      for (let index = 0; index < toolCalls.length; ) {
        if (signal?.aborted) {
          await cancelRemaining(toolCalls.slice(index))
          throw abortError()
        }
        const remaining = toolCalls.slice(index)
        const parallel = await takeParallelPrefix(remaining)
        if (parallel.length >= 2) {
          await runParallel(parallel)
          index += parallel.length
          continue
        }
        const call = toolCalls[index]
        if (!call) {
          index += 1
          continue
        }
        await runOne(call)
        index += 1
      }

      // Failures are the strongest in-run signal that the current approach is
      // wrong. After a couple of failures, ask the model to diagnose the error
      // before continuing instead of silently retrying. The prompt is capped so
      // a broken tool cannot turn the run into an expensive reflection loop.
      if (
        reflectionAfterFailures > 0 &&
        maxReflections > 0 &&
        reflections < maxReflections &&
        stepFailures > 0 &&
        failureTotal >= reflectionAfterFailures &&
        failureTotal > reflectedAtFailure &&
        step < maxSteps
      ) {
        reflections += 1
        reflectedAtFailure = failureTotal
        const digest = failureLog.slice(-6).join('\n')
        messages.push({
          role: 'user',
          internal: true,
          content:
            '[运行反思] 本次运行已经出现工具报错。先暂停执行，用几句话复盘，再继续：\n' +
            '1) 直接原因是什么（具体报错）？\n' +
            '2) 根因假设是什么（路径、参数、环境、权限或依赖）？\n' +
            '3) 下一步要改变什么（换命令、换参数或换方案）？\n' +
            '不要重复同一个失败的调用；如果缺少关键信息或权限，直接说明并停下等待用户。\n\n' +
            `最近的失败：\n${digest}`,
        })
        await emit({
          type: 'notice',
          level: 'info',
          message: `检测到工具报错，已触发第 ${reflections} 次运行内反思。`,
        })
      }

      // A repeated failure can mean a missing reusable capability instead of a
      // bad command. Offer the toolsmith path once, with the boundaries stated
      // explicitly, and let the model decide whether it is warranted.
      if (
        options.toolsmith === true &&
        !toolsmithHintSent &&
        failureTotal >= 3 &&
        step < maxSteps
      ) {
        toolsmithHintSent = true
        messages.push({
          role: 'user',
          internal: true,
          content:
            '[能力缺口] 本次运行已连续出现多次工具失败。如果根因是缺少一个会反复用到的能力（例如批量登录授权测试环境、固定格式转换、调用某个内部接口），而不是一次性的命令错误，可以先调用 list_tools 检查是否已有等价工具；确实没有时：\n' +
            '1) 用 subagent(mode="toolsmith") 在 .pilot/tools/<name>/ 写 tool.json、入口文件和自测文件；\n' +
            '2) 用 register_tool 登记，只有自测通过才会被批准；\n' +
            '3) 用 run_tool 传入 JSON 参数运行，并按输出修正。\n' +
            '升级已有工具：先用 list_tools 查重；同名工具已存在时改写它再 register_tool（版本自动 +1，旧版本保留为快照），不要复制成新工具；新版本自测或运行回归时用 rollback_tool 回到上一个批准版本。\n' +
            '如果工具已多次成功、且没有写死本仓库的绝对路径（不依赖工作区即可复用），用 promote_tool 提升为系统默认工具：之后每个工作区都自带它，升级与回滚仍然有效。只做过一次的工具不要提升。\n' +
            '边界：工具只能访问 localhost 或「设置 → 测试目标」里已登记的地址；不得写入或外传任何密钥、Cookie 或真实用户凭据；不得为未授权的验证码训练识别或绕过代码；一次性任务不要造工具。',
        })
        await emit({
          type: 'notice',
          level: 'info',
          message: '检测到反复失败，已提示模型评估是否可以沉淀为可复用工具。',
        })
      }

      // A read-only analysis that keeps searching past this point is usually
      // avoiding the answer. Ask once for a conclusion and the remaining gaps.
      const wrapUpAt = Math.max(0, Math.round(options.wrapUpAt ?? 0))
      if (wrapUpAt > 0 && !wrapUpSent && step >= wrapUpAt && step < maxSteps) {
        wrapUpSent = true
        messages.push({
          role: 'user',
          internal: true,
          content:
            `[收尾] 已用 ${step}/${maxSteps} 步。停止扩展调查：如果关键问题已有证据，现在直接给出结论；只允许再为某个具体缺口做一次读取。` +
            '答案先给结论，再给带路径/行号的证据；区分已验证与推断，并列出未验证项。',
        })
        await emit({
          type: 'notice',
          level: 'info',
          message: '分析已进行多步，已提醒模型收尾作答。',
        })
      }

      // Running out of steps is a budget event, not a crash. One turn before the
      // cap, ask for a normal-work close-out so the run ends with 已完成/未完成/
      // 下一步 instead of a bare step-limit error, and the auto-continue that
      // follows has a concrete first action to resume from. Separate from the
      // analysis `wrapUpAt` above: that one says "stop searching", this one says
      // "finish what you are verifying and report".
      const budgetMargin =
        options.budgetWrapUp && !stepBudget
          ? Math.max(1, Math.min(10, Math.round(maxSteps * 0.08)))
          : 0
      const budgetWrapAt = budgetMargin > 0 ? maxSteps - budgetMargin : 0
      if (
        budgetWrapAt >= 3 &&
        !closeOutSent &&
        wrapUpAt === 0 &&
        step >= budgetWrapAt &&
        step < maxSteps
      ) {
        closeOutSent = true
        messages.push({
          role: 'user',
          internal: true,
          content:
            `[步数预算] 已用 ${step}/${maxSteps} 步，剩余约 ${maxSteps - step} 步。不要再开启新的调查或大改：` +
            '先把当前这一步的验证跑完，然后给出收尾报告：1) 已完成（含怎么验证的）；2) 未完成与原因；3) 下一步要做的第一条具体动作。' +
            '如果确实还需要很多步，就在报告里说清楚还缺什么、建议怎么拆。',
        })
        await emit({
          type: 'notice',
          level: 'warn',
          message: `已用 ${step}/${maxSteps} 步，已提醒模型收尾并列出剩余项。`,
        })
      }

      // Keep a visible plan fresh on long runs without forcing a model turn
      // every step. One reminder per interval at most.
      const reminderEvery = Math.max(0, Math.round(options.planReminderEvery ?? 20))
      if (
        planSeen &&
        reminderEvery > 0 &&
        step - lastPlanStep >= reminderEvery &&
        step - lastPlanReminderStep >= reminderEvery
      ) {
        lastPlanReminderStep = step
        messages.push({
          role: 'user',
          internal: true,
          content:
            '[计划检查] 任务已执行多步。请确认 update_plan 中的条目是否仍然准确，把已完成项标记为 done、当前项标记为 in_progress；如计划已不适用，请更新它。',
        })
      }

      // Plan coverage. Batching only stands in for splitting when the plan has
      // one item per task: a three-item plan for a five-task instruction makes
      // every per-item mechanism (verification reminders, close-out) undercount
      // and lets two tasks finish without ever being reported.
      if (batchTaskCount >= 2 && !planCoverageAsked && plannedItems.length > 0 && step < maxSteps) {
        planCoverageAsked = true
        if (plannedItems.length < batchTaskCount) {
          const shown = plannedItems
            .map((item, index) => `${index + 1}. ${item.text}（${item.status}）`)
            .join('\n')
          messages.push({
            role: 'user',
            internal: true,
            content:
              `[分项计划] 本轮指令包含 ${batchTaskCount} 个独立任务，但计划里只有 ${plannedItems.length} 条：\n${shown}\n` +
              '请补齐为每一项一条（不要合并两项为一条，也不要为了凑数拆出子步骤）；' +
              '已经完成的保持 done，正在做的标 in_progress，其余 pending。',
          })
          await emit({
            type: 'notice',
            level: 'warn',
            message: `计划条目（${plannedItems.length}）少于指令里的任务数（${batchTaskCount}），已请模型补齐分项。`,
          })
        }
      }
      // Item rotation. Splitting a five-task instruction into five turns gives
      // every task its own allowance; one run has a single pool, so the first
      // task can consume all of it and leave the rest untouched. When the rest
      // of the ceiling no longer covers one floor per unfinished item, say so —
      // early enough to act on, late enough not to nag, and again after each
      // item that really did finish, because the remaining pool then has to
      // cover one fewer item but a still-untouched one.
      if (
        batchTaskCount >= 2 &&
        itemRotationAsks < itemRotationLimit &&
        plannedItems.length >= 2 &&
        step < maxSteps
      ) {
        const open = plannedItems.filter((item) => item.status !== 'done')
        const progressed = open.length < itemRotationOpenAtAsk
        if (progressed && needsItemRotation({ openItems: open.length, stepsLeft: maxSteps - step })) {
          itemRotationAsks += 1
          itemRotationOpenAtAsk = open.length
          const listed = open
            .map((item, index) => `${index + 1}. ${item.text}（${item.status}）`)
            .join('\n')
          messages.push({
            role: 'user',
            internal: true,
            content:
              `[分项轮转] 计划里还有 ${open.length} 项未完成，而剩余步数已不够每一项都做完并验证：\n${listed}\n` +
              '拆分执行时每一项都有自己的一份预算，单轮只能共用同一份，所以要主动分配：\n' +
              '1) 不要再在已经做完的那一项上追加打磨；\n' +
              '2) 把当前正在做的那一项做到可验证的状态就停手，先把它的结论与证据写下来；\n' +
              '3) 立即转向下一项，哪怕只能在剩余步数里完成一部分，也比一步不动强；\n' +
              '4) 确实做不完的项，在最终回答里写清「没开始 / 做到哪一步 / 还差什么」。',
          })
          await emit({
            type: 'notice',
            level: 'warn',
            message: `还有 ${open.length} 项未完成，剩余步数不足每项做完，已请模型立即轮转到下一项。`,
          })
        }
      }
      // Dynamic budget: extend only when the step produced new evidence. A run
      // that keeps finding things is never cut by an arbitrary number; a run
      // that repeats itself is asked to close out instead of burning the cap.
      if (stepBudget) {
        const noted = noteStepObservations(progress, stepObservations)
        stepObservations = []
        if (stallCloseOutSent && noted.progress) stallCloseOutSent = false
        if (
          !stallCloseOutSent &&
          shouldStallCloseOut(progress, stepBudget) &&
          step < maxSteps
        ) {
          stallCloseOutSent = true
          messages.push({
            role: 'user',
            internal: true,
            content:
              `[停滞检测] 最近 ${noted.streak} 步没有产生新证据（反复读到相同内容或重复执行同一动作）。` +
              '拆分执行时，这种时候你会换一轮重新提问；这里改用同一条规则：' +
              '1) 立刻给出当前子任务的结论（含已确认的事实与证据位置）；' +
              '2) 明确这一项是完成、被阻塞、还是需要你先回答一个问题；' +
              '3) 若还有未开始的任务项，直接进入下一项，不要留在原地重试。',
          })
          await emit({
            type: 'notice',
            level: 'warn',
            message: `连续 ${noted.streak} 步没有新证据，已请模型收尾并推进下一项。`,
          })
        }
        if (step >= maxSteps && canExtend(progress, stepBudget, maxSteps)) {
          const next = extendLimit(maxSteps, stepBudget)
          progress.extensions += 1
          maxSteps = next
          await emit({
            type: 'notice',
            level: 'info',
            message: `本步有新证据，步数预算自动延展到 ${next}/${stepCeiling} 步。`,
          })
        }
      }
    }

    await emit({
      type: 'notice',
      level: 'warn',
      message: `Reached the step limit (${maxSteps}).`,
    })
    return finish('max_steps', {
      code: 'AGENT_MAX_STEPS',
      message: `Step limit of ${maxSteps} reached`,
    })
  } catch (error) {
    if (isAbort(error, signal)) return finish('cancelled')
    const message = error instanceof Error ? error.message : String(error)
    return finish('failed', { code: 'AGENT_ERROR', message })
  }
}

/**
 * Keep roughly the newest `keep` messages, but never start the retained tail
 * on a tool result: a tool result without its assistant tool call is rejected
 * by the providers. Walking back to the assistant keeps the pair together.
 * This also works for long single-task runs that never see a second user turn.
 */
function findSummaryBoundary(messages: AgentMessage[], keep: number): number {
  let start = Math.max(0, messages.length - keep)
  while (start > 0 && messages[start]?.role === 'tool') start -= 1
  return start
}

/**
 * Label a carried-forward first turn without stacking the header on repeated
 * summary passes, and strip it again when that turn becomes the live task (a
 * later user message no longer survives the cut).
 *
 * Content that already declares itself closed work — a folded-turns digest or a
 * model summary — is passed through untouched: stripping its header would hand
 * the old task back to the model as the live instruction, which is exactly the
 * drift this framing exists to prevent.
 */
function frameFirstUserTurn(message: AgentMessage, background: boolean): string {
  const content = message.content
  // A folded-turns digest or a model summary is closed work on its own terms.
  // Re-labelling it (or stripping its label when it stops being background)
  // would hand an old task back to the model as the live instruction, which is
  // exactly the drift this framing exists to prevent.
  if (message.earlierWork || content.startsWith(EARLIER_WORK_HEADER)) return content
  const bare = content.startsWith(`${EARLIER_TASK_HEADER}\n`)
    ? content.slice(EARLIER_TASK_HEADER.length + 1)
    : content === EARLIER_TASK_HEADER
      ? ''
      : content
  return background ? `${EARLIER_TASK_HEADER}\n${bare}` : bare
}
