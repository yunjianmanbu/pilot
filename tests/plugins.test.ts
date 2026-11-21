import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_API_VERSION,
  PluginManifestError,
  loadPluginManifests,
  parsePluginManifest,
} from '../src/main/plugins/manifest'
import { PluginError, PluginHost, permissionAllows } from '../src/main/plugins/runtime'
import { handlePluginHttp, sessionTokenFrom } from '../src/main/plugins/bridge'

const cleanups: string[] = []
/** Plugins run as child processes, so Windows keeps the plugin dir locked until
 * every host is stopped. Track them so cleanup cannot race the OS. */
const hosts: PluginHost[] = []

function makeHost(options: { root: string }): PluginHost {
  const host = new PluginHost(options)
  hosts.push(host)
  return host
}

afterEach(async () => {
  while (hosts.length) await hosts.pop()?.stopAll()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-plugins-'))
  cleanups.push(root)
  return root
}

/** Copy the reference auth plugin into a temp workspace. */
async function installAuthPlugin(root: string): Promise<void> {
  const dir = join(root, '.pilot', 'plugins', 'pilot-auth')
  await mkdir(dir, { recursive: true })
  // The example lives inside the repo (examples/plugins/pilot-auth); in the
  // monorepo it sits one level up, so resolve both layouts.
  const candidates = [
    join(__dirname, 'examples', 'plugins', 'pilot-auth'),
    join(__dirname, '..', '..', 'examples', 'plugins', 'pilot-auth'),
  ]
  const source = candidates.find((dir) => existsSync(join(dir, 'plugin.json')))
  if (!source) throw new Error(`pilot-auth example not found: ${candidates.join(' | ')}`)
  for (const file of ['plugin.json', 'index.mjs']) {
    await writeFile(join(dir, file), await readFile(join(source, file), 'utf8'))
  }
}

function minimalManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    api: PLUGIN_API_VERSION,
    entry: 'index.mjs',
    routes: [{ method: 'GET', path: 'ping', auth: 'public' }],
    ...overrides,
  }
}

describe('plugin manifest', () => {
  it('accepts a minimal manifest and fills defaults', () => {
    const manifest = parsePluginManifest(minimalManifest())
    expect(manifest.id).toBe('demo')
    expect(manifest.runtime).toBe('node')
    expect(manifest.version).toBe(1)
    expect(manifest.provides).toBeNull()
    expect(manifest.routes[0]).toEqual({
      method: 'GET',
      path: 'ping',
      auth: 'public',
      permission: null,
      description: '',
    })
    expect(manifest.limits.timeoutMs).toBe(5000)
  })

  it('rejects an entry that escapes the plugin directory', () => {
    expect(() => parsePluginManifest(minimalManifest({ entry: '../../evil.mjs' }))).toThrow(
      PluginManifestError,
    )
    expect(() => parsePluginManifest(minimalManifest({ entry: 'C:/evil.mjs' }))).toThrow(
      /must be relative/,
    )
  })

  it('rejects an unknown api version', () => {
    expect(() => parsePluginManifest(minimalManifest({ api: 2 }))).toThrow(/cannot load api 2/)
  })

  it('rejects permissions that are not namespace:action', () => {
    expect(() => parsePluginManifest(minimalManifest({ permissions: ['read'] }))).toThrow(
      /namespace:action/,
    )
  })

  it('rejects duplicate routes and bad methods', () => {
    expect(() =>
      parsePluginManifest(
        minimalManifest({
          routes: [
            { method: 'GET', path: 'a' },
            { method: 'GET', path: 'a' },
          ],
        }),
      ),
    ).toThrow(/duplicate route/)
    expect(() =>
      parsePluginManifest(minimalManifest({ routes: [{ method: 'PATCH', path: 'a' }] })),
    ).toThrow(/method must be one of/)
  })

  it('rejects nested route paths', () => {
    expect(() =>
      parsePluginManifest(minimalManifest({ routes: [{ method: 'GET', path: 'a/b' }] })),
    ).toThrow(/single lowercase segment/)
  })

  it('reports a directory whose manifest id disagrees with its name', async () => {
    const root = await tempRoot()
    await mkdir(join(root, '.pilot', 'plugins', 'renamed'), { recursive: true })
    await writeFile(
      join(root, '.pilot', 'plugins', 'renamed', 'plugin.json'),
      JSON.stringify(minimalManifest()),
    )
    const discovered = await loadPluginManifests(root)
    expect(discovered).toHaveLength(1)
    expect(discovered[0]?.manifest).toBeNull()
    expect(discovered[0]?.error).toMatch(/does not match the directory name/)
  })

  it('treats a missing plugins directory as no plugins', async () => {
    expect(await loadPluginManifests(await tempRoot())).toEqual([])
  })
})

