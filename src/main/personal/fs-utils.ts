import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export function now(): string {
  return new Date().toISOString()
}

export function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function safeRelative(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.includes('\0') ||
    isAbsolute(normalized) ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    normalized.includes(':')
  ) {
    throw new Error(`贡献包包含不安全路径：${path}`)
  }
  return normalized
}

export function resolveInside(root: string, relative: string): string {
  const normalized = safeRelative(relative)
  const base = resolve(root)
  const target = resolve(base, ...normalized.split('/'))
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`路径越出源码目录：${relative}`)
  }
  return target
}

/** Resolve a write target while refusing to traverse symlinks out of the tree. */
export async function safeWriteTarget(root: string, relative: string): Promise<string> {
  const target = resolveInside(root, relative)
  const realRoot = await realpath(root)
  let parent = dirname(target)
  while (!(await exists(parent))) parent = dirname(parent)
  const realParent = await realpath(parent)
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`路径通过符号链接越出源码目录：${relative}`)
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`拒绝通过符号链接写入：${relative}`)
    }
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught
  }
  return target
}
