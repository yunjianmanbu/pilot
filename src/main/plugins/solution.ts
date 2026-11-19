import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  assessPluginSignature,
  computePluginDigest,
  keyIdForPublicKey,
  readSignaturePolicy,
  readTrustStore,
  type PluginSignature,
  type SignaturePolicy,
  type TrustedKey,
} from './integrity'
import {
  MAX_PLUGINS,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR,
  PluginManifestError,
  parsePluginManifest,
  type PluginManifest,
} from './manifest'

/**
 * Vertical solution packs.
 *
 * A solution pack is the unit a vendor hands to a business customer: one
 * `solution.json`, the plugin directories it ships, the trust anchors that
 * sign them, and the permission grants they need. Installing it is the only
 * step that touches the customer workspace, and it records a lock file so a
 * later source-level patch shows up as drift instead of silently changing a
 * signed deployment.
 */
export const SOLUTION_FILE = 'solution.json'
export const SOLUTION_LOCK_FILE = 'solution.lock.json'
export const SOLUTION_API_VERSION = 1
export const MAX_SOLUTION_PLUGINS = MAX_PLUGINS
export const MAX_SOLUTION_FILE_BYTES = 128 * 1024
/** Copied plugin trees stay small; anything bigger should ship a bundle. */
const MAX_COPY_FILES = 512
const MAX_COPY_BYTES = 8 * 1024 * 1024
const SKIP_ENTRIES = new Set(['node_modules', '.git', '.state'])

const SOLUTION_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export interface SolutionPluginRef {
  id: string
  /** Directory under the pack root, e.g. `plugins/pilot-auth`. */
  path: string
}

export interface SolutionGrant {
  enabled: boolean
  permissions: string[]
}

export interface SolutionTrustAnchor {
  publicKey: string
  label: string
}

export interface SolutionBranding {
  productName: string
  accent: string
  locale: string
}

export interface SolutionPack {
  api: number
  id: string
  name: string
  version: string
  industry: string
  description: string
  vendor: string
  pilotVersion: string
  plugins: SolutionPluginRef[]
  grants: Record<string, SolutionGrant>
  trust: SolutionTrustAnchor[]
  branding: SolutionBranding
  docs: string[]
}

export interface SolutionPlanItem {
  id: string
  dir: string
  manifest: PluginManifest | null
  signature: PluginSignature | null
  requestedPermissions: string[]
  blockers: string[]
  notes: string[]
}

export interface SolutionPlan {
  pack: SolutionPack
  packDir: string
  policy: SignaturePolicy
  items: SolutionPlanItem[]
  blockers: string[]
  warnings: string[]
  ready: boolean
}

export interface SolutionLockEntry {
  id: string
  digest: string
  keyId: string | null
  state: string
}

export interface SolutionLock {
  api: number
  solutionId: string
  version: string
  vendor: string
  installedAt: string
  plugins: SolutionLockEntry[]
}

export interface SolutionDriftItem extends SolutionLockEntry {
  current: string
  drift: boolean
  signature: PluginSignature | null
  detail: string
}

export interface SolutionDrift {
  found: boolean
  solutionId: string
  version: string
  items: SolutionDriftItem[]
  drifted: string[]
}

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PluginManifestError(`${label} must be a JSON object`)
  }
  return raw as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, field: string, max = 200): string {
  const value = record[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new PluginManifestError(`${SOLUTION_FILE}: "${field}" must be a non-empty string`)
  }
  if (value.length > max) {
    throw new PluginManifestError(`${SOLUTION_FILE}: "${field}" is longer than ${max} chars`)
  }
  return value.trim()
}

function optionalString(record: Record<string, unknown>, field: string, max = 200): string {
  const value = record[field]
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new PluginManifestError(`${SOLUTION_FILE}: "${field}" must be a string`)
  }
  return value.trim().slice(0, max)
}

