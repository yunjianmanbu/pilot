import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  loadPluginManifests,
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR,
  PluginManifestError,
  type PluginManifest,
  type PluginRoute,
} from './manifest'
import {
  addTrustedKey,
  assessPluginSignature,
  DEFAULT_SIGNATURE_POLICY,
  readSignaturePolicy,
  readTrustStore,
  removeTrustedKey,
  signatureBlocks,
  type PluginSignature,
  type SignaturePolicy,
  type TrustedKey,
} from './integrity'

/** Anything larger than this from a plugin pipe means the plugin is broken. */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024
const ACTIVATE_TIMEOUT_MS = 15_000
const GRANTS_FILE = 'grants.json'
/** Env entries matching this are never handed to plugin processes. */
const SECRET_ENV_PATTERN = /(api[_-]?key|secret|token|password|credential)/i

export type PluginState = 'stopped' | 'ready' | 'error'

/** A user-approved capability set for one plugin (`grants.json` entry). */
export interface PluginGrant {
  enabled: boolean
  permissions: string[]
  config?: Record<string, unknown>
}

export type PluginGrants = Record<string, PluginGrant>

/** Identity resolved by the session-provider plugin. */
export interface PluginSession {
  subject: string
  roles: string[]
  permissions: string[]
  expiresAt: string | null
  profile?: Record<string, unknown>
}

export interface PluginCallContext {
  route: { method: string; path: string }
  session: PluginSession | null
  body: unknown
  query: Record<string, string>
  /** Raw bearer token, so a plugin can revoke its own session. */
  token?: string | null
}

export interface PluginCallResult {
  status: number
  body: unknown
}

export interface PluginStatus {
  id: string
  name: string
  version: number
  description: string
  enabled: boolean
  granted: string[]
  permissions: string[]
  providesSession: boolean
  routes: PluginRoute[]
  state: PluginState
  lastError: string | null
  calls: number
  /** Signature assessment for this plugin under the workspace policy. */
  signature: PluginSignature | null
}

export interface PluginHostStatus {
  plugins: PluginStatus[]
  /** Directories whose `plugin.json` failed validation. */
  invalid: { id: string; error: string }[]
  /** `off`, `warn` or `required`; see `.pilot/plugins/security.json`. */
  signaturePolicy: SignaturePolicy
}

export class PluginError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message)
    this.name = 'PluginError'
  }
}

export interface PluginHostOptions {
  /** Workspace root holding `.pilot/plugins`. */
  root: string
  /** Per-plugin writable state directory. Defaults to `<root>/.pilot/plugins/.state`. */
  stateRoot?: string
  /** Overrides the manifest `limits.timeoutMs`. */
  timeoutMs?: number
  /** Extra environment for plugin processes. */
  env?: NodeJS.ProcessEnv
  /** Node executable used to start plugin entries. Defaults to this process. */
  nodePath?: string
  /** Overrides `.pilot/plugins/security.json` for embedded hosts and tests. */
  signaturePolicy?: SignaturePolicy
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface PluginRuntime {
  manifest: PluginManifest
  dir: string
  child: ChildProcessWithoutNullStreams | null
  pending: Map<number, PendingCall>
  buffer: string
  ready: boolean
  calls: number[]
  totalCalls: number
  lastError: string | null
}

/**
 * True when `held` satisfies `required`. Supports exact matches, a namespace
 * wildcard (`users:*` covers `users:read`) and the global wildcard `*`.
 */
export function permissionAllows(held: readonly string[], required: string): boolean {
  for (const granted of held) {
    if (granted === '*' || granted === required) return true
    if (granted.endsWith(':*') && required.startsWith(granted.slice(0, -1))) return true
  }
  return false
}

function parseSession(raw: unknown): PluginSession | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
  if (!subject) return null
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 64) : []
  return {
    subject,
    roles: strings(record.roles),
    permissions: strings(record.permissions),
    expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
    profile:
      record.profile && typeof record.profile === 'object' && !Array.isArray(record.profile)
        ? (record.profile as Record<string, unknown>)
        : undefined,
  }
}

