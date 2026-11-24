import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  LayersIcon,
  SearchIcon,
  TerminalIcon,
} from '../icons'
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

function toolIcon(name: string): ReactNode {
  if (name === 'run_command') return <TerminalIcon width={14} height={14} />
  if (name === 'search_files') return <SearchIcon width={14} height={14} />
  if (name === 'list_directory') return <FolderIcon width={14} height={14} />
  if (name === 'explore') return <SearchIcon width={14} height={14} />
  if (name === 'schedule_task') return <ClockIcon width={14} height={14} />
  if (
    name === 'remember' ||
    name === 'update_plan' ||
    name === 'add_todo' ||
    name === 'propose_self_update'
  ) {
    return <LayersIcon width={14} height={14} />
  }
  return <FileIcon width={14} height={14} />
}

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

export function ToolCard({ tool }: { tool: ToolView }) {
  const [open, setOpen] = useState(tool.status === 'waiting' || tool.status === 'error')

  useEffect(() => {
    // The card is created as running and later moves to waiting/error, so the
    // initial state alone is not enough to surface a required decision.
    if (tool.status === 'waiting' || tool.status === 'error') setOpen(true)
  }, [tool.status])
  const now = useTicker(tool.status === 'running')
  const elapsedLabel = tool.status === 'running' ? runningToolLabel(tool.at, now) : ''
  const diff =
    typeof tool.result?.metadata?.['diff'] === 'string'
      ? tool.result.metadata['diff']
      : null
  const output = tool.result?.output ?? ''
  const detail = tool.result?.error || output
  const args = tool.args
  const shell =
    tool.name === 'run_shell' && typeof tool.result?.metadata?.['shell'] === 'string'
      ? String(tool.result.metadata['shell'])
      : null

  return (
    <article className={`tool-card tool-${tool.status} risk-${tool.risk}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool-glyph">{toolIcon(tool.name)}</span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary" title={summarizeTool(tool)}>
          {summarizeTool(tool)}
        </span>
        {shell ? (
          <span className="tool-shell" title={t("本次命令使用的 Shell 解释器")}>
            {shell}
          </span>
        ) : null}
        <span className="tool-risk">{riskLabel(tool.risk)}</span>
        {tool.durationMs != null ? (
          <span className="tool-duration">{formatDuration(tool.durationMs)}</span>
        ) : elapsedLabel ? (
          <span className="tool-duration is-running" aria-live="polite">
            {elapsedLabel}
          </span>
        ) : null}
        <span className={`tool-status status-${tool.status}`}>
          <i className="status-dot" />
          {toolStatusLabel(tool.status)}
        </span>
        <ChevronDownIcon
          width={14}
          height={14}
          className={`tool-chevron${open ? ' open' : ''}`}
        />
      </button>
      {open ? (
        <div className="tool-body">
          <ProcessTime at={tool.at} />
          {Object.keys(args).length > 0 ? (
            <div className="tool-section">
              <div className="tool-label">{t("参数")}</div>
              <pre className="tool-pre tool-args">{JSON.stringify(args, null, 2)}</pre>
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
                <span className="tool-output-size">{detail.length.toLocaleString()} {t("字符")}</span>
              </div>
              <pre className={`tool-pre${tool.status === 'error' ? ' is-error' : ''}`}>
                {detail}
              </pre>
            </div>
          ) : tool.status === 'running' || tool.status === 'waiting' ? null : (
            <div className="tool-empty">{t("没有输出")}</div>
          )}
        </div>
      ) : null}
    </article>
  )
}
