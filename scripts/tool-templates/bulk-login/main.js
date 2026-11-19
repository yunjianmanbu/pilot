'use strict'

// Bulk login for an AUTHORIZED test environment only.
// Reads one JSON object on stdin, writes a JSON summary on stdout.
// Never prints passwords or tokens; never defeats a captcha.

const MAX_ACCOUNTS = 500
const MAX_CONCURRENCY = 8
const MAX_RPS = 20
const MIN_RPS = 0.2
const REQUEST_TIMEOUT_MS = 20_000

function parseTargets() {
  try {
    const value = JSON.parse(process.env.PILOT_TEST_TARGETS || '[]')
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function normalized(value) {
  return String(value || '').replace(/\/$/, '')
}

function isAllowedTarget(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '127.0.0.1' || host === '::1' || host === '[::1]') return true
  const target = normalized(url.toString())
  return parseTargets().some((entry) => {
    const base = normalized(entry)
    return target === base || target.startsWith(base + '/')
  })
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

async function loginOne(options, account) {
  const body = {
    [options.usernameField]: account.username,
    [options.passwordField]: account.password,
  }
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (options.captcha) {
    const mode = process.env.PILOT_TEST_CAPTCHA_MODE || 'off'
    const value = process.env.PILOT_TEST_CAPTCHA || ''
    if (mode === 'header' && value) {
      headers[process.env.PILOT_TEST_CAPTCHA_HEADER || 'X-Pilot-Test-Captcha'] = value
    } else if (mode === 'fixture' && value) {
      body[options.captchaField] = value
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${options.baseUrl}${options.loginPath}`, {
      method: options.method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    })
    const text = await response.text().catch(() => '')
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }
    const explicitFailure =
      payload && typeof payload === 'object' && (payload.success === false || payload.ok === false)
    const ok = response.ok && !explicitFailure
    return {
      username: account.username,
      ok,
      status: response.status,
      ...(ok ? {} : { error: explicitFailure ? 'login rejected' : `HTTP ${response.status}` }),
    }
  } catch (error) {
    return {
      username: account.username,
      ok: false,
      status: 0,
      error: error && error.name === 'AbortError' ? 'timeout' : 'request failed',
    }
  } finally {
    clearTimeout(timer)
  }
}

async function run(input) {
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  if (!baseUrl) throw new Error('baseUrl is required')
  if (!isAllowedTarget(baseUrl)) {
    throw new Error(
      'baseUrl is not an authorized test target. Add it in Settings → test targets (localhost is always allowed).',
    )
  }
  const accounts = Array.isArray(input.accounts) ? input.accounts : []
  if (accounts.length === 0) throw new Error('accounts must be a non-empty array')
  if (accounts.length > MAX_ACCOUNTS) {
    throw new Error(`Too many accounts (max ${MAX_ACCOUNTS})`)
  }
  for (const account of accounts) {
    if (
      !account ||
      typeof account.username !== 'string' ||
      typeof account.password !== 'string' ||
      !account.username.trim() ||
      !account.password
    ) {
      throw new Error('Every account needs username and password strings')
    }
  }
  const options = {
    baseUrl: normalized(baseUrl),
    loginPath: typeof input.loginPath === 'string' && input.loginPath.trim()
      ? (input.loginPath.startsWith('/') ? input.loginPath : `/${input.loginPath}`)
      : '/login',
    method: input.method === 'PUT' ? 'PUT' : 'POST',
    usernameField: typeof input.usernameField === 'string' && input.usernameField.trim()
      ? input.usernameField.trim()
      : 'username',
    passwordField: typeof input.passwordField === 'string' && input.passwordField.trim()
      ? input.passwordField.trim()
      : 'password',
    captchaField: typeof input.captchaField === 'string' && input.captchaField.trim()
      ? input.captchaField.trim()
      : 'captcha',
    captcha: input.captcha === true,
  }
  const concurrency = Math.round(clampNumber(input.concurrency, 2, 1, MAX_CONCURRENCY))
  const rps = clampNumber(input.requestsPerSecond, 2, MIN_RPS, MAX_RPS)
  const intervalMs = 1000 / rps

  // The schedule is shared by all workers, so the rate cap is global, not
  // per-worker. Credentials stay in memory and are never written out.
  let nextAt = 0
  const gate = async () => {
    const now = Date.now()
    const wait = Math.max(0, nextAt - now)
    nextAt = Math.max(now, nextAt) + intervalMs
    if (wait > 0) await sleep(wait)
  }

  const results = new Array(accounts.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= accounts.length) return
      await gate()
      results[index] = await loginOne(options, accounts[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker))

  const succeeded = results.filter((entry) => entry && entry.ok).length
  return {
    total: accounts.length,
    succeeded,
    failed: accounts.length - succeeded,
    results,
  }
}

if (require.main === module) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    raw += chunk
  })
  process.stdin.on('end', () => {
    let input
    try {
      input = JSON.parse(raw || '{}')
    } catch {
      process.stderr.write('Invalid JSON arguments\n')
      process.exit(2)
    }
    run(input)
      .then((summary) => {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
      })
      .catch((error) => {
        process.stderr.write(`${error && error.message ? error.message : String(error)}\n`)
        process.exit(1)
      })
  })
}

module.exports = { run }
