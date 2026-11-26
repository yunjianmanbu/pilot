import type {
  Plan,
  SessionProcessSummary,
  StoredMessage,
  ToolCall,
  ToolResult,
  ToolRisk,
} from '../../shared/types'
import { t } from './i18n'

export type MainView =
  | 'chat'
  | 'todos'
  | 'scheduled'
  | 'memory'
  | 'tools'
  | 'models'
  | 'preferences'
  | 'plugins'
  /** 左下角三个全局资源页：知识（消息检索）、链接、办公文档。 */
  | 'knowledge'
  | 'links'
  | 'documents'

export interface ToolView {
  id: string
  name: string
  args: Record<string, unknown>
  risk: ToolRisk
  status: 'running' | 'waiting' | 'ok' | 'error' | 'denied'
  result?: ToolResult
  durationMs?: number
  approvalReason?: string
  /**
   * Wall-clock moment the call was issued. Live runs stamp the event arrival,
   * replayed history uses the stored message time, so the expanded card can
   * say when the step actually ran.
   */
  at?: string
}

/**
 * One ordered step inside the execution process box. Reasoning, interim notes
 * and tool calls share a single sequence so the collapsed view can show only
 * the newest steps regardless of their type.
 */
export type ProcessPart =
  | { kind: 'reasoning'; key: string; text: string; at?: string }
  | { kind: 'note'; key: string; text: string; at?: string }
  | { kind: 'tool'; key: string; toolId: string }

export type UIMessage =
  | {
      kind: 'user'
      id: string
      content: string
      createdAt: string
      /** Internal continuation prompt; rendered as a compact marker. */
      control?: boolean
      images?: string[]
      references?: string[]
    }
  | {
      kind: 'assistant'
      id: string
      content: string
      reasoning?: string
      runId?: string
      createdAt: string
      /** Plan snapshot produced by this turn, if any. */
      plan?: Plan
    }
  | {
      kind: 'process'
      id: string
      runId?: string
      text: string[]
      reasoning: string[]
      tools: ToolView[]
      /** Chronological order of `text`/`reasoning`/`tools`; derived when absent. */
      parts?: ProcessPart[]
      compacted?: string
      error?: string
      live?: boolean
      /** Run start, so a live box can count how long it has been working. */
      startedAt?: number
      /** Steps this box has not loaded yet; expanding it fetches them. */
      pending?: { stepCount: number; toolCount: number; failed: number }
    }

export interface LiveRun {
  runId: string
  sessionId: string
  content: string
  /**
   * The run's answer, once it has been recognised as one. Text that arrives
   * afterwards belongs to the process: a model that writes its report and then
   * appends a verification recap used to replace the answer on screen, so the
   * reader ended up looking at the recap and calling it the conclusion. The
   * answer is frozen here and the late text goes to the step box instead.
   */
  answer?: string
  reasoning: string
  processText: string[]
  processReasoning: string[]
  tools: ToolView[]
  /** Chronological order of the live process entries. */
  parts?: ProcessPart[]
  compacted?: string
  error?: string
  step: number
  startedAt: number
  status: 'running' | 'done'
}

const READ_TOOLS = new Set([
  'list_directory',
  'read_file',
  'get_file_info',
  'search_files',
  'git_status',
  'git_diff',
  'git_log',
  'explore',
])

const CONTROL_TOOLS = new Set([
  'remember',
  'update_plan',
  'add_todo',
  'schedule_task',
  'propose_self_update',
])

export function inferRisk(name: string): ToolRisk {
  if (READ_TOOLS.has(name)) return 'read'
  if (name === 'run_command') return 'exec'
  if (CONTROL_TOOLS.has(name)) return 'control'
  return 'write'
}

export function createToolView(call: ToolCall, risk?: ToolRisk, at?: string): ToolView {
  return {
    id: call.id,
    name: call.name,
    args: call.arguments ?? {},
    risk: risk ?? inferRisk(call.name),
    status: 'running',
    at: at ?? new Date().toISOString(),
  }
}

