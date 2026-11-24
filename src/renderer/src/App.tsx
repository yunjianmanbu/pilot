import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApprovalMode,
  ApprovalRequest,
  BootstrapData,
  CompanionPairRequest,
  MessageDelivery,
  MessageOptions,
  MessageSearchHit,
  ProjectInstructionFile,
  QualityState,
  ReviewReport,
  RunEvent,
  ScheduledTaskInput,
  Session,
  SessionArtifact,
  SessionPage,
  SessionProcessSummary,
  SessionSummary,
  SettingsView,
  StoredMessage,
  TodoItem,
  TodoPriority,
  UpdateState,
  WorkspaceDetail,
  WorkspaceSummary,
} from '../../shared/types'
import { modelOptionLabel, modelResourceName, normalizeModelTag } from '../../shared/model-label'
import type { HostKind } from '../../shared/capabilities'
import { copyText } from './clipboard'
import { ChangeReviewPanel } from './components/ChangeReviewPanel'
import { ChatView } from './components/ChatView'
import { CheckpointDialog } from './components/CheckpointDialog'
import { CompanionDialog } from './components/CompanionDialog'
import { PairRequestDialog } from './components/PairRequestDialog'
import { evolutionWorkspaceTabs } from './components/EvolutionWorkspace'
import { SessionResourcesPanel } from './components/SessionResourcesPanel'
import { QualityBell } from './components/QualityBell'
import { ResourceMeters } from './components/ResourceMeters'
import { RunningPill } from './components/RunningPill'
import { SystemResourceDialog } from './components/SystemResourceDialog'
import { SystemToolsPanel } from './components/SystemToolsPanel'
import { AllTodosPanel } from './components/AllTodosPanel'
import { AllScheduledPanel } from './components/AllScheduledPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { ModelPanel } from './components/ModelPanel'
import { PreferencesPanel } from './components/PreferencesPanel'
import { PluginsPanel } from './components/PluginsPanel'
import { ReviewDialog } from './components/ReviewDialog'
import { ReviewReportDialog } from './components/ReviewReportDialog'
import { SelectMenu } from './components/SelectMenu'
import type { ResourceTab } from './session-resources'
import { FeedbackDialog } from './components/FeedbackDialog'
import { SettingsDialog, type SettingsFocus } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { TopbarMenu, type TopbarMenuItem } from './components/TopbarMenu'
import { WorkspaceDialog } from './components/WorkspaceDialog'
import {
  CopyIcon,
  DiffIcon,
  DownloadIcon,
  FileIcon,
  FilesIcon,
  FolderIcon,
  HistoryIcon,
  SparkIcon,
  InfoIcon,
  LayersIcon,
  MoonIcon,
  PhoneIcon,
  PilotLogo,
  SettingsIcon,
  SunIcon,
  UpdateIcon,
  XIcon,
} from './icons'
import { transcriptUsage } from './tokens'
import {
  createToolView,
  emptyLiveRun,
  inferRisk,
  insertProcessMessages,
  isDeliverableText,
  mergePendingProcesses,
  processPlaceholders,
  restoreCachedRuns,
  runsWithSteps,
  stripIpcWrapper,
  type CachedRun,
  type LiveRun,
  type MainView,
  type ProcessPart,
} from './ui'
import { applyLocaleSetting, t } from './i18n'

type ToastLevel = 'info' | 'warn' | 'error'

interface Toast {
  id: number
  message: string
  level: ToastLevel
}

const APPROVAL_MODES: Array<{ value: ApprovalMode; label: string }> = [
  { value: 'auto', label: t("全部自动") },
  { value: 'manual', label: t("只读自动") },
  { value: 'ask', label: t("逐条审批") },
]

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  auto: t("全部自动"),
  manual: t("只读自动"),
  ask: t("逐条审批"),
  acceptEdits: t("全部自动"),
  plan: t("只读自动"),
  dontAsk: t("只读自动"),
}

const SESSION_PAGE_SIZE = 120
/**
 * How many dialogue messages one "load earlier" step brings back. Two messages
 * make a turn, so this is six turns: scrolling back stays in transcript order
 * instead of dumping the rest of the conversation above the reader at once.
 */
const EARLIER_DIALOGUE_LIMIT = 12
/** How many opened runs one session keeps cached for later switches. */
const LOADED_RUN_CACHE_SIZE = 8

