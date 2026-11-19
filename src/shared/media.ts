/**
 * Pure helpers behind the in-app resource preview: what a file is, how it is
 * served over HTTP, and which links the app is willing to open.
 *
 * Kept free of Electron imports so the unit tests run them in plain Node.
 */

/** Custom scheme that streams workspace files into the renderer. */
export const MEDIA_SCHEME = 'pilot-media'

export type PreviewKind = 'text' | 'image' | 'video' | 'audio' | 'html'

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'svg',
])

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv'])

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'])

const HTML_EXTENSIONS = new Set(['html', 'htm'])

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

function extensionOf(name: string): string {
  const matched = /\.([^./\\]+)$/.exec(String(name || '').trim())
  return matched?.[1] ? matched[1].toLowerCase() : ''
}

/** How the renderer should present a file, by extension. */
export function previewKindOf(name: string): PreviewKind {
  const ext = extensionOf(name)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (HTML_EXTENSIONS.has(ext)) return 'html'
  return 'text'
}

/** True when the file can be shown by an <img>, <video> or <audio> tag. */
export function isMediaKind(kind: PreviewKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extensionOf(name)] ?? 'application/octet-stream'
}

export interface ByteRange {
  start: number
  end: number
}

/**
 * Parse a single-range `Range` header. Video and audio seeking needs 206
 * responses, so the protocol handler answers them instead of buffering the
 * whole file.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | null {
  if (!header || !Number.isFinite(size) || size <= 0) return null
  const matched = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim())
  if (!matched) return null
  const [, rawStart, rawEnd] = matched
  if (!rawStart && !rawEnd) return null

  if (!rawStart) {
    // `bytes=-500` asks for the last 500 bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return null
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return null
  return { start, end }
}

export type OpenLinkKind = 'preview' | 'external' | 'media'

export interface OpenLinkTarget {
  kind: OpenLinkKind
  url: string
}

/**
 * Decide what a clicked or pasted link means. Only web links get an in-app
 * preview window, `mailto:` goes straight to the OS, and `pilot-media:` is
 * answered by the preview window after the workspace jail check. Anything
 * else (file:, javascript:, custom app schemes) is refused.
 */
export function parseOpenLink(raw: unknown): OpenLinkTarget | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || text.length > 2048) return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  const scheme = parsed.protocol.toLowerCase()
  if (scheme === 'http:' || scheme === 'https:') return { kind: 'preview', url: parsed.toString() }
  if (scheme === 'mailto:' || scheme === 'tel:') return { kind: 'external', url: parsed.toString() }
  if (scheme === `${MEDIA_SCHEME}:`) return { kind: 'media', url: parsed.toString() }
  return null
}

/** Host shown on a link chip; keeps very long paths out of the UI. */
export function linkLabel(raw: string): string {
  try {
    const parsed = new URL(String(raw).trim())
    const rest = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '')
    const label = `${parsed.host}${rest === '/' ? '' : rest}`
    return label.length > 64 ? `${label.slice(0, 61)}…` : label
  } catch {
    const text = String(raw)
    return text.length > 64 ? `${text.slice(0, 61)}…` : text
  }
}
