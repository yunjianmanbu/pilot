import { describe, expect, it } from 'vitest'
import { highlightCode } from '../src/renderer/src/highlight'

/** 把结果折叠成 `kind:text` 便于断言。 */
function shape(code: string, language?: string): string[] | null {
  const tokens = highlightCode(code, language)
  if (!tokens) return null
  return tokens.map((token) => `${token.kind ?? 'plain'}:${token.text}`)
}

describe('highlightCode', () => {
  it('separates keywords, numbers and line comments', () => {
    expect(shape('const x = 1 // done', 'ts')).toEqual([
      'keyword:const',
      'plain: x = ',
      'number:1',
      'plain: ',
      'comment:// done',
    ])
  })

  it('keeps keywords inside strings unmarked', () => {
    // 字符串整体先被吃掉，里面的 const 不该再被当成关键字。
    expect(shape('const s = "const 1"', 'js')).toEqual([
      'keyword:const',
      'plain: s = ',
      'string:"const 1"',
    ])
    expect(shape("const s = 'return // not a comment'", 'js')).toEqual([
      'keyword:const',
      'plain: s = ',
      'string:\'return // not a comment\'',
    ])
  })

  it('marks identifiers that are called as functions', () => {
    expect(shape('readFileSync(p, x)', 'js')).toEqual([
      'function:readFileSync',
      'plain:(p, x)',
    ])
  })

  it('handles python and shell hash comments', () => {
    expect(shape('def f():  # note', 'python')).toEqual([
      'keyword:def',
      'plain: ',
      'function:f',
      'plain:():  ',
      'comment:# note',
    ])
    expect(shape('echo hi # note', 'bash')).toEqual([
      'keyword:echo',
      'plain: hi ',
      'comment:# note',
    ])
  })

  it('does not treat a css hex colour as a comment', () => {
    const tokens = shape('a { color: #fff }', 'css')
    expect(tokens?.some((token) => token.startsWith('comment:'))).toBe(false)
    expect(tokens?.join('')).toBe('plain:a { color: #fff }')
  })

  it('returns null for unknown or missing languages', () => {
    expect(shape('plain text', undefined)).toBeNull()
    expect(shape('plain text', 'makefile')).toBeNull()
    expect(shape('', 'js')).toBeNull()
  })

  it('skips very long blocks instead of slowing the transcript down', () => {
    expect(shape('const x = 1\n'.repeat(2000), 'js')).toBeNull()
  })

  it('keeps the original text intact', () => {
    const source = 'export const a = `tpl ${b}`\n// tail\n'
    expect(
      (highlightCode(source, 'ts') ?? [])
        .map((token) => token.text)
        .join(''),
    ).toBe(source)
  })
})