function normalizeResult(raw: unknown): PluginCallResult {
  if (!raw || typeof raw !== 'object') {
    throw new PluginError('plugin returned no result object', 502)
  }
  const record = raw as Record<string, unknown>
  const status = typeof record.status === 'number' ? Math.trunc(record.status) : 200
  if (status < 100 || status > 599) {
    throw new PluginError(`plugin returned an invalid status ${status}`, 502)
  }
  return { status, body: record.body ?? null }
}

/**
 * Runs external plugins out of process and routes host calls to them.
 *
 * Transport is one JSON object per line over stdin/stdout. The host sends
 * `plugin.activate`, `plugin.session` (session provider only) and
 * `plugin.request`. A plugin answers `{ id, result }` or `{ id, error }`.
 */
export class PluginHost {
  private manifests = new Map<string, PluginManifest>()
  private invalid: { id: string; error: string }[] = []
  private runtimes = new Map<string, PluginRuntime>()
  private grants: PluginGrants = {}
  private signatures = new Map<string, PluginSignature>()
  private policy: SignaturePolicy = DEFAULT_SIGNATURE_POLICY
  private loaded = false
  private sequence = 0

  constructor(private readonly options: PluginHostOptions) {}

  root(): string {
    return this.options.root
  }

  private stateRoot(): string {
    return this.options.stateRoot ?? join(this.root(), PLUGINS_DIR, '.state')
  }

  /** Re-read plugin directories and grants. Call after installing a plugin. */
  async reload(): Promise<void> {
    const discovered = await loadPluginManifests(this.root())
    this.manifests.clear()
    this.invalid = []
    for (const entry of discovered) {
      if (entry.manifest) this.manifests.set(entry.id, entry.manifest)
      else this.invalid.push({ id: entry.id, error: entry.error ?? 'invalid manifest' })
    }
    this.grants = await this.readGrants()
    this.policy = this.options.signaturePolicy ?? (await readSignaturePolicy(this.root()))
    this.signatures.clear()
    const trust = await readTrustStore(this.root())
    for (const manifest of this.manifests.values()) {
      const dir = join(this.root(), PLUGINS_DIR, manifest.id)
      this.signatures.set(
        manifest.id,
        await assessPluginSignature(dir, manifest, trust, this.policy),
      )
    }
    this.loaded = true
  }

  /** Trust anchors this workspace accepts, plus the active policy. */
  async trustSummary(): Promise<{ policy: SignaturePolicy; keys: TrustedKey[] }> {
    await this.ensureLoaded()
    const store = await readTrustStore(this.root())
    return { policy: this.policy, keys: store.keys }
  }

  /**
   * Trust a vendor key by pasting its public key. Self-signed on purpose: the
   * decision is local, and `pilot plugin trust` is the CLI for it.
   */
  async trustKey(publicKeyPem: string, label?: string): Promise<TrustedKey> {
    const key = await addTrustedKey(this.root(), publicKeyPem, label)
    await this.reload()
    return key
  }

  async revokeKey(keyId: string): Promise<boolean> {
    const removed = await removeTrustedKey(this.root(), keyId)
    if (removed) await this.reload()
    return removed
  }

  signatureOf(id: string): PluginSignature | null {
    return this.signatures.get(id) ?? null
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.reload()
  }

