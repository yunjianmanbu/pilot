import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ReasoningBlock,
  reasoningSummary,
  reasoningTail,
} from '../src/renderer/src/components/ReasoningBlock'

/**
 * 思考块的两条体验约定，本文件就是它们的断言对象：
 * 1. 默认收拢——正在写的那一步也不自己展开，思考不抢正文的位置；
 * 2. 标题行只在收拢时给一行预览，展开后正文就在下面，标题行不再重复内容。
 */
const summaryOf = (html: string) =>
  html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'))

describe('reasoningTail', () => {
  it('takes the newest line instead of the first one', () => {
    expect(reasoningTail('先看目录\n再读文件')).toBe('再读文件')
    expect(reasoningTail('  第一行  \n\n\t第二行  ')).toBe('第二行')
  })

  it('returns an empty string for blank thinking', () => {
    expect(reasoningTail('   \n\n')).toBe('')
  })

  it('clips a long newest line', () => {
    expect(reasoningTail('甲'.repeat(120), 5)).toBe('甲甲甲甲甲…')
  })
})

describe('reasoningSummary', () => {
  it('previews the newest line while live and the first line afterwards', () => {
    expect(reasoningSummary('先看目录\n然后跑测试', { live: true })).toBe('然后跑测试')
    expect(reasoningSummary('先看目录\n然后跑测试', { live: false })).toBe('先看目录')
  })

  it('drops the preview once the block is expanded', () => {
    // 展开后正文就在下面：标题行再重复首行 (或最新一行) 只是噪音。
    expect(reasoningSummary('先看目录\n然后跑测试', { live: true, open: true })).toBe('')
    expect(reasoningSummary('先看目录\n然后跑测试', { open: true })).toBe('')
  })
})

describe('ReasoningBlock folded by default', () => {
  it('stays folded while the step is still being written', () => {
    const html = renderToStaticMarkup(<ReasoningBlock text={'第一行\n第二行'} live />)
    expect(html).not.toContain('open=""')
    // 收拢也看得出进度：标题行贴的是最新一行，不是第一行。
    const summary = summaryOf(html)
    expect(summary).toContain('第二行')
    expect(summary).not.toContain('第一行')
  })

  it('stays folded for a finished step', () => {
    const html = renderToStaticMarkup(<ReasoningBlock text={'第一行\n第二行'} />)
    expect(html).not.toContain('open=""')
    expect(summaryOf(html)).toContain('第一行')
  })

  it('marks the live block with its own indicator', () => {
    const live = renderToStaticMarkup(<ReasoningBlock text="思考中" live />)
    const settled = renderToStaticMarkup(<ReasoningBlock text="思考中" />)
    expect(live).toContain('reasoning-live')
    expect(settled).not.toContain('reasoning-live')
  })
})
