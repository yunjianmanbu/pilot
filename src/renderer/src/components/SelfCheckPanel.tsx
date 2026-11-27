import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SELF_CHECK_GROUPS,
  renderSelfCheckText,
  sanitizeSelfCheckReport,
  sortSelfCheckItems,
  worstSelfCheckStatus,
  type SelfCheckGroup,
  type SelfCheckItem,
  type SelfCheckReport,
  type SelfCheckStatus,
} from '../../../shared/self-check'
import { copyText } from '../clipboard'
import { DownloadIcon, ListCheckIcon, RefreshIcon } from '../icons'
import { formatBytes } from '../../../shared/system-info'
import { diagnosticsExportOutcome } from '../../../shared/diagnostics-bundle'
import { t } from '../i18n'

/**
 * 内视页面：只看 Pilot 自己，不接收工作区路径。
 *
 * 页面本身不做判断，只负责「取样一次 → 按分组摊开 → 允许复制全文」。
 * 判定规则放在 shared/self-check.ts，主进程取样，渲染层不重新解释状态。
 */

interface SelfCheckPanelProps {
  onError: (message: string) => void
}

const STATUS_CLASS: Record<SelfCheckStatus, string> = {
  ok: 'is-ok',
  warn: 'is-warn',
  off: 'is-off',
  broken: 'is-broken',
}

const STATUS_CHIPS: readonly SelfCheckStatus[] = ['ok', 'warn', 'off', 'broken']

/** 状态词用字面量交给 t()，英文字典才能静态识别到这些键。 */
function statusText(status: SelfCheckStatus): string {
  switch (status) {
    case 'ok':
      return t('正常')
    case 'warn':
      return t('注意')
    case 'off':
      return t('未启用')
    case 'broken':
      return t('异常')
  }
}

function groupText(group: SelfCheckGroup): string {
  switch (group) {
    case 'runtime':
      return t('运行时')
    case 'model':
      return t('模型与策略')
    case 'exec':
      return t('执行')
    case 'ext':
      return t('扩展')
    case 'data':
      return t('数据与同步')
  }
}

function ItemCard({ item }: { item: SelfCheckItem }) {
  return (
    <article className={`self-check-item ${STATUS_CLASS[item.status]}`}>
      <header className="self-check-item-head">
        <span className={`self-check-badge ${STATUS_CLASS[item.status]}`}>
          {statusText(item.status)}
        </span>
        {/* 标题是中文原文，英文缺词条时原样回落。 */}
        <h3>{t(item.title)}</h3>
        <span className="self-check-detail">{item.detail}</span>
      </header>
      {item.facts.length > 0 ? (
        <ul className="self-check-facts">
          {item.facts.map((fact, index) => (
            <li key={`${item.id}-${index}`}>{fact}</li>
          ))}
        </ul>
      ) : null}
      {item.hint ? (
        <p className="self-check-hint">
          {t('建议')}：{item.hint}
        </p>
      ) : null}
    </article>
  )
}

/**
 * 导出成功后的回执。
 *
 * 单独抽成组件是有原因的：这个状态原来只在 `useState` 里设值、没人渲染，
 * 结果就是「点了按钮、包已落盘、界面却没有一个字」——用户只会再点一次。
 * 拆出来后测试能直接断言它真的产出可见文本，面板只负责条件挂载。
 */
export function SelfCheckExportReceipt({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <span className="self-check-stamp self-check-export-note" role="status">
      {text}
    </span>
  )
}

