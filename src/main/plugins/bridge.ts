import { PLUGIN_HTTP_PREFIX, type PluginManifest } from './manifest'
import { permissionAllows, PluginError, type PluginHost, type PluginSession } from './runtime'

/**
 * HTTP bridge for external plugins.
 *
 * Every plugin route is exposed as `POST|GET|PUT|DELETE /api/plugins/<id>/<path>`
 * on whatever HTTP surface embeds Pilot (the companion server today, `pilot
 * serve` and any reverse proxy in front of it). The bridge is deliberately
 * transport-only: it enforces the manifest's `auth`/`permission` declarations
 * before the plugin process is called, so a plugin cannot accidentally expose
 * a privileged route.
 */
export interface PluginHttpInit {
  method: string
  url: string
  headers: NodeJS.Dict<string | string[]>
  /** Read the request body, refusing anything larger than the given limit. */
  readBody(limit: number): Promise<string>
}

export interface PluginHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): PluginHttpResponse {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body) }
}

function errorResponse(
  status: number,
  error: string,
  message: string,
  extra: Record<string, string> = {},
): PluginHttpResponse {
  return jsonResponse(status, { ok: false, error, message }, extra)
}

function headerValue(headers: NodeJS.Dict<string | string[]>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    if (typeof value === 'string') return value
    if (Array.isArray(value) && value.length > 0) return value[0] ?? null
  }
  return null
}

/** Bearer token, `x-pilot-session` header, or the `pilot_session` cookie. */
export function sessionTokenFrom(headers: NodeJS.Dict<string | string[]>): string | null {
  const authorization = headerValue(headers, 'authorization')
  if (authorization) {
    const match = /^bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1].trim()
  }
  const direct = headerValue(headers, 'x-pilot-session')
  if (direct?.trim()) return direct.trim()
  const cookie = headerValue(headers, 'cookie')
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === 'pilot_session') return decodeURIComponent(rest.join('=').trim())
    }
  }
  return null
}

/** Metadata safe to expose before authentication: no config, no grants. */
function publicMetadata(manifest: PluginManifest, enabled: boolean): Record<string, unknown> {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    enabled,
    providesSession: manifest.provides === 'session',
    roles: manifest.roles.map((role) => role.id),
    routes: manifest.routes.map((route) => ({
      method: route.method,
      path: `${PLUGIN_HTTP_PREFIX}/${manifest.id}/${route.path}`,
      auth: route.auth,
      permission: route.permission,
      description: route.description,
    })),
  }
}

function statusFor(error: PluginError): string {
  switch (error.status) {
    case 400:
      return 'bad-request'
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not-found'
    case 405:
      return 'method-not-allowed'
    case 429:
      return 'rate-limited'
    case 503:
      return 'unavailable'
    case 504:
      return 'timeout'
    default:
      return 'plugin-error'
  }
}

/**
 * Handle a request whose path lies under `/api/plugins`. Returns `null` when the
 * path is unrelated so the caller can fall through to its own routes.
 */
export async function handlePluginHttp(
  host: PluginHost,
  init: PluginHttpInit,
): Promise<PluginHttpResponse | null> {
  const url = new URL(init.url || '/', 'http://pilot.local')
  if (url.pathname !== PLUGIN_HTTP_PREFIX && !url.pathname.startsWith(`${PLUGIN_HTTP_PREFIX}/`)) {
    return null
  }
  const method = (init.method || 'GET').toUpperCase()
  const segments = url.pathname
    .slice(PLUGIN_HTTP_PREFIX.length)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))
  const id = segments[0]
  const routePath = segments[1] ?? null

  try {
    // GET /api/plugins — discovery for the phone app and the login screen.
    if (!id) {
      if (method !== 'GET' && method !== 'HEAD') {
        return errorResponse(405, 'method-not-allowed', 'use GET', { allow: 'GET, HEAD' })
      }
      const status = await host.status()
      return jsonResponse(200, {
        ok: true,
        prefix: PLUGIN_HTTP_PREFIX,
        providers: status.plugins.filter((plugin) => plugin.providesSession && plugin.enabled).map((plugin) => plugin.id),
        plugins: status.plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          description: plugin.description,
          enabled: plugin.enabled,
          providesSession: plugin.providesSession,
          routes: plugin.routes.map((route) => ({
            method: route.method,
            path: `${PLUGIN_HTTP_PREFIX}/${plugin.id}/${route.path}`,
            auth: route.auth,
            permission: route.permission,
          })),
        })),
        invalid: status.invalid,
      })
    }

    const manifest = await host.manifest(id)
    if (!routePath) {
      if (method !== 'GET' && method !== 'HEAD') {
        return errorResponse(405, 'method-not-allowed', 'use GET', { allow: 'GET, HEAD' })
      }
      return jsonResponse(200, { ok: true, plugin: publicMetadata(manifest, true) })
    }
    if (segments.length > 2) {
      return errorResponse(404, 'not-found', 'plugin routes have exactly one path segment')
    }
    const route = manifest.routes.find((entry) => entry.path === routePath)
    if (!route) {
      return errorResponse(404, 'not-found', `plugin ${id} has no route "${routePath}"`)
    }
    if (route.method !== method) {
      return errorResponse(405, 'method-not-allowed', `route "${routePath}" is ${route.method}`, {
        allow: route.method,
      })
    }

    const token = sessionTokenFrom(init.headers)
    const session: PluginSession | null = await host.session(token)
    if (route.auth === 'required' && !session) {
      return errorResponse(401, 'unauthorized', 'a session token is required', {
        'www-authenticate': 'Bearer',
      })
    }
    if (route.permission) {
      if (!session) {
        return errorResponse(401, 'unauthorized', 'a session token is required', {
          'www-authenticate': 'Bearer',
        })
      }
      if (!permissionAllows(session.permissions, route.permission)) {
        return errorResponse(403, 'forbidden', `session lacks permission ${route.permission}`)
      }
    }

    let body: unknown = null
    if (method !== 'GET') {
      const limit = host.bodyLimit(manifest)
      const raw = await init.readBody(limit)
      if (raw.length > limit) {
        return errorResponse(413, 'payload-too-large', `body limit is ${limit} bytes`)
      }
      if (raw.trim()) {
        try {
          body = JSON.parse(raw)
        } catch {
          return errorResponse(400, 'bad-request', 'body must be JSON')
        }
      }
    }
    const result = await host.request(id, {
      route: { method: route.method, path: route.path },
      session,
      token,
      body,
      query: Object.fromEntries(url.searchParams),
    })
    return jsonResponse(result.status, result.body)
  } catch (error) {
    if (error instanceof PluginError) {
      return errorResponse(error.status, statusFor(error), error.message)
    }
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(500, 'plugin-error', message)
  }
}
