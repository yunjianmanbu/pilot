import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HARD_CEILING_MAX } from '../src/shared/step-budget'
import { STEP_LIMIT_MIN, StepLimitField } from '../src/renderer/src/components/step-limit-field'

/**
 * 「最大步数」现在只是许可下限：真正允许跑多少由 `shared/step-budget.ts` 按任务
 * 条数与进展决定。输入框的上限、文案里的数字必须与那个天花板同源，否则用户写进去
 * 的值会被静默夹掉，界面上却看不出原因。
 *
 * 这些用例渲染真实组件，断言用户读到的文案，而不是我们传进去的 props。
 */

describe('step limit field', () => {
  const html = renderToStaticMarkup(<StepLimitField value="200" onChange={() => {}} />)

  it('says the limit is soft instead of a hard cap', () => {
    expect(html).toContain('最大步数（软上限）')
    expect(html).not.toContain('>最大步数<')
  })

  it('explains that 0 means unlimited and where extension stops', () => {
    expect(html).toContain('0 = 不限')
    expect(html).toContain(HARD_CEILING_MAX.toLocaleString())
  })

  it('accepts 0 and stops at the same ceiling the loop enforces', () => {
    expect(STEP_LIMIT_MIN).toBe(0)
    expect(html).toContain('min="0"')
    expect(html).toContain(`max="${HARD_CEILING_MAX}"`)
  })

  it('keeps the persisted value visible', () => {
    expect(html).toContain('value="200"')
  })
})
