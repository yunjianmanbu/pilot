import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'

/**
 * External plugin manifests.
 *
 * A plugin is a directory under `<workspace>/.pilot/plugins/<id>/` holding a
 * `plugin.json` plus a Node entry file. The host never imports plugin code into
 * the Electron main process: the entry file runs in its own child process and
 * talks to the host over newline-delimited JSON-RPC (see `runtime.ts`). That is
 * the same isolation boundary the MCP and dynamic-tool subsystems already use.
 */
export const PLUGIN_API_VERSION = 1
export const PLUGINS_DIR = join('.pilot', 'plugins')
export const PLUGIN_MANIFEST_FILE = 'plugin.json'
export const PLUGIN_HTTP_PREFIX = '/api/plugins'

export const MAX_PLUGINS = 16
export const MAX_ROUTES_PER_PLUGIN = 24
export const MAX_MANIFEST_BYTES = 64 * 1024
export const MAX_ROLES_PER_PLUGIN = 8
export const MAX_PERMISSIONS_PER_PLUGIN = 32

export const DEFAULT_PLUGIN_TIMEOUT_MS = 5_000
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
/** `users:read`, `users:*`, `auth:session-read`. */
const PERMISSION_PATTERN = /^[a-z][a-z0-9-]{0,31}:[a-z0-9*][a-z0-9*-]{0,31}$/
/** One path segment: `login`, `set-role`. Deeper nesting is a v2 concern. */
const ROUTE_PATH_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
const ENTRY_PATTERN = /\.(mjs|cjs|js)$/
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
const AUTH_MODES = new Set(['public', 'required'])

export type PluginMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginManifestError'
  }
}

export interface PluginRoute {
  method: PluginMethod
  path: string
  /** `public` routes are reachable without a session (login, register). */
  auth: 'public' | 'required'
  /** Permission the caller's session must carry. */
  permission: string | null
  description: string
}

export interface PluginRole {
  id: string
  permissions: string[]
}

export interface PluginLimits {
  timeoutMs: number
  rateLimitPerMinute: number
  maxBodyBytes: number
}

