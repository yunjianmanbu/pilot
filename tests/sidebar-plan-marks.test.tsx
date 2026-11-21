import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { PlanMarks } from '../src/renderer/src/components/Sidebar'
import type { Plan, PlanItem } from '../src/shared/types'

// The assertions pin the Chinese source copy; navigator.language is en-US on
// the Linux CI runner, so pin the effective locale before rendering.
setLocale('zh-CN')

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

  it('keeps the numbered dots only while the run is going', () => {
    const done = renderToStaticMarkup(<PlanMarks plan={plan('done', 'done')} running={false} />)
    // 执行结束后只报完成数，不再报步骤序号（与移动端一致）。
    expect(done).toContain('class="session-plan-count"')
    expect(done).toContain('2/2')
    expect(done).not.toContain('session-plan-dot')

    const running = renderToStaticMarkup(<PlanMarks plan={plan('done', 'pending')} running />)
    expect(running).toContain('session-plan-dot is-done')
    expect(running).toContain('session-plan-dot is-pending')
    expect(running).toContain('1/2')
  })

  it('only pulses the active step while the run is going', () => {
    const active = renderToStaticMarkup(<PlanMarks plan={plan('in_progress', 'pending')} running />)
    expect(active).toContain('session-plan-dot is-active')
    const settled = renderToStaticMarkup(
      <PlanMarks plan={plan('in_progress', 'pending')} running={false} />,
    )
    expect(settled).not.toContain('session-plan-dot')
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
    // 结束后的同一份计划不再列步骤，只留 8/9。
    const settled = renderToStaticMarkup(
      <PlanMarks
        plan={plan('done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'pending')}
        running={false}
      />,
    )
    expect(digits(settled)).toEqual([])
    expect(settled).toContain('8/9')
  })

  it('reports progress in the accessible label and renders nothing without items', () => {
    const html = renderToStaticMarkup(<PlanMarks plan={plan('done', 'done', 'pending')} running />)
    expect(html).toContain('aria-label="计划 2/3 完成"')
    expect(renderToStaticMarkup(<PlanMarks plan={plan()} running />)).toBe('')
  })
})
