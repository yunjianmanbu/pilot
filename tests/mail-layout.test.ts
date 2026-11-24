/**
 * 邮件版式：反思报告与事件通知共用一套骨架。
 *
 * 守四件事：
 * 1) 所有用户可控文本都转义，标题里带 `<` 不会破坏结构；
 * 2) 状态色、键值行、发现块都出现在 HTML 里（版式统一靠这些元素）；
 * 3) 深色适配只是 `<style>` 增强，剥掉仍是可读的浅色内联样式；
 * 4) 中英文都用同一份骨架，只有文案不同。
 */
import { describe, expect, it } from 'vitest'
import { escapeHtml, renderMailHtml } from '../src/main/reflect/mail-layout'

describe('escapeHtml', () => {
  it('escapes the five characters that break markup', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })
})

describe('renderMailHtml', () => {
  const html = renderMailHtml({
    title: '任务完成',
    eyebrow: '事件通知',
    badge: { text: '任务完成', tone: 'success' },
    at: '2026-11-24 21:30',
    rows: [
      { label: '会话', value: '构建任务' },
      { label: '状态', value: 'completed' },
    ],
    paragraphs: ['整轮运行没有报错。'],
    blocks: [{ tone: 'warning', heading: '1. [高] 效率', lines: ['现象: 步骤偏多'] }],
    footnote: '打开 Pilot 可以看到完整过程。',
  })

  it('renders a complete standalone document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html.trim().endsWith('</html>')).toBe(true)
  })

  it('carries the badge, rows, paragraphs and finding blocks', () => {
    expect(html).toContain('任务完成')
    expect(html).toContain('会话')
    expect(html).toContain('构建任务')
    expect(html).toContain('整轮运行没有报错。')
    expect(html).toContain('现象: 步骤偏多')
    expect(html).toContain('打开 Pilot 可以看到完整过程。')
  })

  it('uses the same inline typography on every text node', () => {
    expect(html).toContain('font-family:-apple-system')
    expect(html).toContain('max-width:600px')
    expect(html).toContain('border-radius:14px')
  })

  it('keeps dark-mode rules in a style block so stripping them still works', () => {
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('style="margin:0;padding:0;background:#f3f4f6;"')
  })

  it('escapes untrusted text instead of emitting it as markup', () => {
    const risky = renderMailHtml({
      title: '<script>alert(1)</script>',
      rows: [{ label: '<b>x</b>', value: '"quoted"' }],
      footnote: 'ok',
    })
    expect(risky).not.toContain('<script>')
    expect(risky).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(risky).toContain('&quot;quoted&quot;')
  })

  it('skips empty rows so a missing field never shows a blank line', () => {
    const withEmpty = renderMailHtml({
      title: 't',
      rows: [
        { label: '空的', value: '  ' },
        { label: '有值', value: 'x' },
      ],
      footnote: 'f',
    })
    expect(withEmpty).not.toContain('空的')
    expect(withEmpty).toContain('有值')
  })

  it('localizes the footer line from the english flag', () => {
    expect(renderMailHtml({ title: 't', footnote: 'f', english: true })).toContain(
      'Sent by Pilot',
    )
    expect(renderMailHtml({ title: 't', footnote: 'f' })).toContain('由 Pilot 发送')
  })
})
