import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { QueuePanel } from '../src/renderer/src/components/chat/panels'
import type { QueuedTask } from '../src/shared/types'

/**
 * 排队面板必须自己说清「接下来会发生什么」。用户报告的场景是：上个任务没做完，
 * 按了中断/暂停再继续，结果排队的任务先跑了。收尾拦在队列策略里；界面上要能
 * 直接看出队列此刻是在等运行结束、等用户点继续，还是在等一条新消息。
 */
const queue: QueuedTask[] = [
  { id: 'q1', content: '把登录接口的错误码补齐', createdAt: '2026-01-01T00:00:00.000Z' },
]

function render(props: { running: boolean; paused: boolean }): string {
  return renderToStaticMarkup(
    <QueuePanel
      queue={queue}
      running={props.running}
      paused={props.paused}
      onInsert={vi.fn()}
      onRemove={vi.fn()}
      onUpdate={vi.fn(async () => undefined)}
      onConvert={vi.fn()}
    />,
  )
}

describe('QueuePanel', () => {
  it('a running task tells the user the queue starts when it finishes', () => {
    const html = render({ running: true, paused: false })
    expect(html).toContain('当前任务结束后自动开始')
    // 运行中把任务塞进当前 run，按钮语义是「插入」而不是「立即执行」。
    expect(html).toContain('插入当前任务，在下一步生效')
  })

  it('a paused session tells the user the queue waits for Continue', () => {
    const html = render({ running: false, paused: true })
    expect(html).toContain('已暂停：点「继续」后按序开始')
    expect(html).toContain('立即开始这条排队任务')
  })

  it('an idle session offers a manual start instead of claiming it starts soon', () => {
    const html = render({ running: false, paused: false })
    expect(html).toContain('未开始：发一条消息或点「立即执行」')
    expect(html).not.toContain('当前任务结束后自动开始')
    expect(html).toContain('立即执行')
  })

  it('renders nothing when the queue is empty', () => {
    const html = renderToStaticMarkup(
      <QueuePanel
        queue={[]}
        running={true}
        paused={false}
        onInsert={vi.fn()}
        onRemove={vi.fn()}
        onUpdate={vi.fn(async () => undefined)}
        onConvert={vi.fn()}
      />,
    )
    expect(html).toBe('')
  })
})
