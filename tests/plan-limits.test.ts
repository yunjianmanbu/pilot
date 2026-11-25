import { describe, expect, it } from 'vitest'
import { PLAN_ITEM_LIMIT } from '../src/shared/plan-limits'
import { sanitizePlan } from '../src/main/store-schema'
import { runPlanTool } from '../src/main/agent/tools/plan'
import { UPDATE_PLAN } from '../src/main/agent/tools/spec'
import type { ToolHost } from '../src/main/agent/tools/spec'
import type { PlanItem } from '../src/shared/types'

function items(count: number): Array<{ text: string; status: string }> {
  return Array.from({ length: count }, (_, index) => ({
    text: `item ${index + 1}`,
    status: 'pending',
  }))
}

describe('plan item limit', () => {
  it('keeps the valve at a named value instead of a literal in two files', () => {
    // Both the tool and the store used to write 12 inline. The number itself is
    // a runaway valve (the advice to the model is "Keep 2-8 items"), so this
    // assertion exists to make a future change land in one place.
    expect(PLAN_ITEM_LIMIT).toBe(12)
  })

  it('truncates a long plan identically in update_plan and in the store', async () => {
    let saved: { goal: string; items: PlanItem[] } | null = null
    const host = {
      updatePlan: (update: { goal: string; items: PlanItem[] }) => {
        saved = update
      },
    } as unknown as ToolHost

    const result = await runPlanTool(
      UPDATE_PLAN,
      { goal: 'g', items: items(PLAN_ITEM_LIMIT + 3) },
      host,
      new AbortController().signal,
    )

    expect(result?.ok).toBe(true)
    expect(saved).not.toBeNull()
    const accepted = (saved as { goal: string; items: PlanItem[] } | null)?.items ?? []
    expect(accepted.length).toBe(PLAN_ITEM_LIMIT)

    // A stored plan must not lose anything the tool already accepted: a mismatch
    // here would mean the tool reported items the history silently dropped.
    const stored = sanitizePlan({ goal: 'g', items: accepted })
    expect(stored?.items.length).toBe(PLAN_ITEM_LIMIT)
    expect(stored?.items.map((item) => item.text)).toEqual(accepted.map((item) => item.text))
  })
})
