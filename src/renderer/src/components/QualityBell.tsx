import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { QualityCandidate, QualityState, QualityPublishTarget } from '../../../shared/types'
import { bellCount } from '../../../shared/quality'
import { t } from '../i18n'
import { BellIcon, CheckIcon, RefreshIcon, XIcon } from '../icons'

const TARGET_LABEL: Record<QualityPublishTarget, string> = {
  none: '不自动打包',
  'package:dir': '打包到目录（package:dir）',
  'package:win': '打包 Windows（package:win）',
  'package:mac': '打包 macOS（package:mac）',
  'package:linux': '打包 Linux（package:linux）',
}

function statusLabel(candidate: QualityCandidate): string {
  switch (candidate.status) {
    case 'recorded':
      return t('已记录（未超过基线）')
    case 'awaiting_user':
      return t('等待你授权')
    case 'approved':
      return t('已批准，待打包')
    case 'rejected':
      return t('已拒绝')
    case 'publishing':
      return t('打包中…')
    case 'published':
      return t('已打包发布')
    default:
      return t('打包失败')
  }
}

function scoreTone(total: number): string {
  if (total >= 80) return 'pass'
  if (total >= 60) return 'warn'
  return 'bad'
}

export interface QualityBellProps {
  workspacePath: string | null
  state: QualityState | null
  publishTarget: QualityPublishTarget
  busy: boolean
  onDecide: (candidateId: string, decision: 'approve' | 'reject') => void
  onPublish: (candidateId: string) => void
  onEvaluate: () => void
  onTune: () => void
  onOpenChange?: (open: boolean) => void
}

export interface QualityBellPanelProps {
  state: QualityState
  publishTarget: QualityPublishTarget
  busy: boolean
  onDecide: (candidateId: string, decision: 'approve' | 'reject') => void
  onPublish: (candidateId: string) => void
  onEvaluate: () => void
  onTune: () => void
}

/**
 * 铃铛弹层本体。单独导出让渲染测试能直接断言用户看到的那份文案：
 * 待授权的候选必须同时给出分数、差值、理由和两个决策按钮。
 */