export function summarizeTool(tool: ToolView): string {
  const args = tool.args
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
  switch (tool.name) {
    case 'read_file':
      return text(args['path'])
    case 'write_file':
      return text(args['path'])
    case 'apply_patch': {
      const edits = Array.isArray(args['edits']) ? args['edits'].length : 0
      return t("{v1}{v2}", { v1: text(args['path']), v2: edits ? t(" · {v1} 处修改", { v1: edits }) : '' })
    }
    case 'list_directory':
      return text(args['path']) || '.'
    case 'search_files':
      return `"${text(args['pattern'])}"${args['path'] ? ` · ${text(args['path'])}` : ''}`
    case 'explore':
      return t("只读探索：{v1}", { v1: text(args['task']) })
    case 'run_command':
    case 'run_shell':
      return text(args['command'])
    case 'git_status':
      return t("工作区状态")
    case 'git_diff':
      return text(args['path']) || (args['staged'] ? t("已暂存改动") : t("未暂存改动"))
    case 'git_log':
      return t("最近 {v1} 条提交", { v1: text(args['limit']) || 10 })
    case 'remember':
      return text(args['content'])
    case 'update_plan':
      return text(args['goal'])
    case 'add_todo': {
      const items = Array.isArray(args['items']) ? args['items'] : []
      const first = text(items[0])
      return items.length > 1 ? `${first} +${items.length - 1}` : first
    }
    case 'schedule_task': {
      const action = text(args['action'])
      const when =
        args['kind'] === 'interval'
          ? t('每 {v1} 分钟', { v1: text(args['intervalMinutes']) || 60 })
          : args['kind'] === 'daily'
            ? t('每天 {v1}', { v1: text(args['timeOfDay']) })
            : args['delayMinutes'] !== undefined
              ? t('{v1} 分钟后', { v1: text(args['delayMinutes']) })
              : ''
      return [
        action === 'add' ? t('定时任务') : '',
        when,
        text(args['content']) || text(args['taskId']),
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'propose_self_update':
      return text(args['title'])
    case 'get_file_info':
      return text(args['path'])
    default:
      return Object.keys(args).length > 0 ? JSON.stringify(args) : t("调用工具")
  }
}

function attachToolResult(
  tool: ToolView,
  result: ToolResult,
  isError?: boolean,
): void {
  tool.result = result
  tool.status = isError || !result.ok ? 'error' : 'ok'
  tool.durationMs = result.durationMs
}

// Shared with the loop: the renderer decides which chunk to show as the answer,
// the loop decides whether a run has already delivered one. Imported for local
// use and re-exported so existing imports keep working.
import { isDeliverableText } from '../../shared/deliverable'

export { isDeliverableText }

/** Where each run's last step sits (a tool result or a tool-calling turn). */
function lastStepIndexes(messages: StoredMessage[]): Map<string, number> {
  const out = new Map<string, number>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (!message.runId) continue
    const isStep =
      message.role === 'tool' ||
      (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
    if (isStep) out.set(message.runId, index)
  }
  return out
}

/**
 * The assistant messages that are this turn's outcome rather than its process.
 *
 * Position covers the common case: text after the run's last step is the answer.
 * Position alone is not enough, because a model often writes the whole report and
 * *then* removes its temporary scripts or closes a process. Judging by position
 * alone pushed that report into the collapsed execution box and left the reader
 * with only the closing sentence, so a report-shaped chunk counts as an answer
 * wherever it sits in the run.
 *
 * Only the *first* report-shaped chunk of a run is its answer, and once a run
 * has an answer nothing it says afterwards is one. The live view follows the same
 * rule (`appendLiveProcessText`), so a run shows one conclusion while it streams
 * and one conclusion after a reload; before this, a short closing sentence was an
 * answer block in the transcript but extra text under the answer while streaming.
 */
export function answerMessageIds(messages: StoredMessage[]): Set<string> {
  const lastStep = lastStepIndexes(messages)
  const out = new Set<string>()
  const deliveredRuns = new Set<string>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const body = message.content ?? ''
    if (!body.trim()) continue
    const calls = message.toolCalls?.length ?? 0
    const runId = message.runId
    const midRun = Boolean(runId) && (lastStep.get(runId!) ?? -1) > index
    if (isDeliverableText(body)) {
      if (!runId || !deliveredRuns.has(runId)) out.add(message.id)
      if (runId) deliveredRuns.add(runId)
      continue
    }
    if (!calls && !midRun && !(runId && deliveredRuns.has(runId))) out.add(message.id)
  }
  return out
}

/**
 * Convert persisted messages into display blocks. Consecutive tool activity for
 * a run collapses into a single process block.
 */
export function buildTranscript(messages: StoredMessage[]): UIMessage[] {
  const out: UIMessage[] = []
  let process: Extract<UIMessage, { kind: 'process' }> | null = null
  let tools = new Map<string, ToolView>()
  let partSeq = 0

  // A note written in the middle of a run (before another tool call of the same
  // run) is part of the process; a note after the last step is the answer.
  // Without this an assistant note split one run into one collapsed box per
  // note, so a 24-turn conversation showed dozens of execution boxes instead of
  // 24. `answerMessageIds` also lifts a report-shaped chunk that was written
  // before the run's closing cleanup.
  const answers = answerMessageIds(messages)

  const startProcess = (runId?: string): Extract<UIMessage, { kind: 'process' }> => {
    const block: Extract<UIMessage, { kind: 'process' }> = {
      kind: 'process',
      id: `process-${runId ?? 'run'}-${out.length}`,
      runId,
      text: [],
      reasoning: [],
      tools: [],
      parts: [],
    }
    out.push(block)
    process = block
    tools = new Map()
    return block
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      process = null
      tools = new Map()
      const images = message.images ?? []
      const references = message.references ?? []
      if (message.content.trim() || images.length > 0) {
        out.push({
          kind: 'user',
          id: message.id,
          content: message.content,
          createdAt: message.createdAt,
          ...(message.control ? { control: true } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(references.length > 0 ? { references } : {}),
        })
      }
      continue
    }

    if (message.role === 'assistant') {
      const calls = message.toolCalls ?? []
      const reasoning = message.reasoning ?? ''

      // This message is the turn's outcome: show it in the dialogue and end the
      // execution box here. Its own tool calls (a report written in the same
      // message as its closing cleanup) go into a fresh box after the answer.
      if (answers.has(message.id)) {
        process = null
        tools = new Map()
        if (message.content.trim() || reasoning.trim()) {
          out.push({
            kind: 'assistant',
            id: message.id,
            content: message.content,
            ...(message.reasoning ? { reasoning: message.reasoning } : {}),
            ...(message.runId ? { runId: message.runId } : {}),
            ...(message.plan ? { plan: message.plan } : {}),
            createdAt: message.createdAt,
          })
        }
        if (calls.length === 0) continue
        process = startProcess(message.runId)
        for (const call of calls) {
          const tool = createToolView(call, undefined, message.createdAt)
          process.tools.push(tool)
          process.parts!.push({ kind: 'tool', key: tool.id, toolId: tool.id })
          tools.set(call.id, tool)
        }
        continue
      }

      // Everything below is narration: a step that calls tools, or a sentence
      // written before the run's last step.
      if (!process || (message.runId && process.runId && message.runId !== process.runId)) {
        process = startProcess(message.runId)
      }
      if (reasoning.trim()) {
        process.reasoning.push(reasoning)
        process.parts!.push({
          kind: 'reasoning',
          key: `r-${partSeq++}`,
          text: reasoning,
          at: message.createdAt,
        })
      }
      if (message.content.trim()) {
        process.text.push(message.content)
        process.parts!.push({
          kind: 'note',
          key: `n-${partSeq++}`,
          text: message.content,
          at: message.createdAt,
        })
      }
      for (const call of calls) {
        const tool = createToolView(call, undefined, message.createdAt)
        process.tools.push(tool)
        process.parts!.push({ kind: 'tool', key: tool.id, toolId: tool.id })
        tools.set(call.id, tool)
      }
      continue
    }

    if (message.role === 'tool') {
      const tool = message.toolCallId ? tools.get(message.toolCallId) : undefined
      const result: ToolResult = {
        ok: !message.isError,
        output: message.content,
        ...(message.isError ? { error: message.content } : {}),
      }
      if (tool) {
        attachToolResult(tool, result, message.isError)
      } else if (process) {
        const tool: ToolView = {
          id: message.toolCallId ?? message.id,
          name: message.name ?? 'tool',
          args: {},
          risk: inferRisk(message.name ?? ''),
          status: message.isError ? 'error' : 'ok',
          result,
          durationMs: result.durationMs,
          at: message.createdAt,
        }
        process.tools.push(tool)
        process.parts?.push({ kind: 'tool', key: tool.id, toolId: tool.id })
      }
    }
  }

  return out.filter(
    (entry) =>
      entry.kind !== 'process' ||
      entry.tools.length > 0 ||
      entry.text.some((part) => part.trim()) ||
      entry.reasoning.some((part) => part.trim()),
  )
}

/**
 * Put the execution runs a dialogue page skipped back into the timeline as
 * collapsed placeholders. A placeholder carries only counts, so an old run
 * costs a few bytes until the reader expands it.
 *
 * A run is placed after the dialogue message it follows and nowhere else: an
 * anchor that is not on screen means the run belongs to an earlier window the
 * reader has not scrolled to, so stacking those placeholders on top would show
 * a wall of execution boxes above the conversation.
 */
export function withPendingProcesses(
  blocks: UIMessage[],
  processes: SessionProcessSummary[],
): UIMessage[] {
  if (processes.length === 0) return blocks
  const loaded = new Set<string>()
  for (const block of blocks) {
    if (block.kind === 'process' && block.runId && !block.pending) loaded.add(block.runId)
  }
  const pending = processes.filter((entry) => !loaded.has(entry.runId))
  if (pending.length === 0) return blocks
  const out = [...blocks]
  // Newest first while splicing so runs that share one anchor keep their order.
  for (const summary of [...pending].reverse()) {
    const anchor = summary.afterId ? out.findIndex((block) => block.id === summary.afterId) : -1
    if (anchor < 0) continue
    out.splice(anchor + 1, 0, {
      kind: 'process',
      id: `pending-${summary.runId}`,
      runId: summary.runId,
      text: [],
      reasoning: [],
      tools: [],
      parts: [],
      pending: {
        stepCount: summary.stepCount,
        toolCount: summary.toolCount,
        failed: summary.failed,
      },
    })
  }
  return out
}

/**
 * Runs whose execution steps are already part of `messages`.
 *
 * A run id is not proof of that: stored user messages (and answers) carry the
 * id of the run they belong to, so counting every message with a run id marked
 * every run as loaded and dropped every placeholder - the reader then saw a
 * dialogue whose execution boxes could never be opened. Only a tool result or
 * a tool-calling turn is a step.
 */
export function runsWithSteps(messages: StoredMessage[]): Set<string> {
  const out = new Set<string>()
  for (const message of messages) {
    if (!message.runId) continue
    const isStep =
      message.role === 'tool' ||
      (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)
    if (isStep) out.add(message.runId)
  }
  return out
}

/** Runs whose exchange the reader already sees in full: a question and its answer. */
export function runsWithAnswer(messages: StoredMessage[]): Set<string> {
  const answers = answerMessageIds(messages)
  const out = new Set<string>()
  for (const message of messages) {
    if (!message.runId || message.role !== 'assistant') continue
    if (!answers.has(message.id)) continue
    out.add(message.runId)
  }
  return out
}

/**
 * Runs that deserve a collapsed box of their own after paging back.
 *
 * Paging a conversation returns the questions and the answers and leaves their
 * execution steps behind. Giving every one of those runs a "not loaded yet"
 * box buries the dialogue under a stack of grey placeholders - one per turn,
 * growing with every scroll. A run that finished normally does not need that
 * box: its answer is the outcome the reader asked for. A run that stopped
 * without an answer (interrupted, failed, still working) is exactly the case
 * where the box is all that is left, so only those keep one.
 */
export function processPlaceholders(
  reported: readonly SessionProcessSummary[],
  messages: StoredMessage[],
): SessionProcessSummary[] {
  if (reported.length === 0) return []
  const answered = runsWithAnswer(messages)
  return reported.filter((entry) => !answered.has(entry.runId))
}

/**
 * Merge the runs a page reported as placeholders with the ones already on
 * screen. A run whose steps are in the loaded transcript is dropped: the box
 * is real content now, and putting it back would show the same run twice.
 */
export function mergePendingProcesses(
  previous: SessionProcessSummary[],
  incoming: SessionProcessSummary[],
  loadedRunIds: ReadonlySet<string>,
): SessionProcessSummary[] {
  const out: SessionProcessSummary[] = []
  const seen = new Set<string>()
  for (const entry of [...previous, ...incoming]) {
    if (loadedRunIds.has(entry.runId) || seen.has(entry.runId)) continue
    seen.add(entry.runId)
    out.push(entry)
  }
  return out
}

/** Steps the reader already opened for one run, kept for the session's lifetime. */
export interface CachedRun {
  /** Dialogue message the run follows, when it was known at load time. */
  afterId?: string
  messages: StoredMessage[]
}

/**
 * Splice the runs a reader already opened back into a freshly loaded
 * transcript. Only runs whose anchor is on screen are restored: those are the
 * ones sitting inside the window, and putting them back keeps the box the
 * reader read instead of a "not loaded yet" placeholder. A run whose anchor is
 * gone belongs to an earlier window and stays out, so reopening a conversation
 * never grows a stack of boxes above its first message.
 */
export function restoreCachedRuns(
  messages: StoredMessage[],
  cached: ReadonlyMap<string, CachedRun>,
): StoredMessage[] {
  if (cached.size === 0) return messages
  const known = new Set(messages.map((message) => message.id))
  const anchored = new Map<number, StoredMessage[]>()
  const runs = [...cached.values()].sort(
    (left, right) => firstTime(left) - firstTime(right),
  )
  for (const entry of runs) {
    const fresh = entry.messages.filter((message) => !known.has(message.id))
    if (fresh.length === 0) continue
    const anchor = entry.afterId
      ? messages.findIndex((message) => message.id === entry.afterId)
      : -1
    if (anchor < 0) continue
    const bucket = anchored.get(anchor)
    if (bucket) bucket.push(...fresh)
    else anchored.set(anchor, fresh)
    for (const step of fresh) known.add(step.id)
  }
  // Newest anchor first, so an earlier insertion never shifts a later index.
  let out = messages
  for (const position of [...anchored.keys()].sort((left, right) => right - left)) {
    out = [...out.slice(0, position + 1), ...anchored.get(position)!, ...out.slice(position + 1)]
  }
  return out
}

function firstTime(entry: CachedRun): number {
  const stamp = entry.messages[0]?.createdAt
  const time = stamp ? Date.parse(stamp) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

/**
 * Insert one run's stored steps after the dialogue message they follow. The
 * dialogue page holds only user/answer messages, so the steps are spliced back
 * in instead of replacing the transcript. When the anchor is gone the steps
 * still land in transcript order, on the first message written after them.
 */
export function insertProcessMessages(
  messages: StoredMessage[],
  incoming: StoredMessage[],
  afterId?: string,
): StoredMessage[] {
  const existing = new Set(messages.map((message) => message.id))
  const fresh = incoming.filter((message) => !existing.has(message.id))
  if (fresh.length === 0) return messages
  const anchor = afterId ? messages.findIndex((message) => message.id === afterId) : -1
  const index = anchor >= 0 ? anchor + 1 : timeIndex(messages, fresh[0])
  return [...messages.slice(0, index), ...fresh, ...messages.slice(index)]
}

/** First message written after `stamp`, or the end when the steps are newest. */
function timeIndex(messages: StoredMessage[], step: StoredMessage | undefined): number {
  const stamp = step?.createdAt
  if (!stamp) return messages.length
  const after = messages.findIndex((message) => message.createdAt > stamp)
  return after < 0 ? messages.length : after
}

/** Plain-text transcript for copying the whole conversation. */
export function transcriptText(messages: StoredMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user' && !message.control) {
      if (message.content.trim()) parts.push(t("## 我\n{v1}", { v1: message.content.trim() }))
      if (message.images?.length) parts.push(t("（附带 {v1} 张图片）", { v1: message.images.length }))
      if (message.references?.length) {
        const names = message.references.map(
          (path) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path,
        )
        parts.push(t("（参照项目：{v1}）", { v1: names.join('、') }))
      }
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.trim()) parts.push(`## Pilot\n${message.content.trim()}`)
      for (const call of message.toolCalls ?? []) {
        const args = JSON.stringify(call.arguments ?? {})
        parts.push(t("> 调用 {v1} {v2}", { v1: call.name, v2: args.length > 400 ? `${args.slice(0, 400)}…` : args }))
      }
      continue
    }
    if (message.role === 'tool' && message.content.trim()) {
      const body = message.content.trim()
      parts.push(
        t("> {v1} {v2}\n{v3}", { v1: message.name ?? 'tool', v2: message.isError ? t("失败") : t("完成"), v3: body.length > 4_000 ? `${body.slice(0, 4_000)}…` : body }),
      )
    }
  }
  return parts.join('\n\n')
}

