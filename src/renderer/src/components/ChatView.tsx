import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type {
  ApprovalMode,
  ApprovalRequest,
  MessageDelivery,
  ProjectInstructionFile,
  RunRecord,
  ScheduledTask,
  ScheduledTaskInput,
  Session,
  SessionArtifact,
  SessionProcessSummary,
  TodoItem,
  TodoPriority,
  QuickCommand,
  WorkspaceSummary,
} from '../../../shared/types'
import { artifactsFromCalls, collectArtifactsByRun } from '../../../shared/artifacts'
import { ChevronIcon, InfoIcon, PilotMark } from '../icons'
import { buildTranscript, liveProcess, withPendingProcesses, type LiveRun } from '../ui'
import { Markdown } from './Markdown'
import { FileChangeBar } from './FileChangeBar'
import type { TranscriptUsage } from '../tokens'
import { ProcessBox } from './ProcessBox'
import { ReasoningBlock } from './ReasoningBlock'
import { SelectionTodoMenu, type SelectionMenuState } from './SelectionTodoMenu'
import { normalizeSelectionText } from '../selection'
import { t } from '../i18n'
import { ApprovalDock } from './chat/approval'
import { Composer } from './chat/composer'
import { AssistantMessageRow, UserMessageRow } from './chat/message-rows'
import { ContinueBar, QueuePanel, ThinkingIndicator, Welcome } from './chat/panels'

export interface ChatViewProps {
  workspace: WorkspaceSummary | null
  workspaces: WorkspaceSummary[]
  session: Session | null
  live: LiveRun | undefined
  runs: RunRecord[]
  approvals: ApprovalRequest[]
  runError: string | undefined
  hasKey: boolean
  running: boolean
  hasEarlier: boolean
  loadingEarlier: boolean
  contextUsage: TranscriptUsage | null
  projectInstructions: ProjectInstructionFile[]
  focusMessageId: string | null
  /** A prompt inserted by another panel; `key` makes repeated seeds distinct. */
  composerSeed: { key: number; text: string } | null
  onLoadEarlier: () => Promise<boolean>
  /** Execution runs the loaded pages skipped; each expands into its own steps. */
  pendingProcesses: SessionProcessSummary[]
  onLoadProcess: (runId: string) => Promise<boolean>
  onSend: (
    text: string,
    delivery: MessageDelivery,
    options?: { images?: string[]; references?: string[] },
  ) => Promise<boolean>
  onStop: () => void
  onPause: () => void
  onContinue: () => void
  onEditMessage: (messageId: string, content: string) => Promise<void>
  onDeleteMessage: (messageId: string) => Promise<void>
  onRegenerate: () => void
  onRetry: () => void
  continuing: boolean
  onDecideApproval: (callId: string, approved: boolean, remember: boolean) => void
  /** Switch the active session's execution mode (not available in review sessions). */
  onChangeApprovalMode?: (mode: ApprovalMode) => void
  onRemoveQueue: (taskId: string) => void
  onInsertQueue: (taskId: string) => void
  onUpdateQueue: (taskId: string, content: string) => Promise<void>
  onConvertQueue: (taskId: string) => void
  onFeedback: (runId: string, rating: 'up' | 'down') => void
  onReflect: (runId: string) => Promise<number>
  onQuickStart: (text: string) => void
  onPickWorkspace: () => void
  onOpenSettings: () => void
  onAddTodo: (text: string, priority?: TodoPriority) => Promise<void>
  /** 选中正文后「添加待办」：与输入框加待办分开，因为这里要额外提示一次。 */
  onAddSelectedTodo: (text: string) => Promise<void>
  onUpdateTodo: (todoId: string, text: string) => Promise<void>
  onRemoveTodo: (todoId: string) => Promise<void>
  onSendTodo: (todoId: string) => Promise<void>
  onSendAllTodos: () => Promise<void>
  onClearSentTodos: () => Promise<void>
  onScheduleTodo: (todo: TodoItem) => void
  /** 待办优先级循环：高→中→低，列表会按优先级重排。 */
  onSetTodoPriority: (todoId: string, priority: TodoPriority) => Promise<void>
  /** 待办时钟按钮带进来的内容；会话内定时面板据此展开表单。 */
  scheduleSeed: { content: string; todoId?: string } | null
  onScheduleSeedUsed: () => void
  onConvertTodoToSchedule: (
    todoId: string,
    input: ScheduledTaskInput,
  ) => Promise<ScheduledTask | null>
  onConvertScheduleToTodo: (taskId: string) => Promise<void>
  /** 提示气泡：定时面板保存、删除、转待办的结果走这条。 */
  onNotice: (message: string) => void
  /** Open one file from the answer's change bar (preview inside the files area). */
  onOpenArtifact: (artifact: SessionArtifact) => void
  /** 「查看更多」：open the session's files area. */
  onOpenArtifacts: () => void
}

