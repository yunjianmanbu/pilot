/**
 * 会话报告弹窗：把「这一轮做了什么、改了什么、验证过没有」摊开给人看。
 *
 * 报告文本由主进程生成（会话消息与 run 统计都在那边），这里只负责展示与导出，
 * 不在渲染层重算一遍，否则两处口径迟早不一致。
 */

import { useEffect, useState } from 'react'
import type { SessionReport } from '../../../shared/session-report'
import { copyText } from '../clipboard'
import { t } from '../i18n'
import { XIcon } from '../icons'
import { Markdown } from './Markdown'
import { useEscapeClose } from './useEscapeClose'

export function SessionReportView({
  report,
  loading,
}: {
  report: SessionReport | null
  loading: boolean
}) {
  if (loading) {
    return (
      <p className="settings-hint">
        <i className="spinner" /> {t('正在汇总这一轮…')}
      </p>
    )
  }
  if (!report) return <p className="settings-hint">{t('这一轮还没有可报告的运行。')}</p>
  return (
    <>
      <div className="report-facts">
        <span className={`report-pill${report.verified ? ' is-ok' : ' is-warn'}`}>
          {report.verified ? t('已验证') : t('未验证')}
        </span>
        <span className="report-pill">
          {t('改了 {v1} 个文件', { v1: String(report.changedFiles.length) })}
        </span>
        {report.failures.length > 0 ? (
          <span className="report-pill is-warn">
            {t('{v1} 次失败', { v1: String(report.failures.length) })}
          </span>
        ) : null}
      </div>
      <Markdown content={report.markdown} />
    </>
  )
}

export function SessionReportDialog({
  sessionId,
  onClose,
  onError,
}: {
  sessionId: string
  onClose: () => void
  onError: (error: unknown) => void
}) {
  const [report, setReport] = useState<SessionReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  useEscapeClose(onClose)

  // 只取一次：报告是已完成运行的快照，弹窗开着时不会自己变。
  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.pilot
      .sessionReport(sessionId)
      .then((next) => {
        if (!alive) return
        setReport(next)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setLoading(false)
        onError(error)
      })
    return () => {
      alive = false
    }
  }, [sessionId, onError])

  const copyReport = () => {
    if (!report) return
    void copyText(report.markdown).then((ok) => {
      if (!ok) {
        onError(new Error(t('复制失败，请稍后重试。')))
        return
      }
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  const saveReport = async () => {
    if (!report || saving) return
    setSaving(true)
    try {
      const path = await window.pilot.saveSessionReport(sessionId)
      // null 表示用户在保存对话框里取消了，不是失败，什么都不提示。
      if (path) setSavedPath(path)
    } catch (error) {
      onError(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal report-modal"
        role="dialog"
        aria-label={t('会话报告')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t('会话报告')}</h2>
            <p>{t('这一轮改了什么、验证过没有；复制或存成 Markdown 交给别人看。')}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('关闭')}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body report-body">
          <SessionReportView report={report} loading={loading} />
        </div>

        <div className="modal-footer">
          <span className="settings-note">
            {savedPath ? t('已保存到 {v1}', { v1: savedPath }) : t('报告只读，不含任何凭据。')}
          </span>
          <div className="modal-actions">
            <button
              type="button"
              className="button ghost"
              onClick={copyReport}
              disabled={!report}
            >
              {copied ? t('已复制') : t('复制 Markdown')}
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => void saveReport()}
              disabled={!report || saving}
            >
              {saving ? t('保存中…') : t('保存为 Markdown')}
            </button>
            <button type="button" className="button primary" onClick={onClose}>
              {t('关闭')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