/**
 * Text the answer area should show for a run that is still streaming.
 *
 * Once the answer is frozen the answer area never changes again: everything the
 * model writes afterwards is process (see `appendLiveProcessText`), which is
 * also where the stored transcript puts it. Showing a closing line here used to
 * cost more than it gave: the first few frames of a verification recap are too
 * short to read as a report, so they appeared under the answer and then vanished
 * when the text grew past the threshold — the reader watched a second conclusion
 * appear, disappear and reappear in the step box.
 */
export function liveAnswerText(live: LiveRun | undefined): string {
  if (!live) return ''
  if (live.answer?.trim()) return live.answer
  return live.content
}

const LIVE_NOTE_PREFIX = 'live-note-'

/**
 * Fold one streamed delta into a live run.
 *
 * Kept here rather than inside the renderer's event handler so the branching is
 * testable: before the answer is frozen the text is the answer in progress, and
 * after it the text grows the process box. Text must never be buffered invisibly
 * in either case, or the reader watches a run that stopped moving.
 */
export function applyLiveDelta(
  live: LiveRun,
  delta: { text?: string; reasoning?: string },
): LiveRun {
  const withText = delta.text
    ? live.answer
      ? appendLiveProcessText(live, delta.text)
      : { ...live, content: live.content + delta.text }
    : live
  return delta.reasoning ? appendLiveReasoning(withText, delta.reasoning) : withText
}

