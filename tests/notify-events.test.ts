import { describe, expect, it } from 'vitest'
import { defaults } from '../src/main/store-schema'
import {
  DEFAULT_NOTIFY_EMAIL_EVENTS,
  NOTIFY_EVENT_IDS,
  NOTIFY_EVENTS,
  normalizeNotifyEmailEvents,
  notifyEventHint,
  notifyEventLabel,
  withNotifyEvent,
} from '../src/shared/notify-events'

describe('邮件通知事件目录', () => {
  it('顺序就是推荐优先级：priority 从 1 起严格递增且与数组顺序一致', () => {
    expect(NOTIFY_EVENTS.length).toBeGreaterThanOrEqual(8)
    NOTIFY_EVENTS.forEach((entry, index) => {
      expect(entry.priority).toBe(index + 1)
    })
    expect(new Set(NOTIFY_EVENT_IDS).size).toBe(NOTIFY_EVENTS.length)
  })

  it('每个事件都有中英文名与提示，格式化后不残留占位符', () => {
    for (const entry of NOTIFY_EVENTS) {
      expect(entry.zh.length).toBeGreaterThan(0)
      expect(entry.en.length).toBeGreaterThan(0)
      expect(entry.zhHint.length).toBeGreaterThan(0)
      expect(entry.enHint.length).toBeGreaterThan(0)
      expect(entry.en).not.toMatch(/[\u4e00-\u9fff]/)
      expect(entry.enHint).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('出厂默认只勾选 defaultOn 的事件，并且仍然有序', () => {
    expect(DEFAULT_NOTIFY_EMAIL_EVENTS).toEqual(
      NOTIFY_EVENTS.filter((entry) => entry.defaultOn).map((entry) => entry.id),
    )
    // 最需要当场知道的几条默认打开，纯告知类的默认关闭。
    expect(DEFAULT_NOTIFY_EMAIL_EVENTS).toContain('run.failed')
    expect(DEFAULT_NOTIFY_EMAIL_EVENTS).toContain('approval.required')
    expect(DEFAULT_NOTIFY_EMAIL_EVENTS).not.toContain('schedule.started')
    expect(DEFAULT_NOTIFY_EMAIL_EVENTS).not.toContain('quality.better')
  })

  it('归一化丢掉未知 id 与重复项，并按推荐优先级排序', () => {
    const shuffled = ['quality.better', 'run.failed', 'run.failed', 'nope', 'reflect.report']
    expect(normalizeNotifyEmailEvents(shuffled)).toEqual([
      'run.failed',
      'reflect.report',
      'quality.better',
    ])
    expect(normalizeNotifyEmailEvents(undefined)).toEqual([])
    expect(normalizeNotifyEmailEvents('run.failed')).toEqual([])
    expect(normalizeNotifyEmailEvents([42, null, {}])).toEqual([])
  })

  it('打开与关闭单个事件后结果依然有序，且不修改入参', () => {
    const base = ['run.failed', 'reflect.report'] as const
    expect(withNotifyEvent(base, 'quality.better', true)).toEqual([
      'run.failed',
      'reflect.report',
      'quality.better',
    ])
    expect(withNotifyEvent(base, 'run.failed', false)).toEqual(['reflect.report'])
    expect(base).toEqual(['run.failed', 'reflect.report'])
    // 幂等：重复打开/关闭不产生重复项。
    expect(withNotifyEvent(base, 'run.failed', true)).toEqual([...base])
    expect(withNotifyEvent(base, 'update.ready', false)).toEqual([...base])
  })

  it('标签与提示按语言切换，未知 id 退化为 id 本身', () => {
    expect(notifyEventLabel('run.failed', false)).toBe('运行失败')
    expect(notifyEventLabel('run.failed', true)).toBe('Run failed')
    expect(notifyEventHint('run.failed', true)).toMatch(/errors out/)
    expect(notifyEventLabel('nope' as never, false)).toBe('nope')
    expect(notifyEventHint('nope' as never, true)).toBe('')
  })
})

describe('通知配置的出厂状态', () => {
  it('总开关默认关着，事件清单已按优先级预勾选，打开即可生效', () => {
    const settings = defaults().settings
    expect(settings.notifyEmailEnabled).toBe(false)
    expect(settings.notifyEmailEvents).toEqual(DEFAULT_NOTIFY_EMAIL_EVENTS)
    expect(normalizeNotifyEmailEvents(settings.notifyEmailEvents)).toEqual(settings.notifyEmailEvents)
  })

  it('出厂不预置任何邮箱地址或 SMTP 主机', () => {
    const settings = defaults().settings
    expect(settings.reflectEmailTo).toBe('')
    expect(settings.reflectSmtpHost).toBe('')
  })
})
