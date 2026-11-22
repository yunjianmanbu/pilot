import type {
  EvolutionCycle,
  PersonalContribution,
  PersonalVersion,
  ProfileReview,
  ProfileVersion,
} from '../../../../shared/types'

import { t } from '../../i18n'

/** How many ranked rounds the evolution history shows before "show all". */
export const HISTORY_PREVIEW = 20

export const STATUS_LABELS: Record<string, string> = {
  completed: t("完成"),
  failed: t("失败"),
  cancelled: t("取消"),
  interrupted: t("中断"),
  paused: t("已暂停"),
  max_steps: t("步数上限"),
  running: t("运行中"),
}

/** Reasons that block activation even when the user asks to enable anyway. */
export function gateReasons(review: ProfileReview | undefined): string[] {
  return (review?.activation?.reasons ?? []).filter(
    (reason) => reason !== '独立评审未通过',
  )
}

/**
 * True when the gate would actually let this version through. Reviews written
 * before `activation` existed fall back to what the gate itself demands — a
 * pass plus the measured comparison it refuses to go without. Falling back to
 * the rubric alone rendered an enable button that failed on every click.
 */
export function isReady(review: ProfileReview | undefined): boolean {
  if (!review) return false
  if (review.activation) return review.activation.ready
  return review.pass && Boolean(review.comparison)
}

/** `force` only overrides the rubric verdict; it never replaces a measurement. */
export function canForce(review: ProfileReview | undefined): boolean {
  return Boolean(review?.comparison && !review.pass && gateReasons(review).length === 0)
}

/** True when activation is blocked only because nothing was measured yet. */
export function needsMeasurement(review: ProfileReview | undefined): boolean {
  return !review?.comparison
}

export function scoreTone(score: number): string {
  if (score >= 85) return 'excellent'
  if (score >= 75) return 'pass'
  if (score >= 60) return 'warn'
  return 'bad'
}

export function sourceLabel(source: ProfileVersion['source']): string {
  if (source === 'self') return t("Pilot 提出")
  if (source === 'promoted') return t("由工作区提升")
  return t("用户创建")
}

/** True when the profile still has English text worth converting. */
export function needsChinese(profile: ProfileVersion): boolean {
  for (const text of [profile.promptAddendum, profile.rationale]) {
    let hasLatin = false
    let hasCjk = false
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0
      if (code >= 0x3400 && code <= 0x9fff) hasCjk = true
      else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) hasLatin = true
    }
    if (hasLatin && !hasCjk) return true
  }
  return false
}

export function changeSummary(files: PersonalVersion['files']): string {
  const added = files.filter((file) => file.status === 'added').length
  const modified = files.filter((file) => file.status === 'modified').length
  const deleted = files.filter((file) => file.status === 'deleted').length
  return t("新增 {v1} · 修改 {v2} · 删除 {v3}", {
    v1: added,
    v2: modified,
    v3: deleted,
  })
}

export function contributionStatusLabel(status: PersonalContribution['status']): string {
  if (status === 'uploaded') return t("已提交")
  if (status === 'failed') return t("上传失败")
  return t("待发送")
}

export function stageLabel(key: EvolutionCycle['stages'][number]['key']): string {
  if (key === 'evidence') return t("收集证据")
  if (key === 'propose') return t("提出改进")
  if (key === 'review') return t("独立评审")
  if (key === 'apply') return t("应用或保留")
  return t("回归观察")
}

export function cycleTone(status: EvolutionCycle['status']): string {
  if (status === 'completed') return 'pass'
  if (status === 'rejected') return 'warn'
  return 'bad'
}
