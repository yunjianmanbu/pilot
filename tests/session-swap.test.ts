import { describe, expect, it } from 'vitest'
import { sessionSwapView } from '../src/renderer/src/session-swap'
import type { Session } from '../src/shared/types'

function session(id: string): Session {
  return {
    id,
    workspacePath: 'E:/ws',
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
  } as unknown as Session
}

describe('session swap staging', () => {
  it('renders the loaded session once it arrives', () => {
    const view = sessionSwapView({ session: session('next'), loading: false, previous: session('old') })
    expect(view.staged?.id).toBe('next')
    expect(view.swapping).toBe(false)
  })

  it('keeps the previous session on screen while the next one loads', () => {
    // 这正是白屏闪烁的来源：加载期如果按 session=null 渲染，会话区会整块换成
    // 「载入会话…」再整块换回来。保留上一份内容，标成过渡态即可。
    const view = sessionSwapView({ session: null, loading: true, previous: session('old') })
    expect(view.staged?.id).toBe('old')
    expect(view.swapping).toBe(true)
  })

  it('shows the loading view on first load, when nothing was on screen before', () => {
    const view = sessionSwapView({ session: null, loading: true, previous: null })
    expect(view.staged).toBeNull()
    expect(view.swapping).toBe(false)
  })

  it('does not keep a stale session once loading stops without a result', () => {
    // 加载失败或该工作区一个会话都没有：必须回落到空态，不能被旧内容占住。
    const view = sessionSwapView({ session: null, loading: false, previous: session('old') })
    expect(view.staged).toBeNull()
    expect(view.swapping).toBe(false)
  })
})
