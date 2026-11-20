import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

/**
 * Outbound host channel to the Pilot cloud connector.
 *
 * The connector is a blind relay: it only forwards frames between the desktop
 * host and phone sockets in the same room. End-to-end keys never leave the
 * desktop and phone, so the relay cannot read messages even though it sees
 * transport frames.
 */

const PROTOCOL_VERSION = 1
const CONNECT_TIMEOUT_MS = 15_000
const HEARTBEAT_MS = 25_000
const HEARTBEAT_GRACE_MS = 75_000
// Only a connection that stayed up this long resets the reconnect backoff;
// a fast connect/disconnect loop keeps escalating instead of hammering.
const STABLE_CONNECTION_MS = 45_000
const MAX_PAYLOAD = 1024 * 1024
// Stable identity for this desktop process. The relay uses it to tell a
// transient relay-socket reconnect (keep phone sockets) apart from a desktop
// restart (phones must re-authenticate).
const HOST_INSTANCE_ID = randomUUID()
// The relay keeps phones for 30s while the host is away. Keep our virtual
// phone sockets a little longer so a same-process reconnect can resume them.
const PEER_GRACE_MS = 45_000
const MAX_RECONNECT_MS = 15_000

export interface RelayChannelState {
  connected: boolean
  error: string | null
}

export interface RelayChannelHandlers {
  onPeerOpen?: (cid: string) => void
  onPeerClose?: (cid: string) => void
  onFrame?: (cid: string, frame: unknown) => void
  onState?: (state: RelayChannelState) => void
}

interface RelayPeer {
  alive: boolean | null
}

export class RelayHostChannel {
  private socket: WebSocket | null = null
  private stopped = false
  private ready = false
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private peerGraceTimer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private lastFrameAt = 0
  private readyAt = 0
  private connectTimer: NodeJS.Timeout | null = null
  private error: string | null = null
  private readonly peers = new Map<string, RelayPeer>()

  constructor(
    private readonly url: string,
    private readonly room: string,
    private readonly key: string,
    private readonly handlers: RelayChannelHandlers = {},
    // L1 admission code (`id:secret`) from the connection string's `#k=`.
    // Empty when the connector runs open (self-hosted without keys).
    private readonly access: string = '',
  ) {}

  get connected(): boolean {
    return this.ready
  }

  get lastError(): string | null {
    return this.error
  }

