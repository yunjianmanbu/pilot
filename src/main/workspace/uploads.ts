// Phone/relay chunked uploads and desktop file imports.
// Split out of src/main/workspace.ts; statements are moved verbatim.
import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import type { FileNode, FilePreview, ShellInterpreter } from '../../shared/types'
import {
  mediaFileUrlFor,
  mediaDirUrlFor,
  mediaUrlFor,
  dirOf,
  isTextKind,
  previewKindOf,
  type PreviewKind,
} from '../../shared/media'
import { ephemeralDirSegment, looksEphemeralDirPath } from '../../shared/checkpoint-ignore'
import { gitBashLoginEnvironment, resolveShellLaunch } from '../shell'
import { diskSpace, diskWarning } from '../system-info'
import { assertInside, MAX_UPLOAD_BYTES, normalize, pathExists, requestPath, resolveForWrite, toPosix, UPLOAD_ID_RE, UPLOAD_NAME_MAX, workspaceRoot } from './shared'

/* ------------------------------------------------------------------ */
/* Phone uploads                                                       */
/* ------------------------------------------------------------------ */

/**
 * Phone uploads use the same workspace jail as every other file mutation.
 * The destination is a fresh file name under a workspace-relative directory:
 * existing files are never overwritten, they get a numbered sibling instead.
 */
export interface WorkspaceUploadPlan {
  /** Hidden temporary file next to the final destination. */
  tempPath: string
  target: string
  /** Workspace-relative path shown to the phone. */
  path: string
  name: string
}

export interface FinishedWorkspaceUpload {
  path: string
  name: string
  size: number
}

export function uploadName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('文件名不正确')
  const name = input.trim()
  if (!name || name === '.' || name === '..') throw new Error('文件名不正确')
  if (name.length > UPLOAD_NAME_MAX) throw new Error(`文件名不能超过 ${UPLOAD_NAME_MAX} 个字符`)
  if (name.includes('\0') || /[\\/]/.test(name)) throw new Error('文件名不能包含路径分隔符')
  if (/[<>:"|?*\u0000-\u001f\u007f]/.test(name)) throw new Error('文件名包含无效字符')
  if (/[. ]$/.test(name)) throw new Error('文件名不能以空格或句点结尾')
  if (name.startsWith('.pilot-upload-')) throw new Error('文件名是系统保留名称')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
    throw new Error('文件名是系统保留名称')
  }
  return name
}

export function uploadDirectory(input: unknown): string {
  if (input === undefined || input === null || input === '') return '.'
  if (typeof input !== 'string') throw new Error('上传目录不正确')
  const value = input.trim().replace(/\\/g, '/')
  if (!value || value === '.') return '.'
  if (value.split('/').includes('..')) throw new Error('上传目录不能跳出工作区')
  return requestPath(value)
}

/** Never overwrite an existing file: fall back to `name (1).ext`. */
export function numberedName(name: string, index: number): string {
  if (index === 0) return name
  const ext = extname(name)
  const suffix = ` (${index})`
  const stem = ext ? name.slice(0, -ext.length) : name
  const room = Math.max(1, UPLOAD_NAME_MAX - ext.length - suffix.length)
  return `${stem.slice(0, room)}${suffix}${ext}`
}

export async function availableUploadTarget(dir: string, name: string): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const target = join(dir, numberedName(name, index))
    if (!(await pathExists(target))) return target
  }
  throw new Error('同名文件太多，请先整理工作区后再上传')
}

/** Remove half-written temp files left behind by a crash or force-quit. */
export async function pruneUploadTemps(dir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const staleAfter = 10 * 60_000
  for (const entry of entries) {
    if (!entry.isFile() || !/^\.pilot-upload-[A-Za-z0-9_-]{8,80}\.part$/.test(entry.name)) {
      continue
    }
    const target = join(dir, entry.name)
    try {
      const info = await lstat(target)
      if (Date.now() - info.mtimeMs > staleAfter) await rm(target, { force: true })
    } catch {
      // Another upload may have finished it already.
    }
  }
}

export async function beginWorkspaceUpload(
  root: string,
  directory: unknown,
  name: unknown,
  size: unknown,
  uploadId: string,
): Promise<WorkspaceUploadPlan> {
  if (!UPLOAD_ID_RE.test(uploadId)) throw new Error('上传编号不正确')
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    throw new Error('文件大小不正确')
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(`单个文件不能超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`)
  }
  const cleanName = uploadName(name)
  const requested = await resolveForWrite(root, join(uploadDirectory(directory), cleanName))
  const parent = dirname(requested)
  await mkdir(parent, { recursive: true })
  await pruneUploadTemps(parent)
  // Anchor the destination to the real parent so a directory swapped for a
  // symlink during the upload cannot redirect the final rename.
  const base = await workspaceRoot(root)
  const realParent = await realpath(parent)
  assertInside(base, realParent)
  const target = await availableUploadTarget(realParent, cleanName)
  const tempPath = join(realParent, `.pilot-upload-${uploadId}.part`)
  await writeFile(tempPath, Buffer.alloc(0))
  return {
    tempPath,
    target,
    path: toPosix(relative(base, target)),
    name: basename(target),
  }
}

