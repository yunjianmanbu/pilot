/**
 * Paired benchmark for comparing the ACTIVE profile with a CANDIDATE profile.
 *
 * Review scores answer "does this rule sound reasonable"; they cannot answer
 * "does the agent actually do better work with it". This module answers the
 * second question by replaying the same fixed task suite twice — once under the
 * active profile, once under the candidate — in throwaway workspaces, and then
 * comparing the paired outcomes.
 *
 * Design rules (all of them exist to keep the verdict honest):
 * - Same tasks, same model, same limits: only the profile differs.
 * - Each task runs in a fresh temp workspace seeded from the task fixture, so
 *   one run cannot inherit another run's edits.
 * - Run order alternates per task, so cache warmth and rate limits do not
 *   systematically favour one variant.
 * - Objective checks (exit code of a command the task ships) decide pass/fail;
 *   third-party judges only ever break ties, never overturn a failed check.
 * - Execution effectiveness outranks every subjective signal: a candidate that
 *   completes fewer tasks is always worse, no matter how the judges rate its
 *   prose. A completion gain is accepted once the suite has enough tasks or
 *   the gain is a clear net margin, so one lucky task cannot promote a version.
 * - When both sides complete the same share, a clear run-stability difference
 *   (at least two run-level errors) is compared before judge scores, and judge
 *   scores before step/token economy. A single run error is only a note.
 * - A verdict needs enough paired tasks and a clear margin; anything else is
 *   reported as `inconclusive` or `insufficient` instead of a guess.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ModelClient } from './loop'
import type { JudgeUsage, ProfileComparison } from '../../shared/types'
import { coerceScore, extractJsonObject } from './json'
import {
  JUDGE_IDLE_TIMEOUT_MS,
  JUDGE_TOTAL_TIMEOUT_MS,
  addJudgeUsage,
  completeWithWatchdog,
  emptyJudgeUsage,
  sanitizeJudgeUsage,
  unparsedResponseReason,
} from './judge-runtime'
import {
  BENCHMARK_SUITE_VERSION,
  assessCeiling,
  describeCeiling,
  planSuiteUpgrade,
  summarizeSuite,
  type BenchmarkCeiling,
  type SuiteSummary,
  type SuiteUpgrade,
} from './profile-benchmark-suite'

export type BenchmarkVariant = 'current' | 'candidate'

export interface BenchmarkTask {
  id: string
  /** Task text handed to the agent exactly as a user would send it. */
  prompt: string
  /** Files written into the isolated workspace before the run. */
  files?: Record<string, string>
  /**
   * Optional objective check. The command runs with the isolated workspace as
   * cwd; exit code 0 means the task delivered what it promised.
   */
  check?: { command: string; args?: string[]; timeoutMs?: number }
  /**
   * Difficult tier. `L0` is a smoke test (a working profile must pass it),
   * `L1` a single-file fix, `L2` a multi-part change, `L3` an open task.
   * Only used to balance a suite; it never changes a single task's verdict.
   */
  difficulty?: 'L0' | 'L1' | 'L2' | 'L3'
  /**
   * Baseline the candidate may not break. A candidate that fails a task the
   * current profile passes is rejected outright, however well it does overall.
   * `L0` tasks are treated as baselines without this flag.
   */
  mustPass?: boolean
  /**
   * How many times each variant runs this task. More than one separates a
   * stable solve from a lucky one: a sample counts as passed only when every
   * attempt passes, so "works half the time" reads as unfinished work instead
   * of a pass. Applied to the hardest tier so the ceiling is measured on
   * repeatability, not on a single draw.
   */
  attempts?: number
  /** Capability tags (`append-only`, `read-before-edit`, ...) used to keep a
   * suite from covering one behaviour twice while missing another. */
  tags?: string[]
}

export interface TaskRunResult {
  ok: boolean
  steps: number
  tokens: number
  ms?: number
  /** Final answer of the run; shown to the judges, never used for pass/fail. */
  output?: string
  error?: string
}

export type TaskRunner = (input: {
  task: BenchmarkTask
  variant: BenchmarkVariant
  workspacePath: string
}) => Promise<TaskRunResult>

export interface BenchmarkSample {
  taskId: string
  variant: BenchmarkVariant
  ok: boolean
  steps: number
  tokens: number
  ms: number
  /** Blind score from the judge panel, 0-100. Absent when no judge replied. */
  judgeScore?: number
  error?: string
  /** Attempts actually run for this sample (1 when the task is not repeated). */
  attempts?: number
  /** Attempts that failed; `ok` is false as soon as this is above zero. */
  failedAttempts?: number
  /** Some attempts passed and some did not: the solve is not repeatable. */
  flaky?: boolean
}

