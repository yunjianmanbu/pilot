import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelCatalog } from '../../../shared/model-catalog'
import { ChevronDownIcon, RefreshIcon } from '../icons'
import { t } from '../i18n'
import { isClipped } from './SelectMenu'

/**
 * 模型名输入框：可以直接打字，也可以从下拉里挑。
 *
 * 为什么不是普通 SelectMenu：模型名是「厂商随时会改」的自由文本，纯粹的下拉
 * 会在三种情况下把人卡住——厂商不提供 `/models`、刚发布的模型还没进清单、
 * 第三方中转的模型名根本不在任何预设里。所以这里永远是「输入框 + 建议列表」，
 * 下拉只负责把最新名字填进来，不负责限制合法取值。
 *
 * 列表来源与降级顺序由主进程 `discoverModels` 决定（live → cache → preset），
 * 这里只负责展示，并在失败时把原因显示在输入框下面一行，而不是弹错。
 */

/** 一次展开最多渲染多少条：聚合平台能返回上千个模型。 */
const VISIBLE_LIMIT = 60
const LIST_MAX_HEIGHT = 272
const LIST_GAP = 6

export function ModelNameField({
  value,
  baseUrl,
  apiKey,
  providerId,
  hasSavedKey,
  onChange,
  disabled,
}: {
  value: string
  baseUrl: string
  /** 用户刚输入、还没保存的密钥；为空时主进程退回已保存的那把。 */
  apiKey: string
  providerId: string
  hasSavedKey: boolean
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [floating, setFloating] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; right: number; top: number; bottom: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestId = useRef(0)

  const load = async (refresh: boolean) => {
    const id = requestId.current + 1
    requestId.current = id
    setLoading(true)
    try {
      const result = await window.pilot.discoverModels({
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(providerId ? { providerId } : {}),
        ...(value.trim() ? { current: value.trim() } : {}),
        ...(refresh ? { refresh: true } : {}),
      })
      // 期间用户又改了地址/点了刷新：丢掉过期结果，避免旧厂商的列表盖住新的。
      if (requestId.current !== id) return
      setCatalog(result)
    } catch (error) {
      if (requestId.current !== id) return
      const message = error instanceof Error ? error.message : String(error)
      setCatalog((current) => (current ? { ...current, note: message } : null))
    } finally {
      if (requestId.current === id) setLoading(false)
    }
  }

  // 地址或密钥改变（含首次挂载）就去要一次。主进程有 6 小时 TTL 缓存，
  // 所以重复触发不会重复打厂商接口；反之不把密钥纳入依赖的话，用户粘完
  // Key 之后列表会一直停在「内置清单」上，必须先点刷新才刷得出来。
  useEffect(() => {
    if (!baseUrl.trim()) {
      setCatalog(null)
      return
    }
    const timer = setTimeout(() => void load(false), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, apiKey, hasSavedKey])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
    }
    // 浮层位置是一次算好的，容器一滚就错位：收起最省事。列表自身的滚动要放过。
    const closeOnMove = (event: Event) => {
      const target = event.target as Node | null
      if (target && listRef.current?.contains(target)) return
      setOpen(false)
    }
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

  const models = catalog?.models ?? []

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = needle
      ? models.filter((entry) => entry.id.toLowerCase().includes(needle))
      : models
    return list.slice(0, VISIBLE_LIMIT)
  }, [models, query])

  useEffect(() => {
    if (!open) return
    const index = shown.findIndex((entry) => entry.id === value)
    setActive(index >= 0 ? index : 0)
  }, [open, shown, value])

  const openMenu = () => {
    if (disabled) return
    const input = inputRef.current
    const rect = input?.getBoundingClientRect()
    if (rect) {
      setDropUp(window.innerHeight - rect.bottom < LIST_MAX_HEIGHT + LIST_GAP + 16)
      setFloating(isClipped(input))
      setAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width })
    }
    // 展开时清掉过滤词：否则当前值本身会把整张列表筛成一条，换模型得先删字。
    setQuery('')
    setOpen(true)
  }

  const choose = (id: string) => {
    onChange(id)
    setQuery('')
    setOpen(false)
    inputRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) openMenu()
      else setActive((index) => Math.min(index + 1, Math.max(shown.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (open) setActive((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter' && open) {
      const picked = shown[active]
      if (picked) {
        event.preventDefault()
        choose(picked.id)
      }
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  const sourceNote = (() => {
    if (!catalog) return ''
    if (catalog.source === 'live') {
      return catalog.providerLabel
        ? t("已从 {v1} 取到最新模型名", { v1: catalog.providerLabel })
        : t("已取到该地址的最新模型名")
    }
    if (catalog.source === 'cache') return t("显示本机缓存的列表，点刷新可重新获取")
    return t("显示内置清单，填好 Key 后点刷新可取到最新模型名")
  })()

  const listStyle: React.CSSProperties = floating
    ? {
        position: 'fixed',
        zIndex: 300,
        minWidth: anchor?.width ?? undefined,
        left: anchor?.left,
        top: !dropUp ? (anchor ? anchor.bottom + LIST_GAP : undefined) : undefined,
        bottom: dropUp ? Math.max(window.innerHeight - (anchor?.top ?? 0) + LIST_GAP, 8) : undefined,
        maxWidth: 420,
      }
    : { maxWidth: 420 }

  const list = open ? (
    <div
      ref={listRef}
      className={`select-list model-name-list${dropUp ? ' drop-up' : ''}${
        floating ? ' is-floating' : ''
      }`}
      role="listbox"
      aria-label={t("模型列表")}
      style={listStyle}
    >
      {shown.length === 0 ? (
        <div className="model-name-empty">
          {loading ? t("正在获取模型列表…") : t("没有匹配的模型，可直接手填")}
        </div>
      ) : (
        shown.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="option"
            aria-selected={entry.id === value}
            className={`select-option${index === active ? ' is-active' : ''}${
              entry.id === value ? ' is-selected' : ''
            }`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(entry.id)}
          >
            <span className="select-option-label">{entry.id}</span>
            {entry.known ? <span className="select-option-note">{t("推荐")}</span> : null}
          </button>
        ))
      )}
    </div>
  ) : null

  return (
    <div className="model-name-field" ref={rootRef}>
      <div className="model-name-row">
        <input
          ref={inputRef}
          className="text-input mono"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-label={t("模型名称")}
          value={value}
          placeholder="qwen-plus"
          spellCheck={false}
          onChange={(event) => {
            onChange(event.target.value)
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
          onClick={() => {
            if (!open) openMenu()
          }}
        />
        <button
          type="button"
          className="button ghost small"
          aria-label={t("展开模型列表")}
          title={t("展开模型列表")}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : openMenu())}
        >
          <ChevronDownIcon width={13} height={13} />
        </button>
        <button
          type="button"
          className="button ghost small"
          aria-label={t("刷新模型列表")}
          title={t("用当前 Key 向厂商获取最新模型名")}
          disabled={disabled || loading}
          onClick={() => void load(true)}
        >
          <RefreshIcon width={13} height={13} className={loading ? 'is-spinning' : undefined} />
        </button>
      </div>
      {catalog?.note ? (
        <small className="model-name-note is-warn">{catalog.note}</small>
      ) : sourceNote ? (
        <small className="model-name-note">
          {sourceNote}
          {catalog && catalog.models.length > 0
            ? t("（{v1} 个可选）", { v1: catalog.models.length })
            : ''}
        </small>
      ) : null}
      {floating && list ? createPortal(list, document.body) : list}
    </div>
  )
}
