import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TodoGroup, TodoItem } from '../../../shared/types'
import { sortTodos } from '../../../shared/todos'
import { CheckIcon, RefreshIcon, SendIcon, TodoIcon, TrashIcon } from '../icons'
import { formatRelative } from '../ui'
import { TodoPrioritySelect } from './TodoPrioritySelect'
import { t } from '../i18n'

function workspaceName(path: string): string {
  const parts = path.trim().replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/**
 * 左下角「待办」的全量视图：所有会话的待办都在这里，按会话分组、组内按
 * 优先级排序。输入框顶部那块只管当前会话，这里负责「我到底还欠着什么」。
 */
export function AllTodosPanel({
  revision,
  onOpenSession,
  onError,
  onNotice,
}: {
  /** 主进程推送 todos.changed 时自增，用来重新拉一次全量。 */
  revision: number
  /** 点会话标题回到那个会话。 */
  onOpenSession: (sessionId: string) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [groups, setGroups] = useState<TodoGroup[] | null>(null)
  const [busyId, setBusyId] = useState('')
  const [showSent, setShowSent] = useState(false)

  const load = useCallback(() => {
    setGroups(null)
    window.pilot
      .allTodos()
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
    const all = (groups ?? []).flatMap((group) => group.todos)
    return {
      pending: all.filter((todo) => todo.status === 'pending').length,
      sent: all.filter((todo) => todo.status === 'sent').length,
      sessions: (groups ?? []).length,
    }
  }, [groups])

  const run = async (id: string, action: () => Promise<unknown>, notice?: string) => {
    setBusyId(id)
    try {
      await action()
      if (notice) onNotice(notice)
      load()
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyId('')
    }
  }

  const renderTodo = (group: TodoGroup, todo: TodoItem) => {
    const busy = busyId === todo.id
    return (
      <div className={`todo-item status-${todo.status}`} key={todo.id}>
        <span className="todo-check">
          {todo.status === 'sent' ? <CheckIcon width={11} height={11} /> : <i className="plan-circle" />}
        </span>
        {todo.status === 'pending' ? (
          <TodoPrioritySelect
            value={todo.priority}
            onChange={(next) =>
              void run(
                todo.id,
                () => window.pilot.setTodoPriority(group.sessionId, todo.id, next),
              )
            }
          />
        ) : null}
        <span className="todo-text all-todos-text" title={todo.text}>
          {todo.text}
        </span>
        {todo.status === 'sent' ? (
          <span className="todo-sent">{t('已发送')}</span>
        ) : (
          <>
            <button
              type="button"
              className="todo-action"
              title={t('发送到该会话')}
              disabled={busy}
              onClick={() => {
                if (!window.confirm(t('把这条待办发到「{v1}」？', { v1: group.sessionTitle }))) return
                void run(todo.id, () => window.pilot.sendTodo(group.sessionId, todo.id), t('已发送'))
              }}
            >
              {busy ? <i className="spinner tiny" /> : <SendIcon width={12} height={12} />}
            </button>
            <button
              type="button"
              className="todo-action danger"
              title={t('删除待办')}
              disabled={busy}
              onClick={() => {
                if (!window.confirm(t('删除这条待办？'))) return
                void run(todo.id, () => window.pilot.removeTodo(group.sessionId, todo.id))
              }}
            >
              <TrashIcon width={12} height={12} />
            </button>
          </>
        )}
      </div>
    )
  }

  const visibleGroups = (groups ?? [])
    .map((group) => {
      const pending = sortTodos(group.todos.filter((todo) => todo.status === 'pending'))
      const sent = group.todos.filter((todo) => todo.status === 'sent')
      return { ...group, pending, sent }
    })
    .filter((group) => group.pending.length > 0 || (showSent && group.sent.length > 0))

  return (
    <div className="page panel-page all-todos-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <TodoIcon width={13} height={13} />
            {t('待办')}
          </div>
          <h1>{t('全部待办')}</h1>
          <p>
            {groups === null
              ? t('读取中…')
              : t('{v1} 项待发送 · 分布在 {v2} 个会话', { v1: totals.pending, v2: totals.sessions })}
          </p>
        </div>
        <div className="all-todos-actions">
          {totals.sent > 0 ? (
            <label className="all-todos-toggle">
              <input
                type="checkbox"
                checked={showSent}
                onChange={(event) => setShowSent(event.target.checked)}
              />
              {t('显示已发送 {v1} 项', { v1: totals.sent })}
            </label>
          ) : null}
          <button type="button" className="icon-button" title={t('刷新')} onClick={load}>
            <RefreshIcon width={15} height={15} />
          </button>
        </div>
      </div>

      <div className="all-todos-body">
        {groups === null ? (
          <div className="all-todos-empty">
            <i className="spinner" />
            {t('正在汇总所有会话的待办…')}
          </div>
        ) : visibleGroups.length === 0 ? (
          <div className="all-todos-empty">
            <TodoIcon width={26} height={26} />
            <strong>{t('没有待办')}</strong>
            <span>{t('在输入框顶部的待办面板里记一条，或选中正文后加入待办。')}</span>
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
                  {t('{v1} 项待发送', { v1: group.pending.length })}
                  {group.sent.length > 0 ? t(' · {v1} 项已发送', { v1: group.sent.length }) : ''}
                  {` · ${formatRelative(group.sessionUpdatedAt) || t('刚刚')}`}
                </span>
              </header>
              <div className="all-todos-list">
                {group.pending.map((todo) => renderTodo(group, todo))}
                {showSent ? group.sent.map((todo) => renderTodo(group, todo)) : null}
              </div>
            </article>
          ))
        )}
      </div>

      <footer className="all-todos-foot">
        {t('这里是所有会话的待办汇总；发送会把该条待办排进对应会话的队列。')}
      </footer>
    </div>
  )
}
