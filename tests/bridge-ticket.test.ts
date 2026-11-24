/**
 * 浏览器等审批时每一轮回包该怎么处理。
 *
 * 这些断言直接对应「点授权通过、浏览器又重新申请、一直不过」这个现象的每一种
 * 成因：申请不在这台电脑上（404）、服务被关（503）、过期、被拒、已批准。
 * 以前这些都落进同一个 catch 分支「再问一次」，于是页面永远停在等待。
 */
import { describe, expect, it } from 'vitest'
import {
  decideTicketPoll,
  parseTicketDeadline,
  TICKET_TTL_MS,
  type TicketReply,
} from '../src/renderer/src/bridge-ticket'

const NOW = 1_700_000_000_000
const DEADLINE = NOW + 60_000

function decide(status: number, reply: TicketReply, now = NOW) {
  return decideTicketPoll({ status, reply, now, deadline: DEADLINE })
}

describe('decideTicketPoll', () => {
  it('批准了就带着 token 去连', () => {
    expect(decide(200, { ok: true, state: 'approved', token: 'tok_abcdefghijklmnopqrst' })).toEqual({
      kind: 'connect',
      token: 'tok_abcdefghijklmnopqrst',
    })
  })

  it('还在等就继续问', () => {
    expect(decide(200, { ok: true, state: 'pending' })).toEqual({ kind: 'wait' })
  })

  it('申请不在这台电脑的表里时停下来，而不是无限轮询同一个 id', () => {
    const missing = decide(404, { ok: false, error: 'unknown_ticket' })
    expect(missing.kind).toBe('stop')
    if (missing.kind !== 'stop') throw new Error('expected stop')
    // 提示必须告诉用户「另一份服务」这种真实成因，否则他只会再点一次授权。
    expect(missing.message).toContain('另一份')
    expect(missing.message).toContain('刷新')
  })

  it('网页服务被关掉时说明是服务关了，不是浏览器的问题', () => {
    const disabled = decide(503, { ok: false, error: 'server_disabled' })
    expect(disabled.kind).toBe('stop')
    if (disabled.kind !== 'stop') throw new Error('expected stop')
    expect(disabled.message).toContain('网页服务已经关闭')
  })

  it('被拒或过期都停下来，且优先使用服务端给的原因', () => {
    expect(decide(200, { ok: true, state: 'denied', reason: '正在处理另一个配对请求' })).toEqual({
      kind: 'stop',
      message: '正在处理另一个配对请求',
    })
    const expired = decide(200, { ok: true, state: 'expired' })
    expect(expired.kind).toBe('stop')
  })

  it('超过截止时间就停，不再看回包内容', () => {
    const late = decideTicketPoll({
      status: 200,
      reply: { ok: true, state: 'pending' },
      now: DEADLINE,
      deadline: DEADLINE,
    })
    expect(late.kind).toBe('stop')
  })

  it('瞬时 5xx 与网络失败继续等，不当成终态', () => {
    expect(decide(502, { ok: false, error: 'bad_gateway' })).toEqual({ kind: 'wait' })
    expect(decide(0, {})).toEqual({ kind: 'wait' })
  })

  it('批准了但没带 token 时继续等（不能拿空 token 去连）', () => {
    expect(decide(200, { ok: true, state: 'approved' })).toEqual({ kind: 'wait' })
  })
})

describe('parseTicketDeadline', () => {
  it('用服务端给的过期时间', () => {
    const iso = new Date(NOW + 120_000).toISOString()
    expect(parseTicketDeadline(iso, NOW)).toBe(NOW + 120_000)
  })

  it('给不出可用时间时按默认 TTL 兜底，不留永久轮询', () => {
    expect(parseTicketDeadline(undefined, NOW)).toBe(NOW + TICKET_TTL_MS)
    expect(parseTicketDeadline('not-a-date', NOW)).toBe(NOW + TICKET_TTL_MS)
    // 已经过期的回包同样兜底，避免 deadline 落在过去导致立刻放弃。
    expect(parseTicketDeadline(new Date(NOW - 1_000).toISOString(), NOW)).toBe(NOW + TICKET_TTL_MS)
  })
})
