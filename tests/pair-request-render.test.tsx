import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PairRequestDialog } from '../src/renderer/src/components/PairRequestDialog'
import type { CompanionPairRequest } from '../src/shared/types'

const NOW = Date.now()

function request(overrides: Partial<CompanionPairRequest> = {}): CompanionPairRequest {
  return {
    requestId: 'req-1',
    phoneId: 'web-1',
    name: '网页服务 10.0.0.2',
    platform: 'browser',
    address: '10.0.0.2',
    via: 'lan',
    mode: 'browser',
    role: 'host',
    requestedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 45_000).toISOString(),
    ...overrides,
  }
}

function render(overrides: Partial<CompanionPairRequest> = {}): string {
  return renderToStaticMarkup(
    <PairRequestDialog request={request(overrides)} onDecide={() => undefined} />,
  )
}

describe('browser access prompt', () => {
  it('asks once, on the device row, where the request came from', () => {
    const html = render()
    expect(html).toContain('浏览器请求访问这台电脑')
    expect(html).toContain('网页服务 10.0.0.2')
    // 地址已经在标题里，副标题只补「浏览器 · 局域网」，否则同一个地址出现两次。
    expect(html).toContain('浏览器 · 局域网')
    expect(html.match(/10\.0\.0\.2/g)).toHaveLength(1)
  })

  it('shows the countdown on the first frame instead of a timeout', () => {
    const html = render()
    expect(html).not.toContain('已超时')
    expect(html).toMatch(/\d+ 秒/)
  })

  it('states the identity instead of offering an unusable one', () => {
    const html = render()
    expect(html).toContain('pair-request-identity')
    expect(html).toContain('主机用户')
    // 客户机身份过不了 `/bridge` 的 `usableLevel`，页面加载不出来，所以不再作为一个选项。
    expect(html).not.toContain('客户机用户')
    expect(html).not.toContain('pair-request-role')
    expect(html).toContain('允许访问')
  })

  it('never allows a client identity for a browser page', () => {
    const html = render({ role: 'client' })
    expect(html).toContain('主机用户')
    expect(html).not.toContain('客户机用户')
  })
})

describe('phone pairing prompt', () => {
  it('keeps the address and drops the identity picker', () => {
    const html = render({
      mode: 'qr',
      platform: 'Android',
      name: 'Pixel 8',
      address: '10.0.0.9',
    })
    expect(html).toContain('手机请求连接这台电脑')
    expect(html).toContain('Pixel 8')
    expect(html).toContain('局域网 · 10.0.0.9')
    expect(html).not.toContain('pair-request-role')
    // 身份说明块是浏览器专属的：手机走扫码通道，不存在「与本机共用会话」这件事。
    expect(html).not.toContain('pair-request-identity')
    expect(html).not.toContain('浏览器页面必须与本机共用同一份会话')
    expect(html).toContain('允许连接')
  })

  it('does not print an address it does not have', () => {
    const html = render({ mode: 'qr', platform: 'iOS', name: 'iPhone', address: null, via: 'relay' })
    expect(html).toContain('iOS · 云端中继')
    expect(html).not.toContain('未知地址')
  })
})

describe('expired request', () => {
  it('says so instead of counting down', () => {
    const html = render({ expiresAt: new Date(NOW - 5_000).toISOString() })
    expect(html).toContain('已超时')
    expect(html).not.toMatch(/\d+ 秒/)
  })
})
