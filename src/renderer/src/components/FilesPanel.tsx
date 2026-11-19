import { useEffect, useRef, useState } from 'react'
import { FilePreviewBody } from './FilePreviewBody'
import type { FileNode, FilePreview, WorkspaceSummary } from '../../../shared/types'
import {
  ChevronIcon,
  ChevronDownIcon,
  CopyIcon,
  FileIcon,
  FilesIcon,
  FolderIcon,
  RefreshIcon,
  XIcon,
} from '../icons'
import { copyText } from '../clipboard'
import { t } from '../i18n'

function formatBytes(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function FilesPanel({
  workspace,
  onClose,
  onError,
}: {
  workspace: WorkspaceSummary | null
  onClose: () => void
  onError: (message: string) => void
}) {
  const [cwd, setCwd] = useState('.')
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const requestRef = useRef(0)

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    setCwd('.')
    setPreview(null)
    setNodes([])
  }, [workspace?.path])

  useEffect(() => {
    if (!workspace) return
    const request = ++requestRef.current
    setLoading(true)
    window.pilot
      .listFiles(workspace.path, cwd)
      .then((entries) => {
        if (request !== requestRef.current) return
        setNodes(
          [...entries].sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
            return a.name.localeCompare(b.name, 'zh-CN')
          }),
        )
      })
      .catch((error) => {
        if (request !== requestRef.current) return
        onError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false)
      })
  }, [workspace?.path, cwd, refreshKey, onError])

  const openFile = async (node: FileNode) => {
    if (!workspace) return
    setPreviewLoading(true)
    try {
      const file = await window.pilot.previewFile(workspace.path, node.path)
      setPreview(file)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewLoading(false)
    }
  }

  const parts = cwd === '.' ? [] : cwd.split('/')
  const crumbs = parts.map((part, index) => ({
    name: part,
    path: parts.slice(0, index + 1).join('/'),
  }))

  return (
    <>
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside className="files-drawer" aria-label={t("工作区文件")}>
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">
              <FilesIcon width={13} height={13} />
              {t("工作区文件")}</div>
            <h2>{workspace?.name ?? t("未选择工作区")}</h2>
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

        {workspace ? (
          <div className="file-breadcrumb">
            <button
              type="button"
              className="crumb"
              onClick={() => {
                setPreview(null)
                setCwd('.')
              }}
            >
              <FolderIcon width={13} height={13} />
              {t("根目录")}</button>
            {crumbs.map((crumb, index) => (
              <span className="crumb-group" key={crumb.path}>
                <ChevronIcon width={11} height={11} />
                <button
                  type="button"
                  className={`crumb${index === crumbs.length - 1 ? ' is-current' : ''}`}
                  onClick={() => {
                    setPreview(null)
                    setCwd(crumb.path)
                  }}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="drawer-body">
          {!workspace ? (
            <div className="empty-panel compact">
              <FolderIcon width={26} height={26} />
              <strong>{t("没有打开的工作区")}</strong>
              <span>{t("先从侧边栏选择一个本地文件夹。")}</span>
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
                <button
                  type="button"
                  className="icon-text-button"
                  onClick={() => {
                    void window.pilot.revealFile(workspace.path, preview.path)
                  }}
                >
                  {t("在文件夹中显示")}</button>
              </div>
              <FilePreviewBody preview={preview} />
            </div>
          ) : loading ? (
            <div className="drawer-loading">
              <i className="spinner" />
              {t("加载中…")}</div>
          ) : nodes.length === 0 ? (
            <div className="empty-panel compact">
              <FolderIcon width={26} height={26} />
              <strong>{t("这个文件夹是空的")}</strong>
              <span>{t("或者内容都被 .gitignore 中的常见目录规则隐藏了。")}</span>
            </div>
          ) : (
            <div className="file-list">
              {cwd !== '.' ? (
                <button
                  type="button"
                  className="file-row"
                  onClick={() => {
                    const parent = parts.slice(0, -1).join('/')
                    setCwd(parent || '.')
                  }}
                >
                  <span className="file-icon folder">
                    <ChevronDownIcon width={14} height={14} className="rotate-90" />
                  </span>
                  <span className="file-name">..</span>
                </button>
              ) : null}
              {nodes.map((node) => (
                <button
                  type="button"
                  className={`file-row${node.type === 'dir' ? ' is-dir' : ''}`}
                  key={node.path}
                  onClick={() => {
                    if (node.type === 'dir') {
                      setPreview(null)
                      setCwd(node.path)
                    } else {
                      void openFile(node)
                    }
                  }}
                  title={node.path}
                >
                  <span className={`file-icon ${node.type}`}>
                    {node.type === 'dir' ? (
                      <FolderIcon width={15} height={15} />
                    ) : (
                      <FileIcon width={15} height={15} />
                    )}
                  </span>
                  <span className="file-name">{node.name}</span>
                  {node.size !== undefined ? (
                    <span className="file-size">{formatBytes(node.size)}</span>
                  ) : null}
                  {node.type === 'dir' ? (
                    <ChevronIcon width={13} height={13} className="file-chevron" />
                  ) : null}
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
          <span>{t("只读预览 · 修改请通过对话完成")}</span>
        </div>
      </aside>
    </>
  )
}
