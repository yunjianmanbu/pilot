import { useEffect, useState } from 'react'
import type { Session, SessionChange } from '../../../shared/types'
import {
  CheckIcon,
  DiffIcon,
  FileIcon,
  InfoIcon,
  RefreshIcon,
  XIcon,
} from '../icons'
import { t } from '../i18n'

const STATUS_LABELS: Record<SessionChange['status'], string> = {
  modified: t("修改"),
  added: t("新增"),
  deleted: t("删除"),
  unreadable: t("无法预览"),
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff-view">
      {text.split('\n').map((line, index) => {
        const kind =
          line.startsWith('+++') || line.startsWith('---')
            ? 'meta'
            : line.startsWith('@@')
              ? 'hunk'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-')
                  ? 'del'
                  : 'ctx'
        return (
          <span key={`${index}-${line.slice(0, 8)}`} className={`diff-line diff-${kind}`}>
            {line || ' '}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

/**
 * Review every file the agent wrote in this session against the session's
 * earliest checkpoint. Reverting is per-file and refuses paths that are not
 * session artifacts; the main process re-checks the workspace jail.
 */
export function ChangeReviewPanel({
  session,
  onClose,
  onReverted,
  onError,
  onNotice,
}: {
  session: Session
  onClose: () => void
  onReverted: (path: string) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [changes, setChanges] = useState<SessionChange[]>([])
  const [loading, setLoading] = useState(true)
  const [reverting, setReverting] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.pilot
      .reviewSessionChanges(session.id)
      .then((list) => {
        if (cancelled) return
        setChanges(list)
        setSelected((current) =>
          current && list.some((change) => change.path === current)
            ? current
            : (list[0]?.path ?? null),
        )
      })
      .catch((error) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [session.id, refreshKey, onError])

  const current = changes.find((change) => change.path === selected) ?? null
  const revert = async (change: SessionChange) => {
    const label =
      change.status === 'added'
        ? t("撤销后 {v1} 会被移到回退点的回收目录，而不是直接删除。继续？", { v1: change.path })
        : t("用会话最早的快照覆盖 {v1}？当前内容会被替换。", { v1: change.path })
    if (!window.confirm(t("{v1}\n\n这个操作只处理这一个文件。", { v1: label }))) return
    setReverting(change.path)
    try {
      const result = await window.pilot.revertSessionFile(session.id, change.path)
      onReverted(change.path)
      setRefreshKey((value) => value + 1)
      const action = result.restored ? t("已恢复") : result.removed ? t("已移入回收目录") : t("没有变化")
      onNotice(
        result.restored || result.removed
          ? t("已撤销 {v1}：{v2}。", { v1: change.path, v2: action })
          : t("{v1} 没有可撤销的内容。", { v1: change.path }),
      )
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setReverting(null)
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="files-drawer change-review" aria-label={t("变更审阅")}>
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">
              <DiffIcon width={13} height={13} />
              {t("变更审阅")}</div>
            <h2>{session.title}</h2>
          </div>
          <div className="drawer-head-actions">
            <button
              type="button"
              className="icon-button"
              title={t("刷新")}
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              <RefreshIcon width={15} height={15} />
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
              <XIcon width={17} height={17} />
            </button>
          </div>
        </div>

        <div className="drawer-body">
          {loading ? (
            <div className="drawer-loading">
              <i className="spinner" />
              {t("正在比较文件…")}</div>
          ) : changes.length === 0 ? (
            <div className="empty-panel compact">
              <DiffIcon width={26} height={26} />
              <strong>{t("这个会话没有可审阅的文件变更")}</strong>
              <span>{t("Pilot 写入工作区文件后，这里会显示相对会话起点的差异。")}</span>
            </div>
          ) : (
            <div className="change-review-layout">
              <div className="change-list">
                {changes.map((change) => (
                  <button
                    type="button"
                    key={change.path}
                    className={`change-row${change.path === selected ? ' is-active' : ''}`}
                    onClick={() => setSelected(change.path)}
                    title={change.path}
                  >
                    <span className={`change-status status-${change.status}`}>
                      {STATUS_LABELS[change.status]}
                    </span>
                    <span className="change-name">{change.name}</span>
                    <span className="change-path">{change.path}</span>
                    <span className="change-counts">
                      {change.added > 0 ? <em className="add">+{change.added}</em> : null}
                      {change.removed > 0 ? <em className="del">-{change.removed}</em> : null}
                    </span>
                  </button>
                ))}
              </div>

              {current ? (
                <div className="change-detail">
                  <div className="change-detail-head">
                    <span className="change-detail-path" title={current.path}>
                      {current.path}
                    </span>
                    <span className={`change-status status-${current.status}`}>
                      {STATUS_LABELS[current.status]}
                    </span>
                    <button
                      type="button"
                      className="button ghost small"
                      disabled={!current.canRevert || reverting === current.path}
                      title={
                        current.canRevert
                          ? t("用会话最早的快照恢复这个文件")
                          : t("没有可用的基线快照，无法撤销")
                      }
                      onClick={() => void revert(current)}
                    >
                      {reverting === current.path ? (
                        <i className="spinner small" />
                      ) : (
                        <CheckIcon width={13} height={13} />
                      )}
                      {t("撤销此文件")}</button>
                  </div>
                  {current.note ? (
                    <div className="change-note">
                      <InfoIcon width={13} height={13} />
                      {current.note}
                    </div>
                  ) : null}
                  {current.diff ? (
                    <DiffView text={current.diff} />
                  ) : (
                    <div className="change-empty-diff">
                      <FileIcon width={18} height={18} />
                      {t("没有可显示的文本差异。")}</div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <span>{t("对比基线：本会话最早的保留快照 · 撤销按文件进行")}</span>
        </div>
      </aside>
    </>
  )
}
