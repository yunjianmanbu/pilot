import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MODULE_INTERVAL_CHOICES,
  type ModuleCheckReport,
  type ModuleCheckState,
  type ModuleRisk,
  type ModuleTarget,
} from '../../../shared/module-check'
import { ListCheckIcon, RefreshIcon } from '../icons'
import { t } from '../i18n'
import { SelectMenu } from './SelectMenu'

/**
 * 模块自检页面。
 *
 * 一次自检分两步，刻意分开：扫描是只读且可重复的（随时点“立即自检”），
 * 修改必须由用户逐条勾选后确认。页面不会自动“帮你修”，避免把一份没看过的
 * 建议清单直接变成对工作区的写入。
 */

interface ModuleCheckPanelProps {
  onOpenSession: (sessionId: string) => void
  onError: (message: string) => void
}

const SEVERITY_CLASS: Record<ModuleRisk['severity'], string> = {
  high: 'is-high',
  medium: 'is-medium',
  low: 'is-low',
}

/** 严重程度只用字面量，保证英文字典能静态识别到这些键。 */
function severityText(severity: ModuleRisk['severity']): string {
  if (severity === 'high') return t('高')
  if (severity === 'medium') return t('中')
  return t('低')
}

function ruleText(risk: ModuleRisk): string {
  switch (risk.rule) {
    case 'oversized-file':
      return t('超大文件')
    case 'todo-backlog':
      return t('待办积压')
    case 'debug-logging':
      return t('调试输出')
    case 'missing-tests':
      return t('缺少测试')
    case 'hardcoded-path':
      return t('硬编码路径')
    case 'secret-like':
      return t('疑似凭据')
    case 'duplicate-file':
      return t('重复文件')
    case 'missing-verification-script':
      return t('缺少验证脚本')
    default:
      return risk.rule
  }
}

function intervalLabel(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24
    return days === 1 ? t('每天') : t('每 {v1} 天', { v1: days })
  }
  return t('每 {v1} 小时', { v1: hours })
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