  private async readGrants(): Promise<PluginGrants> {
    const file = join(this.root(), PLUGINS_DIR, GRANTS_FILE)
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const grants: PluginGrants = {}
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue
        const record = value as Record<string, unknown>
        grants[id] = {
          enabled: record.enabled === true,
          permissions: Array.isArray(record.permissions)
            ? record.permissions.filter((item): item is string => typeof item === 'string')
            : [],
          config:
            record.config && typeof record.config === 'object' && !Array.isArray(record.config)
              ? (record.config as Record<string, unknown>)
              : undefined,
        }
      }
      return grants
    } catch {
      return {}
    }
  }

  /** Persist one grant. This is the user-approval step for a plugin. */
  async setGrant(id: string, grant: PluginGrant): Promise<void> {
    await this.ensureLoaded()
    this.grants[id] = grant
    const dir = join(this.root(), PLUGINS_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, GRANTS_FILE), `${JSON.stringify(this.grants, null, 2)}\n`, 'utf8')
    if (!grant.enabled) await this.deactivate(id)
  }

  /** The manifest for `id`, or a 404/400 `PluginError`. */
  async manifest(id: string): Promise<PluginManifest> {
    await this.ensureLoaded()
    const manifest = this.manifests.get(id)
    if (manifest) return manifest
    const broken = this.invalid.find((entry) => entry.id === id)
    if (broken) throw new PluginError(`plugin ${id} is invalid: ${broken.error}`, 400)
    throw new PluginError(`unknown plugin ${id}`, 404)
  }

  private grantFor(id: string): PluginGrant {
    return this.grants[id] ?? { enabled: false, permissions: [] }
  }

  async status(): Promise<PluginHostStatus> {
    await this.ensureLoaded()
    const plugins: PluginStatus[] = []
    for (const manifest of this.manifests.values()) {
      const runtime = this.runtimes.get(manifest.id)
      const grant = this.grantFor(manifest.id)
      plugins.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled: grant.enabled,
        granted: grant.permissions,
        permissions: manifest.permissions,
        providesSession: manifest.provides === 'session',
        routes: manifest.routes,
        state: runtime ? (runtime.lastError ? 'error' : runtime.ready ? 'ready' : 'stopped') : 'stopped',
        lastError: runtime?.lastError ?? null,
        calls: runtime?.totalCalls ?? 0,
        signature: this.signatures.get(manifest.id) ?? null,
      })
    }
    return { plugins, invalid: [...this.invalid], signaturePolicy: this.policy }
  }

  /** Manifest limits win over the host default. */
  bodyLimit(manifest: PluginManifest): number {
    return manifest.limits.maxBodyBytes
  }

  private timeoutFor(manifest: PluginManifest): number {
    return this.options.timeoutMs ?? manifest.limits.timeoutMs
  }

  private childEnv(manifest: PluginManifest, stateDir: string): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (SECRET_ENV_PATTERN.test(key)) continue
      base[key] = value
    }
    return {
      ...base,
      ...this.options.env,
      PILOT_PLUGIN_ID: manifest.id,
      PILOT_PLUGIN_API: String(PLUGIN_API_VERSION),
      PILOT_PLUGIN_STATE_DIR: stateDir,
      PILOT_WORKSPACE_ROOT: this.root(),
    }
  }

  /** Start the plugin process and complete its activation handshake. */
  async activate(id: string): Promise<PluginStatus> {
    const manifest = await this.manifest(id)
    const existing = this.runtimes.get(id)
    if (existing?.ready) return this.statusOf(manifest)
    const signature = this.signatures.get(id)
    if (signatureBlocks(signature)) {
      // Policy `required` refuses unsigned, untrusted and tampered plugins before
      // any plugin code runs, so a modified deployment cannot quietly start.
      throw new PluginError(`plugin ${id} is ${signature?.state}: ${signature?.detail}`, 403)
    }
    const grant = this.grantFor(id)
    if (!grant.enabled) {
      throw new PluginError(
        `plugin ${id} is not enabled; set enabled:true in ${join(PLUGINS_DIR, GRANTS_FILE)}`,
        403,
      )
    }
    const missing = manifest.permissions.filter(
      (permission) => !permissionAllows(grant.permissions, permission),
    )
    if (missing.length) {
      throw new PluginError(
        `plugin ${id} asks for permissions that were not granted: ${missing.join(', ')}`,
        403,
      )
    }
    const dir = join(this.root(), PLUGINS_DIR, manifest.id)
    const stateDir = join(this.stateRoot(), manifest.id)
    await mkdir(stateDir, { recursive: true })
    const entry = join(dir, manifest.entry)
    const child = spawn(this.options.nodePath ?? process.execPath, [entry], {
      cwd: dir,
      env: this.childEnv(manifest, stateDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const runtime: PluginRuntime = {
      manifest,
      dir,
      child,
      pending: new Map(),
      buffer: '',
      ready: false,
      calls: [],
      totalCalls: 0,
      lastError: null,
    }
    this.runtimes.set(id, runtime)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(runtime, chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {
      // Plugin stderr is diagnostic only; the last error surfaces in status().
    })
    child.on('error', (error) => this.fail(runtime, error.message))
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${String(code)}`
      this.fail(runtime, `plugin process exited (${reason})`)
    })
    try {
      await this.invoke(runtime, 'plugin.activate', {
        api: PLUGIN_API_VERSION,
        plugin: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          roles: manifest.roles,
          routes: manifest.routes,
          permissions: manifest.permissions,
        },
        config: grant.config ?? {},
        workspaceRoot: this.root(),
        stateDir,
      }, ACTIVATE_TIMEOUT_MS)
      runtime.ready = true
    } catch (error) {
      this.fail(runtime, error instanceof Error ? error.message : String(error))
      throw error instanceof PluginError ? error : new PluginError(String(error), 502)
    }
    return this.statusOf(manifest)
  }

  private statusOf(manifest: PluginManifest): PluginStatus {
    const runtime = this.runtimes.get(manifest.id)
    const grant = this.grantFor(manifest.id)
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      enabled: grant.enabled,
      granted: grant.permissions,
      permissions: manifest.permissions,
      providesSession: manifest.provides === 'session',
      routes: manifest.routes,
      state: runtime?.ready ? 'ready' : 'stopped',
      lastError: runtime?.lastError ?? null,
      calls: runtime?.totalCalls ?? 0,
      signature: this.signatures.get(manifest.id) ?? null,
    }
  }

  async deactivate(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    this.runtimes.delete(id)
    this.shutdown(runtime, 'plugin deactivated')
  }

  async stopAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()]
    this.runtimes.clear()
    for (const runtime of runtimes) this.shutdown(runtime, 'host stopping')
  }

  private shutdown(runtime: PluginRuntime, reason: string): void {
    runtime.ready = false
    for (const [id, pending] of runtime.pending) {
      clearTimeout(pending.timer)
      runtime.pending.delete(id)
      pending.reject(new PluginError(reason, 503))
    }
    const child = runtime.child
    runtime.child = null
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // already closed
    }
    try {
      child.kill()
    } catch {
      // already gone
    }
  }

  private fail(runtime: PluginRuntime, message: string): void {
    if (runtime.lastError === message && !runtime.child) return
    runtime.lastError = message
    runtime.ready = false
    for (const [id, pending] of runtime.pending) {
      clearTimeout(pending.timer)
      runtime.pending.delete(id)
      pending.reject(new PluginError(`plugin ${runtime.manifest.id}: ${message}`, 502))
    }
    const child = runtime.child
    runtime.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  }

  private onStdout(runtime: PluginRuntime, chunk: string): void {
    runtime.buffer += chunk
    if (runtime.buffer.length > MAX_STDOUT_BYTES) {
      this.fail(runtime, 'plugin wrote more than 2 MB without a newline')
      return
    }
    let index = runtime.buffer.indexOf('\n')
    while (index >= 0) {
      const line = runtime.buffer.slice(0, index).trim()
      runtime.buffer = runtime.buffer.slice(index + 1)
      if (line) this.onMessage(runtime, line)
      index = runtime.buffer.indexOf('\n')
    }
  }

  private onMessage(runtime: PluginRuntime, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.fail(runtime, 'plugin wrote a line that is not JSON')
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const record = parsed as Record<string, unknown>
    const id = typeof record.id === 'number' ? record.id : Number(record.id)
    const pending = runtime.pending.get(id)
    if (!pending) return
    runtime.pending.delete(id)
    clearTimeout(pending.timer)
    const error = record.error as { message?: unknown; code?: unknown } | undefined
    if (error) {
      const message = typeof error.message === 'string' ? error.message : 'plugin call failed'
      const status = typeof error.code === 'number' && error.code >= 400 ? error.code : 502
      pending.reject(new PluginError(message, status))
      return
    }
    pending.resolve(record.result)
  }

  private invoke(
    runtime: PluginRuntime,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const child = runtime.child
    if (!child || !child.stdin.writable) {
      return Promise.reject(new PluginError(`plugin ${runtime.manifest.id} is not running`, 503))
    }
    const id = ++this.sequence
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(id)
        this.fail(runtime, `${method} timed out after ${timeoutMs} ms`)
        reject(new PluginError(`plugin ${runtime.manifest.id} timed out on ${method}`, 504))
      }, timeoutMs)
      timer.unref?.()
      runtime.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        runtime.pending.delete(id)
        clearTimeout(timer)
        reject(new PluginError(error instanceof Error ? error.message : String(error), 502))
      }
    })
  }

  private async ensureReady(id: string): Promise<PluginRuntime> {
    const existing = this.runtimes.get(id)
    if (existing?.ready) return existing
    await this.activate(id)
    const started = this.runtimes.get(id)
    if (!started?.ready) throw new PluginError(`plugin ${id} did not start`, 502)
    return started
  }

  /** Route one HTTP call into a plugin, enforcing its manifest rate limit. */
  async request(id: string, context: PluginCallContext): Promise<PluginCallResult> {
    const runtime = await this.ensureReady(id)
    const manifest = runtime.manifest
    const windowStart = Date.now() - 60_000
    runtime.calls = runtime.calls.filter((stamp) => stamp > windowStart)
    if (runtime.calls.length >= manifest.limits.rateLimitPerMinute) {
      throw new PluginError(`plugin ${id} exceeded ${manifest.limits.rateLimitPerMinute} calls/min`, 429)
    }
    runtime.calls.push(Date.now())
    runtime.totalCalls += 1
    const result = await this.invoke(
      runtime,
      'plugin.request',
      {
        route: context.route,
        method: context.route.method,
        session: context.session,
        token: context.token ?? null,
        body: context.body ?? null,
        query: context.query,
      },
      this.timeoutFor(manifest),
    )
    return normalizeResult(result)
  }

  /** The enabled plugin that owns session resolution, if any. */
  async sessionProvider(): Promise<PluginManifest | null> {
    await this.ensureLoaded()
    for (const manifest of this.manifests.values()) {
      if (manifest.provides !== 'session') continue
      if (this.grantFor(manifest.id).enabled) return manifest
    }
    return null
  }

  /** Resolve a bearer token into a session through the provider plugin. */
  async session(token: string | null): Promise<PluginSession | null> {
    if (!token) return null
    const provider = await this.sessionProvider()
    if (!provider) return null
    let runtime: PluginRuntime
    try {
      runtime = await this.ensureReady(provider.id)
    } catch {
      return null
    }
    try {
      const raw = await this.invoke(
        runtime,
        'plugin.session',
        { token },
        this.timeoutFor(provider),
      )
      return parseSession(raw)
    } catch {
      return null
    }
  }

  /** True when the manifest file on disk is the one this host validated. */
  async manifestPath(id: string): Promise<string | null> {
    const manifest = await this.manifest(id)
    return join(this.root(), PLUGINS_DIR, manifest.id, PLUGIN_MANIFEST_FILE)
  }
}

/** Re-exported so callers can distinguish manifest problems from runtime ones. */
export { PluginManifestError }
