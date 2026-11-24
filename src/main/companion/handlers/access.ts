// 浏览器直连通道：打开控制台页面的浏览器不需要二维码，直接申请一份一次性接入凭据。
// 本机（回环地址）自动放行；其他机器要等本机浏览器页面点「允许」——判定仍走
// pairing.ts 的同一条批准通道，因此超时、拒绝、终端 allow 的行为完全一致。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createKeyPair, randomLookup, randomSecret } from '../crypto'
import { readRequestBody, wsEndpoint } from '../helpers'
import type { PairingOffer } from '../types'
import type { CompanionServer } from '../server'

/** 页面拿到凭据后必须在这段时间内完成连接，避免留下长期可用的入口。 */
const ACCESS_TTL_MS = 2 * 60_000
/** 反复刷新页面不应无限增长内存；最老的先淘汰。 */
const MAX_ACCESS_OFFERS = 16

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false
  const value = address.replace(/^::ffff:/i, '').trim()
  return value === '::1' || value.startsWith('127.')
}

function pruneAccessOffers(server: CompanionServer): void {
  const now = Date.now()
  for (const [lookup, offer] of server.accessOffers) {
    if (offer.expiresAt <= now) server.accessOffers.delete(lookup)
  }
  while (server.accessOffers.size >= MAX_ACCESS_OFFERS) {
    const oldest = server.accessOffers.keys().next()
    if (oldest.done) break
    server.accessOffers.delete(oldest.value)
  }
}

function sanitizeHost(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  if (!value || value.length > 80) return ''
  if (!/^[A-Za-z0-9\-._:[\]]+$/.test(value)) return ''
  return value
}

/**
 * 页面自报的期望身份，只能当作审批页的**默认选项**用。
 *
 * 远端页面在 URL 里写 `role=host` 不等于拿到主机权限：审批页可以改成客户机，
 * 审批页没得选时（终端 `allow`）也按请求里的值决定，而旧页面根本不带这个参数，
 * 因此缺省永远是权限更小的 `client`。
 */
function requestedRole(raw: string | null | undefined): 'host' | 'client' {
  return String(raw ?? '').trim().toLowerCase() === 'host' ? 'host' : 'client'
}

/**
 * The page knows which address it was opened with, so reuse that host instead of
 * the listening address: a port forward or a LAN hostname still reaches this
 * process. `--public-url` wins because it is the address other people use.
 */
function accessRelayUrl(server: CompanionServer, request: IncomingMessage): string {
  const publicBase = server.publicBaseUrl()
  if (publicBase) return wsEndpoint(publicBase)
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim()
    .toLowerCase()
  const secure = forwarded === 'https' || Boolean((request.socket as { encrypted?: boolean }).encrypted)
  const host =
    sanitizeHost(request.headers.host) ||
    `${server.addressHost()}:${server.listeningPort()}`
  return `${secure ? 'wss' : 'ws'}://${host}/ws`
}

export interface AccessGrant {
  payload: Record<string, unknown>
  /** 回环地址签发即放行；其他来源要等本机页面批准。 */
  local: boolean
  /** 回环地址是 `host`；远端是页面自报的期望值，审批前不代表权限。 */
  role: 'host' | 'client'
  expiresAt: string
}

export function issueAccessOffer(
  server: CompanionServer,
  request: IncomingMessage,
  role?: 'host' | 'client',
): AccessGrant {
  pruneAccessOffers(server)
  const local = isLoopbackAddress(request.socket.remoteAddress)
  const keyPair = createKeyPair()
  const lookup = randomLookup()
  const secret = randomSecret(16)
  const offer: PairingOffer = {
    lookup,
    secret,
    keys: keyPair,
    expiresAt: Date.now() + ACCESS_TTL_MS,
    room: '',
    roomKey: '',
    autoApprove: local,
    viaAccess: true,
    // 回环地址就是本机，直接是主机；远端只记下它想要什么，等审批定。
    role: local ? 'host' : (role ?? 'client'),
  }
  server.accessOffers.set(lookup, offer)
  const payload: Record<string, unknown> = {
    v: 1,
    r: accessRelayUrl(server, request),
    d: server.state.deviceId,
    k: lookup,
    s: secret,
    p: keyPair.publicBase64,
    n: server.options.deviceName,
  }
  return { payload, local, role: offer.role ?? 'client', expiresAt: new Date(offer.expiresAt).toISOString() }
}