describe('permission matching', () => {
  it('supports exact, namespace wildcard and global wildcard', () => {
    expect(permissionAllows(['users:read'], 'users:read')).toBe(true)
    expect(permissionAllows(['users:read'], 'users:write')).toBe(false)
    expect(permissionAllows(['users:*'], 'users:write')).toBe(true)
    expect(permissionAllows(['*'], 'anything:at-all')).toBe(true)
    expect(permissionAllows([], 'users:read')).toBe(false)
  })
})

describe('session token extraction', () => {
  it('reads bearer, header and cookie forms', () => {
    expect(sessionTokenFrom({ authorization: 'Bearer abc' })).toBe('abc')
    expect(sessionTokenFrom({ authorization: ['Bearer xyz'] })).toBe('xyz')
    expect(sessionTokenFrom({ 'x-pilot-session': 'hdr' })).toBe('hdr')
    expect(sessionTokenFrom({ cookie: 'a=1; pilot_session=tok%20en; b=2' })).toBe('tok en')
    expect(sessionTokenFrom({})).toBeNull()
  })
})

describe('plugin host', () => {
  it('refuses to start a plugin that was not enabled', async () => {
    const root = await tempRoot()
    await installAuthPlugin(root)
    const host = makeHost({ root })
    await expect(host.activate('pilot-auth')).rejects.toThrow(/not enabled/)
  })

  it('refuses to start a plugin whose declared permissions were not granted', async () => {
    const root = await tempRoot()
    await installAuthPlugin(root)
    const host = makeHost({ root })
    await host.setGrant('pilot-auth', { enabled: true, permissions: ['users:read'] })
    await expect(host.activate('pilot-auth')).rejects.toThrow(/not granted: users:write/)
  })

  it('returns 404 for an unknown plugin id', async () => {
    const host = makeHost({ root: await tempRoot() })
    await expect(host.manifest('nope')).rejects.toMatchObject({ status: 404 })
  })
})

