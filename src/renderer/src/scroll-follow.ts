/**
 * 会话正文「是否跟随最新」的判定规则。
 *
 * 为什么单独一个纯模块：流式输出时正文每帧都在长高，跟随逻辑必须能单测。
 * 之前用「距离底部 < 120px 就算还在底部」来判定，结果一条滚轮（约 100px）
 * 滚完仍落在阈值内，被读成「用户还在底部」，下一帧又滚回去——用户看到的是
 * 「往上滚就被按回底部」。规则改成两条：显式向上意图立刻脱离，否则以
 * 滚动方向为准（scrollTop 变小就是用户往上看了），只有真正回到底部才恢复。
 */

export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/** 离底部多近算「已经在最新一条」。与 ProcessBox 的取值保持一致。 */
export const FOLLOW_THRESHOLD_PX = 24

export function distanceToBottom(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

export function isAtBottom(
  metrics: ScrollMetrics,
  threshold = FOLLOW_THRESHOLD_PX,
): boolean {
  // 内容不足一屏时距离为负，同样算在底部。
  return distanceToBottom(metrics) < threshold
}

export type ScrollInput =
  /** 用户显式向上：滚轮 deltaY < 0、触摸下滑看更早、PageUp/ArrowUp。 */
  | { kind: 'user-up' }
  /** 用户点了「回到最新」。 */
  | { kind: 'user-jump' }
  /** 我们自己滚出来的 scroll 事件（不能当成用户意图）。 */
  | { kind: 'own-scroll' }
  /** 一次真实的 scroll：带当前度量、上一次的 scrollTop 与上一次的 scrollHeight。 */
  | {
      kind: 'scroll'
      metrics: ScrollMetrics
      previousTop: number
      previousHeight: number
    }

/**
 * 返回下一次「是否跟随最新」。
 *
 * 两条判定：
 * 1. scrollTop 比上次小 1px 以上 = 用户往上看了，立刻脱离（不看距底多少）。
 * 2. 真回到贴近底部 = 恢复跟随。
 * 3. 其余情况**保持原状**：流式内容让 scrollHeight 变高时，距底会自然变大，
 *    但这不是用户意图，把它当成「离开了底部」会在点「回到最新」后立刻又被判
 *    脱跟（实测就是按钮点完又冒出来、跟随断掉）。
 *
 * 唯一的例外是**内容变矮**：流式段结算成正式消息、进程框收起时，DOM 总高
 * 骤降，浏览器会把 scrollTop 夹到新的最大值上——这会伪造出一个「scrollTop
 * 变小」的向上信号（实测点击「回到最新」后 3.6s，live 区归零那一帧按钮又
 * 出现，而当时距底一直是 0）。内容变矮不是用户意图，所以这一路跳过方向判定，
 * 只看「是不是已经(重新)贴底」。内容变高不能同样处理：流式长高时 scrollTop
 * 不动，用户真往上滚仍然表现为 scrollTop 变小，这条信号必须保留。
 */
export function nextFollow(following: boolean, input: ScrollInput): boolean {
  switch (input.kind) {
    case 'user-up':
      return false
    case 'user-jump':
      return true
    case 'own-scroll':
      return following
    case 'scroll': {
      const shrunk = input.metrics.scrollHeight < input.previousHeight - 1
      // 变矮时浏览器替我们夹了 scrollTop，方向不可信，只认可「已经贴底」。
      if (!shrunk && input.metrics.scrollTop < input.previousTop - 1) return false
      if (isAtBottom(input.metrics)) return true
      return following
    }
  }
}
