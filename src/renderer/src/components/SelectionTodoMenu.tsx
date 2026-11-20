import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { copyText } from '../clipboard'
import { t } from '../i18n'
import { CopyIcon, ListCheckIcon } from '../icons'
import { clampMenuPosition } from '../selection'

export interface SelectionMenuState {
  /** 视口坐标：右键取光标位置，松手取选中区域的下沿。 */
  x: number
  y: number
  /** 已经归一化过的选中文本，菜单关闭前不再重新读 DOM。 */
  text: string
}

const PREVIEW_CHARS = 68

/**
 * 选中正文后弹出的右键菜单。
 *
 * 只在会话正文里出现：文字是刚滑动选中的那段，第一项把它变成待办。
 * 菜单自身阻止 pointerdown 的默认行为，否则按下菜单会先清掉选中区域，
 * 点击事件还没到菜单就已经收起来了。
 */
export function SelectionTodoMenu({
  state,
  onAddTodo,
  onClose,
}: {
  state: SelectionMenuState
  onAddTodo: (text: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    setPos(
      clampMenuPosition(
        { x: state.x, y: state.y },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
  }, [state.x, state.y, state.text])

  useEffect(() => {
    setCopied(false)
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [state.text, state.x, state.y])

  const preview =
    state.text.length > PREVIEW_CHARS
      ? `${state.text.slice(0, PREVIEW_CHARS)}…`
      : state.text

  return (
    <div
      className="selection-menu"
      role="menu"
      aria-label={t("选中内容")}
      ref={ref}
      style={
        pos
          ? { left: `${pos.x}px`, top: `${pos.y}px` }
          : { left: `${state.x}px`, top: `${state.y}px`, visibility: 'hidden' }
      }
      onPointerDown={(event) => {
        // 保住选中区域：按下菜单项不该把正文的选区清掉。
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="selection-menu-preview" title={state.text}>
        {preview}
      </div>
      <button
        type="button"
        className="selection-menu-item"
        role="menuitem"
        onClick={() => onAddTodo(state.text)}
      >
        <ListCheckIcon width={13} height={13} className="selection-menu-icon" />
        <span className="selection-menu-label">{t("添加待办")}</span>
      </button>
      <button
        type="button"
        className="selection-menu-item"
        role="menuitem"
        onClick={() => {
          void copyText(state.text).then((ok) => {
            if (ok) setCopied(true)
          })
        }}
      >
        <CopyIcon width={13} height={13} className="selection-menu-icon" />
        <span className="selection-menu-label">{copied ? t("已复制") : t("复制")}</span>
      </button>
    </div>
  )
}