export interface BenchmarkStats {
  runs: number
  passed: number
  successRate: number
  avgSteps: number
  avgTokens: number
  avgMs: number
  avgJudgeScore?: number
}

export type BenchmarkVerdictKind = 'better' | 'worse' | 'inconclusive' | 'insufficient'

export interface BenchmarkComparison {
  verdict: BenchmarkVerdictKind
  /** Paired tasks, i.e. tasks that ran under both variants. */
  tasks: number
  wins: number
  losses: number
  ties: number
  current: BenchmarkStats
  candidate: BenchmarkStats
  reasons: string[]
}

export interface BenchmarkRun {
  comparison: BenchmarkComparison
  samples: BenchmarkSample[]
  judgeErrors: string[]
  /**
   * Spend of the blind judges across every graded pair. Absent when no judge
   * was configured; a configured judge whose endpoint reports no usage still
   * shows up as `calls` with zero counted tokens.
   */
  judgeUsage?: JudgeUsage
  startedAt: string
  finishedAt: string
  /** Id of the profile that was in force on the "current" side, or null for none. */
  currentProfileId: string | null
  /**
   * The task library this run used: version, tier balance, blind spots. A
   * verdict is only meaningful relative to it, because a saturated suite
   * reports `inconclusive` no matter how different the two profiles are.
   */
  suite?: SuiteSummary
  /** How far up the task difficulty the agent actually got. */
  ceiling?: BenchmarkCeiling
  /** What the next suite revision has to add to keep measuring. */
  upgrade?: SuiteUpgrade
}

/**
 * Keep the six most useful reasons, always including how much of the task
 * library is still unsolved and, when it is saturated, what the next revision
 * must add. Without it an `inconclusive` verdict from a saturated suite looks
 * like evidence of equality.
 */
function ceilingReasons(reasons: string[], run: BenchmarkRun): string[] {
  if (!run.ceiling) return reasons.slice(0, 6)
  const version = run.suite ? `题库 v${run.suite.version}｜` : ''
  const lines = [...reasons.slice(0, 5), `${version}${describeCeiling(run.ceiling)}`]
  const probe = run.upgrade?.toVersion !== run.upgrade?.fromVersion ? run.upgrade?.addProbes[0] : undefined
  if (probe) lines.push(`题库升级建议：${probe}`)
  return lines
}

/** Compact the run into the shape stored on a profile review. */
export function toProfileComparison(
  run: BenchmarkRun,
  judges: string[],
  /** Ids of the two profiles, so a later review can verify what was compared. */
  ids: { currentId?: string; candidateId?: string } = {},
): ProfileComparison {
  const { comparison } = run
  return {
    verdict: comparison.verdict,
    tasks: comparison.tasks,
    wins: comparison.wins,
    losses: comparison.losses,
    ties: comparison.ties,
    current: {
      successRate: comparison.current.successRate,
      avgSteps: comparison.current.avgSteps,
      avgTokens: comparison.current.avgTokens,
      ...(comparison.current.avgMs !== undefined ? { avgMs: comparison.current.avgMs } : {}),
      ...(comparison.current.avgJudgeScore !== undefined
        ? { avgJudgeScore: comparison.current.avgJudgeScore }
        : {}),
    },
    candidate: {
      successRate: comparison.candidate.successRate,
      avgSteps: comparison.candidate.avgSteps,
      avgTokens: comparison.candidate.avgTokens,
      ...(comparison.candidate.avgMs !== undefined ? { avgMs: comparison.candidate.avgMs } : {}),
      ...(comparison.candidate.avgJudgeScore !== undefined
        ? { avgJudgeScore: comparison.candidate.avgJudgeScore }
        : {}),
    },
    // The ceiling note goes last but never gets cut: a verdict read without it
    // can be mistaken for "no difference" when the suite simply saturated.
    reasons: ceilingReasons(comparison.reasons, run),
    at: run.finishedAt,
    ...(run.suite ? { suiteVersion: run.suite.version } : {}),
    ...(run.ceiling?.ceilingTier ? { ceilingTier: run.ceiling.ceilingTier } : {}),
    ...(run.ceiling ? { ceilingPassRate: run.ceiling.ceilingPassRate } : {}),
    ...(run.ceiling ? { suiteSaturated: run.ceiling.saturated } : {}),
    ...(ids.currentId ? { currentId: ids.currentId } : {}),
    ...(ids.candidateId ? { candidateId: ids.candidateId } : {}),
    ...(judges.length > 0 ? { judges } : {}),
    ...(run.judgeErrors.length > 0 ? { judgeErrors: run.judgeErrors.slice(0, 6) } : {}),
    ...(run.judgeUsage ? { judgeUsage: run.judgeUsage } : {}),
  }
}