export function takeAccessOffer(
  server: CompanionServer,
  lookup: string,
): PairingOffer | null {
  const offer = server.accessOffers.get(lookup)
  if (!offer) return null
  if (offer.expiresAt <= Date.now()) {
    server.accessOffers.delete(lookup)
    return null
  }
  return offer
}

/**
 * A QR offer lives in one slot; a page offer lives in the map. Both must stay
 * answerable while the approval prompt is open.
 */
export function offerAlive(server: CompanionServer, offer: PairingOffer): boolean {
  if (offer.expiresAt <= Date.now()) return false
  if (server.offer === offer) return true
  return server.accessOffers.get(offer.lookup) === offer
}

export function consumeOffer(server: CompanionServer, offer: PairingOffer): void {
  if (server.offer === offer) {
    server.clearOffer()
    return
  }
  server.accessOffers.delete(offer.lookup)
}

/** Browsers always send one of these on a cross-site POST, so either one pins the request to this page. */
function sameOriginRequest(request: IncomingMessage): boolean {
  const origin = String(request.headers['origin'] ?? '').trim()
  const host = sanitizeHost(request.headers.host)
  const site = String(request.headers['sec-fetch-site'] ?? '').trim().toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return false
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(text)
}

/**
 * Handles `/access`, `/access/pending` and `/access/resolve`. Returns false when
 * the request belongs to another route, so connection.ts keeps its normal order.
 */
export async function handleAccessHttp(
  server: CompanionServer,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname
  if (path !== '/access' && path !== '/access/pending' && path !== '/access/resolve') {
    return false
  }
  const method = request.method ?? 'GET'
  const head = method === 'HEAD'
  const readOnly = method === 'GET' || head
  const local = isLoopbackAddress(request.socket.remoteAddress)

  if (path === '/access') {
    if (!readOnly) {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return true
    }
    // `dry=1`：只问「这个来源会被当成什么」，不签发凭据。远端页面先用它
    // 决定要显示身份选择页还是直接连，避免每打开一次页面都留下一份没人用的凭据。
    if (url.searchParams.get('dry') === '1') {
      writeJson(response, 200, {
        ok: true,
        dry: true,
        local,
        requestedRole: local ? 'host' : requestedRole(url.searchParams.get('role')),
      })
      return true
    }
    const grant = issueAccessOffer(server, request, requestedRole(url.searchParams.get('role')))
    writeJson(response, 200, {
      ok: true,
      local: grant.local,
      // 审批页据此预选「主机用户 / 客户机用户」；这不等于已获得的权限。
      requestedRole: grant.role,
      expiresAt: grant.expiresAt,
      payload: grant.payload,
    })
    return true
  }

  if (!local) {
    // The approval prompt is the whole point: only this machine may answer it.
    writeJson(response, 403, { ok: false, error: 'local_only' })
    return true
  }

  if (path === '/access/pending') {
    if (!readOnly) {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return true
    }
    writeJson(response, 200, { ok: true, request: server.pendingPairing() })
    return true
  }

  if (method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' })
    response.end()
    return true
  }
  if (!sameOriginRequest(request)) {
    writeJson(response, 403, { ok: false, error: 'same_origin_required' })
    return true
  }
  let body: Record<string, unknown>
  try {
    const text = await readRequestBody(request, 4_096)
    const parsed = JSON.parse(text || '{}') as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('bad body')
    body = parsed as Record<string, unknown>
  } catch {
    writeJson(response, 400, { ok: false, error: 'bad_request' })
    return true
  }
  const requestId = typeof body['requestId'] === 'string' ? body['requestId'] : ''
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(requestId)) {
    writeJson(response, 400, { ok: false, error: 'bad_request' })
    return true
  }
  const approved = body['approved'] === true
  // 审批页选定的角色；不给就按申请时的期望值（扫码配对则忽略）。
  const role = typeof body['role'] === 'string' ? requestedRole(String(body['role'])) : undefined
  const resolved = server.resolvePairing(requestId, approved, role)
  writeJson(response, resolved ? 200 : 409, { ok: resolved })
  return true
}
