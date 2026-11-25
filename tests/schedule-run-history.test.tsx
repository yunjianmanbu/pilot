import { describe, expect, it } from 'vitest'
import { runTimeline, trailingFailures } from '../src/renderer/src/components/AllScheduledPanel'
import { setLocale } from '../src/renderer/src/i18n'
import { sanitizeScheduledTask } from '../src/main/store-schema'
import type { ScheduledTask } from '../src/shared/types'

setLocale('zh-CN')

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    content: '巡检部署状态',
    kind: 'interval',
    intervalMinutes: 30,
    nextRunAt: '2026-03-01T10:00:00.000Z',
    enabled: true,
    createdAt: '2026-03-01T08:00:00.000Z',
    ...overrides,
  }
}

describe('trailingFailures', () => {
  it('counts only the unbroken run of failures at the head', () => {
    expect(trailingFailures(task())).toBe(0)
    expect(
      trailingFailures(
        task({
          runs: [
            { at: '2026-03-01T09:00:00.000Z', status: 'failed' },
            { at: '2026-03-01T08:30:00.000Z', status: 'failed' },
            { at: '2026-03-01T08:00:00.000Z', status: 'queued' },
            { at: '2026-03-01T07:30:00.000Z', status: 'failed' },
          ],
        }),
      ),
    ).toBe(2)
  })

  it('stops counting at the newest success', () => {
    expect(
      trailingFailures(
        task({
          runs: [
            { at: '2026-03-01T09:00:00.000Z', status: 'queued' },
            { at: '2026-03-01T08:30:00.000Z', status: 'failed' },
          ],
        }),
      ),
    ).toBe(0)
  })
})

describe('runTimeline', () => {
  it('renders at most the four newest runs, newest first', () => {
    const runs = Array.from({ length: 6 }, (_, index) => ({
      at: `2026-03-01T0${9 - index}:00:00.000Z`,
      status: (index === 1 ? 'failed' : 'queued') as 'queued' | 'failed',
    }))
    const lines = runTimeline(task({ runs }))
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('已触发')
    expect(lines[1]).toContain('失败')
  })

  it('is empty for a task that never fired', () => {
    expect(runTimeline(task())).toEqual([])
  })
})

describe('sanitizeScheduledTask run history', () => {
  it('drops malformed entries and caps the list', () => {
    const raw = {
      id: 'task-1',
      sessionId: 'session-1',
      content: '巡检部署状态',
      kind: 'interval',
      intervalMinutes: 30,
      nextRunAt: '2026-03-01T10:00:00.000Z',
      enabled: true,
      createdAt: '2026-03-01T08:00:00.000Z',
      runs: [
        { at: '2026-03-01T09:00:00.000Z', status: 'queued' },
        { at: 'not-a-date', status: 'queued' },
        { at: '2026-03-01T08:30:00.000Z', status: 'cancelled' },
        { status: 'failed' },
        // 12 条合法记录，用来验证上限而不是「全部照收」。
        ...Array.from({ length: 12 }, (_, index) => ({
          at: `2026-02-28T0${index % 10}:00:00.000Z`,
          status: 'failed',
          detail: 'x'.repeat(500),
        })),
      ],
    }

    const clean = sanitizeScheduledTask(raw)!
    expect(clean.runs).toBeDefined()
    expect(clean.runs!.length).toBeLessThanOrEqual(10)
    expect(clean.runs![0]!.at).toBe('2026-03-01T09:00:00.000Z')
    // 非法状态、非法时间、缺字段的条目一条都不该留下来。
    expect(clean.runs!.some((run) => run.at === 'not-a-date')).toBe(false)
    expect(clean.runs!.every((run) => run.status === 'queued' || run.status === 'failed')).toBe(true)
    // detail 也要有长度上限：失败原因可能是一整段堆栈。
    expect(clean.runs!.every((run) => (run.detail ?? '').length <= 400)).toBe(true)
  })

  it('omits the field entirely when there is no usable history', () => {
    const clean = sanitizeScheduledTask({
      id: 'task-1',
      sessionId: 'session-1',
      content: '巡检部署状态',
      kind: 'once',
      nextRunAt: '2026-03-01T10:00:00.000Z',
      runs: [{ at: 'not-a-date', status: 'queued' }],
    })!
    expect(clean.runs).toBeUndefined()
  })
})