describe('auth plugin over the HTTP bridge', () => {
  async function bootAuth(): Promise<{ host: PluginHost; root: string }> {
    const root = await tempRoot()
    await installAuthPlugin(root)
    const host = makeHost({ root })
    await host.setGrant('pilot-auth', {
      enabled: true,
      permissions: ['users:read', 'users:write'],
    })
    return { host, root }
  }

  async function call(
    host: PluginHost,
    method: string,
    path: string,
    options: { body?: unknown; token?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    const raw = options.body === undefined ? '' : JSON.stringify(options.body)
    const response = await handlePluginHttp(host, {
      method,
      url: path,
      headers,
      readBody: async () => raw,
    })
    expect(response).not.toBeNull()
    return {
      status: response!.status,
      body: JSON.parse(response!.body) as Record<string, unknown>,
    }
  }

  it('registers the first user as owner and returns a token', async () => {
    const { host } = await bootAuth()
    const created = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'Owner@Example.com ', password: 'correct-horse', name: 'Owner' },
    })
    expect(created.status).toBe(201)
    const user = created.body.user as Record<string, unknown>
    expect(user.email).toBe('owner@example.com')
    expect(user.roles).toEqual(['owner'])
    expect(typeof created.body.token).toBe('string')

    const me = await call(host, 'GET', '/api/plugins/pilot-auth/me', {
      token: String(created.body.token),
    })
    expect(me.status).toBe(200)
    expect(me.body.permissions).toEqual(['users:*'])
  })

  it('rejects a duplicate email and a weak password', async () => {
    const { host } = await bootAuth()
    await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'a@b.co', password: 'longenough' },
    })
    const duplicate = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'a@b.co', password: 'longenough' },
    })
    expect(duplicate.status).toBe(409)
    const weak = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'c@d.co', password: 'short' },
    })
    expect(weak.status).toBe(400)
  })

  it('requires a session on protected routes and enforces permissions', async () => {
    const { host } = await bootAuth()
    const anonymous = await call(host, 'GET', '/api/plugins/pilot-auth/users')
    expect(anonymous.status).toBe(401)

    const owner = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'owner@x.io', password: 'longenough' },
    })
    const member = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'member@x.io', password: 'longenough' },
    })
    const memberUser = member.body.user as Record<string, unknown>
    expect(memberUser.roles).toEqual(['member'])

    const memberList = await call(host, 'GET', '/api/plugins/pilot-auth/users', {
      token: String(member.body.token),
    })
    expect(memberList.status).toBe(403)
    expect(memberList.body.message).toMatch(/users:read/)

    const ownerList = await call(host, 'GET', '/api/plugins/pilot-auth/users', {
      token: String(owner.body.token),
    })
    expect(ownerList.status).toBe(200)
    expect(ownerList.body.users as unknown[]).toHaveLength(2)
  })

  it('promotes a member to admin and the new role grants users:read', async () => {
    const { host } = await bootAuth()
    const owner = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'owner@x.io', password: 'longenough' },
    })
    const member = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'member@x.io', password: 'longenough' },
    })
    const promoted = await call(host, 'POST', '/api/plugins/pilot-auth/role', {
      token: String(owner.body.token),
      body: { email: 'member@x.io', role: 'admin' },
    })
    expect(promoted.status).toBe(200)
    const nowAllowed = await call(host, 'GET', '/api/plugins/pilot-auth/users', {
      token: String(member.body.token),
    })
    expect(nowAllowed.status).toBe(200)
  })

  it('refuses to demote the last owner', async () => {
    const { host } = await bootAuth()
    const owner = await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'owner@x.io', password: 'longenough' },
    })
    const demoted = await call(host, 'POST', '/api/plugins/pilot-auth/role', {
      token: String(owner.body.token),
      body: { email: 'owner@x.io', role: 'member' },
    })
    expect(demoted.status).toBe(409)
  })

  it('logs in, rejects a wrong password, and revokes the token on logout', async () => {
    const { host } = await bootAuth()
    await call(host, 'POST', '/api/plugins/pilot-auth/register', {
      body: { email: 'a@b.co', password: 'longenough' },
    })
    const bad = await call(host, 'POST', '/api/plugins/pilot-auth/login', {
      body: { email: 'a@b.co', password: 'wrong-password' },
    })
    expect(bad.status).toBe(401)
    expect(bad.body.message).toBe('email or password is incorrect')

    const good = await call(host, 'POST', '/api/plugins/pilot-auth/login', {
      body: { email: 'a@b.co', password: 'longenough' },
    })
    expect(good.status).toBe(200)
    const token = String(good.body.token)

    const out = await call(host, 'POST', '/api/plugins/pilot-auth/logout', { token })
    expect(out.status).toBe(200)
    const after = await call(host, 'GET', '/api/plugins/pilot-auth/me', { token })
    expect(after.status).toBe(401)
  })

  it('exposes discovery metadata without leaking grants', async () => {
    const { host } = await bootAuth()
    const discovery = await call(host, 'GET', '/api/plugins')
    expect(discovery.status).toBe(200)
    expect(discovery.body.providers).toEqual(['pilot-auth'])
    const plugins = discovery.body.plugins as Array<Record<string, unknown>>
    expect(plugins[0]?.routes).toBeInstanceOf(Array)
    expect(JSON.stringify(discovery.body)).not.toMatch(/grants|passwordHash/)
  })

  it('answers 405 for a wrong method and 404 for an unknown route', async () => {
    const { host } = await bootAuth()
    const wrongMethod = await call(host, 'GET', '/api/plugins/pilot-auth/login')
    expect(wrongMethod.status).toBe(405)
    const unknown = await call(host, 'GET', '/api/plugins/pilot-auth/nope')
    expect(unknown.status).toBe(404)
  })

  it('reports an unreachable plugin as 503 rather than crashing', async () => {
    const root = await tempRoot()
    const dir = join(root, '.pilot', 'plugins', 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify(minimalManifest({ id: 'broken', routes: [{ method: 'GET', path: 'ping', auth: 'public' }] })),
    )
    await writeFile(join(dir, 'index.mjs'), 'process.exit(3)\n')
    const host = makeHost({ root })
    await host.setGrant('broken', { enabled: true, permissions: [] })
    const response = await handlePluginHttp(host, {
      method: 'GET',
      url: '/api/plugins/broken/ping',
      headers: {},
      readBody: async () => '',
    })
    expect(response?.status).toBe(502)
    await host.stopAll()
  })
})