/**
 * Append streamed thinking to the live run's process parts.
 *
 * Thinking used to live in a block of its own above the answer, which appeared
 * when the model started thinking and vanished the moment the step settled - the
 * transcript moved up and down under the reader's eyes on every step. Writing the
 * text into the step box instead keeps it where the rest of the work is, and the
 * folded row only ever shows its first line, so a growing stream cannot change
 * the height of the page.
 *
 * The part key is derived from the step, not from the tool call that ends it: the
 * block is created by the first delta of the step and keeps its identity until
 * the run ends, so React updates the row instead of remounting it.
 */
export function appendLiveReasoning(live: LiveRun, text: string, at?: string): LiveRun {
  if (!text) return live
  const key = `r-${live.step}`
  const parts = live.parts ?? []
  const last = parts[parts.length - 1]
  const reasoning = live.reasoning + text
  if (last && last.kind === 'reasoning' && last.key === key) {
    return {
      ...live,
      reasoning,
      parts: [...parts.slice(0, -1), { ...last, text: last.text + text }],
    }
  }
  return {
    ...live,
    reasoning,
    parts: [
      ...parts,
      { kind: 'reasoning', key, text, at: at ?? new Date().toISOString() },
    ],
  }
}

/**
 * Append text to the live process box, growing the last streaming note.
 *
 * Called for every delta that arrives after the run's answer is frozen. The
 * answer area stays still and the text is visible while it arrives, instead of
 * being buffered invisibly until the next tool call settles the message.
 */