export function SelfCheckPanel({ onError }: SelfCheckPanelProps) {
  const [report, setReport] = useState<SelfCheckReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const run = useCallback(async () => {
    setBusy(true)
    // 重新内视就是新一轮取样，上一次的导出回执不再对应这份报告，一并清掉。
    setExportResult(null)
    try {
      const safe = sanitizeSelfCheckReport(await window.pilot.selfCheck())
      if (!safe) throw new Error('内视结果格式不对')
      setReport(safe)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [onError])

  useEffect(() => {
    void run()
  }, [run])

  const items = useMemo(() => (report ? sortSelfCheckItems(report.items) : []), [report])
  const overall = report ? worstSelfCheckStatus(report.counts) : null

  const copy = useCallback(async () => {
    if (!report) return
    if (!(await copyText(renderSelfCheckText(report)))) {
      onError(t('复制失败，请手动选择文本'))
      return
    }
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1600)
  }, [onError, report])

  // 导出诊断包：主进程收数据、脱敏、写盘，这里只展示结果。
  // 取消静默（用户自己点的），失败才报错，且不把已选路径写回界面。
  const exportBundle = useCallback(async () => {
    setExporting(true)
    setExportResult(null)
    try {
      // 判定放 shared 的纯函数里：取消必须静默，失败必须报错，两条都由测试固定。
      const outcome = diagnosticsExportOutcome(await window.pilot.diagnosticsExport())
      if (outcome.kind === 'silent') return
      if (outcome.kind === 'error') {
        onError(outcome.message)
        return
      }
      setExportResult(
        t('已导出 {v1} 个文件 · {v2} 条日志 · {v3}', {
          v1: outcome.files,
          v2: outcome.logLines,
          v3: formatBytes(outcome.bytes),
        }),
      )
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }, [onError])

  return (
    <div className="page panel-page self-check-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <ListCheckIcon width={13} height={13} />
            {t('自身功能模块')}
          </div>
          <h1>{t('内视')}</h1>
          <p>
            {t(
              '读的是运行中的服务实例：模型接入、审批规则、沙箱、自写工具、MCP、插件、存储、任务、反馈与更新。不读工作区代码，也不需要你指定路径。',
            )}
          </p>
        </div>
        <div className="stat-strip">
          {STATUS_CHIPS.map((status) => (
            <div className={`stat ${STATUS_CLASS[status]}`} key={status}>
              <strong>{report ? report.counts[status] : '—'}</strong>
              <span>{statusText(status)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="self-check-toolbar">
        <button type="button" className="button ghost small" onClick={() => void run()} disabled={busy}>
          <RefreshIcon width={13} height={13} />
          {busy ? t('正在取样…') : t('重新内视')}
        </button>
        <button
          type="button"
          className="button ghost small"
          onClick={() => void copy()}
          disabled={!report}
        >
          {copied ? t('已复制') : t('复制全文')}
        </button>
        <button
          type="button"
          className="button ghost small"
          onClick={() => void exportBundle()}
          disabled={exporting}
          title={t('收内视报告、最近日志与环境快照，路径已打码，可自行发给他人排查')}
        >
          <DownloadIcon width={13} height={13} />
          {exporting ? t('正在打包…') : t('导出诊断包')}
        </button>
        <SelfCheckExportReceipt text={exportResult} />
        {report ? (
          <span className="self-check-stamp">
            {overall ? statusText(overall) : ''} · v{report.version} ·{' '}
            {t('用时 {v1} ms', { v1: report.durationMs })}
          </span>
        ) : null}
      </div>

      {!report && busy ? (
        <div className="empty-panel">{t('正在取样…')}</div>
      ) : report ? (
        SELF_CHECK_GROUPS.map((group) => {
          const groupItems = items.filter((item) => item.group === group)
          if (groupItems.length === 0) return null
          return (
            <section className="self-check-section" key={group}>
              <div className="self-check-section-head">
                <h2>{groupText(group)}</h2>
                <span className="muted small">
                  {groupItems.length} / {report.items.length}
                </span>
              </div>
              <div className="self-check-list">
                {groupItems.map((item) => (
                  <ItemCard item={item} key={item.id} />
                ))}
              </div>
            </section>
          )
        })
      ) : (
        <div className="empty-panel">{t('还没有内视结果')}</div>
      )}
    </div>
  )
}