export function parseSolutionPack(raw: unknown, expectedId?: string): SolutionPack {
  const record = asRecord(raw, SOLUTION_FILE)
  const api = record['api']
  if (api !== SOLUTION_API_VERSION) {
    throw new PluginManifestError(
      `${SOLUTION_FILE}: api must be ${SOLUTION_API_VERSION}; this build cannot install api ${String(api)}`,
    )
  }
  const id = requiredString(record, 'id', 32)
  if (!SOLUTION_ID_PATTERN.test(id)) {
    throw new PluginManifestError(
      `${SOLUTION_FILE}: "id" must be 2-32 chars of lowercase letters, digits and dashes`,
    )
  }
  if (expectedId && id !== expectedId) {
    throw new PluginManifestError(
      `${SOLUTION_FILE}: id "${id}" does not match the pack directory "${expectedId}"`,
    )
  }
  const version = requiredString(record, 'version', 40)
  if (!VERSION_PATTERN.test(version)) {
    throw new PluginManifestError(`${SOLUTION_FILE}: "version" must look like 1.2.3`)
  }

  const pluginsRaw = record['plugins']
  if (!Array.isArray(pluginsRaw) || pluginsRaw.length === 0) {
    throw new PluginManifestError(`${SOLUTION_FILE}: "plugins" must be a non-empty array`)
  }
  if (pluginsRaw.length > MAX_SOLUTION_PLUGINS) {
    throw new PluginManifestError(
      `${SOLUTION_FILE}: at most ${MAX_SOLUTION_PLUGINS} plugins per solution`,
    )
  }
  const plugins: SolutionPluginRef[] = []
  for (const item of pluginsRaw) {
    const entry = asRecord(item, `${SOLUTION_FILE}: plugins[]`)
    const pluginId = requiredString(entry, 'id', 32)
    const path = requiredString(entry, 'path', 200).replace(/\\/g, '/')
    if (path.startsWith('/') || path.includes(':') || path.split('/').includes('..')) {
      throw new PluginManifestError(
        `${SOLUTION_FILE}: plugin ${pluginId} path must stay inside the pack: ${path}`,
      )
    }
    if (plugins.some((existing) => existing.id === pluginId)) {
      throw new PluginManifestError(`${SOLUTION_FILE}: plugin ${pluginId} is listed twice`)
    }
    plugins.push({ id: pluginId, path })
  }

  const grants: Record<string, SolutionGrant> = {}
  const grantsRaw = record['grants']
  if (grantsRaw !== undefined && grantsRaw !== null) {
    const grantRecord = asRecord(grantsRaw, `${SOLUTION_FILE}: grants`)
    for (const [pluginId, value] of Object.entries(grantRecord)) {
      if (!plugins.some((plugin) => plugin.id === pluginId)) {
        throw new PluginManifestError(
          `${SOLUTION_FILE}: grants mentions ${pluginId}, which is not in "plugins"`,
        )
      }
      const grant = asRecord(value, `${SOLUTION_FILE}: grants.${pluginId}`)
      const permissions = Array.isArray(grant['permissions'])
        ? grant['permissions'].filter((entry): entry is string => typeof entry === 'string')
        : []
      grants[pluginId] = { enabled: grant['enabled'] !== false, permissions }
    }
  }

  const trust: SolutionTrustAnchor[] = []
  const trustRaw = record['trust']
  if (trustRaw !== undefined && trustRaw !== null) {
    if (!Array.isArray(trustRaw)) {
      throw new PluginManifestError(`${SOLUTION_FILE}: "trust" must be an array`)
    }
    for (const item of trustRaw) {
      const entry = asRecord(item, `${SOLUTION_FILE}: trust[]`)
      const publicKey = requiredString(entry, 'publicKey', 4096)
      let keyId: string
      try {
        keyId = keyIdForPublicKey(publicKey)
      } catch {
        throw new PluginManifestError(`${SOLUTION_FILE}: trust[] contains an invalid public key`)
      }
      trust.push({ publicKey, label: optionalString(entry, 'label', 80) || keyId })
    }
  }

  const brandingRaw = record['branding'] === undefined ? {} : asRecord(record['branding'], `${SOLUTION_FILE}: branding`)
  const docsRaw = record['docs']
  const docs = Array.isArray(docsRaw)
    ? docsRaw.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : []

  return {
    api: SOLUTION_API_VERSION,
    id,
    name: requiredString(record, 'name', 80),
    version,
    industry: requiredString(record, 'industry', 40),
    description: optionalString(record, 'description', 400),
    vendor: optionalString(record, 'vendor', 80),
    pilotVersion: optionalString(record, 'pilotVersion', 40),
    plugins,
    grants,
    trust,
    branding: {
      productName: optionalString(brandingRaw, 'productName', 80),
      accent: optionalString(brandingRaw, 'accent', 24),
      locale: optionalString(brandingRaw, 'locale', 16),
    },
    docs,
  }
}

