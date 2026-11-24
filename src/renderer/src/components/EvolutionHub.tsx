import { useId, useRef, useState, type ReactNode } from 'react'
import { t } from '../i18n'

export interface EvolutionTab {
  id: string
  label: string
  /** 悬停说明：一句话说清这个页签做什么。 */
  hint?: string
  /** 右上角计数（待确认的画像、待处理的提案）。 */
  badge?: number
  content: ReactNode
}

/**
 * 进化页的统一入口。
 *
 * 内视、自检、自主优化和反思原先各自占一个侧栏入口，用户要先猜「这件事归哪个页面」。
 * 现在它们都是进化下的页签：一个入口，横向切换，各面板自己管自己的数据。
 *
 * 只渲染当前页签的内容：五个面板同时挂载会各自触发一次扫描/采样，
 * 切回来再拉一遍比在后台常驻更省。
 */
export function EvolutionHub({ tabs }: { tabs: EvolutionTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '')
  const baseId = useId()
  const listRef = useRef<HTMLDivElement | null>(null)
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0]

  /** 左右方向键在页签之间移动，和 WAI-ARIA 的 tablist 约定一致。 */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const index = Math.max(
      0,
      tabs.findIndex((tab) => tab.id === current?.id),
    )
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : tabs[(index - 1 + tabs.length) % tabs.length]
    if (!next) return
    event.preventDefault()
    setActive(next.id)
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)
      ?.focus()
  }

  return (
    <div className="evolution-hub">
      <div
        className="evolution-hub-tabs"
        role="tablist"
        aria-label={t("进化功能")}
        ref={listRef}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const on = tab.id === current?.id
          return (
            <button
              key={tab.id}
              type="button"
              data-tab={tab.id}
              role="tab"
              id={`${baseId}-${tab.id}`}
              aria-selected={on}
              aria-controls={`${baseId}-${tab.id}-panel`}
              tabIndex={on ? 0 : -1}
              className={`page-tab evolution-hub-tab${on ? ' is-active' : ''}`}
              title={tab.hint}
              onClick={() => setActive(tab.id)}
            >
              {tab.label}
              {tab.badge && tab.badge > 0 ? (
                <span className="page-tab-badge">{tab.badge > 99 ? '99+' : tab.badge}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      <div
        className="evolution-hub-body"
        role="tabpanel"
        id={current ? `${baseId}-${current.id}-panel` : undefined}
        aria-labelledby={current ? `${baseId}-${current.id}` : undefined}
      >
        {current?.content}
      </div>
    </div>
  )
}