/**
 * A recorded benchmark may gate activation only while it still describes the
 * pair being activated: same candidate, and the same profile that is in force.
 * After a rollback or a new active version the old numbers no longer apply, so
 * the caller must treat them as absent instead of quoting stale evidence.
 *
 * The same holds for the task library: a verdict measured against an older,
 * easier revision cannot say whether the candidate clears the current one, and
 * is therefore not reusable as evidence. A comparison stored before revisions
 * were recorded has no version and stays valid.
 */
export function reusableComparison(
  comparison: ProfileComparison | undefined,
  candidateId: string,
  activeProfileId: string | null,
  suiteVersion: number = BENCHMARK_SUITE_VERSION,
): ProfileComparison | undefined {
  if (!comparison) return undefined
  if (comparison.candidateId && comparison.candidateId !== candidateId) return undefined
  const compared = comparison.currentId ?? null
  if (compared !== activeProfileId) return undefined
  if (!comparison.candidateId) return undefined
  if (comparison.suiteVersion !== undefined && comparison.suiteVersion !== suiteVersion) return undefined
  return comparison
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function sanitizeVariant(value: unknown): ProfileComparison['current'] {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const judgeScore = raw['avgJudgeScore']
  return {
    successRate: clampNumber(raw['successRate'], 0, 100, 0),
    avgSteps: clampNumber(raw['avgSteps'], 0, 1_000, 0),
    avgTokens: clampNumber(raw['avgTokens'], 0, 10_000_000, 0),
    ...(typeof raw['avgMs'] === 'number' && Number.isFinite(raw['avgMs'])
      ? { avgMs: clampNumber(raw['avgMs'], 0, 86_400_000, 0) }
      : {}),
    ...(typeof judgeScore === 'number' && Number.isFinite(judgeScore)
      ? { avgJudgeScore: clampNumber(judgeScore, 0, 100, 0) }
      : {}),
  }
}

/**
 * Restore a persisted comparison from disk. Anything that does not survive
 * this check is dropped, so a corrupt or hand-edited JSON file can never make
 * the UI claim a benchmark that was not actually run.
 */
export function sanitizeProfileComparison(value: unknown): ProfileComparison | undefined {  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const verdict = raw['verdict']
  if (
    verdict !== 'better' &&
    verdict !== 'worse' &&
    verdict !== 'inconclusive' &&
    verdict !== 'insufficient'
  ) {
    return undefined
  }
  const strings = (input: unknown, limit: number): string[] =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, limit)
      : []
  const judges = strings(raw['judges'], 8)
  const judgeErrors = strings(raw['judgeErrors'], 6)
  const judgeUsage = sanitizeJudgeUsage(raw['judgeUsage'])
  return {
    verdict,
    tasks: clampNumber(raw['tasks'], 0, 200, 0),
    wins: clampNumber(raw['wins'], 0, 200, 0),
    losses: clampNumber(raw['losses'], 0, 200, 0),
    ties: clampNumber(raw['ties'], 0, 200, 0),
    current: sanitizeVariant(raw['current']),
    candidate: sanitizeVariant(raw['candidate']),
    reasons: strings(raw['reasons'], 6),
    at: typeof raw['at'] === 'string' ? raw['at'] : new Date(0).toISOString(),
    ...(typeof raw['currentId'] === 'string' && raw['currentId'] ? { currentId: raw['currentId'] } : {}),
    ...(typeof raw['candidateId'] === 'string' && raw['candidateId']
      ? { candidateId: raw['candidateId'] }
      : {}),
    ...(judges.length > 0 ? { judges } : {}),
    ...(judgeErrors.length > 0 ? { judgeErrors } : {}),
    ...(judgeUsage ? { judgeUsage } : {}),
  }
}

/**
 * Tasks a working profile must pass: the explicitly marked baselines plus every
 * `L0` smoke task. Deriving `L0` keeps the gate honest when a task is added
 * without a `mustPass` flag — a smoke test a candidate cannot pass is a
 * regression, and one neither side passes means the fixture is broken.
 */
export function mustPassTaskIds(tasks: readonly BenchmarkTask[]): string[] {
  return tasks
    .filter((task) => task.mustPass === true || task.difficulty === 'L0')
    .map((task) => task.id)
}

