import { homedir } from 'node:os'
import type { AppLogEntry } from './app-log'
import type { ApprovalDecidedBy, RunEvent, RunRecord } from '../shared/types'

/**
 * 把「一次运行怎么结束」「某次高危工具调用」「某次审批怎么决的」「崩溃」翻译成
 * `app-log.ts` 的 `AppLogEntry`。
 *
 * 全部是纯函数：不碰 Electron、不读全局状态，所以可以直接单测，主进程只在事件
 * 流过 `broadcast` 时调一次。边界与 `app-log.ts` 一致 —— 只写元数据（谁、何时、
 * 哪个工具、结果），不写命令参数、提问正文、工具输出或密钥。
 *
 * 键名注意：`app-log.ts` 的 `SENSITIVE_KEY` 会把键名里带 `token` / `message` /
 * `content` / `prompt` / `stdout` 的字段整段替换成 `<redacted>`。所以用量字段
 * 固定写成 `input` / `output` / `cacheHit`，错误摘要写成 `summary`。
 */

const MAX_FIELD = 240

export type { ApprovalDecidedBy }

/**
 * 把任意异常压成一行摘要：错误名 + 消息 + 前几层调用栈，并把用户主目录折叠成
 * `~`。与 `system-info.ts` 的采集口径一致 —— 不出现用户名、主机名或绝对家目录。
 *
 * 调用方不应把这段摘要当成「脱敏完成」：凭据形状的字符串仍由 `app-log.ts` 的
 * `redactSecrets` 在写盘前处理，这里只负责去掉本机身份信息并限长。
 */
export function describeError(error: unknown): string {
  const home = homedir()
  const collapse = (text: string): string => {
    const withoutHome = home ? text.split(home).join('~') : text
    return withoutHome.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD)
  }
  if (error instanceof Error) {
    const frames = (error.stack ?? '').split('\n').slice(1, 4).join(' ')
    const head = `${error.name}: ${error.message}`
    return collapse(frames ? `${head} @ ${frames}` : head)
  }
  if (typeof error === 'string') return collapse(error)
  try {
    return collapse(JSON.stringify(error) ?? String(error))
  } catch {
    return collapse(String(error))
  }
}

type ApprovalEvent = Extract<RunEvent, { type: 'tool.approval_resolved' }>

/**
 * 一次审批的裁决记录。`name` / `risk` / `decidedBy` 由运行器补齐：审批事件本身
 * 只带 callId，工具名与风险在 `tool.call` 那一刻才知道。
 */
export function approvalAuditEntry(
  event: ApprovalEvent & { name?: string; risk?: string; decidedBy?: ApprovalDecidedBy },
): AppLogEntry {
  const detail: Record<string, unknown> = {
    sessionId: event.sessionId,
    runId: event.runId,
    callId: event.callId,
    approved: event.approved,
  }
  if (event.name) detail['tool'] = event.name
  if (event.risk) detail['risk'] = event.risk
  detail['decidedBy'] = event.decidedBy ?? 'user'
  if (event.reason) detail['reason'] = event.reason
  return {
    area: 'audit',
    event: 'approval.resolved',
    level: event.approved ? 'info' : 'warn',
    detail,
  }
}

/**
 * 高危工具调用的记录（`write` / `exec`）。只读调用不记：量大且没有审计价值，
 * 需要它们时去看会话的 `messages.jsonl`。
 *
 * 返回 null 表示这次调用不该进审计日志。
 */
export function toolAuditEntry(event: Extract<RunEvent, { type: 'tool.call' }>): AppLogEntry | null {
  if (event.risk !== 'write' && event.risk !== 'exec') return null
  return {
    area: 'audit',
    event: 'tool.call',
    level: 'info',
    detail: {
      sessionId: event.sessionId,
      runId: event.runId,
      callId: event.call.id,
      tool: event.call.name,
      risk: event.risk,
    },
  }
}

/**
 * 写/执行类工具失败的表现记录。
 *
 * 刻意**不写** `result.error`：工具的错误串里经常带着命令的 stderr、文件内容或
 * 路径，与 `app-log.ts` 「不记输出原文」的边界冲突。需要排查时用 `callId` 回
 * 会话文件里找完整结果，日志只回答「哪个工具的哪次调用挂了」。
 */
export function toolFailureEntry(
  event: Extract<RunEvent, { type: 'tool.result' }>,
  risk: 'read' | 'write' | 'exec' | 'control' | undefined,
): AppLogEntry | null {
  if (event.result.ok) return null
  if (risk !== 'write' && risk !== 'exec') return null
  return {
    area: 'audit',
    event: 'tool.failed',
    level: 'warn',
    detail: {
      sessionId: event.sessionId,
      runId: event.runId,
      callId: event.callId,
      tool: event.name,
      risk,
      // 只记错误长度：能区分「空错误」与「有上下文」，又不把内容写出。
      errorChars: event.result.error ? event.result.error.length : 0,
    },
  }
}

/**
 * 一轮运行的结算记录。`run` 来自 Store 的 `RunRecord`，因此同一条日志能直接和
 * 用量、失败计数、耗时对上，不再只有 `sessionId` + `status` 两个字段。
 */
export function runSettledEntry(input: {
  sessionId: string
  status: string
  run?: RunRecord | null
}): AppLogEntry {
  const { sessionId, status, run } = input
  const detail: Record<string, unknown> = { sessionId, status }
  if (run) {
    detail['runId'] = run.id
    detail['steps'] = run.steps
    detail['input'] = run.promptTokens
    detail['output'] = run.completionTokens
    if (typeof run.cacheHitTokens === 'number') detail['cacheHit'] = run.cacheHitTokens
    if (run.model) detail['model'] = run.model
    detail['toolErrors'] = run.toolErrors ?? 0
    detail['filesChanged'] = run.filesChanged ?? 0
    const started = Date.parse(run.startedAt)
    const finished = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
      detail['durationMs'] = finished - started
    }
  }
  if (run?.error) detail['error'] = run.error
  return {
    area: 'run',
    event: 'run.settled',
    level: status === 'failed' || status === 'interrupted' ? 'warn' : 'info',
    detail,
  }
}

/**
 * 崩溃类记录：主进程未捕获异常、未处理的 Promise、渲染进程消失、子进程消失。
 * `source` 是崩溃发生的位置（`main` / `renderer` / `child`），`event` 说明种类。
 */
export function crashEntry(input: {
  event: string
  source: 'main' | 'renderer' | 'child'
  error?: unknown
  detail?: Record<string, unknown>
}): AppLogEntry {
  const detail: Record<string, unknown> = { source: input.source, ...input.detail }
  if (input.error !== undefined) detail['summary'] = describeError(input.error)
  return { area: 'crash', event: input.event, level: 'error', detail }
}
