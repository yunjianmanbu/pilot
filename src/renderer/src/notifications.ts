/**
 * 通知中心的数据层。
 *
 * 会话里的提示以 toast 的形式出现 4.5 秒就消失，用户离开座位就永远看不到了。
 * 这里把它们留成一份有上限的历史：顶栏铃铛的未读数、面板里的列表都只读这份数组，
 * 归约逻辑做成纯函数，渲染层不自己算未读，测试也不用起 React。
 */

export type NoticeLevel = 'info' | 'warn' | 'error'

/**
 * 通知来源。只用于面板上的标签，不参与任何业务判断：同一条提示无论来自
 * 审批、定时任务还是更新提醒，行为完全一致。
 */
export type NoticeSource = 'app' | 'session' | 'notice' | 'approval' | 'update' | 'quality'

export interface NoticeEntry {
  /** 与 toast 共用同一个自增 id，方便对账「屏幕上那条」与「列表里这条」。 */
  id: number
  message: string
  level: NoticeLevel
  /** 毫秒时间戳：面板按它倒序，重开 App 前后都能正常排序。 */
  at: number
  source: NoticeSource
  read: boolean
}

/**
 * 历史上限。通知是「最近发生了什么」的旁路记录，不是日志：
 * 超过这个数只淘汰最旧的，避免长时间运行把内存拖成无界数组。
 */
export const NOTICE_LIMIT = 200

/** 新通知放最前面；超出上限时丢最旧的。 */
export function pushNotice(list: NoticeEntry[], entry: NoticeEntry): NoticeEntry[] {
  const next = [entry, ...list]
  return next.length > NOTICE_LIMIT ? next.slice(0, NOTICE_LIMIT) : next
}

export function unreadCount(list: NoticeEntry[]): number {
  return list.reduce((total, entry) => (entry.read ? total : total + 1), 0)
}

export function markAllRead(list: NoticeEntry[]): NoticeEntry[] {
  return list.some((entry) => !entry.read)
    ? list.map((entry) => (entry.read ? entry : { ...entry, read: true }))
    : list
}

/**
 * 面板里的时间：今天只给时分，跨天补上日期。完整时间在 title 里，
 * 面板宽度有限，塞进秒和年份只会把文案挤没。
 */
export function noticeClock(at: number, now: number = Date.now()): string {
  const when = new Date(at)
  const today = new Date(now)
  const hh = String(when.getHours()).padStart(2, '0')
  const mm = String(when.getMinutes()).padStart(2, '0')
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()
  if (sameDay) return `${hh}:${mm}`
  const month = String(when.getMonth() + 1).padStart(2, '0')
  const day = String(when.getDate()).padStart(2, '0')
  return `${month}-${day} ${hh}:${mm}`
}

/** 悬浮提示里的完整时间戳，用本地时区，和面板里的时间口径一致。 */
export function noticeStamp(at: number): string {
  const when = new Date(at)
  const date = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(
    when.getDate(),
  ).padStart(2, '0')}`
  const hh = String(when.getHours()).padStart(2, '0')
  const mm = String(when.getMinutes()).padStart(2, '0')
  return `${date} ${hh}:${mm}`
}
