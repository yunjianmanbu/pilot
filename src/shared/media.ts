/**
 * Pure helpers behind the in-app resource preview: what a file is, how it is
 * served over HTTP, how relative references resolve, and how the preview zooms.
 *
 * Kept free of Electron imports (and of `Buffer`) so the unit tests run them in
 * plain Node and the renderer can build the same URLs the main process serves.
 */

/** Custom scheme that streams workspace files into the renderer. */
export const MEDIA_SCHEME = 'pilot-media'

/** Host part of every generated URL; the jail check happens on the main side. */
const MEDIA_HOST = 'local'

/** Second path segment marking "serve this folder's subtree" instead of one file. */
const DIR_SEGMENT = 'd'

/**
 * `text` and `markdown` are read into memory and rendered by React; every other
 * kind is streamed by the protocol handler.
 */
export type PreviewKind = 'text' | 'markdown' | 'image' | 'video' | 'audio' | 'html'

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

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

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
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown'
  return 'text'
}

/** True when the main process has to read the file into memory as UTF-8. */
export function isTextKind(kind: PreviewKind): boolean {
  return kind === 'text' || kind === 'markdown'
}

/** True when the file can be shown by an <img>, <video> or <audio> tag. */
export function isMediaKind(kind: PreviewKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extensionOf(name)] ?? 'application/octet-stream'
}

/* ── media URLs ─────────────────────────────────────────────────────────── */

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function base64Char(value: number): string {
  return BASE64URL.charAt(value & 63)
}

/** base64url of the UTF-8 bytes, no padding — identical to Node's `base64url`. */
export function encodeMediaPath(relativePath: string): string {
  const bytes = new TextEncoder().encode(relativePath)
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    out += base64Char(first >> 2)
    out += base64Char(((first & 0b11) << 4) | ((second ?? 0) >> 4))
    if (second === undefined) break
    out += base64Char(((second & 0b1111) << 2) | ((third ?? 0) >> 6))
    if (third === undefined) break
    out += base64Char(third)
  }
  return out
}

/** Inverse of {@link encodeMediaPath}; null for anything that is not base64url. */
export function decodeMediaPath(encoded: string): string | null {
  const text = String(encoded ?? '')
  if (!text) return null
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = BASE64URL.indexOf(char)
    if (value < 0) return null
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  try {
    return new TextDecoder().decode(new Uint8Array(bytes)) || null
  } catch {
    return null
  }
}

/** `docs/a.md` → `docs`; `a.md` → ``. */
export function dirOf(filePath: string): string {
  const parts = posixSegments(filePath)
  parts.pop()
  return parts.join('/')
}

function posixSegments(value: string): string[] {
  return String(value ?? '')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
}

/**
 * `pilot-media://local/<base64url(workspace-relative path)>` — absolute paths
 * are refused, because the main process decodes this with the workspace jail.
 */
export function mediaUrlFor(relativePath: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeMediaPath(relativePath)}`
}

/**
 * Base URL of a folder, with the trailing slash kept so that a relative
 * reference inside a served document is appended instead of replacing the last
 * segment. The empty (workspace root) folder is encoded as `.`.
 */
export function mediaDirUrlFor(dir: string): string {
  const normalized = posixSegments(dir).join('/')
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${DIR_SEGMENT}/${encodeMediaPath(normalized || '.')}/`
}

/**
 * The same file as {@link mediaUrlFor}, but addressed *inside* its folder. A
 * local HTML page loaded from here resolves `img/logo.png` (and its own CSS/JS)
 * against the folder instead of a flat encoded blob.
 */
export function mediaFileUrlFor(relativePath: string): string {
  const segments = posixSegments(relativePath)
  const name = segments.pop() ?? ''
  if (!name) return mediaUrlFor(relativePath)
  return `${mediaDirUrlFor(segments.join('/'))}${encodeURIComponent(name)}`
}

