import { describe, expect, it } from 'vitest'
import { normalizeRelayUrl } from '../src/shared/relay'

describe('normalizeRelayUrl', () => {
  it('treats empty values as LAN-only mode', () => {
    expect(normalizeRelayUrl(undefined)).toBe('')
    expect(normalizeRelayUrl(null)).toBe('')
    expect(normalizeRelayUrl('')).toBe('')
    expect(normalizeRelayUrl('   ')).toBe('')
  })

  it('accepts ws and wss endpoints', () => {
    expect(normalizeRelayUrl('wss://relay.example.com/connector')).toBe(
      'wss://relay.example.com/connector',
    )
    expect(normalizeRelayUrl(' ws://192.168.1.10:8789/connector ')).toBe(
      'ws://192.168.1.10:8789/connector',
    )
  })

  it('drops URL fragments but keeps the query', () => {
    expect(normalizeRelayUrl('wss://relay.example.com/connector#frag')).toBe(
      'wss://relay.example.com/connector',
    )
    expect(normalizeRelayUrl('wss://relay.example.com/connector?token=1')).toBe(
      'wss://relay.example.com/connector?token=1',
    )
  })

  it('rejects other schemes and non-URL values', () => {
    expect(normalizeRelayUrl('https://relay.example.com/connector')).toBeNull()
    expect(normalizeRelayUrl('relay.example.com')).toBeNull()
    expect(normalizeRelayUrl('not a url')).toBeNull()
    expect(normalizeRelayUrl(42)).toBeNull()
  })

  it('rejects credentials embedded in the URL', () => {
    expect(normalizeRelayUrl('wss://user:pass@relay.example.com/connector')).toBeNull()
    expect(normalizeRelayUrl('wss://user@relay.example.com/connector')).toBeNull()
  })

  it('rejects overlong values', () => {
    expect(normalizeRelayUrl(`wss://relay.example.com/${'a'.repeat(600)}`)).toBeNull()
  })
})
