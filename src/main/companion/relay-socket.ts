/**
 * A desktop-side virtual WebSocket backed by one phone socket on the cloud
 * connector.
 *
 * It implements just enough of the ws surface for `handleConnection`, so LAN
 * and cloud clients share exactly the same protocol path.
 */
import { WebSocket } from 'ws'
import type { RelayHostChannel } from './relay'
import type { ConnectionSocket } from './types'

export class RelaySocket implements ConnectionSocket {
  readyState: number = WebSocket.OPEN
  private closed = false
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  constructor(
    private readonly channel: RelayHostChannel,
    private readonly cid: string,
  ) {}

  on(event: string, listener: (...args: unknown[]) => void): this {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener)
    return this
  }

  send(data: string): void {
    if (this.closed) return
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    this.channel.send(this.cid, frame)
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.channel.closePeer(this.cid, code, reason)
    this.closeFromPeer()
  }

  terminate(): void {
    this.close(1001, 'terminated')
  }

  ping(): void {
    // The cloud connector handles transport heartbeats. Keep the desktop
    // heartbeat loop happy without generating extra relay traffic.
    if (this.closed) return
    setImmediate(() => this.emit('pong'))
  }

  deliver(frame: unknown): void {
    if (this.closed) return
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'))
  }

  closeFromPeer(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  private emit(event: string, ...args: unknown[]): void {
    const listeners = this.listeners.get(event)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(...args)
      } catch {
        // Connection handlers are already defensive; one bad listener must not
        // stop the rest.
      }
    }
  }
}
