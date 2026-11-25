import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppLogView, DiagnosticsSnapshot } from '../../../shared/types'
import { formatLogRecords } from '../../../shared/app-log-view'
import { copyText } from '../clipboard'
import { t } from '../i18n'

/**
 * 设置 →「运行日志」。
 *
 * 目的只有一个：**在主进程看起来「卡住」时，先分清是它在忙还是它在等。**
 * 面板把四件事并排放在首屏 —— 事件循环延迟、副线队列、进行中的运行、
 * 最近的错误聚合 —— 再看下面的明细。
 *
 * 拉取走一次 `diagnosticsSnapshot()`：四个 IPC 分开取会让面板自己变成
 * 一个新的 IO 竞争者，而这正是我们要排查的东西。
 */

type LevelFilter = 'all' | 'error' | 'warn' | 'info'

const LEVEL_LABEL: Record<LevelFilter, string> = {
  all: '全部',
  error: '错误',
  warn: '警告',
  info: '信息',
}

const JOB_STATE_LABEL: Record<string, string> = {
  running: '正在执行',
  deferred: '让路中',
  queued: '排队中',
  done: '已完成',
  failed: '失败',
  timeout: '超时',
  skipped: '已跳过',
}

function shortTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 毫秒转成「1.2 秒 / 3 分 20 秒」，面板里不出现裸数字。 */
function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