export interface PluginManifest {
  id: string
  name: string
  version: number
  api: number
  runtime: 'node'
  entry: string
  description: string
  /** Capabilities the plugin declares it needs; surfaced before enabling it. */
  permissions: string[]
  /** `session` makes this plugin the authentication provider for the others. */
  provides: 'session' | null
  roles: PluginRole[]
  routes: PluginRoute[]
  limits: PluginLimits
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginManifestError(`${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PluginManifestError(`${what} must be a non-empty string`)
  }
  if (value.length > max) throw new PluginManifestError(`${what} is longer than ${max} characters`)
  return value.trim()
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, number))
}

function parsePermissions(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new PluginManifestError(`${what} must be an array`)
  if (value.length > MAX_PERMISSIONS_PER_PLUGIN) {
    throw new PluginManifestError(`${what} has more than ${MAX_PERMISSIONS_PER_PLUGIN} entries`)
  }
  const seen = new Set<string>()
  for (const entry of value) {
    const permission = asString(entry, `${what}[]`, 64)
    if (!PERMISSION_PATTERN.test(permission)) {
      throw new PluginManifestError(
        `${what} entry "${permission}" must look like "namespace:action" (for example users:read)`,
      )
    }
    seen.add(permission)
  }
  return [...seen]
}

function parseEntry(value: unknown): string {
  const entry = asString(value, 'entry')
  // Windows drive paths ("C:/evil.mjs") are not absolute on POSIX, so a
  // manifest that escapes via a drive letter would only be caught on Windows.
  if (isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry)) {
    throw new PluginManifestError('entry must be relative to the plugin directory')
  }
  const normalized = normalize(entry)
  if (normalized.includes('..')) {
    throw new PluginManifestError('entry must not escape the plugin directory')
  }
  if (!ENTRY_PATTERN.test(normalized)) {
    throw new PluginManifestError('entry must be a .js, .mjs or .cjs file')
  }
  return normalized.replace(/\\/g, '/')
}

function parseRoute(value: unknown, index: number): PluginRoute {
  const record = asRecord(value, `routes[${index}]`)
  const method = asString(record.method, `routes[${index}].method`, 8).toUpperCase()
  if (!METHODS.has(method)) {
    throw new PluginManifestError(`routes[${index}].method must be one of GET, POST, PUT, DELETE`)
  }
  const path = asString(record.path, `routes[${index}].path`, 64)
  if (!ROUTE_PATH_PATTERN.test(path)) {
    throw new PluginManifestError(
      `routes[${index}].path must be a single lowercase segment such as "login"`,
    )
  }
  const auth = record.auth === undefined ? 'required' : asString(record.auth, `routes[${index}].auth`, 16)
  if (!AUTH_MODES.has(auth)) {
    throw new PluginManifestError(`routes[${index}].auth must be "public" or "required"`)
  }
  const permission =
    record.permission === undefined || record.permission === null
      ? null
      : asString(record.permission, `routes[${index}].permission`, 64)
  if (permission && !PERMISSION_PATTERN.test(permission)) {
    throw new PluginManifestError(`routes[${index}].permission must look like "namespace:action"`)
  }
  return {
    method: method as PluginMethod,
    path,
    auth: auth as 'public' | 'required',
    permission,
    description: typeof record.description === 'string' ? record.description.slice(0, 200) : '',
  }
}

function parseRoles(value: unknown): PluginRole[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new PluginManifestError('roles must be an array')
  if (value.length > MAX_ROLES_PER_PLUGIN) {
    throw new PluginManifestError(`roles has more than ${MAX_ROLES_PER_PLUGIN} entries`)
  }
  const roles: PluginRole[] = []
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const record = asRecord(entry, `roles[${index}]`)
    const id = asString(record.id, `roles[${index}].id`, 32)
    if (!ROLE_PATTERN.test(id)) {
      throw new PluginManifestError(`roles[${index}].id must match ${ROLE_PATTERN.source}`)
    }
    if (seen.has(id)) throw new PluginManifestError(`duplicate role "${id}"`)
    seen.add(id)
    roles.push({ id, permissions: parsePermissions(record.permissions, `roles[${index}].permissions`) })
  })
  return roles
}

/**
 * Validate a raw `plugin.json`. Throws `PluginManifestError` naming the
 * offending field, so the settings panel can show it verbatim.
 */
export function parsePluginManifest(raw: unknown, expectedId?: string): PluginManifest {
  const record = asRecord(raw, 'plugin.json')
  const id = asString(record.id, 'id', 32)
  if (!ID_PATTERN.test(id)) {
    throw new PluginManifestError('id must be 2-32 chars of lowercase letters, digits and dashes')
  }
  if (expectedId && id !== expectedId) {
    throw new PluginManifestError(`id "${id}" does not match the directory name "${expectedId}"`)
  }
  const api = clampInt(record.api, 0, 0, 999)
  if (api !== PLUGIN_API_VERSION) {
    throw new PluginManifestError(
      `api must be ${PLUGIN_API_VERSION}; this build cannot load api ${String(record.api)}`,
    )
  }
  const runtime = record.runtime === undefined ? 'node' : asString(record.runtime, 'runtime', 16)
  if (runtime !== 'node') {
    throw new PluginManifestError('runtime must be "node"; other runtimes are not supported yet')
  }
  const provides =
    record.provides === undefined || record.provides === null
      ? null
      : asString(record.provides, 'provides', 16)
  if (provides !== null && provides !== 'session') {
    throw new PluginManifestError('provides must be "session" when set')
  }
  const routes = record.routes === undefined ? [] : record.routes
  if (!Array.isArray(routes)) throw new PluginManifestError('routes must be an array')
  if (routes.length > MAX_ROUTES_PER_PLUGIN) {
    throw new PluginManifestError(`routes has more than ${MAX_ROUTES_PER_PLUGIN} entries`)
  }
  const parsedRoutes = routes.map((route, index) => parseRoute(route, index))
  const keys = new Set<string>()
  for (const route of parsedRoutes) {
    const key = `${route.method} ${route.path}`
    if (keys.has(key)) throw new PluginManifestError(`duplicate route "${key}"`)
    keys.add(key)
  }
  const limits = record.limits === undefined ? {} : asRecord(record.limits, 'limits')
  return {
    id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name.trim().slice(0, 80) : id,
    version: clampInt(record.version, 1, 1, 1_000_000),
    api,
    runtime: 'node',
    entry: parseEntry(record.entry),
    description: typeof record.description === 'string' ? record.description.slice(0, 400) : '',
    permissions: parsePermissions(record.permissions, 'permissions'),
    provides,
    roles: parseRoles(record.roles),
    routes: parsedRoutes,
    limits: {
      timeoutMs: clampInt(limits.timeoutMs, DEFAULT_PLUGIN_TIMEOUT_MS, 200, 60_000),
      rateLimitPerMinute: clampInt(
        limits.rateLimitPerMinute,
        DEFAULT_RATE_LIMIT_PER_MINUTE,
        1,
        6_000,
      ),
      maxBodyBytes: clampInt(limits.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024, 1024 * 1024),
    },
  }
}

export interface DiscoveredPlugin {
  id: string
  dir: string
  manifest: PluginManifest | null
  /** Manifest problem, shown instead of the plugin so a bad file never loads. */
  error: string | null
}

/**
 * Scan `<root>/.pilot/plugins` for plugin directories. A missing directory means
 * "no plugins installed", which is not an error.
 */
export async function loadPluginManifests(root: string): Promise<DiscoveredPlugin[]> {
  const base = join(root, PLUGINS_DIR)
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PLUGINS)
  const plugins: DiscoveredPlugin[] = []
  for (const dir of dirs) {
    const absolute = join(base, dir.name)
    const file = join(absolute, PLUGIN_MANIFEST_FILE)
    try {
      const info = await stat(file)
      if (info.size > MAX_MANIFEST_BYTES) {
        throw new PluginManifestError(`${PLUGIN_MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES} bytes`)
      }
      const text = await readFile(file, 'utf8')
      plugins.push({
        id: dir.name,
        dir: absolute,
        manifest: parsePluginManifest(JSON.parse(text), dir.name),
        error: null,
      })
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'SyntaxError'
          ? `${PLUGIN_MANIFEST_FILE} is not valid JSON`
          : error instanceof Error
            ? error.message
            : String(error)
      plugins.push({ id: dir.name, dir: absolute, manifest: null, error: message })
    }
  }
  return plugins
}
