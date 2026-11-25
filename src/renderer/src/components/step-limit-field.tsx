import { HARD_CEILING_MAX } from '../../../shared/step-budget'
import { t } from '../i18n'
import { Field } from './form-fields'

/**
 * 「最大步数」不再是每轮一刀切的上限，而是**许可下限**：`shared/step-budget.ts`
 * 会按任务条数抬高起步预算，并在每步都有新证据时继续延展，直到硬天花板。
 *
 * 抽成独立组件有两个原因：设置页的输入范围必须与 `HARD_CEILING_MAX` 同源（否则
 * 输入框拦下的值和循环真正允许的值会漂移），以及文案要能被渲染测试直接断言，
 * 而不是等用户在界面上发现「写 1000 就是上限」的误解。
 */
export const STEP_LIMIT_MIN = 0

export function stepLimitHint(): string {
  return t("0 = 不限 · 有进展时最多延展到 {v1} 步", {
    v1: HARD_CEILING_MAX.toLocaleString(),
  })
}

export function StepLimitField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field label={t('最大步数（软上限）')} hint={stepLimitHint()}>
      <input
        className="text-input mono"
        type="number"
        min={STEP_LIMIT_MIN}
        max={HARD_CEILING_MAX}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}