export async function loadSolutionPack(packDir: string, expectedId?: string): Promise<SolutionPack> {
  const file = join(packDir, SOLUTION_FILE)
  const raw = await readFile(file, 'utf8')
  if (Buffer.byteLength(raw, 'utf8') > MAX_SOLUTION_FILE_BYTES) {
    throw new PluginManifestError(`${SOLUTION_FILE} is larger than ${MAX_SOLUTION_FILE_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PluginManifestError(`${SOLUTION_FILE} is not valid JSON`)
  }
  return parseSolutionPack(parsed, expectedId)
}

function insidePack(packDir: string, relativePath: string): string {
  const base = resolve(packDir)
  const target = resolve(base, relativePath)
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new PluginManifestError(`${SOLUTION_FILE}: path escapes the pack: ${relativePath}`)
  }
  return target
}

async function readManifestAt(dir: string, expectedId: string): Promise<PluginManifest> {
  const raw = await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new PluginManifestError(`${PLUGIN_MANIFEST_FILE} is not valid JSON`)
  }
  return parsePluginManifest(parsed, expectedId)
}

async function packTrust(pack: SolutionPack): Promise<TrustedKey[]> {
  return pack.trust.map((anchor) => ({
    keyId: keyIdForPublicKey(anchor.publicKey),
    publicKey: anchor.publicKey,
    label: anchor.label,
    addedAt: '',
  }))
}

/**
 * Dry run: what would installing this pack do, and what stops it. Nothing is
 * written, so a customer can inspect a vendor pack before trusting it.
 */
export async function planSolution(
  workspace: string,
  packDir: string,
  options: { policy?: SignaturePolicy } = {},
): Promise<SolutionPlan> {
  const pack = await loadSolutionPack(packDir)
  const policy = options.policy ?? (await readSignaturePolicy(workspace))
  const workspaceTrust = await readTrustStore(workspace)
  const bundled = await packTrust(pack)
  const trust = {
    keys: [...bundled, ...workspaceTrust.keys.filter((key) => !bundled.some((b) => b.keyId === key.keyId))],
  }
  const items: SolutionPlanItem[] = []
  const blockers: string[] = []
  const warnings: string[] = []

  for (const ref of pack.plugins) {
    const dir = insidePack(packDir, ref.path)
    const item: SolutionPlanItem = {
      id: ref.id,
      dir,
      manifest: null,
      signature: null,
      requestedPermissions: pack.grants[ref.id]?.permissions ?? [],
      blockers: [],
      notes: [],
    }
    try {
      item.manifest = await readManifestAt(dir, ref.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      item.blockers.push(`manifest: ${message}`)
      blockers.push(`${ref.id}: ${message}`)
      items.push(item)
      continue
    }
    const signature = await assessPluginSignature(dir, item.manifest, trust, policy)
    item.signature = signature
    item.notes.push(`signature: ${signature.state} (${signature.detail})`)
    if (signature.policy === 'required' && signature.state !== 'trusted') {
      item.blockers.push(`signature ${signature.state}`)
      blockers.push(`${ref.id}: signature ${signature.state} — ${signature.detail}`)
    } else if (signature.policy === 'warn' && signature.state !== 'trusted') {
      warnings.push(`${ref.id}: signature ${signature.state}`)
    }
    const granted = new Set(pack.grants[ref.id]?.permissions ?? [])
    for (const permission of item.manifest.permissions) {
      if (!granted.has(permission)) {
        warnings.push(`${ref.id}: declares "${permission}" but the pack does not grant it`)
      }
    }
    items.push(item)
  }

  return { pack, packDir, policy, items, blockers, warnings, ready: blockers.length === 0 }
}

interface CopyCounter {
  files: number
  bytes: number
}

async function copyTree(src: string, dest: string, counter: CopyCounter, depth = 0): Promise<void> {
  if (depth > 6) throw new Error('plugin directory is nested more deeply than 6 levels')
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to, counter, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(from)
    counter.files += 1
    counter.bytes += info.size
    if (counter.files > MAX_COPY_FILES) {
      throw new Error(`plugin ships more than ${MAX_COPY_FILES} files; bundle it first`)
    }
    if (counter.bytes > MAX_COPY_BYTES) {
      throw new Error(`plugin ships more than ${MAX_COPY_BYTES} bytes; bundle it first`)
    }
    await writeFile(to, await readFile(from))
  }
}

async function readGrantsFile(workspace: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(
      await readFile(join(workspace, PLUGINS_DIR, 'grants.json'), 'utf8'),
    ) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

export interface InstallSolutionResult {
  solutionId: string
  installed: string[]
  lockPath: string
  warnings: string[]
}

/**
 * Copy the pack's plugins into the workspace, register its trust anchors and
 * record a lock. Installing over an existing plugin replaces it, which is how
 * a vendor ships an update; `solution verify` then tells the customer whether
 * the files still match what was signed.
 */
export async function installSolution(
  workspace: string,
  packDir: string,
  options: { acceptPermissions?: boolean; policy?: SignaturePolicy } = {},
): Promise<InstallSolutionResult> {
  const plan = await planSolution(workspace, packDir, { policy: options.policy })
  if (!plan.ready) {
    throw new Error(`方案包 ${plan.pack.id} 无法安装：\n- ${plan.blockers.join('\n- ')}`)
  }
  const needsPermission = Object.values(plan.pack.grants).some(
    (grant) => grant.permissions.length > 0,
  )
  if (needsPermission && !options.acceptPermissions) {
    throw new Error('this pack asks for permissions; re-run with --accept-permissions after reviewing them')
  }

  const pluginsRoot = join(workspace, PLUGINS_DIR)
  await mkdir(pluginsRoot, { recursive: true })
  const installed: string[] = []
  for (const item of plan.items) {
    const dest = join(pluginsRoot, item.id)
    await rm(dest, { recursive: true, force: true })
    await copyTree(item.dir, dest, { files: 0, bytes: 0 })
    installed.push(item.id)
  }

  if (plan.pack.trust.length > 0) {
    const current = await readTrustStore(workspace)
    const merged = [...current.keys]
    for (const anchor of await packTrust(plan.pack)) {
      if (!merged.some((key) => key.keyId === anchor.keyId)) {
        merged.push({ ...anchor, addedAt: new Date().toISOString() })
      }
    }
    await writeFile(
      join(pluginsRoot, 'trusted-keys.json'),
      `${JSON.stringify({ keys: merged }, null, 2)}\n`,
      'utf8',
    )
  }

  const grants = await readGrantsFile(workspace)
  for (const plugin of plan.items) {
    const grant = plan.pack.grants[plugin.id]
    grants[plugin.id] = {
      enabled: grant?.enabled ?? true,
      permissions: grant?.permissions ?? [],
    }
  }
  await writeFile(join(pluginsRoot, 'grants.json'), `${JSON.stringify(grants, null, 2)}\n`, 'utf8')

  const lock: SolutionLock = {
    api: SOLUTION_API_VERSION,
    solutionId: plan.pack.id,
    version: plan.pack.version,
    vendor: plan.pack.vendor,
    installedAt: new Date().toISOString(),
    plugins: plan.items.map((item) => ({
      id: item.id,
      digest: item.signature?.digest ?? '',
      keyId: item.signature?.keyId ?? null,
      state: item.signature?.state ?? 'unknown',
    })),
  }
  const lockPath = join(pluginsRoot, SOLUTION_LOCK_FILE)
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

  return { solutionId: plan.pack.id, installed, lockPath, warnings: plan.warnings }
}

/**
 * Compare the installed plugins against the lock written at install time.
 * A non-empty `drifted` list means someone edited installed code (source-level
 * tuning, a hotfix) or a partial upgrade happened.
 */
export async function verifySolutionLock(workspace: string): Promise<SolutionDrift> {
  const lockPath = join(workspace, PLUGINS_DIR, SOLUTION_LOCK_FILE)
  let lock: SolutionLock
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8')) as SolutionLock
  } catch {
    return { found: false, solutionId: '', version: '', items: [], drifted: [] }
  }
  const policy = await readSignaturePolicy(workspace)
  const trust = await readTrustStore(workspace)
  const items: SolutionDriftItem[] = []
  const drifted: string[] = []
  for (const entry of Array.isArray(lock.plugins) ? lock.plugins : []) {
    const dir = join(workspace, PLUGINS_DIR, entry.id)
    let current = ''
    let signature: PluginSignature | null = null
    let detail = ''
    try {
      const manifest = await readManifestAt(dir, entry.id)
      current = await computePluginDigest(dir, manifest)
      signature = await assessPluginSignature(dir, manifest, trust, policy)
      detail = signature.detail
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    const drift = current !== entry.digest
    if (drift) drifted.push(entry.id)
    items.push({ ...entry, current, drift, signature, detail })
  }
  return {
    found: true,
    solutionId: lock.solutionId,
    version: lock.version,
    items,
    drifted,
  }
}
