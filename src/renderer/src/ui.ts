import type {
  Plan,
  StoredMessage,
  ToolCall,
  ToolResult,
  ToolRisk,
} from '../../shared/types'
import { t } from './i18n'

export type MainView =
  | 'chat'
  | 'memory'
  | 'evolution'
  | 'knowledge'
  | 'tools'
  | 'plugins'
  | 'module-check'
  | 'self-check'

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
    }

export interface LiveRun {
  runId: string
  sessionId: string
  content: string
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

const CONTROL_TOOLS = new Set(['remember', 'update_plan', 'add_todo', 'propose_self_update'])

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

/**
 * Convert persisted messages into display blocks. Consecutive tool activity for
 * a run collapses into a single process block.
 */
export function buildTranscript(messages: StoredMessage[]): UIMessage[] {
  const out: UIMessage[] = []
  let process: Extract<UIMessage, { kind: 'process' }> | null = null
  let tools = new Map<string, ToolView>()
  let partSeq = 0

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

  for (const message of messages) {
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
      if (message.toolCalls && message.toolCalls.length > 0) {
        if (!process || (message.runId && process.runId && message.runId !== process.runId)) {
          process = startProcess(message.runId)
        }
        if (message.reasoning?.trim()) {
          process!.reasoning.push(message.reasoning)
          process!.parts!.push({
            kind: 'reasoning',
            key: `r-${partSeq++}`,
            text: message.reasoning,
            at: message.createdAt,
          })
        }
        if (message.content.trim()) {
          process!.text.push(message.content)
          process!.parts!.push({
            kind: 'note',
            key: `n-${partSeq++}`,
            text: message.content,
            at: message.createdAt,
          })
        }
        for (const call of message.toolCalls) {
          const tool = createToolView(call, undefined, message.createdAt)
          process!.tools.push(tool)
          process!.parts!.push({ kind: 'tool', key: tool.id, toolId: tool.id })
          tools.set(call.id, tool)
        }
        continue
      }

      process = null
      tools = new Map()
      if (message.content.trim() || message.reasoning?.trim()) {
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
  const hasReasoning = live.processReasoning.some((part) => part.trim())
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

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
}
