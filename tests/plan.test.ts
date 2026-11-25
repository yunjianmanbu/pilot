import { describe, expect, it } from 'vitest'
import { planCarriesOver, settlePlan, shouldResetPlan } from '../src/main/agent/plan'
import type { Plan } from '../src/shared/types'

function plan(): Plan {
  return {
    goal: 'Ship the feature',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [
      { id: 'plan-1', text: 'Inspect the code', status: 'done' },
      { id: 'plan-2', text: 'Implement the fix', status: 'in_progress' },
      { id: 'plan-3', text: 'Run tests', status: 'pending' },
    ],
  }
}

describe('shouldResetPlan', () => {
  it('drops the previous plan when a new user instruction starts', () => {
    expect(shouldResetPlan({ plan: plan(), userMessage: { control: false } })).toBe(true)
  })

  it('keeps the plan for continuation runs marked as control messages', () => {
    expect(shouldResetPlan({ plan: plan(), userMessage: { control: true } })).toBe(false)
    // A steering follow-up inside the same task has no stored user message.
    expect(shouldResetPlan({ plan: plan(), userMessage: null })).toBe(false)
  })

  it('has nothing to reset without a plan or inside a review session', () => {
    expect(shouldResetPlan({ plan: null, userMessage: { control: false } })).toBe(false)
    expect(
      shouldResetPlan({
        plan: { goal: '', updatedAt: '2026-01-01T00:00:00.000Z', items: [] },
        userMessage: { control: false },
      }),
    ).toBe(false)
    expect(
      shouldResetPlan({ plan: plan(), isReview: true, userMessage: { control: false } }),
    ).toBe(false)  })

  it('treats only real user turns as new turns', () => {
    const message = { control: false }
    expect(planCarriesOver(message)).toBe(false)
    expect(planCarriesOver(undefined)).toBe(true)
  })
})

describe('settlePlan', () => {
  it('marks the active item done when the run completed', () => {
    const original = plan()
    const result = settlePlan(original, 'completed', '2026-01-02T00:00:00.000Z')

    expect(result).not.toBeNull()
    expect(result?.items.map((item) => item.status)).toEqual(['done', 'done', 'pending'])
    expect(result?.updatedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(original.items[1]?.status).toBe('in_progress')
  })

  it('returns the active item to pending when the run did not complete', () => {
    for (const status of ['failed', 'cancelled', 'interrupted', 'max_steps'] as const) {
      const result = settlePlan(plan(), status, '2026-01-02T00:00:00.000Z')
      expect(result?.items.map((item) => item.status)).toEqual(['done', 'pending', 'pending'])
    }
  })

  it('leaves a plan without an active item untouched', () => {
    const finished: Plan = {
      goal: 'Done',
      updatedAt: '2026-01-01T00:00:00.000Z',
      items: [{ id: 'plan-1', text: 'Only item', status: 'done' }],
    }
    expect(settlePlan(finished, 'completed', '2026-01-02T00:00:00.000Z')).toBeNull()
  })

  it('keeps the active item pending when a batch run must not infer done', () => {
    // Five tasks in one turn: answering after finishing two of them is a real
    // outcome, and marking the third done would report work that never happened.
    const result = settlePlan(plan(), 'completed', '2026-01-02T00:00:00.000Z', {
      inferDone: false,
    })

    expect(result?.items.map((item) => item.status)).toEqual(['done', 'pending', 'pending'])
  })

  it('still infers done when inferDone is left at its default', () => {
    const result = settlePlan(plan(), 'completed', '2026-01-02T00:00:00.000Z', {
      inferDone: true,
    })
    expect(result?.items.map((item) => item.status)).toEqual(['done', 'done', 'pending'])
  })
})
