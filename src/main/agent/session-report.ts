/**
 * 一轮运行结束后的人读报告。
 *
 * 数据只来自两处已经在磁盘上的东西：`RunRecord`（耗时、token、步数、工具计数）
 * 和这一轮的消息（工具调用参数、失败结果）。这里不调模型、不读文件、不猜：
 * 拿不到的字段就写「未记录」，不用推断补。
 *
 * 纯函数，便于单测；渲染层与主进程共用同一份文本。
 */

import type { RunRecord, ToolCall } from '../../shared/types'
import type { SessionReport } from '../../shared/session-report'

export type { SessionReport }

export interface ReportMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
  isError?: boolean
  /** 内部续跑提示，不算用户开的新任务。 */
  control?: boolean
  /** 系统注入的提醒（反思、收尾、计划检查），不是用户说的话。 */
  internal?: boolean
}


const WRITE_TOOL_NAMES = new Set(['write_file', 'apply_patch', 'bulk-edit'])
const COMMAND_TOOL_NAMES = new Set(['run_command', 'run_shell', 'start_process'])
/** 看起来像「在验证」的命令。判定只影响报告措辞，不影响任何放行。 */
const VERIFY_COMMAND_PATTERN = /\b(test|vitest|jest|pytest|tsc|typecheck|lint|eslint|build|e2e|playwright)\b/i
const MAX_FILES = 40
const MAX_VERIFY_LINES = 8
const MAX_FAILURES = 8
const MAX_PATH_CHARS = 160
const ONE_LINE = 160

const STATUS_LABEL: Record<RunRecord['status'], string> = {
  running: '仍在运行',
  completed: '完成',
  paused: '已暂停',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被中断',
  max_steps: '达到步数上限',
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count)
}

