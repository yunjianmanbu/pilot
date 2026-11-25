import { describe, expect, it } from 'vitest'
import {
  FOLLOW_THRESHOLD_PX,
  distanceToBottom,
  isAtBottom,
  nextFollow,
  type ScrollMetrics,
} from '../src/renderer/src/scroll-follow'

/**
 * 这些用例钉住「流式输出时用户往上滚会被按回底部」那条 bug 的判定规则。
 * 旧规则只看「距底 < 120px 就算还在底部」，一次滚轮（约 100px）滚完仍落在
 * 阈值内，于是被读成用户还在底部，下一帧又滚回去。新规则看滚动方向，
 * 但对「内容变矮导致 scrollTop 被夹」单独豁免（见最后两条）。
 */

function metrics(scrollHeight: number, scrollTop: number, clientHeight: number): ScrollMetrics {
  return { scrollHeight, scrollTop, clientHeight }
}

describe('distanceToBottom / isAtBottom', () => {
  it('距底 = 内容高 - 滚动位置 - 视口高', () => {
    expect(distanceToBottom(metrics(2000, 1400, 500))).toBe(100)
  })

  it('内容不足一屏时距底为负，仍算在底部', () => {
    expect(distanceToBottom(metrics(300, 0, 500))).toBe(-200)
    expect(isAtBottom(metrics(300, 0, 500))).toBe(true)
  })

  it('阈值可显式传参，也能和 ProcessBox 对齐同一斤两', () => {
    expect(FOLLOW_THRESHOLD_PX).toBe(24)
    expect(isAtBottom(metrics(2000, 1477, 500), 10)).toBe(false)
  })

  it('阈值边界：距底 23px 算在底部，25px 就不算', () => {
    expect(distanceToBottom(metrics(2000, 1477, 500))).toBe(23)
    expect(isAtBottom(metrics(2000, 1477, 500))).toBe(true)
    expect(distanceToBottom(metrics(2000, 1475, 500))).toBe(25)
    expect(isAtBottom(metrics(2000, 1475, 500))).toBe(false)
  })
})

describe('nextFollow', () => {
  it('显式向上意图立刻脱离跟随', () => {
    expect(nextFollow(true, { kind: 'user-up' })).toBe(false)
  })

  it('点「回到最新」恢复跟随', () => {
    expect(nextFollow(false, { kind: 'user-jump' })).toBe(true)
  })

  it('自己的滚动不改变跟随状态（否则跟随会被自己的滚动续命）', () => {
    expect(nextFollow(true, { kind: 'own-scroll' })).toBe(true)
    expect(nextFollow(false, { kind: 'own-scroll' })).toBe(false)
  })

  it('用户向上滚 1px 以上就脱离跟随，不看离底部还剩多少', () => {
    // 距底只剩 5px（旧规则的 120px 阈值内），scrollTop 却比上一帧小了 2px。
    const following = nextFollow(true, {
      kind: 'scroll',
      metrics: metrics(2000, 1495, 500),
      previousTop: 1497,
      previousHeight: 2000,
    })
    expect(following).toBe(false)
  })

  it('复现原 bug：流式内容增长后一次滚轮不会再被阈值吞掉', () => {
    // 用户原本在底部（scrollTop 1500 / 距底 0）。
    expect(isAtBottom(metrics(2000, 1500, 500))).toBe(true)
    // 滚轮向上 100px，同时这一帧内容又长了 20px：距底 120px，恰好落在旧阈值边界。
    const after = metrics(2020, 1400, 500)
    expect(distanceToBottom(after)).toBe(120)
    expect(
      nextFollow(true, { kind: 'scroll', metrics: after, previousTop: 1500, previousHeight: 2000 }),
    ).toBe(false)
  })

  it('向下滚但还没到底：保持脱离', () => {
    expect(
      nextFollow(false, {
        kind: 'scroll',
        metrics: metrics(2000, 1300, 500),
        previousTop: 1200,
        previousHeight: 2000,
      }),
    ).toBe(false)
  })

  it('跟随中内容变高（scrollTop 未变）：继续保持跟随，不能误判脱离', () => {
    // 回归用例：旧规则会把「距底变远」当成用户离开，于是点「回到最新」时
    // smooth 滚动过程中内容还在长高，跟随当场被断，按钮又冒回来。
    expect(
      nextFollow(true, {
        kind: 'scroll',
        metrics: metrics(4000, 500, 500),
        previousTop: 500,
        previousHeight: 3000,
      }),
    ).toBe(true)
  })

  it('滚回底部才恢复跟随', () => {
    expect(
      nextFollow(false, {
        kind: 'scroll',
        metrics: metrics(2000, 1500, 500),
        previousTop: 1400,
        previousHeight: 2000,
      }),
    ).toBe(true)
  })

  it('内容变高但 scrollTop 没动、又不在底部：保持原状态（脱离仍脱离）', () => {
    expect(
      nextFollow(false, {
        kind: 'scroll',
        metrics: metrics(4000, 500, 500),
        previousTop: 500,
        previousHeight: 3000,
      }),
    ).toBe(false)
  })

  it('live 段结算成正式消息、内容变矮把 scrollTop 夹小：不误判脱离', () => {
    // 实测回归：点「回到最新」后约 3.6s，live 区归零那一帧距底一直是 0，
    // 按钮却又冒出来。原因是总高从 2012 掉到 1990，浏览器把 scrollTop 从
    // 1506 夹到 1490，制造出一个「往上滚了 16px」的假信号。
    expect(
      nextFollow(true, {
        kind: 'scroll',
        metrics: metrics(1990, 1490, 500),
        previousTop: 1506,
        previousHeight: 2012,
      }),
    ).toBe(true)
  })

  it('内容变矮但用户本来就在上面看：保持脱离，不能被夹紧事件拉回跟随', () => {
    expect(
      nextFollow(false, {
        kind: 'scroll',
        metrics: metrics(1500, 600, 500),
        previousTop: 902,
        previousHeight: 1802,
      }),
    ).toBe(false)
  })
})
