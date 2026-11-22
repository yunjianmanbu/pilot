// 传输入口：HTTP 面板与插件路由、WebSocket 连接接入、心跳巡检，以及原始帧下发与帧分发。
// 由 server.ts 的同名方法机械搬出：方法体逐字保留，this 换成 host 参数。
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { WebSocket } from 'ws'
import { handlePluginHttp as runHandlePluginHttp } from '../../plugins/bridge'
import { PLUGIN_HTTP_PREFIX } from '../../plugins/manifest'
import { HEARTBEAT_MISS_LIMIT, SILENCE_MS } from '../constants'
import {
  CONTENT_TYPES,
  nowIso,
  readRequestBody,
  STATIC_ROUTES,
  withDesktopSurface,
} from '../helpers'
import type { ClientConnection, ConnectionSocket } from '../types'
import type { CompanionServer } from '../server'

export async function handleHttp(
  server: CompanionServer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://pilot.local')
    if (
      url.pathname === PLUGIN_HTTP_PREFIX ||
      url.pathname.startsWith(`${PLUGIN_HTTP_PREFIX}/`)
    ) {
      await server.handlePluginHttp(request, response)
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }
    if (url.pathname === '/healthz') {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      response.end(JSON.stringify({ ok: true, app: 'pilot-link' }))
      return
    }
    let relative = STATIC_ROUTES[url.pathname]
    if (!relative && url.pathname.startsWith('/vendor/')) {
      relative = url.pathname.slice(1)
    }
    if (!relative) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const safeRelative = normalize(relative).replace(/^([.][.][/\\])+/, '')
    const path = join(server.options.assetsDir, safeRelative)
    if (!path.startsWith(server.options.assetsDir)) {
      response.writeHead(403)
      response.end()
      return
    }
    const raw = await readFile(path)
    const ext = safeRelative.slice(safeRelative.lastIndexOf('.'))
    // Server mode paints the console like the desktop client; the phone PWA
    // served by the desktop app keeps the untouched stylesheet. The switch
    // lives in the HTML so one asset directory can serve both surfaces.
    const body =
      ext === '.html' && server.options.surface === 'desktop'
        ? Buffer.from(withDesktopSurface(raw.toString('utf8')))
        : raw
    const headers: Record<string, string | number> = {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    }
    if (ext === '.html') {
      headers['Content-Security-Policy'] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    }
    response.writeHead(200, headers)
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  } catch {
    if (!response.headersSent) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    response.end('Not found')
  }
}

export async function handlePluginHttp(
  server: CompanionServer,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const host = server.pluginHost()
  const write = (status: number, headers: Record<string, string>, body: string): void => {
    if (response.headersSent) return
    response.writeHead(status, headers)
    response.end(body)
  }
  if (!host) {
    write(
      503,
      { 'Content-Type': 'application/json; charset=utf-8' },
      JSON.stringify({ ok: false, error: 'unavailable', message: 'no workspace is open' }),
    )
    return
  }
  const result = await runHandlePluginHttp(host, {
    method: request.method ?? 'GET',
    url: request.url ?? '/',
    headers: request.headers,
    readBody: (limit) => readRequestBody(request, limit),
  })
  if (!result) {
    write(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found')
    return
  }
  write(result.status, result.headers, result.body)
}

export function handleConnection(
  server: CompanionServer,
  socket: ConnectionSocket,
  origin: { via: 'lan' | 'relay'; address?: string | undefined },
): void {
  const connection: ClientConnection = {
    socket,
    authed: false,
    phoneId: null,
    alive: true,
    pairAttempts: 0,
    openedAt: Date.now(),
    via: origin.via,
    address: origin.address?.replace(/^::ffff:/, '') ?? null,
  }
  server.connections.add(connection)
  socket.on('pong', () => {
    connection.alive = true
  })
  socket.on('message', (data) => {
    connection.alive = true
    void server.handleFrame(connection, data).catch(() => {
      // Individual malformed frames are answered by handleFrame.
    })
  })
  socket.on('close', () => {
    server.connections.delete(connection)
    if (server.pendingPair?.connection === connection) {
      server.settlePairing(
        server.pendingPair.request.requestId,
        false,
        '手机已断开连接，请在电脑上重新生成二维码',
      )
    }
    if (connection.phoneId && server.byPhone.get(connection.phoneId) === connection) {
      server.byPhone.delete(connection.phoneId)
      server.phoneSockets.delete(connection.phoneId)
      const phone = server.state.phones[connection.phoneId]
      if (phone) {
        phone.lastSeen = nowIso()
        server.blankSave()
      }
      server.emitStatus()
    }
  })
  socket.on('error', () => {
    // Close follows.
  })
}

export function checkHeartbeat(
  server: CompanionServer,
): void {
  const now = Date.now()
  for (const connection of server.connections) {
    if (!connection.authed && now - connection.openedAt > SILENCE_MS) {
      try {
        connection.socket.terminate()
      } catch {
        // ignore
      }
      continue
    }
    if (connection.alive) {
      connection.missedPongs = 0
    } else {
      connection.missedPongs = (connection.missedPongs ?? 0) + 1
    }
    if ((connection.missedPongs ?? 0) >= HEARTBEAT_MISS_LIMIT) {
      try {
        connection.socket.terminate()
      } catch {
        // ignore
      }
      continue
    }
    connection.alive = false
    try {
      connection.socket.ping()
    } catch {
      // ignore
    }
  }
}

export function sendRaw(
  server: CompanionServer,
  socket: ConnectionSocket,
  frame: unknown,
): void {
  if (socket.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify(frame))
  } catch {
    // ignore
  }
}

export function sendError(
  server: CompanionServer,
  connection: ClientConnection,
  code: string,
  message: string,
): void {
  server.sendRaw(connection.socket, { type: 'error', code, message: message.slice(0, 400) })
}

export async function handleFrame(
  server: CompanionServer,
  connection: ClientConnection,
  raw: unknown,
): Promise<void> {
  let frame: Record<string, unknown>
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : String(raw)
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('bad frame')
    frame = parsed as Record<string, unknown>
  } catch {
    server.sendError(connection, 'bad_frame', '消息格式不正确')
    return
  }
  const type = typeof frame['type'] === 'string' ? frame['type'] : ''
  if (type === 'pair.join') {
    await server.handlePairJoin(connection, frame)
    return
  }
  if (type === 'hello') {
    await server.handleHello(connection, frame)
    return
  }
  if (type === 'hello.proof') {
    await server.handleHelloProof(connection, frame)
    return
  }
  if (type === 'message') {
    if (!connection.authed || !connection.phoneId) {
      server.sendError(connection, 'auth_required', '请先完成配对')
      return
    }
    await server.handleEncrypted(connection.phoneId, frame['payload'])
    return
  }
  if (type === 'ping') {
    server.sendRaw(connection.socket, { type: 'pong', t: Date.now() })
    return
  }
  server.sendError(connection, 'unknown_frame', '未知的消息类型')
}
