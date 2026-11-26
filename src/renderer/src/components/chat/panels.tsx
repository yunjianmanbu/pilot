import { useEffect, useMemo, useState } from 'react'
import type {
  QueuedTask,
  QuickCommand,
  Session,
  TodoItem,
  TodoPriority,
  WorkspaceSummary,
} from '../../../../shared/types'
import { sortTodos } from '../../../../shared/todos'
import type { FailureAction } from '../../../../shared/run-failure'
import { classifyRunFailure, failureAction } from '../../../../shared/run-failure'
import {
  BookmarkIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  FolderIcon,
  InfoIcon,
  ListCheckIcon,
  PauseIcon,
  PilotMark,
  PlayIcon,
  PlusIcon,
  SendIcon,
  SparkIcon,
  XIcon,
} from '../../icons'
import { t } from '../../i18n'
import { QuickCommandsDialog } from '../QuickCommandsDialog'
import { TodoPrioritySelect } from '../TodoPrioritySelect'
import { runElapsedLabel } from '../../ui'
import { QUICK_PROMPTS } from './composer-state'

export function Welcome({
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
          <BookmarkIcon width={13} height={13} />
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

export function TodoPanel({
  todos,
  onAdd,
  onUpdate,
  onRemove,
  onSend,
  onSendAll,
  onClearSent,
  onSchedule,
  onPriority,
}: {
  todos: TodoItem[]
  onAdd: (text: string, priority: TodoPriority) => Promise<void>
  onUpdate: (todoId: string, text: string) => Promise<void>
  onRemove: (todoId: string) => Promise<void>
  onSend: (todoId: string) => Promise<void>
  onSendAll: () => Promise<void>
  onClearSent: () => Promise<void>
  onSchedule: (todo: TodoItem) => void
  onPriority: (todoId: string, priority: TodoPriority) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [draftPriority, setDraftPriority] = useState<TodoPriority>('normal')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const pending = todos.filter((todo) => todo.status === 'pending')
  const sent = todos.length - pending.length
  // 未发送的按优先级排（高→中→低），已发送的沉到后面并保留原顺序。
  const ordered = useMemo(
    () => [...sortTodos(pending), ...todos.filter((todo) => todo.status !== 'pending')],
    [todos, pending],
  )

  const add = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await onAdd(text, draftPriority)
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
          <TodoPrioritySelect
            value={draftPriority}
            onChange={setDraftPriority}
            title={t("新待办优先级")}
          />
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
              {ordered.map((todo) => (
                <div className={`todo-item status-${todo.status}`} key={todo.id}>
                  <span className="todo-check">
                    {todo.status === 'sent' ? (
                      <CheckIcon width={11} height={11} />
                    ) : (
                      <i className="plan-circle" />
                    )}
                  </span>
                  {todo.status === 'pending' ? (
                    <TodoPrioritySelect
                      value={todo.priority}
                      onChange={(next) => void onPriority(todo.id, next)}
                    />
                  ) : null}
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

/**
 * The four `config` sentences, written as literal `t()` keys so the English
 * dictionary actually applies to them. A table lookup (`t(TABLE[action])`)
 * cannot be translated: `t()` only sees literal keys, so English users were
 * shown the Chinese sentence. `tests/run-failure.test.ts` keeps this table
 * identical to `FAILURE_ACTION_TEXT` in shared/run-failure.
 */
const ACTION_TEXT: Record<FailureAction, () => string> = {
  key: () => t('在设置里换一个有效的 API Key，然后继续。'),
  balance: () => t('账户余额不足，充值后再继续；重试不会改变结果。'),
  model: () => t('账号无权使用这个模型，在设置里换模型或申请权限后再继续。'),
  config: () => t('检查模型名称、API Key 与账户余额，改好后再继续。'),
}

export function ContinueBar({
  session,
  busy,
  onContinue,
  onOpenSettings,
}: {
  session: Session
  busy: boolean
  onContinue: () => void
  /** A config failure can only be fixed in Settings, so offer that as the primary action. */
  onOpenSettings?: () => void
}) {
  const instruction = session.pauseInstruction?.trim() ?? ''
  // One sentence for every failure made 28% of runs end on a line that named no
  // cause. The classification comes from shared/run-failure, the same function
  // the agent loop uses to stop auto-continue on errors a replay cannot fix.
  const kind = session.paused ? null : classifyRunFailure(session.lastRunStatus, session.lastRunError)
  // A config failure can be fixed in one place: the key, the balance or the
  // model name. Telling the user which one turns the bar into an action; the
  // provider's own wording stays in the tooltip so nothing is hidden.
  const configAction = kind === 'config' ? failureAction(session.lastRunError) : null
  // Step count of the run being recovered. The generic line said "continue from
  // where it stopped" without saying where that was, so a user resuming a
  // 103-step run had to reread the workspace to find out.
  const stoppedAt = !session.paused && session.lastRunSteps ? session.lastRunSteps : 0
  const detail =
    session.paused && instruction
      ? t("进度停在：{v1}{v2}", { v1: instruction.slice(0, 80), v2: instruction.length > 80 ? '…' : '' })
      : session.paused
        ? t("任务已暂停，可随时从断点继续。")
        : kind === 'config'
          ? ACTION_TEXT[configAction ?? 'config']()
          : kind === 'budget'
            ? t("已完成的部分已保留在工作区，继续会接着计划往下走。")
            : kind === 'network'
              ? t("重试通常即可恢复；继续前 Pilot 会先检查工作区现状。")
              : t("从上次中断的地方继续，Pilot 会先检查工作区现状，避免重复已完成步骤。")
  const title = session.paused
    ? t("任务已暂停")
    : kind === 'config'
      ? t("模型或账号配置需要处理")
      : kind === 'budget'
        ? t("达到步数上限")
        : kind === 'network'
          ? t("网络或服务端中断")
          : t("上次任务没有正常结束")
  const action =
    kind === 'config' ? t("已修复，继续") : kind === 'network' ? t("重试") : t("继续")
  // A wrong key, an empty balance or a denied model cannot be replayed into
  // success, so the button that only repeats the request is not the main one.
  // Settings is where the fix lives; continuing stays available for a user who
  // already fixed it elsewhere (another profile, the provider's dashboard).
  const configFix = kind === 'config' && onOpenSettings ? onOpenSettings : null
  // The provider's own wording is kept one hover away instead of in the body:
  // it is the evidence, not the instruction. Truncated so a relay that echoes a
  // whole HTML error page cannot bloat the markup.
  const rawError = kind === 'config' ? (session.lastRunError ?? '').slice(0, 120) : undefined
  // Where the run stopped and how much of the plan it finished. Neither needs a
  // new write: the step count comes from the run record and the plan is already
  // in the session summary, so resuming no longer requires rereading the
  // workspace to work out what is left.
  const planItems = session.plan?.items ?? []
  const progress = [
    stoppedAt > 0 ? t("上次运行停在：第 {v1} 步", { v1: stoppedAt }) : '',
    planItems.length > 0
      ? t("计划已完成 {v1}/{v2} 项", {
          v1: planItems.filter((item) => item.status === 'done').length,
          v2: planItems.length,
        })
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={`continue-bar${session.paused ? ' is-paused' : ''}`}>
      <span className="continue-icon">
        {session.paused ? <PauseIcon width={14} height={14} /> : <PlayIcon width={13} height={13} />}
      </span>
      <div className="continue-text">
        <strong>{title}</strong>
        <span title={rawError}>{detail}</span>
        {progress ? <span title={progress}>{progress}</span> : null}
      </div>
      <button
        type="button"
        className={`button${configFix ? '' : ' primary'}`}
        onClick={onContinue}
        disabled={busy}
      >
        {busy ? <i className="spinner" /> : <PlayIcon width={12} height={12} />}
        {action}</button>
      {configFix ? (
        <button type="button" className="button primary" onClick={configFix}>
          {t("打开设置")}</button>
      ) : null}
    </div>
  )
}

export function QueuePanel({
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

/**
 * The run's own elapsed counter, ticking once a second.
 *
 * A wait reads the same whether it has lasted two seconds or two minutes; this
 * is the piece that tells them apart. The interval lives in this component so a
 * tick repaints one small span instead of the whole transcript.
 */
export function LiveElapsed({
  startedAt,
  className = 'thinking-elapsed',
}: {
  /** Milliseconds since the run started; absent when only the flag is known. */
  startedAt?: number | undefined
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  const elapsed = runElapsedLabel(startedAt, now)
  if (!elapsed) return null
  return (
    <span className={className} aria-live="off">
      {elapsed}
    </span>
  )
}

/**
 * Shown while the run is working but has produced nothing to read yet. The
 * dots alone look identical whether the model is thinking for two seconds or
 * for two minutes, so the row also carries the run's elapsed time.
 */
export function ThinkingIndicator({
  step,
  startedAt,
}: {
  step: number
  startedAt?: number | undefined
}) {
  return (
    <div className="thinking-row">
      <div className="assistant-avatar live">
        <PilotMark width={18} height={18} />
      </div>
      <div className="thinking-text">
        <span>{step > 1 ? t("正在执行第 {v1} 步", { v1: step }) : t("正在理解任务")}</span>
        <LiveElapsed startedAt={startedAt} />
        <span className="typing-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  )
}
