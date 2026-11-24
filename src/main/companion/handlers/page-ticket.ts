// 网页服务的访问凭据：远端浏览器打开桌面界面（`/` 发的是 `out/web`）后，页面
// 先用 `POST /bridge/ticket` 申请一次访问，本机在配对审批里点「允许」才发一个
// `/bridge` token；`GET /bridge/ticket?id=` 供页面轮询结果。
//
// 为什么不用二维码那套：二维码的载荷（房间号、密钥）是为手机 PWA 的加密协议
// 准备的，浏览器里的桌面界面需要的是整份 `pilot:*` IPC 面，所以只借用同一个
// 「本机审批」回路，凭据本身是一条随机 token。回环地址不需要 ticket，直接连
// `/bridge` 就是本机。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hashToken, randomId, randomToken } from '../crypto'
import { nowIso, readRequestBody, seal } from '../helpers'
import { requestPairApproval } from './pairing'
import { desktopServeAllowed } from './desktop'
import { isLoopbackAddress } from './access'
import type { PageTicket, StoredPhone } from '../types'
import type { CompanionServer } from '../server'

/** 页面要在这段时间内完成申请与连接；过期后重新申请即可。 */
const TICKET_TTL_MS = 5 * 60_000
/** 反复刷新不应把内存撑大；最老的先淘汰。 */
const MAX_TICKETS = 16

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  response.end(text)
}

function pruneTickets(server: CompanionServer): void {
  const now = Date.now()
  for (const [id, ticket] of server.pageTickets) {
    if (ticket.expiresAt <= now && ticket.state === 'pending') {
      ticket.state = 'expired'
      ticket.reason = '申请已过期，请刷新页面重新申请'
    }
    // 过期一段时间的记录直接丢掉（保留一分钟供最后一次轮询读到结果）。
    if (ticket.expiresAt + 60_000 <= now) server.pageTickets.delete(id)
  }
  // 满了先淘汰已出结果的那条，再淘汰最老的：正在等审批的申请被挤掉，页面就会
  // 拿着一个不在表里的 id 无限轮询（服务端只能回 unknown_ticket）。
  while (server.pageTickets.size >= MAX_TICKETS) {
    const victim =
      [...server.pageTickets.values()].find((ticket) => ticket.state !== 'pending') ??
      server.pageTickets.values().next().value
    if (!victim) break
    server.pageTickets.delete(victim.id)
  }
}

/** 同一来源刷新页面时复用同一个待批申请，避免每次刷新都弹一次审批。 */
function ticketForAddress(server: CompanionServer, address: string): PageTicket | null {
  for (const ticket of server.pageTickets.values()) {
    if (sameAddress(ticket.address, address) && ticket.state === 'pending') return ticket
  }
  return null
}

/**
 * 同一台机器可能经 IPv4 或 IPv6 各连一次（IPv4-mapped 写法还不一样），按字面比
 * 地址会让页面申请完却查不到自己的 ticket，只能无限轮询。统一成同一个写法再比。
 */
function sameAddress(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const bare = value.replace(/^::ffff:/i, '').trim().toLowerCase()
    return bare === '::1' ? '127.0.0.1' : bare
  }
  return normalize(left) === normalize(right)
}

/**
 * 同一地址已经批过、且凭据仍然有效时，把那条 token 再发一次。
 *
 * 刷新页面、或者用一个新标签页打开同一个地址，不该让用户重新审批一遍——
 * 那正是「点一次允许，浏览器又再申请一次」的观感来源。两个前提缺一不可：
 * ticket 还在有效期内，且它写下的凭据仍在册。后者必须查，因为用户可能已经在
 * 设置里解除了这次授权：把作废的 token 发回去，页面会连不上、清凭据、再申请，
 * 变成无限循环。
 */
function approvedTicketForAddress(server: CompanionServer, address: string): PageTicket | null {
  const now = Date.now()
  for (const ticket of server.pageTickets.values()) {
    if (!sameAddress(ticket.address, address)) continue
    if (ticket.state !== 'approved' || !ticket.token) continue
    if (ticket.expiresAt <= now) continue
    const record = server.state.phones[`web-${ticket.id}`]
    if (!record || record.tokenHash !== hashToken(ticket.token)) continue
    return ticket
  }
  return null
}

function originAllowed(request: IncomingMessage): boolean {
  // 浏览器 POST 会带 Origin；跨站页面不该能在这台电脑上堆审批框。
  // 命令行工具（无 Origin）仍需通过本机人工审批，放行不会绕过任何判定。
  const origin = String(request.headers.origin ?? '').trim()
  if (!origin) return true
  try {
    return new URL(origin).host === String(request.headers.host ?? '')
  } catch {
    return false
  }
}

