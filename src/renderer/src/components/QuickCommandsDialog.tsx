import { useEffect, useRef, useState } from 'react'
import type { QuickCommand } from '../../../shared/types'
import { ListCheckIcon, PlusIcon, RefreshIcon, TrashIcon, XIcon } from '../icons'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

const MAX_COMMANDS = 8

interface Draft {
  key: string
  id?: string
  content: string
}

export function QuickCommandsDialog({
  defaults,
  onClose,
  onChange,
}: {
  /** Built-in prompts, used when the user has never customized the list. */
  defaults: string[]
  onClose: () => void
  onChange: (commands: QuickCommand[]) => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  useEscapeClose(onClose)
  const [error, setError] = useState('')
  const nextKey = useRef(0)
  const addRow = useRef<HTMLTextAreaElement | null>(null)

  const makeKey = (): string => {
    nextKey.current += 1
    return `quick-${nextKey.current}`
  }

  useEffect(() => {
    let cancelled = false
    window.pilot
      .quickCommands()
      .then((list) => {
        if (cancelled) return
        setDrafts(
          list === null
            ? defaults.map((content, index) => ({
                key: `default-${index}`,
                content,
              }))
            : list.map((command) => ({
                key: command.id,
                id: command.id,
                content: command.content,
              })),
        )
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
        setDrafts(defaults.map((content, index) => ({ key: `default-${index}`, content })))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // The dialog fetches the authoritative list once when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (key: string, content: string): void => {
    setDrafts((previous) =>
      previous.map((draft) => (draft.key === key ? { ...draft, content } : draft)),
    )
  }

  const remove = (key: string): void => {
    setDrafts((previous) => previous.filter((draft) => draft.key !== key))
  }

  const add = (): void => {
    if (drafts.length >= MAX_COMMANDS) return
    setDrafts((previous) => [...previous, { key: makeKey(), content: '' }])
    window.setTimeout(() => addRow.current?.focus(), 20)
  }

  const restore = (): void => {
    setDrafts(defaults.map((content, index) => ({ key: `default-${index}`, content })))
    setError('')
  }

  const save = async (): Promise<void> => {
    setError('')
    setSaving(true)
    try {
      const saved = await window.pilot.saveQuickCommands(
        drafts.map((draft) => ({
          ...(draft.id ? { id: draft.id } : {}),
          content: draft.content,
        })),
      )
      onChange(saved)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal quick-commands-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("常用指令")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>
              <ListCheckIcon width={18} height={18} />
              {t("常用指令")}</h2>
            <p>{t("这些指令显示在空会话的欢迎页，点一下就会把它们作为任务发给 Pilot。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body quick-commands-body">
          {loading ? (
            <div className="quick-commands-loading">
              <i className="spinner tiny" />
              {t("正在读取…")}</div>
          ) : drafts.length === 0 ? (
            <p className="quick-commands-empty">
              {t("还没有常用指令。添加一条，或恢复推荐指令。")}</p>
          ) : (
            <div className="quick-commands-list">
              {drafts.map((draft, index) => (
                <div className="quick-command-row" key={draft.key}>
                  <span className="quick-command-index">{String(index + 1).padStart(2, '0')}</span>
                  <textarea
                    ref={index === drafts.length - 1 ? addRow : undefined}
                    className="text-input quick-command-input"
                    rows={2}
                    maxLength={4_000}
                    value={draft.content}
                    placeholder={t("例如：运行测试并修复所有失败项")}
                    onChange={(event) => update(draft.key, event.target.value)}
                  />
                  <button
                    type="button"
                    className="quick-command-remove"
                    onClick={() => remove(draft.key)}
                    title={t("删除这条指令")}
                    aria-label={t("删除这条指令")}
                  >
                    <TrashIcon width={14} height={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="quick-commands-tools">
            <button
              type="button"
              className="quick-commands-add"
              onClick={add}
              disabled={loading || drafts.length >= MAX_COMMANDS}
            >
              <PlusIcon width={13} height={13} />
              {t("添加一条")}</button>
            <span className="quick-commands-count">
              {t("{v1}/{v2}", { v1: drafts.length, v2: MAX_COMMANDS })}
            </span>
          </div>

          {error ? <div className="settings-error">{error}</div> : null}
        </div>

        <div className="modal-footer">
          <button type="button" className="quick-commands-restore" onClick={restore} disabled={loading || saving}>
            <RefreshIcon width={13} height={13} />
            {t("恢复推荐")}</button>
          <div className="modal-actions">
            <button type="button" className="button ghost" onClick={onClose} disabled={saving}>
              {t("取消")}</button>
            <button
              type="button"
              className="button primary"
              onClick={() => void save()}
              disabled={loading || saving}
            >
              {saving ? t("保存中…") : t("保存")}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
