import { describe, expect, it } from 'vitest'
import { formatLogRecord, formatLogRecords } from '../src/shared/app-log-view'
import type { AppLogView } from '../src/shared/types'

function record(patch: Partial<AppLogView> = {}): AppLogView {
  return {
    at: '2026-01-05T10:00:00.000Z',
    area: 'run',
    event: 'run.settled',
    level: 'info',
    ...patch,
  }
}

describe('日志行的可粘贴格式', () => {
  it('一行一条，带时间、级别、领域与事件', () => {
    expect(formatLogRecord(record())).toBe(
      '2026-01-05T10:00:00.000Z info [run] run.settled',
    )
  })

  it('有细节时附上 JSON，空细节不多留一个空格', () => {
    const withDetail = formatLogRecord(record({ detail: { steps: 7 } }))
    expect(withDetail.endsWith('{"steps":7}')).toBe(true)
    expect(formatLogRecord(record({ detail: {} }))).not.toContain('{}')
  })

  it('多条记录按顺序换行拼接', () => {
    const text = formatLogRecords([
      record({ event: 'run.settled' }),
      record({ area: 'crash', event: 'uncaught-exception', level: 'error' }),
    ])
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain('[crash] uncaught-exception')
  })
})
