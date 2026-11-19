/**
 * Validation for attachments that arrive from the renderer or the phone.
 *
 * Images are persisted inside the session JSON and also travel to the phone
 * through the encrypted relay, whose envelope is capped at 512 KB. Keep a
 * single message well below that budget so a queued or replayed session page
 * still fits. A reference is another project workspace: the renderer sends its
 * absolute path and the runner only accepts paths that are already registered
 * workspaces, then exposes them to file tools as read-only roots. Relative
 * paths remain accepted for messages written by older clients.
 */

import { isAbsolute } from 'node:path'

export const MAX_IMAGES = 3
export const MAX_IMAGE_DATA_URL_CHARS = 120_000
export const MAX_TOTAL_IMAGE_CHARS = 360_000
export const MAX_REFERENCES = 8
export const MAX_REFERENCE_CHARS = 1_000

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\r\n]+$/i

export function sanitizeImages(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('图片格式不正确')
  const images: string[] = []
  let total = 0
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('图片格式不正确')
    const dataUrl = entry.trim()
    if (!dataUrl) continue
    if (!IMAGE_DATA_URL.test(dataUrl)) throw new Error('只支持 PNG、JPEG、WebP 或 GIF 图片')
    if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) throw new Error('单张图片太大，请压缩后再发送')
    total += dataUrl.length
    if (total > MAX_TOTAL_IMAGE_CHARS) throw new Error('图片总量太大，请减少数量后再发送')
    images.push(dataUrl)
  }
  if (images.length > MAX_IMAGES) throw new Error(`一次最多发送 ${MAX_IMAGES} 张图片`)
  return images
}

export function sanitizeReferences(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('参照格式不正确')
  const seen = new Set<string>()
  const references: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('参照格式不正确')
    const path = entry.trim().replace(/\\/g, '/')
    if (!path || path.includes('\0')) continue
    if (isAbsolute(path)) {
      // Absolute paths name another workspace. Membership is verified by the
      // runner against the store, never trusted from the message alone.
      if (path.length > MAX_REFERENCE_CHARS) throw new Error('参照路径太长')
    } else {
      if (path.split('/').includes('..')) {
        throw new Error('参照必须是其他已打开的工作区，或当前工作区内的相对路径')
      }
      if (path.length > MAX_REFERENCE_CHARS) throw new Error('参照路径太长')
    }
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) continue
    seen.add(key)
    references.push(path)
  }
  if (references.length > MAX_REFERENCES) {
    throw new Error(`一次最多参照 ${MAX_REFERENCES} 个项目`)
  }
  return references
}
