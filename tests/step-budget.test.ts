import { describe, expect, it } from 'vitest'
import {
  HARD_CEILING_MAX,
  STEPS_PER_ITEM_FLOOR,
  UNLIMITED_STEPS_FALLBACK,
  canExtend,
  countRequestedTasks,
  createProgressState,
  extendLimit,
  needsItemRotation,
  noteStepObservations,
  planStepBudget,
  shouldStallCloseOut,
} from '../src/shared/step-budget'

const FIVE_TASKS = `1、排查整个代码，不要再出现类似问题
2、设置里要有运行日志入口
3、每个会话能看到卡在哪个节点
4、生成架构图与排查说明
5、设置里加超级 pilot 入口`

describe('countRequestedTasks', () => {
  it('counts numbered lines in a multi-task instruction', () => {
    expect(countRequestedTasks(FIVE_TASKS)).toBe(5)
  })

  it('counts circled numbers and project bullets', () => {
    expect(countRequestedTasks('① 修 A\n② 修 B\n③ 修 C')).toBe(3)
    expect(countRequestedTasks('- 修 A\n- 修 B')).toBe(2)
    expect(countRequestedTasks('(1) 修 A\n(2) 修 B')).toBe(2)
  })

  it('counts tasks chained on a single line', () => {
    expect(countRequestedTasks('1、修 A；2、修 B；3、修 C')).toBe(3)
  })

  it('treats a plain sentence as one task', () => {
    expect(countRequestedTasks('把设置页拉宽一点')).toBe(1)
    expect(countRequestedTasks('')).toBe(1)
  })

  it('ignores marker-only lines and caps the count', () => {
    expect(countRequestedTasks('1、\n2、修 A\n3、修 B')).toBe(2)
    const many = Array.from({ length: 30 }, (_unused, index) => `${index + 1}、任务`).join('\n')
    expect(countRequestedTasks(many)).toBe(20)
  })
})

describe('planStepBudget', () => {
  it('raises the ceiling for a multi-task instruction above the configured default', () => {
    const budget = planStepBudget({ prompt: FIVE_TASKS, configured: 200 })
    expect(budget.taskCount).toBe(5)
    expect(budget.ceiling).toBeGreaterThan(200)
    expect(budget.initial).toBeLessThan(budget.ceiling)
    expect(budget.extension).toBeGreaterThan(0)
  })

  it('leaves a single-task request at the configured ceiling', () => {
    const budget = planStepBudget({ prompt: '把设置页拉宽一点', configured: 200 })
    expect(budget.taskCount).toBe(1)
    expect(budget.ceiling).toBe(200)
  })

  it('treats configured 0 as "no user cap" but keeps a safety valve', () => {
    const single = planStepBudget({ prompt: '修一下', configured: 0 })
    expect(single.ceiling).toBe(UNLIMITED_STEPS_FALLBACK)
    const many = planStepBudget({ prompt: FIVE_TASKS, configured: 0 })
    expect(many.ceiling).toBe(UNLIMITED_STEPS_FALLBACK)
    expect(many.ceiling).toBeLessThanOrEqual(HARD_CEILING_MAX)
  })

  it('keeps review fixed and analysis tight', () => {
    const review = planStepBudget({ prompt: FIVE_TASKS, configured: 400, review: true })
    expect(review.extension).toBe(0)
    expect(review.initial).toBe(review.ceiling)
    expect(review.ceiling).toBeLessThanOrEqual(120)

    const analysis = planStepBudget({ prompt: FIVE_TASKS, configured: 400, analysis: true })
    expect(analysis.ceiling).toBeLessThanOrEqual(160)
    expect(analysis.initial).toBeLessThanOrEqual(analysis.ceiling)
  })

  it('uses existing plan items as a task-count floor', () => {
    const budget = planStepBudget({ prompt: '继续', configured: 200, planItems: 4 })
    expect(budget.taskCount).toBe(4)
  })
})

