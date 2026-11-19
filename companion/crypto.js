import { gcm } from './vendor/noble/ciphers/aes.js'
import { p256 } from './vendor/noble/curves/nist.js'
import { hkdf } from './vendor/noble/hashes/hkdf.js'
import { hmac } from './vendor/noble/hashes/hmac.js'
import { sha256 } from './vendor/noble/hashes/sha2.js'

/**
 * Phone-side end-to-end crypto for Pilot Link.
 *
 * This mirrors src/main/companion/crypto.ts byte for byte. The PWA is served
 * over plain HTTP on the LAN, where WebCrypto is unavailable, so it uses the
 * vendored @noble primitives instead.
 */

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_ENVELOPE = 512 * 1024
const INFO_PC_TO_PHONE = 'pilot-link-e2e-v1:pc-to-phone'
const INFO_PHONE_TO_PC = 'pilot-link-e2e-v1:phone-to-pc'

/* ── Bytes / base64url ─────────────────────────────────────────────────── */

export function randomBytes(length) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)))
  }
  return btoa(binary)
}

function base64ToBytes(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function base64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function fromBase64url(value, label) {
  const text = String(value ?? '')
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error(`${label}格式不正确`)
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return base64ToBytes(padded)
}

export function randomBase64url(length) {
  return base64url(randomBytes(length))
}

export const utf8Encode = (text) => new TextEncoder().encode(text)
export const utf8Decode = (bytes) => new TextDecoder().decode(bytes)

/* ── E2E crypto (mirrors src/main/companion/crypto.ts) ──────────────────── */

export function importKey(value) {
  const key = fromBase64url(value, '加密密钥')
  if (key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  return key
}

function prefixPublicKey(raw) {
  if (raw.length !== 64) throw new Error('公钥长度不正确')
  const point = new Uint8Array(65)
  point[0] = 4
  point.set(raw, 1)
  return point
}

export function createKeyPair() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const privateKey = randomBytes(32)
    try {
      const publicKey = p256.getPublicKey(privateKey, false)
      if (publicKey.length !== 65) continue
      return { privateKey, publicBase64: base64url(publicKey.subarray(1)) }
    } catch {
      // Random scalars outside the curve order are retried.
    }
  }
  throw new Error('无法生成手机密钥')
}

export function derivePairKeys(privateKey, peerPublicBase64, pairSecretBase64) {
  const peerPoint = prefixPublicKey(fromBase64url(peerPublicBase64, '公钥'))
  const secret = fromBase64url(pairSecretBase64, '配对密钥')
  if (secret.length < 16) throw new Error('配对密钥过短')
  const shared = p256.getSharedSecret(privateKey, peerPoint, true).subarray(1)
  if (shared.length !== KEY_BYTES) throw new Error('共享密钥长度不正确')
  return {
    pcToPhone: Uint8Array.from(
      hkdf(sha256, shared, secret, utf8Encode(INFO_PC_TO_PHONE), KEY_BYTES),
    ),
    phoneToPc: Uint8Array.from(
      hkdf(sha256, shared, secret, utf8Encode(INFO_PHONE_TO_PC), KEY_BYTES),
    ),
  }
}

export function encryptPayload(key, value, seq) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('消息序号不正确')
  const iv = randomBytes(IV_BYTES)
  const packed = gcm(key, iv, utf8Encode(String(seq))).encrypt(
    utf8Encode(JSON.stringify(value)),
  )
  return { n: seq, iv: base64url(iv), data: base64url(packed) }
}

export function tokenProof(token, challenge) {
  if (typeof token !== 'string' || !token) throw new Error('配对凭证不正确')
  return base64url(hmac(sha256, utf8Encode(token), utf8Encode(String(challenge))))
}

export function decryptPayload(key, envelope) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new Error('加密密钥不正确')
  if (!envelope || typeof envelope !== 'object') throw new Error('加密消息格式不正确')
  const seq = envelope.n
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('消息序号不正确')
  const iv = fromBase64url(envelope.iv, 'IV')
  if (iv.length !== IV_BYTES) throw new Error('IV 长度不正确')
  const packed = fromBase64url(envelope.data, '密文')
  if (packed.length <= TAG_BYTES || packed.length > MAX_ENVELOPE) {
    throw new Error('密文长度不正确')
  }
  let plaintext
  try {
    plaintext = gcm(key, iv, utf8Encode(String(seq))).decrypt(packed)
  } catch {
    throw new Error('消息解密失败')
  }
  return { seq, value: JSON.parse(utf8Decode(plaintext)) }
}
