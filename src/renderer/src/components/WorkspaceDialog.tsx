import { useState } from 'react'
import type { WorkspaceSummary } from '../../../shared/types'
import {
  CheckIcon,
  DownloadIcon,
  FolderIcon,
  InfoIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from '../icons'
import { formatRelative } from '../ui'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

export function WorkspaceDialog({
  workspaces,
  activeWorkspace,
  onOpen,
  onPick,
  onRemove,
  onReveal,
  onPackExport,
  onPackImport,
  onClose,
  onError,
}: {
  workspaces: WorkspaceSummary[]
  activeWorkspace: string | null
  onOpen: (path: string) => Promise<void>
  onPick: () => void
  onRemove: (path: string) => Promise<void>
  onReveal: (path: string) => void
  /** 导出某个工作区成 .pilotpack.zip（可勾选范围，含明文密钥）。 */
  onPackExport: (workspace: WorkspaceSummary) => void
  /** 从 .pilotpack.zip 导入一个工作区到本机。 */
  onPackImport: () => void
  onClose: () => void
  onError: (message: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)

  useEscapeClose(onClose)

  const open = async (path: string) => {
    if (path === activeWorkspace) return
    setBusy(path)
    try {
      await onOpen(path)
      onClose()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (workspace: WorkspaceSummary) => {
    if (
      !window.confirm(
        t("移除工作区「{v1}」？\n\n会话、项目记忆和自我进化版本将一并从此设备删除，不会删除磁盘上的文件夹。", { v1: workspace.name }),
      )
    ) {
      return
    }
    setBusy(workspace.path)
    try {
      await onRemove(workspace.path)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("工作区")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t("工作区")}</h2>
            <p>{t("Pilot 只在被授权的工作区内读写文件、执行命令。")}</p>
          </div>
          <div className="modal-head-actions">
            <button type="button" className="button ghost small" onClick={onPackImport} title={t("从 .pilotpack.zip 导入工作区")}>
              {t("导入")}</button>
            <button type="button" className="button primary small" onClick={onPick}>
              <PlusIcon width={15} height={15} />
              {t("打开文件夹")}</button>
            <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
              <XIcon width={17} height={17} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {workspaces.length === 0 ? (
            <div className="workspace-empty">
              <FolderIcon width={30} height={30} />
              <strong>{t("还没有工作区")}</strong>
              <span>{t("选择一个本地文件夹，Pilot 才能开始工作。")}</span>
              <button type="button" className="button primary" onClick={onPick}>
                {t("选择文件夹")}</button>
            </div>
          ) : (
            <div className="workspace-list">
              {workspaces.map((workspace) => {
                const active = workspace.path === activeWorkspace
                return (
                  <div
                    className={`workspace-row${active ? ' is-active' : ''}`}
                    key={workspace.path}
                  >
                    <span className="workspace-row-icon">
                      <FolderIcon width={17} height={17} />
                    </span>
                    <button
                      type="button"
                      className="workspace-row-main"
                      onClick={() => void open(workspace.path)}
                    >
                      <span className="workspace-row-name">
                        {workspace.name}
                        {active ? (
                          <span className="active-chip">
                            <CheckIcon width={10} height={10} />
                            {t("当前")}</span>
                        ) : null}
                      </span>
                      <span className="workspace-row-path">{workspace.path}</span>
                      <span className="workspace-row-meta">
                        {workspace.sessionCount} {t("个会话 ·")}{' '}
                        {formatRelative(workspace.lastOpenedAt)}{t("打开")}{workspace.hasMemory ? t(" · 有项目记忆") : ''}
                      </span>
                    </button>
                    <div className="workspace-row-actions">
                      <button
                        type="button"
                        className="icon-text-button"
                        title={t("导出这个工作区（可勾选范围，含密钥）")}
                        disabled={busy === workspace.path}
                        onClick={() => onPackExport(workspace)}
                      >
                        <DownloadIcon width={13} height={13} />
                        {t("导出")}</button>
                      <button
                        type="button"
                        className="icon-text-button"
                        onClick={() => onReveal(workspace.path)}
                      >
                        {t("显示")}</button>
                      <button
                        type="button"
                        className="icon-button danger"
                        title={t("移除工作区")}
                        disabled={busy === workspace.path}
                        onClick={() => void remove(workspace)}
                      >
                        {busy === workspace.path ? (
                          <i className="spinner small" />
                        ) : (
                          <TrashIcon width={14} height={14} />
                        )}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="workspace-note">
            <InfoIcon width={14} height={14} />
            <span>
              {t("每个工作区独立保存会话、项目记忆和运行画像。移除工作区只清除 Pilot 的本地数据，不会删除文件夹。")}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
