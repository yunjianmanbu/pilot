import type {
  JudgeUsage,
  ProfileComparison,
  ProfileJudgeVerdict,
  ProfileReview,
  ProfileRuleRemoval,
} from '../../../shared/types'
import { normalize, similarity } from '../../../shared/profile-diff'
import { coerceScore, coerceTrue, extractJsonObject as extractJson } from '../json'
import { costRegression } from '../profile-benchmark'
import type { ModelClient } from '../loop'
import { scrub } from './evidence'

export interface ProfileJudge {
  id: string
  label: string
  model: string
  /** True when the endpoint or model differs from the execution model. */
  external: boolean
  client: ModelClient
}

/** Injectable benchmark for tests and for callers that measured out of band. */
export type ReviewComparisonProvider = (
  scope: 'workspace' | 'global',
  workspacePath: string,
  profileId: string,
) => Promise<ProfileComparison | undefined>

export function judgeVerdict(
  judge: ProfileJudge,
  content: string,
  gate: { passScore: number; minRuns: number },
  evidenceRuns: number,
): ProfileJudgeVerdict | null {
  const parsed = extractJson(content)
  if (!parsed) return null
  const score = coerceScore(parsed['score']) ?? 0
  const risks = Array.isArray(parsed['risks'])
    ? parsed['risks']
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 8)
        .map((risk) => scrub(risk, 300))
    : []
  const removals = Array.isArray(parsed['removals'])
    ? (parsed['removals'] as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 40)
        .map((item) => {
          const rule =
            typeof item['rule'] === 'string'
              ? item['rule']
              : typeof item['text'] === 'string'
                ? item['text']
                : ''
          return {
            rule: scrub(rule, 1_200),
            justified: item['justified'] === true,
            reason: typeof item['reason'] === 'string' ? scrub(item['reason'], 1_000) : '',
          }
        })
        .filter((item) => item.rule.trim().length > 0)
    : []
  return {
    id: judge.id,
    label: judge.label,
    model: judge.model,
    external: judge.external,
    score: Math.round(score),
    pass: coerceTrue(parsed['pass']) && score >= gate.passScore && evidenceRuns >= gate.minRuns,
    notes: typeof parsed['notes'] === 'string' ? scrub(parsed['notes'], 2_000) : '',
    risks,
    ...(removals.length > 0 ? { removals } : {}),
  }
}

export interface JudgePanel {
  judges: ProfileJudge[]
  verdicts: ProfileJudgeVerdict[]
  errors: string[]
  /** Spend of every judge request in this panel, including the ones that failed. */
  usage: JudgeUsage
}

/**
 * One review record for the whole panel. Every configured reviewer has to pass
 * and no reviewer may fail: a single working model must not activate a profile
 * the others rejected, and an unreachable reviewer blocks instead of abstaining.
 */
function sameRule(left: string, right: string): boolean {
  return normalize(left) === normalize(right) || similarity(left, right) >= 0.75
}

/**
 * Aggregate every reviewer's rationale for every deleted rule. A missing
 * entry, an empty reason or one rejection makes the whole removal unjustified.
 * The caller turns that into an activation block; it can never be waved through
 * by a high rubric score.
 */
function summarizeRemovals(
  panel: JudgePanel,
  removedRules: string[],
): ProfileRuleRemoval[] {
  return removedRules.map((rule) => {
    const entries = panel.verdicts.map((verdict) => {
      const found = verdict.removals?.find((entry) => sameRule(entry.rule, rule))
      return { verdict, found }
    })
    const covered = entries.filter(
      (entry) => entry.found && entry.found.justified && entry.found.reason.trim().length > 0,
    )
    const reason = entries
      .map(({ verdict, found }) =>
        found
          ? `${verdict.label}: ${found.reason.trim() || '未说明理由'}`
          : `${verdict.label}: 未说明理由`,
      )
      .join('；')
    return {
      rule,
      justified: entries.length > 0 && covered.length === entries.length,
      reason: reason || '评审没有覆盖这条删除。',
      judges: covered.map((entry) => entry.verdict.label),
    }
  })
}

/**
 * Suggestion recorded when the review was a self-check. It never changes the
 * verdict: a profile reviewed by its own run model still scores, it just stops
 * being called independent and the user gets the one setting that fixes it.
 */
function independenceAdvice(judges: ProfileJudge[]): string {
  const fallbackOnly = judges.length === 1 && judges[0]?.id === 'default'
  return fallbackOnly
    ? '还没有配置评估模型，这次评审由会话模型自评；建议在设置里添加一个不同来源的评估模型后再评审。'
    : '评估模型与会话模型同源，这次评审等同于自评；建议换一个不同来源的评估模型后再评审。'
}

