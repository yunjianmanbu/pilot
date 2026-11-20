import { describe, expect, it } from 'vitest'
import {
  maskRelayUrl,
  normalizeRelayUrl,
  parseRelayEndpoint,
  splitRelayUrl,
} from '../src/shared/relay'

const CODE = 'home:0123456789abcdef0123456789abcdef'

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

  it('keeps the #k= admission code and the query', () => {
    expect(normalizeRelayUrl(`wss://relay.example.com/c/9f3a#k=${CODE}`)).toBe(
      `wss://relay.example.com/c/9f3a#k=${CODE}`,
    )
    expect(normalizeRelayUrl('wss://relay.example.com/connector?token=1')).toBe(
      'wss://relay.example.com/connector?token=1',
    )
    expect(normalizeRelayUrl('wss://relay.example.com/connector?token=1#k=' + CODE)).toBe(
      `wss://relay.example.com/connector?token=1#k=${CODE}`,
    )
  })

  it('rejects any other fragment', () => {
    // Only the exact `k=` form is a credential. Anything else stays what it
    // always was: not a relay address.
    expect(normalizeRelayUrl('wss://relay.example.com/connector#frag')).toBeNull()
    expect(normalizeRelayUrl('wss://relay.example.com/connector#k=')).toBeNull()
    expect(normalizeRelayUrl('wss://relay.example.com/connector#k=too-short')).toBeNull()
    expect(normalizeRelayUrl(`wss://relay.example.com/connector#p=${CODE}`)).toBeNull()
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

describe('splitRelayUrl / maskRelayUrl', () => {
  it('separates the endpoint from the admission code', () => {
    expect(splitRelayUrl(`wss://relay.example.com/c/9f3a#k=${CODE}`)).toEqual({
      url: 'wss://relay.example.com/c/9f3a',
      access: CODE,
    })
    expect(splitRelayUrl('wss://relay.example.com/c/9f3a')).toEqual({
      url: 'wss://relay.example.com/c/9f3a',
      access: '',
    })
    expect(splitRelayUrl('')).toEqual({ url: '', access: '' })
    expect(splitRelayUrl(null)).toEqual({ url: '', access: '' })
  })

  it('masks the code for anything the user can screenshot', () => {
    expect(maskRelayUrl(`wss://relay.example.com/c/9f3a#k=${CODE}`)).toBe(
      'wss://relay.example.com/c/9f3a',
    )
  })
})

describe('parseRelayEndpoint', () => {
  it('round-trips a canonical endpoint', () => {
    const endpoint = parseRelayEndpoint(`wss://relay.example.com/c/9f3a#k=${CODE}`)
    expect(endpoint).not.toBeNull()
    expect(normalizeRelayUrl(`${endpoint!.url}#k=${endpoint!.access}`)).toBe(
      `wss://relay.example.com/c/9f3a#k=${CODE}`,
    )
  })

  it('drops the default port spelling the same way twice', () => {
    expect(normalizeRelayUrl('wss://relay.example.com:443/c/9f3a')).toBe(
      'wss://relay.example.com/c/9f3a',
    )
  })
})