export function appendLiveProcessText(live: LiveRun, text: string): LiveRun {
  if (!text) return live
  const parts = live.parts ?? []
  const last = parts[parts.length - 1]
  if (last && last.kind === 'note' && last.key.startsWith(LIVE_NOTE_PREFIX)) {
    const merged = [...parts.slice(0, -1), { ...last, text: last.text + text }]
    const processText =
      live.processText.length > 0
        ? [...live.processText.slice(0, -1), live.processText[live.processText.length - 1]! + text]
        : [text]
    return { ...live, parts: merged, processText }
  }
  return {
    ...live,
    parts: [...parts, { kind: 'note', key: `${LIVE_NOTE_PREFIX}${live.step}`, text }],
    processText: [...live.processText, text],
  }
}

/**
 * Close the text that is currently streaming into a live run.
 *
 * Called when a message ends: the first report-shaped text becomes the run's
 * answer, and a second report-shaped text is carried into the process instead -
 * a run that wrote its conclusion and then appended a verification recap used
 * to show two equally formatted conclusions on screen, and the reader could not
 * tell which one was the answer. A short closing line stays in the answer area
 * because the stored transcript keeps it there too.
 *
 * A message boundary caused by a truncated answer (`freeze: false`) must not
 * freeze a half-written report: the loop re-sends the partial answer, and the
 * continuation would then be stranded in the step box.
 */
