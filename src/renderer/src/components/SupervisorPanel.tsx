import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SUPERVISOR_MAX_INTERVAL_MINUTES,
  SUPERVISOR_MIN_INTERVAL_MINUTES,
  SUPERVISOR_WINDOW_MS,
  type SupervisorAction,
  type SupervisorFinding,
  type SupervisorRound,
  type SupervisorSettings,
  type SupervisorState,
} from '../../../shared/supervisor'
import { PlayIcon, RefreshIcon } from '../icons'
import { t } from '../i18n'
import { SelectMenu } from './SelectMenu'

/**
 * 自主优化闭环页面。
 *
 * 这一页只做三件事：说清「现在推断出了什么问题」、「这一轮动了没有、为什么」、
 * 「护栏参数是多少」。它不提供「一键全部自动修」——自动会话本身也照常走沙箱与审批，
 * 页面上任何开关都不会绕过那条链路。
 */

interface SupervisorPanelProps {
  onOpenSession: (sessionId: string) => void
  onError: (message: string) => void
}

const SEVERITY_CLASS: Record<SupervisorFinding['severity'], string> = {
  high: 'is-high',
  medium: 'is-medium',
  low: 'is-low',
}

/** 严重程度只用字面量，保证英文字典能静态识别到这些键。 */
function severityText(severity: SupervisorFinding['severity']): string {
  if (severity === 'high') return t('高')
  if (severity === 'medium') return t('中')
  return t('低')
}

function sourceText(source: SupervisorFinding['source']): string {
  if (source === 'runs') return t('运行记录')
  if (source === 'health') return t('内视')
  if (source === 'reflect') return t('反思')
  return t('源码自检')
}

function actionText(action: SupervisorAction): string {
  if (action.status === 'applied') return t('已开会话')
  if (action.status === 'error') return t('失败')
  return t('已跳过')
}

/** 信号标题来自 shared 层（纯逻辑，无 i18n），这里按 id 给出可翻译的名字。 */
function signalLabel(id: string, fallback: string): string {
  if (id === 'runs.sample') return t('可用运行样本')
  if (id === 'runs.success') return t('运行成功率')
  if (id === 'runs.steps') return t('平均步数')
  if (id === 'runs.tool-errors') return t('工具错误率')
  if (id === 'health.state') return t('内视异常')
  if (id === 'module.risks') return t('源码风险')
  if (id === 'reflect.findings') return t('反思发现')
  return fallback
}

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return days === 1 ? t('每天') : t('每 {v1} 天', { v1: days })
  }
  if (minutes % 60 === 0) return t('每 {v1} 小时', { v1: minutes / 60 })
  return t('每 {v1} 分钟', { v1: minutes })
}

function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const INTERVAL_CHOICES = [15, 30, 60, 180, 360, 720, 1440].filter(
  (minutes) =>
    minutes >= SUPERVISOR_MIN_INTERVAL_MINUTES && minutes <= SUPERVISOR_MAX_INTERVAL_MINUTES,
)

/** 24h 窗口内真正执行过的动作；与主进程的预算口径保持一致。 */
function usedBudget(history: SupervisorRound[]): { sessions: number; chars: number } {
  const from = Date.now() - SUPERVISOR_WINDOW_MS
  let sessions = 0
  let chars = 0
  for (const round of history) {
    for (const action of round.actions) {
      if (action.status !== 'applied') continue
      const at = Date.parse(action.at)
      if (Number.isFinite(at) && at >= from) {
        sessions += 1
        chars += action.chars ?? 0
      }
    }
  }
  return { sessions, chars }
}

