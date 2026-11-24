// 配对与中继房间：配对二维码的生成与批准、待批准配对的下发、中继房间的建立与关闭，以及中继地址推导。
// 由 server.ts 的同名方法机械搬出：方法体逐字保留，this 换成 host 参数。
import QRCode from 'qrcode'
import type { CompanionPairRequest, CompanionPairing } from '../../../shared/types'
import { splitRelayUrl } from '../../../shared/relay'
import { createKeyPair, randomId, randomLookup, randomSecret } from '../crypto'
import { RelayHostChannel, type RelayChannelState } from '../relay'
import {
  APP_DOWNLOAD_URL,
  PAIRING_TTL_MS,
  PAIR_APPROVAL_TTL_MS,
  PAIR_BUSY_REASON,
  TRANSFER_PAIRING_TTL_MS,
} from '../constants'
import { nowIso, wsEndpoint } from '../helpers'
import { RelaySocket } from '../relay-socket'
import type { ClientConnection, PairingOffer } from '../types'
import type { CompanionServer } from '../server'

export async function createPairing(
  server: CompanionServer,
): Promise<CompanionPairing> {
  return server.buildPairingOffer(false)
}

export async function createTransferPairing(
  server: CompanionServer,
): Promise<CompanionPairing> {
  return server.buildPairingOffer(true)
}

