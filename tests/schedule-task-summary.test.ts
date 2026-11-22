import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { summarizeTool, type ToolView } from '../src/renderer/src/ui'

// These assertions pin the Chinese source copy; the effective locale depends
// on navigator.language, which is en-US on the Linux CI runner.
setLocale('zh-CN')

function view(args: Record<string, unknown>): ToolView {
  return {
    id: 'call-1',
    name: 'schedule_task',
    args,
    risk: 'control',
    status: 'ok',
  }
}

describe('schedule_task tool card summary', () => {
  it('shows a one-off delay and the content', () => {
    expect(summarizeTool(view({ action: 'add', content: '整理待办', delayMinutes: 20 }))).toBe(
      '定时任务 · 20 分钟后 · 整理待办',
    )
  })

  it('shows interval and daily schedules', () => {
    expect(
      summarizeTool(
        view({ action: 'add', kind: 'interval', intervalMinutes: 90, content: '同步进度' }),
      ),
    ).toBe('定时任务 · 每 90 分钟 · 同步进度')
    expect(
      summarizeTool(view({ action: 'add', kind: 'daily', timeOfDay: '09:00', content: '写晨报' })),
    ).toBe('定时任务 · 每天 09:00 · 写晨报')
  })

  it('falls back to the task id and drops the prefix for other actions', () => {
    expect(summarizeTool(view({ action: 'list' }))).toBe('')
    expect(summarizeTool(view({ action: 'remove', taskId: '3f2a1b9c' }))).toBe('3f2a1b9c')
  })
})