export function QualityBellPanel({
  state,
  publishTarget,
  busy,
  onDecide,
  onPublish,
  onEvaluate,
  onTune,
}: QualityBellPanelProps): ReactElement {
  const candidates = [...state.candidates].sort((left, right) => {
    const rank = (candidate: QualityCandidate): number =>
      candidate.status === 'awaiting_user' ? 0 : candidate.status === 'approved' ? 1 : 2
    return rank(left) - rank(right) || right.version - left.version
  })
  const current = state.baseline
  const target = TARGET_LABEL[publishTarget] ?? publishTarget

  return (
    <div className="quality-pop" role="dialog" aria-label={t('产出质量')}>
      <header className="quality-pop-head">
        <div>
          <strong>{t('产出质量')}</strong>
          <span className="quality-pop-sub">
            {current
              ? t('现行版本 {v1} 分 · 指标集 v{v2}', {
                  v1: current.total,
                  v2: state.metricSet.version,
                })
              : t('尚未建立基线：下一次评估将成为基线')}
          </span>
        </div>
        <div className="quality-pop-actions">
          <button type="button" className="button ghost small" onClick={onEvaluate} disabled={busy}>
            <RefreshIcon width={13} height={13} />
            {t('立即评估')}
          </button>
          <button type="button" className="button ghost small" onClick={onTune} disabled={busy}>
            {t('重调指标')}
          </button>
        </div>
      </header>

      {current ? (
        <div className="quality-metrics">
          {current.metrics.map((metric) => (
            <div key={metric.id} className="quality-metric">
              <span className="quality-metric-label">
                {metric.label}
                <em>{metric.weight}%</em>
              </span>
              <div className="quality-metric-track">
                <i
                  className={`quality-metric-fill tone-${scoreTone(metric.value)}`}
                  style={{ width: `${Math.max(2, metric.value)}%` }}
                />
              </div>
              <span className="quality-metric-value">{Math.round(metric.value)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="quality-pop-body">
        {candidates.length === 0 ? (
          <p className="quality-empty">
            {t('还没有候选版本。点“立即评估”用配置的评估模型给当前产出打分。')}
          </p>
        ) : (
          candidates.map((candidate) => (
            <article key={candidate.id} className={`quality-candidate status-${candidate.status}`}>
              <div className="quality-candidate-head">
                <strong>
                  {t('候选 #{v1}', { v1: candidate.version })}
                  <span className={`quality-score tone-${scoreTone(candidate.score.total)}`}>
                    {candidate.score.total}
                  </span>
                  {candidate.baseline ? (
                    <span className="quality-delta">
                      {candidate.comparison.delta >= 0 ? '+' : ''}
                      {candidate.comparison.delta}
                    </span>
                  ) : null}
                </strong>
                <span className={`quality-status status-${candidate.status}`}>
                  {statusLabel(candidate)}
                </span>
              </div>
              <p className="quality-reason">{candidate.comparison.reason}</p>
              {candidate.verdict ? <p className="quality-verdict">“{candidate.verdict}”</p> : null}
              {candidate.status === 'awaiting_user' ? (
                <div className="quality-candidate-actions">
                  <button
                    type="button"
                    className="button primary small"
                    disabled={busy}
                    onClick={() => onDecide(candidate.id, 'approve')}
                    title={
                      publishTarget === 'none'
                        ? t('批准后会更新质量基线；未配置打包目标，不会自动打包')
                        : t('批准后更新基线，并用 {v1} 打包发布', { v1: target })
                    }
                  >
                    <CheckIcon width={13} height={13} />
                    {publishTarget === 'none' ? t('批准（仅更新基线）') : t('批准并打包发布')}
                  </button>
                  <button
                    type="button"
                    className="button ghost small"
                    disabled={busy}
                    onClick={() => onDecide(candidate.id, 'reject')}
                  >
                    <XIcon width={13} height={13} />
                    {t('拒绝')}
                  </button>
                </div>
              ) : null}
              {candidate.status === 'approved' ? (
                <div className="quality-candidate-actions">
                  <button
                    type="button"
                    className="button primary small"
                    disabled={busy || publishTarget === 'none'}
                    onClick={() => onPublish(candidate.id)}
                  >
                    {publishTarget === 'none' ? t('先在设置里选择打包目标') : t('开始打包')}
                  </button>
                </div>
              ) : null}
              {candidate.failure ? <p className="quality-failure">{candidate.failure}</p> : null}
              {candidate.log.length > 0 ? (
                <details className="quality-log">
                  <summary>{t('评估记录')}</summary>
                  {/* Tail, not head: the cost and judge-scope lines are appended
                      after the outcome, and they are the ones a user opens this for. */}
                  {candidate.log.slice(-8).map((line, index) => (
                    <p key={`${candidate.id}-log-${index}`}>{line}</p>
                  ))}
                </details>
              ) : null}
            </article>
          ))
        )}
      </div>

      <footer className="quality-pop-foot">
        <span>
          {t('评估模型评分 + 运行记录统计；权重随评估自动调优（指标集 v{v1}）', {
            v1: state.metricSet.version,
          })}
        </span>
        <span className="quality-target">{target}</span>
      </footer>
    </div>
  )
}

/**
 * App 里的小铃铛。
 *
 * 它只做一件事：把「评估模型认为有更优版本」变成用户眼前的一个数字和一次决策。
 * 批准之前不会打包，拒绝之后基线不动——所有按钮都只调用主进程的白名单接口。
 */
export function QualityBell({
  workspacePath,
  state,
  publishTarget,
  busy,
  onDecide,
  onPublish,
  onEvaluate,
  onTune,
  onOpenChange,
}: QualityBellProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])

  if (!workspacePath || !state) return null

  const pending = bellCount(state)
  const current = state.baseline
  return (
    <div className="quality-bell" ref={rootRef}>
      <button
        type="button"
        className={`topbar-icon quality-bell-button${pending > 0 ? ' alert' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title={
          pending > 0
            ? t('{v1} 个更优版本等待授权', { v1: pending })
            : current
              ? t('产出质量 {v1} 分（点击查看评估指标）', { v1: current.total })
              : t('产出质量闸门：尚未建立基线')
        }
        aria-label={t('产出质量与更优版本')}
        aria-expanded={open}
      >
        <BellIcon width={16} height={16} />
        {pending > 0 ? <span className="quality-bell-badge">{pending}</span> : null}
      </button>

      {open ? (
        <QualityBellPanel
          state={state}
          publishTarget={publishTarget}
          busy={busy}
          onDecide={onDecide}
          onPublish={onPublish}
          onEvaluate={onEvaluate}
          onTune={onTune}
        />
      ) : null}
    </div>
  )
}
