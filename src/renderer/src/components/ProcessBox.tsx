import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ChevronDownIcon, InfoIcon } from '../icons'
import { processParts, recentProcessParts, runElapsedLabel, type ProcessPart, type ToolView, type UIMessage } from '../ui'
import { Markdown } from './Markdown'
import { ProcessTime } from './ProcessTime'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolCard } from './ToolCard'
import { t } from '../i18n'

type ProcessMessage = Extract<UIMessage, { kind: 'process' }>

/** Collapsed view keeps only the newest steps, like the mobile client. */
const LATEST_PARTS = 5
/** While a run streams, stay glued to the bottom until the user scrolls up. */
const STICK_THRESHOLD_PX = 24

/**
 * One-second heartbeat, active only while the box is still running. A long run
 * that has produced nothing new looks the same as a stuck one; the counter is
 * what separates the two.
 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

function renderReasoning(part: ProcessPart & { kind: 'reasoning' }) {
  // The folded title carries the first line of the thinking, like the phone app.
  return <ReasoningBlock key={part.key} text={part.text} at={part.at} />
}

function ProcessBoxRow({
  process,
  onLoadSteps,
  initialExpanded = false,
}: {
  process: ProcessMessage
  /** Fetch one run's steps when its page did not carry them. */
  onLoadSteps?: ((runId: string) => Promise<boolean>) | undefined
  /** Re-opens the box after its placeholder was replaced by the loaded run. */
  initialExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(initialExpanded)
  const [loading, setLoading] = useState(false)
  const pending = process.pending
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stackRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  /** True while a pin-to-bottom scroll we issued is still being reported. */
  const pinningRef = useRef(false)
  const failures = process.tools.filter((tool) => tool.status === 'error').length
  const running = process.live && !process.error
  const startedAt = process.startedAt
  const now = useNowTicker(Boolean(running) && Boolean(startedAt))
  const elapsed = running ? runElapsedLabel(startedAt, now) : ''
  const parts = processParts(process)
  const windowed = recentProcessParts(process, LATEST_PARTS)
  const hidden = expanded ? 0 : windowed.hidden
  const visible = expanded ? parts : windowed.parts
  const waiting = process.tools.some((tool) => tool.status === 'waiting')
  const status = pending
    ? pending.failed > 0
      ? 'warn'
      : 'idle'
    : process.error
      ? 'error'
      : failures > 0
        ? 'warn'
        : running
          ? 'running'
          : 'ok'
  const statusText = pending
    ? loading
      ? t("载入中…")
      : t("未加载")
    : process.error
      ? t("运行失败")
      : waiting
        ? t("等待批准")
        : running
          ? t("执行中")
          : failures > 0
            ? t("{v1} 个工具失败", { v1: failures })
            : t("执行完成")

  const lastKey = visible.at(-1)?.key ?? ''

  /** Fetch this run's steps; the parent swaps the placeholder for the real box. */
  const loadSteps = useCallback(() => {
    if (!process.runId || !onLoadSteps) return
    setLoading(true)
    void onLoadSteps(process.runId).then((loaded) => {
      setLoading(false)
      if (loaded) setExpanded(true)
    })
  }, [onLoadSteps, process.runId])

  // Follow the newest step: the window is only five entries tall, so the box
  // stays pinned to the bottom unless the reader scrolled up.
  const pinToBottom = useCallback((node: HTMLDivElement) => {
    const bottom = node.scrollHeight - node.clientHeight
    // Already there: setting scrollTop would not fire a scroll event, and a
    // stale "ours" flag would swallow the reader's next scroll.
    if (Math.abs(node.scrollTop - bottom) < 1) return
    pinningRef.current = true
    node.scrollTop = bottom
  }, [])

  // Layout effect: pin in the same commit that renders the new step, before the
  // browser fires the scroll event caused by its own scroll-anchoring.
  useLayoutEffect(() => {
    const node = bodyRef.current
    if (node && stickRef.current) pinToBottom(node)
  }, [expanded, lastKey, visible.length, process.tools.length, running, pinToBottom])

  // The max-height transition and late markdown layout change the scroll range
  // after the commit above, so keep pinning while the reader is at the bottom.
  useEffect(() => {
    const node = bodyRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const pin = () => {
      if (stickRef.current) pinToBottom(node)
    }
    const observer = new ResizeObserver(pin)
    observer.observe(node)
    if (stackRef.current) observer.observe(stackRef.current)
    node.addEventListener('transitionend', pin)
    return () => {
      observer.disconnect()
      node.removeEventListener('transitionend', pin)
    }
  }, [pinToBottom])

  const atBottomOf = (node: HTMLDivElement) =>
    node.scrollHeight - node.scrollTop - node.clientHeight < STICK_THRESHOLD_PX

  const handleScroll = () => {
    const node = bodyRef.current
    if (!node) return
    // The scroll event our own pinning produced: keep following.
    if (pinningRef.current) {
      pinningRef.current = false
      return
    }
    stickRef.current = atBottomOf(node)
  }

  // Explicit user intent (wheel, touch, drag) releases the pin.
  const releasePin = (event: { deltaY?: number }) => {
    // A gesture from the reader always wins over a pending pin.
    pinningRef.current = false
    const node = bodyRef.current
    if (!node) return
    if (!atBottomOf(node) || (event.deltaY ?? 0) < 0) stickRef.current = false
  }

  // Steps carry no ordinal any more: the reader tracks the work by its content,
  // and numbering shifted as the collapsed window slid forward.
  const toolById = new Map(process.tools.map((tool) => [tool.id, tool]))
  const nodes: ReactNode[] = []
  let toolBuffer: ToolView[] = []
  const flushTools = () => {
    if (toolBuffer.length === 0) return
    nodes.push(
      <div className="tool-list" key={`tools-${toolBuffer[0]!.id}`}>
        {toolBuffer.map((tool) => (
          <ToolCard tool={tool} key={tool.id} />
        ))}
      </div>,
    )
    toolBuffer = []
  }

  for (const part of visible) {
    if (part.kind === 'tool') {
      // Resolve by id so a result attached after the step was recorded still shows.
      const tool = toolById.get(part.toolId)
      if (tool) toolBuffer.push(tool)
      continue
    }
    flushTools()
    if (part.kind === 'reasoning') {
      nodes.push(renderReasoning(part))
      continue
    }
    nodes.push(
      <div className="process-note" key={part.key}>
        <ProcessTime at={part.at} />
        <Markdown content={part.text} />
      </div>,
    )
  }
  flushTools()

  return (
    <section className={`process-box process-${status}${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className="process-head"
        onClick={() => {
          // Re-opening the box starts from the newest step again.
          stickRef.current = true
          setExpanded((value) => !value)
          // A placeholder loads its steps only when the reader opens it.
          if (!expanded && pending && !loading) loadSteps()
        }}
        aria-expanded={expanded}
      >
        <span className="process-indicator">
          {running ? <i className="spinner" /> : <i className={`process-dot dot-${status}`} />}
        </span>
        <span className="process-title">{t("执行过程")}</span>
        <span className="process-meta">
          {pending
            ? t("{v1} 项步骤", { v1: pending.stepCount })
            : `${process.tools.length} ${t("个工具")}${process.reasoning.length > 0 ? t(" · 含思考") : ''}`}
        </span>
        {elapsed ? <span className="process-elapsed">{elapsed}</span> : null}
        <span className={`process-status text-${status}`}>{statusText}</span>
        <span className="process-expand">{expanded ? t("收起") : t("展开")}</span>
        <ChevronDownIcon
          width={14}
          height={14}
          className={`process-chevron${expanded ? ' open' : ''}`}
        />
      </button>

      {process.compacted ? (
        <div className="compact-note">
          <InfoIcon width={13} height={13} />
          {process.compacted}
        </div>
      ) : null}

      {hidden > 0 && !expanded ? (
        <div className="process-more-wrap">
          <button type="button" className="process-more" onClick={() => setExpanded(true)}>
            {t("更早的 {v1} 项执行过程 · 展开", { v1: hidden })}
          </button>
        </div>
      ) : null}

      <div
        className="process-body"
        ref={bodyRef}
        onScroll={handleScroll}
        onWheel={releasePin}
        onTouchMove={() => releasePin({})}
        onPointerDown={() => {
          pinningRef.current = false
        }}
      >
        <div className="process-stack" ref={stackRef}>
          {pending && nodes.length === 0 ? (
            <div className="process-pending">
              <span>
                {loading
                  ? t("正在载入执行过程…")
                  : t("这一轮的执行过程尚未载入，展开即可查看。")}
              </span>
              {!loading ? (
                <button type="button" className="button ghost small" onClick={loadSteps}>
                  {t("载入执行过程")}
                </button>
              ) : null}
            </div>
          ) : null}

          {nodes}

          {process.error ? (
            <div className="process-error">
              <strong>{t("运行失败")}</strong>
              <span>{process.error}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

// Historical process rows are immutable while a later answer streams.
export const ProcessBox = memo(ProcessBoxRow)