export function ModuleCheckPanel({ onOpenSession, onError }: ModuleCheckPanelProps) {
  const [state, setState] = useState<ModuleCheckState | null>(null)
  const [modules, setModules] = useState<ModuleTarget[]>([])
  const [scanned, setScanned] = useState<string[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'load' | 'discover' | 'run' | 'accept' | ''>('load')
  const [error, setError] = useState('')
  const [acceptedSession, setAcceptedSession] = useState('')
  const [queued, setQueued] = useState(false)
  /** 用户显式勾选「允许改我自己的源码」。默认关闭，读取、自检、生成提案都不会打开它。 */
  const [selfModify, setSelfModify] = useState(false)
  const [proposalId, setProposalId] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const report: ModuleCheckReport | null = state?.lastReport ?? null

  const load = useCallback(async () => {
    setBusy('load')
    setError('')
    try {
      const [next, discovered] = await Promise.all([
        window.pilot.moduleCheckState(),
        window.pilot.moduleCheckDiscover(),
      ])
      if (!mounted.current) return
      setState(next)
      setModules(discovered)
      const configured = next.settings.modules.filter((id) =>
        discovered.some((target) => target.id === id),
      )
      setScanned(configured.length > 0 ? configured : discovered.map((target) => target.id))
    } catch (reason) {
      if (!mounted.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      onError(message)
    } finally {
      if (mounted.current) setBusy('')
    }
  }, [onError])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(async () => {
    setBusy('run')
    setError('')
    setAcceptedSession('')
    try {
      const selection = scanned.length > 0 ? scanned : undefined
      const next = await window.pilot.moduleCheckRun(selection)
      if (!mounted.current) return
      const refreshed = await window.pilot.moduleCheckState()
      if (!mounted.current) return
      setState(refreshed)
      setPicked(new Set())
      if (next.risks.length === 0) {
        onError(t('本次自检没有发现风险点。'))
      }
    } catch (reason) {
      if (!mounted.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      onError(message)
    } finally {
      if (mounted.current) setBusy('')
    }
  }, [scanned, onError])

  const changeSchedule = useCallback(
    async (enabled: boolean, hours?: number) => {
      setError('')
      try {
        const next = await window.pilot.moduleCheckSettings({
          enabled,
          ...(hours === undefined ? {} : { intervalHours: hours }),
        })
        if (mounted.current) setState(next)
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        onError(message)
      }
    },
    [onError],
  )

  const accept = useCallback(async () => {
    if (!report || picked.size === 0) return
    setBusy('accept')
    setError('')
    setQueued(false)
    try {
      const result = await window.pilot.moduleCheckAccept({
        reportId: report.id,
        riskIds: [...picked],
        // 只有用户真的勾选了自改，才把开关传给主进程；否则只生成提案。
        selfModify,
      })
      if (!mounted.current) return
      setProposalId(result.proposalId)
      setPicked(new Set())
      const refreshed = await window.pilot.moduleCheckState()
      if (mounted.current) setState(refreshed)
      if (!result.selfModify) {
        // 只生成了提案：不建会话、不跳转、不改任何文件。
        setAcceptedSession('')
        setSelfModify(false)
        return
      }
      setSelfModify(false)
      if (result.sessionId) {
        setAcceptedSession(result.sessionId)
        setQueued(result.queued === true)
        onOpenSession(result.sessionId)
      }
    } catch (reason) {
      if (!mounted.current) return
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      onError(message)
    } finally {
      if (mounted.current) setBusy('')
    }
  }, [report, picked, selfModify, onOpenSession, onError])

  const toggleModule = useCallback((id: string) => {
    setScanned((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }, [])

  const toggleRisk = useCallback((risk: ModuleRisk) => {
    if (risk.manual) return
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(risk.id)) next.delete(risk.id)
      else next.add(risk.id)
      return next
    })
  }, [])

  const selectable = useMemo(
    () => (report?.risks ?? []).filter((risk) => !risk.manual),
    [report],
  )
  const manualCount = (report?.risks.length ?? 0) - selectable.length
  const counts = useMemo(() => {
    const risks = report?.risks ?? []
    return {
      high: risks.filter((risk) => risk.severity === 'high').length,
      medium: risks.filter((risk) => risk.severity === 'medium').length,
      low: risks.filter((risk) => risk.severity === 'low').length,
    }
  }, [report])

  const intervalOptions = MODULE_INTERVAL_CHOICES.map((hours) => ({
    value: String(hours),
    label: intervalLabel(hours),
  }))

  return (
    <div className="page panel-page module-check-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <ListCheckIcon width={13} height={13} />
            {t("工程健康")}</div>
          <h1>{t("模块自检")}</h1>
          <p>
            {t("自检只读扫描 Pilot 内置源码里你勾选的模块，用固定规则列出风险点和优化建议。勾选后默认只生成改造提案，不改任何文件；只有勾选「自改」才会开启一个普通会话去改，写入仍受沙箱与审批约束。")}
          </p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{report ? report.score : '—'}</strong>
            <span>{t("健康分")}</span>
          </div>
          <div className="stat">
            <strong>{report ? report.risks.length : 0}</strong>
            <span>{t("风险点")}</span>
          </div>
          <div className="stat">
            <strong>{report ? report.scannedFiles : 0}</strong>
            <span>{t("已扫描文件")}</span>
          </div>
        </div>
      </div>

      {error ? <div className="module-check-error">{error}</div> : null}

      {/*
        自检始终扫内置源码，不是用户当前打开的工作区；把实际目录写出来，
        用户才不会把风险点当成自己项目的问题。
      */}
      {report?.workspace ? (
        <div className="module-check-note">
          {t("扫描目标：Pilot 内置源码（{v1}）。", { v1: report.workspace })}
        </div>
      ) : null}

      <section className="module-check-section">
        <div className="module-check-section-head">
          <div>
            <h2>{t("自检模块")}</h2>
            <p>
              {t("勾选要参与的模块；不勾选时默认自检全部。")}
              {modules.length > 0
                ? ` ${t("共 {v1} 个模块，已选 {v2} 个。", { v1: modules.length, v2: scanned.length })}`
                : ''}
            </p>
          </div>
          <div className="module-check-actions">
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                setScanned(modules.map((target) => target.id))
              }}
              disabled={busy !== '' || modules.length === 0}
            >
              {t("全选")}
            </button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                setScanned([])
              }}
              disabled={busy !== '' || modules.length === 0}
            >
              {t("清空")}
            </button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => void load()}
              disabled={busy !== ''}
              title={t("重新读取内置源码目录")}
            >
              <RefreshIcon width={14} height={14} />
              {t("重新扫描")}
            </button>
            <button
              type="button"
              className="button primary small"
              onClick={() => void run()}
              disabled={busy !== '' || modules.length === 0}
            >
              {busy === 'run' ? t("自检中…") : t("立即自检")}
            </button>
          </div>
        </div>

        {modules.length === 0 ? (
          <div className="empty-panel">
            {t("内置源码里没有发现可自检的模块。")}
          </div>
        ) : (
          <div className="module-check-grid">
            {modules.map((target) => {
              const active = scanned.includes(target.id)
              return (
                <label
                  key={target.id}
                  className={`module-check-card${active ? ' is-active' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleModule(target.id)}
                  />
                  <div className="module-check-card-body">
                    <strong>{target.path || '/'}</strong>
                    <span>
                      {t("{v1} 个文件 · {v2} 个源文件", {
                        v1: target.files,
                        v2: target.sourceFiles,
                      })}
                      {target.testFiles > 0 ? ` · ${t("{v1} 个测试", { v1: target.testFiles })}` : ''}
                    </span>
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </section>

      <section className="module-check-section">
        <div className="module-check-section-head">
          <div>
            <h2>{t("定期自检")}</h2>
            <p>
              {state?.settings.enabled
                ? t("已开启 · 下次 {v1}", { v1: formatTime(state.nextRunAt) })
                : t("关闭时只在手动点击时扫描。开启后按间隔在后台用同一套规则扫描已选模块。")}
            </p>
          </div>
          <div className="module-check-actions">
            <SelectMenu
              value={String(state?.settings.intervalHours ?? 24)}
              options={intervalOptions}
              onChange={(value) => void changeSchedule(state?.settings.enabled ?? false, Number(value))}
              ariaLabel={t("自检间隔")}
              className="module-check-interval"
            />
            <button
              type="button"
              className={state?.settings.enabled ? 'button ghost small' : 'button primary small'}
              onClick={() => void changeSchedule(!(state?.settings.enabled ?? false))}
              disabled={busy !== ''}
            >
              {state?.settings.enabled ? t("关闭定期自检") : t("开启定期自检")}
            </button>
          </div>
        </div>
        <div className="module-check-meta">
          {t("上次自检：{v1}", { v1: formatTime(state?.lastRunAt) })}
          {report ? ` · ${t("扫描 {v1} 个文件 / {v2} 行", { v1: report.scannedFiles, v2: report.scannedLines })}` : ''}
          {report ? ` · ${t("触发方式：{v1}", { v1: report.trigger === 'schedule' ? t("定期") : t("手动") })}` : ''}
        </div>
      </section>

      <section className="module-check-section">
        <div className="module-check-section-head">
          <div>
            <h2>{t("风险点与建议")}</h2>
            <p>
              {report
                ? t("高 {v1} · 中 {v2} · 低 {v3}。勾选条目后可直接生成提案，或勾选「自改」后执行。", {
                    v1: counts.high,
                    v2: counts.medium,
                    v3: counts.low,
                  })
                : t("还没有自检报告。点「立即自检」生成第一份。")}
            </p>
          </div>
          {report ? (
            <div className="module-check-actions">
              <button
                type="button"
                className="button ghost small"
                onClick={() => setPicked(new Set(selectable.map((risk) => risk.id)))}
                disabled={busy !== '' || selectable.length === 0}
              >
                {t("全选可优化项")}
              </button>
              <label className="module-check-selfmodify">
                <input
                  type="checkbox"
                  checked={selfModify}
                  disabled={busy !== '' || picked.size === 0}
                  onChange={(event) => setSelfModify(event.target.checked)}
                />
                {t("允许直接修改 Pilot 自己的源码（自改）")}
              </label>
              <button
                type="button"
                className="button primary small"
                onClick={() => void accept()}
                disabled={busy !== '' || picked.size === 0}
              >
                {busy === 'accept'
                  ? t("正在处理…")
                  : selfModify
                    ? t("开始自改（{v1} 项）", { v1: picked.size })
                    : t("生成改造提案（{v1} 项）", { v1: picked.size })}
              </button>
            </div>
          ) : null}
          {report ? (
            <p className="module-check-note">
              {selfModify
                ? t("自改会真的改源码：会话结束后会自动重跑一次自检，用新报告刷新提案。")
                : t("不勾选「自改」时只生成提案，不会修改任何文件。")}
            </p>
          ) : null}
        </div>

        {acceptedSession ? (
          <div className="module-check-accepted">
            {queued
              ? t("已创建修复会话，优化清单在会话队列里：配置模型后发送即可。")
              : t("已创建修复会话，正在切换过去。")}
            <button type="button" className="link-btn" onClick={() => onOpenSession(acceptedSession)}>
              {t("打开会话")}
            </button>
          </div>
        ) : null}

        {proposalId && !acceptedSession ? (
          <div className="module-check-accepted">
            {t("已生成改造提案（{v1}），未修改任何文件。勾选「自改」后才会真正执行。", {
              v1: proposalId,
            })}
          </div>
        ) : null}

        {state && state.proposals.length > 0 && state.proposals[0] ? (
          <details className="module-check-proposal">
            <summary>
              {t("最近一份改造提案：{v1}（{v2} 项）", {
                v1: formatTime(state.proposals[0].createdAt),
                v2: state.proposals[0].riskIds.length,
              })}
              {state.proposals[0].refreshedAt ? t(" · 已按最新自检刷新") : ''}
            </summary>
            <pre className="module-check-proposal-body">{state.proposals[0].prompt}</pre>
          </details>
        ) : null}

        {report && report.risks.length === 0 ? (
          <div className="empty-panel">{t("没有发现风险点。")}</div>
        ) : null}

        {report && report.risks.length > 0 ? (
          <div className="module-check-risks">
            {report.risks.map((risk) => {
              const checked = picked.has(risk.id)
              return (
                <article
                  key={risk.id}
                  className={`module-check-risk${checked ? ' is-picked' : ''}${risk.manual ? ' is-manual' : ''}`}
                >
                  <label className="module-check-risk-head">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={risk.manual}
                      onChange={() => toggleRisk(risk)}
                    />
                    <span className={`severity-chip ${SEVERITY_CLASS[risk.severity]}`}>
                      {severityText(risk.severity)}
                    </span>
                    <span className="module-check-risk-title">{risk.title}</span>
                    <span className="module-check-risk-module">
                      {ruleText(risk)} · {risk.moduleName}
                    </span>
                  </label>
                  <p className="module-check-risk-detail">{risk.detail}</p>
                  <p className="module-check-risk-fix">
                    <strong>{t("建议")}</strong>
                    {risk.recommendation}
                  </p>
                  {risk.evidence.length > 0 ? (
                    <ul className="module-check-evidence">
                      {risk.evidence.map((item) => (
                        <li key={item}>
                          <code>{item}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {risk.manual ? (
                    <div className="module-check-manual-note">
                      {t("该项已标记为人工处理，自检不会自动修改。")}
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>
        ) : null}

        {manualCount > 0 ? (
          <div className="module-check-note">
            {t("{v1} 项需要人工处理（例如疑似凭据），自检不会把它们交给会话自动修改。", { v1: manualCount })}
          </div>
        ) : null}

        {state && state.decisions.length > 0 && state.decisions[0] ? (
          <div className="module-check-note">
            {state.decisions[0].selfModify
              ? t("最近一次自改：{v1}（会话 {v2}）", {
                  v1: formatTime(state.decisions[0].at),
                  v2: state.decisions[0].sessionId ?? '—',
                })
              : t("最近一次提案：{v1}（未修改任何文件）", {
                  v1: formatTime(state.decisions[0].at),
                })}
          </div>
        ) : null}
      </section>
    </div>
  )
}
