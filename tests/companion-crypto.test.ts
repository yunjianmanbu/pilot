import { describe, expect, it } from 'vitest'
import {
  createKeyPair,
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  fromBase64url,
  randomSecret,
} from '../src/main/companion/crypto'

type PhoneCrypto = typeof import('../companion/crypto.js')

async function loadPhoneCrypto(): Promise<PhoneCrypto> {
  return import('../companion/crypto.js')
}

describe('Pilot Link end-to-end crypto', () => {
  it('derives identical directional keys on desktop and phone', async () => {
    const phone = await loadPhoneCrypto()
    const desktop = createKeyPair()
    const mobile = phone.createKeyPair()
    const secret = randomSecret(32)

    const desktopKeys = derivePairKeys(desktop.privateKey, mobile.publicBase64, secret)
    const phoneKeys = phone.derivePairKeys(mobile.privateKey, desktop.publicBase64, secret)

    expect(Buffer.from(phoneKeys.pcToPhone).equals(desktopKeys.pcToPhone)).toBe(true)
    expect(Buffer.from(phoneKeys.phoneToPc).equals(desktopKeys.phoneToPc)).toBe(true)
    expect(desktopKeys.pcToPhone.equals(desktopKeys.phoneToPc)).toBe(false)
  })

  it('decrypts desktop envelopes on the phone and phone envelopes on the desktop', async () => {
    const phone = await loadPhoneCrypto()
    const desktop = createKeyPair()
    const mobile = phone.createKeyPair()
    const secret = randomSecret(32)
    const desktopKeys = derivePairKeys(desktop.privateKey, mobile.publicBase64, secret)
    const phoneKeys = phone.derivePairKeys(mobile.privateKey, desktop.publicBase64, secret)

    const fromDesktop = encryptPayload(
      desktopKeys.pcToPhone,
      { type: 'event', data: { type: 'run.started' } },
      7,
    )
    const decodedOnPhone = phone.decryptPayload(phoneKeys.pcToPhone, fromDesktop)
    expect(decodedOnPhone.seq).toBe(7)
    expect(decodedOnPhone.value).toEqual({
      type: 'event',
      data: { type: 'run.started' },
    })

    const fromPhone = phone.encryptPayload(
      phoneKeys.phoneToPc,
      { type: 'request', id: '1-a', method: 'sessions.list', params: {} },
      3,
    )
    const decodedOnDesktop = decryptPayload(desktopKeys.phoneToPc, fromPhone)
    expect(decodedOnDesktop.seq).toBe(3)
    expect(decodedOnDesktop.value).toMatchObject({
      type: 'request',
      method: 'sessions.list',
    })
  })

  it('binds ciphertext to the sequence number and rejects tampering', async () => {
    const phone = await loadPhoneCrypto()
    const desktop = createKeyPair()
    const mobile = phone.createKeyPair()
    const secret = randomSecret(32)
    const desktopKeys = derivePairKeys(desktop.privateKey, mobile.publicBase64, secret)
    const phoneKeys = phone.derivePairKeys(mobile.privateKey, desktop.publicBase64, secret)

    const envelope = encryptPayload(desktopKeys.pcToPhone, { ok: true }, 11)
    expect(() => phone.decryptPayload(phoneKeys.pcToPhone, { ...envelope, n: 12 })).toThrow(
      '消息解密失败',
    )

    const data = fromBase64url(envelope.data, '密文')
    const last = data.length - 1
    data[last] = (data[last] ?? 0) ^ 0xff
    expect(() =>
      phone.decryptPayload(phoneKeys.pcToPhone, {
        ...envelope,
        data: Buffer.from(data).toString('base64url'),
      }),
    ).toThrow('消息解密失败')
  })

  it('uses the full 64-byte uncompressed public key without the 0x04 prefix', async () => {
    const phone = await loadPhoneCrypto()
    const mobile = phone.createKeyPair()
    expect(mobile.publicBase64).toHaveLength(86)
    expect(fromBase64url(mobile.publicBase64, '公钥')).toHaveLength(64)
  })
})
