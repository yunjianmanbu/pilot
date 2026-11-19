import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import type {
  ApprovalMode,
  ApprovalRequest,
  ContextStats,
  MessageDelivery,
  Plan,
  ProjectInstructionFile,
  QueuedTask,
  QuickCommand,
  RunRecord,
  Session,
  TodoItem,
  WorkspaceSummary,
} from '../../../shared/types'
import { copyText } from '../clipboard'
import {
  BrainIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  InfoIcon,
  ListCheckIcon,
  PauseIcon,
  PilotMark,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  SparkIcon,
  StopIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  XIcon,
} from '../icons'
import {
  buildTranscript,
  formatDuration,
  formatNumber,
  formatTime,
  liveProcess,
  riskLabel,
  summarizeTool,
  type LiveRun,
  type UIMessage,
} from '../ui'
import { Markdown } from './Markdown'
import { ProcessBox } from './ProcessBox'
import { QuickCommandsDialog } from './QuickCommandsDialog'
import { ReferencePicker } from './ReferencePicker'
import { t } from '../i18n'

const INPUT_HISTORY_KEY = 'pilot.input-history.v1'
const INPUT_HISTORY_LIMIT = 40

function readInputHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(INPUT_HISTORY_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, INPUT_HISTORY_LIMIT)
  } catch {
    return []
  }
}

function rememberInput(text: string): void {
  try {
    const previous = readInputHistory().filter((entry) => entry !== text)
    window.localStorage.setItem(
      INPUT_HISTORY_KEY,
      JSON.stringify([text, ...previous].slice(0, INPUT_HISTORY_LIMIT)),
    )
  } catch {
    // History is a convenience; sending must still work without storage.
  }
}

interface ComposerDraftState {
  text: string
  images: string[]
  references: string[]
}

// Drafts live outside the component so switching to another view (which
// unmounts ChatView) or another session does not throw away what the user
// already typed; each session gets its own slot for the app's lifetime. The
// empty-state composer (no session yet) keeps its own slot as well.
const NO_SESSION_DRAFT_KEY = 'no-session'
const composerDrafts = new Map<string, ComposerDraftState>()

function draftKeyOf(sessionId: string | null | undefined): string {
  return sessionId ?? NO_SESSION_DRAFT_KEY
}

function readComposerDraft(sessionId: string | null | undefined): ComposerDraftState {
  const saved = composerDrafts.get(draftKeyOf(sessionId))
  return saved
    ? { text: saved.text, images: [...saved.images], references: [...saved.references] }
    : { text: '', images: [], references: [] }
}

function saveComposerDraft(sessionId: string | null, next: ComposerDraftState): void {
  const key = draftKeyOf(sessionId)
  if (!next.text && next.images.length === 0 && next.references.length === 0) {
    composerDrafts.delete(key)
    return
  }
  composerDrafts.set(key, {
    text: next.text,
    images: [...next.images],
    references: [...next.references],
  })
}

// Seeded prompts must only fill the composer once: remounting ChatView (view
// switch) restores the draft instead of replaying a stale seed. Seed keys are
// monotonic across the app, so a single module-level marker is enough.
let lastAppliedComposerSeed = 0

const QUICK_PROMPTS = [
  t("先梳理一下这个项目的结构、技术栈和启动方式"),
  t("运行项目测试，定位并修复所有失败项"),
  t("阅读 README 和核心代码，指出三个最值得改进的地方"),
  t("为这个项目添加一个实用的新功能，先给出计划再实施"),
]

