import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon } from '../icons'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
  /** 第二行小字：模型名这类只在展开时需要的细节。 */
  detail?: string
  /** 右侧短标注（如模型标签），只在展开的列表里出现。 */
  note?: string
  /** 触发器文案；省略时用 label，让选中后的按钮保持简短。 */
  triggerLabel?: string
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
 * 触发器是否处在会被裁切的环境里。弹框的 `.modal-body` 是 overflow: auto，
 * 抽屉和侧栏面板也一样：绝对定位的下拉列表展开到容器外就会被切掉一半。
 * 这种情况下把列表渲染到 body 上并用 fixed 定位，弹框里选模型、选频率才不会看不见。
 */
function isClipped(node: HTMLElement | null): boolean {
  let parent = node?.parentElement ?? null
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent)
    const clip = /(auto|scroll|hidden|clip)/
    if (clip.test(style.overflowY) || clip.test(style.overflowX)) return true
    parent = parent.parentElement
  }
  return false
}

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
  /** 列表要不要挂到 body 上（弹框、抽屉等会裁切子元素的容器里需要）。 */
  const [floating, setFloating] = useState(false)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
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
      const target = event.target as Node
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    // 浮层定位是按触发器位置一次算好的，容器一滚就会错位，直接收起最稳。
    // 普通（绝对定位）下拉会跟着容器一起滚，不需要这个监听；而且在打开瞬间
    // 把选中项 scrollIntoView 也会冒泡成 scroll 事件，监听只在浮动时才有意义。
    const closeOnMove = () => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    if (floating) {
      document.addEventListener('scroll', closeOnMove, true)
      window.addEventListener('resize', closeOnMove)
    }
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', closeOnMove, true)
      window.removeEventListener('resize', closeOnMove)
    }
  }, [floating, open])

  useEffect(() => {
    if (open) optionRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const openMenu = () => {
    if (disabled) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      // 靠近窗口底部时向上展开，避免下拉列表被裁掉。
      setDropUp(window.innerHeight - rect.bottom < LIST_MAX_HEIGHT + LIST_GAP + 16)
      setFloating(isClipped(triggerRef.current))
      setAnchor(rect)
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

  const floatingStyle: CSSProperties = {
    position: 'fixed',
    zIndex: 260,
    maxWidth: `${maxListWidth}px`,
    minWidth: anchor?.width ?? undefined,
    left: anchor ? (align === 'end' ? undefined : anchor.left) : undefined,
    right: anchor && align === 'end' ? Math.max(window.innerWidth - anchor.right, 8) : undefined,
    top: anchor && !dropUp ? anchor.bottom + LIST_GAP : undefined,
    bottom: anchor && dropUp ? Math.max(window.innerHeight - anchor.top + LIST_GAP, 8) : undefined,
  }
  const listStyle: CSSProperties = floating ? floatingStyle : { maxWidth: `${maxListWidth}px` }

  const list = open ? (
    <div
      id={listId}
      ref={listRef}
      className={`select-list${align === 'end' ? ' align-end' : ''}${
        dropUp ? ' drop-up' : ''
      }${floating ? ' is-floating' : ''}`}
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
            title={option.detail ? `${option.label} · ${option.detail}` : option.label}
            className={`select-option${index === active ? ' is-active' : ''}${
              isSelected ? ' is-selected' : ''
            }${option.disabled ? ' is-option-disabled' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => {
              if (!option.disabled) setActive(index)
            }}
            onClick={() => choose(index)}
          >
            {option.detail ? (
              <span className="select-option-main">
                <span className="select-option-label">{option.label}</span>
                <span className="select-option-detail">{option.detail}</span>
              </span>
            ) : (
              <span className="select-option-label">{option.label}</span>
            )}
            {option.note ? <span className="select-option-note">{option.note}</span> : null}
            <CheckIcon width={13} height={13} className="select-check" />
          </button>
        )
      })}
    </div>
  ) : null

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
        <span className="select-value">
          {selected ? (selected.triggerLabel ?? selected.label) : ''}
        </span>
        <ChevronDownIcon width={13} height={13} className="select-chevron" />
      </button>

      {floating && list ? createPortal(list, document.body) : list}
    </div>
  )
}