const INITIAL_UPDATE: UpdateState = {
  status: 'idle',
  currentVersion: '',
  release: null,
  progress: 0,
  transferred: 0,
  total: 0,
  message: t("正在读取更新状态…"),
  checkedAt: null,
  canInstall: false,
  elevationRequired: false,
  relocatingToUserDir: false,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function summaryOf(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    running: session.running,
    paused: session.paused,
    ...(session.pausedAt ? { pausedAt: session.pausedAt } : {}),
    ...(session.pauseInstruction ? { pauseInstruction: session.pauseInstruction } : {}),
    canContinue: session.canContinue,
    ...(session.lastRunStatus ? { lastRunStatus: session.lastRunStatus } : {}),
    ...(session.lastRunError ? { lastRunError: session.lastRunError } : {}),
    sessionModelId: session.sessionModelId,
    messageCount: session.messages.length,
    instructionCount: session.messages.filter(
      (message) => message.role === 'user' && !message.control,
    ).length,
    queueCount: session.queue.length,
    todoCount: session.todos.filter((todo) => todo.status === 'pending').length,
    ...(session.runInstruction ? { runInstruction: session.runInstruction } : {}),
    ...(session.runStartedAt ? { runStartedAt: session.runStartedAt } : {}),
    approvalMode: session.approvalMode,
    plan: session.plan,
    kind: session.kind,
    review: session.review ?? null,
    reviewReport: session.reviewReport ?? null,
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

function updateLive(
  previous: Record<string, LiveRun>,
  sessionId: string,
  runId: string,
  updater: (live: LiveRun) => LiveRun,
): Record<string, LiveRun> {
  const current = previous[sessionId] ?? { ...emptyLiveRun(sessionId), runId }
  return { ...previous, [sessionId]: updater(current) }
}

function SessionTitleEditor({
  session,
  onRename,
}: {
  session: Session | null
  onRename: (sessionId: string, title: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(session?.title ?? '')

  useEffect(() => {
    if (!editing) setValue(session?.title ?? '')
  }, [session?.id, session?.title, editing])

  if (!session) return <span className="header-title muted">{t("未选择会话")}</span>

  if (editing) {
    const commit = () => {
      setEditing(false)
      const title = value.trim()
      if (title && title !== session.title) onRename(session.id, title)
    }
    return (
      <input
        className="header-title-input"
        value={value}
        autoFocus
        maxLength={120}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            setEditing(false)
            setValue(session.title)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className="header-title"
      onClick={() => setEditing(true)}
      title={t("点击重命名")}
    >
      {session.title}
    </button>
  )
}

const REVIEW_VERDICT: Record<ReviewReport['verdict'], string> = {
  pass: t("通过"),
  needs_work: t("需要处理"),
  blocked: t("证据受阻"),
}

function reviewAverage(report: ReviewReport): number {
  const { correctness, evidence, safety, efficiency } = report.scores
  return Math.round((correctness + evidence + safety + efficiency) / 4)
}

function ReviewBanner({
  session,
  handingOff,
  onOpenReport,
  onHandoff,
}: {
  session: Session
  handingOff: boolean
  onOpenReport: () => void
  onHandoff: () => void
}) {
  const review = session.review
  if (!review) return null
  const report = session.reviewReport
  const scope =
    review.sessions === 'all'
      ? t("所有工作区")
      : review.sessions === 'workspace'
        ? t("当前工作区")
        : t("{v1} 个指定会话", { v1: review.sessions.length })
  return (
    <div className="review-banner">
      <span className="review-banner-mark">
        <SparkIcon width={17} height={17} />
      </span>
      <div className="review-banner-text">
        <strong>
          {t("只读复盘 ·")}{scope}
          {report ? (
            <span className={`review-banner-verdict verdict-${report.verdict}`}>
              {REVIEW_VERDICT[report.verdict]} {reviewAverage(report)}
            </span>
          ) : (
            <span className="review-banner-pending">{t("评估中，尚未生成报告")}</span>
          )}
        </strong>
        <span title={review.roots.map((root) => root.path).join('\n')}>
          {t("可读目录：")}{review.roots.map((root) => root.name).join(' · ')}
          {review.objective ? t(" · 目标：{v1}", { v1: review.objective.slice(0, 60) }) : ''}
        </span>
      </div>
      <div className="review-banner-actions">
        {report ? (
          <button type="button" className="button ghost small" onClick={onOpenReport}>
            {t("查看报告")}</button>
        ) : null}
        <button
          type="button"
          className="button primary small"
          onClick={onHandoff}
          disabled={!report || handingOff}
          title={report ? t("新建普通编码会话处理报告中的问题") : t("先完成评估并生成报告")}
        >
          {handingOff ? <i className="spinner" /> : null}
          {handingOff ? t("创建中…") : t("交接修复")}
        </button>
      </div>
    </div>
  )
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast-${toast.level}`} key={toast.id}>
          <span className="toast-icon">
            {toast.level === 'error' ? (
              <InfoIcon width={15} height={15} />
            ) : toast.level === 'warn' ? (
              <InfoIcon width={15} height={15} />
            ) : (
              <InfoIcon width={15} height={15} />
            )}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => onDismiss(toast.id)}
            aria-label={t("关闭提示")}
          >
            <XIcon width={13} height={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function App() {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null)
  /** 质量闸门正在评估/打包：铃铛按钮与弹窗按钮在此期间都不能重入。 */
  const [qualityBusy, setQualityBusy] = useState(false)
  const [liveRuns, setLiveRuns] = useState<Record<string, LiveRun>>({})
  const [activeRuns, setActiveRuns] = useState<Record<string, boolean>>({})
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [runErrors, setRunErrors] = useState<Record<string, string>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [view, setView] = useState<MainView>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false)
  /**
   * 会话资源抽屉：null 表示关闭，否则是当前分类。工作区文件、相关链接、可用
   * 工具、会话知识库和本次产出的文件共用这一个抽屉，切换分类不用另开面板。
   */
  const [resourcesTab, setResourcesTab] = useState<ResourceTab | null>(null)
  /** File the抽屉 should preview right away, set by an answer's change bar. */
  const [artifactSeed, setArtifactSeed] = useState<{ path: string; key: number } | null>(null)
  const artifactSeedKey = useRef(0)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  /** 顶栏资源条点开的详情弹框。 */
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false)
  const [scheduleRevision, setScheduleRevision] = useState(0)
  /** 全量待办视图的刷新信号：任何会话的待办变化都会自增。 */
  const [todosRevision, setTodosRevision] = useState(0)
  /** 左下角「定时」角标：所有会话里启用中的定时任务数。 */
  const [scheduledCount, setScheduledCount] = useState(0)
  const [scheduleSeed, setScheduleSeed] = useState<{ content: string; todoId?: string } | null>(
    null,
  )
  const [composerSeed, setComposerSeed] = useState<{ key: number; text: string } | null>(null)
  const [sessionHasMore, setSessionHasMore] = useState(false)
  /** Runs whose steps a dialogue page left out; each loads when its box opens. */
  const [pendingProcesses, setPendingProcesses] = useState<SessionProcessSummary[]>([])
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [companionOpen, setCompanionOpen] = useState(false)
  /** A phone waiting for this window to allow or reject the connection. */
  const [pairRequest, setPairRequest] = useState<CompanionPairRequest | null>(null)
  const [booted, setBooted] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [platform, setPlatform] = useState('')
  /**
   * 同一个面板跑在两个宿主里：桌面端有自己的窗口（含右上角最小化/最大化/关闭），
   * `pilot serve` 只是在浏览器标签页里。顶栏要为原生按钮留的空白、以及全屏
   * 要走哪条路，都得按这个标识决定，不能按平台名猜。
   */
  const [host, setHost] = useState<HostKind>('desktop')
  /** 浏览器的全屏状态。桌面端没有这条入口，所以永远保持 false。 */
  const [fullscreen, setFullscreen] = useState(false)
  const [update, setUpdate] = useState<UpdateState>(INITIAL_UPDATE)
  const [projectInstructions, setProjectInstructions] = useState<ProjectInstructionFile[]>([])
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null)
  const [changesOpen, setChangesOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewReportOpen, setReviewReportOpen] = useState(false)
  const [handingOff, setHandingOff] = useState(false)

  const activeSessionRef = useRef<string | null>(null)
  const activeWorkspaceRef = useRef<string | null>(null)
  const composerSeedKeyRef = useRef(0)
  const sessionRef = useRef<Session | null>(null)
  const pendingProcessesRef = useRef<SessionProcessSummary[]>([])
  /**
   * Steps the reader already opened, per session and per run, with the dialogue
   * message each run follows. Reopening a conversation restores the boxes that
   * were already read instead of replacing them with "not loaded yet"; the
   * anchor decides where they go, so a run whose question is no longer on
   * screen stays in the earlier history rather than piling up above the window.
   */
  const loadedRuns = useRef(new Map<string, Map<string, CachedRun>>())
  const sessionHasMoreRef = useRef(false)
  const sessionSeq = useRef<Record<string, number>>({})
  const detailSeq = useRef(0)
  const sessionsSeq = useRef<Record<string, number>>({})
  const toastId = useRef(0)
  const memoryToastAt = useRef(0)
  const profileToastAt = useRef(0)
  // Streaming deltas arrive per token. Buffering them into one state update per
  // animation frame avoids re-rendering the whole transcript for every token.
  const pendingDeltas = useRef(
    new Map<string, { sessionId: string; runId: string; text: string; reasoning: string }>(),
  )
  const deltaFrame = useRef<number | null>(null)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    pendingProcessesRef.current = pendingProcesses
  }, [pendingProcesses])

  const setSessionHasMoreBoth = useCallback((value: boolean) => {
    sessionHasMoreRef.current = value
    setSessionHasMore(value)
  }, [])

  const pushToast = useCallback((message: string, level: ToastLevel = 'info') => {
    const id = ++toastId.current
    setToasts((previous) => [...previous.slice(-4), { id, message, level }])
    window.setTimeout(
      () => setToasts((previous) => previous.filter((toast) => toast.id !== id)),
      level === 'error' ? 8000 : 4500,
    )
  }, [])

  const showError = useCallback(
    (message: string) => pushToast(stripIpcWrapper(message), 'error'),
    [pushToast],
  )

  /**
   * An answer's change bar opened the files area. A row also names the file it
   * stands for, so the drawer jumps straight to that preview.
   */
  const openArtifacts = useCallback(() => {
    setArtifactSeed(null)
    setResourcesTab('artifacts')
  }, [])

  const openArtifact = useCallback((artifact: SessionArtifact) => {
    artifactSeedKey.current += 1
    setArtifactSeed({ path: artifact.path, key: artifactSeedKey.current })
    setResourcesTab('artifacts')
  }, [])

  /** 顶栏与侧栏是同一个入口：再点一次收起，和其他抽屉的手感一致。 */
  const toggleResources = useCallback((tab: ResourceTab) => {
    setResourcesTab((current) => (current === tab ? null : tab))
  }, [])

  /**
   * 左下角的「定时」角标要算所有会话，所以在定时任务变化时重新汇总一次：
   * 事件里只带一个 sessionId，阔不出其他会话的条数。
   */
  useEffect(() => {
    let cancelled = false
    void window.pilot
      .allScheduledTasks()
      .then((groups) => {
        if (cancelled) return
        setScheduledCount(
          groups.reduce(
            (sum, group) => sum + group.tasks.filter((task) => task.enabled).length,
            0,
          ),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scheduleRevision])

  /**
   * Answer the pending phone request. The dialog closes right away and the
   * main process decides whether the request was still open (it may have timed
   * out while the prompt was on screen).
   */
  const decidePairing = useCallback(
    (requestId: string, approved: boolean, role?: 'host' | 'client') => {
      setPairRequest((current) =>
        current && current.requestId === requestId ? null : current,
      )
      void window.pilot
        .companionPairDecision(requestId, approved, role)
        .then((answered) => {
          if (answered) return
          pushToast(t('这个配对请求已失效，请让手机重新扫码。'), 'warn')
        })
        .catch((error: unknown) => showError(errorMessage(error)))
    },
    [pushToast, showError],
  )

  const openSettings = useCallback((focus: SettingsFocus = null) => {
    setUpdateOpen(false)
    setSettingsFocus(focus)
    setSettingsOpen(true)
  }, [])

  /**
   * 浏览器里没有原生窗口按钮，全屏只能走 Fullscreen API。必须由用户手势触发
   * （双击顶栏算手势，但还是可能被策略或 iframe 拒绝，要告诉用户而不是静默失败）。
   * 顶栏不放全屏按钮：那条只剩系统级入口，多一个四角箭头容易被读成
   * 「展开/收拢」这类面板开关，真正的开关留在会话资源抽屉头部。
   */
  const toggleFullscreen = useCallback(() => {
    const enter = document.fullscreenElement === null
    const action = enter
      ? document.documentElement.requestFullscreen()
      : document.exitFullscreen()
    void action.catch((caught: unknown) => showError(errorMessage(caught)))
  }, [showError])

  const checkForUpdates = useCallback(() => {
    window.pilot.updates
      .check()
      .then((next) => setUpdate(next))
      .catch((error) => showError(t("检查更新失败：{v1}", { v1: errorMessage(error) })))
  }, [showError])

  const openUpdates = useCallback(() => {
    setSettingsOpen(false)
    setUpdateOpen(true)
    checkForUpdates()
  }, [checkForUpdates])

  const closeUpdates = useCallback(() => setUpdateOpen(false), [])

  const downloadUpdate = useCallback(() => {
    window.pilot.updates
      .download()
      .then((next) => setUpdate(next))
      .catch((error) => showError(t("下载更新失败：{v1}", { v1: errorMessage(error) })))
  }, [showError])

  const installUpdate = useCallback(() => {
    window.pilot.updates
      .install()
      .catch((error) => showError(t("安装更新失败：{v1}", { v1: errorMessage(error) })))
  }, [showError])

  const isLightTheme = settings?.theme === 'light'

  const toggleTheme = useCallback(async () => {
    if (!settings) return
    const previous = settings.theme
    const next = previous === 'dark' ? 'light' : 'dark'
    setSettings((current) => (current ? { ...current, theme: next } : current))
    try {
      await window.pilot.setTheme(next)
    } catch (caught) {
      setSettings((current) => (current ? { ...current, theme: previous } : current))
      showError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [settings, showError])

  const loadSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      const seq = (sessionSeq.current[sessionId] ?? 0) + 1
      sessionSeq.current[sessionId] = seq
      try {
        const page = await window.pilot.getSessionPage(
          sessionId,
          undefined,
          SESSION_PAGE_SIZE,
        )
        const next = page?.session ?? null
        if (sessionSeq.current[sessionId] !== seq) return next
        if (activeSessionRef.current === sessionId) {
          const previous = sessionRef.current
          const sameSession = Boolean(next && previous && previous.id === next.id)
          let messages = next?.messages ?? []
          if (next && sameSession && previous) {
            // Keep messages the user has already paged in, then apply the
            // refreshed newest page. Map preserves the older-first order.
            const merged = new Map(previous.messages.map((message) => [message.id, message]))
            for (const message of next.messages) merged.set(message.id, message)
            messages = [...merged.values()]
          }
          // Put the steps the reader already opened back in place, so returning
          // to a conversation shows the same execution boxes it showed when
          // they left. Only runs whose question is still in the window come
          // back; earlier ones stay in the history behind "load earlier".
          const cachedRuns = next ? loadedRuns.current.get(sessionId) : undefined
          if (cachedRuns && cachedRuns.size > 0) {
            messages = restoreCachedRuns(messages, cachedRuns)
          }
          if (next) {
            setSession({ ...next, messages })
            if (!sameSession) setSessionHasMoreBoth(page?.hasMore ?? false)
          } else {
            setSession(null)
            setSessionHasMoreBoth(page?.hasMore ?? false)
          }
          // A run that stopped without an answer keeps a collapsed placeholder
          // where its own question is, so the box is the only thing left to
          // open. Runs that finished keep nothing: their answer is the result,
          // and one placeholder per turn is what buried the dialogue. A
          // different session must not inherit the previous one's placeholders.
          const loadedRunIds = runsWithSteps(messages)
          const reported = processPlaceholders(page?.processes ?? [], messages)
          setPendingProcesses((current) =>
            mergePendingProcesses(sameSession ? current : [], reported, loadedRunIds),
          )
          setSessionLoading(false)
        }
        if (next) {
          setSessions((previous) => {
            const summary = summaryOf(next)
            return previous.some((entry) => entry.id === next.id)
              ? previous.map((entry) => (entry.id === next.id ? summary : entry))
              : [summary, ...previous]
          })
        }
        return next
      } catch {
        if (activeSessionRef.current === sessionId) setSessionLoading(false)
        return null
      }
    },
    [setSessionHasMoreBoth],
  )

  const loadEarlier = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current
    if (!current || loadingEarlier || !sessionHasMoreRef.current) return false
    const first = current.messages[0]
    if (!first) return false
    setLoadingEarlier(true)
    try {
      // Dialogue only: execution steps are huge and rarely why someone scrolls
      // back. Each skipped run comes back as a summary the box can expand into,
      // placed after its own question. The page is short by design, so one
      // scroll-up adds a few turns in transcript order instead of the rest of
      // the session at once.
      const page: SessionPage | null = await window.pilot.getSessionPage(
        current.id,
        first.id,
        EARLIER_DIALOGUE_LIMIT,
        { dialogue: true },
      )
      if (!page) return false
      const current_ = sessionRef.current
      if (!current_ || current_.id !== current.id) return false
      const cachedRuns = loadedRuns.current.get(current.id)
      const existing = new Set(current_.messages.map((message) => message.id))
      const older = page.session.messages.filter((message) => !existing.has(message.id))
      const merged = [...older, ...current_.messages]
      // A run the reader opened before scrolling this far comes back as its
      // steps, not as another placeholder to click again.
      const restored = cachedRuns && cachedRuns.size > 0 ? restoreCachedRuns(merged, cachedRuns) : merged
      setSession({ ...current_, messages: restored })
      // Only runs whose steps are still missing - and that never produced an
      // answer - get a placeholder, so scrolling back never shows a box twice
      // and never stacks one grey box per turn above the reader's question.
      const loadedRunIds = runsWithSteps(restored)
      setPendingProcesses((previous) =>
        mergePendingProcesses(previous, processPlaceholders(page.processes ?? [], restored), loadedRunIds),
      )
      setSessionHasMoreBoth(page.hasMore)
      return page.session.messages.length > 0
    } catch (caught) {
      pushToast(errorMessage(caught), 'error')
      return false
    } finally {
      setLoadingEarlier(false)
    }
  }, [loadingEarlier, pushToast, setSessionHasMoreBoth])

  /** Load one run's execution steps when its placeholder expands. */
  const loadProcess = useCallback(
    async (runId: string): Promise<boolean> => {
      const current = sessionRef.current
      if (!current) return false
      try {
        const messages = await window.pilot.getSessionProcess(current.id, runId)
        if (sessionRef.current?.id !== current.id) return false
        if (messages.length === 0) {
          pushToast(t('这一轮的执行过程已经不在会话记录里了。'), 'warn')
          return false
        }
        // Remember the steps so switching away and back does not turn this box
        // into "not loaded" again. Oldest runs fall off once a session keeps
        // more than the cap, so the cache cannot grow without bound.
        const afterId = pendingProcessesRef.current.find((entry) => entry.runId === runId)?.afterId
        const perSession = loadedRuns.current.get(current.id) ?? new Map<string, CachedRun>()
        perSession.delete(runId)
        perSession.set(runId, { ...(afterId ? { afterId } : {}), messages })
        while (perSession.size > LOADED_RUN_CACHE_SIZE) {
          const oldest = perSession.keys().next().value
          if (!oldest) break
          perSession.delete(oldest)
        }
        loadedRuns.current.set(current.id, perSession)
        setSession((previous) =>
          previous && previous.id === current.id
            ? {
                ...previous,
                messages: insertProcessMessages(previous.messages, messages, afterId),
              }
            : previous,
        )
        setPendingProcesses((previous) => previous.filter((entry) => entry.runId !== runId))
        return true
      } catch (caught) {
        pushToast(errorMessage(caught), 'error')
        return false
      }
    },
    [pushToast],
  )

  const loadDetail = useCallback(async (workspacePath: string): Promise<void> => {
    const seq = ++detailSeq.current
    try {
      const next = await window.pilot.getWorkspaceDetail(workspacePath)
      if (detailSeq.current !== seq) return
      if (activeWorkspaceRef.current !== workspacePath) return
      setDetail(next)
      setWorkspaces((previous) => {
        if (previous.some((workspace) => workspace.path === next.workspace.path)) {
          return previous.map((workspace) =>
            workspace.path === next.workspace.path ? next.workspace : workspace,
          )
        }
        return [next.workspace, ...previous]
      })
    } catch {
      // The detail panel is best-effort; the conversation remains usable.
    }
  }, [])

  const refreshSessions = useCallback(async (workspacePath: string): Promise<void> => {
    const seq = (sessionsSeq.current[workspacePath] ?? 0) + 1
    sessionsSeq.current[workspacePath] = seq
    try {
      const list = await window.pilot.listSessions(workspacePath)
      if (sessionsSeq.current[workspacePath] !== seq) return
      setSessions((previous) => [
        ...previous.filter((entry) => entry.workspacePath !== workspacePath),
        ...list,
      ])
    } catch {
      // Sidebar refresh is best-effort.
    }
  }, [])

  const refreshAllSessions = useCallback(
    async (list: WorkspaceSummary[]): Promise<void> => {
      await Promise.all(list.map((workspace) => refreshSessions(workspace.path)))
    },
    [refreshSessions],
  )

  const applyBootstrap = useCallback(
    (data: BootstrapData) => {
      if (
        applyLocaleSetting(
          data.settings.locale,
          data.settings.systemLocale ? [data.settings.systemLocale] : undefined,
        )
      ) {
        // First boot after a language change (or an OS change while following
        // the system): re-import modules so module-level labels use the new
        // language. The chosen locale is cached, so this reload happens once.
        window.location.reload()
        return
      }
      setSettings(data.settings)
      setWorkspaces(data.workspaces)
      setSessions(data.sessions)
      setActiveWorkspace(data.activeWorkspace)
      setActiveSessionId(data.activeSession)
      activeWorkspaceRef.current = data.activeWorkspace
      activeSessionRef.current = data.activeSession
      setSession(null)
      setSessionHasMoreBoth(false)
      setDetail(null)
      setLiveRuns({})
      setActiveRuns({})
      setApprovals([])
      setRunErrors({})
      setSessionLoading(Boolean(data.activeSession))
      setFocusMessageId(null)
      setChangesOpen(false)
      setVersion(data.version)
      setPlatform(data.platform)
      setHost(data.host)
      if (data.activeWorkspace) void loadDetail(data.activeWorkspace)
      if (data.activeSession) void loadSession(data.activeSession)
      else setSessionLoading(false)
      if (data.workspaces.length > 0) void refreshAllSessions(data.workspaces)
    },
    [loadDetail, loadSession, refreshAllSessions, setSessionHasMoreBoth],
  )

  useEffect(() => {
    let cancelled = false
    window.pilot
      .bootstrap()
      .then((data) => {
        if (cancelled) return
        applyBootstrap(data)
        setBooted(true)
      })
      .catch((error) => {
        if (cancelled) return
        setFatal(errorMessage(error))
        setBooted(true)
      })
    return () => {
      cancelled = true
    }
  }, [applyBootstrap])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.pilot.updates.onState((next) => {
      if (!cancelled) setUpdate(next)
    })
    window.pilot.updates
      .state()
      .then((next) => {
        if (!cancelled) setUpdate(next)
      })
      .catch(() => {
        if (cancelled) return
        setUpdate((previous) => ({
          ...previous,
          status: 'error',
          message: t("无法读取更新状态，请稍后重试。"),
        }))
      })

    const timer = window.setTimeout(() => {
      window.pilot.updates
        .check()
        .then((next) => {
          if (cancelled) return
          setUpdate(next)
          if (next.status === 'available' && next.release) {
            pushToast(t("发现新版本 v{v1}，点击左下角版本号查看。", { v1: next.release.version }), 'info')
          }
        })
        .catch(() => undefined)
    }, 2500)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [pushToast])

  // Only two themes exist, so the stored value is painted as-is.
  useEffect(() => {
    document.documentElement.dataset['theme'] = settings?.theme ?? 'dark'
  }, [settings?.theme])

  useEffect(() => {
    document.documentElement.dataset['fontSize'] = settings?.fontSize ?? 'standard'
  }, [settings?.fontSize])

  useEffect(() => {
    document.documentElement.dataset['platform'] = platform
  }, [platform])

  // 浏览器全屏是标签页级的：按 Esc、F11 或用户用浏览器菜单进出时不会走我们的
  // 双击处理，只能监听 `fullscreenchange` 才知道当前是不是全屏态。
  useEffect(() => {
    const sync = (): void => setFullscreen(Boolean(document.fullscreenElement))
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const flushPendingDeltas = useCallback(() => {
    if (deltaFrame.current !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(deltaFrame.current)
      deltaFrame.current = null
    }
    const pending = pendingDeltas.current
    if (pending.size === 0) return
    const batch = [...pending.values()]
    pending.clear()
    // Functional updates from the same tick run in enqueue order, so a flush
    // triggered by a following tool/step event still lands before that event.
    setLiveRuns((previous) => {
      let next = previous
      for (const delta of batch) {
        next = updateLive(next, delta.sessionId, delta.runId, (live) => ({
          ...live,
          ...(delta.text ? { content: live.content + delta.text } : {}),
          ...(delta.reasoning ? { reasoning: live.reasoning + delta.reasoning } : {}),
        }))
      }
      return next
    })
  }, [])

  const queueDelta = useCallback(
    (sessionId: string, runId: string, kind: 'text' | 'reasoning', text: string) => {
      const key = `${sessionId}\u0000${runId}`
      const pending = pendingDeltas.current
      const entry = pending.get(key) ?? { sessionId, runId, text: '', reasoning: '' }
      if (kind === 'text') entry.text += text
      else entry.reasoning += text
      pending.set(key, entry)
      if (deltaFrame.current === null) {
        deltaFrame.current =
          typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(() => flushPendingDeltas())
            : window.setTimeout(() => flushPendingDeltas(), 16)
      }
    },
    [flushPendingDeltas],
  )

  const handleEvent = useCallback(
    (event: RunEvent) => {
      // Any non-delta event (a tool call, the next step, run end) must observe
      // the streamed text that preceded it, so flush synchronously first.
      if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') {
        flushPendingDeltas()
      }
      switch (event.type) {
        case 'run.started': {
          const sessionId = event.sessionId
          setActiveRuns((previous) => ({ ...previous, [sessionId]: true }))
          setRunErrors((previous) => omit(previous, sessionId))
          setLiveRuns((previous) => ({
            ...previous,
            [sessionId]: {
              ...emptyLiveRun(sessionId),
              runId: event.runId,
              startedAt: Date.now(),
            },
          }))
          setSessions((previous) =>
            previous.map((entry) =>
              entry.id === sessionId ? { ...entry, running: true } : entry,
            ),
          )
          void loadSession(sessionId)
          return
        }
        case 'step.started': {
          const sessionId = event.sessionId
          setLiveRuns((previous) =>
            previous[sessionId]
              ? {
                  ...previous,
                  [sessionId]: { ...previous[sessionId]!, step: event.step },
                }
              : previous,
          )
          return
        }
        case 'message.started': {
          const sessionId = event.sessionId
          setLiveRuns((previous) =>
            updateLive(previous, sessionId, event.runId, (live) => ({
              ...live,
              content: '',
              reasoning: '',
              status: 'running',
            })),
          )
          return
        }
        case 'message.delta': {
          queueDelta(event.sessionId, event.runId, 'text', event.text)
          return
        }
        case 'reasoning.delta': {
          queueDelta(event.sessionId, event.runId, 'reasoning', event.text)
          return
        }
        case 'tool.call': {
          const sessionId = event.sessionId
          setLiveRuns((previous) =>
            updateLive(previous, sessionId, event.runId, (live) => {
              if (live.tools.some((tool) => tool.id === event.call.id)) return live
              const tool = createToolView(event.call, event.risk)
              const note = live.content.trim() ? live.content : ''
              const reasoning = live.reasoning.trim() ? live.reasoning : ''
              // A report stays in the answer area instead of sliding into the
              // step box: the step here is only the cleanup after it, and the
              // replay would put the report back in the dialogue.
              const report = note ? isDeliverableText(note) : false
              // Reasoning and interim text belong to the step that ends with this call.
              const parts: ProcessPart[] = [
                ...(live.parts ?? []),
                ...(reasoning
                  ? [{ kind: 'reasoning' as const, key: `r-${tool.id}`, text: reasoning, at: tool.at }]
                  : []),
                ...(note && !report
                  ? [{ kind: 'note' as const, key: `n-${tool.id}`, text: note, at: tool.at }]
                  : []),
                { kind: 'tool' as const, key: tool.id, toolId: tool.id },
              ]
              return {
                ...live,
                content: report ? live.content : '',
                reasoning: '',
                processText: note && !report ? [...live.processText, note] : live.processText,
                processReasoning: reasoning
                  ? [...live.processReasoning, reasoning]
                  : live.processReasoning,
                tools: [...live.tools, tool],
                parts,
              }
            }),
          )
          return
        }
        case 'tool.approval_required': {
          const sessionId = event.sessionId
          setLiveRuns((previous) =>
            updateLive(previous, sessionId, event.runId, (live) => {
              const exists = live.tools.some((tool) => tool.id === event.call.id)
              if (exists) {
                return {
                  ...live,
                  tools: live.tools.map((tool) =>
                    tool.id === event.call.id ? { ...tool, status: 'waiting' } : tool,
                  ),
                }
              }
              const tool = { ...createToolView(event.call, event.risk), status: 'waiting' as const }
              const parts: ProcessPart[] = [
                ...(live.parts ?? []),
                { kind: 'tool', key: tool.id, toolId: tool.id },
              ]
              return { ...live, tools: [...live.tools, tool], parts }
            }),
          )
          setApprovals((previous) =>
            previous.some((entry) => entry.callId === event.call.id)
              ? previous
              : [
                  ...previous,
                  {
                    callId: event.call.id,
                    runId: event.runId,
                    sessionId,
                    tool: event.call.name,
                    risk: event.risk,
                    arguments: event.call.arguments ?? {},
                    ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
                  },
                ],
          )
          return
        }
        case 'tool.approval_resolved': {
          const sessionId = event.sessionId
          setApprovals((previous) =>
            previous.filter((entry) => entry.callId !== event.callId),
          )
          setLiveRuns((previous) =>
            updateLive(previous, sessionId, event.runId, (live) => ({
              ...live,
              tools: live.tools.map((tool) =>
                tool.id === event.callId
                  ? {
                      ...tool,
                      status: event.approved ? 'running' : 'denied',
                      ...(event.reason ? { approvalReason: event.reason } : {}),
                    }
                  : tool,
              ),
            })),
          )
          return
        }
        case 'tool.result': {
          const sessionId = event.sessionId
          setLiveRuns((previous) =>
            updateLive(previous, sessionId, event.runId, (live) => {
              const existing = live.tools.find((tool) => tool.id === event.callId)
              const updated = {
                ...(existing ?? {
                  id: event.callId,
                  name: event.name,
                  args: {},
                  risk: event.result.risk ?? inferRisk(event.name),
                  status: 'running' as const,
                  at: new Date().toISOString(),
                }),
                status: event.result.ok ? ('ok' as const) : ('error' as const),
                result: event.result,
                durationMs: event.result.durationMs,
              }
              return {
                ...live,
                tools: existing
                  ? live.tools.map((tool) => (tool.id === event.callId ? updated : tool))
                  : [...live.tools, updated],
                ...(existing
                  ? {}
                  : {
                      parts: [
                        ...(live.parts ?? []),
                        { kind: 'tool' as const, key: updated.id, toolId: updated.id },
                      ],
                    }),
              }
            }),
          )
          return
        }
        case 'context.compacted': {
          const sessionId = event.sessionId
          setLiveRuns((previous) =>
            updateLive(previous, sessionId, event.runId, (live) => ({
              ...live,
              compacted: t("上下文已压缩：整理 {v1} 条旧工具输出，移除 {v2} 条早期消息（约 {v3} tokens）。", { v1: event.compactedResults, v2: event.droppedMessages, v3: event.estimatedTokens.toLocaleString() }),
            })),
          )
          return
        }
        case 'run.completed': {
          const sessionId = event.sessionId
          setActiveRuns((previous) => omit(previous, sessionId))
          setApprovals((previous) => previous.filter((entry) => entry.sessionId !== sessionId))
          setSessions((previous) =>
            previous.map((entry) =>
              entry.id === sessionId ? { ...entry, running: false } : entry,
            ),
          )
          if (event.status !== 'completed') {
            pushToast(
              event.status === 'paused'
                ? t("任务已暂停，可随时从断点继续。")
                : event.status === 'cancelled'
                  ? t("任务已停止。")
                  : event.status === 'max_steps'
                    ? t("达到步数上限，任务已暂停。")
                    : t("Token 预算已用尽，任务已停止。"),
              event.status === 'paused' ? 'info' : 'warn',
            )
          }
          void (async () => {
            const next = await loadSession(sessionId)
            setLiveRuns((previous) => omit(previous, sessionId))
            setRunErrors((previous) => omit(previous, sessionId))
            const workspacePath = next?.workspacePath ?? activeWorkspaceRef.current
            if (workspacePath) {
              void loadDetail(workspacePath)
              void refreshSessions(workspacePath)
            }
          })()
          return
        }
        case 'run.failed': {
          const sessionId = event.sessionId
          pushToast(event.message, 'error')
          setRunErrors((previous) => ({ ...previous, [sessionId]: event.message }))
          setActiveRuns((previous) => omit(previous, sessionId))
          setApprovals((previous) => previous.filter((entry) => entry.sessionId !== sessionId))
          setSessions((previous) =>
            previous.map((entry) =>
              entry.id === sessionId ? { ...entry, running: false } : entry,
            ),
          )
          void (async () => {
            const next = await loadSession(sessionId)
            setLiveRuns((previous) => omit(previous, sessionId))
            const workspacePath = next?.workspacePath ?? activeWorkspaceRef.current
            if (workspacePath) {
              void loadDetail(workspacePath)
              void refreshSessions(workspacePath)
            }
          })()
          return
        }
        case 'queue.changed': {
          const sessionId = event.sessionId
          setSessions((previous) =>
            previous.map((entry) =>
              entry.id === sessionId ? { ...entry, queueCount: event.queue.length } : entry,
            ),
          )
          if (activeSessionRef.current === sessionId) {
            setSession((previous) =>
              previous ? { ...previous, queue: event.queue, queueCount: event.queue.length } : previous,
            )
          }
          return
        }
        case 'todos.changed': {
          const sessionId = event.sessionId
          const todoCount = event.todos.filter((todo) => todo.status === 'pending').length
          setTodosRevision((value) => value + 1)
          setSessions((previous) =>
            previous.map((entry) =>
              entry.id === sessionId ? { ...entry, todoCount } : entry,
            ),
          )
          if (activeSessionRef.current === sessionId) {
            setSession((previous) =>
              previous ? { ...previous, todos: event.todos, todoCount } : previous,
            )
          }
          return
        }
        case 'scheduled.changed': {
          // 定时任务可能属于别的会话：角标与全站视图都要跟着刷新，
          // 所以这里不再限定「当前会话」才自增。
          setScheduleRevision((value) => value + 1)
          return
        }
        case 'session.changed': {
          const sessionId = event.sessionId
          // Apply the plan from the event immediately instead of waiting for
          // the full session reload, so the panel cannot flicker or vanish
          // while a run keeps updating it.
          if (event.plan !== undefined) {
            const plan = event.plan
            setSessions((previous) =>
              previous.map((entry) =>
                entry.id === sessionId ? { ...entry, plan } : entry,
              ),
            )
            if (activeSessionRef.current === sessionId) {
              setSession((previous) => (previous ? { ...previous, plan } : previous))
            }
          }
          void loadSession(sessionId).then((next) => {
            const workspacePath = next?.workspacePath ?? activeWorkspaceRef.current
            if (workspacePath) void refreshSessions(workspacePath)
          })
          return
        }
        case 'workspace.changed': {
          // 手机端新建了工作区：只刷新工作区列表，不切换电脑端当前目录。
          void window.pilot
            .bootstrap()
            .then((data) => setWorkspaces(data.workspaces))
            .catch(() => undefined)
          return
        }
        case 'memory.changed': {
          if (activeWorkspaceRef.current !== event.workspacePath) return
          void loadDetail(event.workspacePath)
          const now = Date.now()
          if (now - memoryToastAt.current > 4000) {
            memoryToastAt.current = now
            pushToast(t("项目记忆已更新。"), 'info')
          }
          return
        }
        case 'profile.changed': {
          if (activeWorkspaceRef.current !== event.workspacePath) return
          void loadDetail(event.workspacePath)
          const now = Date.now()
          if (now - profileToastAt.current > 4000) {
            profileToastAt.current = now
            pushToast(t("自我进化版本已更新。"), 'info')
          }
          return
        }
        case 'evolution.changed': {
          if (activeWorkspaceRef.current !== event.workspacePath) return
          void loadDetail(event.workspacePath)
          return
        }
        case 'settings.changed': {
          setSettings(event.settings)
          return
        }
        case 'notice': {
          pushToast(event.message, event.level)
          return
        }
        case 'companion.pair_request': {
          setPairRequest(event.request)
          return
        }
        case 'companion.pair_resolved': {
          setPairRequest((current) =>
            current && current.requestId === event.requestId ? null : current,
          )
          if (!event.approved && event.reason) pushToast(event.reason, 'warn')
          return
        }
      }
    },
    [flushPendingDeltas, loadDetail, loadSession, pushToast, queueDelta, refreshSessions],
  )

  useEffect(() => window.pilot.onEvent(handleEvent), [handleEvent])

  /**
   * 质量闸门的三个动作都回传整份 QualityState，直接写回 detail，
   * 不再二次请求：否则铃铛会闪一下旧分数。
   */
  const runQualityAction = useCallback(
    async (action: () => Promise<QualityState>): Promise<void> => {
      setQualityBusy(true)
      try {
        const next = await action()
        setDetail((previous) => (previous ? { ...previous, quality: next } : previous))
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      } finally {
        setQualityBusy(false)
      }
    },
    [pushToast],
  )

  const onQualityEvaluate = useCallback(() => {
    const workspacePath = activeWorkspaceRef.current
    if (!workspacePath) return
    void runQualityAction(() => window.pilot.qualityEvaluate(workspacePath))
  }, [runQualityAction])

  const onQualityDecide = useCallback(
    (candidateId: string, decision: 'approve' | 'reject') => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) return
      void runQualityAction(() => window.pilot.qualityDecide(workspacePath, candidateId, decision))
    },
    [runQualityAction],
  )

  const onQualityPublish = useCallback(
    (candidateId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) return
      void runQualityAction(() => window.pilot.qualityPublish(workspacePath, candidateId))
    },
    [runQualityAction],
  )

  const onQualityTune = useCallback(() => {
    const workspacePath = activeWorkspaceRef.current
    if (!workspacePath) return
    void runQualityAction(() => window.pilot.qualityTune(workspacePath))
  }, [runQualityAction])

  // 点系统通知打开铃铛：把工作区切到通知里那个，再重拉一次 detail。
  useEffect(
    () =>
      window.pilot.onFocusQuality((workspacePath) => {
        if (!workspacePath) return
        if (activeWorkspaceRef.current !== workspacePath) {
          setActiveWorkspace(workspacePath)
          void loadDetail(workspacePath)
        }
      }),
    [loadDetail],
  )

  useEffect(
    () => () => {
      if (deltaFrame.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(deltaFrame.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (!activeWorkspace) {
      setProjectInstructions([])
      return
    }
    let cancelled = false
    void window.pilot
      .projectInstructions(activeWorkspace)
      .then((list) => {
        if (!cancelled) setProjectInstructions(list)
      })
      .catch(() => {
        if (!cancelled) setProjectInstructions([])
      })
    return () => {
      cancelled = true
    }
  }, [activeWorkspace])

  const newSession = useCallback(
    async (workspacePath?: string) => {
      const target = workspacePath ?? activeWorkspaceRef.current
      if (!target) {
        setWorkspaceDialogOpen(true)
        return
      }
      try {
        if (activeWorkspaceRef.current !== target) {
          await window.pilot.openWorkspace(target)
          applyBootstrap(await window.pilot.bootstrap())
        }
        const created = await window.pilot.createSession(target)
        activeSessionRef.current = created.id
        setActiveSessionId(created.id)
        setSession(created)
        setSessionHasMoreBoth(false)
        setSessionLoading(false)
        // 新会话没有历史：上一个会话的占位框必须就地丢掉。它们带着旧会话的
        // runId，留在状态里既会在新会话顶部挤出成排执行框，点开也只会得到
        // 「这一轮的执行过程已经不在会话记录里」，因为按新会话 id 查不到。
        setPendingProcesses([])
        setSessions((previous) => [
          summaryOf(created),
          ...previous.filter((entry) => entry.id !== created.id),
        ])
        setView('chat')
        void refreshSessions(target)
        void loadDetail(target)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [applyBootstrap, loadDetail, pushToast, refreshSessions, setSessionHasMoreBoth],
  )

  const openModuleCheckSession = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        const created = await window.pilot.getSession(sessionId)
        if (!created) {
          pushToast(t("自检生成的会话已不存在，请重新自检。"), 'warn')
          return
        }
        activeSessionRef.current = created.id
        setActiveSessionId(created.id)
        setSession(created)
        setSessionHasMoreBoth(false)
        setSessionLoading(false)
        setPendingProcesses([])
        setSessions((previous) => [
          summaryOf(created),
          ...previous.filter((entry) => entry.id !== created.id),
        ])
        setView('chat')
        void refreshSessions(created.workspacePath)
        void loadDetail(created.workspacePath)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadDetail, pushToast, refreshSessions, setSessionHasMoreBoth],
  )

  /**
   * 复盘评估页签里的历史列表：进化是它唯一入口，所以列表从会话里筛出 kind=review 的项，
   * 最近更新的排在最上面。
   */
  const reviewSessionEntries = useMemo(
    () =>
      sessions
        .filter((entry) => entry.kind === 'review')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((entry) => ({ id: entry.id, title: entry.title })),
    [sessions],
  )

  const openReview = useCallback(() => {
    if (!activeWorkspaceRef.current) {
      setWorkspaceDialogOpen(true)
      pushToast(t("先选择一个工作区，再新建复盘评估。"), 'warn')
      return
    }
    setReviewOpen(true)
  }, [pushToast])

  const reviewCreated = useCallback(
    async (created: Session) => {
      setReviewOpen(false)
      setReviewReportOpen(false)
      activeSessionRef.current = created.id
      setActiveSessionId(created.id)
      setSession(created)
      setSessionHasMoreBoth(false)
      setSessionLoading(false)
      setSessions((previous) => [
        summaryOf(created),
        ...previous.filter((entry) => entry.id !== created.id),
      ])
      setView('chat')
      pushToast(t("复盘会话已创建：只读读取源码和会话，不写入、不执行命令。"), 'info')
      void refreshSessions(created.workspacePath)
      void loadDetail(created.workspacePath)
      if (!settings?.hasKey) {
        pushToast(t("配置 API Key 后发送任意消息即可开始评估。"), 'warn')
        return
      }
      try {
        const result = await window.pilot.sendMessage(
          created.id,
          t("请开始复盘评估。先核对可读目录与会话证据，再按报告协议输出结构化结论。"),
          'queue',
        )
        if (!result.queued) {
          setActiveRuns((previous) => ({ ...previous, [created.id]: true }))
        }
        await loadSession(created.id)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [
      loadDetail,
      loadSession,
      pushToast,
      refreshSessions,
      setSessionHasMoreBoth,
      settings?.hasKey,
    ],
  )

  const handoffReview = useCallback(async () => {
    const current = sessionRef.current
    if (!current || current.kind !== 'review' || handingOff) return
    if (!current.reviewReport) {
      pushToast(t("复盘还没有生成结构化报告，先完成评估再交接修复。"), 'warn')
      return
    }
    setHandingOff(true)
    try {
      const created = await window.pilot.handoffReview(current.id)
      activeSessionRef.current = created.id
      setActiveSessionId(created.id)
      setSession(created)
      setSessionHasMoreBoth(false)
      setSessionLoading(false)
      setSessions((previous) => [
        summaryOf(created),
        ...previous.filter((entry) => entry.id !== created.id),
      ])
      setReviewReportOpen(false)
      setActiveRuns((previous) => ({ ...previous, [created.id]: true }))
      setView('chat')
      pushToast(t("已创建普通编码会话，会先复核每条问题再修改。"), 'info')
      await loadSession(created.id)
      void refreshSessions(created.workspacePath)
      void loadDetail(created.workspacePath)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    } finally {
      setHandingOff(false)
    }
  }, [
    handingOff,
    loadDetail,
    loadSession,
    pushToast,
    refreshSessions,
    setSessionHasMoreBoth,
  ])

  const sendMessage = useCallback(
    async (text: string, delivery: MessageDelivery, options?: MessageOptions): Promise<boolean> => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) {
        setWorkspaceDialogOpen(true)
        pushToast(t("先选择一个工作区。"), 'warn')
        return false
      }
      let sessionId = activeSessionRef.current
      try {
        if (!sessionId) {
          const created = await window.pilot.createSession(workspacePath)
          sessionId = created.id
          activeSessionRef.current = created.id
          setActiveSessionId(created.id)
          setSession(created)
          setSessionHasMoreBoth(false)
          // A fresh session has no history, so hold on to no placeholder from
          // the conversation that was open before.
          setPendingProcesses([])
          setSessions((previous) => [
            summaryOf(created),
            ...previous.filter((entry) => entry.id !== created.id),
          ])
          void refreshSessions(workspacePath)
        }
        setView('chat')
        setRunErrors((previous) => omit(previous, sessionId!))
        const result = await window.pilot.sendMessage(sessionId, text, delivery, options)
        if (result.queued) {
          pushToast(t("已加入队列，当前任务结束后自动开始。"), 'info')
        } else {
          setActiveRuns((previous) => ({ ...previous, [sessionId!]: true }))
        }
        await loadSession(sessionId)
        return true
      } catch (error) {
        pushToast(errorMessage(error), 'error')
        return false
      }
    },
    [loadSession, pushToast, refreshSessions],
  )

  const quickStart = useCallback(
    (text: string) => {
      if (!settings?.hasKey) {
        openSettings()
        return
      }
      void sendMessage(text, 'queue')
    },
    [sendMessage, settings?.hasKey],
  )

  const selectSession = useCallback(
    (target: SessionSummary) => {
      const sessionId = target.id
      setView('chat')
      setReviewReportOpen(false)
      setFocusMessageId(null)
      if (activeSessionRef.current === sessionId) return
      if (activeWorkspaceRef.current !== target.workspacePath) {
        void (async () => {
          try {
            await window.pilot.openWorkspace(target.workspacePath)
            applyBootstrap(await window.pilot.bootstrap())
            activeSessionRef.current = sessionId
            setActiveSessionId(sessionId)
            setSession(null)
            setSessionHasMoreBoth(false)
            setSessionLoading(true)
            void loadSession(sessionId)
          } catch (error) {
            pushToast(errorMessage(error), 'error')
          }
        })()
        return
      }
      activeSessionRef.current = sessionId
      setActiveSessionId(sessionId)
      setSession(null)
      setSessionHasMoreBoth(false)
      setSessionLoading(true)
      void loadSession(sessionId)
    },
    [applyBootstrap, loadSession, pushToast, setSessionHasMoreBoth],
  )

  /** 全量待办里点会话标题：按 id 找到列表里的会话再切过去。 */
  const openSessionById = useCallback(
    (sessionId: string) => {
      const target = sessions.find((entry) => entry.id === sessionId)
      if (!target) {
        pushToast(t("这个会话已不在列表里，可能被删除了。"), 'warn')
        return
      }
      selectSession(target)
    },
    [pushToast, selectSession, sessions],
  )

  const deleteSession = useCallback(
    async (target: SessionSummary) => {
      if (
        !window.confirm(
          t("删除会话「{v1}」？\n\n聊天记录会从本机删除，项目记忆和进化版本不受影响。", { v1: target.title }),
        )
      ) {
        return
      }
      try {
        await window.pilot.deleteSession(target.id)
        loadedRuns.current.delete(target.id)
        const list = await window.pilot.listSessions(target.workspacePath)
        setSessions((previous) => [
          ...previous.filter((entry) => entry.workspacePath !== target.workspacePath),
          ...list,
        ])
        if (
          activeWorkspaceRef.current === target.workspacePath &&
          activeSessionRef.current === target.id
        ) {
          const next = list[0]?.id ?? null
          activeSessionRef.current = next
          setActiveSessionId(next)
          setSession(null)
          setSessionHasMoreBoth(false)
          if (next) {
            setSessionLoading(true)
            void loadSession(next)
          } else {
            setSessionLoading(false)
          }
        }
        pushToast(t("会话已删除。"), 'info')
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadSession, pushToast],
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        const updated = await window.pilot.updateSession(sessionId, { title })
        setSessions((previous) =>
          previous.map((entry) => (entry.id === sessionId ? updated : entry)),
        )
        setSession((previous) =>
          previous && previous.id === sessionId
            ? {
                ...previous,
                title: updated.title,
                updatedAt: updated.updatedAt,
                approvalMode: updated.approvalMode,
              }
            : previous,
        )
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast],
  )

  const changeApprovalMode = useCallback(
    async (mode: ApprovalMode) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        const updated = await window.pilot.updateSession(sessionId, { approvalMode: mode })
        setSessions((previous) =>
          previous.map((entry) => (entry.id === sessionId ? updated : entry)),
        )
        setSession((previous) =>
          previous && previous.id === sessionId
            ? { ...previous, approvalMode: updated.approvalMode }
            : previous,
        )
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast],
  )

  const changeSessionModel = useCallback(
    async (modelId: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        const updated = await window.pilot.setSessionModel(sessionId, modelId)
        setSessions((previous) =>
          previous.map((entry) => (entry.id === sessionId ? updated : entry)),
        )
        setSession((previous) =>
          previous && previous.id === sessionId
            ? {
                ...previous,
                sessionModelId: updated.sessionModelId,
                updatedAt: updated.updatedAt,
              }
            : previous,
        )
        const resource = settings?.modelResources.find((item) => item.id === modelId)
        const label = resource
          ? modelOptionLabel(
              modelResourceName(resource) || t("未命名模型"),
              resource.tag,
            )
          : ''
        pushToast(
          modelId
            ? t("这个任务将使用「{v1}」", { v1: label })
            : t("这个任务已跟随全局会话模型"),
          'info',
        )
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast, settings],
  )

  const stopRun = useCallback(async () => {
    const sessionId = activeSessionRef.current
    if (!sessionId) return
    if (!window.confirm(t("停止当前任务？停止后不会自动继续，需要重新发送。"))) return
    try {
      await window.pilot.cancelRun(sessionId)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [pushToast])

  const pauseRun = useCallback(async () => {
    const sessionId = activeSessionRef.current
    if (!sessionId) return
    if (!window.confirm(t("暂停当前任务？暂停后可随时点「继续」接着执行。"))) return
    try {
      await window.pilot.pauseRun(sessionId)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [pushToast])

  const continueRun = useCallback(async () => {
    const sessionId = activeSessionRef.current
    if (!sessionId || continuing) return
    setContinuing(true)
    try {
      await window.pilot.continueRun(sessionId)
      setActiveRuns((previous) => ({ ...previous, [sessionId]: true }))
      await loadSession(sessionId)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    } finally {
      setContinuing(false)
    }
  }, [continuing, loadSession, pushToast])

  const editMessage = useCallback(
    async (messageId: string, content: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        await window.pilot.editMessage(sessionId, messageId, content)
        setFocusMessageId(null)
        setRunErrors((previous) => omit(previous, sessionId))
        setActiveRuns((previous) => ({ ...previous, [sessionId]: true }))
        // Old messages after the edit were dropped by the main process; clear
        // the cached transcript so loadSession does not merge them back in.
        sessionRef.current = null
        setSession(null)
        await loadSession(sessionId)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadSession, pushToast],
  )

  const deleteMessage = useCallback(
    async (messageId: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        await window.pilot.deleteMessage(sessionId, messageId)
        setFocusMessageId(null)
        // The main process rewrote the transcript; drop the cached copy so
        // loadSession reads the shortened one instead of merging the old one.
        sessionRef.current = null
        setSession(null)
        await loadSession(sessionId)
        pushToast(t("指令已删除。"), 'info')
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadSession, pushToast],
  )

  const regenerate = useCallback(async () => {
    const sessionId = activeSessionRef.current
    if (!sessionId) return
    try {
      await window.pilot.regenerate(sessionId)
      setFocusMessageId(null)
      setRunErrors((previous) => omit(previous, sessionId))
      setActiveRuns((previous) => ({ ...previous, [sessionId]: true }))
      sessionRef.current = null
      setSession(null)
      await loadSession(sessionId)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [loadSession, pushToast])

  const retryRun = useCallback(async () => {
    const sessionId = activeSessionRef.current
    if (!sessionId) return
    try {
      await window.pilot.retryRun(sessionId)
      setRunErrors((previous) => omit(previous, sessionId))
      setActiveRuns((previous) => ({ ...previous, [sessionId]: true }))
      sessionRef.current = null
      setSession(null)
      await loadSession(sessionId)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [loadSession, pushToast])

  const revealSession = useCallback(
    async (target: Session, messageId?: string): Promise<void> => {
      setView('chat')
      setReviewReportOpen(false)
      if (activeWorkspaceRef.current !== target.workspacePath) {
        const opened = await window.pilot.openWorkspace(target.workspacePath)
        activeWorkspaceRef.current = target.workspacePath
        setActiveWorkspace(target.workspacePath)
        setWorkspaces((previous) =>
          previous.some((workspace) => workspace.path === target.workspacePath)
            ? previous.map((workspace) =>
                workspace.path === target.workspacePath ? opened.workspace : workspace,
              )
            : [opened.workspace, ...previous],
        )
        setSessions((previous) => [
          ...previous.filter((entry) => entry.workspacePath !== target.workspacePath),
          ...opened.sessions,
        ])
        void loadDetail(target.workspacePath)
      }
      activeSessionRef.current = target.id
      setActiveSessionId(target.id)
      setSessionLoading(true)
      setFocusMessageId(messageId ?? null)
      // Search hits and notifications may point outside the newest page, so
      // load the full transcript before scrolling to the target message.
      setSession(target)
      setSessionHasMoreBoth(false)
      setSessionLoading(false)
      setSessions((previous) =>
        previous.some((entry) => entry.id === target.id)
          ? previous.map((entry) => (entry.id === target.id ? summaryOf(target) : entry))
          : [summaryOf(target), ...previous],
      )
    },
    [loadDetail, setSessionHasMoreBoth],
  )

  useEffect(
    () =>
      window.pilot.onFocusSession((sessionId) => {
        void (async () => {
          try {
            const target =
              sessionRef.current?.id === sessionId
                ? sessionRef.current
                : await window.pilot.getSession(sessionId)
            if (target) await revealSession(target)
          } catch (error) {
            pushToast(errorMessage(error), 'error')
          }
        })()
      }),
    [pushToast, revealSession],
  )

  const openMessage = useCallback(
    (sessionId: string, messageId: string) => {
      void (async () => {
        try {
          const current = sessionRef.current
          const target =
            current?.id === sessionId &&
            current.messages.some((message) => message.id === messageId)
              ? current
              : await window.pilot.getSession(sessionId)
          if (!target) throw new Error(t("会话不存在，可能已被删除"))
          await revealSession(target, messageId)
        } catch (error) {
          pushToast(errorMessage(error), 'error')
        }
      })()
    },
    [pushToast, revealSession],
  )

  const openSearchHit = useCallback(
    (hit: MessageSearchHit) => openMessage(hit.sessionId, hit.messageId),
    [openMessage],
  )

  const forkSession = useCallback(async () => {
    const sessionId = activeSessionRef.current
    if (!sessionId) return
    try {
      const fork = await window.pilot.forkSession(sessionId)
      activeSessionRef.current = fork.id
      setActiveSessionId(fork.id)
      setSession(fork)
      setSessionHasMoreBoth(false)
      setSessionLoading(false)
      setLiveRuns((previous) => omit(previous, sessionId))
      setSessions((previous) => [
        summaryOf(fork),
        ...previous.filter((entry) => entry.id !== fork.id),
      ])
      setView('chat')
      pushToast(t("已创建副本，可以从这里分叉尝试别的做法。"), 'info')
      void refreshSessions(fork.workspacePath)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [pushToast, refreshSessions])

  const copyTranscript = useCallback(async () => {
    if (!session) return
    try {
      // The UI may only hold one page; the main process has the full transcript.
      const text = await window.pilot.getSessionTranscript(session.id)
      if (!text.trim()) {
        pushToast(t("当前会话还没有可复制的内容。"), 'warn')
        return
      }
      if (!(await copyText(text))) {
        pushToast(t("复制失败，请稍后重试。"), 'error')
        return
      }
      // 复制入口现在收在「更多操作」菜单里，菜单会随即关闭，所以用 toast 回执。
      pushToast(t("已复制对话"))
    } catch {
      pushToast(t("复制失败，请稍后重试。"), 'error')
    }
  }, [pushToast, session])

  const todoSession = useCallback((): string | null => activeSessionRef.current, [])

  const addTodo = useCallback(
    async (text: string, priority: TodoPriority = 'normal') => {
      const sessionId = todoSession()
      if (!sessionId) return
      try {
        await window.pilot.addTodo(sessionId, text, undefined, priority)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast, todoSession],
  )

  /**
   * 正文里滑选一段话后「添加待办」。
   *
   * 与会话输入框加待办不同：这里可能连会话都还没有（新窗口先读了一段旧内容），
   * 所以缺会话时先建一个再写待办，否则选中的文字会静静丢掉。
   */
  const addSelectedTodo = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      try {
        let sessionId = activeSessionRef.current
        if (!sessionId) {
          const workspacePath = activeWorkspaceRef.current
          if (!workspacePath) {
            setWorkspaceDialogOpen(true)
            pushToast(t("先选择一个工作区。"), 'warn')
            return
          }
          const created = await window.pilot.createSession(workspacePath)
          sessionId = created.id
          activeSessionRef.current = created.id
          setActiveSessionId(created.id)
          setSession(created)
          setSessionHasMoreBoth(false)
          setPendingProcesses([])
          setSessions((previous) => [
            summaryOf(created),
            ...previous.filter((entry) => entry.id !== created.id),
          ])
          void refreshSessions(workspacePath)
        }
        await window.pilot.addTodo(sessionId, trimmed)
        await loadSession(sessionId)
        pushToast(t("已把选中内容加入待办。"), 'info')
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadSession, pushToast, refreshSessions, setSessionHasMoreBoth],
  )

  const updateTodo = useCallback(
    async (todoId: string, text: string) => {
      const sessionId = todoSession()
      if (!sessionId) return
      try {
        await window.pilot.updateTodo(sessionId, todoId, text)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast, todoSession],
  )

  const removeTodo = useCallback(
    async (todoId: string) => {
      const sessionId = todoSession()
      if (!sessionId) return
      try {
        await window.pilot.removeTodo(sessionId, todoId)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast, todoSession],
  )

  const setTodoPriority = useCallback(
    async (todoId: string, priority: TodoPriority) => {
      const sessionId = todoSession()
      if (!sessionId) return
      try {
        await window.pilot.setTodoPriority(sessionId, todoId, priority)
        // 优先级会改变列表顺序，重新拉一次会话以便面板立刻重排。
        await loadSession(sessionId)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadSession, pushToast, todoSession],
  )

  const sendTodo = useCallback(
    async (todoId: string) => {
      const sessionId = todoSession()
      if (!sessionId) return
      try {
        const result = await window.pilot.sendTodo(sessionId, todoId)
        pushToast(
          result.queued ? t("待办已加入队列，当前任务结束后自动开始。") : t("待办已发送。"),
          'info',
        )
        await loadSession(sessionId)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadSession, pushToast, todoSession],
  )

  const sendAllTodos = useCallback(async () => {
    const sessionId = todoSession()
    if (!sessionId) return
    try {
      const result = await window.pilot.sendAllTodos(sessionId)
      pushToast(
        result.failed > 0
          ? t("已发送 {v1} 项，{v2} 项失败。", { v1: result.sent, v2: result.failed })
          : t("已发送 {v1} 项待办。", { v1: result.sent }),
        result.failed > 0 ? 'warn' : 'info',
      )
      await loadSession(sessionId)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [loadSession, pushToast, todoSession])

  const clearSentTodos = useCallback(async () => {
    const sessionId = todoSession()
    if (!sessionId) return
    try {
      await window.pilot.clearSentTodos(sessionId)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [pushToast, todoSession])

  const decideApproval = useCallback(
    async (callId: string, approved: boolean, remember = false) => {
      try {
        await window.pilot.decideApproval(callId, approved, undefined, remember)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
        setApprovals((previous) => previous.filter((entry) => entry.callId !== callId))
      }
    },
    [pushToast],
  )

  const removeQueueItem = useCallback(
    async (taskId: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        await window.pilot.removeQueueItem(sessionId, taskId)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast],
  )

  const insertQueueItem = useCallback(
    async (taskId: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        await window.pilot.insertQueueItem(sessionId, taskId)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast],
  )

  const updateQueueItem = useCallback(
    async (taskId: string, content: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        await window.pilot.updateQueueItem(sessionId, taskId, content)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast],
  )

  const convertQueueItemToTodo = useCallback(
    async (taskId: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        const todo = await window.pilot.convertQueueItemToTodo(sessionId, taskId)
        if (todo) pushToast(t("已把排队任务转为待办。"), 'info')
        await loadSession(sessionId)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [loadSession, pushToast],
  )

  /** 待办上的时钟按钮：把内容带进会话内的定时面板，由面板自己展开表单。 */
  const scheduleTodo = useCallback((todo: TodoItem) => {
    setScheduleSeed({ content: todo.text, todoId: todo.id })
  }, [])

  const convertScheduledTaskToTodo = useCallback(
    async (taskId: string) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return
      try {
        await window.pilot.convertScheduledTaskToTodo(sessionId, taskId)
        setScheduleRevision((value) => value + 1)
        pushToast(t("已把定时任务转为待办。"), 'info')
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast],
  )

  const convertTodoToSchedule = useCallback(
    async (todoId: string, input: ScheduledTaskInput) => {
      const sessionId = activeSessionRef.current
      if (!sessionId) return null
      try {
        const task = await window.pilot.convertTodoToSchedule(sessionId, todoId, input)
        setScheduleRevision((value) => value + 1)
        pushToast(t("已把待办转为定时任务。"), 'info')
        return task
      } catch (error) {
        pushToast(errorMessage(error), 'error')
        return null
      }
    },
    [pushToast],
  )

  const setFeedback = useCallback(
    (runId: string, rating: 'up' | 'down') => {
      const sessionId = activeSessionRef.current
      const workspacePath = activeWorkspaceRef.current
      if (!sessionId) return
      setDetail((previous) =>
        previous
          ? {
              ...previous,
              runs: previous.runs.map((run) =>
                run.id === runId
                  ? {
                      ...run,
                      feedback: { rating, at: new Date().toISOString() },
                    }
                  : run,
              ),
            }
          : previous,
      )
      void window.pilot
        .setFeedback(sessionId, runId, rating)
        .then(() => {
          pushToast(rating === 'up' ? t("已记录正反馈。") : t("已记录负反馈，Pilot 会复盘这次运行。"), 'info')
          if (workspacePath) void loadDetail(workspacePath)
        })
        .catch((error) => {
          pushToast(errorMessage(error), 'error')
          if (workspacePath) void loadDetail(workspacePath)
        })
    },
    [loadDetail, pushToast],
  )

  const reflectRun = useCallback(
    async (runId: string): Promise<number> => {
      const sessionId = activeSessionRef.current
      const workspacePath = activeWorkspaceRef.current
      if (!sessionId) return 0
      try {
        const entries = await window.pilot.reflectRun(sessionId, runId)
        if (workspacePath) void loadDetail(workspacePath)
        pushToast(
          entries.length > 0
            ? t("复盘完成，新增 {v1} 条项目记忆。", { v1: entries.length })
            : t("复盘完成，没有新的可复用经验。"),
          'info',
        )
        return entries.length
      } catch (error) {
        pushToast(errorMessage(error), 'error')
        return 0
      }
    },
    [loadDetail, pushToast],
  )

  const addMemory = useCallback(
    async (content: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) return
      try {
        await window.pilot.addMemory(workspacePath, content)
        await loadDetail(workspacePath)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
        throw error
      }
    },
    [loadDetail, pushToast],
  )

  const deleteMemory = useCallback(
    async (memoryId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) return
      try {
        await window.pilot.deleteMemory(workspacePath, memoryId)
        await loadDetail(workspacePath)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
        throw error
      }
    },
    [loadDetail, pushToast],
  )

  const proposeEvolution = useCallback(async () => {
    const workspacePath = activeWorkspaceRef.current
    if (!workspacePath) throw new Error('No active workspace')
    const profile = await window.pilot.proposeEvolution(workspacePath)
    await loadDetail(workspacePath)
    pushToast(t("已生成候选版本 v{v1}，请进行独立评审。", { v1: profile.version }), 'info')
  }, [loadDetail, pushToast])

  const runSystemEvolution = useCallback(async () => {
    const workspacePath = activeWorkspaceRef.current
    if (!workspacePath) throw new Error('No active workspace')
    const cycle = await window.pilot.runSystemEvolution(workspacePath)
    await loadDetail(workspacePath)
    pushToast(cycle.summary, cycle.status === 'failed' ? 'warn' : 'info')
    return cycle
  }, [loadDetail, pushToast])

  const improveEvolutionFlow = useCallback(async () => {
    const version = await window.pilot.improveEvolutionFlow()
    const workspacePath = activeWorkspaceRef.current
    if (workspacePath) await loadDetail(workspacePath)
    pushToast(
      version
        ? t("进化机制已更新到 v{v1}。", { v1: version.version })
        : t("当前进化机制无需调整。"),
      'info',
    )
    return version
  }, [loadDetail, pushToast])

  const rollbackEvolutionPolicy = useCallback(async () => {
    const version = await window.pilot.rollbackEvolutionPolicy()
    const workspacePath = activeWorkspaceRef.current
    if (workspacePath) await loadDetail(workspacePath)
    pushToast(
      version
        ? t("已回滚到进化机制 v{v1}。", { v1: version.version })
        : t("没有可回滚的进化机制版本。"),
      'info',
    )
    return version
  }, [loadDetail, pushToast])

  /**
   * 进化记录不再自动裁剪，只有用户主动点「清理」才删。当前生效的策略版本
   * 会被保留：删掉它等于默默回退到内置默认值，不是「清理历史」的语义。
   */
  const clearEvolutionHistory = useCallback(async () => {
    await window.pilot.clearEvolutionHistory()
    const workspacePath = activeWorkspaceRef.current
    if (workspacePath) await loadDetail(workspacePath)
    pushToast(t("已清理进化记录，当前生效的机制保留不变。"), 'info')
  }, [loadDetail, pushToast])

  const toggleAutoEvolve = useCallback(
    async (value: boolean) => {
      const next = await window.pilot.updateSettings({ autoEvolve: value })
      setSettings(next)
      pushToast(
        value ? t("已开启系统级自动进化。") : t("已关闭系统级自动进化。"),
        'info',
      )
    },
    [pushToast],
  )

  const reviewProfile = useCallback(
    async (profileId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const result = await window.pilot.reviewProfile(workspacePath, profileId)
      await loadDetail(workspacePath)
      return result
    },
    [loadDetail],
  )

  const benchmarkProfile = useCallback(
    async (profileId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const report = await window.pilot.benchmarkProfile(workspacePath, profileId)
      await loadDetail(workspacePath)
      return report
    },
    [loadDetail],
  )

  const activateProfile = useCallback(
    async (profileId: string, force?: boolean) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const profile = await window.pilot.activateProfile(workspacePath, profileId, force)
      await loadDetail(workspacePath)
      pushToast(t("版本 v{v1} 已启用。", { v1: profile.version }), 'info')
    },
    [loadDetail, pushToast],
  )

  const rollbackProfile = useCallback(async () => {
    const workspacePath = activeWorkspaceRef.current
    if (!workspacePath) throw new Error('No active workspace')
    const profile = await window.pilot.rollbackProfile(workspacePath)
    await loadDetail(workspacePath)
    pushToast(
      profile ? t("已回滚到版本 v{v1}。", { v1: profile.version }) : t("没有可回滚的历史版本。"),
      'info',
    )
  }, [loadDetail, pushToast])

  const deleteProfile = useCallback(
    async (profileId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      await window.pilot.deleteProfile(workspacePath, profileId)
      await loadDetail(workspacePath)
      pushToast(t("候选版本已删除。"), 'info')
    },
    [loadDetail, pushToast],
  )

  const promoteProfile = useCallback(
    async (profileId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const profile = await window.pilot.promoteProfile(workspacePath, profileId)
      await loadDetail(workspacePath)
      pushToast(t("已生成全局候选 v{v1}，请独立评审后手动启用。", { v1: profile.version }), 'info')
      return profile
    },
    [loadDetail, pushToast],
  )

  const localizeProfile = useCallback(
    async (profileId: string, scope: 'workspace' | 'global') => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const profile = await window.pilot.localizeProfile(scope, workspacePath, profileId)
      await loadDetail(workspacePath)
      pushToast(t("已生成中文版本 v{v1}，请评审后再启用。", { v1: profile.version }), 'info')
      return profile
    },
    [loadDetail, pushToast],
  )

  const explainProfile = useCallback(
    async (profileId: string, scope: 'workspace' | 'global') => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const profile = await window.pilot.explainProfile(scope, workspacePath, profileId)
      await loadDetail(workspacePath)
      pushToast(t('已用日常说法说明 v{v1}。', { v1: profile.version }), 'info')
      return profile
    },
    [loadDetail, pushToast],
  )

  const benchmarkGlobalProfile = useCallback(
    async (profileId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const report = await window.pilot.benchmarkGlobalProfile(profileId)
      await loadDetail(workspacePath)
      return report
    },
    [loadDetail],
  )

  const reviewGlobalProfile = useCallback(
    async (profileId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const result = await window.pilot.reviewGlobalProfile(profileId)
      await loadDetail(workspacePath)
      return result
    },
    [loadDetail],
  )

  const activateGlobalProfile = useCallback(
    async (profileId: string, force?: boolean) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      const profile = await window.pilot.activateGlobalProfile(profileId, force)
      await loadDetail(workspacePath)
      pushToast(t("全局画像 v{v1} 已启用。", { v1: profile.version }), 'info')
    },
    [loadDetail, pushToast],
  )

  const rollbackGlobalProfile = useCallback(async () => {
    const workspacePath = activeWorkspaceRef.current
    if (!workspacePath) throw new Error('No active workspace')
    const profile = await window.pilot.rollbackGlobalProfile()
    await loadDetail(workspacePath)
    pushToast(
      profile ? t("已回滚到全局画像 v{v1}。", { v1: profile.version }) : t("没有可回滚的历史全局版本。"),
      'info',
    )
  }, [loadDetail, pushToast])

  const deleteGlobalProfile = useCallback(
    async (profileId: string) => {
      const workspacePath = activeWorkspaceRef.current
      if (!workspacePath) throw new Error('No active workspace')
      await window.pilot.deleteGlobalProfile(profileId)
      await loadDetail(workspacePath)
      pushToast(t("全局候选版本已删除。"), 'info')
    },
    [loadDetail, pushToast],
  )

  const switchWorkspace = useCallback(
    async (path: string) => {
      await window.pilot.openWorkspace(path)
      const data = await window.pilot.bootstrap()
      applyBootstrap(data)
    },
    [applyBootstrap],
  )

  const openSelfSource = useCallback(async () => {
    const result = await window.pilot.prepareSelfSource()
    await switchWorkspace(result.path)
    setView('chat')
    pushToast(
      result.copied
        ? t("已准备好自身源码工作区，可以开始修改 Pilot。")
        : t("已打开自身源码工作区。"),
      'info',
    )
  }, [switchWorkspace, pushToast])

  const chatSelfSource = useCallback(async () => {
    const result = await window.pilot.prepareSelfSource()
    // 源码目录就是一个普通工作区：新建对话后把开场白放进输入框，
    // 用户可以改成自己的说法，再由 Pilot 读 SELF.md、修改、跑门禁并构建。
    await newSession(result.path)
    composerSeedKeyRef.current += 1
    setComposerSeed({
      key: composerSeedKeyRef.current,
      text: t(
        "我想改造自己的 Pilot。请先读 SELF.md，了解源码结构和构建方式，然后用简短的话说明可以定制哪些地方，并问我最想改什么。先不要改代码，等我确认。",
      ),
    })
    pushToast(
      result.copied
        ? t("已准备好自身源码工作区，可以开始告诉 Pilot 你想改什么。")
        : t("已打开自身源码工作区，可以开始告诉 Pilot 你想改什么。"),
      'info',
    )
  }, [newSession, pushToast])

  const loadPersonal = useCallback(() => window.pilot.personalEvolution(), [])
  const savePersonalVersion = useCallback(
    (input: { name: string; note?: string }) => window.pilot.savePersonalVersion(input),
    [],
  )
  const restorePersonalVersion = useCallback(
    (versionId: string) => window.pilot.restorePersonalVersion(versionId),
    [],
  )
  const submitPersonalVersion = useCallback(
    (versionId: string, note: string) => window.pilot.submitPersonalVersion(versionId, note),
    [],
  )
  const revealPersonalContribution = useCallback(
    (contributionId: string) => window.pilot.revealPersonalContribution(contributionId),
    [],
  )
  const preparePersonalUpgrade = useCallback(() => window.pilot.preparePersonalUpgrade(), [])
  const applyPersonalUpgrade = useCallback(() => window.pilot.applyPersonalUpgrade(), [])
  const validatePersonalUpgrade = useCallback(() => window.pilot.validatePersonalUpgrade(), [])
  const rollbackPersonalUpgrade = useCallback(() => window.pilot.rollbackPersonalUpgrade(), [])
  const askResolveUpgrade = useCallback(
    async (
      sourcePath: string,
      conflicts: string[],
      toVersion: string,
      officialCopyPath?: string,
    ) => {
      if (activeWorkspaceRef.current !== sourcePath) await switchWorkspace(sourcePath)
      composerSeedKeyRef.current += 1
      setComposerSeed({
        key: composerSeedKeyRef.current,
        text: officialCopyPath
          ? t(
              "官方已经升级到 v{v1}，但找不到升级前的官方基线，无法自动合并。新版官方源码已复制到 {v2}，我当前的个人源码在工作区根目录。请逐文件对比，把官方更新迁移进来，同时保留我的改动，并检查跨文件调用是否同步（例如方法、类型或参数变了，所有调用方都要一起改）。完成后运行 pnpm typecheck 和 pnpm test，全部通过后运行 node scripts/self-build.mjs 构建个人版。",
              { v1: toVersion, v2: officialCopyPath },
            )
          : t(
              "官方已经合并到 v{v1}，以下文件还留着冲突标记（<<<<<<< 我的版本 / >>>>>>> 官方 v{v1}）：\n{v2}\n\n请逐个解决冲突，既保留我的意图也吸收官方更新，并检查跨文件调用是否同步（例如方法、类型或参数变了，所有调用方都要一起改）。然后运行 pnpm typecheck 和 pnpm test，全部通过后运行 node scripts/self-build.mjs 构建个人版，并告诉我改了什么。",
              { v1: toVersion, v2: conflicts.join('\n') },
            ),
      })
      setView('chat')
    },
    [switchWorkspace],
  )
  const askFixUpgrade = useCallback(
    async (sourcePath: string, details: string, toVersion: string) => {
      if (activeWorkspaceRef.current !== sourcePath) await switchWorkspace(sourcePath)
      composerSeedKeyRef.current += 1
      setComposerSeed({
        key: composerSeedKeyRef.current,
        text: t(
          "我把官方 v{v1} 合并进了个人源码，但检查没有通过：\n\n{v2}\n\n请定位并修复。重点检查跨文件调用是否一致：官方可能改了方法、类型或参数，而我的改动仍按旧接口调用。修好后运行 pnpm typecheck、pnpm test 和 node scripts/self-build.mjs，最后说明改了什么。",
          { v1: toVersion, v2: details.slice(0, 4_000) },
        ),
      })
      setView('chat')
    },
    [switchWorkspace],
  )
  const askPilotToBuild = useCallback(
    async (sourcePath: string) => {
      if (activeWorkspaceRef.current !== sourcePath) await switchWorkspace(sourcePath)
      composerSeedKeyRef.current += 1
      setComposerSeed({
        key: composerSeedKeyRef.current,
        text: t(
          "请按 SELF.md 的流程构建我的个人版：先检查当前改动，特别确认官方更新和我的改动在跨文件调用上是否一致（例如某个方法、类型或参数被改后，所有调用方是否同步），然后运行 pnpm typecheck、pnpm test 和 node scripts/self-build.mjs；失败就修到通过，最后告诉我实验版目录和改了什么。",
        ),
      })
      setView('chat')
    },
    [switchWorkspace],
  )

  const refreshSidebarSessions = useCallback(() => {
    void refreshAllSessions(workspaces)
  }, [refreshAllSessions, workspaces])

  const pickWorkspace = useCallback(async () => {
    try {
      const path = await window.pilot.pickFolder()
      if (!path) return
      await switchWorkspace(path)
      setWorkspaceDialogOpen(false)
    } catch (error) {
      pushToast(errorMessage(error), 'error')
    }
  }, [pushToast, switchWorkspace])

  const removeWorkspace = useCallback(
    async (path: string) => {
      await window.pilot.removeWorkspace(path)
      const data = await window.pilot.bootstrap()
      applyBootstrap(data)
      pushToast(t("工作区已移除。"), 'info')
    },
    [applyBootstrap, pushToast],
  )

  const revealWorkspace = useCallback(
    async (path: string) => {
      try {
        await window.pilot.openWorkspaceFolder(path)
      } catch (error) {
        pushToast(errorMessage(error), 'error')
      }
    },
    [pushToast],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier) return
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void newSession()
      } else if (event.key === ',') {
        event.preventDefault()
        setUpdateOpen(false)
        setSettingsOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newSession])

  const workspace = useMemo(
    () => workspaces.find((entry) => entry.path === activeWorkspace) ?? null,
    [activeWorkspace, workspaces],
  )

  // 任务级模型：只在任务会话里选。空值表示跟随全局会话模型。
  // 触发器只放名称（顶栏很窄），模型名和标签只在展开的列表里出现。
  const sessionModelOptions = useMemo(() => {
    const resources = settings?.modelResources ?? []
    const nameFor = (resource: (typeof resources)[number]): string =>
      modelResourceName(resource) || t("未命名模型")
    const inherited =
      resources.find((item) => item.id === settings?.sessionModelId) ?? resources[0]
    return [
      {
        value: '',
        label: inherited
          ? t("跟随全局（{v1}）", { v1: nameFor(inherited) })
          : t("跟随全局会话模型"),
        triggerLabel: t("跟随全局"),
        detail: inherited?.model.trim() || undefined,
        note: inherited ? normalizeModelTag(inherited.tag) || undefined : undefined,
      },
      ...resources.map((resource) => ({
        value: resource.id,
        label: nameFor(resource),
        detail: resource.model.trim() || undefined,
        note: normalizeModelTag(resource.tag) || undefined,
      })),
    ]
  }, [settings])

  const sessionModelValue =
    session?.sessionModelId &&
    (settings?.modelResources ?? []).some((item) => item.id === session.sessionModelId)
      ? session.sessionModelId
      : ''
  const live = activeSessionId ? liveRuns[activeSessionId] : undefined
  const running = Boolean(
    activeSessionId && (activeRuns[activeSessionId] || session?.running),
  )
  const runningSince =
    live?.startedAt ??
    (session?.runStartedAt ? Date.parse(session.runStartedAt) : undefined)
  const activeApprovals = approvals.filter(
    (entry) => entry.sessionId === activeSessionId,
  )
  const activeRunError = activeSessionId ? runErrors[activeSessionId] : undefined
  const draftProfileCount = detail?.profiles.filter((profile) => profile.status === 'draft').length ?? 0

  // Context usage is estimated locally from the transcript (and the answer
  // currently streaming), so the readout never costs a model request and never
  // waits on an IPC round trip.
  const contextUsage = useMemo(
    () =>
      session
        ? transcriptUsage(session.messages, live?.content ?? '')
        : null,
    [session, live?.content],
  )

  // 会话级操作原来平铺成七个图标，现在收进一个「更多操作」菜单：
  // 顶栏少占约 230px，标题不再被挤成两三个字，面板打开状态改用勾选表达。
  const sessionMenuItems: TopbarMenuItem[] = []
  if (session) {
    sessionMenuItems.push({
      key: 'copy-transcript',
      label: t("复制对话"),
      icon: <CopyIcon width={15} height={15} />,
      onSelect: () => void copyTranscript(),
    })
    // 「会话资源」只保留导航栏右侧那一个图标，避免两个入口互相抢焦点。
    if (session.kind !== 'review') {
      sessionMenuItems.push({
        key: 'fork',
        label: t("创建副本"),
        hint: t("基于当前会话新建一个副本"),
        icon: <LayersIcon width={15} height={15} />,
        onSelect: () => void forkSession(),
      })
      sessionMenuItems.push({
        key: 'checkpoints',
        label: t("回退点"),
        hint: t("回退点：恢复文件或对话"),
        icon: <HistoryIcon width={15} height={15} />,
        active: checkpointsOpen,
        onSelect: () => setCheckpointsOpen(true),
      })
      sessionMenuItems.push({
        key: 'changes',
        label: t("变更审阅"),
        hint: t("变更审阅：比较并撤销本次会话修改的文件"),
        icon: <DiffIcon width={15} height={15} />,
        active: changesOpen,
        onSelect: () => setChangesOpen(true),
      })
      // 定时任务不再是弹框：入口在输入框上方的待办列表下面，与移动端一致。
    }
  }

  if (!booted) {
    return (
      <div className="app-splash">
        <PilotLogo width={52} height={52} />
        <span className="splash-brand">PILOT</span>
        <i className="spinner" />
      </div>
    )
  }

  if (fatal) {
    return (
      <div className="app-fatal">
        <PilotLogo width={46} height={46} />
        <h1>{t("Pilot 无法启动")}</h1>
        <p>{fatal}</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          {t("重试")}</button>
      </div>
    )
  }

  return (
    <div className="app" data-platform={platform} data-host={host}>
      <div
        className="titlebar"
        data-fullscreen={fullscreen ? 'true' : undefined}
        title={host === 'server' ? t("双击顶栏切换全屏") : undefined}
        onDoubleClick={(event) => {
          // 网页端双击顶栏空白处切换全屏。按钮、链接、资源条上的双击留给它们自己。
          if (host !== 'server') return
          const target = event.target as HTMLElement
          if (target.closest('button, a, input, select, textarea, [role="button"], .resource-meters')) return
          toggleFullscreen()
        }}
      >
        <div className="titlebar-brand">
          <PilotLogo width={18} height={18} />
          <span>PILOT</span>
          <span className="titlebar-tag">
            LOCAL AGENT{version ? ` · v${version}` : ''}
          </span>
        </div>
        <div className="titlebar-path">{workspace?.path ?? ''}</div>
        {/* 本机负载常驻在窗口最上边这条栏：切到任何视图都能看；点击看详情。 */}
        <ResourceMeters
          workspacePath={detail?.workspace.path ?? activeWorkspace ?? undefined}
          onOpen={() => setResourceDialogOpen(true)}
        />
        {/* 设置放在资源条后面：它属于「这台机器」这一组，不跟会话操作混在一起。
            「进化」收进设置后，待确认草稿数改成这颗齿轮上的徽标：进化入口只此一个。 */}
        <button
          type="button"
          className={`titlebar-icon${settingsOpen ? ' is-active' : ''}`}
          title={
            draftProfileCount > 0
              ? t("设置（{v1} 项进化草稿待确认）", { v1: draftProfileCount })
              : t("设置")
          }
          aria-label={t("设置")}
          onClick={() => openSettings()}
        >
          <SettingsIcon width={15} height={15} />
          {draftProfileCount > 0 ? (
            <span className="titlebar-icon-badge">{draftProfileCount}</span>
          ) : null}
        </button>
      </div>

      <div className="app-shell">
        <Sidebar
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          sessions={sessions}
          activeSession={activeSessionId}
          view={view}
          feedbackOpen={feedbackOpen}
          version={version}
          update={update}
          updateOpen={updateOpen}
          onPickWorkspace={() => void pickWorkspace()}
          onNewSession={(workspacePath) => void newSession(workspacePath)}
          todoCount={sessions.reduce((sum, entry) => sum + entry.todoCount, 0)}
          scheduledCount={scheduledCount}
          onSelectSession={selectSession}
          onDeleteSession={(target) => void deleteSession(target)}
          onOpenSearchHit={openSearchHit}
          onView={setView}
          onOpenFeedback={() => setFeedbackOpen(true)}
          onOpenUpdate={openUpdates}
          onCloseUpdate={closeUpdates}
          onCheckUpdate={checkForUpdates}
          onDownloadUpdate={downloadUpdate}
          onInstallUpdate={installUpdate}
          onRevealWorkspace={() => {
            if (activeWorkspace) void revealWorkspace(activeWorkspace)
          }}
          onRefreshSessions={refreshSidebarSessions}
          memoryCount={detail?.memory.length ?? 0}
        />

        <main className="main-area">
          <header className="topbar">
            <div className="topbar-left">
              <button
                type="button"
                className="topbar-workspace"
                onClick={() => setWorkspaceDialogOpen(true)}
                title={t("{v1} · 点击管理工作区", { v1: workspace?.path ?? t("未选择工作区") })}
              >
                <FolderIcon width={14} height={14} />
                {workspace?.name ?? t("未选择工作区")}
              </button>
              <span className="topbar-divider" />
              {view === 'chat' ? (
                <SessionTitleEditor session={session} onRename={(id, title) => void renameSession(id, title)} />
              ) : (
                <span className="header-title static">
                  {view === 'memory'
                    ? t("项目记忆")
                    : view === 'tools'
                      ? t("系统工具")
                      : view === 'todos'
                        ? t("全部待办")
                        : view === 'scheduled'
                          ? t("全部定时任务")
                          : view === 'plugins'
                            ? t("插件")
                            : view === 'models'
                              ? t("模型")
                              : t("偏好")}
                </span>
              )}
            </div>

            <div className="topbar-right">
              {view === 'chat' && session && session.kind !== 'review' ? (
                <SelectMenu
                  className="approval-menu session-model-menu"
                  value={sessionModelValue}
                  options={sessionModelOptions}
                  onChange={(value) => void changeSessionModel(value)}
                  ariaLabel={t("这个任务使用的会话模型")}
                  title={t("会话模型只影响这个任务，不会改统一设置")}
                  align="end"
                  maxListWidth={320}
                />
              ) : null}

              {/* 模型服务状态：只说连没连，模型名称由左边的下拉负责。 */}
              <button
                type="button"
                className="topbar-model"
                onClick={() => openSettings()}
                title={
                  settings?.hasKey
                    ? t("模型服务已连接 · 点击打开设置")
                    : t("尚未配置 API Key · 点击打开设置")
                }
              >
                <span className={`key-dot${settings?.hasKey ? ' ok' : ''}`} />
                <span className="topbar-model-state">
                  {settings?.hasKey ? t("已连接") : t("未连接")}
                </span>
              </button>

              {update.status === 'available' ||
              update.status === 'downloading' ||
              update.status === 'ready' ? (
                <button
                  type="button"
                  className={`topbar-update ${update.status}`}
                  onClick={() => setUpdateOpen(true)}
                  title={
                    update.status === 'available'
                      ? t("发现新版本 v{v1}，点击查看", { v1: update.release?.version ?? '' })
                      : update.status === 'downloading'
                        ? t("正在后台下载更新 {v1}%，不影响当前会话", { v1: Math.round(update.progress * 100) })
                        : t("更新已下载，点击查看安装")
                  }
                >
                  {update.status === 'downloading' ? (
                    <DownloadIcon width={14} height={14} />
                  ) : (
                    <UpdateIcon width={14} height={14} />
                  )}
                  <span>
                    {update.status === 'available'
                      ? `v${update.release?.version ?? ''}`
                      : update.status === 'downloading'
                        ? `${Math.round(update.progress * 100)}%`
                        : t("待安装")}
                  </span>
                </button>
              ) : null}

              {view === 'chat' && session && session.kind !== 'review' ? (
                <SelectMenu
                  className="approval-menu"
                  value={session.approvalMode}
                  options={APPROVAL_MODES}
                  onChange={(value) => void changeApprovalMode(value as ApprovalMode)}
                  ariaLabel={t("当前会话的执行模式")}
                  align="end"
                />
              ) : null}

              {view === 'chat' && session ? (
                <TopbarMenu
                  items={sessionMenuItems}
                  label={t("会话操作")}
                  title={t("更多会话操作")}
                />
              ) : null}

              {running ? (
                <RunningPill startedAt={runningSince} step={live?.step} />
              ) : null}

              {/* 分隔线把「当前会话的模式与操作」与「全局的铃铛/模型/主题/连接」分开。 */}
              {view === 'chat' && session ? <span className="topbar-split" /> : null}

              {/* 小铃铛：评估模型认为有更优版本时亮起，批准前不会打包。 */}
              <QualityBell
                workspacePath={detail?.workspace.path ?? activeWorkspace}
                state={detail?.quality ?? null}
                publishTarget={settings?.qualityPublishTarget ?? 'none'}
                busy={qualityBusy}
                onDecide={onQualityDecide}
                onPublish={onQualityPublish}
                onEvaluate={onQualityEvaluate}
                onTune={onQualityTune}
              />

              <button
                type="button"
                className="topbar-icon topbar-theme"
                onClick={() => void toggleTheme()}
                title={isLightTheme ? t("切换到深色模式") : t("切换到浅色模式")}
                aria-label={isLightTheme ? t("切换到深色模式") : t("切换到浅色模式")}
              >
                {isLightTheme ? (
                  <MoonIcon width={16} height={16} />
                ) : (
                  <SunIcon width={16} height={16} />
                )}
              </button>

              <button
                type="button"
                className={`topbar-icon${companionOpen ? ' is-active' : ''}`}
                onClick={() => setCompanionOpen(true)}
                title={t("手机连接")}
                aria-label={t("手机连接")}
              >
                <PhoneIcon width={16} height={16} />
              </button>
              <button
                type="button"
                className={`topbar-icon${resourcesTab ? ' is-active' : ''}`}
                onClick={() => toggleResources(resourcesTab ?? 'files')}
                title={t("会话资源")}
                aria-label={t("会话资源")}
              >
                <FilesIcon width={16} height={16} />
              </button>
            </div>
          </header>

          {view === 'chat' ? (
            sessionLoading && !session ? (
              <div className="session-loading-view">
                <i className="spinner" />
                <span>{t("载入会话…")}</span>
              </div>
            ) : (
              <>
                {session?.kind === 'review' ? (
                  <ReviewBanner
                    session={session}
                    handingOff={handingOff}
                    onOpenReport={() => setReviewReportOpen(true)}
                    onHandoff={() => void handoffReview()}
                  />
                ) : null}
                <ChatView
                workspace={workspace}
                workspaces={workspaces}
                session={session}
                live={live}
                runs={detail?.runs ?? []}
                approvals={activeApprovals}
                runError={activeRunError}
                hasKey={settings?.hasKey ?? false}
                running={running}
                hasEarlier={sessionHasMore}
                loadingEarlier={loadingEarlier}
                contextUsage={contextUsage}
                projectInstructions={projectInstructions}
                focusMessageId={focusMessageId}
                composerSeed={composerSeed}
                onLoadEarlier={loadEarlier}
                pendingProcesses={pendingProcesses}
                onLoadProcess={loadProcess}
                onSend={sendMessage}
                onStop={() => void stopRun()}
                onPause={() => void pauseRun()}
                onContinue={() => void continueRun()}
                onEditMessage={editMessage}
                onDeleteMessage={deleteMessage}
                onRegenerate={regenerate}
                onRetry={() => void retryRun()}
                continuing={continuing}
                onDecideApproval={(callId, approved, remember) =>
                  void decideApproval(callId, approved, remember)
                }
                onChangeApprovalMode={(mode) => void changeApprovalMode(mode)}
                onRemoveQueue={(taskId) => void removeQueueItem(taskId)}
                onInsertQueue={(taskId) => void insertQueueItem(taskId)}
                onUpdateQueue={updateQueueItem}
                onConvertQueue={(taskId) => void convertQueueItemToTodo(taskId)}
                onFeedback={setFeedback}
                onReflect={reflectRun}
                onQuickStart={quickStart}
                onPickWorkspace={() => void pickWorkspace()}
                onOpenSettings={openSettings}
                onAddTodo={addTodo}
                onAddSelectedTodo={addSelectedTodo}
                onUpdateTodo={updateTodo}
                onRemoveTodo={removeTodo}
                onSendTodo={sendTodo}
                onSendAllTodos={sendAllTodos}
                onClearSentTodos={clearSentTodos}
                onScheduleTodo={scheduleTodo}
                onSetTodoPriority={setTodoPriority}
                scheduleSeed={scheduleSeed}
                onScheduleSeedUsed={() => setScheduleSeed(null)}
                onConvertTodoToSchedule={convertTodoToSchedule}
                onConvertScheduleToTodo={convertScheduledTaskToTodo}
                onNotice={(message) => pushToast(message, 'info')}
                onOpenArtifact={openArtifact}
                onOpenArtifacts={openArtifacts}
                />
              </>
            )
          ) : view === 'memory' ? (
            <MemoryPanel
              workspace={workspace}
              detail={detail}
              onAdd={async (content) => {
                await addMemory(content)
              }}
              onDelete={async (memoryId) => {
                await deleteMemory(memoryId)
              }}
            />
          ) : view === 'todos' ? (
            <AllTodosPanel
              revision={todosRevision}
              onOpenSession={openSessionById}
              onError={showError}
              onNotice={(message) => pushToast(message, 'info')}
            />
          ) : view === 'tools' ? (
            <SystemToolsPanel workspace={workspace} onError={showError} />
          ) : view === 'scheduled' ? (
            <AllScheduledPanel
              revision={scheduleRevision}
              onOpenSession={openSessionById}
              onError={showError}
            />
          ) : view === 'plugins' ? (
            <PluginsPanel workspace={workspace} />
          ) : view === 'models' ? (
            settings ? (
              <ModelPanel
                settings={settings}
                onSaved={(next) => setSettings(next)}
                onNotice={(message) => pushToast(message, 'info')}
                onError={showError}
              />
            ) : null
          ) : view === 'preferences' ? (
            settings ? (
              <PreferencesPanel
                settings={settings}
                onSaved={(next) => setSettings(next)}
                onNotice={(message) => pushToast(message, 'info')}
                onError={showError}
              />
            ) : null
          ) : null}
        </main>
      </div>

      {resourcesTab ? (
        <SessionResourcesPanel
          workspace={workspace}
          session={session}
          tab={resourcesTab}
          onTabChange={setResourcesTab}
          artifactSeed={artifactSeed}
          memory={detail?.memory ?? []}
          onAddMemory={addMemory}
          onDeleteMemory={deleteMemory}
          onOpenMemoryPanel={() => {
            setResourcesTab(null)
            setArtifactSeed(null)
            setView('memory')
          }}
          onOpenMessage={openMessage}
          onOpenChanges={() => {
            setResourcesTab(null)
            setArtifactSeed(null)
            setChangesOpen(true)
          }}
          onClose={() => {
            setResourcesTab(null)
            setArtifactSeed(null)
          }}
          onError={showError}
          onNotice={(message) => pushToast(message, 'info')}
        />
      ) : null}

      {changesOpen && session ? (
        <ChangeReviewPanel
          session={session}
          onClose={() => setChangesOpen(false)}
          onReverted={() => {
            void loadSession(session.id)
            void refreshSessions(session.workspacePath)
          }}
          onNotice={(message) => pushToast(message, 'info')}
          onError={showError}
        />
      ) : null}

      {checkpointsOpen && session ? (
        <CheckpointDialog
          session={session}
          onClose={() => setCheckpointsOpen(false)}
          onRestored={(restored, safetyCheckpointId) => {
            setSession(restored)
            setSessions((previous) =>
              previous.map((entry) =>
                entry.id === restored.id ? summaryOf(restored) : entry,
              ),
            )
            setView('chat')
            pushToast(
              safetyCheckpointId
                ? t("已回退。回退前的工作区已存为「回退前」快照，可再回退一次撤销。")
                : t("已回退。检查工作区状态后继续任务。"),
              'info',
            )
          }}
          onError={showError}
        />
      ) : null}

      {resourceDialogOpen ? (
        <SystemResourceDialog
          workspacePath={detail?.workspace.path ?? activeWorkspace ?? undefined}
          onClose={() => setResourceDialogOpen(false)}
        />
      ) : null}

      {feedbackOpen ? (
        <FeedbackDialog
          version={version}
          workspacePath={workspace?.path ?? null}
          onClose={() => setFeedbackOpen(false)}
          onError={showError}
        />
      ) : null}

      {settingsOpen && settings ? (
        <SettingsDialog
          settings={settings}
          workspacePath={workspace?.path ?? null}
          focusSection={settingsFocus}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setSettings(next)
            pushToast(t("设置已保存。"), 'info')
          }}
          onError={showError}
          onWarn={(message) => pushToast(message, 'warn')}
          evolutionTabs={(helpers) =>
            evolutionWorkspaceTabs({
              settings,
              onOpenSession: openSessionById,
              onOpenModuleCheckSession: (sessionId) => {
                void openModuleCheckSession(sessionId)
              },
              onSettingsSaved: (next) => setSettings(next),
              onOpenNotifySettings: helpers.openNotify,
              workspace,
              detail,
              hasKey: settings.hasKey,
              autoEvolve: settings.autoEvolve,
              onToggleAutoEvolve: toggleAutoEvolve,
              onRunEvolution: runSystemEvolution,
              onImproveEvolution: improveEvolutionFlow,
              onRollbackEvolutionPolicy: rollbackEvolutionPolicy,
              onClearHistory: clearEvolutionHistory,
              onPropose: proposeEvolution,
              onReview: reviewProfile,
              onBenchmark: benchmarkProfile,
              onActivate: activateProfile,
              onRollback: rollbackProfile,
              onDelete: deleteProfile,
              onPromote: promoteProfile,
              onLocalize: localizeProfile,
              onExplainProfile: explainProfile,
              onOpenSettings: () => {
                setSettingsOpen(false)
                setView('models')
              },
              onBenchmarkGlobal: benchmarkGlobalProfile,
              onReviewGlobal: reviewGlobalProfile,
              onActivateGlobal: activateGlobalProfile,
              onRollbackGlobal: rollbackGlobalProfile,
              onDeleteGlobal: deleteGlobalProfile,
              onOpenSelfSource: openSelfSource,
              onChatSelfSource: chatSelfSource,
              onLoadPersonal: loadPersonal,
              onSavePersonalVersion: savePersonalVersion,
              onRestorePersonalVersion: restorePersonalVersion,
              onSubmitPersonalVersion: submitPersonalVersion,
              onRevealPersonalContribution: revealPersonalContribution,
              onAskBuild: askPilotToBuild,
              onPreparePersonalUpgrade: preparePersonalUpgrade,
              onApplyPersonalUpgrade: applyPersonalUpgrade,
              onValidatePersonalUpgrade: validatePersonalUpgrade,
              onRollbackPersonalUpgrade: rollbackPersonalUpgrade,
              onAskResolveUpgrade: askResolveUpgrade,
              onAskFixUpgrade: askFixUpgrade,
              onError: showError,
            })
          }
          onOpenReview={() => {
            setSettingsOpen(false)
            openReview()
          }}
          reviewSessions={reviewSessionEntries}
          onOpenReviewSession={(sessionId) => {
            setSettingsOpen(false)
            openSessionById(sessionId)
          }}
        />
      ) : null}

      {reviewOpen && workspace ? (
        <ReviewDialog
          workspace={workspace.path}
          workspaceName={workspace.name}
          onClose={() => setReviewOpen(false)}
          onCreated={(created) => void reviewCreated(created)}
          onError={showError}
        />
      ) : null}

      {reviewReportOpen && session?.kind === 'review' && session.reviewReport ? (
        <ReviewReportDialog
          session={session}
          report={session.reviewReport}
          handingOff={handingOff}
          onClose={() => setReviewReportOpen(false)}
          onHandoff={() => void handoffReview()}
          onAddTodo={async (text) => {
            try {
              await window.pilot.addTodo(session.id, text)
              pushToast(t("建议已加入待办。"), 'info')
            } catch (error) {
              pushToast(errorMessage(error), 'error')
              throw error
            }
          }}
        />
      ) : null}

      <CompanionDialog
        open={companionOpen}
        onClose={() => setCompanionOpen(false)}
        onError={showError}
      />

      <PairRequestDialog request={pairRequest} onDecide={decidePairing} />


      {workspaceDialogOpen ? (
        <WorkspaceDialog
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          onOpen={switchWorkspace}
          onPick={() => void pickWorkspace()}
          onRemove={removeWorkspace}
          onReveal={(path) => void revealWorkspace(path)}
          onClose={() => setWorkspaceDialogOpen(false)}
          onError={showError}
        />
      ) : null}

      <ToastStack
        toasts={toasts}
        onDismiss={(id) =>
          setToasts((previous) => previous.filter((toast) => toast.id !== id))
        }
      />
    </div>
  )
}
