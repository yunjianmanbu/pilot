/**
 * The activation gate for evolved profiles.
 *
 * It is a hard gate, not a warning: `force` is only the user's override for a
 * rubric that did not pass. It cannot skip a missing or negative benchmark, a
 * missing deletion reason, a reviewer failure, or a protected-rule deletion.
 *
 * Both hosts apply it — the desktop IPC handler and the phone/server evolution
 * controls — so it must not live in either host.
 */
import type { ProfileVersion } from '../shared/types'
import { diffAddendum, isProtectedRule } from '../shared/profile-diff'
import { comparisonVoidReason } from '../shared/profile-evidence'
import { BENCHMARK_SUITE_VERSION } from '../main/agent/profile-benchmark-suite'

export function assertActivatable(
  current: ProfileVersion | null,
  candidate: ProfileVersion,
  force: boolean,
  failMessage: string,
): void {
  const protectedRules = diffAddendum(
    current?.promptAddendum ?? '',
    candidate.promptAddendum,
  ).removed.filter(isProtectedRule)
  if (protectedRules.length > 0) {
    throw new Error(
      `不能删除安全、审批、凭据、证据或验证规则：${protectedRules.join('；')}`,
    )
  }
  const review = candidate.review
  // Force overrides a rubric that did not pass. It does not override evidence:
  // a candidate that was never reviewed, or reviewed without replaying the
  // benchmark, has nothing that shows it is better than what is running.
  if (!review) {
    throw new Error('还没有完成独立评审，不能启用：请先评审并跑一次基准对比。')
  }
  if (!review.comparison) {
    throw new Error('缺少实测对比，不能启用：请先跑一次基准对比（这一项 force 不能跳过）。')
  }
  // The review is stored with the verdict it earned at the time. Once the pair
  // or the task library changes, those numbers describe a measurement that no
  // longer applies — re-checking here is what stops a stored "better" from
  // activating a candidate the old baseline never measured. `force` covers a
  // rubric score, never evidence.
  const voided = comparisonVoidReason(review.comparison, {
    candidateId: candidate.id,
    activeProfileId: current?.id ?? null,
    suiteVersion: BENCHMARK_SUITE_VERSION,
  })
  if (voided) {
    throw new Error(`旧实测已失效：${voided}。请重新跑一次实测对比（这一项 force 不能跳过）。`)
  }
  const blocking = (review.activation?.reasons ?? []).filter(
    (reason) => reason !== '独立评审未通过',
  )
  if (blocking.length > 0) {
    throw new Error(`还不能启用：${blocking.join('；')}`)
  }
  if (!review.pass && !force) throw new Error(failMessage)
}
