/**
 * 内视：Pilot 检查自己有哪些功能模块、现在能不能用。
 *
 * 与「模块自检」的分工：
 * - 模块自检扫的是当前工作区的代码风险，要用户先指定一个工作区；
 * - 内视不接收任何路径，读的是运行中的服务实例：模型接入、审批规则、沙箱、
 *   自写工具、MCP、插件、数据存储、定时任务、反馈、更新器和体检服务。
 *
 * 每项只写四类状态之一（正常 / 注意 / 未启用 / 异常），并附上真实取值作为
 * 证据。采不到就报异常并给出原因，不用默认值把「没读到」包装成「正常」。
 */

export type SelfCheckStatus = 'ok' | 'warn' | 'off' | 'broken'

/** 分组只用于排序和分段展示，不参与判定。 */
export type SelfCheckGroup = 'runtime' | 'model' | 'exec' | 'ext' | 'data'

export interface SelfCheckItem {
  /** 稳定 id，测试和复制出的文本都靠它定位。 */
  id: string
  group: SelfCheckGroup
  /** 中文标题；英文界面由渲染层的字典翻译，缺词条时回落中文。 */
  title: string
  status: SelfCheckStatus
  /** 一句话结论。 */
  detail: string
  /** 证据行：真实取值，不是描述。 */
  facts: string[]
  /** 状态不理想时的下一步。 */
  hint?: string
  durationMs: number
}

export interface SelfCheckCounts {
  ok: number
  warn: number
  off: number
  broken: number
}

export interface SelfCheckReport {
  at: number
  version: string
  durationMs: number
  counts: SelfCheckCounts
  items: SelfCheckItem[]
}

export const SELF_CHECK_GROUPS: readonly SelfCheckGroup[] = [
  'runtime',
  'model',
  'exec',
  'ext',
  'data',
]

/** 同分组内先看异常，再看注意、未启用，最后是正常。 */
const STATUS_WEIGHT: Record<SelfCheckStatus, number> = {
  broken: 0,
  warn: 1,
  off: 2,
  ok: 3,
}

export function countSelfCheck(items: readonly SelfCheckItem[]): SelfCheckCounts {
  const counts: SelfCheckCounts = { ok: 0, warn: 0, off: 0, broken: 0 }
  for (const item of items) counts[item.status] += 1
  return counts
}

/** 整份报告的代表状态：有一个异常就是异常，其次注意，其次正常。 */
export function worstSelfCheckStatus(counts: SelfCheckCounts): SelfCheckStatus {
  if (counts.broken > 0) return 'broken'
  if (counts.warn > 0) return 'warn'
  if (counts.ok > 0) return 'ok'
  return 'off'
}

export function selfCheckStatusText(status: SelfCheckStatus): string {
  switch (status) {
    case 'ok':
      return '正常'
    case 'warn':
      return '注意'
    case 'off':
      return '未启用'
    case 'broken':
      return '异常'
  }
}

export function selfCheckGroupText(group: SelfCheckGroup): string {
  switch (group) {
    case 'runtime':
      return '运行时'
    case 'model':
      return '模型与策略'
    case 'exec':
      return '执行'
    case 'ext':
      return '扩展'
    case 'data':
      return '数据与同步'
  }
}

export function sortSelfCheckItems(items: readonly SelfCheckItem[]): SelfCheckItem[] {
  const order = new Map(SELF_CHECK_GROUPS.map((group, index) => [group, index]))
  return [...items].sort((left, right) => {
    const byGroup = (order.get(left.group) ?? 99) - (order.get(right.group) ?? 99)
    if (byGroup !== 0) return byGroup
    const byStatus = STATUS_WEIGHT[left.status] - STATUS_WEIGHT[right.status]
    if (byStatus !== 0) return byStatus
    return left.id.localeCompare(right.id)
  })
}

/** 本地时间戳，复制出来的报告要能被人工读懂，不用 ISO。 */
export function formatSelfCheckStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 纯文本报告：用于「复制全文」，也可以直接贴进会话让模型分析。
 * 只用中文，避免英文界面下把状态词翻一半。
 */
export function renderSelfCheckText(report: SelfCheckReport): string {
  const items = sortSelfCheckItems(report.items)
  const counts = report.counts
  const lines = [
    `Pilot 内视 · ${formatSelfCheckStamp(report.at)} · v${report.version} · 用时 ${report.durationMs} ms`,
    `正常 ${counts.ok} · 注意 ${counts.warn} · 未启用 ${counts.off} · 异常 ${counts.broken}`,
  ]
  for (const group of SELF_CHECK_GROUPS) {
    const groupItems = items.filter((item) => item.group === group)
    if (groupItems.length === 0) continue
    lines.push('', `[${selfCheckGroupText(group)}]`)
    for (const item of groupItems) {
      lines.push(`- [${selfCheckStatusText(item.status)}] ${item.title}：${item.detail}`)
      for (const fact of item.facts) lines.push(`    · ${fact}`)
      if (item.hint) lines.push(`    建议：${item.hint}`)
    }
  }
  return lines.join('\n')
}

/** IPC 进来的报告不可信：字段类型不对就整份丢弃，避免渲染层拿到半份数据。 */
export function sanitizeSelfCheckReport(value: unknown): SelfCheckReport | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.at !== 'number' || typeof raw.version !== 'string') return null
  if (!Array.isArray(raw.items)) return null
  const items: SelfCheckItem[] = []
  for (const entry of raw.items) {
    if (!entry || typeof entry !== 'object') return null
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.title !== 'string') return null
    if (typeof item.detail !== 'string' || !Array.isArray(item.facts)) return null
    const status = item.status
    if (status !== 'ok' && status !== 'warn' && status !== 'off' && status !== 'broken') return null
    const group = item.group
    if (group !== 'runtime' && group !== 'model' && group !== 'exec' && group !== 'ext' && group !== 'data') {
      return null
    }
    items.push({
      id: item.id,
      group,
      title: item.title,
      status,
      detail: item.detail,
      facts: item.facts.filter((fact): fact is string => typeof fact === 'string'),
      ...(typeof item.hint === 'string' ? { hint: item.hint } : {}),
      durationMs: typeof item.durationMs === 'number' ? item.durationMs : 0,
    })
  }
  return {
    at: raw.at,
    version: raw.version,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    counts: countSelfCheck(items),
    items,
  }
}
