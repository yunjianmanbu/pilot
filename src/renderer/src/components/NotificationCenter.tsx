import { useEffect, useRef, type ReactElement } from 'react'
import { t } from '../i18n'
import { BellIcon, CheckIcon, InfoIcon, XIcon } from '../icons'
import {
  noticeClock,
  noticeStamp,
  unreadCount,
  type NoticeEntry,
  type NoticeSource,
} from '../notifications'

/**
 * 来源标签。写成字面量 t() 调用而不是查表：英文词典的覆盖测试只认字面量，
 * 用 `t(TABLE[source])` 这类变量形式会把这几条文案漏出检查之外。
 */
function sourceLabel(source: NoticeSource): string {
  switch (source) {
    case 'session':
      return t('会话')
    case 'notice':
      return t('后台任务')
    case 'approval':
      return t('审批')
    case 'update':
      return t('更新')
    case 'quality':
      return t('产出质量')
    case 'app':
    default:
      return t('应用')
  }
}

export interface NotificationCenterProps {
  open: boolean
  notices: NoticeEntry[]
  /** 正在等用户决定的工具调用条数；它们的审批卡在会话里，这里只做汇总提醒。 */
  pendingApprovals: number
  onOpenChange: (open: boolean) => void
  onMarkAllRead: () => void
  onClear: () => void
}

/**
 * 顶栏的小铃铛 = 通知中心，只回答「刚才发生过什么」。
 *
 * 以前这个位置只服务产出质量闸门，会话里那些「已复制」「配对请求已失效」
 * 之类的提示飘过去就没了。现在它同时是会话内所有弹框提醒的历史与待审批
 * 工具调用的汇总。
 *
 * 产出质量的裁决面板不在这里：它由顶栏「三个点」菜单打开（`QualityDialog`）。
 * 通知是「已经发生的事实」，裁决是「要不要接受这份产出」，两者混在一个弹层里
 * 会让人把裁决当成又一条可以划走的提醒。
 */
export function NotificationCenter({
  open,
  notices,
  pendingApprovals,
  onOpenChange,
  onMarkAllRead,
  onClear,
}: NotificationCenterProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  const unread = unreadCount(notices)
  /** 角标只数「还没看过的提醒 + 正在等你的审批」。质量候选另有自己的菜单项角标。 */
  const badge = unread + pendingApprovals

  return (
    <div className="quality-bell notice-center" ref={rootRef}>
      <button
        type="button"
        className={`topbar-icon quality-bell-button${badge > 0 ? ' alert' : ''}`}
        onClick={() => onOpenChange(!open)}
        title={
          badge > 0
            ? t('{v1} 条未读通知', { v1: badge })
            : pendingApprovals > 0
              ? t('{v1} 个工具调用等待审批', { v1: pendingApprovals })
              : t('通知与提醒')
        }
        aria-label={t('通知与提醒')}
        aria-expanded={open}
      >
        <BellIcon width={16} height={16} />
        {badge > 0 ? (
          <span className="quality-bell-badge">{badge > 99 ? '99+' : badge}</span>
        ) : null}
      </button>

      {open ? (
        <div className="quality-pop notice-pop" role="dialog" aria-label={t('通知与提醒')}>
          <header className="quality-pop-head">
            <div>
              <strong>{t('通知')}</strong>
              <span className="quality-pop-sub">
                {unread > 0
                  ? t('{v1} 条未读', { v1: unread })
                  : t('没有未读通知：提醒会留在列表里')}
              </span>
            </div>
            <div className="quality-pop-actions">
              <button
                type="button"
                className="button ghost small"
                onClick={onMarkAllRead}
                disabled={unread === 0}
              >
                <CheckIcon width={13} height={13} />
                {t('全部已读')}
              </button>
              <button
                type="button"
                className="button ghost small"
                onClick={onClear}
                disabled={notices.length === 0}
              >
                <XIcon width={13} height={13} />
                {t('清空')}
              </button>
            </div>
          </header>

          {pendingApprovals > 0 ? (
            <p className="notice-pending">
              <InfoIcon width={14} height={14} />
              {t('{v1} 个工具调用等待你审批，请在会话里处理。', { v1: pendingApprovals })}
            </p>
          ) : null}
          {notices.length === 0 ? (
            <p className="quality-empty">
              {t('还没有通知。会话中的提示、更新与后台任务提醒都会留在这里。')}
            </p>
          ) : (
            <div className="notice-list">
              {notices.map((entry) => (
                <article
                  key={entry.id}
                  className={`notice-item level-${entry.level}${entry.read ? '' : ' is-unread'}`}
                >
                  <header className="notice-item-head">
                    <span className="notice-source">{sourceLabel(entry.source)}</span>
                    <time className="notice-time" title={noticeStamp(entry.at)}>
                      {noticeClock(entry.at)}
                    </time>
                  </header>
                  <p className="notice-text">{entry.message}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