export function ChatView({
  workspace,
  workspaces,
  session,
  live,
  runs,
  approvals,
  runError,
  hasKey,
  running,
  hasEarlier,
  loadingEarlier,
  contextUsage,
  projectInstructions,
  focusMessageId,
  composerSeed,
  onLoadEarlier,
  pendingProcesses,
  onLoadProcess,
  onSend,
  onStop,
  onPause,
  onContinue,
  onEditMessage,
  onDeleteMessage,
  onRegenerate,
  onRetry,
  continuing,
  onDecideApproval,
  onChangeApprovalMode,
  onRemoveQueue,
  onInsertQueue,
  onUpdateQueue,
  onConvertQueue,
  onFeedback,
  onReflect,
  onQuickStart,
  onPickWorkspace,
  onOpenSettings,
  onAddTodo,
  onAddSelectedTodo,
  onUpdateTodo,
  onRemoveTodo,
  onSendTodo,
  onSendAllTodos,
  onClearSentTodos,
  onScheduleTodo,
  onSetTodoPriority,
  onOpenArtifact,
  onOpenArtifacts,
  scheduleSeed,
  onScheduleSeedUsed,
  onConvertTodoToSchedule,
  onConvertScheduleToTodo,
  onNotice,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const lastSessionRef = useRef<string | null>(null)
  const earlierAnchor = useRef<{ height: number; top: number } | null>(null)
  const [showJump, setShowJump] = useState(false)
  // 正文里滑动选中后弹出的「添加待办」菜单；null = 没有选中。
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null)
  // null = never customized; the welcome screen then shows the built-in prompts.
  const [quickCommands, setQuickCommands] = useState<QuickCommand[] | null>(null)
  /** Runs whose box stayed open across the placeholder → loaded swap. */
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set())

  /** Load a run and keep its box open; the placeholder is replaced on success. */
  const loadProcessSteps = useCallback(
    async (runId: string): Promise<boolean> => {
      const loaded = await onLoadProcess(runId)
      if (!loaded) return false
      setExpandedRuns((previous) => new Set(previous).add(runId))
      return true
    },
    [onLoadProcess],
  )

  useEffect(() => {
    let cancelled = false
    window.pilot
      .quickCommands()
      .then((list) => {
        if (!cancelled) setQuickCommands(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const transcript = useMemo(
    () => (session ? withPendingProcesses(buildTranscript(session.messages), pendingProcesses) : []),
    [session, pendingProcesses],
  )
  const runsById = useMemo(
    () => new Map(runs.map((run) => [run.id, run])),
    [runs],
  )
  // Files per run, so each answer can carry its own change bar. Both sides use
  // the same collector (shared/artifacts.ts) as the files drawer, so a file can
  // never show up in one place and not the other.
  const filesByRun = useMemo(
    () => (session ? collectArtifactsByRun(session.messages) : new Map<string, SessionArtifact[]>()),
    [session],
  )
  // The run still streaming has no stored messages yet; read its live tool views.
  const liveFiles = useMemo(
    () =>
      artifactsFromCalls(
        (live?.tools ?? []).map((tool) => ({
          name: tool.name,
          args: tool.args,
          ok: tool.status === 'ok',
        })),
      ),
    [live],
  )
  const filesForRun = useCallback(
    (runId: string | undefined): SessionArtifact[] => {
      if (!runId) return []
      const stored = filesByRun.get(runId)
      if (stored && stored.length > 0) return stored
      return live?.runId === runId ? liveFiles : []
    },
    [filesByRun, live?.runId, liveFiles],
  )
  // Legacy plans can still carry an in_progress item after their run ended.
  // Treat it as settled only when the session's latest run actually completed.
  const planSettled = useMemo(() => {
    if (running || !session) return false
    let latest: RunRecord | null = null
    for (const run of runs) {
      if (run.sessionId !== session.id) continue
      if (!latest || run.startedAt > latest.startedAt) latest = run
    }
    return latest?.status === 'completed'
  }, [running, runs, session])
  const process = liveProcess(live)
  const empty = transcript.length === 0 && !live
  const lastAssistantId = useMemo(() => {
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      const message = transcript[index]
      if (message?.kind === 'assistant') return message.id
    }
    return null
  }, [transcript])

  const scrollToBottom = (smooth = false) => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({
      top: element.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    })
  }

  useEffect(() => {
    const id = session?.id ?? null
    if (lastSessionRef.current !== id) {
      lastSessionRef.current = id
      stickRef.current = true
      setShowJump(false)
      requestAnimationFrame(() => scrollToBottom())
    }
  }, [session?.id])

  useEffect(() => {
    if (!focusMessageId) return
    const element = scrollRef.current?.querySelector(
      `[data-message-id="${CSS.escape(focusMessageId)}"]`,
    )
    if (!element) return
    stickRef.current = false
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusMessageId, session?.messages.length])

  useEffect(() => {
    if (stickRef.current) {
      requestAnimationFrame(() => scrollToBottom())
    }
  }, [
    session?.messages.length,
    session?.plan?.updatedAt,
    live?.content.length,
    live?.reasoning.length,
    live?.tools.length,
    live?.step,
    approvals.length,
  ])

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120
    stickRef.current = atBottom
    setShowJump(!atBottom)
    // 菜单用的是视口坐标，正文一滚就错位了，直接收掉。
    setSelectionMenu((previous) => (previous ? null : previous))
  }

  const loadEarlier = () => {
    const element = scrollRef.current
    if (!element || loadingEarlier) return
    earlierAnchor.current = { height: element.scrollHeight, top: element.scrollTop }
    void onLoadEarlier().then((added) => {
      if (!added) earlierAnchor.current = null
    })
  }

  // ── 选中正文 → 添加待办 ──────────────────────────────────────────────
  // 鼠标拖选与触摸端滑动选中走同一条路径：拖动过程中浏览器不断触发
  // selectionchange，抬手（pointerup）时选区已经就位，这里再按选区末行
  // 的位置把菜单放到文字下方。右键则直接落在光标处。
  const readSelection = useCallback(() => {
    const element = scrollRef.current
    if (!element) return null
    const domSelection = window.getSelection()
    if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) return null
    const range = domSelection.getRangeAt(0)
    // 只认会话正文里的选区：输入框、侧栏里的选中不该弹这个菜单。
    if (!element.contains(range.commonAncestorContainer)) return null
    const text = normalizeSelectionText(range.toString())
    if (!text) return null
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    )
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect()
    return { text, rect }
  }, [])

  const addSelectedTodo = useCallback(
    (text: string) => {
      setSelectionMenu(null)
      // 选中的文字已经落到待办里，正文里的高亮可以收了。
      window.getSelection()?.removeAllRanges()
      void onAddSelectedTodo(text)
    },
    [onAddSelectedTodo],
  )

  useEffect(() => {
    const handleUp = (event: PointerEvent) => {
      // 右键由 contextmenu 负责，否则抬手会先弹在选区下沿、再跳到光标。
      if (event.button === 2) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.selection-menu')) return
      const found = readSelection()
      if (!found) return
      setSelectionMenu({
        x: found.rect.left,
        y: found.rect.bottom + 8,
        text: found.text,
      })
    }
    document.addEventListener('pointerup', handleUp)
    return () => document.removeEventListener('pointerup', handleUp)
  }, [readSelection])

  // 选区没了（点了空白、按了 Esc、正文重渲染）就把菜单一起收掉。
  useEffect(() => {
    if (!selectionMenu) return
    const sync = () => {
      if (!readSelection()) setSelectionMenu(null)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setSelectionMenu(null)
    }
    const onPointerDown = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.selection-menu')) return
      setSelectionMenu(null)
    }
    document.addEventListener('selectionchange', sync)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', sync)
    return () => {
      document.removeEventListener('selectionchange', sync)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', sync)
    }
  }, [selectionMenu, readSelection])

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const found = readSelection()
    if (!found) return
    event.preventDefault()
    setSelectionMenu({
      x: event.clientX || found.rect.left,
      y: event.clientY || found.rect.bottom + 8,
      text: found.text,
    })
  }

  useLayoutEffect(() => {
    const anchor = earlierAnchor.current
    const element = scrollRef.current
    if (!anchor || !element) return
    earlierAnchor.current = null
    // Prepending changes scrollHeight; keep the reader's viewport stable.
    element.scrollTop = anchor.top + (element.scrollHeight - anchor.height)
  }, [session?.messages.length])

  const showWelcome = !session || (empty && !running)

  return (
    <div className="chat-view">
      <div
        className="messages-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onContextMenu={onContextMenu}
      >
        <div className="messages-inner">
          {hasEarlier && !showWelcome ? (
            <button
              type="button"
              className="load-earlier"
              onClick={loadEarlier}
              disabled={loadingEarlier}
            >
              {loadingEarlier ? (
                <i className="spinner" />
              ) : (
                <ChevronIcon width={14} height={14} className="rotate-up" />
              )}
              {loadingEarlier ? t("载入中…") : t("加载更早消息")}
            </button>
          ) : null}

          {showWelcome ? (
            <Welcome
              workspace={workspace}
              hasKey={hasKey}
              hasSession={Boolean(session)}
              quickCommands={quickCommands}
              onQuickCommandsChange={setQuickCommands}
              onPickWorkspace={onPickWorkspace}
              onOpenSettings={onOpenSettings}
              onQuickStart={onQuickStart}
            />
          ) : null}

          {transcript.map((message) => {
            if (message.kind === 'user') {
              return (
                <UserMessageRow
                  message={message}
                  key={message.id}
                  focused={focusMessageId === message.id}
                  busy={running}
                  canDelete={
                    !running &&
                    !message.control &&
                    message.id === transcript[transcript.length - 1]?.id
                  }
                  onEdit={onEditMessage}
                  onDelete={onDeleteMessage}
                />
              )
            }
            if (message.kind === 'process') {
              return (
                <ProcessBox
                  process={message}
                  onLoadSteps={loadProcessSteps}
                  initialExpanded={message.runId ? expandedRuns.has(message.runId) : false}
                  key={message.id}
                />
              )
            }
            const files = filesForRun(message.runId)
            return (
              <AssistantMessageRow
                message={message}
                key={message.id}
                focused={focusMessageId === message.id}
                canRegenerate={!running && message.id === lastAssistantId}
                files={files}
                onOpenFile={onOpenArtifact}
                onOpenAll={onOpenArtifacts}
                {...(message.runId && runsById.has(message.runId)
                  ? { run: runsById.get(message.runId)! }
                  : {})}
                onFeedback={onFeedback}
                onReflect={onReflect}
                onRegenerate={onRegenerate}
              />
            )
          })}

          {process ? (
            <ProcessBox
              process={process}
              onLoadSteps={loadProcessSteps}
              initialExpanded={process.runId ? expandedRuns.has(process.runId) : false}
            />
          ) : null}

          {live?.error && !process ? (
            <div className="run-error-card">
              <InfoIcon width={15} height={15} />
              <div>
                <strong>{t("运行失败")}</strong>
                <span>{live.error}</span>
              </div>
              {session && !running ? (
                <button type="button" className="button ghost small" onClick={onRetry}>
                  {t("重试")}</button>
              ) : null}
            </div>
          ) : null}

          {live?.content ? (
            <div className="message assistant-message live-message">
              <div className="assistant-avatar live">
                <PilotMark width={18} height={18} />
              </div>
              <div className="assistant-content">
                <div className="message-head">
                  <span className="message-author">Pilot</span>
                  <span className="live-label">
                    <i className="live-dot" />
                    {t("回复中")}</span>
                </div>
                {live.reasoning ? (
                  <ReasoningBlock text={live.reasoning} className="answer-reasoning" />
                ) : null}
                <Markdown content={live.content} />
                <span className="stream-caret" />
                <FileChangeBar
                  files={liveFiles}
                  onOpenFile={onOpenArtifact}
                  onOpenAll={onOpenArtifacts}
                />
              </div>
            </div>
          ) : null}

          {running && !live?.content && !process ? (
            <ThinkingIndicator step={live?.step ?? 0} />
          ) : null}

          {running && live?.content && !process ? (
            <div className="thinking-row subtle">
              <span className="typing-dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          ) : null}

          {runError && !live?.error ? (
            <div className="run-error-card">
              <InfoIcon width={15} height={15} />
              <div>
                <strong>{t("运行失败")}</strong>
                <span>{runError}</span>
              </div>
              {session && !running ? (
                <button type="button" className="button ghost small" onClick={onRetry}>
                  {t("重试")}</button>
              ) : null}
            </div>
          ) : null}

          <div className="scroll-anchor" />
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            stickRef.current = true
            scrollToBottom(true)
          }}
        >
          <ChevronIcon width={14} height={14} className="rotate-90" />
          {t("回到最新")}</button>
      ) : null}

      {selectionMenu ? (
        <SelectionTodoMenu
          state={selectionMenu}
          onAddTodo={addSelectedTodo}
          onClose={() => setSelectionMenu(null)}
        />
      ) : null}

      <div className="composer-dock">
        <ApprovalDock
          approvals={approvals}
          approvalMode={session?.approvalMode ?? 'auto'}
          onDecide={onDecideApproval}
          {...(session && session.kind !== 'review' && onChangeApprovalMode
            ? { onSwitchToAuto: () => onChangeApprovalMode('auto') }
            : {})}
        />
        {session && !running && (session.paused || session.canContinue) ? (
          <ContinueBar session={session} busy={continuing} onContinue={onContinue} />
        ) : null}
        <QueuePanel
          queue={session?.queue ?? []}
          running={running}
          onInsert={onInsertQueue}
          onRemove={onRemoveQueue}
          onUpdate={onUpdateQueue}
          onConvert={onConvertQueue}
        />
        <Composer
          session={session}
          workspaces={workspaces}
          running={running}
          planSettled={planSettled}
          hasKey={hasKey}
          contextUsage={contextUsage}
          projectInstructions={projectInstructions}
          composerSeed={composerSeed}
          onSend={onSend}
          onStop={onStop}
          onPause={onPause}
          onOpenSettings={onOpenSettings}
          onAddTodo={onAddTodo}
          onUpdateTodo={onUpdateTodo}
          onRemoveTodo={onRemoveTodo}
          onSendTodo={onSendTodo}
          onSendAllTodos={onSendAllTodos}
          onClearSentTodos={onClearSentTodos}
          onScheduleTodo={onScheduleTodo}
          onSetTodoPriority={onSetTodoPriority}
          scheduleSeed={scheduleSeed}
          onScheduleSeedUsed={onScheduleSeedUsed}
          onConvertTodoToSchedule={onConvertTodoToSchedule}
          onConvertScheduleToTodo={onConvertScheduleToTodo}
          onNotice={onNotice}
        />
      </div>
    </div>
  )
}
