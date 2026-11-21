/**
 * In-app resource preview.
 *
 * Three pieces live here:
 * - the `pilot-media` protocol, which streams files of the *open workspace*
 *   into the renderer (with Range support so video seeking works);
 * - one reusable preview window for web pages, local HTML and direct media
 *   URLs, isolated in a memory-only session;
 * - the link opener that decides between in-app preview and the OS browser.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { BrowserWindow, session, shell, protocol } from 'electron'
import { contentTypeFor, MEDIA_SCHEME, linkLabel, parseByteRange, parseOpenLink } from '../shared/media'
import { windowIconOption } from './app-icon'
import { resolveMediaTarget, mediaPathFromUrl } from './workspace'

/**
 * A local HTML page is untrusted content: inline script is allowed (charts and
 * reports need it) but every network channel is closed. Without this a file the
 * agent wrote — or one it downloaded — could read other workspace files through
 * `pilot-media:` URLs and post them somewhere, because a sandboxed frame still
 * resolves its own origin's URLs.
 */
export const HTML_PREVIEW_CSP = [
  `default-src 'self' ${MEDIA_SCHEME}: data:`,
  `script-src 'unsafe-inline' 'unsafe-eval' ${MEDIA_SCHEME}: data:`,
  `style-src 'unsafe-inline' ${MEDIA_SCHEME}: data:`,
  `img-src ${MEDIA_SCHEME}: data: blob:`,
  `media-src ${MEDIA_SCHEME}: data: blob:`,
  `font-src ${MEDIA_SCHEME}: data:`,
  `connect-src ${MEDIA_SCHEME}: data:`,
  `frame-src ${MEDIA_SCHEME}:`,
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** Preview windows get their own memory-only session: no cookies, no storage. */
const PREVIEW_PARTITION = 'pilot-preview'
const MAX_PREVIEW_TITLE = 120

let previewWindow: BrowserWindow | null = null

/** Must run before `app.whenReady()`; Electron only accepts privileges that early. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ])
}

/** Answer one `pilot-media://` request; anything outside the workspace is a 404. */
export async function serveMediaRequest(
  request: Request,
  activeRoot: () => string | null,
): Promise<Response> {
  const relativePath = mediaPathFromUrl(request.url)
  const root = activeRoot()
  if (!relativePath || !root) return new Response('Not found', { status: 404 })
  const target = await resolveMediaTarget(root, relativePath)
  if (!target) return new Response('Not found', { status: 404 })
  let size: number
  try {
    const info = await stat(target)
    if (!info.isFile()) return new Response('Not found', { status: 404 })
    size = info.size
  } catch {
    return new Response('Not found', { status: 404 })
  }

  const contentType = contentTypeFor(target)
  const headers = new Headers({
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  // HTML is rendered in a sandboxed frame; the header is what keeps that frame
  // from talking to the network at all.
  if (contentType.startsWith('text/html')) headers.set('content-security-policy', HTML_PREVIEW_CSP)
  const range = parseByteRange(request.headers.get('range'), size)
  const nodeStream = range
    ? createReadStream(target, { start: range.start, end: range.end })
    : createReadStream(target)
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`)
    headers.set('content-length', String(range.end - range.start + 1))
  } else {
    headers.set('content-length', String(size))
  }
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status: range ? 206 : 200, headers })
}

/**
 * Install the `pilot-media` handler on the main session and on the preview
 * session, so a local HTML page and its images/video resolve inside the
 * preview window too.
 */
export function installMediaProtocol(activeRoot: () => string | null): void {
  protocol.handle(MEDIA_SCHEME, (request) => serveMediaRequest(request, activeRoot))
  session
    .fromPartition(PREVIEW_PARTITION)
    .protocol.handle(MEDIA_SCHEME, (request) => serveMediaRequest(request, activeRoot))
}

function previewSession(): Electron.Session {
  const partition = session.fromPartition(PREVIEW_PARTITION)
  // A previewed page is untrusted content: no camera, mic, clipboard or
  // notifications, and no permission prompt that could be mistaken for ours.
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  return partition
}

function titleFor(url: string): string {
  const relativePath = mediaPathFromUrl(url)
  const label = relativePath ? basename(relativePath) : linkLabel(url)
  return label.length > MAX_PREVIEW_TITLE ? `${label.slice(0, MAX_PREVIEW_TITLE - 1)}…` : label
}

/**
 * A local HTML page often ships without any CSS, so its black default text
 * would sit on the dark window backdrop and read as garbage. Give such a page
 * a light canvas; a page that declares its own background keeps it untouched.
 */
const BACKDROP_CSS = `:root { background-color: #fbfbfb !important; color-scheme: light; }
body { color: #1f2328; }`

async function ensureReadableBackdrop(contents: Electron.WebContents): Promise<void> {
  if (!mediaPathFromUrl(contents.getURL())) return
  try {
    const plain = await contents.executeJavaScript(
      `(() => {
        const clear = (value) => !value || value === 'transparent' || /^rgba\\(0, 0, 0, 0\\)$/.test(value)
        const root = getComputedStyle(document.documentElement).backgroundColor
        const body = document.body ? getComputedStyle(document.body).backgroundColor : 'transparent'
        return clear(root) && clear(body)
      })()`,
      true,
    )
    if (plain === true) await contents.insertCSS(BACKDROP_CSS)
  } catch {
    // A page that refuses the probe just keeps the window backdrop.
  }
}

/** Show `url` in the single reusable preview window, creating it on first use. */
export function openPreviewWindow(url: string): void {
  previewSession()
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.setTitle(titleFor(url))
    void previewWindow.loadURL(url)
    if (previewWindow.isMinimized()) previewWindow.restore()
    previewWindow.show()
    previewWindow.focus()
    return
  }
  const created = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 640,
    minHeight: 480,
    title: titleFor(url),
    ...windowIconOption(),
    backgroundColor: '#191a1c',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PREVIEW_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  previewWindow = created
  created.on('closed', () => {
    if (previewWindow === created) previewWindow = null
  })
  created.webContents.setWindowOpenHandler(({ url: next }) => {
    // A previewed page may not spawn more windows; hand those to the browser.
    if (/^(https?|mailto):/i.test(next)) void shell.openExternal(next)
    return { action: 'deny' }
  })
  created.webContents.on('will-navigate', (event, next) => {
    if (!/^(https?|pilot-media):/i.test(next)) event.preventDefault()
  })
  // Kept for the window's whole life, so it also covers every later reuse.
  created.webContents.on('did-finish-load', () => {
    void ensureReadableBackdrop(created.webContents)
  })
  void created.loadURL(url)
}

export interface OpenLinkOptions {
  /** Hand the link to the system browser instead of the in-app window. */
  external?: boolean
  /** Root of the open workspace, used as the jail for `pilot-media` links. */
  activeRoot: () => string | null
}

/**
 * Open a link the user clicked. Web links preview inside the app, `mailto:`
 * and explicit "open in browser" go to the OS, and local media/HTML links are
 * only opened when the file is still inside the open workspace.
 */
export async function openLink(raw: unknown, options: OpenLinkOptions): Promise<void> {
  const target = parseOpenLink(raw)
  if (!target) throw new Error('Only web links, mail links and workspace files can be opened')
  if (options.external === true || target.kind === 'external') {
    await shell.openExternal(target.url)
    return
  }
  if (target.kind === 'media') {
    const relativePath = mediaPathFromUrl(target.url)
    const root = options.activeRoot()
    if (!relativePath || !root || !(await resolveMediaTarget(root, relativePath))) {
      throw new Error('This file is outside the open workspace')
    }
  }
  openPreviewWindow(target.url)
}