export function summarizeReview(
  panel: JudgePanel,
  fallback: { pass: string; fail: string },
  removedRules: string[] = [],
  baselineVersion?: number,
): ProfileReview {
  const removals = summarizeRemovals(panel, removedRules)
  const removalsPass = removals.every((entry) => entry.justified)
  const pass =
    panel.errors.length === 0 &&
    panel.verdicts.every((verdict) => verdict.pass) &&
    removalsPass
  const score = Math.round(Math.min(...panel.verdicts.map((verdict) => verdict.score)))
  const baseNotes =
    panel.verdicts.length === 1
      ? panel.verdicts[0]!.notes || (pass ? fallback.pass : fallback.fail)
      : [...panel.verdicts]
          .sort((a, b) => a.score - b.score)
          .map((verdict) => `${verdict.label}（${verdict.score}）: ${verdict.notes}`)
          .join('\n')
  const removalNotes =
    removals.length > 0
      ? `\n删除规则：${removals
          .map((entry) => `${entry.justified ? '有理由' : '缺少理由'}（${entry.rule.slice(0, 80)}）`)
          .join('；')}`
      : ''
  const notes = `${baseNotes}${removalNotes}`
  const risks = Array.from(new Set(panel.verdicts.flatMap((verdict) => verdict.risks))).slice(0, 8)
  const independent = panel.verdicts.every((verdict) => verdict.external)
  // Recorded first so a long rubric risk list cannot push the suggestion away.
  if (!independent) risks.unshift(independenceAdvice(panel.judges))
  if (!removalsPass) {
    risks.push('有旧规则被删除但没有得到每位评审的明确理由，不能自动切换。')
  }
  return {
    score,
    pass,
    notes: scrub(notes, 2_000),
    risks: risks.slice(0, 8),
    at: new Date().toISOString(),
    model: scrub(panel.judges.map((judge) => judge.model).join(' + '), 300),
    independent,
    judges: panel.verdicts,
    ...(baselineVersion !== undefined ? { baselineVersion } : {}),
    ...(removals.length > 0 ? { removals } : {}),
    ...(panel.errors.length > 0 ? { judgeErrors: panel.errors } : {}),
    // Cost stays visible next to the verdict it paid for, so a review that spent
    // four judge calls cannot read like a single cheap check.
    ...(panel.usage.calls > 0 ? { judgeUsage: panel.usage } : {}),
  }
}

/**
 * Fold a paired benchmark into the review record. A benchmark that was run and
 * lost blocks activation regardless of the rubric score; a benchmark that was
 * run and won is quoted as evidence; one that could not decide is reported as
 * such and left to the reviewer, so a tiny sample never silently decides.
 */
export function applyComparison(
  review: ProfileReview,
  comparison?: ProfileComparison,
): ProfileReview {
  if (!comparison) return review
  const label =
    comparison.verdict === 'better'
      ? '实测更优'
      : comparison.verdict === 'worse'
        ? '实测更差'
        : comparison.verdict === 'inconclusive'
          ? '实测无显著差异'
          : '实测样本不足'
  const cost = costRegression(comparison.current, comparison.candidate)
  const lines = [
    `${label}：候选 ${comparison.wins} 胜 / ${comparison.losses} 负 / ${comparison.ties} 平（共 ${comparison.tasks} 组）`,
    ...comparison.reasons,
    ...(cost ? [`成本/时长：${cost}`] : []),
  ]
  const risks = new Set(review.risks)
  if (comparison.verdict === 'worse') risks.add('实测能力下降')
  // A large cost increase is a risk on the review card, not a veto on its own:
  // `compareBenchmark` already downgrades a marginal win past the ceilings.
  if (cost && comparison.verdict !== 'better') risks.add('成本或时长明显上升')
  return {
    ...review,
    pass: review.pass && comparison.verdict !== 'worse',
    notes: scrub(`${lines.join('；')}\n${review.notes}`, 2_000),
    risks: Array.from(risks).slice(0, 8),
    comparison,
  }
}

/**
 * The final switch decision. Rubric review, deletion rationale and measured
 * behaviour are separate gates; a candidate must clear all three and the
 * measured result must be a clear win. A tie is not enough to replace the
 * version that is already running.
 */
export function applyActivationGate(
  review: ProfileReview,
  comparison: ProfileComparison | undefined,
  extraReasons: string[] = [],
  /** Why a stored comparison was dropped as evidence; only read when there is
   * no comparison, so "never measured" and "measured under an old ruler" stop
   * reading as the same sentence. */
  voidedReason?: string,
): ProfileReview {
  const reasons: string[] = []
  if (!review.pass) reasons.push('独立评审未通过')
  if (review.judgeErrors && review.judgeErrors.length > 0) {
    reasons.push('有评审模型没有返回结果')
  }
  if (review.removals?.some((entry) => !entry.justified)) {
    reasons.push('删除旧规则缺少评审理由')
  }
  if (!comparison) {
    reasons.push(
      voidedReason
        ? `旧实测已失效：${voidedReason}；请重新跑一次实测对比`
        : '尚未与当前版本完成实测对比',
    )
  } else if (comparison.verdict === 'worse') {
    reasons.push('实测比当前版本更差')
  } else if (comparison.verdict === 'inconclusive') {
    reasons.push('实测没有明显优于当前版本')
  } else if (comparison.verdict === 'insufficient') {
    reasons.push('实测样本不足，无法证明更好')
  }
  const cost = comparison ? costRegression(comparison.current, comparison.candidate) : undefined
  if (cost && comparison && comparison.verdict !== 'better') {
    reasons.push('成本或时长明显上升')
  }
  for (const reason of extraReasons) {
    if (reason.trim()) reasons.push(reason.trim())
  }
  const unique = Array.from(new Set(reasons))
  return {
    ...review,
    activation: { ready: unique.length === 0, reasons: unique },
  }
}
