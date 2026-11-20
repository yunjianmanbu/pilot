import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import { CheckIcon, MoreIcon } from '../icons'

export interface TopbarMenuItem {
  key: string
  label: string
  icon: ReactElement
  /** 悬停说明。菜单项只放短标签，长解释留在这里。 */
  hint?: string
  /** 该操作对应的面板正开着：菜单里打勾，触发器也进入活跃态。 */
  active?: boolean
  disabled?: boolean
  /** 在这一项之前画分隔线，用来分组（对话操作 / 产出与工作区）。 */
  dividerBefore?: boolean
  onSelect: () => void
}

export interface TopbarMenuPopupProps {
  items: TopbarMenuItem[]
  label: string
  onPick?: (item: TopbarMenuItem) => void
  onClose?: () => void
}

/** 可操作项的按钮列表，用于方向键导航；禁用的项不参与。 */
function enabledItems(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button.topbar-menu-item:not(:disabled)'))
}

/**
 * 菜单弹层本体。单独导出让渲染测试能直接断言用户看到的那一份标签集合，
 * 也让 App 渲染逻辑里不出现第二套菜单结构。
 */
export function TopbarMenuPopup({
  items,
  label,
  onPick,
  onClose,
}: TopbarMenuPopupProps): ReactElement {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose?.()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    const buttons = enabledItems(event.currentTarget)
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const last = buttons.length - 1
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown'
            ? current < 0 || current === last
              ? 0
              : current + 1
            : current <= 0
              ? last
              : current - 1
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <div className="topbar-menu-pop" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.dividerBefore ? <div className="topbar-menu-sep" role="separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className={`topbar-menu-item${item.active ? ' is-active' : ''}`}
            title={item.hint ?? item.label}
            disabled={item.disabled}
            onClick={() => onPick?.(item)}
          >
            <span className="topbar-menu-icon">{item.icon}</span>
            <span className="topbar-menu-label">{item.label}</span>
            {item.active ? <CheckIcon width={13} height={13} className="topbar-menu-check" /> : null}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

export interface TopbarMenuProps {
  items: TopbarMenuItem[]
  /** 触发器的无障碍名与菜单名，例如「会话操作」。 */
  label: string
  title?: string
}

/**
 * 顶栏的「更多操作」按钮。
 *
 * 会话边上原本平铺着七个图标，窄窗口下会把标题挤成两三个字。现在收敛成一个
 * 三个点的菜单：触发器只占 30px，面板打开状态通过勾选和按钮活跃态体现，
 * 所以信息没有丢，只是多了一次点击。
 */
export function TopbarMenu({ items, label, title }: TopbarMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // 打开后把键盘焦点送进菜单，方向键即可在项间移动，Esc 回到触发器。
  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector<HTMLButtonElement>('button.topbar-menu-item:not(:disabled)')?.focus()
  }, [open])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const pick = (item: TopbarMenuItem): void => {
    setOpen(false)
    triggerRef.current?.focus()
    item.onSelect()
  }

  const anyActive = items.some((item) => item.active)

  return (
    <div className="topbar-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`topbar-icon${open || anyActive ? ' is-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title ?? label}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon width={16} height={16} />
      </button>
      {open ? (
        <TopbarMenuPopup items={items} label={label} onPick={pick} onClose={close} />
      ) : null}
    </div>
  )
}
