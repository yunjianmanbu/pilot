import { t } from '../i18n'
import { formatClock } from '../ui'

/**
 * First line of an expanded execution step: the wall-clock moment it ran.
 * Renders nothing when the step has no recorded time, so old transcripts and
 * blocks built from grouped arrays stay unchanged.
 */
export function ProcessTime({ at }: { at?: string }) {
  const clock = formatClock(at)
  if (!clock) return null
  return <div className="process-time">{t("执行时间 {v1}", { v1: clock })}</div>
}
