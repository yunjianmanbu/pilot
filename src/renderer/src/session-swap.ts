import type { Session } from '../../shared/types'

export interface SessionSwapInput {
  /** 当前已加载的会话：切换开始的瞬间会被清成 null。 */
  session: Session | null
  /** 新会话是否正在加载。 */
  loading: boolean
  /** 上一份已加载完成的会话，加载期间用它占位。 */
  previous: Session | null
}

export interface SessionSwapView {
  /** 会话区实际渲染的会话；加载期间沿用上一份，避免整块闪成「载入会话…」。 */
  staged: Session | null
  /** 是否处于切换过渡：压暗、顶部细进度条、禁止交互。 */
  swapping: boolean
}

/**
 * 决定切换会话时渲染哪一份内容。
 *
 * 直接按 `session` 渲染会把会话区整块换成载入态，再整块换回新内容——两次
 * 白屏闪烁，会话越大越明显。这里在加载期保留上一份内容并标记为过渡态，
 * 新会话就绪后一次淡入替换；首屏（还没有任何上一份）仍然显示载入态。
 */
export function sessionSwapView({ session, loading, previous }: SessionSwapInput): SessionSwapView {
  if (session) return { staged: session, swapping: false }
  if (!loading || !previous) return { staged: null, swapping: false }
  return { staged: previous, swapping: true }
}
