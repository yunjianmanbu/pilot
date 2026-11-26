import { useEffect, useState } from 'react'
import { ChevronDownIcon } from '../icons'
import {
  formatDuration,
  riskLabel,
  runningToolLabel,
  summarizeTool,
  toolStatusLabel,
  type ToolView,
} from '../ui'
import { t } from '../i18n'
import { ProcessTime } from './ProcessTime'
import { toolGlyph, toolKind } from './process-icons'

/**
 * One-second heartbeat, active only while a call is still running: it is what
 * turns a silent long command into a counter the user can watch.
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff-view">
      {text.split('\n').map((line, index) => {
        const kind = line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'ctx'
        return (
          <span key={`${index}-${line.slice(0, 8)}`} className={`diff-line diff-${kind}`}>
            {line || ' '}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

function diffOf(tool: ToolView): string | null {
  const value = tool.result?.metadata?.['diff']
  return typeof value === 'string' ? value : null
}

function shellOf(tool: ToolView): string | null {
  const value = tool.result?.metadata?.['shell']
  return tool.name === 'run_shell' && typeof value === 'string' ? String(value) : null
}

/**
 * Everything a call produced, shown in the dialog the row opens.
 *
 * This used to be the card's own expanding body. It moved out for the same
 * reason the thinking did: a body that appears and disappears inside the box
 * changes its height, and the box then scrolls itself while the reader is
 * reading. The dialog also has room for long output, which the narrow box never
 * had.
 */
export function ToolDetail({ tool }: { tool: ToolView }) {
  const diff = diffOf(tool)
  const shell = shellOf(tool)
  const output = tool.result?.output ?? ''
  const detail = tool.result?.error || output

  return (
    <div className="tool-body tool-detail">
      <ProcessTime at={tool.at} />
      <div className="tool-detail-meta">
        <span className={`tool-status status-${tool.status}`}>
          <i className="status-dot" />
          {toolStatusLabel(tool.status)}
        </span>
        <span className="tool-risk">{riskLabel(tool.risk)}</span>
        {shell ? (
          <span className="tool-shell" title={t("本次命令使用的 Shell 解释器")}>
            {shell}
          </span>
        ) : null}
        {tool.durationMs != null ? (
          <span
            className={`tool-duration${tool.durationEstimated ? ' is-estimated' : ''}`}
            title={
              tool.durationEstimated ? t("该步骤没有落盘耗时，这里按消息时间差估算") : undefined
            }
          >
            {toolDurationLabel(tool)}
          </span>
        ) : null}
      </div>
      {Object.keys(tool.args).length > 0 ? (
        <div className="tool-section">
          <div className="tool-label">{t("参数")}</div>
          <pre className="tool-pre tool-args">{JSON.stringify(tool.args, null, 2)}</pre>
        </div>
      ) : null}
      {diff ? (
        <div className="tool-section">
          <div className="tool-label">{t("变更")}</div>
          <DiffView text={diff} />
        </div>
      ) : null}
      {detail ? (
        <div className="tool-section">
          <div className="tool-label">
            {tool.status === 'error' ? t("错误") : t("输出")}
            <span className="tool-output-size">
              {detail.length.toLocaleString()} {t("字符")}
            </span>
          </div>
          <pre className={`tool-pre${tool.status === 'error' ? ' is-error' : ''}`}>{detail}</pre>
        </div>
      ) : tool.status === 'running' || tool.status === 'waiting' ? null : (
        <div className="tool-empty">{t("没有输出")}</div>
      )}
    </div>
  )
}

/**
 * 一行里的耗时文案。估算值前面加 ≈：旧记录没存耗时，数字来自消息时间差，
 * 不能让它和落盘的真实耗时看起来一模一样。
 */
export function toolDurationLabel(tool: ToolView): string {
  if (tool.durationMs == null) return ''
  const text = formatDuration(tool.durationMs)
  if (!text) return ''
  return tool.durationEstimated ? `≈${text}` : text
}

/**
 * One folded call in the execution box: a single row that never grows.
 *
 * Clicking it hands the step to the dialog owner (the chat view) instead of
 * toggling a body here. The row carries its own status dot, duration and risk
 * label, so the reader still sees what happened without opening anything; the
 * dialog is for the details.
 */
export function ToolCard({ tool, onOpen }: { tool: ToolView; onOpen?: (() => void) | undefined }) {
  const now = useTicker(tool.status === 'running')
  const elapsedLabel = tool.status === 'running' ? runningToolLabel(tool.at, now) : ''
  const shell = shellOf(tool)
  const durationText = toolDurationLabel(tool)

  return (
    <article className={`tool-card tool-${tool.status} risk-${tool.risk}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => onOpen?.()}
        title={summarizeTool(tool)}
      >
        {/* 图标与动作标签是一个整体：先看到「哪一类动作」+「读还是写」，
            再看到具体工具名与参数。标签原先排在行尾（在时长、状态之前），
            要扫到行末才知道这次是只读还是写入，扫视成本比放在图标后高。 */}
        <span className="tool-lead">
          <span className={`tool-glyph glyph-${toolKind(tool.name)}`}>{toolGlyph(tool.name)}</span>
          <span className="tool-risk">{riskLabel(tool.risk)}</span>
        </span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary">{summarizeTool(tool)}</span>
        {shell ? (
          <span className="tool-shell" title={t("本次命令使用的 Shell 解释器")}>
            {shell}
          </span>
        ) : null}
        {durationText ? (
          <span
            className={`tool-duration${tool.durationEstimated ? ' is-estimated' : ''}`}
            title={
              tool.durationEstimated
                ? t("该步骤没有落盘耗时，这里按消息时间差估算")
                : t("本次调用的耗时")
            }
          >
            {durationText}
          </span>
        ) : elapsedLabel ? (
          <span className="tool-duration is-running" aria-live="polite">
            {elapsedLabel}
          </span>
        ) : null}
        <span className={`tool-status status-${tool.status}`}>
          <i className="status-dot" />
          {toolStatusLabel(tool.status)}
        </span>
        <ChevronDownIcon width={14} height={14} className="tool-chevron is-out" />
      </button>
    </article>
  )
}
