import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { PLUGIN_MANIFEST_FILE, PLUGINS_DIR, type PluginManifest } from './manifest'

/**
 * Self-signed plugin trust.
 *
 * Business integrations and vertical solutions are usually shipped by someone
 * other than the Pilot project, so the signature chain is deliberately
 * self-signed: a vendor generates an ed25519 key pair, signs the plugin, and
 * the workspace owner pastes the vendor's public key into
 * `<workspace>/.pilot/plugins/trusted-keys.json`. There is no PKI, no network
 * call and no certificate authority involved — the trust decision stays local
 * and auditable, which is what on-premise and industry deployments need.
 *
 * What a signature covers: the on-disk bytes of `plugin.json` and the entry
 * file named in it. That is exactly the code the host spawns, so editing either
 * one after signing is reported as `tampered` — the same signal a business
 * developer sees after a source-level patch until they sign again.
 */
export const PLUGIN_SIGNATURE_FILE = 'plugin.sig'
export const TRUST_STORE_FILE = 'trusted-keys.json'
export const PLUGIN_SECURITY_FILE = 'security.json'
export const SIGNATURE_ALGORITHM = 'ed25519'
export const MAX_SIGNATURE_FILE_BYTES = 4 * 1024
export const MAX_TRUSTED_KEYS = 32

const DIGEST_PREFIX = 'pilot-plugin/1'
const KEY_ID_PREFIX = 'ed25519-'

export type SignaturePolicy = 'off' | 'warn' | 'required'

/** Unsigned plugins keep working: the default only surfaces a warning. */
export const DEFAULT_SIGNATURE_POLICY: SignaturePolicy = 'warn'

/**
 * - `unsigned`  no `plugin.sig` on disk
 * - `trusted`   signed by a key in this workspace's trust store, files intact
 * - `untrusted` signed, but the signing key is unknown here
 * - `tampered`  the signed key is trusted, but the files changed afterwards
 * - `malformed` the signature file or the digest could not be produced
 */
export type SignatureState = 'unsigned' | 'trusted' | 'untrusted' | 'tampered' | 'malformed'

export interface PluginSignatureFile {
  algorithm: typeof SIGNATURE_ALGORITHM
  keyId: string
  digest: string
  signature: string
  signedAt: string
}

export interface TrustedKey {
  keyId: string
  publicKey: string
  label: string
  addedAt: string
}

export interface TrustStore {
  keys: TrustedKey[]
}

export interface PluginSignature {
  state: SignatureState
  policy: SignaturePolicy
  /** Digest of the files as they are on disk right now. */
  digest: string
  keyId: string | null
  label: string | null
  detail: string
}

export interface SigningKeyPair {
  keyId: string
  privateKey: string
  publicKey: string
}

/** Stable id derived from the key material, so a key cannot claim another id. */
export function keyIdForPublicKey(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return `${KEY_ID_PREFIX}${createHash('sha256').update(der).digest('hex').slice(0, 16)}`
}

export function generateSigningKey(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { keyId: keyIdForPublicKey(publicKeyPem), privateKey: privateKeyPem, publicKey: publicKeyPem }
}

/**
 * Digest over the manifest and the entry file, length-prefixed so two files
 * cannot be concatenated into the same hash.
 */
export async function computePluginDigest(dir: string, manifest: PluginManifest): Promise<string> {
  const hash = createHash('sha256')
  hash.update(DIGEST_PREFIX)
  for (const name of [PLUGIN_MANIFEST_FILE, normalize(manifest.entry)]) {
    const bytes = await readFile(join(dir, name))
    hash.update(`\n${name} ${bytes.byteLength} `)
    hash.update(bytes)
  }
  return `sha256:${hash.digest('hex')}`
}

