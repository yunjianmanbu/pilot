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

  it('keeps the running step visible when a plan is longer than the row fits', () => {
    // 9 步只画当前步附近的 3 个点，两侧折叠成 +N——整排铺开会被侧栏的
    // overflow 裁掉，而被裁掉的往往正好是「现在跑到第几步」。
    const html = renderToStaticMarkup(
      <PlanMarks
        plan={plan('done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'pending')}
        running
      />,
    )
    // 前 8 步已完成，当前步是第 9 步：窗口落在尾部，前面折叠 6 步。
    expect(digits(html)).toEqual(['7', '8', '9'])
    expect(html).toContain('class="session-plan-more">+6</i>')
    // 还没有任何一步标成 in_progress 时，当前步（下一个要做的）按运行中高亮。
    expect(html).toContain('session-plan-dot is-active is-current')
    expect(html).toContain('>8/9<')
  })

  it('centres the window on the step that is running', () => {
    const html = renderToStaticMarkup(
      <PlanMarks
        plan={plan(
          'done',
          'done',
          'done',
          'done',
          'done',
          'in_progress',
          'pending',
          'pending',
          'pending',
        )}
        running
      />,
    )
    // 第 6 步在跑：5/6/7 可见，前后各自折叠。
    expect(digits(html)).toEqual(['5', '6', '7'])
    expect(html).toContain('class="session-plan-more">+4</i>')
    expect(html).toContain('class="session-plan-more">+2</i>')
    expect(html).toContain('session-plan-dot is-active is-current')
  })

  it('still lists every step when the plan is short', () => {
    const html = renderToStaticMarkup(
      <PlanMarks plan={plan('done', 'in_progress', 'pending', 'pending', 'pending')} running />,
    )
    expect(digits(html)).toEqual(['1', '2', '3', '4', '5'])
    expect(html).not.toContain('session-plan-more')
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