export interface MediaUrlTarget {
  /** Folder the request is rooted at; empty for a single-file URL. */
  base: string
  /** Path below {@link base}: the file itself, or anything relative to it. */
  tail: string
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** Split a `pilot-media:` URL into its folder root and the path below it. */
export function parseMediaUrl(raw: unknown): MediaUrlTarget | null {
  if (typeof raw !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null
  // Only the host we generate is served; a foreign one is a malformed URL, not
  // a second route into the disk.
  if (parsed.host && parsed.host !== MEDIA_HOST) return null
  const segments = parsed.pathname.split('/').filter((part) => part.length > 0)
  if (segments[0] === DIR_SEGMENT) {
    const encoded = decodeSegment(segments[1] ?? '')
    const base = encoded === null ? null : decodeMediaPath(encoded)
    if (base === null) return null
    const rest: string[] = []
    for (const raw of segments.slice(2)) {
      const decoded = decodeSegment(raw)
      if (decoded === null) return null
      rest.push(decoded)
    }
    return { base: base === '.' ? '' : base, tail: rest.join('/') }
  }
  const decoded = segments[0] ? decodeMediaPath(decodeSegment(segments[0]) ?? '') : null
  return decoded ? { base: '', tail: decoded } : null
}

/**
 * Join a folder root and a relative tail into one workspace-relative path.
 * `..` is refused outright: a served page must not climb out of its folder.
 */
export function joinMediaPath(base: string, tail: string): string | null {
  const parts: string[] = []
  for (const raw of `${base}/${tail}`.split('/')) {
    const part = raw.trim()
    if (!part || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.length > 0 ? parts.join('/') : null
}

/** Workspace-relative path behind a `pilot-media:` URL, or null when malformed. */
export function mediaPathFromUrl(raw: unknown): string | null {
  const target = parseMediaUrl(raw)
  return target ? joinMediaPath(target.base, target.tail) : null
}

/**
 * Resolve a reference found inside `baseDir` (a markdown image, an HTML asset)
 * to a `pilot-media:` URL. Absolute, external and `..` references are refused,
 * so a document cannot point the renderer at anything outside the workspace.
 */
export function resolveMediaRef(baseDir: string, ref: unknown): string | null {
  if (typeof ref !== 'string') return null
  const text = ref.trim()
  if (!text) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return text.toLowerCase().startsWith(`${MEDIA_SCHEME}:`) ? text : null
  }
  if (text.startsWith('#') || text.startsWith('//')) return null
  const clean = text.split('#')[0]?.split('?')[0] ?? ''
  if (!clean) return null
  const decoded = decodeSegment(clean)
  if (decoded === null) return null
  // A leading slash means "from the workspace root", the same as a web server.
  const joined = joinMediaPath(decoded.startsWith('/') ? '' : baseDir, decoded)
  return joined ? mediaUrlFor(joined) : null
}

/* ── zoom ───────────────────────────────────────────────────────────────── */

/** Discrete zoom levels: enough range to read a diagram, never a lost state. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3] as const

export const ZOOM_MIN: number = ZOOM_STEPS[0]
export const ZOOM_MAX: number = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 3

/** Keep a zoom factor inside the supported range; junk becomes 100%. */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

function nearestZoomIndex(zoom: number): number {
  const target = clampZoom(zoom)
  let best = 0
  let bestDelta = Number.POSITIVE_INFINITY
  ZOOM_STEPS.forEach((step, index) => {
    const delta = Math.abs(step - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = index
    }
  })
  return best
}

/** Next preset level in `direction`; stops at the ends instead of wrapping. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const index = nearestZoomIndex(current)
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))]
  return next ?? 1
}

export function zoomLabel(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`
}

/**
 * Zoom intent of a key press: `1` in, `-1` out, `0` reset, `null` not a zoom
 * key. Callers pass `ctrlKey || metaKey` because both bind the same way.
 */
export function zoomShortcut(key: string, modifier: boolean): 1 | -1 | 0 | null {
  if (!modifier) return null
  if (key === '=' || key === '+' || key === 'Add') return 1
  if (key === '-' || key === '_' || key === 'Subtract') return -1
  if (key === '0') return 0
  return null
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
