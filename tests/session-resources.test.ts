import { describe, expect, it } from 'vitest'
import type { MemoryEntry } from '../src/shared/types'
import {
  describeLink,
  excerpt,
  queryPairs,
  RESOURCE_TABS,
  sessionMemories,
} from '../src/renderer/src/session-resources'

// 会话资源抽屉里六类资源共用同一套列表/预览结构，这里钉住的是纯函数的边界：
// 坏 URL 不能抛错、查询参数要能拆成可读的键值、摘录必须是一行。

describe('session resource tabs', () => {
  it('keeps the six categories in the order the panel renders them', () => {
    expect(RESOURCE_TABS).toEqual([
      'files',
      'links',
      'tools',
      'knowledge',
      'memory',
      'artifacts',
    ])
  })
})

describe('describeLink', () => {
  it('splits an ordinary https url into scheme, host, path, query and hash', () => {
    const parts = describeLink('https://developer.mozilla.org/en-US/docs/Web/API?q=a#top')
    expect(parts.scheme).toBe('https')
    expect(parts.host).toBe('developer.mozilla.org')
    expect(parts.path).toBe('/en-US/docs/Web/API')
    expect(parts.query).toBe('q=a')
    expect(parts.hash).toBe('top')
  })

  it('keeps a mangled link renderable instead of throwing', () => {
    const parts = describeLink('not a url at all')
    expect(parts.scheme).toBe('')
    expect(parts.host).toBe('')
    expect(parts.path).toBe('not a url at all')
    expect(parts.query).toBe('')
    expect(parts.hash).toBe('')
  })

  it('survives an empty string', () => {
    expect(() => describeLink('')).not.toThrow()
    expect(describeLink('').path).toBe('')
  })

  it('drops the www. prefix so the host column stays short', () => {
    expect(describeLink('https://www.example.com/a').host).toBe('example.com')
  })
})

describe('queryPairs', () => {
  it('turns a query string into decoded key/value pairs', () => {
    expect(queryPairs('a=1&b=hello%20world')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'hello world' },
    ])
  })

  it('accepts the leading question mark describeLink strips', () => {
    expect(queryPairs('?a=1')).toEqual([{ key: 'a', value: '1' }])
  })

  it('returns nothing when there are no parameters', () => {
    expect(queryPairs('')).toEqual([])
  })

  it('shows a bare flag as an empty value rather than dropping it', () => {
    expect(queryPairs('flag')).toEqual([{ key: 'flag', value: '' }])
  })

  it('turns a plus into a space, as form encoding means it', () => {
    expect(queryPairs('q=a+b')).toEqual([{ key: 'q', value: 'a b' }])
  })

  it('does not throw on broken percent-encoding', () => {
    expect(() => queryPairs('a=%E0%A4%A')).not.toThrow()
  })
})

describe('excerpt', () => {
  it('collapses newlines and repeated spaces into one line', () => {
    expect(excerpt('第一行\n\n第二行   结尾')).toBe('第一行 第二行 结尾')
  })

  it('truncates at the limit and marks the cut', () => {
    const text = 'a'.repeat(200)
    const line = excerpt(text, 20)
    expect(line.length).toBe(21)
    expect(line.endsWith('…')).toBe(true)
  })

  it('leaves a short line untouched', () => {
    expect(excerpt('  短句  ')).toBe('短句')
  })
})

function memory(id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    content: `记忆 ${id}`,
    source: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

describe('sessionMemories', () => {
  it('returns nothing without a session', () => {
    expect(sessionMemories([memory('a')], null)).toEqual([])
  })

  it('lists what the prompt carried in the recorded order', () => {
    const rows = sessionMemories([memory('a'), memory('b')], { id: 's1', memoryIds: ['b', 'a'] })
    expect(rows.map((row) => row.entry.id)).toEqual(['b', 'a'])
    expect(rows.every((row) => row.injected)).toBe(true)
  })

  it('drops ids the workspace store no longer holds', () => {
    const rows = sessionMemories([memory('a')], { id: 's1', memoryIds: ['gone', 'a'] })
    expect(rows.map((row) => row.entry.id)).toEqual(['a'])
  })

  it('appends what this session wrote but never re-read, newest first', () => {
    const rows = sessionMemories(
      [
        memory('a'),
        memory('old', { sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }),
        memory('new', { sessionId: 's1', createdAt: '2026-02-01T00:00:00.000Z' }),
        memory('other', { sessionId: 's2' }),
      ],
      { id: 's1', memoryIds: ['a'] },
    )
    expect(rows.map((row) => row.entry.id)).toEqual(['a', 'new', 'old'])
    expect(rows[0]?.written).toBe(false)
    expect(rows[1]?.injected).toBe(false)
  })

  it('counts an entry once even when it was written and injected', () => {
    const rows = sessionMemories([memory('a', { sessionId: 's1' })], {
      id: 's1',
      memoryIds: ['a'],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ injected: true, written: true })
  })
})
