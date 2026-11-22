// 工具执行侧的共享 helper：根目录别名解析、复盘根目录注入、drive 提示词、定时任务文案。
import type { AgentToolDefinition, ReviewRoot, ScheduledTask, ScheduledTaskInput } from '../../../shared/types'
import { join } from 'node:path'
import type { DriveHints } from '../drive'
import type { LearningSummary } from '../learning'
import type { ToolHost } from './spec'
import { REVIEW_READ_TOOLS } from './spec'

export function formatLearningSummary(summary: LearningSummary): string {
  const percent = (value: number): string => `${Math.round(value * 100)}%`
  const lines = [
    `来源 ${summary.sources} 条｜任务 ${summary.tasks} 个｜阶段成果 ${summary.outcomes} 次`,
    `裁决：通过 ${summary.approved}｜驳回 ${summary.rejected}｜待批 ${summary.pending}｜通过率 ${percent(summary.approvalRate)}`,
    `质量均值 ${summary.averageQuality.toFixed(2)}｜未收尾任务 ${summary.openTasks}`,
  ]
  if (summary.hosts.length > 0) {
    lines.push(
      `来源分布：${summary.hosts.map((entry) => `${entry.host}(${entry.sources})`).join('、')}`,
    )
  }
  if (summary.focus.length > 0) {
    lines.push('', '焦点建议：', ...summary.focus.map((item) => `- ${item}`))
  }
  return lines.join('\n')
}

export function rootKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export async function rootFor(host: ToolHost, args: Record<string, unknown>): Promise<string> {
  const roots = [...(host.roots ?? []), ...(host.referenceRoots ?? [])]
  if (roots.length === 0) return host.root
  const alias = typeof args['root'] === 'string' ? args['root'].trim() : ''
  if (!alias) return host.root
  const match = roots.find(
    (entry) => entry.name === alias || rootKey(entry.path) === rootKey(alias),
  )
  if (!match) {
    throw new Error(
      `Unknown root "${alias}". Allowed roots: ${roots.map((entry) => entry.name).join(', ')}`,
    )
  }
  return match.path
}

export function withReferenceRoots(
  tools: AgentToolDefinition[],
  roots: ReviewRoot[],
): AgentToolDefinition[] {
  if (roots.length === 0) return tools
  const names = roots.map((root) => root.name)
  return tools.map((tool) => {
    if (!REVIEW_READ_TOOLS.has(tool.name)) return tool
    const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, unknown>
    return {
      ...tool,
      description: `${tool.description} The user also referenced other workspaces: pass root to read one of them (${names.join(', ')}); omit root for the current workspace.`,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...properties,
          root: {
            type: 'string',
            enum: names,
            description: 'Referenced workspace alias. Omit to use the current workspace.',
          },
        },
      },
    }
  })
}

export function driveHints(root: string, args: Record<string, unknown>): DriveHints {
  const text = (key: string): string | undefined => {
    const value = args[key]
    if (typeof value !== 'string' || !value.trim()) return undefined
    return value.trim()
  }
  return {
    root,
    ...(text('url') ? { url: text('url') } : {}),
    ...(typeof args['port'] === 'number' ? { port: args['port'] } : {}),
    ...(text('processName') ? { processName: text('processName') } : {}),
    ...(text('windowTitle') ? { windowTitle: text('windowTitle') } : {}),
    ...(text('command') ? { command: text('command') } : {}),
    ...(text('targetId') ? { targetId: text('targetId') } : {}),
    ...(text('targetTitle') ? { targetTitle: text('targetTitle') } : {}),
    ...(text('targetUrl') ? { targetUrl: text('targetUrl') } : {}),
    ...(typeof args['kind'] === 'string' && args['kind'] !== 'unknown'
      ? { kind: args['kind'] as NonNullable<DriveHints['kind']> }
      : {}),
  }
}

export function scheduleWhen(task: ScheduledTask): string {
  if (task.kind === 'interval') return `每 ${task.intervalMinutes ?? 0} 分钟`
  if (task.kind === 'daily') return `每天 ${task.timeOfDay ?? ''}`
  return '一次性'
}

export function formatScheduleTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatScheduleLine(task: ScheduledTask): string {
  const parts = [scheduleWhen(task), `下次 ${formatScheduleTime(task.nextRunAt)}`]
  parts.push(task.enabled ? '启用' : '已暂停')
  if (task.lastStatus === 'failed') {
    parts.push(task.lastError ? `上次失败：${task.lastError}` : '上次失败')
  } else if (task.lastStatus === 'queued') {
    parts.push('上次已触发')
  }
  return `${parts.join(' · ')} · id ${task.id.slice(0, 8)}\n  ${task.content}`
}

export function formatScheduleList(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return '本会话没有定时任务。'
  return tasks.map((task, index) => `${index + 1}. ${formatScheduleLine(task)}`).join('\n')
}

export function scheduleKindArg(value: unknown): ScheduledTaskInput['kind'] {
  return value === 'interval' || value === 'daily' ? value : 'once'
}

export function minutesArg(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.round(value)
}
