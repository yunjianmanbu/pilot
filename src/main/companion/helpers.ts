/**
 * Stateless helpers for the companion service: payload sanitising, address
 * discovery, sealed storage values and static asset routing.
 *
 * Nothing here touches the server state, so these functions are shared by the
 * HTTP panel, the WebSocket protocol and the tests without a server instance.
 */
import type { IncomingMessage } from 'node:http'
import { networkInterfaces } from 'node:os'
import { safeStorage } from 'electron'
import type { CompanionPhone } from '../../shared/types'
import type { LearningEntry } from '../agent/learning'
import {
  PHONE_LEARNING_NOTE_LIMIT,
  PHONE_LEARNING_PATH_LIMIT,
  PHONE_LEARNING_TITLE_LIMIT,
  PHONE_LEARNING_URL_LIMIT,
} from './constants'
import type { StoredPhone } from './types'

export function nowIso(): string {
  return new Date().toISOString()
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Read a request body up to `limit` bytes. Reading stops as soon as the limit is
 * exceeded so a large upload cannot be buffered into memory.
 */
export function readRequestBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > limit) {
        request.off('data', onData)
        request.resume()
        resolve(Buffer.concat(chunks).toString('utf8'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => finish()
    const onError = (error: Error): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      reject(error)
    }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

export function cleanText(value: unknown, fallback: string, max: number): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max)
  return text || fallback
}

export function clipOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 账本条目也来自工作区文件；手机端只拿截断后的安全副本。 */
export function phoneLearningEntry(entry: LearningEntry): LearningEntry {
  const quality = Number(entry.quality)
  const bytes = Number(entry.bytes)
  return {
    at: String(entry.at || '').slice(0, 40),
    kind: entry.kind,
    id: String(entry.id || '').slice(0, 120),
    url: clipOptional(entry.url, PHONE_LEARNING_URL_LIMIT),
    path: clipOptional(entry.path, PHONE_LEARNING_PATH_LIMIT),
    host: clipOptional(entry.host, 253),
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined,
    title: clipOptional(entry.title, PHONE_LEARNING_TITLE_LIMIT),
    goal: clipOptional(entry.goal, PHONE_LEARNING_TITLE_LIMIT),
    sourceId: clipOptional(entry.sourceId, 120),
    taskId: clipOptional(entry.taskId, 120),
    verdict: entry.verdict,
    quality: Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : undefined,
    note: clipOptional(entry.note, PHONE_LEARNING_NOTE_LIMIT),
  }
}

export function requireString(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  return value.trim().slice(0, max)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function seal(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `s1:${safeStorage.encryptString(value).toString('base64')}`
    }
  } catch {
    // Fall back to an unsealed base64 value.
  }
  return `p1:${Buffer.from(value, 'utf8').toString('base64')}`
}

export function unseal(value: string): string {
  if (value.startsWith('s1:')) {
    return safeStorage.decryptString(Buffer.from(value.slice(3), 'base64'))
  }
  if (value.startsWith('p1:')) {
    return Buffer.from(value.slice(3), 'base64').toString('utf8')
  }
  throw new Error('Unknown sealed value')
}

export function publicPhone(phone: StoredPhone, online: boolean): CompanionPhone {
  return {
    phoneId: phone.phoneId,
    name: phone.name,
    platform: phone.platform,
    online,
    pairedAt: phone.pairedAt,
    lastSeen: phone.lastSeen,
    ...(phone.address ? { address: phone.address } : {}),
    ...(phone.via ? { via: phone.via } : {}),
    ...(phone.role ? { role: phone.role } : {}),
  }
}

/**
 * All usable IPv4 addresses, best first. Home LAN ranges outrank VPN/virtual
 * adapter ranges so pairing and welcome frames advertise the address a phone
 * on the same Wi-Fi can actually reach.
 */
export function lanAddresses(): string[] {
  const candidates: Array<{ address: string; virtual: boolean }> = []
  const interfaces = networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    const virtual =
      /(vmware|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|tailscale|zerotier|loopback|\btap\b|\btun\b)/i.test(
        name,
      )
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      candidates.push({ address: entry.address, virtual })
    }
  }
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    return 3
  }
  candidates.sort((left, right) => {
    // A virtual adapter is a fallback, not a peer: even a 192.168.x address on
    // a VM host-only network is usually useless to the phone.
    return (
      rank(left.address) +
      (left.virtual ? 4 : 0) -
      (rank(right.address) + (right.virtual ? 4 : 0))
    )
  })
  const out: string[] = []
  for (const item of candidates) {
    if (!out.includes(item.address)) out.push(item.address)
  }
  return out
}

export function preferredLanAddress(): string {
  return lanAddresses()[0] ?? '127.0.0.1'
}

/** Same host as `base`, but on the companion WebSocket path. */
export function wsEndpoint(base: string): string {
  try {
    const url = new URL(base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/ws'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return base
  }
}

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Mark the panel as the server-mode console and load the desktop shell styles.
 *
 * The CLI shares one asset directory with the phone PWA, so the switch has to
 * be per response instead of per file: `data-surface="desktop"` scopes every
 * rule in `desktop.css`, and the PWA (served by the desktop app) never sees
 * either the attribute or the extra stylesheet.
 */
export function withDesktopSurface(html: string): string {
  const linked = html.includes('desktop.css')
    ? html
    : html.replace(
        /<\/head>/i,
        '  <link rel="stylesheet" href="./desktop.css" />\n  </head>',
      )
  // Pure black chrome matches the desktop window frame; the PWA keeps its own
  // tinted browser color.
  const themed = linked.replace(
    /<meta name="theme-color" content="[^"]*" \/>/i,
    '<meta name="theme-color" content="#000000" />',
  )
  return themed.replace(/<html\b([^>]*)>/i, (_match, attrs: string) => {
    if (/data-surface=/i.test(attrs)) return `<html${attrs}>`
    return `<html${attrs} data-surface="desktop">`
  })
}

export const STATIC_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/crypto.js': 'crypto.js',
  '/style.css': 'style.css',
  '/desktop.css': 'desktop.css',
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/icons/icon.svg': 'icons/icon.svg',
  '/icons/icon.png': 'icons/icon.png',
  '/icons/maskable.svg': 'icons/maskable.svg',
}