function holderPhone(ticket: PageTicket, token: string, name: string): StoredPhone {
  const now = nowIso()
  return {
    phoneId: `web-${ticket.id}`,
    name,
    platform: 'browser',
    tokenHash: hashToken(token),
    tokenSealed: seal(token),
    // 浏览器不走手机的端到端加密帧；这两个字段留给记录结构的必填位。
    pcToPhone: seal(randomToken()),
    phoneToPc: seal(randomToken()),
    outSeq: 1,
    inSeq: 0,
    via: 'browser',
    role: ticket.role ?? 'host',
    address: ticket.address.replace(/^::ffff:/i, ''),
    pairedAt: now,
    lastSeen: null,
  }
}

export async function handlePageTicketHttp(
  server: CompanionServer,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname !== '/bridge/ticket') return false
  // 网页服务关着时不再发新凭据：已发出那条由 `mode-control` 在关闭时撤销。
  if (!desktopServeAllowed(server)) {
    writeJson(response, 503, { ok: false, error: 'server_disabled' })
    return true
  }
  const address = request.socket.remoteAddress ?? null
  if (url.pathname === '/bridge/ticket' && request.method === 'GET') {
    pruneTickets(server)
    const id = String(url.searchParams.get('id') ?? '').trim()
    const ticket = id ? server.pageTickets.get(id) : undefined
    // 只把结果发给申请人自己的地址；别人猜到 id 也拿不到 token。
    if (!ticket || !address || !sameAddress(ticket.address, address)) {
      writeJson(response, 404, { ok: false, error: 'unknown_ticket' })
      return true
    }
    writeJson(response, 200, {
      ok: true,
      state: ticket.state,
      expiresAt: new Date(ticket.expiresAt).toISOString(),
      ...(ticket.role ? { role: ticket.role } : {}),
      ...(ticket.state === 'approved' && ticket.token ? { token: ticket.token } : {}),
      ...(ticket.reason ? { reason: ticket.reason } : {}),
    })
    return true
  }

  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return true
  }
  // 回环地址不需要凭据：`/bridge` 本来就按本机放行。
  if (address && isLoopbackAddress(address)) {
    writeJson(response, 200, { ok: true, local: true })
    return true
  }
  if (!originAllowed(request)) {
    writeJson(response, 403, { ok: false, error: 'bad_origin' })
    return true
  }
  // 页面不需要带请求体；读掉它只是为了让 keep-alive 连接干净。
  await readRequestBody(request, 4_096).catch(() => null)
  if (!address) {
    writeJson(response, 400, { ok: false, error: 'unknown_address' })
    return true
  }
  pruneTickets(server)
  // 先看有没有已经批准过的：批准过的直接发 token，不再弹第二遍审批。
  const approved = approvedTicketForAddress(server, address)
  if (approved) {
    writeJson(response, 200, {
      ok: true,
      id: approved.id,
      state: approved.state,
      expiresAt: new Date(approved.expiresAt).toISOString(),
      ...(approved.role ? { role: approved.role } : {}),
      ...(approved.token ? { token: approved.token } : {}),
    })
    return true
  }
  const existing = ticketForAddress(server, address)
  if (existing) {
    writeJson(response, 200, {
      ok: true,
      id: existing.id,
      expiresAt: new Date(existing.expiresAt).toISOString(),
      state: existing.state,
    })
    return true
  }
  const id = randomId(18)
  const ticket: PageTicket = {
    id,
    address,
    createdAt: Date.now(),
    expiresAt: Date.now() + TICKET_TTL_MS,
    state: 'pending',
  }
  server.pageTickets.set(id, ticket)
  // 审批仍是 pairing.ts 的那一条回路：桌面窗口弹确认框，`pilot serve` 在终端
  // 打印 allow host / allow client。申请默认要主机身份——页面就是桌面界面，
  // 批成客户机时页面会明确告知「只有主机用户能用」。
  const name = `网页服务 ${address.replace(/^::ffff:/i, '')}`
  void requestPairApproval(server, { address, via: 'lan' }, {
    phoneId: `web-${id}`,
    name,
    platform: 'browser',
    mode: 'browser',
    role: 'host',
  })
    .then(async (decision) => {
      const record = server.pageTickets.get(id)
      if (!record || record.state !== 'pending') return
      if (!decision.approved) {
        record.state = 'denied'
        record.reason = decision.reason || '这台电脑拒绝了网页访问'
        return
      }
      const token = randomToken()
      record.role = decision.role ?? 'host'
      record.token = token
      record.state = 'approved'
      server.state.phones[`web-${id}`] = holderPhone(record, token, name)
      await server.saveNow()
      server.emitStatus()
    })
    .catch(() => {
      const record = server.pageTickets.get(id)
      if (!record || record.state !== 'pending') return
      record.state = 'denied'
      record.reason = '这台电脑没有给出确认'
    })
  writeJson(response, 200, {
    ok: true,
    id,
    expiresAt: new Date(ticket.expiresAt).toISOString(),
    state: ticket.state,
    address,
  })
  return true
}