  start(): void {
    if (this.stopped) return
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.clearPeerGrace()
    this.ready = false
    this.readyAt = 0
    this.closePeers()
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close(1001, 'client stopping')
      } catch {
        // ignore
      }
    }
    this.emitState()
  }

  send(cid: string, frame: unknown): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(JSON.stringify({ type: 'relay.send', cid, data: frame }))
    } catch {
      // The socket close handler reconnects.
    }
  }

  closePeer(cid: string, code = 1000, reason = ''): void {
    this.peers.delete(cid)
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(
        JSON.stringify({
          type: 'relay.close',
          cid,
          code: Number.isSafeInteger(code) ? code : 1000,
          reason: String(reason).slice(0, 120),
        }),
      )
    } catch {
      // ignore
    }
  }

  private emitState(): void {
    try {
      this.handlers.onState?.({ connected: this.ready, error: this.error })
    } catch {
      // Status callbacks must not break the tunnel.
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private clearPeerGrace(): void {
    if (this.peerGraceTimer) {
      clearTimeout(this.peerGraceTimer)
      this.peerGraceTimer = null
    }
  }

  private schedulePeerGrace(): void {
    if (this.peerGraceTimer || this.peers.size === 0) return
    this.peerGraceTimer = setTimeout(() => {
      this.peerGraceTimer = null
      if (this.ready || this.stopped) return
      this.closePeers()
    }, PEER_GRACE_MS)
    this.peerGraceTimer.unref?.()
  }

  private connect(): void {
    if (this.stopped) return
    this.clearTimers()
    let socket: WebSocket
    try {
      socket = new WebSocket(this.url, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket || this.ready) return
      this.error = '连接器连接超时'
      try {
        socket.terminate()
      } catch {
        // ignore
      }
      this.scheduleReconnect()
    }, CONNECT_TIMEOUT_MS)
    this.connectTimer.unref?.()

    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return
      this.lastFrameAt = Date.now()
      try {
        socket.send(
          JSON.stringify({
            type: 'relay.hello',
            role: 'host',
            room: this.room,
            key: this.key,
            protocol: PROTOCOL_VERSION,
            hostInstance: HOST_INSTANCE_ID,
            ...(this.access ? { access: this.access } : {}),
          }),
        )
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        try {
          socket.terminate()
        } catch {
          // ignore
        }
      }
    })

    socket.on('message', (data) => {
      if (this.socket !== socket) return
      this.lastFrameAt = Date.now()
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (!frame || typeof frame.type !== 'string') return
      switch (frame.type) {
        case 'relay.ready':
          if (this.connectTimer) {
            clearTimeout(this.connectTimer)
            this.connectTimer = null
          }
          this.clearPeerGrace()
          this.ready = true
          this.readyAt = Date.now()
          this.error = null
          this.startHeartbeat()
          this.emitState()
          return
        case 'relay.peer-open': {
          const cid = typeof frame.cid === 'string' ? frame.cid.slice(0, 80) : ''
          if (!cid || this.peers.has(cid)) return
          this.peers.set(cid, { alive: true })
          try {
            this.handlers.onPeerOpen?.(cid)
          } catch {
            // ignore
          }
          return
        }
        case 'relay.peer-close': {
          const cid = typeof frame.cid === 'string' ? frame.cid : ''
          const peer = this.peers.get(cid)
          if (peer) peer.alive = false
          this.peers.delete(cid)
          try {
            this.handlers.onPeerClose?.(cid)
          } catch {
            // ignore
          }
          return
        }
        case 'relay.frame': {
          const cid = typeof frame.cid === 'string' ? frame.cid : ''
          if (!cid || !this.peers.has(cid)) return
          try {
            this.handlers.onFrame?.(cid, frame.data)
          } catch {
            // A malformed frame is ignored; the encrypted protocol handles errors.
          }
          return
        }
        case 'relay.error': {
          this.error = String(frame.message || '连接器返回错误').slice(0, 300)
          if (frame.fatal === true) {
            // Another host channel took over; this one must not reconnect.
            this.stopped = true
            this.ready = false
            this.clearTimers()
            this.clearPeerGrace()
            this.closePeers()
          }
          this.emitState()
          return
        }
        default:
          return
      }
    })

    socket.on('pong', () => {
      if (this.socket !== socket) return
      this.lastFrameAt = Date.now()
      for (const peer of this.peers.values()) peer.alive = true
    })

    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.ready = false
      if (this.readyAt && Date.now() - this.readyAt >= STABLE_CONNECTION_MS) {
        this.attempt = 0
      }
      this.readyAt = 0
      this.clearTimers()
      // Keep virtual phone sockets across a transient relay disconnect. The
      // relay holds the real phone sockets for 30s; if this same process
      // reconnects in time the phones never notice the gap.
      this.schedulePeerGrace()
      this.emitState()
      if (!this.stopped) this.scheduleReconnect()
    })

    socket.on('error', () => {
      // Terminate immediately so 'close' fires and the reconnect starts now,
      // instead of waiting for the heartbeat grace period.
      if (this.socket === socket) {
        try {
          socket.terminate()
        } catch {
          // ignore
        }
      }
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastFrameAt > HEARTBEAT_GRACE_MS) {
        this.error = '连接器连接超时'
        try {
          socket.terminate()
        } catch {
          // ignore
        }
        return
      }
      try {
        socket.ping()
      } catch {
        // ignore
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(MAX_RECONNECT_MS, 1_000 * 1.7 ** Math.min(this.attempt, 8))
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, Math.round(delay + Math.random() * 500))
    this.reconnectTimer.unref?.()
  }

  private closePeers(): void {
    const ids = [...this.peers.keys()]
    this.peers.clear()
    for (const cid of ids) {
      try {
        this.handlers.onPeerClose?.(cid)
      } catch {
        // ignore
      }
    }
  }
}
