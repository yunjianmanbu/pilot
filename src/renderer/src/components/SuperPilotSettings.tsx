import { useCallback, useEffect, useState } from 'react'
import type { SuperPilotStatusReply } from '../../../shared/super'
import { t } from '../i18n'

/**
 * 设置 →「超级 Pilot」。
 *
 * 这里只做一件事：**在主界面还活着的时候，也让人能进得去应急通道。**
 * 真正干活的界面在独立窗口（`super.html`），因为主窗口一旦卡住，这个弹窗里的
 * 按钮也点不动。所以这一节只显示状态 + 一个「打开」按钮，并把边界写清楚：
 * 它独立存储、独立运行器、全权限，且不改业务数据。
 *
 * 样式全部复用设置面板已有的类（`settings-*`、`diag-*`），不再引入新的 CSS。
 */
export function SuperPilotSettings(): React.JSX.Element {
  const [reply, setReply] = useState<SuperPilotStatusReply | null>(null)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setReply(await window.pilot.super.status())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const open = useCallback(async () => {
    setOpening(true)
    try {
      const result = await window.pilot.super.open()
      if (!result.ok) setError(t('未能打开应急窗口'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOpening(false)
    }
  }, [])

  const status = reply && !('error' in reply) ? reply : null
  const unavailable = reply && 'error' in reply ? String(reply.error) : ''
  const stateText = status
    ? status.state === 'running'
      ? t('运行中')
      : status.state === 'failed'
        ? t('未能启动')
        : status.state === 'booting'
          ? t('启动中')
          : t('就绪')
    : t('未知')

  return (
    <div className="runtime-log">
      <div className="settings-section-head">
        <div>
          <h3>{t('超级 Pilot（应急通道）')}</h3>
          <p>
            {t('Pilot 自己出问题时用它修自己。它有自己的存储、回退点与运行器，不排队也不参与回退点维护，所以主引擎卡住时仍能发指令。它拥有自身源码与配置的完整读写权限，但不改会话与设置。')}</p>
        </div>
        <div className="runtime-log-actions">
          <button type="button" className="button ghost small" onClick={() => void refresh()}>
            {t('刷新状态')}</button>
          <button
            type="button"
            className="button primary small"
            onClick={() => void open()}
            disabled={opening}
          >
            {opening ? t('正在打开…') : t('打开超级 Pilot 窗口')}
          </button>
        </div>
      </div>

      {error ? <div className="settings-error">{error}</div> : null}
      {unavailable ? <div className="settings-error">{unavailable}</div> : null}

      <div className="diag-cards">
        <div className={`diag-card${status?.state === 'running' ? ' is-warn' : ''}`}>
          <span className="diag-label">{t('状态')}</span>
          <strong>{stateText}</strong>
          <span className="diag-muted">{status?.model || t('未配置模型')}</span>
        </div>
        <div className={`diag-card${status && !status.autonomy.active ? ' is-warn' : ''}`}>
          <span className="diag-label">{t('完全自主档')}</span>
          <strong>{status?.autonomy.active ? t('已生效') : t('未生效')}</strong>
          <span className="diag-muted">
            {status?.autonomy.active
              ? t('读写、联网、改自身源码都不逐次确认')
              : (status?.autonomy.blockers.join('、') || t('原因未知'))}
          </span>
        </div>
        <div className={`diag-card${status?.lastError ? ' is-warn' : ''}`}>
          <span className="diag-label">{t('最近错误')}</span>
          <span className="diag-muted">{status?.lastError || t('无')}</span>
        </div>
      </div>

      <div className="diag-table">
        <div className="diag-row">
          <div className="diag-row-main">{t('数据面目录')}</div>
          <div className="diag-row-detail mono">{status?.dataDir || '—'}</div>
        </div>
        <div className="diag-row">
          <div className="diag-row-main">{t('工作区（自身源码）')}</div>
          <div className="diag-row-detail mono">{status?.workspace || '—'}</div>
        </div>
        <div className="diag-row">
          <div className="diag-row-main">{t('模型通道来源')}</div>
          <div className="diag-row-detail">
            {status?.inheritedFromHost
              ? t('已从主客户端继承；主客户端读不出来时用自己存下的那份')
              : t('独立配置：主客户端不可用时仍然可用')}
          </div>
        </div>
        <div className="diag-row">
          <div className="diag-row-main">{t('应急会话')}</div>
          <div className="diag-row-detail mono">{status?.sessionId || '—'}</div>
        </div>
      </div>

      <p className="settings-hint">
        {t('应急窗口里的「一键抢救」会取消卡住的运行、放掉待批审批，并把每一步成功与否列出来。它不能绕过 JS 单线程：主进程被同步死循环堵住时，正确出路仍是重启应用，日志面板能看到当时的延迟。')}</p>
    </div>
  )
}
