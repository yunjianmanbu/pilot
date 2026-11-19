import type { RunRecord } from './types'

/**
 * Measured behaviour of one profile version, computed from recorded runs.
 *
 * This is the deterministic half of "is the new version actually better".
 * The model-written explanation can only say what changed; these numbers say
 * how each version behaved while it was in use, and they are computed from
 * the same run log the user can open, so there is nothing to trust blindly.
 */

export interface VersionMetrics {
  version: number
  /** Runs attributed to this version (running ones excluded). */
  finished: number
  /** completed / finished. Null when nothing finished yet. */
  successRate: number | null
  /** Runs that ended by hitting the step cap: the agent ran out of room. */
  maxStepRate: number | null
  avgSteps: number | null
  /** Tool errors per run. */
  avgToolErrors: number | null
  /** Share of runs whose last verification-like command succeeded. */
  checkedRate: number | null
  ratingUp: number
  ratingDown: number
}

export type ComparisonVerdict =
  /** The candidate has never run, so only the baseline is measurable. */
  | 'untested'
  /** Both ran, but a side has too few finished runs to say anything. */
  | 'too-few'
  | 'ready'

export interface VersionComparison {
  baseline: VersionMetrics
  candidate: VersionMetrics
  verdict: ComparisonVerdict
  /** Minimum finished runs per side before a difference is treated as signal. */
  minRuns: number
  /** Plain-language sentences, worst-first. Empty when data is missing. */
  findings: string[]
}

const RATING_FLOOR = 3
export const COMPARE_MIN_RUNS = 5

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null
  return part / whole
}

function mean(total: number, count: number): number | null {
  if (count <= 0) return null
  return total / count
}

/** Aggregate the finished runs that ran under one profile version. */
export function versionMetrics(runs: readonly RunRecord[], version: number): VersionMetrics {
  const mine = runs.filter((run) => run.profileVersion === version && run.status !== 'running')
  let completed = 0
  let capped = 0
  let steps = 0
  let toolErrors = 0
  let checked = 0
  let checkedKnown = 0
  let up = 0
  let down = 0
  for (const run of mine) {
    if (run.status === 'completed') completed += 1
    if (run.status === 'max_steps') capped += 1
    steps += run.steps ?? 0
    toolErrors += run.toolErrors ?? 0
    if (run.checked !== undefined) {
      checkedKnown += 1
      if (run.checked) checked += 1
    }
    if (run.feedback?.rating === 'up') up += 1
    if (run.feedback?.rating === 'down') down += 1
  }
  return {
    version,
    finished: mine.length,
    successRate: rate(completed, mine.length),
    maxStepRate: rate(capped, mine.length),
    avgSteps: mean(steps, mine.length),
    avgToolErrors: mean(toolErrors, mine.length),
    checkedRate: rate(checked, checkedKnown),
    ratingUp: up,
    ratingDown: down,
  }
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

/**
 * Compare two versions on the same measures.
 *
 * Deliberately conservative: a difference is only reported when both sides
 * have enough finished runs, so a lucky streak of two tasks is never sold as
 * an improvement.
 */
export function compareVersions(
  runs: readonly RunRecord[],
  baselineVersion: number,
  candidateVersion: number,
  minRuns = COMPARE_MIN_RUNS,
): VersionComparison {
  const baseline = versionMetrics(runs, baselineVersion)
  const candidate = versionMetrics(runs, candidateVersion)
  if (candidate.finished === 0 && baseline.finished === 0) {
    return { baseline, candidate, verdict: 'untested', minRuns, findings: [] }
  }
  if (candidate.finished === 0) {
    return { baseline, candidate, verdict: 'untested', minRuns, findings: [] }
  }
  if (baseline.finished < minRuns || candidate.finished < minRuns) {
    return { baseline, candidate, verdict: 'too-few', minRuns, findings: [] }
  }

  const findings: string[] = []
  const successDelta = (candidate.successRate ?? 0) - (baseline.successRate ?? 0)
  if (Math.abs(successDelta) >= 0.1) {
    findings.push(
      successDelta > 0
        ? `新版完成任务的比例 ${pct(candidate.successRate)}，旧版 ${pct(baseline.successRate)}。`
        : `新版完成任务的比例 ${pct(candidate.successRate)}，低于旧版 ${pct(baseline.successRate)}。`,
    )
  }
  const capDelta = (candidate.maxStepRate ?? 0) - (baseline.maxStepRate ?? 0)
  if (Math.abs(capDelta) >= 0.1) {
    findings.push(
      capDelta < 0
        ? `撞到步数上限的跑次从 ${pct(baseline.maxStepRate)} 降到 ${pct(candidate.maxStepRate)}。`
        : `撞到步数上限的跑次从 ${pct(baseline.maxStepRate)} 升到 ${pct(candidate.maxStepRate)}。`,
    )
  }
  const stepsDelta = (candidate.avgSteps ?? 0) - (baseline.avgSteps ?? 0)
  if (Math.abs(stepsDelta) >= 2) {
    findings.push(
      stepsDelta < 0
        ? `同样的任务平均少走 ${Math.abs(stepsDelta).toFixed(1)} 步。`
        : `同样的任务平均多走 ${stepsDelta.toFixed(1)} 步。`,
    )
  }
  const errorDelta = (candidate.avgToolErrors ?? 0) - (baseline.avgToolErrors ?? 0)
  if (Math.abs(errorDelta) >= 0.5) {
    findings.push(
      errorDelta < 0
        ? `每次运行的命令报错从 ${baseline.avgToolErrors?.toFixed(1)} 次降到 ${candidate.avgToolErrors?.toFixed(1)} 次。`
        : `每次运行的命令报错从 ${baseline.avgToolErrors?.toFixed(1)} 次升到 ${candidate.avgToolErrors?.toFixed(1)} 次。`,
    )
  }
  if (baseline.ratingUp + baseline.ratingDown >= RATING_FLOOR || candidate.ratingUp + candidate.ratingDown >= RATING_FLOOR) {
    const base = baseline.ratingUp - baseline.ratingDown
    const cand = candidate.ratingUp - candidate.ratingDown
    if (cand !== base) {
      findings.push(
        cand > base
          ? `你的评价更正面了：新版 好评 ${candidate.ratingUp} / 差评 ${candidate.ratingDown}，旧版 ${baseline.ratingUp} / ${baseline.ratingDown}。`
          : `你的评价变差了：新版 好评 ${candidate.ratingUp} / 差评 ${candidate.ratingDown}，旧版 ${baseline.ratingUp} / ${baseline.ratingDown}。`,
      )
    }
  }
  return { baseline, candidate, verdict: 'ready', minRuns, findings }
}

/** Compact one-line summary for logs and chat replies. */
export function summarizeComparison(comparison: VersionComparison): string {
  const { baseline, candidate } = comparison
  const side = (metrics: VersionMetrics) =>
    `v${metrics.version}: ${metrics.finished} 次运行 · 成功率 ${pct(metrics.successRate)} · 平均 ${metrics.avgSteps?.toFixed(1) ?? '—'} 步`
  return `${side(baseline)} → ${side(candidate)}`
}
