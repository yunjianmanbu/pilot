/**
 * 拖拽 / 粘贴上传共用的一份规则：渲染进程挑出要传的文件，主进程照着这份契约
 * 再校验一遍。数量上限、空文件判定、文件名兜底和引用合并顺序都放在这里，
 * 两边不会各写一套而在边界上分叉。
 */

/** 一次上传最多收几个文件，和「上传文件」对话框保持一致。 */
/**
 * 一次上传最多收几个文件，和「上传文件」对话框保持一致。
 */
export const MAX_UPLOAD_FILES = 3
/** 一条消息里可以附的图片上限，和 agent/attachments 的 MAX_IMAGES 一致。 */
export const MAX_UPLOAD_IMAGES = 3
/** 拖拽/粘贴上传落在工作区的哪个目录（工作区相对路径）。 */
export const UPLOAD_DIRECTORY = 'uploads'
/** 一条消息里可以参照的路径上限。 */
export const MAX_MESSAGE_REFERENCES = 8

/** 没有磁盘路径的内容（剪贴板里的文件、拖进来的虚拟文件）走内存。 */
export interface UploadBlob {
  name: string
  data: ArrayBuffer
}

export interface UploadBatch {
  /** 本机磁盘上的绝对路径，由主进程决定复制还是直接引用。 */
  paths: string[]
  blobs: UploadBlob[]
}

export interface UploadPlan extends UploadBatch {
  /** 跳过的空条目数（多数是拖进来的空目录）。 */
  skipped: number
  /** 超出数量上限、没有收下的文件数。 */
  overflow: number
}

export interface PlanUploadOptions {
  /** 本批最多收几个文件。 */
  limit?: number
  /**
   * 强制读字节：图片要变成 data URL，即使有磁盘路径也不能只传路径。
   */
  readBytes?: boolean
}

/** 渲染进程侧的一层抽象：File 与测试用的假对象都满足这个形状。 */
export interface UploadCandidate {
  name: string
  type?: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/zip': '.zip',
}

/** 剪贴板里的截图往往没有文件名，用 MIME 补一个可读的扩展名。 */
export function extensionForType(type: string | undefined): string {
  if (!type) return ''
  return MIME_EXTENSIONS[type.toLowerCase()] ?? ''
}

/**
 * 拖进来/粘进来的是图片就走「随消息附图」（会被压成 data URL），否则当作
 * 工作区文件上传。SVG 不算：附图链路只接受位图。
 */
export function isImageUpload(file: { name: string; type?: string }): boolean {
  if (file.type?.startsWith('image/')) return file.type.toLowerCase() !== 'image/svg+xml'
  const name = file.name.toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot >= 0 && IMAGE_EXTENSIONS.has(name.slice(dot))
}

function isBinaryData(value: unknown): value is ArrayBuffer | Uint8Array {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

/**
 * 校验渲染进程递过来的一批上传内容。抛出的文案直接给用户看，所以写成中文短句。
 */
export function parseUploadBatch(input: unknown): UploadBatch {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const rawPaths = Array.isArray(record.paths) ? record.paths : []
  const paths: string[] = []
  for (const entry of rawPaths) {
    if (typeof entry !== 'string') throw new Error('上传路径不正确')
    const value = entry.trim()
    if (!value || paths.includes(value)) continue
    paths.push(value)
  }
  const rawBlobs = Array.isArray(record.blobs) ? record.blobs : []
  const blobs: UploadBlob[] = []
  for (let index = 0; index < rawBlobs.length; index += 1) {
    const entry = rawBlobs[index]
    const blob = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    if (!blob || !isBinaryData(blob.data)) throw new Error('上传内容不正确')
    const rawName = typeof blob.name === 'string' ? blob.name.trim() : ''
    blobs.push({ name: rawName || `upload-${index + 1}.bin`, data: blob.data as ArrayBuffer })
  }
  const total = paths.length + blobs.length
  if (total === 0) throw new Error('没有要上传的文件')
  if (total > MAX_UPLOAD_FILES) throw new Error(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件`)
  return { paths, blobs }
}

/**
 * 把拖拽/粘贴拿到的一批文件分成「有磁盘路径」和「只有字节」两组。
 * 有路径的交给主进程直接复制（不经过 IPC 传字节），没有路径的才读进内存。
 */
export async function planUpload(
  files: ArrayLike<UploadCandidate>,
  pathOf: (file: UploadCandidate) => string,
  options: PlanUploadOptions = {},
): Promise<UploadPlan> {
  const limit = Math.max(0, options.limit ?? MAX_UPLOAD_FILES)
  const plan: UploadPlan = { paths: [], blobs: [], skipped: 0, overflow: 0 }
  const list = Array.from(files)
  for (let index = 0; index < list.length; index += 1) {
    const file = list[index]
    if (!file) continue
    if (plan.paths.length + plan.blobs.length >= limit) {
      plan.overflow += 1
      continue
    }
    // webUtils.getPathForFile 对剪贴板内容和虚拟文件返回空串。
    const path = options.readBytes ? '' : (pathOf(file) || '').trim()
    if (path) {
      plan.paths.push(path)
      continue
    }
    // 目录拖进来时 Chromium 只给一个 size 为 0 的条目，读不出字节也别报错。
    if (!file.size) {
      plan.skipped += 1
      continue
    }
    const name = file.name.trim() || `upload-${index + 1}${extensionForType(file.type)}`
    plan.blobs.push({ name, data: await file.arrayBuffer() })
  }
  return plan
}

/**
 * 合并「参照」列表：去重、保序、按上限截断，并告诉调用方丢了几条。
 */
export function mergeReferences(
  current: string[],
  added: string[],
  limit: number = MAX_MESSAGE_REFERENCES,
): { references: string[]; dropped: number } {
  const merged = [...current]
  for (const entry of added) {
    const value = entry.trim()
    if (!value || merged.includes(value)) continue
    merged.push(value)
  }
  const references = merged.slice(0, limit)
  return { references, dropped: merged.length - references.length }
}
