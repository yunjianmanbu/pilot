import type { Plan } from '../../../../shared/types'
import { CheckIcon, ChevronIcon, ListCheckIcon } from '../../icons'
import { t } from '../../i18n'

/** Collapsed plan snapshot attached to a finished turn's final answer. */
export function TurnPlan({ plan }: { plan: Plan }) {
  const { done } = planRows(plan, false, false)
  return (
    <details className="turn-plan">
      <summary>
        <span className="plan-badge">{t("本轮计划")}</span>
        <span className="plan-goal">{plan.goal || t("本轮任务")}</span>
        <span className="plan-progress">
          {done}/{plan.items.length}
        </span>
        <span className="turn-plan-toggle">{t("查看")}</span>
        <ChevronIcon width={13} height={13} className="plan-chevron" />
      </summary>
      <PlanItems plan={plan} running={false} settled={false} />
    </details>
  )
}

function planRows(plan: Plan, running: boolean, settled: boolean) {
  const items = plan.items.map((item) => {
    const isDone = item.status === 'done' || (settled && item.status === 'in_progress')
    const isActive = item.status === 'in_progress' && running
    return {
      item,
      isDone,
      isActive,
      className: isDone ? 'is-done' : isActive ? 'is-in_progress' : 'is-pending',
    }
  })
  return { items, done: items.filter((entry) => entry.isDone).length }
}

function PlanItems({ plan, running, settled }: { plan: Plan; running: boolean; settled: boolean }) {
  const { items } = planRows(plan, running, settled)
  return (
    <ol className="plan-items">
      {items.map(({ item, isDone, isActive, className }) => (
        <li key={item.id} className={`plan-item ${className}`}>
          <span className="plan-check">
            {isDone ? (
              <CheckIcon width={11} height={11} />
            ) : isActive ? (
              <i className="spinner tiny" />
            ) : (
              <i className="plan-circle" />
            )}
          </span>
          <span>{item.text}</span>
        </li>
      ))}
    </ol>
  )
}

export function PlanPanel({
  plan,
  running,
  settled,
}: {
  plan: Plan
  running: boolean
  settled: boolean
}) {
  const { done } = planRows(plan, running, settled)

  return (
    <details className="plan-panel">
      <summary>
        <span className="plan-badge">
          <ListCheckIcon width={12} height={12} />
          {t("计划")}
        </span>
        <span className="plan-goal">{plan.goal || t("当前任务")}</span>
        <span className="plan-progress">
          {done}/{plan.items.length}
        </span>
        <ChevronIcon width={13} height={13} className="plan-chevron" />
      </summary>
      <PlanItems plan={plan} running={running} settled={settled} />
    </details>
  )
}
