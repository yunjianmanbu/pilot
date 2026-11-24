import { describe, expect, it } from 'vitest'

import { explainSmtpFailure } from '../src/main/reflect/mail'

/**
 * 163 拒认证回的是 `550 User has no permission`，字面上跟「授权码」无关。
 * 这里保证：原始回包一字不改地留着，后面附一句能照做的建议。
 */
describe('explainSmtpFailure', () => {
  it('keeps the raw 163 auth reply and adds what to fix', () => {
    const text = explainSmtpFailure('SMTP AUTH 失败：550 User has no permission')
    expect(text).toContain('550 User has no permission')
    expect(text).toContain('授权码')
  })

  it('explains a sender mismatch', () => {
    const text = explainSmtpFailure('收件人被拒：553 sender address rejected')
    expect(text).toContain('553 sender address rejected')
    expect(text).toContain('发件人')
  })

  it('explains unreachable hosts and timeouts', () => {
    expect(explainSmtpFailure('connect ECONNREFUSED 127.0.0.1:465')).toContain('端口')
    expect(explainSmtpFailure('SMTP 超时（20s 无响应）')).toContain('465')
  })

  it('leaves unrelated errors untouched', () => {
    expect(explainSmtpFailure('收件人地址无效：nobody')).toBe('收件人地址无效：nobody')
  })

  it('has English guidance too', () => {
    const text = explainSmtpFailure('550 User has no permission', true)
    expect(text).toContain('app password')
  })
})
