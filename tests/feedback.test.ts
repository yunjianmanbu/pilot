import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_TITLE_MAX,
  FeedbackInputError,
  formatFeedback,
  formatLocalTime,
  isFeedbackKind,
  normalizeFeedback,
} from '../src/shared/feedback'
import { FeedbackBox } from '../src/main/feedback'

const context = { version: '0.1.40', platform: 'win32 10.0.26100', locale: 'zh-CN' as const }

describe('normalizeFeedback', () => {
  it('trims every field and keeps the chosen kind', () => {
    expect(
      normalizeFeedback({ kind: 'feature', title: '  批量删除  ', body: ' 想一次删多条 ', contact: '' }),
    ).toEqual({ kind: 'feature', title: '批量删除', body: '想一次删多条', contact: '' })
  })

  it('accepts all three kinds', () => {
    expect(isFeedbackKind('bug')).toBe(true)
    expect(isFeedbackKind('feature')).toBe(true)
    expect(isFeedbackKind('suggestion')).toBe(true)
    expect(isFeedbackKind('praise')).toBe(false)
  })

  it('reports which check failed instead of a bare string', () => {
    const problem = (input: unknown): string => {
      try {
        normalizeFeedback(input)
      } catch (error) {
        return error instanceof FeedbackInputError ? error.problem : 'wrong-error'
      }
      return 'no-throw'
    }
    expect(problem({ kind: 'praise', title: 'x', body: 'y' })).toBe('kind')
    expect(problem({ kind: 'bug', title: '   ', body: 'y' })).toBe('title')
    expect(problem({ kind: 'bug', title: 'x'.repeat(FEEDBACK_TITLE_MAX + 1), body: 'y' })).toBe(
      'titleTooLong',
    )
    expect(problem({ kind: 'bug', title: 'x', body: '' })).toBe('body')
    expect(problem({ kind: 'bug', title: 'x', body: 'y'.repeat(FEEDBACK_BODY_MAX + 1) })).toBe(
      'bodyTooLong',
    )
    expect(problem(null)).toBe('kind')
  })
})

describe('formatFeedback', () => {
  it('formats the timestamp as local time', () => {
    const stamp = new Date(2026, 10, 14, 2, 5).toISOString()
    expect(formatLocalTime(stamp)).toBe('2026-11-14 02:05')
    expect(formatLocalTime('not a date')).toBe('not a date')
  })

  it('renders kind, body and environment as plain text', () => {
    const text = formatFeedback({
      kind: 'suggestion',
      title: '希望排队任务能拖动排序',
      body: '现在只能用按钮上下移动。',
      contact: 'me@example.com',
      id: 'abc12345-0000',
      createdAt: '2026-11-14T02:00:00.000Z',
      context,
    })
    expect(text).toContain('【提建议】希望排队任务能拖动排序')
    expect(text).toContain('现在只能用按钮上下移动。')
    expect(text).toContain('联系方式：me@example.com')
    expect(text).toContain('版本：Pilot 0.1.40 · win32 10.0.26100 · zh-CN')
    expect(text).toContain('编号：abc12345-0000')
  })

  it('leaves the contact section out when nothing was given', () => {
    const text = formatFeedback({
      kind: 'bug',
      title: '崩溃',
      body: '打开设置就闪退',
      contact: '',
      id: 'id',
      createdAt: '2026-11-14T02:00:00.000Z',
      context,
    })
    expect(text).not.toContain('联系方式')
  })
})

describe('FeedbackBox', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pilot-feedback-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes one JSON file per report and lists the newest first', async () => {
    const box = new FeedbackBox(dir)
    const first = await box.submit({ kind: 'bug', title: '第一条', body: 'a', contact: '' }, context)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await box.submit(
      { kind: 'feature', title: '第二条', body: 'b', contact: '' },
      context,
    )
    expect(first.id).not.toBe(second.id)

    const files = await box.list()
    expect(files).toHaveLength(2)
    const newest = JSON.parse(await readFile(files[0] as string, 'utf8'))
    expect(newest.title).toBe('第二条')
    expect(newest.context).toEqual(context)
  })

  it('rejects an empty report before touching the disk', async () => {
    const box = new FeedbackBox(dir)
    await expect(box.submit({ kind: 'bug', title: '', body: '', contact: '' }, context)).rejects.toThrow(
      '请填写一句话概括',
    )
    await expect(box.list()).resolves.toEqual([])
  })
})
