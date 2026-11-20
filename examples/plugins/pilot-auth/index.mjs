#!/usr/bin/env node
/**
 * Pilot auth plugin (reference implementation).
 *
 * Protocol: one JSON object per line on stdin/stdout.
 *   host -> plugin  { jsonrpc, id, method, params }
 *   plugin -> host  { jsonrpc, id, result } | { jsonrpc, id, error: { code, message } }
 *
 * Methods handled: plugin.activate, plugin.session, plugin.request.
 * State lives in $PILOT_PLUGIN_STATE_DIR/auth.json (mode 0600), never in the
 * workspace tree, so credentials are not picked up by workspace scans.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const PASSWORD_MIN = 8
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const NAME_MAX = 60

const state = { roles: [], users: [], sessions: [] }
let storeFile = null
let rolesById = new Map()

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(storeFile, 'utf8'))
    state.users = Array.isArray(raw.users) ? raw.users : []
    state.sessions = Array.isArray(raw.sessions) ? raw.sessions : []
  } catch {
    state.users = []
    state.sessions = []
  }
  const now = Date.now()
  state.sessions = state.sessions.filter((session) => Date.parse(session.expiresAt) > now)
}

async function saveState() {
  const temp = `${storeFile}.tmp`
  await writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, storeFile)
}

function rolePermissions(roleIds) {
  const permissions = new Set()
  for (const roleId of roleIds) {
    const role = rolesById.get(roleId)
    if (!role) continue
    for (const permission of role.permissions) permissions.add(permission)
  }
  return [...permissions]
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roles: user.roles,
    createdAt: user.createdAt,
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'email is required')
  const email = value.trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'email looks invalid')
  return email
}

function normalizeName(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return value.trim().slice(0, NAME_MAX)
}

function checkPassword(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN) {
    throw new HttpError(400, `password must be at least ${PASSWORD_MIN} characters`)
  }
  return value
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password, user) {
  const expected = Buffer.from(user.passwordHash, 'hex')
  const actual = Buffer.from(hashPassword(password, user.salt), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function newToken() {
  return randomBytes(32).toString('base64url')
}

function defaultRole() {
  if (rolesById.has('member')) return 'member'
  const first = state.roles[0]
  return first ? first.id : 'member'
}

async function issueSession(user) {
  const token = newToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  state.sessions = state.sessions.filter((session) => session.userId !== user.id)
  state.sessions.push({ token, userId: user.id, expiresAt })
  await saveState()
  return { token, expiresAt }
}

function findByToken(token) {
  if (typeof token !== 'string' || !token) return null
  const session = state.sessions.find((entry) => entry.token === token)
  if (!session) return null
  if (Date.parse(session.expiresAt) <= Date.now()) return null
  const user = state.users.find((entry) => entry.id === session.userId)
  if (!user) return null
  return { session, user }
}

/** Resolve the host's session request into identity + permissions. */
function resolveSession(params) {
  const found = findByToken(params && params.token)
  if (!found) return null
  return {
    subject: found.user.id,
    roles: [...found.user.roles],
    permissions: rolePermissions(found.user.roles),
    expiresAt: found.session.expiresAt,
    profile: { email: found.user.email, name: found.user.name },
  }
}

async function handleRegister(body) {
  const email = normalizeEmail(body && body.email)
  const password = checkPassword(body && body.password)
  if (state.users.some((user) => user.email === email)) {
    throw new HttpError(409, 'this email is already registered')
  }
  const salt = randomBytes(16).toString('hex')
  const roles = [state.users.length === 0 ? (rolesById.has('owner') ? 'owner' : defaultRole()) : defaultRole()]
  const user = {
    id: randomBytes(8).toString('hex'),
    email,
    name: normalizeName(body && body.name, email.split('@')[0] || 'user'),
    salt,
    passwordHash: hashPassword(password, salt),
    roles,
    createdAt: new Date().toISOString(),
  }
  state.users.push(user)
  await saveState()
  const issued = await issueSession(user)
  return {
    status: 201,
    body: { user: publicUser(user), token: issued.token, expiresAt: issued.expiresAt },
  }
}