function argString(toolCall: ToolCall, key: string): string {
  const raw = toolCall.arguments?.[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 命令行的可读形式：run_command 的 argv 拼起来，run_shell 直接用 command。 */
function commandOf(toolCall: ToolCall): string {
  const shell = argString(toolCall, 'command')
  const args = toolCall.arguments?.['args']
  if (Array.isArray(args) && args.length > 0) {
    return [shell, ...args.map((item) => String(item))].join(' ').trim()
  }
  return shell
}

function pathOf(toolCall: ToolCall): string {
  return (
    argString(toolCall, 'path') ||
    argString(toolCall, 'file_path') ||
    argString(toolCall, 'filePath')
  )
}

export function buildSessionReport(input: {
  run: RunRecord
  messages: ReportMessage[]
  /** 会话标题；没有就用任务首行。 */
  sessionTitle?: string
}): SessionReport {
  const { run, messages } = input
  const promptLine = clip(run.prompt || '（没有记录任务描述）', ONE_LINE)
  const title = clip(input.sessionTitle?.trim() || promptLine, 60)

  const changedFiles: string[] = []
  const verification: Array<{ command: string; ok: boolean }> = []
  const failures: string[] = []
  /** toolCallId → 是否失败，用来给验证命令配结论。 */
  const callFailed = new Map<string, boolean>()
  // 第一遍只收工具结果：assistant 的工具调用消息总在结果之前，
  // 边扫边查只会拿到 undefined 并把失败的命令误判成通过。
  for (const message of messages) {
    if (message.role !== 'tool') continue
    if (message.toolCallId) callFailed.set(message.toolCallId, message.isError === true)
    if (message.isError && failures.length < MAX_FAILURES) {
      failures.push(`${message.name ?? 'tool'}：${clip(message.content, ONE_LINE)}`)
    }
  }
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (const call of message.toolCalls) {
      if (WRITE_TOOL_NAMES.has(call.name)) {
        const path = pathOf(call)
        if (path && !changedFiles.includes(path) && changedFiles.length < MAX_FILES) {
          changedFiles.push(clip(path, MAX_PATH_CHARS))
        }
        continue
      }
      if (COMMAND_TOOL_NAMES.has(call.name)) {
        const command = commandOf(call)
        if (command && VERIFY_COMMAND_PATTERN.test(command) && verification.length < MAX_VERIFY_LINES) {
          verification.push({ command: clip(command, ONE_LINE), ok: callFailed.get(call.id) !== true })
        }
      }
    }
  }

  const startedAt = Date.parse(run.startedAt)
  const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN
  const wallMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? finishedAt - startedAt : 0
  // 运行没正常收尾时，就算验证命令碰巧通过也不算「已验证」：
  // 一次中断的 run 后面可能还有没跑完的改动。
  const runCompleted = run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'interrupted'
  const verified = verification.length > 0 && verification[verification.length - 1]!.ok && runCompleted
  const writtenButUnverified = changedFiles.length > 0 && !verified

  const lines: string[] = []
  lines.push(`# 会话报告 · ${title}`)
  lines.push('')
  if (run.prompt && promptLine !== title) lines.push(`> ${promptLine}`)
  if (run.prompt && promptLine !== title) lines.push('')

  lines.push('## 结论')
  lines.push(`- 状态：${STATUS_LABEL[run.status]}${run.error ? `（${clip(run.error, ONE_LINE)}）` : ''}`)
  if (run.finishedAt) {
    lines.push(`- 墙钟：${formatDuration(wallMs)}`)
  } else {
    lines.push('- 墙钟：未记录（这一轮还没有结束时间）')
  }
  const timings: string[] = []
  if (run.modelMs) timings.push(`模型 ${formatDuration(run.modelMs)}`)
  if (run.toolMs) timings.push(`工具 ${formatDuration(run.toolMs)}`)
  if (run.approvalMs) timings.push(`等审批 ${formatDuration(run.approvalMs)}`)
  if (run.checkpointMs) timings.push(`快照 ${formatDuration(run.checkpointMs)}`)
  if (timings.length > 0) lines.push(`- 耗时构成：${timings.join(' · ')}`)
  const counts = [`${run.steps} 步`, `${run.toolCalls} 次工具调用`]
  if (run.toolErrors > 0) counts.push(`${run.toolErrors} 次失败`)
  if (run.delegations) counts.push(`${run.delegations} 次委派`)
  lines.push(`- 规模：${counts.join(' · ')}`)
  if (run.totalTokens > 0) {
    const cache = run.cacheHitTokens && run.promptTokens
      ? `，缓存命中 ${Math.round((run.cacheHitTokens / run.promptTokens) * 100)}%`
      : ''
    lines.push(
      `- 用量：${formatTokens(run.totalTokens)} token（prompt ${formatTokens(run.promptTokens)} · 输出 ${formatTokens(run.completionTokens)}${cache}）`,
    )
  }
  lines.push('')

  lines.push('## 改了什么')
  if (changedFiles.length > 0) {
    for (const file of changedFiles) lines.push(`- \`${file}\``)
    if ((run.filesChanged ?? 0) > changedFiles.length) {
      lines.push(`- 另有 ${(run.filesChanged ?? 0) - changedFiles.length} 个文件被改写，消息里没有留下路径`)
    }
  } else if ((run.filesChanged ?? 0) > 0) {
    lines.push(`- 工具层记录改写 ${run.filesChanged} 个文件，但这一轮的消息里没有可读的路径`)
  } else {
    lines.push('- 这一轮没有写文件')
  }
  lines.push('')

  lines.push('## 验证')
  if (verification.length > 0) {
    for (const entry of verification) {
      lines.push(`- \`${entry.command}\` → ${entry.ok ? '通过' : '失败'}`)
    }
    if (!verified) {
      const lastOk = verification[verification.length - 1]!.ok
      lines.push(
        lastOk
          ? `- 验证命令都通过了，但这一轮以「${STATUS_LABEL[run.status]}」结束：改动还不能算成立`
          : '- 最后一次验证没有通过：改动还不能算成立',
      )
    }
  } else if (changedFiles.length > 0) {
    lines.push('- 改了文件，但没有跑任何验证类命令')
  } else {
    lines.push('- 没有跑验证命令')
  }
  lines.push('')

  if (failures.length > 0 || run.error) {
    lines.push('## 失败与卡点')
    for (const failure of failures) lines.push(`- ${failure}`)
    if (run.error) lines.push(`- 运行错误：${clip(run.error, 240)}`)
    lines.push('')
  }

  const next: string[] = []
  if (writtenButUnverified) next.push('先跑一次最窄的检查（单个测试文件或 typecheck），再宣布完成')
  if (run.status === 'max_steps') next.push('上一轮撞到步数上限：把剩下的工作拆小，或减少探索步数')
  if (run.status === 'failed' || run.status === 'interrupted') next.push('确认失败原因是否与工具或环境有关，再决定是重试还是换做法')
  if (run.toolErrors > failures.length && failures.length >= MAX_FAILURES) {
    next.push(`本轮共 ${run.toolErrors} 次工具失败，这里只列了前 ${MAX_FAILURES} 条`)
  }
  if (next.length > 0) {
    lines.push('## 下一步')
    for (const item of next) lines.push(`- ${item}`)
    lines.push('')
  }

  return { title, markdown: lines.join('\n').trimEnd(), changedFiles, verified, failures }
}
