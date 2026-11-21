#!/usr/bin/env node
/**
 * Retail loyalty plugin — the vertical-solution example.
 *
 * Same protocol as every Pilot plugin: one JSON object per line on
 * stdin/stdout (`plugin.activate`, `plugin.session`, `plugin.request`).
 * The host has already enforced the route's `auth`/`permission` before it
 * forwards a request, so handlers here only deal with business rules.
 *
 * State: `$PILOT_PLUGIN_STATE_DIR/loyalty.json` (mode 0600). Keeping member
 * data out of the workspace tree means a workspace scan or a git commit never
 * picks up customer phone numbers.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const STATE_DIR = process.env.PILOT_PLUGIN_STATE_DIR || '.'
const STORE_FILE = join(STATE_DIR, 'loyalty.json')
const PHONE_PATTERN = /^\+?\d{6,15}$/
const MAX_REDEEM = 10_000

let state = { members: {} }

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(STORE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.members && typeof parsed.members === 'object') {
      state = { members: parsed.members }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function saveState() {
  await mkdir(STATE_DIR, { recursive: true })
  const temp = `${STORE_FILE}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, STORE_FILE)
}

function phoneOf(body) {
  const phone = body && typeof body.phone === 'string' ? body.phone.trim() : ''
  if (!PHONE_PATTERN.test(phone)) throw new HttpError(400, 'phone must be 6-15 digits')
  return phone
}

function memberOf(phone) {
  const member = state.members[phone]
  if (!member) throw new HttpError(404, `no member ${phone}`)
  return member
}

const ROUTES = {
  'POST enroll': async (body) => {
    const phone = phoneOf(body)
    if (!state.members[phone]) {
      state.members[phone] = { phone, points: 0, joinedAt: new Date().toISOString() }
      await saveState()
    }
    return { status: 201, body: state.members[phone] }
  },
  'GET points': async (body, actor, query) => {
    const phone = phoneOf(query)
    const member = memberOf(phone)
    return { status: 200, body: { ...member, pointValueCents: Math.round(member.points * 0.5) } }
  },
  'POST redeem': async (body, actor) => {
    const phone = phoneOf(body)
    const points = Number(body.points)
    if (!Number.isInteger(points) || points <= 0 || points > MAX_REDEEM) {
      throw new HttpError(400, `points must be an integer between 1 and ${MAX_REDEEM}`)
    }
    const member = memberOf(phone)
    if (member.points < points) throw new HttpError(409, 'not enough points')
    member.points -= points
    await saveState()
    return {
      status: 200,
      body: { ...member, redeemed: points, orderId: `R-${Date.now()}-${phone.slice(-4)}`, by: actor ? actor.subject : null },
    }
  },
}

async function handleRequest(params) {
  const route = params.route || {}
  const body = params.body || {}
  const handler = ROUTES[`${route.method} ${route.path}`]
  if (!handler) throw new HttpError(404, `no handler for ${route.method} ${route.path}`)
  return handler(body, params.session || null, params.query || {})
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function replyError(id, error) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: error.status || 500, message: error.message || 'plugin error' },
    })}\n`,
  )
}

async function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  try {
    if (method === 'plugin.activate') {
      await loadState()
      return reply(id, { ok: true, members: Object.keys(state.members).length })
    }
    if (method === 'plugin.session') return reply(id, null)
    if (method === 'plugin.request') {
      const result = await handleRequest(params || {})
      return reply(id, result)
    }
    return reply(id, null)
  } catch (error) {
    replyError(id, error)
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
