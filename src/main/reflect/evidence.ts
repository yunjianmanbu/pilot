import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import type { Store } from '../store'
import type { RunRecord } from '../../shared/types'
import { type ReflectionEvidenceKind, type ReflectionFindingStatus } from '../../shared/reflect'
import { scrub } from '../agent/evolution/evidence'
import {
  SPLIT_DECISIONS,
  SPLIT_SCAN_AT,
  SPLIT_VERDICTS,
  normalizeSplitPath,
  splitConstraints,
  splitDecisionIndex,
  splitDecisionKindLabel,
  splitScanCounts,
  type SplitDecision,
  type SplitVerdictCode,
} from '../../shared/split-decisions'
import type { ModuleCheckState } from '../../shared/module-check'

/**
 * 反思的证据采集。
 *
 * 反思最怕变成“空谈”：模型没有真实数字就只能写套话。这里把已经在本地落库的
 * 事实（每个工作区的会话数、运行数、失败分布、步数/token 均值、工具错误、
 * 压缩次数）整理成一小段文本，既控制了 prompt 体积，又让每条结论都有出处。
 *
 * 代码相关的事实只从自检报告里取，不在反思里重新扫一遍：扫描代价高，而且结论
 * 必须和用户在界面上看到的自检报告同源，否则反思会说“应该拆某个文件”，而那个
 * 文件其实早就决策过不拆了。
 */

/** 喂给反思的代码事实：全部来自最近一份自检报告 + 已记录的拆分决策。 */
export interface ReflectionCodeFacts {
  reportId?: string
  finishedAt?: string
  score?: number
  scannedFiles?: number
  scannedLines?: number
  /** 自检时的工作区绝对路径：用它把报告里的相对路径换算成真实文件。 */
  workspaceRoot?: string
  /** 报告完成距今的天数（向下取整）。数字很大就说明“代码事实”已经过期。 */
  ageDays?: number
  /**
   * 超过行数阈值、但还没有拆分决策的文件。`verdict` 是已量到的判据码（缺了就是没量过）。
   * `currentLines`/`missing` 是采集时重新读盘的结果：用户可能已经拆过或删了。
   */
  oversized: {
    path: string
    lines: number
    verdict?: SplitVerdictCode
    currentLines?: number
    missing?: boolean
  }[]
  /** 本次扫描命中的已记录决策（拆分 / 不拆 / 暂缓）。 */
  decisions: SplitDecision[]
  /** 决策里的文件在磁盘上已经找不到了（改名或删除）：决策本身需要复核。 */
  missingDecisions: string[]
  /** 规则产出的风险点，带可复核的依据。 */
  risks: { rule: string; severity: string; moduleName: string; title: string; basis?: string }[]
}