export async function appendWorkspaceUpload(tempPath: string, data: Buffer): Promise<void> {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('上传分块为空')
  const handle = await open(tempPath, 'a')
  try {
    await handle.appendFile(data)
  } finally {
    await handle.close()
  }
}

export async function finishWorkspaceUpload(
  root: string,
  tempPath: string,
  name: unknown,
  size: number,
): Promise<FinishedWorkspaceUpload> {
  const base = await workspaceRoot(root)
  const realTemp = await realpath(tempPath)
  assertInside(base, realTemp)
  const parent = dirname(realTemp)
  assertInside(base, parent)
  const info = await stat(realTemp)
  if (!info.isFile()) throw new Error('上传的临时文件不存在')
  if (!Number.isFinite(size) || info.size !== size) {
    throw new Error('文件分块不完整，请重新上传')
  }
  const cleanName = uploadName(name)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const target = await availableUploadTarget(parent, cleanName)
    try {
      await rename(realTemp, target)
      return {
        path: toPosix(relative(base, target)),
        name: basename(target),
        size: info.size,
      }
    } catch (error) {
      // Another upload may have claimed the same name after our check.
      if (await pathExists(target)) continue
      throw error
    }
  }
  throw new Error('同名文件太多，请先整理工作区后再上传')
}

export async function abortWorkspaceUpload(tempPath: string): Promise<void> {
  await rm(tempPath, { force: true })
}

/**
 * Copy a file the user picked on this computer into the workspace.
 *
 * The phone has to stream through the relay in chunks; the desktop can copy
 * straight from disk. The destination follows the same rules as the relay
 * upload: it lands under `uploads/`, an existing file is never overwritten,
 * and a file that already lives in the workspace is referenced in place so a
 * second copy does not appear.
 */
export async function importWorkspaceFile(
  root: string,
  directory: unknown,
  sourcePath: unknown,
): Promise<FinishedWorkspaceUpload> {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new Error('请选择要上传的文件')
  }
  const source = resolve(sourcePath.trim())
  const info = await stat(source).catch(() => null)
  if (!info || !info.isFile()) throw new Error(`找不到要上传的文件：${basename(source)}`)
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `「${basename(source)}」超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
    )
  }
  const base = await workspaceRoot(root)
  const realSource = await realpath(source)
  const inside = relative(normalize(base), normalize(realSource))
  const withinWorkspace =
    inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
  if (withinWorkspace) {
    return { path: toPosix(inside), name: basename(realSource), size: info.size }
  }
  const cleanName = uploadName(basename(realSource))
  const requested = await resolveForWrite(
    root,
    join(uploadDirectory(directory ?? 'uploads'), cleanName),
  )
  const parent = dirname(requested)
  await mkdir(parent, { recursive: true })
  // Anchor the copy to the real parent so a directory swapped for a symlink
  // cannot redirect the write outside the workspace.
  const realParent = await realpath(parent)
  assertInside(base, realParent)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const target = await availableUploadTarget(realParent, cleanName)
    try {
      // COPYFILE_EXCL keeps a concurrent upload from being overwritten.
      await copyFile(realSource, target, constants.COPYFILE_EXCL)
      return {
        path: toPosix(relative(base, target)),
        name: basename(target),
        size: info.size,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('同名文件太多，请先整理工作区后再上传')
}

/**
 * 把剪贴板或拖拽拿到的一段内存写进工作区。没有源路径可以复制，所以直接落盘，
 * 但目标目录、命名和同名避让和 `importWorkspaceFile` 走同一套规则。
 */
export async function importWorkspaceBytes(
  root: string,
  directory: unknown,
  name: unknown,
  data: Buffer,
): Promise<FinishedWorkspaceUpload> {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('上传内容为空')
  const cleanName = uploadName(name)
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new Error(`「${cleanName}」超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`)
  }
  const requested = await resolveForWrite(
    root,
    join(uploadDirectory(directory ?? 'uploads'), cleanName),
  )
  const parent = dirname(requested)
  await mkdir(parent, { recursive: true })
  const base = await workspaceRoot(root)
  const realParent = await realpath(parent)
  assertInside(base, realParent)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const target = await availableUploadTarget(realParent, cleanName)
    try {
      // wx 等价于 COPYFILE_EXCL：并发上传同名内容时后者让位，不覆盖已存在的文件。
      await writeFile(target, data, { flag: 'wx' })
      return { path: toPosix(relative(base, target)), name: basename(target), size: data.length }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error('同名文件太多，请先整理工作区后再上传')
}
