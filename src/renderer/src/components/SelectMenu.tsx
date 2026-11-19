import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { CheckIcon, ChevronDownIcon } from '../icons'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectMenuProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  ariaLabel: string
  title?: string
  className?: string
  align?: 'start' | 'end'
  disabled?: boolean
  /** 下拉列表的最大宽度；长文案（模型、会话）可以放宽。 */
  maxListWidth?: number
}

const LIST_MAX_HEIGHT = 272
const LIST_GAP = 6

/**
 * Theme-aware listbox shared by the sidebar, panels and dialogs.
 * Keeps focus on the trigger and exposes the active option through
 * aria-activedescendant so keyboard and screen-reader navigation stay intact.
 * Disabled options are announced but skipped by pointer and keyboard input.
 */
export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  className,
  align = 'start',
  disabled = false,
  maxListWidth = 240,
}: SelectMenuProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [dropUp, setDropUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const listId = `select-${useId().replace(/:/g, '')}`

  const foundIndex = options.findIndex((option) => option.value === value)
  const selectedIndex = foundIndex >= 0 ? foundIndex : 0
  const selected = options[selectedIndex] ?? options[0]

  const firstEnabled = () => {
    const index = options.findIndex((option) => !option.disabled)
    return index >= 0 ? index : 0
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) optionRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const openMenu = () => {
    if (disabled) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      // 靠近窗口底部时向上展开，避免下拉列表被裁掉。
      setDropUp(window.innerHeight - rect.bottom < LIST_MAX_HEIGHT + LIST_GAP + 16)
    }
    setActive(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : firstEnabled())
    setOpen(true)
  }

  const closeMenu = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    closeMenu()
  }

  const move = (from: number, direction: 1 | -1) => {
    for (let step = 1; step <= options.length; step += 1) {
      const index = (from + direction * step + options.length) % options.length
      if (!options[index]?.disabled) return index
    }
    return from
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (!open) {
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault()
        openMenu()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => move(index, 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => move(index, -1))
        break
      case 'Home':
        event.preventDefault()
        setActive(firstEnabled())
        break
      case 'End': {
        event.preventDefault()
        let index = options.length - 1
        while (index > 0 && options[index]?.disabled) index -= 1
        setActive(index)
        break
      }
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        break
      case 'Escape':
        event.preventDefault()
        closeMenu()
        break
      case 'Tab':
        setOpen(false)
        break
      default:
        break
    }
  }

  const listStyle: CSSProperties = { maxWidth: `${maxListWidth}px` }

  return (
    <div
      ref={rootRef}
      className={`select-menu${className ? ` ${className}` : ''}${open ? ' is-open' : ''}${
        disabled ? ' is-disabled' : ''
      }`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-option-${active}` : undefined}
        aria-label={ariaLabel}
        title={title ?? selected?.label ?? ariaLabel}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selected?.label ?? ''}</span>
        <ChevronDownIcon width={13} height={13} className="select-chevron" />
      </button>

      {open ? (
        <div
          id={listId}
          className={`select-list${align === 'end' ? ' align-end' : ''}${
            dropUp ? ' drop-up' : ''
          }`}
          role="listbox"
          aria-label={ariaLabel}
          style={listStyle}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
              <button
                key={option.value || '__all__'}
                ref={(element) => {
                  optionRefs.current[index] = element
                }}
                type="button"
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                disabled={option.disabled}
                title={option.label}
                className={`select-option${index === active ? ' is-active' : ''}${
                  isSelected ? ' is-selected' : ''
                }${option.disabled ? ' is-option-disabled' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  if (!option.disabled) setActive(index)
                }}
                onClick={() => choose(index)}
              >
                <span className="select-option-label">{option.label}</span>
                <CheckIcon width={13} height={13} className="select-check" />
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
