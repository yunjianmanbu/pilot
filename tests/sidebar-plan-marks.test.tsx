import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlanMarks } from '../src/renderer/src/components/Sidebar'
import type { Plan, PlanItem } from '../src/shared/types'

function plan(...statuses: PlanItem['status'][]): Plan {
  return {
    goal: '把耗时优化落地',
    items: statuses.map((status, index) => ({
      id: `p${index + 1}`,
      text: `步骤内容 ${index + 1}`,
      status,
    })),
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** The digits rendered in the row, in order. */
function digits(html: string): string[] {
  return [...html.matchAll(/<i class="[^"]*">(\d+)<\/i>/g)].map((match) => match[1])
}

describe('session list plan marks', () => {
  it('renders the step numbers only, never the item text', () => {
    const html = renderToStaticMarkup(
      <PlanMarks plan={plan('done', 'in_progress', 'pending')} running />,
    )
    expect(digits(html)).toEqual(['1', '2', '3'])
    expect(html).not.toContain('步骤内容')
  })

  it('maps each state to its own colour class', () => {
    const html = renderToStaticMarkup(<PlanMarks plan={plan('done', 'pending')} running={false} />)
    expect(html).toContain('class="session-plan-num is-done"')
    expect(html).toContain('class="session-plan-num is-pending"')
    expect(html).not.toContain('is-live')
  })

  it('only pulses the active number while the run is going', () => {
    const active = renderToStaticMarkup(<PlanMarks plan={plan('in_progress', 'pending')} running />)
    expect(active).toContain('session-plan-num is-in_progress is-live')
    const settled = renderToStaticMarkup(
      <PlanMarks plan={plan('in_progress', 'pending')} running={false} />,
    )
    expect(settled).toContain('class="session-plan-num is-in_progress"')
    expect(settled).not.toContain('is-live')
  })

  it('summarises the tail of a long plan instead of clipping it', () => {
    const html = renderToStaticMarkup(
      <PlanMarks
        plan={plan('done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'pending')}
        running
      />,
    )
    expect(digits(html)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    expect(html).toContain('class="session-plan-more">+1</i>')
  })

  it('reports progress in the accessible label and renders nothing without items', () => {
    const html = renderToStaticMarkup(<PlanMarks plan={plan('done', 'done', 'pending')} running />)
    expect(html).toContain('aria-label="计划 2/3 完成"')
    expect(renderToStaticMarkup(<PlanMarks plan={plan()} running />)).toBe('')
  })
})