describe('plugin isolation', () => {
  it('tears the child process down on stopAll', async () => {
    const root = await tempRoot()
    await installAuthPlugin(root)
    const host = makeHost({ root })
    await host.setGrant('pilot-auth', { enabled: true, permissions: ['users:read', 'users:write'] })
    await host.activate('pilot-auth')
    const before = await host.status()
    expect(before.plugins[0]?.state).toBe('ready')
    await host.stopAll()
    const after = await host.status()
    expect(after.plugins[0]?.state).toBe('stopped')
    await expect(
      host.request('pilot-auth', {
        route: { method: 'GET', path: 'me' },
        session: null,
        body: null,
        query: {},
      }),
    ).rejects.toBeInstanceOf(PluginError)
  })
})

describe('plugin routes over real HTTP', () => {
  let server: Server | null = null

  afterEach(async () => {
    const current = server
    server = null
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
  })

  async function listen(host: PluginHost): Promise<string> {
    const created = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks).toString('utf8')
        const result = await handlePluginHttp(host, {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers: request.headers,
          readBody: async () => body,
        })
        if (!result) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(result.status, result.headers).end(result.body)
      })().catch((error: unknown) => {
        response.writeHead(500).end(String(error))
      })
    })
    server = created
    await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', () => resolve()))
    const address = created.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  it('registers, authenticates with a bearer token and refuses an escalated call', async () => {
    const root = await tempRoot()
    await installAuthPlugin(root)
    const host = makeHost({ root })
    await host.setGrant('pilot-auth', { enabled: true, permissions: ['users:read', 'users:write'] })
    const base = await listen(host)

    const discovery = await fetch(`${base}/api/plugins`)
    expect(discovery.status).toBe(200)
    const discovered = (await discovery.json()) as { providers: string[] }
    expect(discovered.providers).toEqual(['pilot-auth'])

    const registered = await fetch(`${base}/api/plugins/pilot-auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e2e@example.com', password: 'correct-horse' }),
    })
    expect(registered.status).toBe(201)
    const created = (await registered.json()) as { token: string; user: { roles: string[] } }
    expect(created.user.roles).toEqual(['owner'])

    const me = await fetch(`${base}/api/plugins/pilot-auth/me`, {
      headers: { authorization: `Bearer ${created.token}` },
    })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { permissions: string[] }).permissions).toEqual(['users:*'])

    const anonymous = await fetch(`${base}/api/plugins/pilot-auth/users`)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer')

    const second = await fetch(`${base}/api/plugins/pilot-auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'correct-horse' }),
    })
    const member = (await second.json()) as { token: string }
    const forbidden = await fetch(`${base}/api/plugins/pilot-auth/users`, {
      headers: { authorization: `Bearer ${member.token}` },
    })
    expect(forbidden.status).toBe(403)

    const wrongMethod = await fetch(`${base}/api/plugins/pilot-auth/login`)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const unknown = await fetch(`${base}/api/plugins/pilot-auth/nope`)
    expect(unknown.status).toBe(404)
  })
})