export const BENCHMARK_LIMITS = {
  /** Paired tasks needed before any verdict other than `insufficient`. */
  minTasks: 3,
  /** Smallest net task margin that can ever justify a verdict. */
  minWinMargin: 2,
  /**
   * Share of the *decided* pairs a net completion margin must also reach.
   * A one-task gain is weak evidence on any suite, so the required margin grows
   * with the number of decided tasks instead of shrinking as the suite widens.
   */
  completionMarginRatio: 0.25,
  /** Extra run-level errors that count as a clear stability regression. */
  stabilityErrorDelta: 2,
  /** Upper bound on `task.attempts`, so a fixture cannot silently multiply the run time. */
  maxAttempts: 3,
  /** Judge-score difference that breaks a tie after completion and stability. */
  judgeDelta: 5,
  /** Step difference that breaks a tie when no judge score exists. */
  stepDelta: 2,
  /** Token difference (relative) that breaks a tie when no judge score exists. */
  tokenDelta: 0.1,
  /**
   * Cost ceilings for a candidate whose quality win is only marginal: past
   * these ratios the win is downgraded to `inconclusive` instead of replacing
   * the running profile. They sit far above the tie-breakers on purpose —
   * answering quality outranks cost, so only a large increase vetoes a win.
   */
  tokenRegressionRatio: 1.5,
  durationRegressionRatio: 2,
} as const

/**
 * Cost and duration are a tie-breaker, never a reason to prefer a worse answer.
 * Returns a human-readable summary when the candidate needs clearly more tokens
 * or wall-clock time than the version it would replace, otherwise `undefined`.
 * An unknown (0 or missing) measurement never triggers a veto.
 */
export function costRegression(
  current: { avgTokens: number; avgMs?: number },
  candidate: { avgTokens: number; avgMs?: number },
): string | undefined {
  const parts: string[] = []
  const tokens = ratio(candidate.avgTokens, current.avgTokens)
  if (tokens !== undefined && tokens > BENCHMARK_LIMITS.tokenRegressionRatio) {
    parts.push(`平均 token ${current.avgTokens} → ${candidate.avgTokens}（${tokens.toFixed(1)} 倍）`)
  }
  const ms = ratio(candidate.avgMs, current.avgMs)
  if (ms !== undefined && ms > BENCHMARK_LIMITS.durationRegressionRatio) {
    parts.push(`平均耗时 ${current.avgMs} → ${candidate.avgMs} ms（${ms.toFixed(1)} 倍）`)
  }
  return parts.length > 0 ? parts.join('，') : undefined
}

function ratio(candidate: number | undefined, current: number | undefined): number | undefined {
  if (typeof candidate !== 'number' || typeof current !== 'number') return undefined
  if (!Number.isFinite(candidate) || !Number.isFinite(current) || current <= 0) return undefined
  return candidate / current
}

function stats(samples: BenchmarkSample[]): BenchmarkStats {
  const runs = samples.length
  if (runs === 0) {
    return { runs: 0, passed: 0, successRate: 0, avgSteps: 0, avgTokens: 0, avgMs: 0 }
  }
  const passed = samples.filter((sample) => sample.ok).length
  const mean = (pick: (sample: BenchmarkSample) => number): number =>
    Math.round(samples.reduce((sum, sample) => sum + pick(sample), 0) / runs)
  const scored = samples.filter((sample) => typeof sample.judgeScore === 'number')
  return {
    runs,
    passed,
    successRate: Math.round((passed / runs) * 1000) / 1000,
    avgSteps: mean((sample) => sample.steps),
    avgTokens: mean((sample) => sample.tokens),
    avgMs: mean((sample) => sample.ms),
    ...(scored.length > 0
      ? {
          avgJudgeScore: Math.round(
            scored.reduce((sum, sample) => sum + (sample.judgeScore ?? 0), 0) / scored.length,
          ),
        }
      : {}),
  }
}

/** Compare one paired task; positive means the candidate did better. */
function taskDelta(current: BenchmarkSample, candidate: BenchmarkSample): number {
  // A failed objective check is decisive: no judge score can lift it.
  if (current.ok !== candidate.ok) return candidate.ok ? 1 : -1
  if (!current.ok && !candidate.ok) return 0
  if (
    typeof current.judgeScore === 'number' &&
    typeof candidate.judgeScore === 'number' &&
    Math.abs(candidate.judgeScore - current.judgeScore) >= BENCHMARK_LIMITS.judgeDelta
  ) {
    return candidate.judgeScore > current.judgeScore ? 1 : -1
  }
  const stepsBetter = current.steps - candidate.steps
  if (Math.abs(stepsBetter) >= BENCHMARK_LIMITS.stepDelta) return stepsBetter > 0 ? 1 : -1
  if (current.tokens > 0) {
    const relative = (current.tokens - candidate.tokens) / current.tokens
    if (Math.abs(relative) >= BENCHMARK_LIMITS.tokenDelta) return relative > 0 ? 1 : -1
  }
  return 0
}

/**
 * Turn samples into a verdict. Pure: same input, same output, no I/O, so the
 * decision that gates an upgrade can be unit tested directly.
 */