export function RuntimeLogPanel({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [logDir, setLogDir] = useState('')
  const [error, setError] = useState('')
  const [level, setLevel] = useState<LevelFilter>('all')
  const [area, setArea] = useState('')
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const [auto, setAuto] = useState(true)
  const mounted = useRef(true)

  const load = useCallback(async () => {
    try {
      const next = await window.pilot.diagnosticsSnapshot(200)
      if (!mounted.current) return
      setSnapshot(next)
      setError('')
    } catch (cause) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  useEffect(() => {
    void window.pilot
      .logDir()
      .then((value) => {
        if (mounted.current) setLogDir(value)
      })
      .catch(() => undefined)
  }, [])

  // 自动刷新只在面板可见时开：看到的是活数据，隐藏后不占主进程 IO。
  useEffect(() => {
    if (!auto) return
    const timer = setInterval(() => void load(), 4000)
    return () => clearInterval(timer)
  }, [auto, load])

  const health = snapshot?.health
  const stallRisk = (health?.lagMs ?? 0) >= 200 || (health?.stallCount ?? 0) > 0

  const records = useMemo(() => {
    const list = snapshot?.records ?? []
    const needle = query.trim().toLowerCase()
    return list.filter((record) => {
      if (level !== 'all' && record.level !== level) return false
      if (area && record.area !== area) return false
      if (!needle) return true
      return `${record.event} ${record.area} ${JSON.stringify(record.detail ?? {})}`
        .toLowerCase()
        .includes(needle)
    })
  }, [snapshot, level, area, query])

  const problems = useMemo(
    () => (snapshot?.groups ?? []).filter((group) => group.level !== 'info'),
    [snapshot],
  )

  const areas = useMemo(() => {
    const seen = new Set<string>()
    for (const record of snapshot?.records ?? []) seen.add(record.area)
    return [...seen].sort()
  }, [snapshot])

  const copyAll = () => {
    const text = formatLogRecords(records)
    void copyText(text || t('（没有匹配的日志）'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="runtime-log">
      <div className="settings-section-head">
        <div>
          <h3>{t('运行日志')}</h3>
          <p>
            {t(
              '主进程健康、副线队列、进行中的会话与最近日志都在这里。会话看起来「卡住」时，先看第一行：延迟和卡顿为 0 说明主进程没被堵，慢在模型或网络。',
            )}
          </p>
        </div>
        <div className="runtime-log-actions">
          <button type="button" className="button ghost small" onClick={() => void load()}>
            {t('刷新')}
          </button>
          <button
            type="button"
            className={`button ghost small${auto ? ' is-active' : ''}`}
            onClick={() => setAuto((current) => !current)}
            title={t('每 4 秒自动刷新，关闭后只看手动刷新结果')}
          >
            {auto ? t('自动刷新中') : t('已暂停刷新')}
          </button>
        </div>
      </div>

      {error ? (
        <div className="settings-error">{t('读取运行状态失败：{v1}', { v1: error })}</div>
      ) : null}

      <div className="diag-cards">
        <div className={`diag-card${stallRisk ? ' is-warn' : ''}`}>
          <span>{t('事件循环延迟')}</span>
          <strong>{health ? `${Math.round(health.lagMs)} 毫秒` : '—'}</strong>
          <em>
            {health
              ? t('最差 {v1}，累计卡顿 {v2} 次', {
                  v1: duration(health.worstLagMs),
                  v2: String(health.stallCount),
                })
              : ''}
          </em>
        </div>
        <div className="diag-card">
          <span>{t('主进程已运行')}</span>
          <strong>{health ? duration(health.uptimeMs) : '—'}</strong>
          <em>{health ? t('启动于 {v1}', { v1: shortTime(health.startedAt) }) : ''}</em>
        </div>
        <div className={`diag-card${(snapshot?.jobs.length ?? 0) > 0 ? ' is-warn' : ''}`}>
          <span>{t('副线队列')}</span>
          <strong>{snapshot ? String(snapshot.jobs.length) : '—'}</strong>
          <em>{t('同一时刻只跑一个，有会话时主动让路')}</em>
        </div>
        <div className={`diag-card${(snapshot?.running.length ?? 0) > 0 ? ' is-warn' : ''}`}>
          <span>{t('进行中的会话')}</span>
          <strong>{snapshot ? String(snapshot.running.length) : '—'}</strong>
          <em>{t('按启动时间，最久的在最前')}</em>
        </div>
      </div>

      <div className="settings-subhead">
        <strong>{t('正在跑什么')}</strong>
        <span>{t('副线任务与对话并行，任一副线阻塞都不会挡住对话')}</span>
      </div>

      {snapshot && snapshot.running.length > 0 ? (
        <div className="diag-table">
          {snapshot.running.map((run) => (
            <div className="diag-row" key={run.runId}>
              <div className="diag-row-main">
                <strong>{run.sessionTitle || t('未命名会话')}</strong>
                <span className="diag-muted">
                  {t('已运行 {v1}', { v1: duration(run.elapsedMs) })}
                </span>
              </div>
              <div className="diag-row-detail">{run.instruction}</div>
              {onOpenSession ? (
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => onOpenSession(run.sessionId)}
                >
                  {t('查看卡点')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="settings-hint">{t('当前没有进行中的会话。')}</p>
      )}

      {snapshot && snapshot.jobs.length > 0 ? (
        <div className="diag-table">
          {snapshot.jobs.slice(0, 12).map((job) => (
            <div className="diag-row" key={`${job.name}-${job.queuedAt}`}>
              <div className="diag-row-main">
                <strong>{job.name}</strong>
                <span className={`diag-badge level-${job.state === 'failed' || job.state === 'timeout' ? 'error' : job.state === 'deferred' ? 'warn' : 'info'}`}>
                  {JOB_STATE_LABEL[job.state] ?? job.state}
                </span>
                <span className="diag-muted">
                  {job.durationMs === undefined ? t('排队于 {v1}', { v1: shortTime(job.queuedAt) }) : duration(job.durationMs)}
                  {job.deferrals > 0 ? t('，让路 {v1} 次', { v1: String(job.deferrals) }) : ''}
                </span>
              </div>
              {job.error ? <div className="diag-row-detail">{job.error}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="settings-subhead">
        <strong>{t('问题聚合')}</strong>
        <span>{t('最近 {v1} 条日志按领域与事件归并，先看这里再翻明细', { v1: String(snapshot?.scanned ?? 0) })}</span>
      </div>

      {problems.length > 0 ? (
        <div className="diag-table">
          {problems.slice(0, 10).map((group) => (
            <button
              type="button"
              className="diag-row diag-row-button"
              key={`${group.level}-${group.area}-${group.event}`}
              onClick={() => {
                setLevel(group.level)
                setArea(group.area)
                setQuery(group.event)
              }}
            >
              <div className="diag-row-main">
                <span className={`diag-badge level-${group.level}`}>{group.level}</span>
                <strong>{group.event}</strong>
                <span className="diag-muted">
                  {t('{v1} 次', { v1: String(group.count) })} · {group.area} · {shortTime(group.lastAt)}
                </span>
              </div>
              {group.lastDetail ? (
                <div className="diag-row-detail">{JSON.stringify(group.lastDetail).slice(0, 220)}</div>
              ) : null}
            </button>
          ))}
        </div>
      ) : (
        <p className="settings-hint">{t('最近日志里没有错误或警告。')}</p>
      )}

      <div className="settings-subhead">
        <strong>{t('日志明细')}</strong>
        <span>{t('写盘前已脱敏；正文与密钥不会出现在这里')}</span>
      </div>

      <div className="runtime-log-filters">
        <div className="runtime-log-levels">
          {(['all', 'error', 'warn', 'info'] as LevelFilter[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`diag-filter${level === id ? ' is-active' : ''}`}
              onClick={() => setLevel(id)}
            >
              {t(LEVEL_LABEL[id])}
            </button>
          ))}
        </div>
        <select
          className="text-input runtime-log-area"
          value={area}
          onChange={(event) => setArea(event.target.value)}
          aria-label={t('按领域筛选')}
        >
          <option value="">{t('全部领域')}</option>
          {areas.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input
          className="text-input runtime-log-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('搜索事件或细节')}
        />
        <button type="button" className="button ghost small" onClick={copyAll}>
          {copied ? t('已复制') : t('复制日志')}
        </button>
        <button
          type="button"
          className="button ghost small"
          onClick={() => void window.pilot.openLogs().catch(() => undefined)}
          disabled={!logDir}
          title={logDir}
        >
          {t('打开日志目录')}
        </button>
      </div>

      <div className="diag-log">
        {records.length > 0 ? (
          records.map((record, index) => <LogLine key={`${record.at}-${index}`} record={record} />)
        ) : (
          <p className="settings-hint">{t('没有匹配的日志。')}</p>
        )}
      </div>
      {records.length > 0 ? (
        <p className="settings-note">{t('显示最近 {v1} 条（共扫描 {v2} 条）。', {
          v1: String(records.length),
          v2: String(snapshot?.scanned ?? 0),
        })}</p>
      ) : null}
    </div>
  )
}

function LogLine({ record }: { record: AppLogView }) {
  const detail = record.detail && Object.keys(record.detail).length > 0 ? record.detail : null
  return (
    <div className={`diag-log-line level-${record.level}`}>
      <span className="diag-log-time">{shortTime(record.at)}</span>
      <span className={`diag-badge level-${record.level}`}>{record.level}</span>
      <span className="diag-log-area">{record.area}</span>
      <span className="diag-log-event">{record.event}</span>
      {detail ? <span className="diag-log-detail">{JSON.stringify(detail).slice(0, 400)}</span> : null}
    </div>
  )
}
