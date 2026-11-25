// 主机能力与入口校验：能力清单、更新与进化门禁、待办与定时参数、上传限额、工作区越界检查，以及手机侧自检与学习投影。
// 由 server.ts 的同名方法机械搬出：方法体逐字保留，this 换成 host 参数。
import type { ModuleCheckReport, ModuleCheckState, ScheduledTaskInput } from '../../../shared/types'
import { DESKTOP_CAPABILITIES, type HostCapabilities } from '../../../shared/capabilities'
import { sortRisks, type ModuleCheckSummary } from '../../../shared/module-check'
import {
  DEFAULT_LEARNING_HOSTS,
  readLearningLedger,
  resolveLearningPolicy,
  summarizeLearning,
} from '../../agent/learning'
import { abortWorkspaceUpload } from '../../workspace'
import { PHONE_LEARNING_ENTRY_LIMIT, PHONE_MODULE_RISK_LIMIT, UPLOAD_TTL_MS } from '../constants'
import { phoneLearningEntry } from '../helpers'
import type {
  CompanionOptions,
  PendingUpload,
  PhoneLearningState,
  PhoneModuleCheckReport,
  PhoneModuleCheckState,
} from '../types'
import type { CompanionServer } from '../server'

export function capabilities(
  host: CompanionServer,
): HostCapabilities {
  return host.options.capabilities ?? DESKTOP_CAPABILITIES
}

export function requireUpdate(
  host: CompanionServer,
): NonNullable<CompanionOptions['update']> {
  const update = host.options.update
  if (!update) {
    throw new Error('当前电脑端版本不支持手机控制更新，请先在电脑上更新 Pilot。')
  }
  return update
}

export function requireEvolution(
  host: CompanionServer,
): NonNullable<CompanionOptions['evolution']> {
  const evolution = host.options.evolution
  if (!evolution) {
    throw new Error(
      host.capabilities().evolution
        ? '当前电脑端版本不支持手机控制自进化，请先在电脑上更新 Pilot。'
        : '服务器模式不支持手机控制自进化与个人版本，请在电脑端操作。',
    )
  }
  return evolution
}

export function requireReflect(
  host: CompanionServer,
): NonNullable<CompanionOptions['reflect']> {
  const reflect = host.options.reflect
  if (!reflect) {
    throw new Error('当前电脑端版本不支持手机设置反思，请先在电脑上更新 Pilot。')
  }
  return reflect
}

export function scheduleInput(
  host: CompanionServer,
  params: Record<string, unknown>,
  requireContent: boolean,
): Partial<ScheduledTaskInput> & { enabled?: boolean } {
  const input: Partial<ScheduledTaskInput> & { enabled?: boolean } = {}
  if (typeof params['content'] === 'string' && params['content'].trim()) {
    input.content = params['content'].slice(0, 4_000)
  } else if (requireContent) {
    throw new Error('定时任务内容不能为空')
  }
  if (
    params['kind'] === 'once' ||
    params['kind'] === 'interval' ||
    params['kind'] === 'daily'
  ) {
    input.kind = params['kind']
  } else if (requireContent) {
    throw new Error('请选择执行方式')
  }
  const delayMinutes = params['delayMinutes']
  if (typeof delayMinutes === 'number' && Number.isFinite(delayMinutes)) {
    input.delayMinutes = delayMinutes
  }
  const intervalMinutes = params['intervalMinutes']
  if (typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)) {
    input.intervalMinutes = intervalMinutes
  }
  if (typeof params['timeOfDay'] === 'string') {
    input.timeOfDay = params['timeOfDay'].slice(0, 5)
  }
  // 手机端传本地 "YYYY-MM-DD"；空串表示「不再限定起始日」，由 store 按今天重新算。
  // 形状校验留给 store（cleanStartDate 报「起始日期要像 2026-11-25」），这里只管透传。
  if (typeof params['startDate'] === 'string') {
    input.startDate = params['startDate'].trim().slice(0, 10)
  }
  if (typeof params['enabled'] === 'boolean') input.enabled = params['enabled']
  return input
}

