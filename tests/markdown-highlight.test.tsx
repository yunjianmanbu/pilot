import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/renderer/src/components/Markdown'

/**
 * 端到端地盯着围栏代码块这一条链路：react-markdown 把语言写在内层 <code> 的
 * class 上 → CodeBlock 读出来 → 切成 tok-* 片段 → CSS 用 --syn-* 上色。
 * 前两步只有单元测试，这里补上「组件真的接上了」。
 */
function render(source: string): string {
  return renderToStaticMarkup(<Markdown content={source} />)
}

describe('Markdown code fences', () => {
  it('colours a fenced block using its language tag', () => {
    const html = render('```ts\nconst answer = 42 // note\n```\n')
    expect(html).toContain('<span class="tok-keyword">const</span>')
    expect(html).toContain('<span class="tok-number">42</span>')
    expect(html).toContain('<span class="tok-comment">// note</span>')
    expect(html).toContain('class="code-wrap"')
  })

  it('leaves an untagged fence as plain text', () => {
    const html = render('```\nsome plain output\n```\n')
    expect(html).not.toContain('tok-keyword')
    expect(html).toContain('some plain output')
  })

  it('keeps inline code and tables untouched', () => {
    const inline = render('use `const` here\n')
    expect(inline).toContain('<code>const</code>')
    expect(inline).not.toContain('tok-keyword')

    const table = render('| a | b |\n| - | - |\n| 1 | 2 |\n')
    expect(table).toContain('class="table-wrap"')
  })

  it('escapes angle brackets instead of injecting markup', () => {
    const html = render('```html\n<script>alert(1)</script>\n```\n')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
