import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { SearchIcon } from '../icons'
import { t } from '../i18n'
import { filterPalette, movePaletteCursor, type PaletteEntry } from './command-palette-search'
import { useEscapeClose } from './useEscapeClose'

export interface PaletteCommand extends PaletteEntry {
  icon: ReactNode
  /** 显示在行尾的快捷键，例如 Ctrl+K。只做提示，真正的监听在 App 里。 */
  shortcut?: string
  /** 当前状态下用不了（例如没有打开工作区时的「导出工作区包」）。 */
  disabled?: boolean
  run: () => void
}

/**
 * Ctrl+K 命令面板。
 *
 * 只有一个输入框加一列命令：输入即过滤，上下移动光标，回车执行，Esc 关闭。
 * Esc 走 `useEscapeClose` 的栈，所以面板压在任何弹框之上时只关面板，不会把
 * 底下的设置页一起关掉。
 */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  useEscapeClose(onClose, open)

  const matches = useMemo(() => filterPalette(commands, query), [commands, query])

  // 每次打开都从空查询、第一条开始：留着上一次的搜索词会让人以为命令不见了。
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    // 面板有 0.16s 淡入，立刻 focus 会把光标闪在动画中途。
    const timer = window.setTimeout(() => input.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  // 查询变了，原来的光标位置指向的已经不是同一条命令。
  useEffect(() => {
    setCursor(0)
  }, [query])

  // 光标移出可视区（条目多、窗口矮）时跟着滚，否则方向键按下去看不到选了谁。
  useEffect(() => {
    if (!open) return
    const selected = list.current?.querySelector('[aria-selected="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open, matches.length])

  if (!open) return null

  const choose = (command: PaletteCommand | undefined): void => {
    if (!command || command.disabled) return
    onClose()
    command.run()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((current) =>
        movePaletteCursor(current, event.key === 'ArrowDown' ? 1 : -1, matches.length),
      )
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(matches[cursor])
    }
  }

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div
        className="modal palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("命令面板")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-search">
          <SearchIcon width={16} height={16} />
          <input
            ref={input}
            className="palette-input"
            type="text"
            value={query}
            placeholder={t("搜索命令：新建任务、设置、切换视图…")}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={matches[cursor] ? `palette-${matches[cursor].id}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="palette-esc">{t("Esc 关闭")}</span>
        </div>

        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {matches.length === 0 ? (
            <p className="palette-empty">{t("没有匹配的命令")}</p>
          ) : (
            matches.map((command, index) => (
              <button
                key={command.id}
                id={`palette-${command.id}`}
                type="button"
                role="option"
                aria-selected={index === cursor}
                className={`palette-item${command.disabled ? ' is-disabled' : ''}`}
                disabled={command.disabled}
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(command)}
              >
                <span className="palette-icon">{command.icon}</span>
                <span className="palette-title">{command.title}</span>
                <span className="palette-group">{command.group}</span>
                {command.shortcut ? <kbd className="palette-kbd">{command.shortcut}</kbd> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