export function settleLiveAnswer(
  live: LiveRun,
  key: string,
  options?: { freeze?: boolean },
): LiveRun {
  const text = live.content.trim() ? live.content : ''
  if (!text) return live
  const freeze = options?.freeze !== false
  const report = isDeliverableText(text)
  if (!live.answer) {
    return freeze && report ? { ...live, answer: text, content: '' } : live
  }
  if (!report) return live
  return {
    ...live,
    content: '',
    processText: [...live.processText, text],
    parts: [...(live.parts ?? []), { kind: 'note', key, text }],
  }
}

export function emptyLiveRun(sessionId: string): LiveRun {
  return {
    runId: '',
    sessionId,
    content: '',
    reasoning: '',
    processText: [],
    processReasoning: [],
    tools: [],
    parts: [],
    step: 0,
    startedAt: Date.now(),
    status: 'running',
  }
}

export function liveProcess(live: LiveRun | undefined): Extract<UIMessage, { kind: 'process' }> | null {
  if (!live) return null
  const hasTools = live.tools.length > 0
  const hasText = live.processText.some((part) => part.trim())
  // Thinking that has not yet been claimed by a tool call lives only in the
  // parts (and in `reasoning`), so the box has to open on it: the reader asked
  // to see thinking inside the step box, not in a separate block that flickers.
  const hasReasoning =
    live.processReasoning.some((part) => part.trim()) ||
    (live.parts ?? []).some((part) => part.kind === 'reasoning' && part.text.trim())
  if (!hasTools && !hasText && !hasReasoning && !live.compacted && !live.error) return null
  return {
    kind: 'process',
    id: `live-process-${live.runId}`,
    runId: live.runId,
    text: live.processText,
    reasoning: live.processReasoning,
    tools: live.tools,
    parts: live.parts ?? [],
    ...(live.compacted ? { compacted: live.compacted } : {}),
    ...(live.error ? { error: live.error } : {}),
    startedAt: live.startedAt,
    live: true,
  }
}