export function SupervisorPanel({ onOpenSession, onError }: SupervisorPanelProps) {
  const [state, setState] = useState<SupervisorState | null>(null)
  const [busy, setBusy] = useState<'load' | 'run' | 'save' | ''>('load')
  const [error, setError] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const fail = useCallback(
    (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      if (!mounted.current) return
      setError(message)
      onError(message)
    },
    [onError],
  )

  const load = useCallback(async () => {
    setBusy('load')
    setError('')
    try {
      const next = await window.pilot.supervisorState()
      if (mounted.current) setState(next)
    } catch (reason) {
      fail(reason)
    } finally {
      if (mounted.current) setBusy('')
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(
    async (input: Partial<SupervisorSettings>) => {
      setBusy('save')
      setError('')
      try {
        const next = await window.pilot.supervisorSettings(input)
        if (mounted.current) setState(next)
      } catch (reason) {
        fail(reason)
      } finally {
        if (mounted.current) setBusy('')
      }
    },
    [fail],
  )

  const run = useCallback(async () => {
    setBusy('run')
    setError('')
    try {
      await window.pilot.supervisorRun()
      if (!mounted.current) return
      const next = await window.pilot.supervisorState()
      if (mounted.current) setState(next)
    } catch (reason) {
      fail(reason)
    } finally {
      if (mounted.current) setBusy('')
    }
  }, [fail])

  const round = state?.lastRound ?? null
  const settings = state?.settings
  const used = useMemo(() => usedBudget(state?.history ?? []), [state])
  const findings = round?.findings ?? []
  const actions = round?.actions ?? []
  const counts = useMemo(() => {
    return {
      high: findings.filter((item) => item.severity === 'high').length,
      manual: findings.filter((item) => item.manual).length,
      applied: actions.filter((item) => item.status === 'applied').length,
    }
  }, [findings, actions])

  const intervalOptions = INTERVAL_CHOICES.map((minutes) => ({
    value: String(minutes),
    label: intervalLabel(minutes),
  }))

  return (
    <div className="page panel-page supervisor-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <PlayIcon width={13} height={13} />
            {t('自主优化')}
          </div>
          <h1>{t('自主优化闭环')}</h1>
          <p>
            {t(
              'Pilot 定时把运行记录、内视结果、源码自检与反思结论汇总成一份信号清单，在护栏内只挑一件事，用普通会话去修。取舍类问题（页面设计、项目结构、交互体验、输出质量）只列不自动动手；开出来的会话照常走沙箱与审批，不打开「允许自动动手」时什么都不会改。',
            )}
          </p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{round ? round.score : '—'}</strong>
            <span>{t('健康分')}</span>
          </div>
          <div className="stat">
            <strong>{findings.length}</strong>
            <span>{t('待处理')}</span>
          </div>
          <div className="stat">
            <strong>
              {used.sessions}/{settings?.budget.sessionsPerDay ?? 0}
            </strong>
            <span>{t('今日已用')}</span>
          </div>
        </div>
      </div>

      {error ? <div className="module-check-error">{error}</div> : null}

      <section className="supervisor-section">
        <div className="supervisor-section-head">
          <div>
            <h2>{t('运行状态')}</h2>
            <p>
              {settings?.enabled
                ? t('已开启 · 下次 {v1}', { v1: formatTime(state?.nextRunAt) })
                : t('已关闭 · 关闭时只能手动跑一轮，且不会自动动手。')}
            </p>
          </div>
          <div className="supervisor-controls">
            <SelectMenu
              value={String(settings?.intervalMinutes ?? 180)}
              options={intervalOptions}
              onChange={(value) => void save({ intervalMinutes: Number(value) })}
              ariaLabel={t('优化间隔')}
              className="supervisor-interval"
              disabled={busy !== ''}
            />
            <button
              type="button"
              className={settings?.enabled ? 'button ghost small' : 'button primary small'}
              onClick={() => void save({ enabled: !(settings?.enabled ?? false) })}
              disabled={busy !== '' || !settings}
            >
              {settings?.enabled ? t('关闭定时优化') : t('开启定时优化')}
            </button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => void load()}
              disabled={busy !== ''}
              title={t('重新读取状态')}
            >
              <RefreshIcon width={14} height={14} />
              {t('刷新')}
            </button>
            <button
              type="button"
              className="button primary small"
              onClick={() => void run()}
              disabled={busy !== ''}
            >
              {busy === 'run' ? t('分析中…') : t('立即分析一轮')}
            </button>
          </div>
        </div>

        <div className="supervisor-meta">
          {t('上次分析：{v1}', { v1: formatTime(round?.finishedAt) })}
          {round
            ? ` · ${t('触发方式：{v1}', {
                v1: round.trigger === 'schedule' ? t('定时') : t('手动'),
              })}`
            : ''}
          {` · ${t('今日指令已用 {v1}/{v2} 字符', {
            v1: used.chars,
            v2: settings?.budget.charsPerDay ?? 0,
          })}`}
        </div>
      </section>

      <section className="supervisor-section">
        <div className="supervisor-section-head">
          <div>
            <h2>{t('护栏')}</h2>
            <p>
              {t(
                '两道开关都必须由你手动打开。每日预算按滚动的 24 小时统计：用完只出清单。同一项 24 小时内只自动处理一次，需要人判断的项永远不进自动队列；反思里的页面设计、项目结构、输出质量、交互体验四类就是只进清单不自动动手。',
              )}
            </p>
          </div>
        </div>
        <div className="supervisor-guards">
          <label className="supervisor-guard">
            <input
              type="checkbox"
              checked={settings?.enabled ?? false}
              disabled={busy !== '' || !settings}
              onChange={(event) => void save({ enabled: event.target.checked })}
            />
            <div>
              <strong>{t('按间隔自动分析')}</strong>
              <span>{t('只读采集信号并生成清单，不改任何文件。')}</span>
            </div>
          </label>
          <label className="supervisor-guard is-danger">
            <input
              type="checkbox"
              checked={settings?.apply ?? false}
              disabled={busy !== '' || !settings?.enabled}
              onChange={(event) => void save({ apply: event.target.checked })}
            />
            <div>
              <strong>{t('允许自动动手')}</strong>
              <span>
                {t(
                  '每轮最多开一个普通会话去修。审批策略、沙箱、权限规则都不受影响，被拒绝时这一轮只记失败。',
                )}
              </span>
            </div>
          </label>
          <label className="supervisor-guard">
            <div>
              <strong>{t('每日自动会话上限')}</strong>
              <span>{t('超出后只出清单，0 表示永不自动动手。')}</span>
            </div>
            <input
              type="number"
              min={0}
              max={10}
              value={settings?.budget.sessionsPerDay ?? 0}
              disabled={busy !== '' || !settings}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value)) return
                void save({ budget: { ...(settings?.budget ?? { sessionsPerDay: 0, charsPerDay: 0 }), sessionsPerDay: value } })
              }}
            />
          </label>
          <label className="supervisor-guard">
            <div>
              <strong>{t('每日指令字符上限')}</strong>
              <span>{t('单条指令超预算会被截断并标注。')}</span>
            </div>
            <input
              type="number"
              min={0}
              max={200000}
              step={1000}
              value={settings?.budget.charsPerDay ?? 0}
              disabled={busy !== '' || !settings}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value)) return
                void save({ budget: { ...(settings?.budget ?? { sessionsPerDay: 0, charsPerDay: 0 }), charsPerDay: value } })
              }}
            />
          </label>
        </div>
      </section>

      <section className="supervisor-section">
        <div className="supervisor-section-head">
          <div>
            <h2>{t('信号')}</h2>
            <p>{round ? round.note : t('还没有分析过。点「立即分析一轮」生成第一份信号。')}</p>
          </div>
        </div>
        {round && round.signals.length > 0 ? (
          <div className="supervisor-signals">
            {round.signals.map((signal) => (
              <div key={signal.id} className={`supervisor-signal is-${signal.level}`}>
                <span>{signalLabel(signal.id, signal.label)}</span>
                <strong>{signal.value}</strong>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-panel">{t('暂无信号。')}</div>
        )}
      </section>

      <section className="supervisor-section">
        <div className="supervisor-section-head">
          <div>
            <h2>{t('本轮发现')}</h2>
            <p>
              {round
                ? t('高 {v1} 项 · 需人工确认 {v2} 项 · 本轮动手 {v3} 次。', {
                    v1: counts.high,
                    v2: counts.manual,
                    v3: counts.applied,
                  })
                : t('这一块只列出结论与证据，不含被扫描文件的内容。')}
            </p>
          </div>
        </div>
        {findings.length === 0 ? (
          <div className="empty-panel">
            {round ? t('这一轮没有发现需要处理的信号。') : t('还没有分析结果。')}
          </div>
        ) : (
          <div className="supervisor-findings">
            {findings.map((item) => (
              <article
                key={item.id}
                className={`supervisor-finding${item.manual ? ' is-manual' : ''}`}
              >
                <div className="supervisor-finding-head">
                  <span className={`severity-chip ${SEVERITY_CLASS[item.severity]}`}>
                    {severityText(item.severity)}
                  </span>
                  <strong>{item.title}</strong>
                  <span className="supervisor-finding-source">{sourceText(item.source)}</span>
                  {item.manual ? (
                    <span className="supervisor-finding-manual">{t('需人工确认')}</span>
                  ) : null}
                </div>
                <p className="supervisor-finding-detail">{item.detail}</p>
                <p className="supervisor-finding-fix">
                  <strong>{t('建议')}</strong>
                  {item.suggestion}
                </p>
                {item.evidence.length > 0 ? (
                  <ul className="module-check-evidence">
                    {item.evidence.map((entry, index) => (
                      <li key={`${item.id}-${index}`}>
                        <code>{entry}</code>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="supervisor-section">
        <div className="supervisor-section-head">
          <div>
            <h2>{t('动作记录')}</h2>
            <p>{t('每一轮的动作都记账：为什么动手、为什么跳过、为什么失败。')}</p>
          </div>
        </div>
        {actions.length === 0 ? (
          <div className="empty-panel">{t('这一轮没有产生动作。')}</div>
        ) : (
          <div className="supervisor-actions">
            {actions.map((action, index) => (
              <div key={`${action.at}-${action.findingId}-${index}`} className={`supervisor-action is-${action.status}`}>
                <span className="supervisor-action-status">{actionText(action)}</span>
                <div className="supervisor-action-body">
                  <strong>{action.title}</strong>
                  {action.reason ? <span>{action.reason}</span> : null}
                  {typeof action.chars === 'number' ? (
                    <span className="supervisor-action-meta">
                      {t('指令 {v1} 字符', { v1: action.chars })}
                    </span>
                  ) : null}
                </div>
                {action.sessionId ? (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onOpenSession(action.sessionId as string)}
                  >
                    {t('打开会话')}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="supervisor-section">
        <div className="supervisor-section-head">
          <div>
            <h2>{t('历史轮次')}</h2>
            <p>{t('保留最近 {v1} 轮，供你回看健康分的变化。', { v1: state?.history.length ?? 0 })}</p>
          </div>
        </div>
        {state && state.history.length > 0 ? (
          <div className="supervisor-history">
            {state.history.map((item) => (
              <div key={item.id} className="supervisor-history-row">
                <span>{formatTime(item.finishedAt)}</span>
                <span>{item.trigger === 'schedule' ? t('定时') : t('手动')}</span>
                <span>{t('健康分 {v1}', { v1: item.score })}</span>
                <span>{t('{v1} 项信号', { v1: item.findings.length })}</span>
                <span>
                  {item.actions.filter((action) => action.status === 'applied').length > 0
                    ? t('动过手')
                    : t('未动手')}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-panel">{t('还没有历史轮次。')}</div>
        )}
      </section>
    </div>
  )
}