export async function buildPairingOffer(
  server: CompanionServer,
  autoApprove: boolean,
): Promise<CompanionPairing> {
  if (!server.state.enabled) {
    server.state.enabled = true
    await server.saveNow()
  }
  await server.start()
  const port = server.listeningPort()
  if (!port) throw new Error('手机连接服务启动失败')
  server.clearOffer()
  const ttl = autoApprove ? TRANSFER_PAIRING_TTL_MS : PAIRING_TTL_MS
  const keyPair = createKeyPair()
  const offer: PairingOffer = {
    lookup: randomLookup(),
    secret: randomSecret(16),
    keys: keyPair,
    expiresAt: Date.now() + ttl,
    room: randomId(24),
    roomKey: randomSecret(24),
    autoApprove,
  }
  server.offer = offer
  server.offerTimer = setTimeout(() => {
    if (server.offer === offer) {
      server.offer = null
      if (!server.roomInUse(offer.room)) server.closeRelayRoom(offer.room)
      if (server.pendingPair) {
        server.settlePairing(
          server.pendingPair.request.requestId,
          false,
          '配对二维码已失效，请在电脑上重新生成',
        )
      }
      server.emitStatus()
    }
  }, ttl)
  server.offerTimer.unref?.()
  const host = server.addressHost()
  const publicBase = server.publicBaseUrl()
  const localAddress = publicBase || `http://${host}:${port}/`
  const lanRelay = publicBase ? wsEndpoint(publicBase) : `ws://${host}:${port}/ws`
  const relayUrl = server.relayUrl()
  const baseUrl = server.appBaseUrl() || localAddress
  if (relayUrl) server.ensureRelayRoom(offer.room, offer.roomKey)
  const payload: Record<string, unknown> = {
    v: 1,
    r: relayUrl || lanRelay,
    d: server.state.deviceId,
    k: offer.lookup,
    s: offer.secret,
    p: keyPair.publicBase64,
    n: server.options.deviceName,
  }
  if (relayUrl) {
    // The phone prefers the direct LAN address when both devices share a
    // network and falls back to the cloud connector otherwise.
    payload['l'] = lanRelay
    payload['x'] = offer.room
    payload['h'] = offer.roomKey
    // L1 admission code. The relay checks it before it will put the phone
    // in a room, so the pairing payload is how it reaches the phone without
    // the user typing anything. It is no more sensitive than `h`.
    const access = server.relayAccess()
    if (access) payload['a'] = access
  }
  const url = new URL(baseUrl)
  url.hash = `p=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
  const qrDataUrl = await QRCode.toDataURL(url.toString(), {
    errorCorrectionLevel: 'M',
    // Four modules of quiet zone are required for reliable scanning. The
    // pairing payload is large (v15, 77 modules), so a 1-module margin left
    // the finder patterns flush against the edge.
    margin: 4,
    // The transfer QR is shown on a high-DPI phone and scanned by another
    // phone's camera, so keep more source pixels than the desktop dialog.
    width: autoApprove ? 720 : 480,
    color: { dark: '#0b1118', light: '#ffffff' },
  })
  server.emitStatus()
  return {
    url: url.toString(),
    qrDataUrl,
    address: baseUrl,
    expiresAt: new Date(offer.expiresAt).toISOString(),
    mode: relayUrl ? 'cloud' : 'lan',
  }
}

export function resolvePairing(
  server: CompanionServer,
  requestId: string,
  approved: boolean,
  role?: 'host' | 'client',
): boolean {
  return server.settlePairing(
    requestId,
    approved,
    approved ? undefined : '电脑端拒绝了本次配对',
    role,
  )
}

export function pendingPairing(
  server: CompanionServer,
): CompanionPairRequest | null {
  return server.pendingPair?.request ?? null
}

export function requestPairApproval(
  server: CompanionServer,
  /**
   * 申请人。`connection` 传带 socket 的连接对象（扫码/握手）；网页服务的 ticket
   * 申请只有来源地址，传 `{ address, via: 'lan' }` 即可。
   */
  connection: Pick<ClientConnection, 'address' | 'via'> & Partial<ClientConnection>,
  input: {
    phoneId: string
    name: string
    platform: string
    mode?: 'qr' | 'browser'
    /** 浏览器申请时页面自报的期望身份；审批时本机可以改。 */
    role?: 'host' | 'client'
  },
): Promise<{ approved: boolean; reason?: string; role?: 'host' | 'client' }> {
  if (server.pendingPair) {
    // Checked before `pair.pending` so the phone never sees "waiting" and then
    // an immediate rejection for the same attempt.
    return Promise.resolve({ approved: false, reason: PAIR_BUSY_REASON })
  }
  const ttl = server.options.pairApprovalTtlMs ?? PAIR_APPROVAL_TTL_MS
  const request: CompanionPairRequest = {
    requestId: randomId(12),
    phoneId: input.phoneId,
    name: input.name,
    platform: input.platform,
    address: connection.address,
    via: connection.via,
    mode: input.mode ?? 'qr',
    ...(input.role ? { role: input.role } : {}),
    requestedAt: nowIso(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  }
  return new Promise((resolvePromise) => {
    server.pendingPair = {
      request,
      ...(connection.socket ? { connection: connection as ClientConnection } : {}),
      resolve: resolvePromise,
    }
    server.pairApprovalTimer = setTimeout(() => {
      server.settlePairing(
        request.requestId,
        false,
        '电脑端没有在限定时间内确认，请在电脑上重新生成二维码',
      )
    }, ttl)
    server.pairApprovalTimer.unref?.()
    server.emitStatus()
    try {
      // Every host shows the request the same way: one run event. A host that
      // offers no prompt (headless without a console) leaves it pending, so
      // an unwired deployment fails closed instead of pairing silently.
      server.options.onEvent?.({ type: 'companion.pair_request', request })
    } catch {
      // A broken prompt must not strand the phone without an answer.
      server.settlePairing(request.requestId, false, '电脑端无法显示配对确认')
    }
  })
}

export function settlePairing(
  server: CompanionServer,
  requestId: string,
  approved: boolean,
  reason?: string,
  role?: 'host' | 'client',
): boolean {
  const pending = server.pendingPair
  if (!pending || pending.request.requestId !== requestId) return false
  server.pendingPair = null
  if (server.pairApprovalTimer) {
    clearTimeout(server.pairApprovalTimer)
    server.pairApprovalTimer = null
  }
  // 角色只对「浏览器直连申请」有意义：扫码配对是本机手机，走的是 paired。
  const granted = pending.request.mode === 'browser' && role ? role : undefined
  pending.resolve({ approved, reason, ...(granted ? { role: granted } : {}) })
  try {
    server.options.onEvent?.({
      type: 'companion.pair_resolved',
      requestId,
      approved,
      reason,
      ...(granted ? { role: granted } : {}),
    })
  } catch {
    // The desktop mirror is best-effort.
  }
  server.emitStatus()
  return true
}

export async function appQr(
  server: CompanionServer,
): Promise<{ url: string; qrDataUrl: string }> {
  const configured = (server.options.appDownloadUrl ?? APP_DOWNLOAD_URL).trim()
  const url = configured || server.appBaseUrl() || server.status().address || server.localUrl()
  if (!url) throw new Error('手机 App 地址尚未配置')
  if (server.appQrCache?.url === url) return server.appQrCache
  const qrDataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 360,
    color: { dark: '#0b1118', light: '#ffffff' },
  })
  server.appQrCache = { url, qrDataUrl }
  return server.appQrCache
}

export function roomInUse(
  server: CompanionServer,
  room: string,
): boolean {
  return Object.values(server.state.phones).some((phone) => phone.relayRoom === room)
}

export function ensureRelayRoom(
  server: CompanionServer,
  room: string,
  key: string,
): void {
  const url = server.relayUrl()
  if (!url || !room || !key || server.relayRooms.has(room)) return
  const sockets = new Map<string, RelaySocket>()
  let channel: RelayHostChannel
  channel = new RelayHostChannel(
    url,
    room,
    key,
    {
      onPeerOpen: (cid) => {
        const socket = new RelaySocket(channel, cid)
        sockets.set(cid, socket)
        server.handleConnection(socket, { via: 'relay' })
      },
      onPeerClose: (cid) => {
        const socket = sockets.get(cid)
        sockets.delete(cid)
        socket?.closeFromPeer()
      },
      onFrame: (cid, frame) => {
        sockets.get(cid)?.deliver(frame)
      },
      onState: (state: RelayChannelState) => {
        server.relayError = state.error
        server.emitStatus()
      },
    },
    server.relayAccess(),
  )
  server.relayRooms.set(room, { channel, sockets })
  channel.start()
}

export function startRelay(
  server: CompanionServer,
): void {
  if (!server.relayUrl()) return
  for (const phone of Object.values(server.state.phones)) {
    if (phone.relayRoom && phone.relayKey) server.ensureRelayRoom(phone.relayRoom, phone.relayKey)
  }
  if (server.offer) server.ensureRelayRoom(server.offer.room, server.offer.roomKey)
}

export function closeRelayRoom(
  server: CompanionServer,
  room: string,
): void {
  const state = server.relayRooms.get(room)
  if (!state) return
  server.relayRooms.delete(room)
  // This is an explicit room shutdown (companion disabled or relay address
  // changed), so tell phones immediately instead of waiting for the relay's
  // host grace period.
  for (const socket of state.sockets.values()) socket.close(1000, 'room closed')
  state.sockets.clear()
  state.channel.stop()
  server.emitStatus()
}

export function stopRelay(
  server: CompanionServer,
): void {
  for (const room of [...server.relayRooms.keys()]) server.closeRelayRoom(room)
  server.relayRooms.clear()
  server.relayError = null
}

export function activeOffer(
  server: CompanionServer,
): PairingOffer | null {
  if (!server.offer) return null
  if (server.offer.expiresAt <= Date.now()) {
    server.clearOffer()
    return null
  }
  return server.offer
}

export function clearOffer(
  server: CompanionServer,
): void {
  const room = server.offer?.room
  server.offer = null
  if (server.offerTimer) {
    clearTimeout(server.offerTimer)
    server.offerTimer = null
  }
  if (room && !server.roomInUse(room)) server.closeRelayRoom(room)
  // A new QR code invalidates any phone still waiting on the old one.
  if (server.pendingPair) {
    server.settlePairing(
      server.pendingPair.request.requestId,
      false,
      '配对二维码已更换，请重新扫码',
    )
  }
}

export function relayEndpoint(
  server: CompanionServer,
): { url: string; access: string } {
  const override = (server.options.relayUrl ?? '').trim()
  const raw = override || server.options.store.settingsView().relayUrl
  return splitRelayUrl(raw)
}

export function relayUrl(
  server: CompanionServer,
): string {
  return server.relayEndpoint().url
}

export function relayAccess(
  server: CompanionServer,
): string {
  return server.relayEndpoint().access
}

export function relaySource(
  server: CompanionServer,
): 'env' | 'settings' | 'none' {
  if ((server.options.relayUrl ?? '').trim()) return 'env'
  return server.options.store.settingsView().relayUrl.trim() ? 'settings' : 'none'
}

export function localUrl(
  server: CompanionServer,
): string {
  const port = server.listeningPort()
  return port ? `http://127.0.0.1:${port}/` : ''
}
