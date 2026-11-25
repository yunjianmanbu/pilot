import { useEffect, useState } from 'react'
import type { DiagnosticsSnapshot, Session } from '../../../shared/types'
import { copyText } from '../clipboard'
import { t } from '../i18n'
import { XIcon } from '../icons'
import { STAGE_LABEL, isActiveStage, trailHint, type RunTrail } from '../run-trail'
import { useEscapeClose } from './useEscapeClose'

/**
 * 会话「卡点」面板：回答「这次运行现在停在哪一步、停了多久、该找谁」。
 *
 * 数据全部来自渲染进程已经在收的 `RunEvent`（轨迹）与一次只读的
 * `diagnosticsSnapshot`（主进程健康、副线队列）。面板自己不再拉会话正文，
 * 打开它不会给正在跑的运行增加负担。
 */

/** 面板只关心「谁在占着主线程」，所以只取快照里的这两项。 */
type HealthProbe = Pick<DiagnosticsSnapshot, 'health' | 'jobs' | 'running'>

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

export function RunTrailDialog({
  session,
  trail,
  running,
  onClose,
}: {
  session: Session
  /** 这个会话最近一次运行的轨迹；没跑过时为 undefined。 */
  trail?: RunTrail
  running: boolean
  onClose: () => void
}) {
  const [probe, setProbe] = useState<HealthProbe | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  useEscapeClose(onClose)

  // 一秒钟一次的本地计时只重画这一块；它不碰主进程，不产生 IPC。
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let alive = true
    void window.pilot
      .diagnosticsSnapshot(80)
      .then((snapshot) => {
        if (alive) setProbe({ health: snapshot.health, jobs: snapshot.jobs, running: snapshot.running })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const lag = probe?.health.lagMs ?? 0
  const stalled = lag >= 200 || (probe?.health.stallCount ?? 0) > 0
  // 主进程被堵和「在等模型」是两个完全不同的结论，面板必须先给出这个判断。
  const verdict = !running
    ? t('这个会话当前没有运行中的任务。')
    : stalled
      ? t('主进程自身有卡顿（延迟 {v1}），先看运行日志里的 runtime 事件。', {
          v1: duration(lag),
        })
      : t('主进程响应正常（延迟 {v1}），慢的地方在下面这个节点。', { v1: duration(lag) })

  const copyTrail = () => {
    if (!trail) return
    const lines = [
      `${session.title} / ${trail.runId}`,
      `阶段 ${STAGE_LABEL[trail.stage]} 已 ${duration(now - trail.stageSince)}`,
      ...trail.entries.map((entry) => `${time(entry.at)} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`),
    ]
    void copyText(lines.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal trail-modal"
        role="dialog"
        aria-label={t('对话卡点')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t('对话卡点')}</h2>
            <p>{t('看这次运行停在哪一步、停了多久；再决定是等、是停、还是去看日志。')}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('关闭')}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body trail-body">
          <div className={`trail-stage${stalled && running ? ' is-warn' : ''}`}>
            <div className="trail-stage-main">
              <span className="trail-stage-label">
                {trail ? t(STAGE_LABEL[trail.stage]) : running ? t('准备运行') : t('空闲')}
              </span>
              <strong className="trail-stage-time">
                {trail && running ? duration(now - trail.stageSince) : trail ? t('已结束') : '—'}
              </strong>
            </div>
            <p className="trail-hint">{trail ? trailHint(trail, now) : verdict}</p>
            {stalled && running ? <p className="trail-warn">{verdict}</p> : null}
            {trail && isActiveStage(trail.stage) && trail.status === undefined ? (
              <p className="trail-muted">
                {t('第 {v1} 步 · 已调用工具 {v2} 次', {
                  v1: String(trail.step || 1),
                  v2: String(trail.toolCalls),
                })}
              </p>
            ) : null}
            {trail?.error ? <p className="trail-warn">{trail.error}</p> : null}
          </div>

          <div className="settings-subhead">
            <strong>{t('节点轨迹')}</strong>
            <span>{t('新的在上；每一步都带时间，可用来判断是哪一段突然不动了')}</span>
          </div>
          {trail && trail.entries.length > 0 ? (
            <div className="trail-list">
              {trail.entries.map((entry, index) => (
                <div className="trail-row" key={`${entry.at}-${index}`}>
                  <span className="trail-row-time">{time(entry.at)}</span>
                  <span className="trail-row-label">{entry.label}</span>
                  {entry.detail ? <span className="trail-row-detail">{entry.detail}</span> : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-hint">
              {t('还没有事件。运行一次任务后这里会逐条记下每个节点。')}
            </p>
          )}

          <div className="settings-subhead">
            <strong>{t('同一时刻的其他负载')}</strong>
            <span>{t('副线任务不会阻塞对话，但能解释「为什么慢了一点」')}</span>
          </div>
          {probe && probe.jobs.length > 0 ? (
            <div className="trail-list">
              {probe.jobs.slice(0, 6).map((job) => (
                <div className="trail-row" key={`${job.name}-${job.queuedAt}`}>
                  <span className="trail-row-time">{job.state}</span>
                  <span className="trail-row-label">{job.name}</span>
                  <span className="trail-row-detail">
                    {job.durationMs === undefined
                      ? t('排队中')
                      : t('用时 {v1}', { v1: duration(job.durationMs) })}
                    {job.deferrals > 0 ? t('，让路 {v1} 次', { v1: String(job.deferrals) }) : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-hint">{t('副线队列是空的。')}</p>
          )}
        </div>

        <div className="modal-footer">
          <span className="settings-note">
            {t('主进程延迟 {v1}，累计卡顿 {v2} 次。', {
              v1: duration(lag),
              v2: String(probe?.health.stallCount ?? 0),
            })}
          </span>
          <div className="modal-actions">
            <button type="button" className="button ghost" onClick={copyTrail} disabled={!trail}>
              {copied ? t('已复制') : t('复制轨迹')}
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
