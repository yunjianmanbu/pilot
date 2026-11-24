import type { ReactNode } from 'react'

/**
 * 设置类面板共用的两个字段外壳。
 *
 * 原先定义在 SettingsDialog 内部；反思工作区搬到进化页后两处都要用，
 * 抽出来避免第三份拷贝。
 */
export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <label className={`settings-field${wide ? ' wide' : ''}`}>
      <span className="field-label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description: string
  /** 关闭时不再响应点击：用于「总开关关掉，单个事件无意义」这类层级。 */
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
      onClick={() => {
        if (disabled) return
        onChange(!checked)
      }}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled ? true : undefined}
      disabled={disabled}
    >
      <span className="toggle-text">
        <span>{label}</span>
        <small>{description}</small>
      </span>
      <span className="toggle-switch">
        <i />
      </span>
    </button>
  )
}