export function compareBenchmark(
  samples: BenchmarkSample[],
  limits: {
    minTasks?: number
    minWinMargin?: number
    /** See `BENCHMARK_LIMITS.completionMarginRatio`. */
    completionMarginRatio?: number
    /** Tasks that are `mustPass` (explicitly or L0) in the suite behind these samples. */
    mustPassTaskIds?: readonly string[]
  } = {},
): BenchmarkComparison {
  const minTasks = limits.minTasks ?? BENCHMARK_LIMITS.minTasks
  const minWinMargin = limits.minWinMargin ?? BENCHMARK_LIMITS.minWinMargin
  const completionMarginRatio =
    limits.completionMarginRatio ?? BENCHMARK_LIMITS.completionMarginRatio
  const byTask = new Map<string, { current?: BenchmarkSample; candidate?: BenchmarkSample }>()
  for (const sample of samples) {
    const entry = byTask.get(sample.taskId) ?? {}
    entry[sample.variant] = sample
    byTask.set(sample.taskId, entry)
  }
  const paired = [...byTask.values()].filter(
    (entry): entry is { current: BenchmarkSample; candidate: BenchmarkSample } =>
      Boolean(entry.current && entry.candidate),
  )
  const current = stats(paired.map((entry) => entry.current))
  const candidate = stats(paired.map((entry) => entry.candidate))
  let wins = 0
  let losses = 0
  let ties = 0
  let objectiveWins = 0
  let objectiveLosses = 0
  for (const entry of paired) {
    if (entry.current.ok !== entry.candidate.ok) {
      if (entry.candidate.ok) objectiveWins += 1
      else objectiveLosses += 1
    }
    const delta = taskDelta(entry.current, entry.candidate)
    if (delta > 0) wins += 1
    else if (delta < 0) losses += 1
    else ties += 1
  }
  const base = { tasks: paired.length, wins, losses, ties, current, candidate }
  if (paired.length < minTasks) {
    return {
      ...base,
      verdict: 'insufficient',
      reasons: [
        `需要至少 ${minTasks} 组可比任务才能下结论，当前只有 ${paired.length} 组。`,
      ],
    }
  }
  // A must-pass baseline outranks every aggregate signal: losing a task the
  // current profile already handled is a regression even when the candidate
  // gains more elsewhere, and a baseline neither side passes is a broken task
  // rather than evidence about either profile.
  const mustPass = new Set(limits.mustPassTaskIds ?? [])
  if (mustPass.size > 0) {
    const regressions: string[] = []
    const broken: string[] = []
    for (const entry of paired) {
      if (!mustPass.has(entry.current.taskId)) continue
      if (!entry.current.ok && !entry.candidate.ok) broken.push(entry.current.taskId)
      else if (entry.current.ok && !entry.candidate.ok) regressions.push(entry.current.taskId)
    }
    if (regressions.length > 0) {
      return {
        ...base,
        verdict: 'worse',
        reasons: [
          `必过任务 ${regressions.join('、')}：当前版本通过、候选版本失败；基线任务回退，判为更差。`,
        ],
      }
    }
    if (broken.length > 0) {
      return {
        ...base,
        verdict: 'inconclusive',
        reasons: [
          `必过任务 ${broken.join('、')}：两边都没通过，说明题目或运行环境本身有问题；先修题再比较。`,
        ],
      }
    }
  }
  // Execution effectiveness is the top-order signal. A lower completion rate
  // is always a regression — even if the judges prefer the candidate's prose
  // or it uses fewer steps on the tasks both finished.
  const successDelta = candidate.successRate - current.successRate
  if (successDelta < 0) {
    return {
      ...base,
      verdict: 'worse',
      reasons: [
        `候选版本成功率 ${Math.round(candidate.successRate * 100)}%，低于当前版本 ${Math.round(current.successRate * 100)}%；执行结果不允许回退，判为更差。`,
      ],
    }
  }
  // A higher completion rate wins only with a clear net margin over the tasks
  // that actually went one way: one extra completed task is noise whether the
  // suite has three tasks or nine. Ties do not raise the bar because they carry
  // no information about either variant.
  if (successDelta > 0) {
    const completionMargin = objectiveWins - objectiveLosses
    const decided = objectiveWins + objectiveLosses
    const requiredMargin = Math.max(
      minWinMargin,
      Math.ceil(decided * completionMarginRatio),
    )
    if (completionMargin < requiredMargin) {
      return {
        ...base,
        verdict: 'inconclusive',
        reasons: [
          `候选版本成功率 ${Math.round(candidate.successRate * 100)}% 高于当前 ${Math.round(current.successRate * 100)}%，但分出胜负的 ${decided} 组里净胜只有 ${completionMargin} 个，少于要求的 ${requiredMargin} 个；单个任务的差距不足以判更优。`,
        ],
      }
    }
    // Cost never outranks answering quality, but a marginal win does not buy a
    // large cost increase: below twice the required margin the candidate has to
    // stay inside the token/duration ceilings.
    const cost =
      completionMargin >= requiredMargin * 2 ? undefined : costRegression(current, candidate)
    if (cost) {
      return {
        ...base,
        verdict: 'inconclusive',
        reasons: [
          `候选版本成功率 ${Math.round(candidate.successRate * 100)}% 高于当前 ${Math.round(current.successRate * 100)}%（分出胜负 ${decided} 组，净胜 ${completionMargin} 个，要求 ${requiredMargin} 个），但${cost}；这点质量优势不足以抵消成本上升，判为无明显提升。`,
        ],
      }
    }
    return {
      ...base,
      verdict: 'better',
      reasons: [
        `候选版本成功率 ${Math.round(candidate.successRate * 100)}% 高于当前 ${Math.round(current.successRate * 100)}%（分出胜负 ${decided} 组，净胜 ${completionMargin} 个，要求 ${requiredMargin} 个）；执行结果优先，判为更优。`,
      ],
    }
  }
  // Same completion rate: only a clear stability difference outranks judge
  // scores. A single extra run error (retry, crash, aborted tool) is reported
  // as a note, not treated as decisive.
  const currentErrors = paired.filter((entry) => entry.current.error).length
  const candidateErrors = paired.filter((entry) => entry.candidate.error).length
  const errorDelta = candidateErrors - currentErrors
  if (Math.abs(errorDelta) >= BENCHMARK_LIMITS.stabilityErrorDelta) {
    const better = errorDelta < 0
    const cost = better ? costRegression(current, candidate) : undefined
    if (cost) {
      return {
        ...base,
        verdict: 'inconclusive',
        reasons: [
          `两边成功率相同，候选版本运行错误 ${candidateErrors} 次、当前 ${currentErrors} 次，但${cost}；稳定性收益不足以抵消成本上升，判为无明显提升。`,
        ],
      }
    }
    return {
      ...base,
      verdict: better ? 'better' : 'worse',
      reasons: [
        `两边成功率相同，候选版本运行错误 ${candidateErrors} 次，当前版本 ${currentErrors} 次；稳定性明显${better ? '更好' : '更差'}，判为${better ? '更优' : '更差'}。`,
      ],
    }
  }
  const reasons: string[] = []
  if (errorDelta !== 0) {
    reasons.push(
      `运行错误候选 ${candidateErrors} 次、当前 ${currentErrors} 次，差距不足 ${BENCHMARK_LIMITS.stabilityErrorDelta} 次，只作参考`,
    )
  }
  if (candidate.avgSteps !== current.avgSteps) {
    reasons.push(`平均步数 ${current.avgSteps} → ${candidate.avgSteps}`)
  }
  if (candidate.avgTokens !== current.avgTokens) {
    reasons.push(`平均 token ${current.avgTokens} → ${candidate.avgTokens}`)
  }
  if (losses > wins) {
    reasons.unshift(`候选版本在 ${losses} 个任务上更差，只在 ${wins} 个任务上更好。`)
    return { ...base, verdict: 'worse', reasons }
  }
  if (wins - losses >= minWinMargin) {
    const cost = wins - losses >= minWinMargin * 2 ? undefined : costRegression(current, candidate)
    if (cost) {
      return {
        ...base,
        verdict: 'inconclusive',
        reasons: [
          `候选版本在 ${wins} 个任务上更好、${losses} 个更差，但${cost}；这点质量优势不足以抵消成本上升，判为无明显提升。`,
        ],
      }
    }
    reasons.unshift(`候选版本在 ${wins} 个任务上更好，${losses} 个更差。`)
    return { ...base, verdict: 'better', reasons }
  }
  reasons.unshift(
    `差异不足以证明提升：更好 ${wins} 个、更差 ${losses} 个、持平 ${ties} 个（需净胜 ${minWinMargin} 个）。`,
  )
  return { ...base, verdict: 'inconclusive', reasons }
}