async function handleLogin(body) {
  const email = normalizeEmail(body && body.email)
  const password = typeof body?.password === 'string' ? body.password : ''
  const user = state.users.find((entry) => entry.email === email)
  if (!user || !verifyPassword(password, user)) {
    // Same message for unknown user and wrong password.
    throw new HttpError(401, 'email or password is incorrect')
  }
  const issued = await issueSession(user)
  return {
    status: 200,
    body: { user: publicUser(user), token: issued.token, expiresAt: issued.expiresAt },
  }
}

async function handleLogout(body, actor) {
  const token = typeof body?.token === 'string' && body.token ? body.token : actor?.token
  if (!token) throw new HttpError(400, 'token is required')
  state.sessions = state.sessions.filter((session) => session.token !== token)
  await saveState()
  return { status: 200, body: { ok: true } }
}

function handleMe(body, actor) {
  if (!actor) throw new HttpError(401, 'not signed in')
  const user = state.users.find((entry) => entry.id === actor.subject)
  if (!user) throw new HttpError(401, 'not signed in')
  return { status: 200, body: { user: publicUser(user), permissions: actor.permissions } }
}

function handleUsers() {
  return { status: 200, body: { users: state.users.map(publicUser) } }
}

async function handleRole(body) {
  const email = normalizeEmail(body && body.email)
  const role = typeof body?.role === 'string' ? body.role.trim() : ''
  if (!rolesById.has(role)) {
    throw new HttpError(400, `unknown role "${role}"; known roles: ${[...rolesById.keys()].join(', ')}`)
  }
  const user = state.users.find((entry) => entry.email === email)
  if (!user) throw new HttpError(404, 'no such user')
  const owners = state.users.filter((entry) => entry.roles.includes('owner'))
  if (user.roles.includes('owner') && owners.length === 1 && role !== 'owner') {
    throw new HttpError(409, 'cannot demote the last owner')
  }
  user.roles = [role]
  await saveState()
  return { status: 200, body: { user: publicUser(user) } }
}

const ROUTES = {
  'POST register': (body) => handleRegister(body),
  'POST login': (body) => handleLogin(body),
  'POST logout': (body, actor) => handleLogout(body, actor),
  'GET me': (body, actor) => handleMe(body, actor),
  'GET users': () => handleUsers(),
  'POST role': (body) => handleRole(body),
}

async function handleRequest(params) {
  const route = params && params.route
  if (!route || typeof route.path !== 'string' || typeof route.method !== 'string') {
    throw new HttpError(400, 'route is required')
  }
  if (route.path === 'logout') {
    // Logout needs the raw bearer token, which only the host can see.
    return handleLogout(params.body, { token: params.token, permissions: params.session ? params.session.permissions : [] })
  }
  const handler = ROUTES[`${route.method} ${route.path}`]
  if (!handler) throw new HttpError(404, `no handler for ${route.method} ${route.path}`)
  const actor = params.session ? { ...params.session, token: params.token } : null
  return handler(params.body || {}, actor)
}

async function handleActivate(params) {
  const plugin = (params && params.plugin) || {}
  state.roles = Array.isArray(plugin.roles) ? plugin.roles : []
  rolesById = new Map(state.roles.map((role) => [role.id, role]))
  const stateDir = params && typeof params.stateDir === 'string' ? params.stateDir : null
  if (!stateDir) throw new Error('stateDir is required')
  await mkdir(stateDir, { recursive: true })
  storeFile = join(stateDir, 'auth.json')
  await loadState()
  return { ok: true, id: plugin.id || 'pilot-auth', users: state.users.length, roles: [...rolesById.keys()] }
}

async function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const id = message && message.id
  const method = message && message.method
  const params = (message && message.params) || {}
  try {
    if (method === 'plugin.activate') return reply(id, await handleActivate(params))
    if (method === 'plugin.session') return reply(id, resolveSession(params))
    if (method === 'plugin.request') return reply(id, await handleRequest(params))
    if (method === 'plugin.deactivate') return reply(id, { ok: true })
    return replyError(id, 400, `unknown method ${String(method)}`)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error && error.status ? error.status : 500
    return replyError(id, status, error instanceof Error ? error.message : String(error))
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) void handleLine(line)
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))