describe('progress detection', () => {
  it('flags a step with unseen output as progress', () => {
    const state = createProgressState()
    const first = noteStepObservations(state, [
      { name: 'read_file', args: '{"path":"a.ts"}', output: 'one' },
    ])
    expect(first.progress).toBe(true)
    expect(first.streak).toBe(0)
  })

  it('accumulates a stall streak when the same read repeats verbatim', () => {
    const state = createProgressState()
    const observation = { name: 'read_file', args: '{"path":"a.ts"}', output: 'same' }
    noteStepObservations(state, [observation])
    noteStepObservations(state, [observation])
    const third = noteStepObservations(state, [observation])
    expect(third.progress).toBe(false)
    expect(third.streak).toBe(2)
  })

  it('counts a retry that fails differently as progress', () => {
    const state = createProgressState()
    noteStepObservations(state, [{ name: 'run_command', args: '{"command":"x"}', output: 'EACCES' }])
    const second = noteStepObservations(state, [
      { name: 'run_command', args: '{"command":"x"}', output: 'ENOENT' },
    ])
    expect(second.progress).toBe(true)
    expect(second.streak).toBe(0)
  })

  it('resets the streak once new evidence arrives', () => {
    const state = createProgressState()
    const observation = { name: 'read_file', args: '{}', output: 'same' }
    noteStepObservations(state, [observation])
    noteStepObservations(state, [observation])
    expect(state.streak).toBe(1)
    noteStepObservations(state, [{ name: 'read_file', args: '{"path":"b.ts"}', output: 'new' }])
    expect(state.streak).toBe(0)
  })
})

describe('extension and close-out', () => {
  it('extends only while there is progress and never past the ceiling', () => {
    const budget = planStepBudget({ prompt: FIVE_TASKS, configured: 200 })
    const state = createProgressState()
    noteStepObservations(state, [{ name: 'read_file', args: '{}', output: 'fresh' }])

    let limit = budget.initial
    expect(canExtend(state, budget, limit)).toBe(true)
    for (let guard = 0; guard < 100; guard += 1) {
      limit = extendLimit(limit, budget)
    }
    expect(limit).toBe(budget.ceiling)
    expect(canExtend(state, budget, limit)).toBe(false)
  })

  it('refuses to extend when the last step produced nothing new', () => {
    const budget = planStepBudget({ prompt: FIVE_TASKS, configured: 200 })
    const state = createProgressState()
    const observation = { name: 'read_file', args: '{}', output: 'same' }
    noteStepObservations(state, [observation])
    noteStepObservations(state, [observation])
    expect(canExtend(state, budget, budget.initial)).toBe(false)
  })

  it('asks for a close-out only after the stall threshold', () => {
    const budget = planStepBudget({ prompt: FIVE_TASKS, configured: 200 })
    const state = createProgressState()
    const observation = { name: 'read_file', args: '{}', output: 'same' }
    // First sight of a result counts as progress (streak 0), so the threshold is
    // reached one step after that.
    noteStepObservations(state, [observation])
    for (let index = 1; index < budget.stallAfter; index += 1) {
      noteStepObservations(state, [observation])
      expect(shouldStallCloseOut(state, budget)).toBe(false)
    }
    noteStepObservations(state, [observation])
    expect(shouldStallCloseOut(state, budget)).toBe(true)
  })

  it('never closes out on a stall when the budget disables it', () => {
    const review = planStepBudget({ prompt: 'review', configured: 200, review: true })
    const state = createProgressState()
    state.streak = 50
    expect(shouldStallCloseOut(state, review)).toBe(false)
  })
})

describe('needsItemRotation', () => {
  it('warns when the remaining steps cannot cover one floor per open item', () => {
    // Three items still open but only two floors of steps left: at least one of
    // them would never be started, which splitting into turns cannot happen.
    expect(needsItemRotation({ openItems: 3, stepsLeft: STEPS_PER_ITEM_FLOOR * 2 })).toBe(true)
  })

  it('stays quiet while every open item still has room', () => {
    expect(needsItemRotation({ openItems: 3, stepsLeft: STEPS_PER_ITEM_FLOOR * 3 })).toBe(false)
    expect(needsItemRotation({ openItems: 1, stepsLeft: 4 })).toBe(false)
  })

  it('does not warn without a second item or without any steps left', () => {
    expect(needsItemRotation({ openItems: 0, stepsLeft: 0 })).toBe(false)
    expect(needsItemRotation({ openItems: 2, stepsLeft: 0 })).toBe(false)
    expect(needsItemRotation({ openItems: Number.NaN, stepsLeft: 5 })).toBe(false)
  })

  it('keeps a five-task run quiet until the last third of its ceiling', () => {
    const budget = planStepBudget({ prompt: FIVE_TASKS, configured: 200 })
    // Early in the run the leftover ceiling covers all five items with room to
    // spare, so no rotation notice is emitted.
    expect(needsItemRotation({ openItems: 5, stepsLeft: budget.ceiling - 10 })).toBe(false)
    expect(needsItemRotation({ openItems: 5, stepsLeft: 20 })).toBe(true)
  })
})