export async function signPluginDir(
  dir: string,
  manifest: PluginManifest,
  privateKeyPem: string,
): Promise<PluginSignatureFile> {
  const digest = await computePluginDigest(dir, manifest)
  const key = createPrivateKey(privateKeyPem)
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString()
  const signature = signBytes(null, Buffer.from(`${DIGEST_PREFIX}\n${digest}`), key).toString('base64')
  return {
    algorithm: SIGNATURE_ALGORITHM,
    keyId: keyIdForPublicKey(publicKeyPem),
    digest,
    signature,
    signedAt: new Date().toISOString(),
  }
}

export async function writePluginSignature(
  dir: string,
  signature: PluginSignatureFile,
): Promise<string> {
  const file = join(dir, PLUGIN_SIGNATURE_FILE)
  await writeFile(file, `${JSON.stringify(signature, null, 2)}\n`, 'utf8')
  return file
}

export async function readPluginSignatureFile(dir: string): Promise<PluginSignatureFile | null> {
  let raw: string
  try {
    raw = await readFile(join(dir, PLUGIN_SIGNATURE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SIGNATURE_FILE_BYTES) {
    throw new Error(`${PLUGIN_SIGNATURE_FILE} is larger than ${MAX_SIGNATURE_FILE_BYTES} bytes`)
  }
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${PLUGIN_SIGNATURE_FILE} must be a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  if (record['algorithm'] !== SIGNATURE_ALGORITHM) {
    throw new Error(`${PLUGIN_SIGNATURE_FILE} algorithm must be "${SIGNATURE_ALGORITHM}"`)
  }
  for (const field of ['keyId', 'digest', 'signature'] as const) {
    if (typeof record[field] !== 'string' || !record[field]) {
      throw new Error(`${PLUGIN_SIGNATURE_FILE} is missing "${field}"`)
    }
  }
  return {
    algorithm: SIGNATURE_ALGORITHM,
    keyId: record['keyId'] as string,
    digest: record['digest'] as string,
    signature: record['signature'] as string,
    signedAt: typeof record['signedAt'] === 'string' ? record['signedAt'] : '',
  }
}

export function trustStorePath(root: string): string {
  return join(root, PLUGINS_DIR, TRUST_STORE_FILE)
}

export function securityPath(root: string): string {
  return join(root, PLUGINS_DIR, PLUGIN_SECURITY_FILE)
}

export async function readTrustStore(root: string): Promise<TrustStore> {
  const file = trustStorePath(root)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { keys: [] }
    throw error
  }
  const parsed = JSON.parse(raw) as unknown
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { keys?: unknown }).keys)
      ? ((parsed as { keys: unknown[] }).keys)
      : []
  const keys: TrustedKey[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const publicKey = typeof record['publicKey'] === 'string' ? record['publicKey'] : ''
    if (!publicKey) continue
    let keyId: string
    try {
      keyId = keyIdForPublicKey(publicKey)
    } catch {
      // A corrupted or non-ed25519 key must not silently weaken the store.
      continue
    }
    if (keys.some((entry) => entry.keyId === keyId)) continue
    keys.push({
      keyId,
      publicKey,
      label: typeof record['label'] === 'string' ? record['label'] : keyId,
      addedAt: typeof record['addedAt'] === 'string' ? record['addedAt'] : '',
    })
    if (keys.length >= MAX_TRUSTED_KEYS) break
  }
  return { keys }
}

