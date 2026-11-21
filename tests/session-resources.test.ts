import { describe, expect, it } from 'vitest'
import {
  describeLink,
  excerpt,
  queryPairs,
  RESOURCE_TABS,
} from '../src/renderer/src/session-resources'

// 会话资源抽屉里五类资源共用同一套列表/预览结构，这里钉住的是纯函数的边界：
// 坏 URL 不能抛错、查询参数要能拆成可读的键值、摘录必须是一行。

describe('session resource tabs', () => {
  it('keeps the five categories in the order the panel renders them', () => {
    expect(RESOURCE_TABS).toEqual(['files', 'links', 'tools', 'knowledge', 'artifacts'])
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
