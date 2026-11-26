import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReasoningBlock, reasoningPeek } from '../src/renderer/src/components/ReasoningBlock'

/**
 * 思考在执行过程框里只占一行，点开是弹框。本文件断言的是这一行的三件事：
 * 1. 预览取第一行（不是最新一行，否则标题每来一个 token 就重排，页面跟着跳）；
 * 2. 行本身是按钮，整行可点，点开的是弹框不是就地展开；
 * 3. 还在书写的那一步带自己的跳点，结束后不再带。
 */
const rowOf = (html: string) => {
  const start = html.indexOf('<button')
  if (start < 0) return html
  return html.slice(start, html.indexOf('</button>', start))
}

describe('reasoningPeek', () => {
  it('takes the first non-empty line, whitespace flattened', () => {
    expect(reasoningPeek('\n\n  先看目录  \n再读文件')).toBe('先看目录')
    expect(reasoningPeek('第一行\t有   空白\n第二行')).toBe('第一行 有 空白')
  })

  it('returns an empty string for blank thinking', () => {
    expect(reasoningPeek('   \n\n')).toBe('')
  })

  it('clips a long line', () => {
    expect(reasoningPeek('甲'.repeat(120))).toBe(`${'甲'.repeat(80)}…`)
    expect(reasoningPeek('甲'.repeat(120), 5)).toBe('甲甲甲甲甲…')
  })
})

describe('ReasoningBlock folded row', () => {
  it('previews the first line, never the newest one', () => {
    const html = renderToStaticMarkup(<ReasoningBlock text={'第一行\n第二行'} live />)
    const row = rowOf(html)
    expect(row).toContain('reasoning-peek')
    expect(row).toContain('第一行')
    expect(row).not.toContain('第二行')
  })

  it('carries a semantic glyph so the row is recognisable at a glance', () => {
    const html = renderToStaticMarkup(<ReasoningBlock text="随便想想" />)
    expect(html).toContain('step-glyph')
    expect(html).toContain('<svg')
  })

  it('is a button when it opens a dialog, a plain line otherwise', () => {
    const clickable = renderToStaticMarkup(<ReasoningBlock text="思考中" onOpen={() => {}} />)
    expect(clickable).toContain('<button')
    expect(clickable).not.toContain('<details')
    expect(clickable).not.toContain('<summary')

    const plain = renderToStaticMarkup(<ReasoningBlock text="思考中" />)
    expect(plain).not.toContain('<button')
    expect(plain).toContain('reasoning-block')
  })

  it('marks the live block with its own indicator', () => {
    const live = renderToStaticMarkup(<ReasoningBlock text="思考中" live />)
    const settled = renderToStaticMarkup(<ReasoningBlock text="思考中" />)
    expect(live).toContain('reasoning-live')
    expect(settled).not.toContain('reasoning-live')
  })
})
