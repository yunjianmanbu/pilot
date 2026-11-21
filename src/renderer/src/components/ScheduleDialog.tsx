import { useEffect, useState } from 'react'
import type {
  ScheduleKind,
  ScheduledTask,
  ScheduledTaskInput,
  Session,
} from '../../../shared/types'
import { ClockIcon, PlusIcon, TrashIcon, XIcon } from '../icons'
import { SelectMenu } from './SelectMenu'
import { useEscapeClose } from './useEscapeClose'
import { t } from '../i18n'

const KIND_LABELS: Record<ScheduleKind, string> = {
  once: t("一次"),
  interval: t("间隔"),
  daily: t("每天"),
}

const KIND_OPTIONS: Array<{ value: ScheduleKind; label: string }> = [
  { value: 'once', label: t("稍后一次") },
  { value: 'interval', label: t("每隔一段时间") },
  { value: 'daily', label: t("每天固定时间") },
]

function formatLocal(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function scheduleLabel(task: ScheduledTask): string {
  if (task.kind === 'interval') return t("每 {v1} 分钟", { v1: task.intervalMinutes ?? 60 })
  if (task.kind === 'daily') return t("每天 {v1}", { v1: task.timeOfDay ?? '09:00' })
  return t("一次性")
}

export function ScheduleDialog({
  session,
  revision,
  seed,
  onSeedUsed,
  onConvertTodo,
  onConvertToTodo,
  onClose,
  onError,
}: {
  session: Session
  revision: number
  /** Prefill from a todo; when `todoId` is set the todo is moved on submit. */
  seed?: { content: string; todoId?: string } | null
  onSeedUsed?: () => void
  onConvertTodo?: (todoId: string, input: ScheduledTaskInput) => Promise<ScheduledTask | null>
  onConvertToTodo?: (taskId: string) => Promise<void>
  onClose: () => void
  onError: (message: string) => void
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  useEscapeClose(onClose)
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<ScheduleKind>('once')
  const [delayMinutes, setDelayMinutes] = useState('10')
  const [intervalMinutes, setIntervalMinutes] = useState('60')
  const [timeOfDay, setTimeOfDay] = useState('09:00')
  const [error, setError] = useState('')
  const [seedTodo, setSeedTodo] = useState<string | null>(null)
  const [editing, setEditing] = useState<{
    id: string
    content: string
    kind: ScheduleKind
    delayMinutes: string
    intervalMinutes: string
    timeOfDay: string
  } | null>(null)

  useEffect(() => {
    if (!seed) return
    setContent(seed.content)
    setSeedTodo(seed.todoId ?? null)
    setError('')
  }, [seed])

  const inputOf = (): ScheduledTaskInput | null => {
    const delay = Number(delayMinutes)
    const interval = Number(intervalMinutes)
    if (kind === 'once' && (!Number.isFinite(delay) || delay < 1 || delay > 10_080)) {
      setError(t("延迟时间需要在 1 到 10,080 分钟之间。"))
      return null
    }
    if (kind === 'interval' && (!Number.isFinite(interval) || interval < 1 || interval > 10_080)) {
      setError(t("间隔需要在 1 到 10,080 分钟之间。"))
      return null
    }
    return {
      content: content.trim(),
      kind,
      ...(kind === 'once' ? { delayMinutes: delay } : {}),
      ...(kind === 'interval' ? { intervalMinutes: interval } : {}),
      ...(kind === 'daily' ? { timeOfDay } : {}),
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.pilot
      .listScheduledTasks(session.id)
      .then((list) => {
        if (!cancelled) setTasks(list)
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [session.id, revision])

  const add = async () => {
    setError('')
    if (!content.trim()) {
      setError(t("先写清楚要定时执行的内容。"))
      return
    }
    const input = inputOf()
    if (!input) return
    setBusy('add')
    try {
      const task =
        seedTodo && onConvertTodo
          ? await onConvertTodo(seedTodo, input)
          : await window.pilot.addScheduledTask(session.id, input)
      if (task) {
        setTasks((previous) =>
          [...previous.filter((entry) => entry.id !== task.id), task].sort((a, b) =>
            a.nextRunAt.localeCompare(b.nextRunAt),
          ),
        )
        setContent('')
        setSeedTodo(null)
        onSeedUsed?.()
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setBusy(null)
    }
  }

  const startEdit = (task: ScheduledTask) => {
    setEditing({
      id: task.id,
      content: task.content,
      kind: task.kind,
      delayMinutes: '10',
      intervalMinutes: task.intervalMinutes ? String(task.intervalMinutes) : '60',
      timeOfDay: task.timeOfDay ?? '09:00',
    })
  }

  const saveEdit = async () => {
    if (!editing) return
    setError('')
    if (!editing.content.trim()) {
      setError(t("定时任务内容不能为空。"))
      return
    }
    const delay = Number(editing.delayMinutes)
    const interval = Number(editing.intervalMinutes)
    if (editing.kind === 'once' && (!Number.isFinite(delay) || delay < 1 || delay > 10_080)) {
      setError(t("延迟时间需要在 1 到 10,080 分钟之间。"))
      return
    }
    if (editing.kind === 'interval' && (!Number.isFinite(interval) || interval < 1 || interval > 10_080)) {
      setError(t("间隔需要在 1 到 10,080 分钟之间。"))
      return
    }
    setBusy(editing.id)
    try {
      const next = await window.pilot.updateScheduledTask(session.id, editing.id, {
        content: editing.content.trim(),
        kind: editing.kind,
        ...(editing.kind === 'once' ? { delayMinutes: delay } : {}),
        ...(editing.kind === 'interval' ? { intervalMinutes: interval } : {}),
        ...(editing.kind === 'daily' ? { timeOfDay: editing.timeOfDay } : {}),
      })
      setTasks((previous) =>
        previous
          .map((entry) => (entry.id === next.id ? next : entry))
          .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)),
      )
      setEditing(null)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setBusy(null)
    }
  }

  const convertToTodo = async (task: ScheduledTask) => {
    if (!onConvertToTodo) return
    setBusy(task.id)
    try {
      await onConvertToTodo(task.id)
      setTasks((previous) => previous.filter((entry) => entry.id !== task.id))
      if (editing?.id === task.id) setEditing(null)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const toggle = async (task: ScheduledTask) => {
    setBusy(task.id)
    try {
      const next = await window.pilot.updateScheduledTask(session.id, task.id, {
        enabled: !task.enabled,
      })
      setTasks((previous) => previous.map((entry) => (entry.id === next.id ? next : entry)))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (task: ScheduledTask) => {
    if (!window.confirm(t("删除定时任务「{v1}」？", { v1: task.content.slice(0, 40) }))) return
    setBusy(task.id)
    try {
      await window.pilot.removeScheduledTask(session.id, task.id)
      setTasks((previous) => previous.filter((entry) => entry.id !== task.id))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal schedule-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("定时任务")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>
              <ClockIcon width={18} height={18} />
              {t("定时任务")}</h2>
            <p>{t("到点后把内容加入这个会话的队列，和手动发送走同样的审批与工作区边界。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body schedule-body">
          <section className="schedule-form">
            <label className="settings-field wide">
              <span className="field-label">{t("执行内容")}</span>
              <textarea
                className="text-input schedule-content"
                rows={3}
                maxLength={4_000}
                value={content}
                placeholder={t("例如：检查项目测试结果，失败则修复并重新运行")}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            {seedTodo ? (
              <div className="schedule-seed">{t("添加后会把这个待办转成定时任务，并从待办列表移除。")}</div>
            ) : null}
            <div className="schedule-form-row">
              <label className="settings-field">
                <span className="field-label">{t("频率")}</span>
                <SelectMenu
                  value={kind}
                  options={KIND_OPTIONS}
                  onChange={(value) => setKind(value as ScheduleKind)}
                  ariaLabel={t("频率")}
                />
              </label>
              {kind === 'once' ? (
                <label className="settings-field">
                  <span className="field-label">{t("延迟（分钟）")}</span>
                  <input
                    className="text-input mono"
                    type="number"
                    min={1}
                    max={10_080}
                    value={delayMinutes}
                    onChange={(event) => setDelayMinutes(event.target.value)}
                  />
                </label>
              ) : kind === 'interval' ? (
                <label className="settings-field">
                  <span className="field-label">{t("间隔（分钟）")}</span>
                  <input
                    className="text-input mono"
                    type="number"
                    min={1}
                    max={10_080}
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                  />
                </label>
              ) : (
                <label className="settings-field">
                  <span className="field-label">{t("每天时间")}</span>
                  <input
                    className="text-input mono"
                    type="time"
                    value={timeOfDay}
                    onChange={(event) => setTimeOfDay(event.target.value)}
                  />
                </label>
              )}
              <button
                type="button"
                className="button primary schedule-add"
                onClick={() => void add()}
                disabled={busy === 'add'}
              >
                {busy === 'add' ? <i className="spinner" /> : <PlusIcon width={15} height={15} />}
                {seedTodo ? t("转为定时") : t("添加")}
              </button>
            </div>
            {error ? <div className="settings-error">{error}</div> : null}
            <p className="schedule-hint">
              {t("也可以直接在对话里说：「每天 9 点帮我整理待办」，Pilot 会自己建好这条任务。")}
            </p>
          </section>

          <section className="schedule-list">
            <div className="schedule-list-head">
              <strong>{t("已安排")}</strong>
              <span>{tasks.length} {t("项")}</span>
            </div>
            {loading ? (
              <div className="schedule-empty">
                <i className="spinner" />
                {t("读取中…")}</div>
            ) : tasks.length === 0 ? (
              <div className="schedule-empty">
                <ClockIcon width={24} height={24} />
                <span>{t("还没有定时任务。Pilot 只会在电脑客户端运行时触发。")}</span>
              </div>
            ) : (
              tasks.map((task) => (
                <div className={`schedule-item${task.enabled ? '' : ' is-off'}`} key={task.id}>
                  <div className="schedule-item-main">
                    <div className="schedule-item-title">
                      <span className={`schedule-kind kind-${task.kind}`}>
                        {KIND_LABELS[task.kind]}
                      </span>
                      <span>{scheduleLabel(task)}</span>
                      {task.lastStatus === 'failed' ? (
                        <span className="schedule-failed" title={task.lastError}>
                          {t("上次失败")}</span>
                      ) : null}
                    </div>
                    {editing?.id === task.id ? (
                      <div className="schedule-edit">
                        <textarea
                          className="text-input"
                          rows={2}
                          maxLength={4_000}
                          value={editing.content}
                          onChange={(event) =>
                            setEditing({ ...editing, content: event.target.value })
                          }
                        />
                        <div className="schedule-edit-row">
                          <SelectMenu
                            className="select-menu-compact"
                            value={editing.kind}
                            options={KIND_OPTIONS}
                            onChange={(value) =>
                              setEditing({ ...editing, kind: value as ScheduleKind })
                            }
                            ariaLabel={t("频率")}
                          />
                          {editing.kind === 'once' ? (
                            <input
                              className="text-input mono"
                              type="number"
                              min={1}
                              max={10_080}
                              value={editing.delayMinutes}
                              onChange={(event) =>
                                setEditing({ ...editing, delayMinutes: event.target.value })
                              }
                              aria-label={t("延迟分钟")}
                            />
                          ) : editing.kind === 'interval' ? (
                            <input
                              className="text-input mono"
                              type="number"
                              min={1}
                              max={10_080}
                              value={editing.intervalMinutes}
                              onChange={(event) =>
                                setEditing({ ...editing, intervalMinutes: event.target.value })
                              }
                              aria-label={t("间隔分钟")}
                            />
                          ) : (
                            <input
                              className="text-input mono"
                              type="time"
                              value={editing.timeOfDay}
                              onChange={(event) =>
                                setEditing({ ...editing, timeOfDay: event.target.value })
                              }
                              aria-label={t("每天时间")}
                            />
                          )}
                          <button
                            type="button"
                            className="button primary tiny"
                            disabled={busy === task.id}
                            onClick={() => void saveEdit()}
                          >
                            {t("保存")}</button>
                          <button
                            type="button"
                            className="button ghost tiny"
                            onClick={() => setEditing(null)}
                          >
                            {t("取消")}</button>
                        </div>
                      </div>
                    ) : (
                      <p>{task.content}</p>
                    )}
                    <small>
                      {task.enabled ? t("下次 {v1}", { v1: formatLocal(task.nextRunAt) }) : t("已暂停")}
                      {task.lastRunAt ? t(" · 上次 {v1}", { v1: formatLocal(task.lastRunAt) }) : ''}
                    </small>
                  </div>
                  <div className="schedule-item-actions">
                    <button
                      type="button"
                      className="button ghost tiny"
                      disabled={busy === task.id}
                      onClick={() => startEdit(task)}
                    >
                      {t("编辑")}</button>
                    {onConvertToTodo ? (
                      <button
                        type="button"
                        className="button ghost tiny"
                        disabled={busy === task.id}
                        onClick={() => void convertToTodo(task)}
                      >
                        {t("转待办")}</button>
                    ) : null}
                    <button
                      type="button"
                      className="button ghost tiny"
                      disabled={busy === task.id}
                      onClick={() => void toggle(task)}
                    >
                      {task.enabled ? t("暂停") : t("启用")}
                    </button>
                    <button
                      type="button"
                      className="button ghost tiny danger-text"
                      disabled={busy === task.id}
                      onClick={() => void remove(task)}
                      aria-label={t("删除定时任务")}
                    >
                      <TrashIcon width={13} height={13} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>

        <div className="modal-footer">
          <span className="settings-note">{t("定时任务保存在本机；关闭电脑后不会在后台执行。")}</span>
          <div className="modal-actions">
            <button type="button" className="button ghost" onClick={onClose}>
              {t("关闭")}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