/** 读一个文本文件的行数；读不到（不存在、太大、不是文件）返回 null。 */
function readLineCount(path: string): number | null {
  try {
    const stat = statSync(path)
    // 超过 4MB 的源文件不太可能是人写的业务代码，也不值得为一次反思读进内存。
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null
    const text = readFileSync(path, 'utf8')
    if (!text) return 0
    let lines = 0
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) lines += 1
    }
    // 末尾换行不算多一行。
    return text.endsWith('\n') ? lines : lines + 1
  } catch {
    return null
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * 把最近一份自检报告整理成反思可用的代码事实。
 *
 * 决策列表总是全量带出：即使这次扫描没有命中某个已决策文件，反思也不该重新提出
 * 已被否决的拆分。行数事实只列「还没有决策」的文件，并且渲染时明确标注它不是结论。
 *
 * 报告是快照，用户在这之后很可能已经改过代码。所以采集时把每个待决策大文件的行数
 * 重新读一遍（最多 20 个文件），并把报告龄期一起带出去：反思才能分清“该拆”和
 * “报告写完之后已经拆完了”。
 */
export function codeFactsFromModuleCheck(
  state: Pick<ModuleCheckState, 'lastReport'> | null | undefined,
  now = new Date(),
): ReflectionCodeFacts | null {
  if (!state) return null
  const report = state.lastReport
  // 报告里的决策只在扫描命中时才有；没有就先退回仓库记录的决策表。
  const decisions =
    report?.decisions && report.decisions.length > 0 ? report.decisions : [...SPLIT_DECISIONS]
  // `decided` 是后加的字段：旧报告里缺它就会读成 false，已决策的文件又会被当成
  // 待决策重新提一遍。用决策表兜底，行数事实与决策永远互斥。
  const decisionIndex = splitDecisionIndex(decisions)
  const workspaceRoot = report?.workspace
  const oversized = (report?.largeFiles ?? [])
    .filter((file) => !file.decided && !decisionIndex.has(normalizeSplitPath(file.path)))
    .slice(0, 20)
    .map((file) => {
      const fact: ReflectionCodeFacts['oversized'][number] = { path: file.path, lines: file.lines }
      if (file.verdict) fact.verdict = file.verdict
      if (workspaceRoot) {
        const current = readLineCount(join(workspaceRoot, file.path))
        if (current === null) fact.missing = true
        else fact.currentLines = current
      }
      return fact
    })
  const missingDecisions = workspaceRoot
    ? decisions
        .map((decision) => normalizeSplitPath(decision.path))
        .filter((path) => !fileExists(join(workspaceRoot, path)))
        .slice(0, 10)
    : []
  const facts: ReflectionCodeFacts = {
    oversized,
    decisions,
    missingDecisions,
    risks: (report?.risks ?? []).map((risk) => ({
      rule: risk.rule,
      severity: risk.severity,
      moduleName: risk.moduleName,
      title: risk.title,
      ...(risk.basis ? { basis: risk.basis } : {}),
    })),
  }
  if (report) {
    facts.reportId = report.id
    facts.finishedAt = report.finishedAt
    facts.score = report.score
    facts.scannedFiles = report.scannedFiles
    facts.scannedLines = report.scannedLines
    if (workspaceRoot) facts.workspaceRoot = workspaceRoot
    const finished = Date.parse(report.finishedAt)
    if (Number.isFinite(finished)) {
      facts.ageDays = Math.max(0, Math.floor((now.getTime() - finished) / 86_400_000))
    }
  }
  return facts
}

export interface WorkspaceEvidence {
  name: string
  path: string
  sessions: number
  runs: number
  failures: number
  failureRate: number
  toolErrors: number
  avgSteps: number
  avgTokens: number
  /** 发生过上下文压缩的运行数（summarizeMs > 0 即认为压缩过）。 */
  compactedRuns: number
  summarizeMs: number
  /** 最近几条失败运行的错误摘要（已脱敏）。 */
  recentFailures: string[]
}

/** 阶段耗时：回答「时间花在哪里」，而不是只能看到步数和 token。 */
export interface ReflectionTiming {
  runs: number
  avgModelMs: number
  avgToolMs: number
  avgCheckpointMs: number
  avgSummarizeMs: number
  /** 有审批等待记录的运行数与它的均值。 */
  runsWithApproval: number
  avgApprovalMs: number
  modelShare: number
  toolShare: number
  approvalShare: number
}

/** 用户评分与校验结果：输出质量域唯一可信的证据来源。 */
export interface ReflectionOutcomes {
  rated: number
  positive: number
  negative: number
  /** checked=true 的运行数，至少证明「改完验过」。 */
  checked: number
  /** 差评备注（已脱敏、已截断），是唯一带人工语义的原文。 */
  negativeNotes: string[]
}

/** 一段时间窗口的统计，用来回答「在不在漂移」。 */
export interface ReflectionWindow {
  label: string
  runs: number
  failures: number
  failureRate: number
  avgSteps: number
  avgTokens: number
}

/** 本地存储体积：存储性能域的事实来源。 */
export interface ReflectionStorageFacts {
  stateBytes: number
  checkpointsBytes: number
  checkpointFiles: number
  sessionShardFiles: number
  sessionShardBytes: number
}

/** 上一份报告里已经提过的结论，避免同一个现象每次换种说法再报一遍。 */
export interface ReflectionHistoryEntry {
  reportId: string
  createdAt: string
  topic: string
  severity: string
  observation: string
  /** 用户给这条结论标的状态：done 说明已经修过，dismissed 说明不打算做。 */
  status: ReflectionFindingStatus
  /** 结论指向的代码位置：已修的条目靠它告诉模型「这个文件已经改过了」。 */
  refs: string[]
}

export interface ReflectionEvidence {
  generatedAt: string
  workspaces: WorkspaceEvidence[]
  /** 代码事实；宿主没有提供（例如纯服务器环境）时不存在。 */
  code?: ReflectionCodeFacts
  timing?: ReflectionTiming
  outcomes?: ReflectionOutcomes
  /** 最近 N 天与更早的对比，用来回答“在不在漂移”。 */
  recent?: ReflectionWindow
  baseline?: ReflectionWindow
  storage?: ReflectionStorageFacts
  history?: ReflectionHistoryEntry[]
  totals: {
    workspaces: number
    sessions: number
    runs: number
    failures: number
    failureRate: number
    toolErrors: number
    avgSteps: number
    avgTokens: number
    compactedRuns: number
    /** 加权平均的底数，避免“平均值再平均”。 */
    totalSteps: number
    totalTokens: number
  }
}

/** 最近多少天算“近期”。和固定的 7 天对齐，不用配置项。 */
export const REFLECTION_RECENT_DAYS = 7

/**
 * 这份证据能支撑哪些问题域。
 *
 * 以前是把判断交给模型，结果是它在没证据的域也照写；现在由这里判定，
 * 跳过的域会在提示词和报告里各留一行原因。
 */
export function evidenceAvailability(evidence: ReflectionEvidence): ReflectionEvidenceKind[] {
  const kinds: ReflectionEvidenceKind[] = []
  const t = evidence.totals
  if (t.runs > 0) kinds.push('runs')
  if (evidence.timing) kinds.push('timing')
  if (evidence.outcomes && (evidence.outcomes.rated > 0 || evidence.outcomes.checked > 0)) {
    kinds.push('outcomes')
  }
  if (t.compactedRuns > 0) kinds.push('compaction')
  if (evidence.storage && evidence.storage.stateBytes > 0) kinds.push('storage')
  if (evidence.code) {
    kinds.push('code')
    // 界面事实只从代码事实里抽：renderer 的过大文件或界面相关风险。
    const uiHit =
      evidence.code.oversized.some((file) => /renderer|components/.test(file.path)) ||
      evidence.code.risks.some((risk) => /renderer|ui|界面|layout/i.test(`${risk.moduleName} ${risk.title}`))
    if (uiHit) kinds.push('ui')
  }
  return kinds
}

const MAX_RECENT_FAILURES = 4
const MAX_RUNS_SCANNED = 200
/** 存储统计最多走多少个目录项：checkpoints 实测 2.9GB，无上限遍历会把反思拖成分钟级。 */
const MAX_STORAGE_ENTRIES = 20_000

export function average(values: number[]): number {
  if (values.length === 0) return 0
  const total = values.reduce((sum, value) => sum + value, 0)
  return Math.round(total / values.length)
}

function failureLine(prompt: string, error: string | undefined, status: string): string {
  const head = scrub(prompt, 90) || '(no prompt)'
  const tail = error ? scrub(error, 120) : status
  return `${head} → ${tail}`
}

function isFailure(run: RunRecord): boolean {
  return run.status === 'failed' || run.status === 'interrupted' || run.status === 'max_steps'
}

/** 统计一个目录的体积与文件数，带条目上限。 */
function measureDir(dir: string, budget = MAX_STORAGE_ENTRIES): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  let seen = 0
  const walk = (current: string): void => {
    if (seen >= budget) return
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++seen >= budget) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        files += 1
        try {
          bytes += statSync(full).size
        } catch {
          // 读不到就不算：体积是参考值，不能因为一个文件失败就让反思失败。
        }
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

function measureStorage(store: Store): ReflectionStorageFacts | undefined {
  let root: string
  try {
    root = store.dataDir()
  } catch {
    return undefined
  }
  const statePath = join(root, 'pilot-core.json')
  let stateBytes = 0
  try {
    stateBytes = statSync(statePath).size
  } catch {
    stateBytes = 0
  }
  const sessions = measureDir(join(root, 'sessions'))
  const checkpoints = measureDir(join(root, 'checkpoints'))
  if (stateBytes === 0 && sessions.files === 0 && checkpoints.files === 0) return undefined
  return {
    stateBytes,
    checkpointsBytes: checkpoints.bytes,
    checkpointFiles: checkpoints.files,
    sessionShardFiles: sessions.files,
    sessionShardBytes: sessions.bytes,
  }
}

/** 把一个运行集合聚合成一段窗口统计。 */
function windowOf(label: string, runs: RunRecord[]): ReflectionWindow {
  const failures = runs.filter(isFailure).length
  return {
    label,
    runs: runs.length,
    failures,
    failureRate: runs.length === 0 ? 0 : failures / runs.length,
    avgSteps: average(runs.map((run) => run.steps)),
    avgTokens: average(runs.map((run) => run.totalTokens)),
  }
}

function collectTiming(runs: RunRecord[]): ReflectionTiming | undefined {
  if (runs.length === 0) return undefined
  const modelMs = runs.reduce((sum, run) => sum + (run.modelMs ?? 0), 0)
  const toolMs = runs.reduce((sum, run) => sum + (run.toolMs ?? 0), 0)
  const checkpointMs = runs.reduce((sum, run) => sum + (run.checkpointMs ?? 0), 0)
  const summarizeMs = runs.reduce((sum, run) => sum + (run.summarizeMs ?? 0), 0)
  const approvalRuns = runs.filter((run) => (run.approvalMs ?? 0) > 0)
  const approvalMs = runs.reduce((sum, run) => sum + (run.approvalMs ?? 0), 0)
  if (modelMs === 0 && toolMs === 0 && checkpointMs === 0 && summarizeMs === 0 && approvalMs === 0) {
    // 老版本运行记录没有分阶段耗时：宁可不给，也不要让模型把 0 当成“不花时间”。
    return undefined
  }
  const total = modelMs + toolMs + checkpointMs + summarizeMs + approvalMs
  const share = (value: number): number => (total === 0 ? 0 : Math.round((value / total) * 100))
  return {
    runs: runs.length,
    avgModelMs: average(runs.map((run) => run.modelMs ?? 0)),
    avgToolMs: average(runs.map((run) => run.toolMs ?? 0)),
    avgCheckpointMs: average(runs.map((run) => run.checkpointMs ?? 0)),
    avgSummarizeMs: average(runs.map((run) => run.summarizeMs ?? 0)),
    runsWithApproval: approvalRuns.length,
    avgApprovalMs: approvalRuns.length === 0 ? 0 : Math.round(approvalMs / approvalRuns.length),
    modelShare: share(modelMs),
    toolShare: share(toolMs),
    approvalShare: share(approvalMs),
  }
}

function collectOutcomes(runs: RunRecord[]): ReflectionOutcomes | undefined {
  const rated = runs.filter((run) => run.feedback)
  const checked = runs.filter((run) => run.checked).length
  if (rated.length === 0 && checked === 0) return undefined
  return {
    rated: rated.length,
    positive: rated.filter((run) => run.feedback?.rating === 'up').length,
    negative: rated.filter((run) => run.feedback?.rating === 'down').length,
    checked,
    negativeNotes: rated
      .filter((run) => run.feedback?.rating === 'down' && run.feedback.note)
      .slice(0, 5)
      .map((run) => scrub(run.feedback?.note ?? '', 160)),
  }
}

/** 上一份报告的发现：让模型知道哪些结论已经提过，避免换种说法再提一遍。 */
function collectHistory(store: Store): ReflectionHistoryEntry[] {
  const reports = store.reflectionReports().slice(0, 3)
  const entries: ReflectionHistoryEntry[] = []
  for (const report of reports) {
    for (const finding of report.findings.slice(0, 6)) {
      const status = finding.status ?? 'open'
      // 用户标了「不打算做」的结论再提一遍只会消耗信任；done 仍然带出去，
      // 但会明确写「已处理」——否则代码改了、模型还在照旧报同一条。
      if (status === 'dismissed') continue
      entries.push({
        reportId: report.id,
        createdAt: report.createdAt,
        topic: finding.topic,
        severity: finding.severity,
        observation: scrub(finding.observation, 160),
        status,
        refs: (finding.refs ?? []).map((ref) => (ref.line ? `${ref.path}:${ref.line}` : ref.path)),
      })
    }
  }
  return entries.slice(0, 18)
}

function collectStorage(store: Store): ReflectionStorageFacts | undefined {
  try {
    return measureStorage(store)
  } catch {
    return undefined
  }
}

export function collectEvidence(
  store: Store,
  now = new Date(),
  code?: ReflectionCodeFacts | null,
): ReflectionEvidence {
  const workspaces: WorkspaceEvidence[] = []
  /** 所有运行拍平成一个池：总量与均值必须按 run 加权，工作区等权会把“平均值再平均”。 */
  const allRuns: RunRecord[] = []
  for (const workspace of store.workspaces()) {
    const sessions = store.sessions(workspace.path)
    const runs = store.runs(workspace.path).slice(0, MAX_RUNS_SCANNED)
    allRuns.push(...runs)
    const failures = runs.filter(isFailure)
    const toolErrors = runs.reduce((sum, run) => sum + (run.toolErrors ?? 0), 0)
    const compactedRuns = runs.filter((run) => (run.summarizeMs ?? 0) > 0).length
    workspaces.push({
      name: workspace.name,
      path: workspace.path,
      sessions: sessions.length,
      runs: runs.length,
      failures: failures.length,
      failureRate: runs.length === 0 ? 0 : failures.length / runs.length,
      toolErrors,
      avgSteps: average(runs.map((run) => run.steps)),
      avgTokens: average(runs.map((run) => run.totalTokens)),
      compactedRuns,
      summarizeMs: runs.reduce((sum, run) => sum + (run.summarizeMs ?? 0), 0),
      recentFailures: failures
        .slice(0, MAX_RECENT_FAILURES)
        .map((run) => failureLine(run.prompt, run.error, run.status)),
    })
  }
  const totalSteps = allRuns.reduce((sum, run) => sum + run.steps, 0)
  const totalTokens = allRuns.reduce((sum, run) => sum + run.totalTokens, 0)
  const failures = allRuns.filter(isFailure).length
  const evidence: ReflectionEvidence = {
    generatedAt: now.toISOString(),
    workspaces,
    history: collectHistory(store),
    totals: {
      workspaces: workspaces.length,
      sessions: workspaces.reduce((sum, workspace) => sum + workspace.sessions, 0),
      runs: allRuns.length,
      failures,
      failureRate: allRuns.length === 0 ? 0 : failures / allRuns.length,
      toolErrors: workspaces.reduce((sum, workspace) => sum + workspace.toolErrors, 0),
      avgSteps: average(allRuns.map((run) => run.steps)),
      avgTokens: average(allRuns.map((run) => run.totalTokens)),
      compactedRuns: workspaces.reduce((sum, workspace) => sum + workspace.compactedRuns, 0),
      totalSteps,
      totalTokens,
    },
  }
  const timing = collectTiming(allRuns)
  if (timing) evidence.timing = timing
  const outcomes = collectOutcomes(allRuns)
  if (outcomes) evidence.outcomes = outcomes
  const storage = collectStorage(store)
  if (storage) evidence.storage = storage
  // 近期 vs 更早：漂移问题必须靠对比才有答案，全量平均会把“最近变差”抹平。
  const cutoff = now.getTime() - REFLECTION_RECENT_DAYS * 24 * 60 * 60 * 1_000
  const recentRuns = allRuns.filter((run) => {
    const at = Date.parse(run.startedAt)
    return Number.isFinite(at) && at >= cutoff
  })
  const olderRuns = allRuns.filter((run) => {
    const at = Date.parse(run.startedAt)
    return Number.isFinite(at) && at < cutoff
  })
  if (recentRuns.length > 0 || olderRuns.length > 0) {
    // 语言取生效的界面语言（配置 + 系统兜底），没有 settings.language 这个字段。
    const english = store.uiLocale() === 'en'
    evidence.recent = windowOf(
      english ? `last ${REFLECTION_RECENT_DAYS} days` : `最近 ${REFLECTION_RECENT_DAYS} 天`,
      recentRuns,
    )
    evidence.baseline = windowOf(english ? 'before that' : '更早', olderRuns)
  }
  if (code) evidence.code = code
  return evidence
}

/** 给人看 / 给模型看的纯文本渲染。 */
export function renderEvidence(evidence: ReflectionEvidence, english: boolean): string {
  const lines: string[] = []
  const t = evidence.totals
  lines.push(
    english
      ? `Totals: ${t.workspaces} workspaces, ${t.sessions} sessions, ${t.runs} runs, ${t.failures} failures (${Math.round(t.failureRate * 100)}%), ${t.toolErrors} tool errors, avg ${t.avgSteps} steps / ${t.avgTokens} tokens, ${t.compactedRuns} compacted runs`
      : `总体：${t.workspaces} 个工作区、${t.sessions} 个会话、${t.runs} 次运行、${t.failures} 次失败（${Math.round(t.failureRate * 100)}%）、${t.toolErrors} 次工具错误、平均 ${t.avgSteps} 步 / ${t.avgTokens} token、${t.compactedRuns} 次运行发生过会话压缩`,
  )
  lines.push(
    english
      ? '  (averages are weighted per run, not per workspace)'
      : '  （以上均值按运行次数加权，不是先按工作区平均再平均）',
  )
  if (evidence.recent || evidence.baseline) {
    const fmt = (window: ReflectionWindow | undefined): string => {
      if (!window) return english ? '(no data)' : '（无数据）'
      return english
        ? `${window.runs} runs, ${window.failures} failures (${Math.round(window.failureRate * 100)}%), avg ${window.avgSteps} steps / ${window.avgTokens} tokens`
        : `${window.runs} 次运行、${window.failures} 次失败（${Math.round(window.failureRate * 100)}%）、平均 ${window.avgSteps} 步 / ${window.avgTokens} token`
    }
    lines.push(
      english
        ? `Trend — ${evidence.recent?.label ?? 'recent'}: ${fmt(evidence.recent)} | ${evidence.baseline?.label ?? 'before'}: ${fmt(evidence.baseline)}`
        : `趋势 —— ${evidence.recent?.label ?? '最近'}：${fmt(evidence.recent)} ｜ ${evidence.baseline?.label ?? '更早'}：${fmt(evidence.baseline)}`,
    )
  }
  const timing = evidence.timing
  if (timing) {
    lines.push(
      english
        ? `Time split over ${timing.runs} runs: model ${timing.modelShare}% (avg ${timing.avgModelMs}ms), tools ${timing.toolShare}% (avg ${timing.avgToolMs}ms), approval ${timing.approvalShare}% (${timing.runsWithApproval} runs waited, avg ${timing.avgApprovalMs}ms), checkpoints avg ${timing.avgCheckpointMs}ms, compaction avg ${timing.avgSummarizeMs}ms`
        : `耗时构成（${timing.runs} 次运行）：模型 ${timing.modelShare}%（均 ${timing.avgModelMs}ms）、工具 ${timing.toolShare}%（均 ${timing.avgToolMs}ms）、审批 ${timing.approvalShare}%（${timing.runsWithApproval} 次有等待，均 ${timing.avgApprovalMs}ms）、快照均 ${timing.avgCheckpointMs}ms、压缩均 ${timing.avgSummarizeMs}ms`,
    )
  }
  const outcomes = evidence.outcomes
  if (outcomes) {
    lines.push(
      english
        ? `Outcomes: ${outcomes.rated} rated (+${outcomes.positive}/-${outcomes.negative}), ${outcomes.checked} runs verified after their last change`
        : `结果：${outcomes.rated} 条评分（好评 ${outcomes.positive} / 差评 ${outcomes.negative}）、${outcomes.checked} 次运行在最后一次改动后做过校验`,
    )
    for (const note of outcomes.negativeNotes) lines.push(`  · ${english ? 'down vote' : '差评'}: ${note}`)
  }
  const storage = evidence.storage
  if (storage) {
    const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)}MB`
    lines.push(
      english
        ? `Local storage: state file ${mb(storage.stateBytes)}, sessions ${mb(storage.sessionShardBytes)} across ${storage.sessionShardFiles} files, checkpoints ${mb(storage.checkpointsBytes)} across ${storage.checkpointFiles} files`
        : `本地存储：状态文件 ${mb(storage.stateBytes)}、会话分片 ${mb(storage.sessionShardBytes)}（${storage.sessionShardFiles} 个文件）、检查点 ${mb(storage.checkpointsBytes)}（${storage.checkpointFiles} 个文件）`,
    )
  }
  for (const workspace of evidence.workspaces) {
    lines.push(
      `- ${workspace.name} (${workspace.path}): sessions=${workspace.sessions}, runs=${workspace.runs}, failures=${workspace.failures}, toolErrors=${workspace.toolErrors}, avgSteps=${workspace.avgSteps}, avgTokens=${workspace.avgTokens}, compactedRuns=${workspace.compactedRuns}, summarizeMs=${workspace.summarizeMs}`,
    )
    for (const failure of workspace.recentFailures) lines.push(`  · ${failure}`)
  }
  if (evidence.code) lines.push(...renderCodeFacts(evidence.code, english))
  const history = evidence.history ?? []
  if (history.length > 0) {
    lines.push(
      '',
      english
        ? 'Already reported (do not restate; items marked done were already fixed in code):'
        : '已经提过的结论（不要重复；标为已处理的表示代码已经改过）：',
    )
    for (const entry of history) {
      const where = entry.refs.length > 0 ? ` @ ${entry.refs.join(', ')}` : ''
      const state = entry.status === 'done' ? (english ? 'done' : '已处理') : english ? 'open' : '待处理'
      lines.push(
        `  · [${entry.createdAt.slice(0, 10)}][${entry.topic}/${entry.severity}/${state}] ${entry.observation}${where}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * 代码事实单独成段：先把可复核的数字摆出来，再列既有决策与约束，
 * 最后才允许模型谈“该不该改结构”。
 */
function renderCodeFacts(code: ReflectionCodeFacts, english: boolean): string[] {
  const lines: string[] = []
  const source = code.reportId
    ? english
      ? `Self-check report ${code.reportId} (${(code.finishedAt ?? '').slice(0, 19).replace('T', ' ')})`
      : `自检报告 ${code.reportId}（${(code.finishedAt ?? '').slice(0, 19).replace('T', ' ')}）`
    : english
      ? 'No self-check report yet'
      : '还没有自检报告'
  lines.push('', english ? `Code facts — ${source}` : `代码事实 —— ${source}`)
  if (typeof code.score === 'number') {
    lines.push(
      english
        ? `- score ${code.score}/100, scanned ${code.scannedFiles ?? 0} files / ${code.scannedLines ?? 0} lines`
        : `- 得分 ${code.score}/100，扫描 ${code.scannedFiles ?? 0} 个文件 / ${code.scannedLines ?? 0} 行`,
    )
  }
  // 报告是快照。用户完全可能在本轮反思之前已经改过代码（包括提交里的修复），
  // 所以龄期必须写出来，否则模型会把旧数字当成现状。
  if (typeof code.ageDays === 'number') {
    lines.push(
      english
        ? `- this report was written ${code.ageDays} day(s) ago; every line count below was re-read from disk just now`
        : `- 这份报告写于 ${code.ageDays} 天前；下面的行数都是刚才重新读盘得到的`,
    )
  }
  // 判据分布：让模型看到仓库里大多数大文件量出来是什么码，而不是默认「行数长＝该拆」。
  const counts = splitScanCounts()
  if (counts.length > 0) {
    lines.push(
      english
        ? `- verdict distribution from split-candidates.mjs --scan (${SPLIT_SCAN_AT}, ${counts.reduce(
            (sum, entry) => sum + entry.count,
            0,
          )} files): ${counts.map((entry) => `${entry.code}=${entry.count}`).join(' ')}`
        : `- split-candidates.mjs --scan 的判据分布（${SPLIT_SCAN_AT}，共 ${counts.reduce(
            (sum, entry) => sum + entry.count,
            0,
          )} 个文件）：${counts.map((entry) => `${entry.code}=${entry.count}`).join(' ')}`,
    )
    const keepCodes = counts.filter((entry) => !SPLIT_VERDICTS[entry.code].split).map((entry) => entry.code)
    if (keepCodes.length > 0) {
      lines.push(
        english
          ? `  · ${keepCodes.join(' / ')} do not justify a split — quote the code, not the line count`
          : `  · ${keepCodes.join(' / ')} 都不支持拆分：引用判据码，不要拿行数当理由`,
      )
    }
  }
  if (code.oversized.length > 0) {
    // 分两组写：已经量过判据的，和连判据都没有的。前者只差一条决策，后者还得先跑脚本。
    const measured = code.oversized.filter((file) => file.verdict)
    const unmeasured = code.oversized.filter((file) => !file.verdict)
    // 行数是重新读盘的结果：已经拆成小文件（或已删）的不再把旧数字当成待办。
    const note = (file: (typeof code.oversized)[number]): string => {
      if (file.missing) return english ? 'file no longer exists' : '文件已不存在'
      if (typeof file.currentLines === 'number' && file.currentLines !== file.lines) {
        return english ? `now ${file.currentLines} lines` : `现在 ${file.currentLines} 行`
      }
      return ''
    }
    const describe = (file: (typeof code.oversized)[number], withVerdict: boolean): string => {
      const extra = note(file)
      if (english) {
        return `${file.path} (${file.lines} at scan time${extra ? `, ${extra}` : ''})${withVerdict ? ` ${file.verdict}` : ''}`
      }
      return `${file.path}（扫描时 ${file.lines} 行${extra ? `，${extra}` : ''}${withVerdict ? `，${file.verdict}` : ''}）`
    }
    if (measured.length > 0) {
      lines.push(
        english
          ? `- over the line threshold, verdict measured but no decision yet: ${measured
              .slice(0, 6)
              .map((file) => describe(file, true))
              .join(', ')}`
          : `- 超过行数阈值、已有判据但还没决策：${measured
              .slice(0, 6)
              .map((file) => describe(file, true))
              .join('、')}`,
      )
    }
    if (unmeasured.length > 0) {
      lines.push(
        english
          ? `- over the line threshold, never measured (line count only, not a verdict): ${unmeasured
              .slice(0, 6)
              .map((file) => describe(file, false))
              .join(', ')}`
          : `- 超过行数阈值、还没量过（只是行数，不是结论）：${unmeasured
              .slice(0, 6)
              .map((file) => describe(file, false))
              .join('、')}`,
      )
    }
  }
  if (code.missingDecisions.length > 0) {
    lines.push(
      english
        ? '- recorded decisions whose file no longer exists (the decision needs revisiting, do not treat it as applied):'
        : '- 已记录决策对应的文件已不存在（决策本身需要复核，不要当成已生效）：',
    )
    for (const path of code.missingDecisions) lines.push(`  · ${path}`)
  }
  if (code.decisions.length > 0) {
    lines.push(english ? '- recorded decisions (do not overturn):' : '- 已记录的决策（不得推翻）：')
    for (const decision of code.decisions.slice(0, 12)) {
      lines.push(
        `  · ${decision.path}: ${splitDecisionKindLabel(decision.kind, english)}${
          decision.rule ? ` (${decision.rule})` : ''
        } — ${decision.reason}`,
      )
      const evidenceLine = decision.evidence.slice(0, 2).join('; ')
      if (evidenceLine) lines.push(`    ${english ? 'evidence' : '证据'}: ${evidenceLine}`)
    }
  }
  if (code.risks.length > 0) {
    lines.push(english ? '- self-check findings with their basis:' : '- 自检结论及其依据：')
    for (const risk of code.risks.slice(0, 8)) {
      lines.push(
        `  · [${risk.severity}] ${risk.moduleName} / ${risk.title}${risk.basis ? ` — ${english ? 'basis' : '依据'}: ${risk.basis}` : ''}`,
      )
    }
  }
  lines.push(english ? 'Structural constraints:' : '结构类约束：')
  for (const entry of splitConstraints(english)) lines.push(`  · ${entry}`)
  return lines
}
