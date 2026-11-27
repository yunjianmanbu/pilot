/**
 * 审批卡的播报：只播新来的那一条。
 *
 * 卡片里的倒计时每秒变一次，如果播报节点跟着卡片走，读者会被每秒打断一次；
 * 判定收在 `freshApprovals` 里，这里钉住「旧的不重复、清空后重新计」。
 */
import { describe, expect, it } from 'vitest'
import { freshApprovals } from '../src/renderer/src/a11y/approval-announce'

const call = (callId: string) => ({ callId })

describe('freshApprovals', () => {
  it('announces everything on the first batch', () => {
    expect(freshApprovals([], [])).toEqual({ fresh: [], seen: [] })
    expect(freshApprovals([], [call('a'), call('b')])).toEqual({
      fresh: [call('a'), call('b')],
      seen: ['a', 'b'],
    })
  })

  it('does not repeat a request that is already on screen', () => {
    const result = freshApprovals(['a'], [call('a')])
    expect(result.fresh).toEqual([])
    expect(result.seen).toEqual(['a'])
  })

  it('announces only the addition when a second call arrives', () => {
    const result = freshApprovals(['a'], [call('a'), call('b')])
    expect(result.fresh.map((r) => r.callId)).toEqual(['b'])
    expect(result.seen).toEqual(['a', 'b'])
  })

  it('leaves the caller array untouched so a stale render cannot poison it', () => {
    const seen = ['a']
    freshApprovals(seen, [call('a'), call('b')])
    expect(seen).toEqual(['a'])
  })

  it('forgets everything once the stack is empty', () => {
    expect(freshApprovals(['a', 'b'], [])).toEqual({ fresh: [], seen: [] })
    // 同一条工具再次请求确认时，清空过就能重新播报。
    expect(freshApprovals([], [call('a')]).fresh).toHaveLength(1)
  })
})
