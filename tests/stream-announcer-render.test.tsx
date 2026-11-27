import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StreamAnnouncer } from '../src/renderer/src/components/StreamAnnouncer'

/**
 * 播报通道的 DOM 契约。
 *
 * 这几个属性各自挡掉一种回退，少一个读者体验就不同：
 *
 * - `aria-live="polite"`：不抢焦点、等手头的朗读停下再念；
 * - `aria-atomic="false"`：只念新增的节点，不把整个区域重读一遍；
 * - `aria-relevant="additions"`：条目超过上限被裁掉时不念「已删除」；
 * - `sr-only`：视觉隐藏但留在可访问性树里（`display:none` 会彻底哑掉）。
 *
 * 静态渲染还顺带证明「首屏没有内容」——历史消息不该被整段朗读。
 */
describe('StreamAnnouncer', () => {
  it('renders an empty, polite live region before anything streams', () => {
    const html = renderToStaticMarkup(<StreamAnnouncer text="" active={false} />)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="false"')
    expect(html).toContain('aria-relevant="additions"')
    expect(html).toContain('class="sr-only"')
    expect(html).toContain('data-stream-announcer')
    // 内容只在轮询/收尾时追加，挂载的那一刻必须是空的。
    expect(html).toContain('></div>')
  })

  it('does not dump a static transcript into the live region', () => {
    // 已结束的回答（active=false）走的是屏幕上的 Markdown，不该进播报区。
    const html = renderToStaticMarkup(
      <StreamAnnouncer text="这是一段已经写完的历史回答。" active={false} resetKey="run-1" />,
    )
    expect(html).not.toContain('这是一段已经写完的历史回答。')
  })
})
