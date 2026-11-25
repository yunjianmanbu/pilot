import { describe, expect, it } from 'vitest'
import {
  NOTICE_LIMIT,
  markAllRead,
  noticeClock,
  noticeStamp,
  pushNotice,
  unreadCount,
  type NoticeEntry,
} from '../src/renderer/src/notifications'

/**
 * 通知中心的数据层：顶栏角标和面板列表都读这一份数组。
 * 这里固定三件容易在重构里丢的事：最新的在最前、历史上限、打开过的提醒能标已读。
 */

function entry(id: number, overrides: Partial<NoticeEntry> = {}): NoticeEntry {
  return {
    id,
    message: `提醒 ${id}`,
    level: 'info',
    at: 1_700_000_000_000,
    source: 'app',
    read: false,
    ...overrides,
  }
}

describe('pushNotice', () => {
  it('把新提醒放在最前面，顺序就是面板里的显示顺序', () => {
    const list = pushNotice(pushNotice([], entry(1)), entry(2))
    expect(list.map((item) => item.message)).toEqual(['提醒 2', '提醒 1'])
  })

  it('超过上限时丢最旧的，不无限增长', () => {
    let list: NoticeEntry[] = []
    for (let id = 1; id <= NOTICE_LIMIT + 5; id += 1) list = pushNotice(list, entry(id))
    expect(list).toHaveLength(NOTICE_LIMIT)
    expect(list[0]?.message).toBe(`提醒 ${NOTICE_LIMIT + 5}`)
    expect(list[list.length - 1]?.message).toBe('提醒 6')
  })
})

describe('unreadCount / markAllRead', () => {
  it('只数未读的提醒', () => {
    expect(unreadCount([entry(1), entry(2, { read: true })])).toBe(1)
    expect(unreadCount([])).toBe(0)
  })

  it('标已读后一条未读都不剩，且不改动原数组', () => {
    const before = [entry(1), entry(2, { read: true })]
    const after = markAllRead(before)
    expect(unreadCount(after)).toBe(0)
    expect(before[0]?.read).toBe(false)
  })

  it('全是已读时返回同一个引用，避免多余的渲染', () => {
    const before = [entry(1, { read: true })]
    expect(markAllRead(before)).toBe(before)
  })
})

describe('noticeClock', () => {
  it('当天只给时分，跨天补上日期', () => {
    const now = new Date(2026, 4, 6, 15, 30).getTime()
    expect(noticeClock(new Date(2026, 4, 6, 9, 5).getTime(), now)).toBe('09:05')
    expect(noticeClock(new Date(2026, 3, 28, 23, 59).getTime(), now)).toBe('04-28 23:59')
  })

  it('完整时间戳保留年月日，悬浮提示用', () => {
    expect(noticeStamp(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04')
  })
})
