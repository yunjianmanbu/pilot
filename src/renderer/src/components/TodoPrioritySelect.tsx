import { useMemo } from 'react'
import type { TodoPriority } from '../../../shared/types'
import { normalizeTodoPriority } from '../../../shared/todos'
import { SelectMenu, type SelectOption } from './SelectMenu'
import { t } from '../i18n'

/** 优先级的中文短标签，下拉与触发态共用。 */
export function priorityLabel(priority: TodoPriority | undefined): string {
  const value = normalizeTodoPriority(priority)
  if (value === 'high') return t('高')
  if (value === 'low') return t('低')
  return t('中')
}

export function priorityTitle(priority: TodoPriority | undefined): string {
  const value = normalizeTodoPriority(priority)
  if (value === 'high') return t('高优先级')
  if (value === 'low') return t('低优先级')
  return t('中优先级')
}

/**
 * 待办优先级下拉：点开选高/中/低，不再点一下轮换。
 * 触发器沿用旧的 `.todo-priority` 配色，所以行内仍是一枚小色块。
 */
export function TodoPrioritySelect({
  value,
  onChange,
  disabled = false,
  title,
  className,
  align = 'start',
}: {
  value: TodoPriority | undefined
  onChange: (next: TodoPriority) => void
  disabled?: boolean
  title?: string
  className?: string
  align?: 'start' | 'end'
}) {
  const current = normalizeTodoPriority(value)
  const options = useMemo<SelectOption[]>(
    () => [
      { value: 'high', label: t('高'), note: t('最急') },
      { value: 'normal', label: t('中'), note: t('默认') },
      { value: 'low', label: t('低'), note: t('可以等') },
    ],
    [],
  )
  return (
    <SelectMenu
      className={`todo-priority-select priority-${current}${className ? ` ${className}` : ''}`}
      value={current}
      options={options}
      onChange={(next) => onChange(next as TodoPriority)}
      ariaLabel={title ?? priorityTitle(current)}
      title={title ?? priorityTitle(current)}
      align={align}
      disabled={disabled}
      maxListWidth={132}
    />
  )
}