const JUDGE_SYSTEM = [
  'You compare two agent transcripts of the SAME task, labelled A and B.',
  'You do not know which configuration produced which transcript. Judge only the work.',
  'Score in this priority order: (1) execution effectiveness — did it finish the task correctly and completely; (2) stability — is the result reliable, with no failed commands, retries, aborted steps or success claims that were never checked; (3) economy — did it waste steps or tokens; (4) explanation quality, which carries the least weight.',
  'Clear prose cannot compensate for unfinished or unverified work. A shorter transcript that leaves the task unfinished is worse, not better.',
  '',
  'Return the JSON object only. Do not use a Markdown code fence and do not explain before or after it.',
  '{"a":{"score":0-100,"note":"..."},"b":{"score":0-100,"note":"..."},"better":"a|b|tie","reason":"one sentence"}',
].join('\n')

function scoreField(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return (value as Record<string, unknown>)['score']
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = (value as Record<string, unknown>)[key]
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : null
}

export function parseJudgeScores(
  content: string,
): { a: number; b: number } | null {
  const parsed = extractJsonObject(content)
  if (!parsed) return null
  // Accept the documented lowercase keys, plus the uppercase/scores variants
  // some providers emit for the same schema.
  const scores = objectField(parsed, 'scores')
  const a = coerceScore(scoreField(parsed['a'] ?? parsed['A'] ?? scores?.['a'] ?? scores?.['A']))
  const b = coerceScore(scoreField(parsed['b'] ?? parsed['B'] ?? scores?.['b'] ?? scores?.['B']))
  if (a === null || b === null) return null
  return { a, b }
}

