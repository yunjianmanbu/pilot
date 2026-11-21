import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { SelectionTodoMenu } from '../src/renderer/src/components/SelectionTodoMenu'
import {
  clampMenuPosition,
  MAX_SELECTION_TODO_CHARS,
  normalizeSelectionText,
} from '../src/renderer/src/selection'

// The assertions pin the Chinese source copy; navigator.language is en-US on
// the Linux CI runner, so pin the effective locale before rendering.
setLocale('zh-CN')

describe('normalizeSelectionText', () => {
  it('collapses wrapped lines and indentation into one line', () => {
    expect(normalizeSelectionText('  第一行\n\n  第二行\t缩进  ')).toBe('第一行 第二行 缩进')
  })

  it('keeps inline code and paths readable', () => {
    expect(normalizeSelectionText('跑 `node pilot/scripts/verify-release.mjs`')).toBe(
      '跑 `node pilot/scripts/verify-release.mjs`',
    )
  })

  it('returns an empty string for a whitespace-only selection', () => {
    expect(normalizeSelectionText('\n \t\r\n')).toBe('')
  })

  it('caps very long selections without adding an ellipsis', () => {
    const text = normalizeSelectionText('字'.repeat(MAX_SELECTION_TODO_CHARS + 500))
    expect(text).toHaveLength(MAX_SELECTION_TODO_CHARS)
    expect(text.endsWith('…')).toBe(false)
  })
})

describe('clampMenuPosition', () => {
  const viewport = { width: 1000, height: 700 }
  const menu = { width: 200, height: 90 }

  it('keeps a menu that fits exactly where the pointer is', () => {
    expect(clampMenuPosition({ x: 300, y: 200 }, menu, viewport)).toEqual({ x: 300, y: 200 })
  })

  it('flips above the anchor when there is no room below', () => {
    expect(clampMenuPosition({ x: 300, y: 680 }, menu, viewport)).toEqual({ x: 300, y: 578 })
  })

  it('stays inside the viewport at both edges', () => {
    expect(clampMenuPosition({ x: -20, y: -40 }, menu, viewport)).toEqual({ x: 8, y: 8 })
    expect(clampMenuPosition({ x: 2000, y: 2000 }, menu, viewport)).toEqual({ x: 792, y: 602 })
  })

  it('does not flip above when the flipped position is also off-screen', () => {
    const short = { width: 300, height: 260 }
    expect(clampMenuPosition({ x: 10, y: 30 }, short, viewport)).toEqual({ x: 10, y: 30 })
  })
})

describe('SelectionTodoMenu', () => {
  const noop = () => undefined

  it('offers adding the selection as a todo and copying it', () => {
    const html = renderToStaticMarkup(
      <SelectionTodoMenu state={{ x: 40, y: 60, text: '这段要跟进' }} onAddTodo={noop} onClose={noop} />,
    )
    expect(html).toContain('role="menu"')
    expect(html).toContain('添加待办')
    expect(html).toContain('复制')
    expect(html).toContain('这段要跟进')
  })

  it('shortens a long selection in the preview but keeps the full text in the title', () => {
    const text = '长'.repeat(200)
    const html = renderToStaticMarkup(
      <SelectionTodoMenu state={{ x: 0, y: 0, text }} onAddTodo={noop} onClose={noop} />,
    )
    expect(html).toContain(`title="${text}"`)
    expect(html).toContain('…')
  })
})