import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCapturer, type BrowserWindow, type NativeImage } from 'electron'

/**
 * Screenshot capture for the agent. Privacy boundaries:
 * - default target is one window, never the whole desktop;
 * - a full-screen capture requires an explicit `target: "screen"` request;
 * - the model may name a window title, otherwise Pilot captures its own window.
 *
 * The image is compressed to a bounded JPEG data URL before it is attached to
 * the conversation. `screenshotFeedback` can turn attachment off entirely.
 */
export const MAX_SCREENSHOT_DATA_URL_CHARS = 110_000
const MAX_KEPT_FILES = 40
const DEFAULT_MAX_WIDTH = 1_440

export interface ScreenshotRequest {
  target?: 'window' | 'screen'
  windowTitle?: string
  /**
   * Exact `desktopCapturer` source id, e.g. "window:12345:0". Two windows can
   * share a title (two Pilot instances), so an id is the only unambiguous
   * selector. Get one from list_windows.
   */
  windowId?: string
  label?: string
  maxWidth?: number
}

export interface CapturableWindow {
  id: string
  title: string
}

/** List capturable windows with their stable desktopCapturer ids. */
export async function listCapturableWindows(): Promise<CapturableWindow[]> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  })
  return sources.map((source) => ({ id: source.id, title: source.name }))
}

export interface ScreenshotCapture {
  dataUrl: string
  width: number
  height: number
  target: string
  path: string | null
  bytes: number
}

function safeLabel(value: string | undefined): string {
  const text = (value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return text.slice(0, 48) || 'screenshot'
}

/**
 * Encode an image as JPEG, shrinking until the data URL fits the model's
 * per-image budget. Throws instead of sending an oversized payload.
 */
export function encodeJpegDataUrl(
  image: NativeImage,
  maxWidth = DEFAULT_MAX_WIDTH,
): { dataUrl: string; width: number; height: number; bytes: number } {
  const original = image.getSize()
  if (original.width < 1 || original.height < 1) throw new Error('Captured image is empty')
  const targetWidth = Math.min(maxWidth, original.width)
  const widths = [
    ...new Set(
      [targetWidth, 1_440, 1_200, 1_000, 800, 640, 480, 360, 280].filter(
        (width) => width <= targetWidth,
      ),
    ),
  ]
  for (const width of widths.length > 0 ? widths : [original.width]) {
    const scaled =
      original.width > width ? image.resize({ width, quality: 'good' }) : image
    for (const quality of [78, 62, 48, 36, 28]) {
      const jpeg = scaled.toJPEG(quality)
      const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`
      if (dataUrl.length <= MAX_SCREENSHOT_DATA_URL_CHARS) {
        const size = scaled.getSize()
        return { dataUrl, width: size.width, height: size.height, bytes: jpeg.length }
      }
    }
  }
  throw new Error(
    `Screenshot is too large to attach (limit ${MAX_SCREENSHOT_DATA_URL_CHARS} characters). Capture a smaller window or set screenshotFeedback off.`,
  )
}

async function pruneScreenshots(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((name) => /\.jpg$/i.test(name)).sort()
    const excess = names.length - MAX_KEPT_FILES
    for (const name of names.slice(0, Math.max(0, excess))) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  } catch {
    // Retention is best-effort; a failed prune must not fail the capture.
  }
}

async function saveImage(dir: string, name: string, bytes: Buffer): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true })
    await pruneScreenshots(dir)
    const path = join(dir, name)
    await writeFile(path, bytes)
    return path
  } catch {
    return null
  }
}

function toBuffer(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

export async function captureScreenshot(input: {
  window: BrowserWindow | null
  saveDir: string
  request: ScreenshotRequest
}): Promise<ScreenshotCapture> {
  const { request } = input
  const target = request.target === 'screen' ? 'screen' : 'window'
  const maxWidth = Math.min(
    2_560,
    Math.max(480, Math.round(request.maxWidth ?? DEFAULT_MAX_WIDTH) || DEFAULT_MAX_WIDTH),
  )

  let image: NativeImage
  let targetLabel = target
  const title = request.windowTitle?.trim() ?? ''
  const windowId = request.windowId?.trim() ?? ''

  if (target === 'window' && !title && !windowId) {
    if (!input.window || input.window.isDestroyed()) {
      throw new Error(
        'No window to capture. Pass windowId from list_windows, or windowTitle with the title of the app window you started.',
      )
    }
    image = await input.window.webContents.capturePage()
    targetLabel = 'pilot-window'
  } else {
    const types: Array<'window' | 'screen'> = [target]
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: maxWidth, height: Math.round((maxWidth * 9) / 16) },
      fetchWindowIcons: false,
    })
    if (sources.length === 0) throw new Error(`No capturable ${target} found`)
    const source = windowId
      ? sources.find((entry) => entry.id === windowId)
      : title
        ? sources.find((entry) => entry.name.toLowerCase().includes(title.toLowerCase()))
        : sources[0]
    if (!source) {
      throw new Error(
        windowId
          ? `No ${target} with id "${windowId}". Available: ${sources
              .map((entry) => `${entry.id} | ${entry.name}`)
              .slice(0, 12)
              .join(' ; ')}`
          : `No ${target} whose title contains "${title}". Call list_windows for exact ids, or use this list: ${sources
              .map((entry) => `${entry.id} | ${entry.name}`)
              .slice(0, 12)
              .join(' ; ')}`,
      )
    }
    image = source.thumbnail
    targetLabel = target === 'screen' ? 'screen' : `window:${source.name}`
  }

  const encoded = encodeJpegDataUrl(image, maxWidth)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = await saveImage(
    input.saveDir,
    `${stamp}-${safeLabel(request.label ?? title)}.jpg`,
    toBuffer(encoded.dataUrl),
  )
  return {
    dataUrl: encoded.dataUrl,
    width: encoded.width,
    height: encoded.height,
    target: targetLabel,
    path,
    bytes: encoded.bytes,
  }
}