/**
 * Newest `limit` steps of a process block plus how many older ones are hidden.
 * The collapsed execution box shows only these.
 */
export function recentProcessParts(
  process: Extract<UIMessage, { kind: 'process' }>,
  limit: number,
): { parts: ProcessPart[]; hidden: number } {
  const all = processParts(process)
  const hidden = Math.max(0, all.length - Math.max(0, limit))
  return { parts: hidden > 0 ? all.slice(hidden) : all, hidden }
}

/**
 * Ordered execution steps of a process block. Blocks built before `parts`
 * existed fall back to the grouped arrays.
 */
export function processParts(process: Extract<UIMessage, { kind: 'process' }>): ProcessPart[] {
  if (process.parts && process.parts.length > 0) return process.parts
  const out: ProcessPart[] = []
  process.reasoning.forEach((text, index) => {
    if (text.trim()) out.push({ kind: 'reasoning', key: `r-${index}`, text })
  })
  process.text.forEach((text, index) => {
    if (text.trim()) out.push({ kind: 'note', key: `n-${index}`, text })
  })
  process.tools.forEach((tool) => out.push({ kind: 'tool', key: tool.id, toolId: tool.id }))
  return out
}

export function toolStatusLabel(status: ToolView['status']): string {
  switch (status) {
    case 'running':
      return t("执行中")
    case 'waiting':
      return t("等待批准")
    case 'ok':
      return t("完成")
    case 'error':
      return t("失败")
    case 'denied':
      return t("已拒绝")
  }
}

