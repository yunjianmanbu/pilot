/**
 * When a recorded benchmark may still gate an activation.
 *
 * A comparison is evidence about one pair of profiles measured against one
 * revision of the task library. As soon as any of those three changes — a new
 * candidate, a new active version, a new ruler — the numbers no longer describe
 * what is about to be enabled, and quoting them would claim a measurement that
 * was never taken.
 *
 * This lives in `shared` because both hosts need the same judgement: the main
 * process decides whether to reuse a stored comparison, and the activation gate
 * re-checks it before anything is enabled (a review computed under an older
 * ruler stays on disk with its old verdict, so trusting `activation.ready`
 * alone would let stale evidence through).
 *
 * The distinction the callers need: "no measurement at all" and "a measurement
 * that no longer applies" are different facts, and the second one has to say
 * *why* it was dropped — otherwise the panel tells the user they never measured
 * something they did measure.
 */
import type { ProfileComparison } from './types'

export interface ComparisonContext {
  /** Id of the profile that would be activated. */
  candidateId: string
  /** Id of the profile in force, or null when the workspace has none. */
  activeProfileId: string | null
  /** Current task-library revision. */
  suiteVersion: number
}

/**
 * Why a stored comparison can no longer be used, or undefined when it is still
 * valid. Undefined for an absent comparison too: there is nothing to explain.
 */
export function comparisonVoidReason(
  comparison: ProfileComparison | undefined,
  context: ComparisonContext,
): string | undefined {
  if (!comparison) return undefined
  if (!comparison.candidateId) return '这份实测没有记录是哪个候选版本量的'
  if (comparison.candidateId !== context.candidateId) return '已记录的实测不是这个版本量的'
  const compared = comparison.currentId
  if (compared === undefined) return '这份实测没有记录当时的基线版本'
  if (compared !== context.activeProfileId) {
    if (compared === null) return '这份实测的基线是「没有生效版本」，现在已经有生效版本了'
    if (context.activeProfileId === null) return '这份实测的基线是另一个版本，现在没有生效版本'
    return '实测时的基线与当前生效版本不是同一个'
  }
  if (comparison.suiteVersion === undefined) {
    return `这份实测没有记录题库版本，无法与当前题库 v${context.suiteVersion} 比较`
  }
  if (comparison.suiteVersion !== context.suiteVersion) {
    return `这份实测是在题库 v${comparison.suiteVersion} 上量的，当前题库是 v${context.suiteVersion}`
  }
  return undefined
}