export function pruneUploads(
  host: CompanionServer,
): void {
  const now = Date.now()
  for (const upload of host.pendingUploads.values()) {
    if (now - upload.createdAt <= UPLOAD_TTL_MS) continue
    host.pendingUploads.delete(upload.uploadId)
    void abortWorkspaceUpload(upload.tempPath).catch(() => undefined)
  }
}

export function assertUploadFresh(
  host: CompanionServer,
  upload: PendingUpload,
): void {
  if (Date.now() - upload.createdAt <= UPLOAD_TTL_MS) return
  host.pendingUploads.delete(upload.uploadId)
  void abortWorkspaceUpload(upload.tempPath).catch(() => undefined)
  throw new Error('上传已过期，请重新选择文件')
}

export function assertWorkspace(
  host: CompanionServer,
  path: string,
): void {
  if (!host.options.store.workspaces().some((workspace) => workspace.path === path)) {
    throw new Error('工作区未打开')
  }
}

export function phoneModuleCheckReport(
  host: CompanionServer,
  report: ModuleCheckReport,
): PhoneModuleCheckReport {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const risk of report.risks) {
    if (risk.severity === 'high') counts.high += 1
    else if (risk.severity === 'medium') counts.medium += 1
    else counts.low += 1
  }
  // Trimming the tail of a module-ordered list could drop every high risk
  // found in later modules. Apply the same canonical ordering the desktop
  // report uses so a capped phone payload still shows the items that matter
  // most; the desktop keeps the full report either way.
  const ranked = sortRisks(report.risks)
  return {
    ...report,
    risks: ranked.slice(0, PHONE_MODULE_RISK_LIMIT),
    riskTotal: report.risks.length,
    riskCounts: counts,
  }
}

export function phoneModuleCheckState(
  host: CompanionServer,
  state: ModuleCheckSummary | ModuleCheckState,
): PhoneModuleCheckState {
  const historyCount = 'historyCount' in state ? state.historyCount : state.history.length
  return {
    settings: state.settings,
    ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
    ...(state.nextRunAt ? { nextRunAt: state.nextRunAt } : {}),
    ...(state.lastReport ? { lastReport: host.phoneModuleCheckReport(state.lastReport) } : {}),
    historyCount,
    decisions: state.decisions.slice(0, 5),
    proposals: state.proposals.slice(0, 3).map((proposal) => {
      // 手机上只看构造思路，预览截断到 1500 字，避免状态帧过大。
      const limit = 1_500
      const promptTruncated = proposal.prompt.length > limit
      return {
        id: proposal.id,
        reportId: proposal.reportId,
        createdAt: proposal.createdAt,
        riskIds: proposal.riskIds.slice(0, 200),
        prompt: promptTruncated ? `${proposal.prompt.slice(0, limit)}…` : proposal.prompt,
        promptTruncated,
        selfModify: proposal.selfModify === true,
        ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}),
        ...(proposal.refreshedAt ? { refreshedAt: proposal.refreshedAt } : {}),
      }
    }),
  }
}

export async function phoneLearningState(
  host: CompanionServer,
  workspacePath: string,
): Promise<PhoneLearningState> {
  const settings = host.options.store.settingsView()
  const policy = resolveLearningPolicy(settings)
  const entries = await readLearningLedger(workspacePath)
  return {
    enabled: settings.learningMode === true,
    hosts: [...settings.learningHosts],
    effectiveHosts: [...policy.hosts],
    defaultHosts: [...DEFAULT_LEARNING_HOSTS],
    ledger: '.pilot/learning/ledger.jsonl',
    entryTotal: entries.length,
    summary: summarizeLearning(entries),
    // 最新记录在前，手机端不需要滚动到最底部才能看到刚发生的事。
    entries: entries.slice(-PHONE_LEARNING_ENTRY_LIMIT).reverse().map(phoneLearningEntry),
  }
}
