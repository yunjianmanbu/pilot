import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ScheduleKind,
  ScheduledTask,
  ScheduledTaskInput,
} from '../../../shared/types'
import {
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  PlayIcon,
  PlusIcon,
  TodoIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
} from '../icons'
import { SelectMenu } from './SelectMenu'
import { t } from '../i18n'

const KIND_OPTIONS: Array<{ value: ScheduleKind; label: string }> = [
  { value: 'once', label: t('稍后一次') },
  { value: 'interval', label: t('每隔一段时间') },
  { value: 'daily', label: t('每天固定时间') },
]

const KIND_SHORT: Record<ScheduleKind, string> = {
  once: t('一次'),
  interval: t('间隔'),
  daily: t('每天'),
}

function formatLocal(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function kindHint(task: ScheduledTask): string {
  if (task.kind === 'interval') return t('每 {v1} 分钟', { v1: task.intervalMinutes ?? 0 })
  if (task.kind === 'daily') {
    const time = t('每天 {v1}', { v1: task.timeOfDay ?? '' })
    return task.startDate ? t('{v1}（从 {v2} 起）', { v1: time, v2: task.startDate }) : time
  }
  return t('一次')
}

export interface ScheduleSeed {
  content: string
  /** 由待办上的时钟按钮带进来；保存后把这条件办删掉。 */
  todoId?: string
}

/**
 * 会话输入框上方的定时任务面板，位置和外观与「待办」一致。
 *
 * 桌面端原来只有三点菜单里的一个弹框；用户在会话里想「这条稍后再说」时，
 * 弹框会盖住正在写的内容。现在与移动端一致：待办下面一块折叠区，
 * 新建、暂停、编辑、转待办都在会话里完成。
 */
export function SessionSchedulePanel({
  sessionId,
  seed,
  onSeedUsed,
  onConvertTodoToSchedule,
  onConvertToTodo,
  onNotice,
}: {
  sessionId: string
  seed: ScheduleSeed | null
  onSeedUsed: () => void
  onConvertTodoToSchedule: (
    todoId: string,
    input: ScheduledTaskInput,
  ) => Promise<ScheduledTask | null>
  onConvertToTodo: (taskId: string) => Promise<unknown>
  onNotice: (message: string, level?: 'info' | 'warn' | 'error') => void
}) {
  const [open, setOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null)
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<ScheduleKind>('once')
  const [delayMinutes, setDelayMinutes] = useState('30')
  const [intervalMinutes, setIntervalMinutes] = useState('60')
  const [timeOfDay, setTimeOfDay] = useState('09:00')
  const [startDate, setStartDate] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    window.pilot
      .listScheduledTasks(sessionId)
      .then((list) => {
        if (!cancelled) setTasks(list)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => load(), [load])

  // 别的入口（对话里的 schedule_task 工具、右侧联动）改了定时任务时同步一次。
  useEffect(
    () =>
      window.pilot.onEvent((event) => {
        if (event.type === 'scheduled.changed') load()
      }),
    [load],
  )

  // 待办上的时钟按钮：展开面板并把内容带进表单。
  useEffect(() => {
    if (!seed) return
    setContent(seed.content)
    setFormOpen(true)
    setOpen(true)
    setError('')
  }, [seed])

  useEffect(() => {
    if (formOpen) inputRef.current?.focus()
  }, [formOpen])

  const active = useMemo(() => (tasks ?? []).filter((task) => task.enabled).length, [tasks])

  const inputOf = (): ScheduledTaskInput | null => {
    const text = content.trim()
    if (!text) {
      setError(t('先写清楚到点要做什么'))
      return null
    }
    if (kind === 'once') {
      const delay = Number(delayMinutes)
      if (!Number.isFinite(delay) || delay < 1) {
        setError(t('延迟至少 1 分钟'))
        return null
      }
      return { content: text, kind, delayMinutes: Math.round(delay) }
    }
    if (kind === 'interval') {
      const interval = Number(intervalMinutes)
      if (!Number.isFinite(interval) || interval < 5) {
        setError(t('间隔至少 5 分钟'))
        return null
      }
      return { content: text, kind, intervalMinutes: Math.round(interval) }
    }
    if (!/^\d{2}:\d{2}$/.test(timeOfDay)) {
      setError(t('时间格式要像 09:30'))
      return null
    }
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      setError(t('起始日期格式要像 2026-11-25'))
      return null
    }
    return { content: text, kind, timeOfDay, ...(startDate ? { startDate } : {}) }
  }

  const resetForm = () => {
    setFormOpen(false)
    setContent('')
    setStartDate('')
    setError('')
  }

  const submit = async () => {
    const input = inputOf()
    if (!input) return
    setBusy('new')
    try {
      if (seed?.todoId) {
        const created = await onConvertTodoToSchedule(seed.todoId, input)
        if (!created) return
        onSeedUsed()
      } else {
        await window.pilot.addScheduledTask(sessionId, input)
      }
      resetForm()
      load()
      onNotice(t('已加入定时任务。'), 'info')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onNotice(message, 'error')
    } finally {
      setBusy('')
    }
  }

  const toggle = async (task: ScheduledTask) => {
    setBusy(task.id)
    try {
      await window.pilot.updateScheduledTask(sessionId, task.id, { enabled: !task.enabled })
      load()
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : String(caught), 'error')
    } finally {
      setBusy('')
    }
  }

  const remove = async (task: ScheduledTask) => {
    if (!window.confirm(t('删除定时任务「{v1}」？', { v1: task.content.slice(0, 40) }))) return
    setBusy(task.id)
    try {
      await window.pilot.removeScheduledTask(sessionId, task.id)
      setTasks((previous) => (previous ?? []).filter((entry) => entry.id !== task.id))
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : String(caught), 'error')
    } finally {
      setBusy('')
    }
  }

  const toTodo = async (task: ScheduledTask) => {
    setBusy(task.id)
    try {
      await onConvertToTodo(task.id)
      load()
      onNotice(t('已把定时任务转为待办。'), 'info')
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : String(caught), 'error')
    } finally {
      setBusy('')
    }
  }

  const list = tasks ?? []
  const empty = tasks !== null && list.length === 0

  return (
    <details
      className="todo-panel schedule-panel"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="todo-badge">
          <ClockIcon width={12} height={12} />
          {t('定时任务')}
        </span>
        <span className="todo-summary-text">
          {list.length > 0
            ? t('{v1} 项 · {v2} 项在等', { v1: list.length, v2: active })
            : t('到点自动加入队列，电脑端执行')}
        </span>
        <span
          className="todo-send-all"
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.preventDefault()
            setOpen(true)
            setFormOpen(true)
            setError('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setOpen(true)
              setFormOpen(true)
            }
          }}
        >
          <PlusIcon width={11} height={11} />
          {t('新建')}
        </span>
        <ChevronIcon width={12} height={12} className="todo-chevron" />
      </summary>

      <div className="todo-body">
        {formOpen ? (
          <div className="schedule-form">
            <div className="todo-add-row">
              <input
                ref={inputRef}
                className="todo-add-input"
                value={content}
                placeholder={t('到点要让 Pilot 做什么')}
                onChange={(event) => {
                  setContent(event.target.value)
                  setError('')
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void submit()
                  } else if (event.key === 'Escape') {
                    resetForm()
                    if (seed) onSeedUsed()
                  }
                }}
              />
            </div>
            <div className="schedule-controls">
              <SelectMenu
                value={kind}
                options={KIND_OPTIONS}
                onChange={(value) => {
                  setKind(value as ScheduleKind)
                  setError('')
                }}
                ariaLabel={t('频率')}
              />
              {kind === 'once' ? (
                <label className="schedule-param">
                  <input
                    className="todo-add-input"
                    type="number"
                    min={1}
                    value={delayMinutes}
                    onChange={(event) => setDelayMinutes(event.target.value)}
                  />
                  <span>{t('分钟后')}</span>
                </label>
              ) : kind === 'interval' ? (
                <label className="schedule-param">
                  <input
                    className="todo-add-input"
                    type="number"
                    min={5}
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                  />
                  <span>{t('分钟一次')}</span>
                </label>
              ) : (
                <>
                  <label className="schedule-param">
                    <input
                      className="todo-add-input"
                      type="time"
                      value={timeOfDay}
                      onChange={(event) => setTimeOfDay(event.target.value)}
                    />
                    <span>{t('每天')}</span>
                  </label>
                  <label className="schedule-param">
                    <input
                      className="todo-add-input"
                      type="date"
                      value={startDate}
                      title={t('留空表示从今天开始每天执行')}
                      onChange={(event) => {
                        setStartDate(event.target.value)
                        setError('')
                      }}
                    />
                    <span>{t('从哪天起')}</span>
                  </label>
                </>
              )}
              <button
                type="button"
                className="button primary schedule-save"
                disabled={busy === 'new'}
                onClick={() => void submit()}
              >
                {busy === 'new' ? <i className="spinner tiny" /> : <CheckIcon width={12} height={12} />}
                {t('保存')}
              </button>
              <button type="button" className="todo-action" title={t('取消')} onClick={resetForm}>
                <XIcon width={12} height={12} />
              </button>
            </div>
            {error ? <div className="schedule-error">{error}</div> : null}
          </div>
        ) : null}

        {empty && !formOpen ? (
          <div className="schedule-empty">
            <ClockIcon width={14} height={14} />
            {t('还没有定时任务：点「新建」、待办上的时钟按钮，或直接在对话里说「20 分钟后…」。')}
          </div>
        ) : null}

        {list.length > 0 ? (
          <div className="todo-list schedule-list">
            {list.map((task) => (
              <div
                className={`todo-item schedule-item${task.enabled ? '' : ' is-paused'}`}
                key={task.id}
              >
                <span className="todo-state">
                  <ClockIcon width={13} height={13} />
                </span>
                <span className="todo-text">
                  {task.content}
                  <span className="schedule-meta">
                    {KIND_SHORT[task.kind]} · {kindHint(task)}
                    {task.enabled
                      ? ` · ${t('下次 {v1}', { v1: formatLocal(task.nextRunAt) })}`
                      : ` · ${t('已暂停')}`}
                  </span>
                </span>
                <span className="todo-actions">
                  <button
                    type="button"
                    className="todo-action"
                    title={task.enabled ? t('暂停') : t('启用')}
                    disabled={busy === task.id}
                    onClick={() => void toggle(task)}
                  >
                    {busy === task.id ? (
                      <i className="spinner tiny" />
                    ) : task.enabled ? (
                      <WrenchIcon width={12} height={12} />
                    ) : (
                      <PlayIcon width={12} height={12} />
                    )}
                  </button>
                  <button
                    type="button"
                    className="todo-action"
                    title={t('转成待办')}
                    onClick={() => void toTodo(task)}
                  >
                    <TodoIcon width={12} height={12} />
                  </button>
                  <button
                    type="button"
                    className="todo-action danger"
                    title={t('删除定时任务')}
                    onClick={() => void remove(task)}
                  >
                    <TrashIcon width={12} height={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  )
}