const APPROVAL_LABELS: Record<string, string> = {
  auto: t("全部自动"),
  manual: t("只读自动"),
  ask: t("逐条审批"),
  acceptEdits: t("全部自动"),
  plan: t("只读自动"),
  dontAsk: t("只读自动"),
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function RunBadge({ run }: { run?: RunRecord }) {
  if (!run || run.status === 'completed' || run.status === 'running') return null
  const label =
    run.status === 'failed'
      ? t("运行失败")
      : run.status === 'paused'
        ? t("已暂停")
        : run.status === 'cancelled'
          ? t("已取消")
          : run.status === 'max_steps'
            ? t("达到步数上限")
            : t("已中断")
  return <span className={`run-badge run-${run.status}`}>{label}</span>
}

/** Collapsed plan snapshot attached to a finished turn's final answer. */
function TurnPlan({ plan }: { plan: Plan }) {
  const { done } = planRows(plan, false, false)
  return (
    <details className="turn-plan">
      <summary>
        <span className="plan-badge">{t("本轮计划")}</span>
        <span className="plan-goal">{plan.goal || t("本轮任务")}</span>
        <span className="plan-progress">
          {done}/{plan.items.length}
        </span>
        <span className="turn-plan-toggle">{t("查看")}</span>
        <ChevronIcon width={13} height={13} className="plan-chevron" />
      </summary>
      <PlanItems plan={plan} running={false} settled={false} />
    </details>
  )
}

function AssistantMessage({
  message,
  run,
  focused,
  canRegenerate,
  onFeedback,
  onReflect,
  onRegenerate,
}: {
  message: Extract<UIMessage, { kind: 'assistant' }>
  run?: RunRecord
  focused?: boolean
  canRegenerate?: boolean
  onFeedback: (runId: string, rating: 'up' | 'down') => void
  onReflect: (runId: string) => Promise<number>
  onRegenerate: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [reflecting, setReflecting] = useState(false)

  const copy = () => {
    void copyText(message.content).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed')
      window.setTimeout(() => setCopyState('idle'), 1400)
    })
  }

  const reflect = async () => {
    if (!message.runId || reflecting) return
    setReflecting(true)
    try {
      await onReflect(message.runId)
    } finally {
      setReflecting(false)
    }
  }

  return (
    <div
      className={`message assistant-message${focused ? ' is-focused' : ''}`}
      data-message-id={message.id}
    >
      <div className="assistant-avatar">
        <PilotMark width={18} height={18} />
      </div>
      <div className="assistant-content">
        <div className="message-head">
          <span className="message-author">Pilot</span>
          <span className="message-time">{formatTime(message.createdAt)}</span>
          <RunBadge run={run} />
        </div>

        {message.reasoning?.trim() ? (
          <details className="reasoning-block answer-reasoning">
            <summary>{t("思考过程")}</summary>
            <div className="reasoning-content">{message.reasoning}</div>
          </details>
        ) : null}

        {message.content.trim() ? (
          <Markdown content={message.content} />
        ) : (
          <p className="empty-answer">{t("模型没有返回可见内容。")}</p>
        )}

        {message.plan ? <TurnPlan plan={message.plan} /> : null}

        {run?.error ? (
          <div className="run-inline-error">
            <InfoIcon width={13} height={13} />
            {run.error}
          </div>
        ) : null}

        <div className="message-actions">
          <button type="button" className="icon-text-button" onClick={copy}>
            {copyState === 'copied' ? (
              <CheckIcon width={13} height={13} />
            ) : (
              <CopyIcon width={13} height={13} />
            )}
            {copyState === 'copied' ? t("已复制") : copyState === 'failed' ? t("复制失败") : t("复制")}
          </button>

          {canRegenerate ? (
            <>
              <span className="action-sep" />
              <button
                type="button"
                className="icon-text-button"
                onClick={onRegenerate}
                title={t("让 Pilot 重新生成这条回答")}
              >
                <RefreshIcon width={13} height={13} />
                {t("重新生成")}</button>
            </>
          ) : null}

          {message.runId ? (
            <>
              <span className="action-sep" />
              <button
                type="button"
                className={`icon-button${run?.feedback?.rating === 'up' ? ' is-selected' : ''}`}
                title={t("这次回答有帮助")}
                onClick={() => onFeedback(message.runId!, 'up')}
              >
                <ThumbUpIcon width={14} height={14} />
              </button>
              <button
                type="button"
                className={`icon-button${run?.feedback?.rating === 'down' ? ' is-selected' : ''}`}
                title={t("这次回答不够好")}
                onClick={() => onFeedback(message.runId!, 'down')}
              >
                <ThumbDownIcon width={14} height={14} />
              </button>
              <button
                type="button"
                className="icon-text-button reflect-button"
                onClick={() => void reflect()}
                disabled={reflecting}
                title={t("让 Pilot 复盘这次运行，提炼可复用的经验")}
              >
                {reflecting ? <i className="spinner small" /> : <SparkIcon width={13} height={13} />}
                {reflecting ? t("复盘中") : t("复盘")}
              </button>
              {run ? (
                <span className="run-meta">
                  {run.steps} {t("步 ·")}{formatNumber(run.totalTokens)} tokens
                  {run.delegations
                    ? ` · ${t("委派 {v1} 次 / {v2} 步", {
                        v1: run.delegations,
                        v2: run.delegatedSteps ?? 0,
                      })}`
                    : null}
                  {run.modelMs !== undefined
                    ? ` · ${t("模型 {v1}s / 工具 {v2}s / 快照 {v3}s", {
                        v1: (run.modelMs / 1000).toFixed(1),
                        v2: ((run.toolMs ?? 0) / 1000).toFixed(1),
                        v3: ((run.checkpointMs ?? 0) / 1000).toFixed(1),
                      })}`
                    : null}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function UserMessage({
  message,
  focused,
  busy,
  canDelete,
  onEdit,
  onDelete,
}: {
  message: Extract<UIMessage, { kind: 'user' }>
  focused?: boolean
  busy: boolean
  canDelete?: boolean
  onEdit: (messageId: string, content: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(message.content)
  }, [message.content, editing])

  if (message.control) {
    return (
      <div className="control-message">
        <PlayIcon width={12} height={12} />
        <span>{t("从中断处继续任务")}</span>
        <span className="control-time">{formatTime(message.createdAt)}</span>
      </div>
    )
  }

  const copy = () => {
    void copyText(message.content).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed')
      window.setTimeout(() => setCopyState('idle'), 1400)
    })
  }

  const save = async () => {
    const text = draft.trim()
    if (!text || text === message.content || saving) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onEdit(message.id, text)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`message user-message${focused ? ' is-focused' : ''}`}
      data-message-id={message.id}
    >
      <div className="user-bubble">
        {editing ? (
          <div className="user-edit">
            <textarea
              className="user-edit-input"
              value={draft}
              autoFocus
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void save()
                }
              }}
            />
            <div className="user-edit-actions">
              <span>{t("保存后会从这条消息重新生成，之后的回复会被丢弃。")}</span>
              <button
                type="button"
                className="button ghost small"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                {t("取消")}</button>
              <button
                type="button"
                className="button primary small"
                onClick={() => void save()}
                disabled={saving || !draft.trim()}
              >
                {saving ? <i className="spinner small" /> : <RefreshIcon width={12} height={12} />}
                {t("保存并重新生成")}</button>
            </div>
          </div>
        ) : (
          <>
            {message.content.trim() ? <div className="user-text">{message.content}</div> : null}
            {message.references && message.references.length > 0 ? (
              <div className="user-references">
                {message.references.map((path) => {
                  const project = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
                  return (
                    <span className="user-reference" key={path} title={path}>
                      {/^(?:[a-z]:\/|\/)/i.test(path) ? (
                        <FolderIcon width={11} height={11} />
                      ) : (
                        <FileIcon width={11} height={11} />
                      )}
                      {project}
                    </span>
                  )
                })}
              </div>
            ) : null}
            {message.images && message.images.length > 0 ? (
              <div className="user-images">
                {message.images.map((url, index) => (
                  <img
                    key={`${message.id}-image-${index}`}
                    src={url}
                    alt={t("用户发送的图片")}
                    className="user-image"
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
        <div className="user-foot">
          <span className="user-time">{formatTime(message.createdAt)}</span>
          {!editing ? (
            <>
              <button
                type="button"
                className="user-copy user-edit-start"
                onClick={() => setEditing(true)}
                disabled={busy}
                title={busy ? t("任务执行中，结束后可编辑") : t("编辑并重新生成")}
                aria-label={t("编辑这条消息")}
              >
                {t("编辑")}</button>
              <button
                type="button"
                className="user-copy"
                onClick={copy}
                title={copyState === 'failed' ? t("复制失败") : t("复制这条消息")}
                aria-label={copyState === 'failed' ? t("复制失败") : t("复制这条消息")}
              >
                {copyState === 'copied' ? (
                  <CheckIcon width={12} height={12} />
                ) : (
                  <CopyIcon width={12} height={12} />
                )}
              </button>
              {canDelete ? (
                <button
                  type="button"
                  className="user-copy danger"
                  onClick={() => {
                    if (!window.confirm(t("删除这条还没有回复的指令？"))) return
                    void onDelete(message.id)
                  }}
                  title={t("删除这条还没有回复的指令？")}
                  aria-label={t("删除这条还没有回复的指令？")}
                >
                  <XIcon width={12} height={12} />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// Transcript rows keep the same message object while a later answer streams.
// Memoizing them stops every token from re-rendering the whole history.
const AssistantMessageRow = memo(AssistantMessage)
const UserMessageRow = memo(UserMessage)

function Welcome({
  workspace,
  hasKey,
  hasSession,
  quickCommands,
  onQuickCommandsChange,
  onPickWorkspace,
  onOpenSettings,
  onQuickStart,
}: {
  workspace: WorkspaceSummary | null
  hasKey: boolean
  hasSession: boolean
  quickCommands: QuickCommand[] | null
  onQuickCommandsChange: (commands: QuickCommand[]) => void
  onPickWorkspace: () => void
  onOpenSettings: () => void
  onQuickStart: (text: string) => void
}) {
  const [manageOpen, setManageOpen] = useState(false)
  const prompts: QuickCommand[] =
    quickCommands ?? QUICK_PROMPTS.map((content, index) => ({ id: `default-${index}`, content }))
  return (
    <div className="welcome">
      <div className="welcome-mark">
        <PilotMark width={54} height={54} />
      </div>
      <h1>{workspace ? (hasSession ? t("开始这个任务") : t("把想法交给 Pilot")) : t("先选择一个工作区")}</h1>
      <p className="welcome-sub">
        {workspace
          ? t("Pilot 会在你的本地工作区中阅读、修改和运行代码。每个工作区拥有独立记忆，并能在真实运行中持续优化自己的行为。")
          : t("Pilot 是一个本地运行的自主智能体。授权一个文件夹，它就能理解代码、执行命令、修改文件，并把每次经验留在这个工作区。")}
      </p>

      {!hasKey ? (
        <button type="button" className="welcome-alert" onClick={onOpenSettings}>
          <span className="welcome-alert-icon">
            <InfoIcon width={16} height={16} />
          </span>
          <span>
            <strong>{t("还差一个 API Key")}</strong>
            <small>{t("本地加密保存，不注册、不登录，配置后即可开始。")}</small>
          </span>
          <ChevronIcon width={16} height={16} />
        </button>
      ) : null}

      {!workspace ? (
        <div className="welcome-actions">
          <button type="button" className="button primary large" onClick={onPickWorkspace}>
            <FolderIcon width={17} height={17} />
            {t("选择工作区文件夹")}</button>
          <span className="welcome-hint">{t("也可以从左上角切换工作区")}</span>
        </div>
      ) : (
        <div className="quick-area">
          {prompts.length > 0 ? (
            <div className="quick-grid">
              {prompts.map((prompt, index) => (
                <button
                  type="button"
                  className="quick-card"
                  key={prompt.id}
                  onClick={() => {
                    if (!hasKey) {
                      onOpenSettings()
                      return
                    }
                    onQuickStart(prompt.content)
                  }}
                >
                  <span className="quick-index">{String(index + 1).padStart(2, '0')}</span>
                  <span>{prompt.content}</span>
                  <ChevronIcon width={14} height={14} />
                </button>
              ))}
            </div>
          ) : (
            <p className="quick-empty">{t("还没有常用指令。添加几条常用的任务，点一下就能开始。")}</p>
          )}
          <button type="button" className="quick-manage" onClick={() => setManageOpen(true)}>
            <ListCheckIcon width={13} height={13} />
            {t("管理常用指令")}</button>
        </div>
      )}

      {manageOpen ? (
        <QuickCommandsDialog
          defaults={QUICK_PROMPTS}
          onClose={() => setManageOpen(false)}
          onChange={onQuickCommandsChange}
        />
      ) : null}

      <div className="welcome-features">
        <span>
          <BrainIcon width={13} height={13} />
          {t("项目记忆")}</span>
        <span>
          <SparkIcon width={13} height={13} />
          {t("自我进化")}</span>
        <span>
          <FolderIcon width={13} height={13} />
          {t("本地文件")}</span>
        <span>
          <ClockIcon width={13} height={13} />
          {t("无需登录")}</span>
      </div>
    </div>
  )
}

function planRows(plan: Plan, running: boolean, settled: boolean) {
  const items = plan.items.map((item) => {
    const isDone = item.status === 'done' || (settled && item.status === 'in_progress')
    const isActive = item.status === 'in_progress' && running
    return {
      item,
      isDone,
      isActive,
      className: isDone ? 'is-done' : isActive ? 'is-in_progress' : 'is-pending',
    }
  })
  return { items, done: items.filter((entry) => entry.isDone).length }
}

function PlanItems({ plan, running, settled }: { plan: Plan; running: boolean; settled: boolean }) {
  const { items } = planRows(plan, running, settled)
  return (
    <ol className="plan-items">
      {items.map(({ item, isDone, isActive, className }) => (
        <li key={item.id} className={`plan-item ${className}`}>
          <span className="plan-check">
            {isDone ? (
              <CheckIcon width={11} height={11} />
            ) : isActive ? (
              <i className="spinner tiny" />
            ) : (
              <i className="plan-circle" />
            )}
          </span>
          <span>{item.text}</span>
        </li>
      ))}
    </ol>
  )
}

function PlanPanel({
  plan,
  running,
  settled,
}: {
  plan: Plan
  running: boolean
  settled: boolean
}) {
  const { done } = planRows(plan, running, settled)

  return (
    <details className="plan-panel">
      <summary>
        <span className="plan-badge">{t("计划")}</span>
        <span className="plan-goal">{plan.goal || t("当前任务")}</span>
        <span className="plan-progress">
          {done}/{plan.items.length}
        </span>
        <ChevronIcon width={13} height={13} className="plan-chevron" />
      </summary>
      <PlanItems plan={plan} running={running} settled={settled} />
    </details>
  )
}

function TodoPanel({
  todos,
  onAdd,
  onUpdate,
  onRemove,
  onSend,
  onSendAll,
  onClearSent,
  onSchedule,
}: {
  todos: TodoItem[]
  onAdd: (text: string) => Promise<void>
  onUpdate: (todoId: string, text: string) => Promise<void>
  onRemove: (todoId: string) => Promise<void>
  onSend: (todoId: string) => Promise<void>
  onSendAll: () => Promise<void>
  onClearSent: () => Promise<void>
  onSchedule: (todo: TodoItem) => void
}) {
  const [draft, setDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const pending = todos.filter((todo) => todo.status === 'pending')
  const sent = todos.length - pending.length

  const add = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await onAdd(text)
  }

  const commitEdit = async () => {
    if (!editing) return
    const next = editing.text.trim()
    const target = editing
    setEditing(null)
    if (next && next !== todos.find((todo) => todo.id === target.id)?.text) {
      await onUpdate(target.id, next)
    }
  }

  return (
    <details className="todo-panel">
      <summary>
        <span className="todo-badge">
          <ListCheckIcon width={12} height={12} />
          {t("待办")}</span>
        <span className="todo-summary-text">
          {pending.length > 0
            ? t("{v1} 项待发送", { v1: pending.length })
            : sent > 0
              ? t("{v1} 项已发送", { v1: sent })
              : t("记录下一步，稍后一键发送")}
        </span>
        <ChevronIcon width={12} height={12} className="todo-chevron" />
      </summary>
      <div className="todo-body">
        <div className="todo-add-row">
          <input
            className="todo-add-input"
            value={draft}
            placeholder={t("添加待办，Enter 保存")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void add()
              }
            }}
          />
          <button
            type="button"
            className="todo-add-btn"
            disabled={!draft.trim()}
            onClick={() => void add()}
            title={t("添加待办")}
          >
            <PlusIcon width={13} height={13} />
          </button>
        </div>
        {todos.length > 0 ? (
          <>
            <div className="todo-list">
              {todos.map((todo) => (
                <div className={`todo-item status-${todo.status}`} key={todo.id}>
                  <span className="todo-check">
                    {todo.status === 'sent' ? (
                      <CheckIcon width={11} height={11} />
                    ) : (
                      <i className="plan-circle" />
                    )}
                  </span>
                  {editing?.id === todo.id ? (
                    <input
                      className="todo-edit"
                      value={editing.text}
                      autoFocus
                      onChange={(event) =>
                        setEditing({ id: todo.id, text: event.target.value })
                      }
                      onBlur={() => void commitEdit()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault()
                          event.currentTarget.blur()
                        } else if (event.key === 'Escape') {
                          setEditing(null)
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="todo-text"
                      title={todo.status === 'pending' ? t("点击编辑") : t("已发送")}
                      onClick={() => {
                        if (todo.status === 'pending') setEditing({ id: todo.id, text: todo.text })
                      }}
                    >
                      {todo.text}
                    </button>
                  )}
                  {todo.status === 'sent' ? (
                    <span className="todo-sent">{t("已发送")}</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="todo-action"
                        title={t("转为定时任务")}
                        onClick={() => onSchedule(todo)}
                      >
                        <ClockIcon width={12} height={12} />
                      </button>
                      <button
                        type="button"
                        className="todo-action"
                        title={t("发送到当前会话")}
                        disabled={busyId === todo.id}
                        onClick={() => {
                          if (!window.confirm(t("发送这条待办？"))) return
                          setBusyId(todo.id)
                          void onSend(todo.id).finally(() => setBusyId(null))
                        }}
                      >
                        {busyId === todo.id ? (
                          <i className="spinner tiny" />
                        ) : (
                          <SendIcon width={12} height={12} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="todo-action danger"
                        title={t("删除待办")}
                        onClick={() => {
                          if (!window.confirm(t("删除这条待办？"))) return
                          void onRemove(todo.id)
                        }}
                      >
                        <XIcon width={12} height={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="todo-foot">
              {pending.length > 1 ? (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    if (!window.confirm(t("全部发送这 {v1} 条待办？", { v1: pending.length }))) return
                    void onSendAll()
                  }}
                >
                  {t("全部发送（")}{pending.length}）
                </button>
              ) : null}
              {sent > 0 ? (
                <button type="button" className="link-btn" onClick={() => void onClearSent()}>
                  {t("清除已发送")}</button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </details>
  )
}

function ContinueBar({
  session,
  busy,
  onContinue,
}: {
  session: Session
  busy: boolean
  onContinue: () => void
}) {
  const instruction = session.pauseInstruction?.trim() ?? ''
  return (
    <div className={`continue-bar${session.paused ? ' is-paused' : ''}`}>
      <span className="continue-icon">
        {session.paused ? <PauseIcon width={14} height={14} /> : <PlayIcon width={13} height={13} />}
      </span>
      <div className="continue-text">
        <strong>{session.paused ? t("任务已暂停") : t("上次任务没有正常结束")}</strong>
        <span>
          {session.paused && instruction
            ? t("进度停在：{v1}{v2}", { v1: instruction.slice(0, 80), v2: instruction.length > 80 ? '…' : '' })
            : t("从上次中断的地方继续，Pilot 会先检查工作区现状，避免重复已完成步骤。")}
        </span>
      </div>
      <button
        type="button"
        className="button primary"
        onClick={onContinue}
        disabled={busy}
      >
        {busy ? <i className="spinner" /> : <PlayIcon width={12} height={12} />}
        {t("继续")}</button>
    </div>
  )
}

function QueuePanel({
  queue,
  running,
  onInsert,
  onRemove,
  onUpdate,
  onConvert,
}: {
  queue: QueuedTask[]
  running: boolean
  onInsert: (taskId: string) => void
  onRemove: (taskId: string) => void
  onUpdate: (taskId: string, content: string) => Promise<void>
  onConvert: (taskId: string) => void
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  if (queue.length === 0) return null

  const commit = async () => {
    if (!editing || saving) return
    const text = editing.text.trim()
    if (!text) {
      setEditing(null)
      return
    }
    setSaving(true)
    try {
      await onUpdate(editing.id, text)
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <details className="queue-panel">
      <summary className="queue-head">
        <ClockIcon width={15} height={15} />
        <span className="queue-title">{t("排队中的任务")}</span>
        <span className="queue-count">{queue.length}</span>
        <span className="queue-hint">
          {running ? t("当前任务结束后自动开始") : t("即将开始")}
        </span>
        <ChevronIcon width={12} height={12} className="queue-chevron" />
      </summary>
      <div className="queue-list">
        {queue.map((task, index) => (
          <div className="queue-item" key={task.id}>
            <span className="queue-index">{index + 1}</span>
            {editing?.id === task.id ? (
              <input
                className="queue-edit"
                value={editing.text}
                autoFocus
                onChange={(event) => setEditing({ id: task.id, text: event.target.value })}
                onBlur={() => void commit()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    event.currentTarget.blur()
                  } else if (event.key === 'Escape') {
                    setEditing(null)
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="queue-content"
                title={t("点击编辑排队内容")}
                onClick={() => setEditing({ id: task.id, text: task.content })}
              >
                {task.content}
              </button>
            )}
            {running ? (
              <button
                type="button"
                className="queue-action"
                onClick={() => onInsert(task.id)}
                title={t("插入当前任务，在下一步生效")}
              >
                {t("插入")}</button>
            ) : null}
            <button
              type="button"
              className="queue-action"
              onClick={() => onConvert(task.id)}
              title={t("移到待办，确认后手动发送")}
            >
              {t("转待办")}</button>
            <button
              type="button"
              className="queue-remove"
              onClick={() => onRemove(task.id)}
              title={t("移除")}
            >
              <XIcon width={13} height={13} />
            </button>
          </div>
        ))}
      </div>
    </details>
  )
}

function ApprovalCountdown({ expiresAt }: { expiresAt?: string }) {
  const [remaining, setRemaining] = useState(() =>
    expiresAt ? Math.max(0, Date.parse(expiresAt) - Date.now()) : 0,
  )
  useEffect(() => {
    if (!expiresAt) return
    const tick = () =>
      setRemaining(Math.max(0, Date.parse(expiresAt) - Date.now()))
    tick()
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  if (!expiresAt) return null
  return (
    <span className={`approval-countdown${remaining <= 30_000 ? ' urgent' : ''}`}>
      {remaining > 0 ? t("剩余 {v1}", { v1: formatDuration(remaining) }) : t("即将自动拒绝")}
    </span>
  )
}

function ApprovalDock({
  approvals,
  approvalMode,
  onDecide,
  onSwitchToAuto,
}: {
  approvals: ApprovalRequest[]
  approvalMode: string
  onDecide: (callId: string, approved: boolean, remember: boolean) => void
  onSwitchToAuto?: () => void
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [remember, setRemember] = useState<Record<string, boolean>>({})
  if (approvals.length === 0) return null

  const decide = (callId: string, approved: boolean) => {
    setBusy((value) => ({ ...value, [callId]: true }))
    onDecide(callId, approved, remember[callId] === true)
  }
  const switchAndAllow = (callId: string) => {
    setBusy((value) => ({ ...value, [callId]: true }))
    // Switching the session changes the policy for every later call; approving
    // this pending one matches what 全部自动 would have done with it anyway.
    onSwitchToAuto?.()
    onDecide(callId, true, false)
  }

  return (
    <div className="approval-stack">
      {approvals.map((request) => (
        <div className="approval-card" key={request.callId}>
          <div className="approval-head">
            <span className="approval-pulse" />
            <span className="approval-title">{t("需要你的确认")}</span>
            <span className={`risk-pill risk-${request.risk}`}>{riskLabel(request.risk)}</span>
            <span className="approval-mode">{APPROVAL_LABELS[approvalMode] ?? approvalMode}</span>
            <ApprovalCountdown expiresAt={request.expiresAt} />
          </div>
          <div className="approval-tool">
            <code>{request.tool}</code>
            <span>{summarizeTool({ id: '', name: request.tool, args: request.arguments, risk: request.risk, status: 'waiting' })}</span>
          </div>
          {request.reason ? (
            <div className="approval-reason">
              {request.reason}
              {request.rule ? <code>{request.rule}</code> : null}
            </div>
          ) : null}
          {request.tool === 'request_system_access' ? (
            <div className="approval-shell-warning">
              {t("这是 Agent 读取 Pilot 自身运行记录与执行策略的系统级授权：只读、绑定本次运行、到期自动失效。批准后它只能通过 read_execution_records / read_system_strategy 读取所选范围，不能修改设置或提升权限；优化建议会先成为草稿，仍需你审核后启用。")}
            </div>
          ) : null}
          {request.tool === 'run_shell' && approvalMode !== 'auto' ? (
            <div className="approval-shell-warning">
              {approvalMode === 'plan'
                ? t("计划模式只允许只读命令；需要执行时请先退出计划模式。")
                : t("完整 shell 不受工作区路径限制，当前会话不是「全部自动」，所以需要你确认。经常无人值守时，可把本会话改为全部自动。")}
            </div>
          ) : null}
          {Object.keys(request.arguments).length > 0 ? (
            <pre className="approval-args">{JSON.stringify(request.arguments, null, 2)}</pre>
          ) : null}
          {request.tool === 'run_shell' ? (
            <label className="approval-remember">
              <input
                type="checkbox"
                checked={remember[request.callId] === true}
                onChange={(event) =>
                  setRemember((value) => ({ ...value, [request.callId]: event.target.checked }))
                }
              />
              {t("始终允许这条命令（仅完全匹配时）")}
            </label>
          ) : null}
          <div className="approval-actions">
            <button
              type="button"
              className="button danger ghost"
              disabled={busy[request.callId]}
              onClick={() => decide(request.callId, false)}
            >
              {t("拒绝")}</button>
            {approvalMode !== 'auto' && approvalMode !== 'plan' && onSwitchToAuto ? (
              <button
                type="button"
                className="button ghost"
                disabled={busy[request.callId]}
                onClick={() => switchAndAllow(request.callId)}
                title={t("本会话之后的所有工具调用都不再逐次确认；工作区路径限制、受保护路径和拒绝规则仍然生效。")}
              >
                {t("改为全部自动并允许")}</button>
            ) : null}
            <button
              type="button"
              className="button primary"
              disabled={busy[request.callId]}
              onClick={() => decide(request.callId, true)}
            >
              {busy[request.callId] ? <i className="spinner" /> : <CheckIcon width={15} height={15} />}
              {t("允许一次")}</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function ThinkingIndicator({ step }: { step: number }) {
  return (
    <div className="thinking-row">
      <div className="assistant-avatar live">
        <PilotMark width={18} height={18} />
      </div>
      <div className="thinking-text">
        <span>{step > 1 ? t("正在执行第 {v1} 步", { v1: step }) : t("正在理解任务")}</span>
        <span className="typing-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  )
}

function Composer({
  session,
  workspaces,
  running,
  planSettled,
  hasKey,
  contextStats,
  compacting,
  projectInstructions,
  composerSeed,
  onSend,
  onStop,
  onPause,
  onOpenSettings,
  onCompactContext,
  onAddTodo,
  onUpdateTodo,
  onRemoveTodo,
  onSendTodo,
  onSendAllTodos,
  onClearSentTodos,
  onScheduleTodo,
}: {
  session: Session | null
  workspaces: WorkspaceSummary[]
  running: boolean
  planSettled: boolean
  hasKey: boolean
  contextStats: ContextStats | null
  compacting: boolean
  projectInstructions: ProjectInstructionFile[]
  composerSeed: { key: number; text: string } | null
  onSend: (
    text: string,
    delivery: MessageDelivery,
    options?: { images?: string[]; references?: string[] },
  ) => Promise<boolean>
  onStop: () => void
  onPause: () => void
  onOpenSettings: () => void
  onCompactContext: () => void
  onAddTodo: (text: string) => Promise<void>
  onUpdateTodo: (todoId: string, text: string) => Promise<void>
  onRemoveTodo: (todoId: string) => Promise<void>
  onSendTodo: (todoId: string) => Promise<void>
  onSendAllTodos: () => Promise<void>
  onClearSentTodos: () => Promise<void>
  onScheduleTodo: (todo: TodoItem) => void
}) {
  const [draft, setDraft] = useState(() => readComposerDraft(session?.id).text)
  const [delivery, setDelivery] = useState<MessageDelivery>('queue')
  const [submitting, setSubmitting] = useState(false)
  const [images, setImages] = useState<string[]>(() => readComposerDraft(session?.id).images)
  const [references, setReferences] = useState<string[]>(
    () => readComposerDraft(session?.id).references,
  )
  const [refOpen, setRefOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sessionIdRef = useRef<string | null>(session?.id ?? null)
  const historyIndex = useRef(-1)
  const historyDraft = useRef('')

  const persistDraft = (patch: Partial<ComposerDraftState>) => {
    const id = sessionIdRef.current
    saveComposerDraft(id, { ...readComposerDraft(id), ...patch })
  }
  const changeDraft = (value: string) => {
    setDraft(value)
    persistDraft({ text: value })
  }
  const changeImages = (value: string[]) => {
    setImages(value)
    persistDraft({ images: value })
  }
  const changeReferences = (value: string[]) => {
    setReferences(value)
    persistDraft({ references: value })
  }

  useEffect(() => {
    if (sessionIdRef.current !== (session?.id ?? null)) {
      sessionIdRef.current = session?.id ?? null
      const restored = readComposerDraft(session?.id)
      setDraft(restored.text)
      setImages(restored.images)
      setReferences(restored.references)
      setRefOpen(false)
      historyIndex.current = -1
      historyDraft.current = ''
    }
  }, [session?.id])

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`
  }, [draft])

  useEffect(() => {
    if (!composerSeed || composerSeed.key <= lastAppliedComposerSeed) return
    lastAppliedComposerSeed = composerSeed.key
    changeDraft(composerSeed.text)
    changeImages([])
    changeReferences([])
    window.setTimeout(() => textareaRef.current?.focus(), 30)
  }, [composerSeed])

  useEffect(() => {
    if (!running) setDelivery('queue')
  }, [running])

  const pickImages = async () => {
    if (picking || running) return
    setPicking(true)
    try {
      const picked = await window.pilot.pickImages()
      if (picked.length > 0) {
        changeImages([...images, ...picked].slice(0, 3))
      }
    } catch (error) {
      // Surfacing the reason matters when an image is too large.
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setPicking(false)
    }
  }

  const toggleReference = (path: string) => {
    changeReferences(
      references.includes(path)
        ? references.filter((entry) => entry !== path)
        : [...references, path].slice(0, 8),
    )
  }
  const referenceLabel = (path: string): string =>
    workspaces.find((entry) => entry.path === path)?.name ||
    path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
    path

  const submit = async () => {
    const text = draft.trim()
    if ((!text && images.length === 0) || submitting) return
    if (!hasKey) {
      onOpenSettings()
      return
    }
    setSubmitting(true)
    try {
      const sent = await onSend(text, delivery, { images, references })
      if (sent) {
        if (text) rememberInput(text)
        historyIndex.current = -1
        historyDraft.current = ''
        changeDraft('')
        changeImages([])
        changeReferences([])
        window.setTimeout(() => textareaRef.current?.focus(), 30)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
      return
    }
    if (
      (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return
    }
    const history = readInputHistory()
    if (history.length === 0) return
    const element = event.currentTarget
    if (event.key === 'ArrowUp') {
      // Only walk history when the caret is at the very start; otherwise let
      // the textarea move between the user's own lines.
      if (element.selectionStart !== 0 || element.selectionEnd !== 0) return
      event.preventDefault()
      if (historyIndex.current < 0) historyDraft.current = draft
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1)
      changeDraft(history[historyIndex.current] ?? '')
      return
    }
    if (historyIndex.current < 0) return
    event.preventDefault()
    historyIndex.current -= 1
    changeDraft(
      historyIndex.current < 0 ? historyDraft.current : (history[historyIndex.current] ?? ''),
    )
  }

  return (
    <div className="composer-wrap">
      {!hasKey ? (
        <button type="button" className="composer-warning" onClick={onOpenSettings}>
          <InfoIcon width={14} height={14} />
          {t("尚未配置 API Key，点击设置后即可开始。")}</button>
      ) : null}

      <div className={`composer${running ? ' is-running' : ''}`}>
        <div className="composer-main">
          {session ? (
            <TodoPanel
              todos={session.todos}
              onAdd={onAddTodo}
              onUpdate={onUpdateTodo}
              onRemove={onRemoveTodo}
              onSend={onSendTodo}
              onSendAll={onSendAllTodos}
              onClearSent={onClearSentTodos}
              onSchedule={onScheduleTodo}
            />
          ) : null}
          {session?.plan ? (
            <PlanPanel plan={session.plan} running={running} settled={planSettled} />
          ) : null}
          {images.length > 0 || references.length > 0 ? (
            <div className="attachment-strip">
              {references.map((path) => (
                <span className="attachment-chip" key={path} title={path}>
                  <FolderIcon width={12} height={12} />
                  <span>{referenceLabel(path)}</span>
                  <button
                    type="button"
                    aria-label={t("移除参照")}
                    onClick={() => changeReferences(references.filter((entry) => entry !== path))}
                  >
                    <XIcon width={10} height={10} />
                  </button>
                </span>
              ))}
              {images.map((url, index) => (
                <span className="attachment-thumb" key={`image-${index}`}>
                  <img src={url} alt={t("待发送图片")} />
                  <button
                    type="button"
                    aria-label={t("移除图片")}
                    onClick={() => changeImages(images.filter((_, at) => at !== index))}
                  >
                    <XIcon width={10} height={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={draft}
            rows={1}
            onChange={(event) => changeDraft(event.target.value)}
            placeholder={
              running
                ? t("继续补充任务；可排队，或插入当前任务在下一步生效…")
                : t("描述任务，Pilot 会读取工作区并自主执行…")
            }
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
        </div>

        <div className="composer-footer">
          <div className="composer-left">
            <button
              type="button"
              className="composer-attach"
              onClick={() => void pickImages()}
              disabled={running || picking}
              title={running ? t("任务结束后可添加图片") : t("添加图片")}
            >
              {picking ? <i className="spinner tiny" /> : <ImageIcon width={14} height={14} />}
              {t("图片")}</button>
            <button
              type="button"
              className="composer-attach"
              onClick={() => setRefOpen(true)}
              disabled={running || !session}
              title={running ? t("任务结束后可参照其他项目") : t("参照其他项目")}
            >
              <FileIcon width={14} height={14} />
              {t("参照")}{references.length > 0 ? <span className="attach-count">{references.length}</span> : null}
            </button>
            {running ? (
              <div className="delivery-toggle" role="group" aria-label={t("消息投递方式")}>
                <button
                  type="button"
                  className={delivery === 'queue' ? 'is-active' : ''}
                  onClick={() => setDelivery('queue')}
                  title={t("当前任务结束后自动开始")}
                >
                  {t("排队")}</button>
                <button
                  type="button"
                  className={delivery === 'insert' ? 'is-active' : ''}
                  onClick={() => setDelivery('insert')}
                  title={t("在下一步将消息插入当前任务")}
                >
                  {t("插入当前任务")}</button>
              </div>
            ) : (
              <span className="composer-hint">
                {session
                  ? session.kind === 'review'
                    ? t("只读复盘 · 不写入、不执行命令")
                    : t("{v1} · 本地工作区", {
                        v1: APPROVAL_LABELS[session.approvalMode] ?? session.approvalMode,
                      })
                  : t("全部自动 · 本地工作区")}
              </span>
            )}
            {projectInstructions.length > 0 ? (
              <span
                className="project-instruction-chip"
                title={projectInstructions
                  .map((file) => t("{v1} · {v2}{v3}", { v1: file.name, v2: formatFileSize(file.bytes), v3: file.truncated ? t(" · 已截断") : '' }))
                  .join('\n')}
              >
                {t("项目指令 ·")}{projectInstructions.map((file) => file.name).join(' / ')}
              </span>
            ) : null}
            {contextStats && session ? (
              <span
                className={`context-meter${contextStats.percent >= 85 ? ' is-high' : ''}`}
                title={t("约 {v1} / {v2} tokens · {v3} 条消息", { v1: formatNumber(contextStats.estimatedTokens), v2: formatNumber(contextStats.maxContextTokens), v3: contextStats.messageCount })}
              >
                <span className="context-meter-track">
                  <i
                    className="context-meter-fill"
                    style={{ width: `${Math.min(100, Math.max(2, contextStats.percent))}%` }}
                  />
                </span>
                <span>{contextStats.percent}%</span>
                <button
                  type="button"
                  className="context-compact"
                  onClick={onCompactContext}
                  disabled={compacting || contextStats.compactableChars === 0 || running}
                  title={
                    running
                      ? t("任务执行中，结束后可手动压缩")
                      : contextStats.compactableChars > 0
                        ? t("压缩旧工具输出，可释放约 {v1} 字符", { v1: formatNumber(contextStats.compactableChars) })
                        : t("当前没有可压缩的旧工具输出")
                  }
                >
                  {compacting ? <i className="spinner tiny" /> : t("压缩")}
                </button>
              </span>
            ) : null}
          </div>

          <div className="composer-right">
            <span className="key-hint">{t("Enter 发送 · Shift+Enter 换行 · 可附图/参照")}</span>
            {running ? (
              <>
                <button
                  type="button"
                  className="composer-pause"
                  onClick={onPause}
                  title={t("暂停当前任务，可随时继续")}
                >
                  <PauseIcon width={14} height={14} />
                </button>
                <button
                  type="button"
                  className="composer-stop"
                  onClick={onStop}
                  title={t("停止当前任务（不会自动继续）")}
                >
                  <StopIcon width={14} height={14} />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="composer-send"
              onClick={() => void submit()}
              disabled={(!draft.trim() && images.length === 0) || submitting}
              title={hasKey ? t("发送") : t("先配置 API Key")}
            >
              {submitting ? <i className="spinner" /> : <SendIcon width={16} height={16} />}
            </button>
          </div>
        </div>
      </div>
      {refOpen && session ? (
        <ReferencePicker
          workspacePath={session.workspacePath}
          workspaces={workspaces}
          selected={references}
          onClose={() => setRefOpen(false)}
          onToggle={toggleReference}
        />
      ) : null}
    </div>
  )
}

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
  contextStats: ContextStats | null
  compacting: boolean
  projectInstructions: ProjectInstructionFile[]
  focusMessageId: string | null
  /** A prompt inserted by another panel; `key` makes repeated seeds distinct. */
  composerSeed: { key: number; text: string } | null
  onLoadEarlier: () => Promise<boolean>
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
  onCompactContext: () => void
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
  onAddTodo: (text: string) => Promise<void>
  onUpdateTodo: (todoId: string, text: string) => Promise<void>
  onRemoveTodo: (todoId: string) => Promise<void>
  onSendTodo: (todoId: string) => Promise<void>
  onSendAllTodos: () => Promise<void>
  onClearSentTodos: () => Promise<void>
  onScheduleTodo: (todo: TodoItem) => void
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
  contextStats,
  compacting,
  projectInstructions,
  focusMessageId,
  composerSeed,
  onLoadEarlier,
  onSend,
  onStop,
  onPause,
  onContinue,
  onEditMessage,
  onDeleteMessage,
  onRegenerate,
  onRetry,
  onCompactContext,
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
  onUpdateTodo,
  onRemoveTodo,
  onSendTodo,
  onSendAllTodos,
  onClearSentTodos,
  onScheduleTodo,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const lastSessionRef = useRef<string | null>(null)
  const earlierAnchor = useRef<{ height: number; top: number } | null>(null)
  const [showJump, setShowJump] = useState(false)
  // null = never customized; the welcome screen then shows the built-in prompts.
  const [quickCommands, setQuickCommands] = useState<QuickCommand[] | null>(null)

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
    () => (session ? buildTranscript(session.messages) : []),
    [session],
  )
  const runsById = useMemo(
    () => new Map(runs.map((run) => [run.id, run])),
    [runs],
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
  }

  const loadEarlier = () => {
    const element = scrollRef.current
    if (!element || loadingEarlier) return
    earlierAnchor.current = { height: element.scrollHeight, top: element.scrollTop }
    void onLoadEarlier().then((added) => {
      if (!added) earlierAnchor.current = null
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
      <div className="messages-scroll" ref={scrollRef} onScroll={onScroll}>
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
              return <ProcessBox process={message} key={message.id} />
            }
            return (
              <AssistantMessageRow
                message={message}
                key={message.id}
                focused={focusMessageId === message.id}
                canRegenerate={!running && message.id === lastAssistantId}
                {...(message.runId && runsById.has(message.runId)
                  ? { run: runsById.get(message.runId)! }
                  : {})}
                onFeedback={onFeedback}
                onReflect={onReflect}
                onRegenerate={onRegenerate}
              />
            )
          })}

          {process ? <ProcessBox process={process} /> : null}

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
                  <details className="reasoning-block answer-reasoning">
                    <summary>{t("思考过程")}</summary>
                    <div className="reasoning-content">{live.reasoning}</div>
                  </details>
                ) : null}
                <Markdown content={live.content} />
                <span className="stream-caret" />
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
          contextStats={contextStats}
          compacting={compacting}
          projectInstructions={projectInstructions}
          composerSeed={composerSeed}
          onSend={onSend}
          onStop={onStop}
          onPause={onPause}
          onOpenSettings={onOpenSettings}
          onCompactContext={onCompactContext}
          onAddTodo={onAddTodo}
          onUpdateTodo={onUpdateTodo}
          onRemoveTodo={onRemoveTodo}
          onSendTodo={onSendTodo}
          onSendAllTodos={onSendAllTodos}
          onClearSentTodos={onClearSentTodos}
          onScheduleTodo={onScheduleTodo}
        />
      </div>
    </div>
  )
}
