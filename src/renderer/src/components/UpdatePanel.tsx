import { useEffect, useRef } from 'react'
import type { UpdateState } from '../../../shared/types'
import { DownloadIcon, RefreshIcon, UpdateIcon, XIcon } from '../icons'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

const UPDATE_LABELS: Record<UpdateState['status'], string> = {
  disabled: t("不可用"),
  idle: t("未检查"),
  checking: t("检查中"),
  'up-to-date': t("已是最新"),
  available: t("更新可用"),
  downloading: t("下载中"),
  ready: t("待安装"),
  installing: t("安装中"),
  error: t("检查失败"),
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatCheckedAt(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function UpdatePanel({
  update,
  running,
  onClose,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
}: {
  update: UpdateState
  running: number
  onClose: () => void
  onCheckUpdate: () => void
  onDownloadUpdate: () => void
  onInstallUpdate: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEscapeClose(onClose)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.update-trigger')) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [onClose])

  const canInstallNow = update.canInstall && running === 0

  const install = () => {
    if (!canInstallNow) return
    if (
      !window.confirm(
        t("安装更新会退出 Pilot，当前界面会关闭并在安装完成后自动重新启动。确定继续吗？"),
      )
    ) {
      return
    }
    onInstallUpdate()
  }

  return (
    <div ref={panelRef} className="update-panel" role="dialog" aria-label={t("软件更新")}>
      <div className="update-panel-head">
        <div className="update-panel-title">
          <strong>{t("软件更新")}</strong>
          <span className={`update-state ${update.status}`}>
            <i className="key-dot" />
            {UPDATE_LABELS[update.status]}
          </span>
        </div>
        <button
          type="button"
          className="update-panel-close"
          onClick={onClose}
          aria-label={t("关闭更新面板")}
        >
          <XIcon width={14} height={14} />
        </button>
      </div>

      <div className="update-panel-body">
        <div className="update-version-row">
          <span className="update-current">{t("当前 v")}{update.currentVersion}</span>
          {update.release &&
          (update.status === 'available' ||
            update.status === 'downloading' ||
            update.status === 'ready') ? (
            <>
              <span className="update-version-arrow">→</span>
              <span className="update-latest">v{update.release.version}</span>
            </>
          ) : null}
        </div>

        <p className={`update-message ${update.status}`}>{update.message}</p>

        {update.release && update.status === 'available' ? (
          <>
            <div className="update-meta">
              {update.release.date ? <span>{update.release.date}</span> : null}
              <span>{formatBytes(update.release.size)}</span>
              <span>{update.release.platform}</span>
            </div>
            {update.release.notes ? <p className="update-notes">{update.release.notes}</p> : null}
          </>
        ) : null}

        {update.status === 'downloading' ? (
          <div className="update-progress">
            <div className="update-progress-track">
              <i style={{ width: `${Math.round(update.progress * 100)}%` }} />
            </div>
            <div className="update-progress-meta">
              <span>
                {formatBytes(update.transferred)} / {formatBytes(update.total)}
              </span>
              <span>{Math.round(update.progress * 100)}%</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="update-actions">
        {update.status === 'available' ? (
          <button type="button" className="button primary" onClick={onDownloadUpdate}>
            <DownloadIcon width={15} height={15} />
            {t("下载更新")}</button>
        ) : null}
        {update.status === 'ready' ? (
          <button
            type="button"
            className="button primary"
            onClick={install}
            disabled={!canInstallNow}
            title={
              !update.canInstall
                ? t("开发模式下不会执行安装")
                : running > 0
                  ? t("任务执行中，完成后才能重启安装")
                  : t("启动安装程序并退出 Pilot")
            }
          >
            <UpdateIcon width={15} height={15} />
            {t("重启并安装")}</button>
        ) : null}
        {update.status === 'checking' ||
        update.status === 'downloading' ||
        update.status === 'installing' ? (
          <button type="button" className="button ghost" disabled>
            <i className="spinner" />
            {update.status === 'checking'
              ? t("检查中…")
              : update.status === 'downloading'
                ? t("下载中…")
                : t("正在启动…")}
          </button>
        ) : null}
        {update.status === 'idle' ||
        update.status === 'up-to-date' ||
        update.status === 'error' ? (
          <button type="button" className="button ghost" onClick={onCheckUpdate} title={t("重新检查更新")}>
            <RefreshIcon width={15} height={15} />
            {t("检查更新")}</button>
        ) : null}
      </div>

      {update.status === 'ready' && running > 0 ? (
        <p className="update-hint">
          {t("当前有")}{running} {t("个任务执行中。安装会退出 Pilot，请等任务完成或停止后再重启安装。")}</p>
      ) : null}
      {update.status === 'ready' && !update.canInstall ? (
        <p className="update-hint">{t("开发模式下只验证下载与校验流程，不执行安装。")}</p>
      ) : null}
      {update.relocatingToUserDir && (update.status === 'ready' || update.status === 'installing') ? (
        <p className="update-hint">
          {t("这次安装会把 Pilot 迁移到当前用户目录，不再需要管理员授权；配对、会话和设置都会保留。旧的 Program Files 副本可以之后在「应用和功能」里手动卸载。")}</p>
      ) : null}
      {!update.relocatingToUserDir && update.elevationRequired && (update.status === 'ready' || update.status === 'installing') ? (
        <p className="update-hint">
          {t("Pilot 安装在需要管理员权限的目录，安装时 Windows 会弹出授权框，请点「是」。想以后免确认，可把 Pilot 重装到当前用户目录。")}</p>
      ) : null}
      <p className="update-footnote">
        {t("更新包通过 HTTPS 下载，并与清单中的 SHA-256 校验一致后才会提供安装入口。下载在后台进行， 不会中断当前会话；安装需要你手动确认。")}{t("支持增量更新时只下载变化的数据块；首次更新或服务器不支持时仍下载完整安装包。")}{update.checkedAt ? t(" 上次检查：{v1}。", { v1: formatCheckedAt(update.checkedAt) }) : ''}
      </p>
    </div>
  )
}
