export interface PhoneKeyPair {
  privateKey: Uint8Array
  publicBase64: string
}

export interface PhonePairKeys {
  pcToPhone: Uint8Array
  phoneToPc: Uint8Array
}

export interface EncryptedEnvelope {
  n: number
  iv: string
  data: string
}

export function randomBytes(length: number): Uint8Array
export function base64url(bytes: Uint8Array): string
export function fromBase64url(value: unknown, label: string): Uint8Array
export function randomBase64url(length: number): string
export function utf8Encode(text: string): Uint8Array
export function utf8Decode(bytes: Uint8Array): string
export function importKey(value: unknown): Uint8Array
export function createKeyPair(): PhoneKeyPair
export function derivePairKeys(
  privateKey: Uint8Array,
  peerPublicBase64: unknown,
  pairSecretBase64: unknown,
): PhonePairKeys
export function encryptPayload(
  key: Uint8Array,
  value: unknown,
  seq: number,
): EncryptedEnvelope
export function decryptPayload(
  key: Uint8Array,
  envelope: unknown,
): { seq: number; value: unknown }
