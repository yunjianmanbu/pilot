import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'

/**
 * End-to-end encryption for Pilot Link.
 *
 * The phone and the desktop derive two AES-256-GCM keys from an ECDH P-256
 * exchange plus a one-time pairing secret carried in the QR code. The local
 * relay only ever sees ciphertext envelopes. This module mirrors the WebCrypto
 * implementation in companion/app.js byte for byte.
 */

const CURVE = 'prime256v1'
const PUBLIC_KEY_BYTES = 64
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_ENVELOPE_BYTES = 512 * 1024

export const INFO_PC_TO_PHONE = 'pilot-link-e2e-v1:pc-to-phone'
export const INFO_PHONE_TO_PC = 'pilot-link-e2e-v1:phone-to-pc'

export interface PairKeys {
  pcToPhone: Buffer
  phoneToPc: Buffer
}

export interface EncryptedEnvelope {
  n: number
  iv: string
  data: string
}

export interface KeyPair {
  privateKey: KeyObject
  publicKey: KeyObject
  publicBase64: string
}

export function base64url(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer).toString('base64url')
}

export function fromBase64url(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`${label}格式不正确`)
  }
  return Buffer.from(value, 'base64url')
}

export function exportPublicKey(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' })
  const x = fromBase64url(jwk.x, '公钥')
  const y = fromBase64url(jwk.y, '公钥')
  if (x.length !== 32 || y.length !== 32) throw new Error('公钥长度不正确')
  return base64url(Buffer.concat([x, y]))
}

export function importPublicKey(value: unknown): KeyObject {
  const raw = fromBase64url(value, '公钥')
  if (raw.length !== PUBLIC_KEY_BYTES) throw new Error('公钥长度不正确')
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64url(raw.subarray(0, 32)),
      y: base64url(raw.subarray(32, 64)),
    },
    format: 'jwk',
  })
}

export function createKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE })
  return {
    privateKey,
    publicKey,
    publicBase64: exportPublicKey(publicKey),
  }
}

function deriveDirectionKey(shared: Buffer, secret: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, secret, Buffer.from(info, 'utf8'), KEY_BYTES))
}

export function derivePairKeys(
  privateKey: KeyObject,
  peerPublicBase64: unknown,
  pairSecretBase64: unknown,
): PairKeys {
  const peerPublicKey = importPublicKey(peerPublicBase64)
  const secret = fromBase64url(pairSecretBase64, '配对密钥')
  if (secret.length < 16 || secret.length > 64) throw new Error('配对密钥长度不正确')
  const shared = diffieHellman({ privateKey, publicKey: peerPublicKey })
  return {
    pcToPhone: deriveDirectionKey(shared, secret, INFO_PC_TO_PHONE),
    phoneToPc: deriveDirectionKey(shared, secret, INFO_PHONE_TO_PC),
  }
}

export function encryptPayload(
  key: Buffer,
  value: unknown,
  seq: number,
): EncryptedEnvelope {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('消息序号不正确')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(String(seq), 'utf8'))
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    n: seq,
    iv: base64url(iv),
    data: base64url(Buffer.concat([ciphertext, cipher.getAuthTag()])),
  }
}

export function decryptPayload(key: Buffer, envelope: unknown): {
  seq: number
  value: unknown
} {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  if (!envelope || typeof envelope !== 'object') throw new Error('加密消息格式不正确')
  const record = envelope as Record<string, unknown>
  const seq = record['n']
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw new Error('消息序号不正确')
  const iv = fromBase64url(record['iv'], 'IV')
  if (iv.length !== IV_BYTES) throw new Error('IV 长度不正确')
  const packed = fromBase64url(record['data'], '密文')
  if (packed.length <= TAG_BYTES || packed.length > MAX_ENVELOPE_BYTES) {
    throw new Error('密文长度不正确')
  }
  const ciphertext = packed.subarray(0, packed.length - TAG_BYTES)
  const tag = packed.subarray(packed.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(String(seq), 'utf8'))
  decipher.setAuthTag(tag)
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return { seq: seq as number, value: JSON.parse(plaintext.toString('utf8')) }
  } catch {
    throw new Error('消息解密失败')
  }
}

export function randomSecret(bytes = 16): string {
  return base64url(randomBytes(bytes))
}

export function randomLookup(): string {
  return base64url(randomBytes(32))
}

export function randomToken(): string {
  return base64url(randomBytes(32))
}

export function randomId(bytes = 16): string {
  return base64url(randomBytes(bytes))
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Challenge-response proof so the relay never sees the pairing token. */
export function tokenProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(challenge).digest('base64url')
}

export function safeEqualText(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export function safeEqualHex(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    Number.isSafeInteger(record['n']) &&
    typeof record['iv'] === 'string' &&
    typeof record['data'] === 'string'
  )
}