export function riskLabel(risk: ToolRisk): string {
  switch (risk) {
    case 'read':
      return t("只读")
    case 'write':
      return t("写入")
    case 'exec':
      return t("命令")
    case 'control':
      return t("控制")
  }
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Clock label of one execution step, e.g. "14:05:32". */
export function formatClock(iso?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatRelative(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return t("刚刚")
  if (diff < hour) return t("{v1} 分钟前", { v1: Math.floor(diff / minute) })
  if (diff < day) return t("{v1} 小时前", { v1: Math.floor(diff / hour) })
  if (diff < 7 * day) return t("{v1} 天前", { v1: Math.floor(diff / day) })
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * Strip Electron's IPC wrapper from a rejected invoke so the toast shows the
 * message the main process actually threw. `Error invoking remote method
 * 'pilot:profile-benchmark': Error: No API key ...` becomes
 * `No API key ...`.
 */
export function stripIpcWrapper(message: string): string {
  const match = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?([\s\S]*)$/.exec(message)
  const cleaned = (match ? (match[1] ?? '') : message).trim()
  return cleaned || message
}

/** Elapsed time for a running task, e.g. "3m 12s". */
export function formatElapsedSince(iso?: string): string {
  if (!iso) return ''
  const start = new Date(iso).getTime()
  if (Number.isNaN(start)) return ''
  return formatDuration(Date.now() - start)
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/** Below this the counter would only flash, so a quick call stays quiet. */
export const RUNNING_LABEL_MIN_MS = 3_000
/** From here on the label also says the step has not stalled. */
export const RUNNING_LABEL_QUIET_MS = 45_000

/**
 * Elapsed label for a tool that has not returned yet. A command that is still
 * working gets a counter that keeps moving, so a two-minute build never looks
 * like a frozen window; once it is long enough to worry about, the label says
 * so explicitly instead of leaving the user to guess.
 */
export function runningToolLabel(at: string | undefined, now = Date.now()): string {
  if (!at) return ''
  const start = new Date(at).getTime()
  if (Number.isNaN(start)) return ''
  const elapsed = now - start
  if (elapsed < RUNNING_LABEL_MIN_MS) return ''
  const duration = formatDuration(elapsed)
  return elapsed < RUNNING_LABEL_QUIET_MS
    ? t("已运行 {v1}", { v1: duration })
    : t("已运行 {v1} · 仍在执行", { v1: duration })
}

/**
 * Elapsed suffix of the topbar "running" pill. The whole run is what the user
 * waits on, so the clock starts with the run and keeps moving even while the
 * model thinks without calling a tool.
 */
export function runElapsedLabel(
  startedAt: number | undefined,
  now = Date.now(),
): string {
  if (!startedAt || Number.isNaN(startedAt)) return ''
  const elapsed = now - startedAt
  if (elapsed < RUNNING_LABEL_MIN_MS) return ''
  return formatDuration(elapsed)
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
}