async function runCheck(task: BenchmarkTask, cwd: string): Promise<boolean | null> {
  if (!task.check) return null
  return new Promise((resolve) => {
    execFile(
      task.check!.command,
      task.check!.args ?? [],
      { cwd, timeout: task.check!.timeoutMs ?? 180_000, windowsHide: true },
      (error) => resolve(!error),
    )
  })
}

export interface ProfileBenchmarkOptions {
  tasks: BenchmarkTask[]
  currentProfile: string
  candidateProfile: string
  /** Id of the profile in force on the "current" side; null when none is active. */
  currentProfileId?: string | null
  /** Directory holding the per-run workspaces; a temp dir is used by default. */
  rootDir?: string
  judgeTimeoutMs?: number
}

/**
 * Runs the suite under both variants and judges the pairs blind.
 * `runTask` is injected so the benchmark stays independent of how a run is
 * executed (the runner wires it to the real agent loop; tests use fakes).
 */
export class ProfileBenchmark {
  constructor(
    private readonly runTask: TaskRunner,
    private readonly judges: () => { label: string; client: ModelClient }[] = () => [],
    private readonly judgeTimeoutMs = JUDGE_IDLE_TIMEOUT_MS,
  ) {}

  async run(options: ProfileBenchmarkOptions): Promise<BenchmarkRun> {
    const startedAt = new Date().toISOString()
    const root = options.rootDir ?? (await mkdtemp(join(tmpdir(), 'pilot-bench-')))
    const ownsRoot = !options.rootDir
    const samples: BenchmarkSample[] = []
    const judgeErrors: string[] = []
    const judgeUsage = emptyJudgeUsage()
    try {
      for (const [index, task] of options.tasks.entries()) {
        // Alternate which variant runs first so a systematic ordering effect
        // cannot favour one profile.
        const order: BenchmarkVariant[] =
          index % 2 === 0 ? ['current', 'candidate'] : ['candidate', 'current']
        const runs = new Map<
          BenchmarkVariant,
          { result: TaskRunResult; attempts: number; failedAttempts: number; flaky: boolean }
        >()
        const attempts = Math.max(
          1,
          Math.min(BENCHMARK_LIMITS.maxAttempts, Math.floor(task.attempts ?? 1)),
        )
        for (const variant of order) {
          let failures = 0
          let passedAttempts = 0
          let steps = 0
          let tokens = 0
          let ms = 0
          let firstError: string | undefined
          let last: TaskRunResult = { ok: false, steps: 0, tokens: 0 }
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            // Each attempt gets a pristine workspace: a retried task must not
            // inherit the files an earlier attempt (or the agent) left behind.
            const workspacePath =
              attempt === 0 ? join(root, `${task.id}-${variant}`) : join(root, `${task.id}-${variant}-${attempt + 1}`)
            await mkdir(workspacePath, { recursive: true })
            for (const [path, content] of Object.entries(task.files ?? {})) {
              const target = join(workspacePath, path)
              await mkdir(dirname(target), { recursive: true })
              await writeFile(target, content, 'utf8')
            }
            const started = Date.now()
            let result: TaskRunResult
            try {
              result = await this.runTask({ task, variant, workspacePath })
            } catch (error) {
              result = {
                ok: false,
                steps: 0,
                tokens: 0,
                error: error instanceof Error ? error.message : 'run failed',
              }
            }
            const checked = await runCheck(task, workspacePath)
            const ok = checked === null ? result.ok : checked
            if (ok) passedAttempts += 1
            else {
              failures += 1
              firstError = firstError ?? result.error
            }
            last = { ...result, ok }
            steps += result.steps
            tokens += result.tokens
            ms += checked === null ? (result.ms ?? Date.now() - started) : Date.now() - started
          }
          runs.set(variant, {
            result: {
              ...last,
              // A solve only counts when it repeats: a task that passes half the
              // time is unfinished work, not a pass with a footnote.
              ok: failures === 0,
              // Steps are averaged per attempt so the number stays comparable
              // across suites; tokens and wall clock are real spend, so summed.
              steps: Math.round(steps / attempts),
              tokens,
              ms,
              ...(failures > 0 && firstError ? { error: firstError } : {}),
            },
            attempts,
            failedAttempts: failures,
            flaky: passedAttempts > 0 && failures > 0,
          })
        }
        const scored = await this.judgePair(
          task,
          runs.get('current')!.result,
          runs.get('candidate')!.result,
          judgeErrors,
          judgeUsage,
        )
        for (const variant of ['current', 'candidate'] as const) {
          const entry = runs.get(variant)!
          const result = entry.result
          samples.push({
            taskId: task.id,
            variant,
            ok: result.ok,
            steps: result.steps,
            tokens: result.tokens,
            ms: result.ms ?? 0,
            ...(entry.attempts > 1
              ? {
                  attempts: entry.attempts,
                  failedAttempts: entry.failedAttempts,
                  ...(entry.flaky ? { flaky: true } : {}),
                }
              : {}),
            ...(scored ? { judgeScore: scored[variant] } : {}),
            ...(result.error ? { error: result.error } : {}),
          })
        }
      }
    } finally {
      if (ownsRoot) await rm(root, { recursive: true, force: true })
    }
    const suite = summarizeSuite(options.tasks)
    const ceiling = assessCeiling(suite, samples, options.tasks)
    return {
      comparison: compareBenchmark(samples, {
        mustPassTaskIds: mustPassTaskIds(options.tasks),
      }),
      samples,
      judgeErrors,
      ...(judgeUsage.calls > 0 ? { judgeUsage } : {}),
      startedAt,
      finishedAt: new Date().toISOString(),
      currentProfileId: options.currentProfileId ?? null,
      suite,
      ceiling,
      upgrade: planSuiteUpgrade(suite, ceiling, options.tasks),
    }
  }

  /**
   * Blind A/B grading by the configured third-party judges. The order shown to
   * each judge alternates with the task index so a judge with a positional bias
   * does not consistently favour the same variant. A judge that fails is
   * reported, and the comparison simply falls back to objective outcomes.
   *
   * `usage` is an accumulator shared by every pair in one run, so the caller can
   * report what grading cost instead of only what it concluded.
   */
  private async judgePair(
    task: BenchmarkTask,
    current: TaskRunResult,
    candidate: TaskRunResult,
    errors: string[],
    usage: JudgeUsage,
  ): Promise<{ current: number; candidate: number } | null> {
    const panel = this.judges()
    if (panel.length === 0) return null
    if (!current.output && !candidate.output) return null
    const swap = task.id.length % 2 === 1
    const labelOf = (variant: BenchmarkVariant): 'A' | 'B' =>
      (variant === 'current') === !swap ? 'A' : 'B'
    const content = [
      `Task: ${task.prompt}`,
      '',
      `Transcript A (variant ${labelOf('current') === 'A' ? 'current' : 'candidate'}):`,
      (labelOf('current') === 'A' ? current : candidate).output?.slice(0, 4000) || '(no output)',
      '',
      `Transcript B (variant ${labelOf('current') === 'B' ? 'current' : 'candidate'}):`,
      (labelOf('current') === 'B' ? current : candidate).output?.slice(0, 4000) || '(no output)',
      '',
      'Return the JSON verdict now.',
    ].join('\n')
    const totals = { current: [] as number[], candidate: [] as number[] }
    await Promise.all(
      panel.map(async (judge) => {
        try {
          // A thinking judge streams reasoning for minutes before the verdict;
          // time out on silence, not on the total duration.
          const response = await completeWithWatchdog(
            judge.client,
            {
              messages: [
                { role: 'system', content: JUDGE_SYSTEM },
                { role: 'user', content },
              ],
              tools: [],
              temperature: 0.1,
            },
            { idleMs: this.judgeTimeoutMs, totalMs: JUDGE_TOTAL_TIMEOUT_MS },
          )
          const scores = parseJudgeScores(response.content)
          // Counted before parsing: a verdict that failed to parse was still billed.
          addJudgeUsage(usage, response.usage)
          if (!scores) {
            errors.push(`${judge.label}: ${unparsedResponseReason(response)}`)
            return
          }
          totals.current.push(labelOf('current') === 'A' ? scores.a : scores.b)
          totals.candidate.push(labelOf('candidate') === 'A' ? scores.a : scores.b)
        } catch (error) {
          // The request reached the endpoint, so it counts even without usage.
          addJudgeUsage(usage, undefined)
          errors.push(`${judge.label}: ${error instanceof Error ? error.message : '评分失败'}`)
        }
      }),
    )
    if (totals.current.length === 0) return null
    const mean = (values: number[]): number =>
      Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    return { current: mean(totals.current), candidate: mean(totals.candidate) }
  }
}
