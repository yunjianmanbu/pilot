import { useEffect, useState } from 'react'
import type {
  FilePreview,
  Session,
  SessionArtifact,
  WorkspaceSummary,
} from '../../../shared/types'
import {
  ChevronIcon,
  CopyIcon,
  FileIcon,
  FilesIcon,
  RefreshIcon,
  XIcon,
} from '../icons'
import { copyText } from '../clipboard'
import { FilePreviewBody } from './FilePreviewBody'
import { t } from '../i18n'

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Files the agent actually wrote in this session. Listing comes from the
 * persisted tool calls; opening a file still goes through the workspace jail.
 */
export function SessionFilesPanel({
  session,
  workspace,
  onClose,
  onError,
}: {
  session: Session | null
  workspace: WorkspaceSummary | null
  onClose: () => void
  onError: (message: string) => void
}) {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    setPreview(null)
    if (!session) {
      setArtifacts([])
      return
    }
    let cancelled = false
    setLoading(true)
    window.pilot
      .getSessionArtifacts(session.id)
      .then((list) => {
        if (!cancelled) setArtifacts(list)
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
  }, [session?.id, refreshKey, onError])

  const openFile = async (artifact: SessionArtifact) => {
    if (!workspace) return
    setPreviewLoading(true)
    try {
      const file = await window.pilot.previewFile(workspace.path, artifact.path)
      setPreview(file)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewLoading(false)
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="files-drawer" aria-label={t("会话产出文件")}>
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">
              <FilesIcon width={13} height={13} />
              {t("本次会话产出")}</div>
            <h2>{session?.title ?? t("未选择会话")}</h2>
          </div>
          <div className="drawer-head-actions">
            <button
              type="button"
              className="icon-button"
              title={t("刷新")}
              onClick={() => {
                setPreview(null)
                setRefreshKey((value) => value + 1)
              }}
            >
              <RefreshIcon width={15} height={15} />
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
              <XIcon width={17} height={17} />
            </button>
          </div>
        </div>

        <div className="drawer-body">
          {!session ? (
            <div className="empty-panel compact">
              <FileIcon width={26} height={26} />
              <strong>{t("还没有选中的会话")}</strong>
              <span>{t("选择一个会话后，这里会列出 Pilot 写入或修改过的文件。")}</span>
            </div>
          ) : preview ? (
            <div className="file-preview">
              <div className="preview-head">
                <button
                  type="button"
                  className="icon-text-button"
                  onClick={() => setPreview(null)}
                >
                  <ChevronIcon width={14} height={14} className="rotate-180" />
                  {t("返回")}</button>
                <span className="preview-name" title={preview.path}>
                  {preview.path}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  title={t("复制相对路径")}
                  onClick={() => {
                    void copyText(preview.path)
                  }}
                >
                  <CopyIcon width={14} height={14} />
                </button>
              </div>
              <div className="preview-meta">
                <span>{preview.language}</span>
                <span>{formatBytes(preview.size)}</span>
                {preview.truncated ? <span className="preview-truncated">{t("已截断")}</span> : null}
                {workspace ? (
                  <button
                    type="button"
                    className="icon-text-button"
                    onClick={() => {
                      void window.pilot.revealFile(workspace.path, preview.path)
                    }}
                  >
                    {t("在文件夹中显示")}</button>
                ) : null}
              </div>
              <FilePreviewBody
                preview={preview}
                {...(workspace
                  ? {
                      onOpenWindow: () => {
                        void window.pilot.openDocument(workspace.path, preview.path)
                      },
                    }
                  : {})}
              />
            </div>
          ) : loading ? (
            <div className="drawer-loading">
              <i className="spinner" />
              {t("加载中…")}</div>
          ) : artifacts.length === 0 ? (
            <div className="empty-panel compact">
              <FileIcon width={26} height={26} />
              <strong>{t("这个会话还没有产出文件")}</strong>
              <span>{t("Pilot 成功写入或修改的文件会自动收集到这里。")}</span>
            </div>
          ) : (
            <div className="file-list">
              {artifacts.map((artifact) => (
                <button
                  type="button"
                  className="file-row"
                  key={artifact.path}
                  onClick={() => void openFile(artifact)}
                  title={artifact.path}
                >
                  <span className="file-icon file">
                    <FileIcon width={15} height={15} />
                  </span>
                  <span className="file-name">{artifact.name}</span>
                  <span className="artifact-path">{artifact.path}</span>
                  <span className={`artifact-action ${artifact.action}`}>
                    {artifact.action === 'write' ? t("新建") : t("修改")}
                  </span>
                </button>
              ))}
            </div>
          )}

          {previewLoading ? (
            <div className="preview-loading">
              <i className="spinner" />
              {t("打开文件…")}</div>
          ) : null}
        </div>

        <div className="drawer-foot">
          <span>{t("只汇总本次会话成功写入的文件 · 只读预览")}</span>
        </div>
      </aside>
    </>
  )
}