export async function writeTrustStore(root: string, store: TrustStore): Promise<void> {
  const file = trustStorePath(root)
  await mkdir(join(root, PLUGINS_DIR), { recursive: true })
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

export async function addTrustedKey(
  root: string,
  publicKeyPem: string,
  label?: string,
): Promise<TrustedKey> {
  const keyId = keyIdForPublicKey(publicKeyPem)
  const store = await readTrustStore(root)
  const existing = store.keys.find((key) => key.keyId === keyId)
  const key: TrustedKey = {
    keyId,
    publicKey: publicKeyPem.endsWith('\n') ? publicKeyPem : `${publicKeyPem}\n`,
    label: label?.trim() || existing?.label || keyId,
    addedAt: new Date().toISOString(),
  }
  const keys = [...store.keys.filter((entry) => entry.keyId !== keyId), key]
  if (keys.length > MAX_TRUSTED_KEYS) {
    throw new Error(`at most ${MAX_TRUSTED_KEYS} trusted keys are supported per workspace`)
  }
  await writeTrustStore(root, { keys })
  return key
}

export async function removeTrustedKey(root: string, keyId: string): Promise<boolean> {
  const store = await readTrustStore(root)
  const keys = store.keys.filter((key) => key.keyId !== keyId)
  if (keys.length === store.keys.length) return false
  await writeTrustStore(root, { keys })
  return true
}

export async function readSignaturePolicy(root: string): Promise<SignaturePolicy> {
  let raw: string
  try {
    raw = await readFile(securityPath(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_SIGNATURE_POLICY
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    const value =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)['signaturePolicy']
        : undefined
    return value === 'off' || value === 'warn' || value === 'required'
      ? value
      : DEFAULT_SIGNATURE_POLICY
  } catch {
    return DEFAULT_SIGNATURE_POLICY
  }
}

export async function writeSignaturePolicy(root: string, policy: SignaturePolicy): Promise<void> {
  await mkdir(join(root, PLUGINS_DIR), { recursive: true })
  await writeFile(securityPath(root), `${JSON.stringify({ signaturePolicy: policy }, null, 2)}\n`, 'utf8')
}

/** Decides what a plugin's signature means for this workspace. */
export async function assessPluginSignature(
  dir: string,
  manifest: PluginManifest,
  store: TrustStore,
  policy: SignaturePolicy = DEFAULT_SIGNATURE_POLICY,
): Promise<PluginSignature> {
  const unsigned: PluginSignature = {
    state: 'unsigned',
    policy,
    digest: '',
    keyId: null,
    label: null,
    detail: `not signed; run \`pilot plugin sign ${manifest.id}\` before shipping it`,
  }
  let digest: string
  try {
    digest = await computePluginDigest(dir, manifest)
  } catch (error) {
    return {
      ...unsigned,
      state: 'malformed',
      detail: `cannot read the files a signature would cover: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  let signature: PluginSignatureFile | null
  try {
    signature = await readPluginSignatureFile(dir)
  } catch (error) {
    return {
      ...unsigned,
      digest,
      state: 'malformed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  if (!signature) return { ...unsigned, digest }

  const key = store.keys.find((entry) => entry.keyId === signature.keyId)
  if (!key) {
    return {
      state: 'untrusted',
      policy,
      digest,
      keyId: signature.keyId,
      label: null,
      detail: `signed by ${signature.keyId}, which is not trusted in this workspace; run \`pilot plugin trust <vendor-public.pem>\``,
    }
  }
  if (signature.digest !== digest) {
    return {
      state: 'tampered',
      policy,
      digest,
      keyId: key.keyId,
      label: key.label,
      detail:
        'files changed after signing (local source-level edit?); re-sign with `pilot plugin sign` to publish the change',
    }
  }
  let valid = false
  try {
    const publicKey = createPublicKey(key.publicKey)
    valid = verifyBytes(
      null,
      Buffer.from(`${DIGEST_PREFIX}\n${digest}`),
      publicKey,
      Buffer.from(signature.signature, 'base64'),
    )
  } catch {
    valid = false
  }
  if (!valid) {
    return {
      state: 'tampered',
      policy,
      digest,
      keyId: key.keyId,
      label: key.label,
      detail: 'signature does not verify against the trusted key',
    }
  }
  return {
    state: 'trusted',
    policy,
    digest,
    keyId: key.keyId,
    label: key.label,
    detail: `signed by ${key.label} (${key.keyId})`,
  }
}

/** True when this workspace's policy refuses to run the plugin. */
export function signatureBlocks(signature: PluginSignature | null | undefined): boolean {
  if (!signature) return false
  return signature.policy === 'required' && signature.state !== 'trusted'
}
