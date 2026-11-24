import { useEffect, useState } from 'react'
import { runElapsedLabel } from '../ui'
import { t } from '../i18n'

/**
 * The topbar "running" pill.
 *
 * A long task that has not failed and has not finished still owes the user a
 * sign of life, so the pill carries two progress signals: the step number that
 * changes as work advances, and a clock that keeps counting even while the
 * model thinks without calling a tool. The ticker lives here, not in App, so a
 * one-second update re-renders this pill instead of the whole transcript.
 */
export function RunningPill({
  startedAt,
  step,
}: {
  /** Milliseconds since the run started; absent when only the flag is known. */
  startedAt?: number | undefined
  /** Current step of the run, when the live state has one. */
  step?: number | undefined
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  const elapsed = runElapsedLabel(startedAt, now)
  return (
    <span className="running-pill" title={t("任务执行中，仍在工作")}>
      <i className="live-dot" />
      {t("执行中")}
      {step ? <span className="running-elapsed">{t("第 {v1} 步", { v1: step })}</span> : null}
      {elapsed ? <span className="running-elapsed">{elapsed}</span> : null}
    </span>
  )
}
