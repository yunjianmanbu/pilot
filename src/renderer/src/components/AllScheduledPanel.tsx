import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ScheduleKind, ScheduledTask, ScheduledTaskGroup } from '../../../shared/types'
import { CheckIcon, ClockIcon, RefreshIcon, TodoIcon, TrashIcon } from '../icons'
import { formatRelative } from '../ui'
import { t } from '../i18n'

const KIND_LABELS: Record<ScheduleKind, string> = {
  once: t('一次'),
  interval: t('间隔'),
  daily: t('每天'),
}

function formatLocal(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function kindHint(task: ScheduledTask): string {
  if (task.kind === 'interval') return t('每 {v1} 分钟', { v1: task.intervalMinutes ?? 0 })
  if (task.kind === 'daily') return t('每天 {v1}', { v1: task.timeOfDay ?? '' })
  return KIND_LABELS[task.kind]
}

function workspaceName(path: string): string {
  const parts = path.trim().replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/**
 * 左下角「定时」的全量视图：所有会话的定时任务都在这儿，按下一次触发时间排序。
 * 会话里的定时面板负责新建，这里负责「我到底还挂着哪些定时任务」。
 */
export function AllScheduledPanel({
  revision,
  onOpenSession,
  onError,
}: {
  revision: number
  onOpenSession: (sessionId: string) => void
  onError: (message: string) => void
}) {
  const [groups, setGroups] = useState<ScheduledTaskGroup[] | null>(null)
  const [busyId, setBusyId] = useState('')
  /** 「启用中」只看还会触发的；「全部」连暂停的也列出来。 */
  const [tab, setTab] = useState<'active' | 'all'>('active')

  const load = useCallback(() => {
    setGroups(null)
    window.pilot
      .allScheduledTasks()
      .then((list) => setGroups(list))
      .catch((reason: unknown) => {
        onError(reason instanceof Error ? reason.message : String(reason))
        setGroups([])
      })
  }, [onError])

  useEffect(() => {
    load()
  }, [load, revision])

  const totals = useMemo(() => {
    const tasks = (groups ?? []).flatMap((group) => group.tasks)
    return {
      tasks: tasks.length,
      active: tasks.filter((task) => task.enabled).length,
      paused: tasks.filter((task) => !task.enabled).length,
      sessions: (groups ?? []).filter((group) => group.tasks.length > 0).length,
    }
  }, [groups])

  // 切到「启用中」时只看还会跑的任务，空组直接收起来。
  const visibleGroups = useMemo(() => {
    if (tab === 'all') return groups ?? []
    return (groups ?? [])
      .map((group) => ({ ...group, tasks: group.tasks.filter((task) => task.enabled) }))
      .filter((group) => group.tasks.length > 0)
  }, [groups, tab])

  const run = useCallback(
    async (id: string, action: () => Promise<unknown>, message?: string) => {
      setBusyId(id)
      try {
        await action()
        if (message) onError(message)
        load()
      } catch (reason) {
        onError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusyId('')
      }
    },
    [load, onError],
  )

  const renderTask = (group: ScheduledTaskGroup, task: ScheduledTask) => {
    const busy = busyId === task.id
    return (
      <div className={`schedule-row${task.enabled ? '' : ' is-off'}`} key={task.id}>
        <span className={`schedule-kind kind-${task.kind}`}>{KIND_LABELS[task.kind]}</span>
        <div className="schedule-row-main">
          <p>{task.content}</p>
          <small>
            {kindHint(task)}
            {task.enabled
              ? ` · ${t('下次 {v1}', { v1: formatLocal(task.nextRunAt) })}`
              : ` · ${t('已暂停')}`}
            {task.lastRunAt ? ` · ${t('上次 {v1}', { v1: formatLocal(task.lastRunAt) })}` : ''}
          </small>
          {task.lastStatus === 'failed' ? (
            <small className="schedule-row-error">{task.lastError || t('上次执行失败')}</small>
          ) : null}
        </div>
        <div className="schedule-row-actions">
          <button
            type="button"
            className="button ghost tiny"
            disabled={busy}
            onClick={() =>
              void run(task.id, () =>
                window.pilot.updateScheduledTask(group.sessionId, task.id, {
                  enabled: !task.enabled,
                }),
              )
            }
          >
            {task.enabled ? t('暂停') : t('启用')}
          </button>
          <button
            type="button"
            className="todo-action"
            title={t('转成待办')}
            disabled={busy}
            onClick={() =>
              void run(task.id, () =>
                window.pilot.convertScheduledTaskToTodo(group.sessionId, task.id),
              )
            }
          >
            {busy ? <i className="spinner tiny" /> : <TodoIcon width={12} height={12} />}
          </button>
          <button
            type="button"
            className="todo-action danger"
            title={t('删除定时任务')}
            disabled={busy}
            onClick={() => {
              if (!window.confirm(t('删除这条定时任务？'))) return
              void run(task.id, () =>
                window.pilot.removeScheduledTask(group.sessionId, task.id),
              )
            }}
          >
            <TrashIcon width={12} height={12} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page panel-page all-todos-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <ClockIcon width={13} height={13} />
            {t('定时')}
          </div>
          <h1>{t('全部定时任务')}</h1>
          <p>
            {groups === null
              ? t('读取中…')
              : t('{v1} 项定时任务 · {v2} 项启用 · 分布在 {v3} 个会话', {
                  v1: totals.tasks,
                  v2: totals.active,
                  v3: totals.sessions,
                })}
          </p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{totals.active}</strong>
            <span>{t('项启用中')}</span>
          </div>
          <div className="stat">
            <strong>{totals.paused}</strong>
            <span>{t('项已暂停')}</span>
          </div>
          <div className="stat">
            <strong>{totals.sessions}</strong>
            <span>{t('个会话')}</span>
          </div>
        </div>
      </div>

      <div className="page-tabs" role="tablist" aria-label={t('定时任务筛选')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'active'}
          className={`page-tab${tab === 'active' ? ' is-active' : ''}`}
          onClick={() => setTab('active')}
        >
          <ClockIcon width={15} height={15} />
          {t('启用中')}
          {totals.active > 0 ? <span className="page-tab-badge">{totals.active}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={`page-tab${tab === 'all' ? ' is-active' : ''}`}
          onClick={() => setTab('all')}
        >
          {t('全部')}
          {totals.tasks > 0 ? <span className="page-tab-badge">{totals.tasks}</span> : null}
        </button>
        <button
          type="button"
          className="page-tabs-refresh"
          title={t('刷新')}
          aria-label={t('刷新')}
          onClick={load}
        >
          <RefreshIcon width={14} height={14} />
        </button>
      </div>

      <div className="all-todos-body">
        {groups === null ? (
          <div className="all-todos-empty">
            <i className="spinner" />
            {t('正在汇总所有会话的定时任务…')}
          </div>
        ) : totals.tasks === 0 ? (
          <div className="all-todos-empty">
            <ClockIcon width={26} height={26} />
            <strong>{t('没有定时任务')}</strong>
            <span>{t('在会话输入框上方的「定时任务」面板新建一条，就能给这个会话挂上。')}</span>
          </div>
        ) : visibleGroups.length === 0 ? (
          <div className="all-todos-empty">
            <ClockIcon width={26} height={26} />
            <strong>{t('没有启用中的定时任务')}</strong>
            <span>{t('切到「全部」可以看到已暂停的任务，再点「启用」恢复它。')}</span>
          </div>
        ) : (
          visibleGroups.map((group) => (
            <article className="all-todos-group" key={group.sessionId}>
              <header className="all-todos-group-head">
                <button
                  type="button"
                  className="link-btn all-todos-session"
                  title={t('回到这个会话')}
                  onClick={() => onOpenSession(group.sessionId)}
                >
                  {group.sessionTitle}
                </button>
                <span className="all-todos-workspace">{workspaceName(group.workspacePath)}</span>
                <span className="all-todos-meta">
                  {t('{v1} 项定时任务', { v1: group.tasks.length })}
                  {` · ${formatRelative(group.sessionUpdatedAt) || t('刚刚')}`}
                </span>
              </header>
              <div className="schedule-rows">
                {group.tasks.map((task) => renderTask(group, task))}
              </div>
            </article>
          ))
        )}
      </div>

      <footer className="all-todos-foot">
        {t('定时任务在电脑端运行；关闭客户端后不会触发，重新打开时到点未跑的任务会补跑。')}
      </footer>
    </div>
  )
}
