import type { Plan, PlanItem, RunStatus } from '../../shared/types'

/**
 * Decide whether the plan left by the previous turn belongs to the run that is
 * about to start.
 *
 * A run that begins with a real user instruction opens a new turn: the earlier
 * plan is history, already snapshotted on that turn's final answer, so keeping
 * it on the session made the panel show the last plan for an instruction that
 * produced none (and made the soft plan gate think this turn had planned
 * already). Continuation runs — pause/resume and the auto-continue of an
 * unfinished plan — carry it forward, which is why their stored user message is
 * marked as control. A queued task typed earlier is a new instruction, so it
 * starts from a clean plan too.
 */
export function planCarriesOver(userMessage: { control?: boolean } | null | undefined): boolean {
  return !userMessage || userMessage.control === true
}

/**
 * Whether the run about to start must drop the session-level plan first.
 *
 * Only a new user turn with a plan in place resets it; a review session keeps
 * its plan because the review prompt is built from it, and a run with no plan
 * has nothing to drop.
 */
export function shouldResetPlan(input: {
  plan: Plan | null
  isReview?: boolean
  userMessage: { control?: boolean } | null | undefined
}): boolean {
  const { plan } = input
  if (!plan || plan.items.length === 0) return false
  if (input.isReview) return false
  return !planCarriesOver(input.userMessage)
}

/**
 * A run can finish while the model still has one item marked in_progress:
 * the final answer usually arrives without another update_plan call.
 * Persist a terminal state so the UI never keeps spinning after the run ends.
 *
 * Single-task runs settle the active item as done — one task, one answer, the
 * answer is the evidence. A multi-task run must **not** inherit that inference:
 * the model can answer after finishing two of five items, and turning the third
 * item's in_progress into done would show the user more work than actually
 * happened. Those items go back to pending so the panel (and the auto-continue
 * that watches for unfinished plan items) still sees them as open work.
 */
export function settlePlan(
  plan: Plan,
  status: RunStatus,
  updatedAt: string,
  options: { inferDone?: boolean } = {},
): Plan | null {
  if (!plan.items.some((item) => item.status === 'in_progress')) return null
  const fallback: PlanItem['status'] =
    status === 'completed' && options.inferDone !== false ? 'done' : 'pending'
  return {
    ...plan,
    items: plan.items.map((item) =>
      item.status === 'in_progress' ? { ...item, status: fallback } : item,
    ),
    updatedAt,
  }
}
