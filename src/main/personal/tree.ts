import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PersonalChangedFile } from '../../shared/types'
import { exists, sha256 } from './fs-utils'

const MAX_FILES = 1_200
const MAX_FILE_BYTES = 2 * 1024 * 1024
export const EXCLUDED_DIRS = new Set([
  '.git',
  '.pilot',
  '.pilot-upgrade',
  '.selfdev-build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'release-selfdev',
])

export const EXCLUDED_FILES = new Set([
  '.DS_Store',
  'build/self-source-package.json',
  'keystore-password.txt',
])

export const FORBIDDEN_SUFFIXES = ['.jks', '.keystore', '.pem', '.key', '.pfx', '.p12', '.log']

export interface TreeEntry {
  path: string
  absolute: string
  size: number
  /** 用于指纹缓存的重算判据：任一文件被改写都会推高新 mtime。 */
  mtimeMs: number
}

export function isExcludedFile(relative: string): boolean {
  if (EXCLUDED_FILES.has(relative)) return true
  const lower = relative.toLowerCase()
  if (FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('/.env')) return true
  return false
}

export async function walk(
  root: string,
  relative = '',
  output: TreeEntry[] = [],
  limits = true,
): Promise<TreeEntry[]> {
  const directory = relative ? join(root, ...relative.split('/')) : root
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      await walk(root, path, output, limits)
      continue
    }
    if (!entry.isFile()) continue
    if (isExcludedFile(path)) continue
    const info = await stat(join(root, ...path.split('/')))
    if (limits && info.size > MAX_FILE_BYTES) {
      throw new Error(`文件过大，无法放入个人版本：${path}（${(info.size / 1024).toFixed(0)} KiB）`)
    }
    output.push({
      path,
      absolute: join(root, ...path.split('/')),
      size: info.size,
      mtimeMs: info.mtimeMs,
    })
    if (limits && output.length > MAX_FILES) {
      throw new Error(`改动文件过多（超过 ${MAX_FILES} 个），请拆分成更小的版本。`)
    }
  }
  return output
}

/** 整棵树的指纹：路径 + 每个文件的 sha256，顺序稳定。 */
export async function hashTree(input: TreeEntry[]): Promise<string> {
  const entries = [...input].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(sha256(await readFile(entry.absolute)))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** Fingerprint of the whole source tree, used to match a build to its source. */
export async function sourceFingerprint(root: string): Promise<string> {
  return hashTree(await walk(root, '', [], false))
}

/**
 * 只 stat 的树签名：文件数、总字节、最新 mtime。
 *
 * 进化页每次打开都会问一次「基线有没有变」，而真正算指纹要把 8 MiB 全部读一遍
 * 再算 sha256（实测约 1.6 s）。签名只多花约 0.25 s，未变时直接复用上次结果。
 */
export function treeSignature(entries: TreeEntry[]): string {
  let bytes = 0
  let newest = 0
  for (const entry of entries) {
    bytes += entry.size
    if (entry.mtimeMs > newest) newest = entry.mtimeMs
  }
  return `${entries.length}:${bytes}:${newest}`
}

export interface FingerprintMemo {
  hash: string
  signature: string
  /** 上次「确认未变」的时间。在 TTL 内直接复用，不再扫目录。 */
  checkedAt?: number
}

/**
 * 官方基线树只由本进程写（快照/合并/升级/回滚），那几处都会显式失效；
 * 所以短时间内无需每次重新 stat 整棵树（Windows 上 610 个文件约 0.3-1.5 s）。
 * 窗口刻意留短：安装包升级会替换官方基线，那是本进程看不到的外部变化。
 */
export const FINGERPRINT_TRUST_MS = 30_000

const fingerprintMemos = new Map<string, FingerprintMemo>()

/**
 * 指纹缓存文件（userData 下）。重新启动后第一张进化页仍要把整棵树读一遍，
 * 落盘后签名命中就能直接复用，省掉约 1.5 s 的读盘与 sha256。
 */
let fingerprintCachePath: string | null = null
let diskMemos: Record<string, FingerprintMemo> | null = null

export function configureFingerprintCache(path: string | null): void {
  fingerprintCachePath = path
  diskMemos = null
}

async function readDiskMemos(): Promise<Record<string, FingerprintMemo>> {
  if (diskMemos) return diskMemos
  if (!fingerprintCachePath) return {}
  try {
    const parsed = JSON.parse(await readFile(fingerprintCachePath, 'utf8')) as Record<
      string,
      FingerprintMemo
    >
    diskMemos = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    diskMemos = {}
  }
  return diskMemos
}

async function writeDiskMemo(root: string, memo: FingerprintMemo): Promise<void> {
  if (!fingerprintCachePath) return
  const memos = await readDiskMemos()
  memos[root] = memo
  try {
    await mkdir(dirname(fingerprintCachePath), { recursive: true })
    await writeFile(fingerprintCachePath, JSON.stringify(memos), 'utf8')
  } catch {
    // A cache write failure only costs the next process a recompute.
  }
}

/**
 * `sourceFingerprint` 的记忆版：签名未变就不重复读整棵树。
 *
 * `trustMs` > 0 时，在窗口内直接采信已确认的结果、不再扫目录。只适用于
 * 由应用自己维护的树（官方基线）；用户可写的目录必须传 0 保持逐次校验。
 * 落盘结果只用来省掉“重新读整棵树 + sha256”，签名对不上就重算。
 */
export async function cachedSourceFingerprint(root: string, trustMs = 0): Promise<string> {
  const memo = fingerprintMemos.get(root)
  if (trustMs > 0 && memo?.checkedAt && Date.now() - memo.checkedAt < trustMs) return memo.hash
  const entries = await walk(root, '', [], false)
  const signature = treeSignature(entries)
  if (memo && memo.signature === signature) {
    memo.checkedAt = Date.now()
    return memo.hash
  }
  const stored = (await readDiskMemos())[root]
  if (stored && stored.signature === signature) {
    const hit = { ...stored, checkedAt: Date.now() }
    fingerprintMemos.set(root, hit)
    return hit.hash
  }
  const hash = await hashTree(entries)
  const fresh = { hash, signature, checkedAt: Date.now() }
  fingerprintMemos.set(root, fresh)
  await writeDiskMemo(root, { hash, signature })
  return hash
}

/** 树刚被本进程改过（快照/合并/升级），丢掉对应指纹。 */
export function forgetSourceFingerprint(root: string): void {
  fingerprintMemos.delete(root)
  if (diskMemos) delete diskMemos[root]
}

/** Test seam: forget every memoised fingerprint. */
export function resetFingerprintMemo(): void {
  fingerprintMemos.clear()
  diskMemos = null
}

export async function tree(root: string): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>()
  for (const entry of await walk(root)) result.set(entry.path, entry)
  return result
}

export async function hashEntry(entry: TreeEntry): Promise<string> {
  return sha256(await readFile(entry.absolute))
}

/**
 * True when two files differ only in line endings.
 *
 * A checkout with `core.autocrlf` has CRLF in the working tree but LF in the
 * blobs, and an official baseline extracted from git has LF. Comparing bytes
 * blindly would report every file as modified on Windows. The hashes reported
 * to the user stay byte-exact (the official importer recomputes them), so this
 * only affects the equality test.
 */
async function sameContent(left: TreeEntry, right: TreeEntry): Promise<boolean> {
  const [a, b] = await Promise.all([readFile(left.absolute), readFile(right.absolute)])
  if (a.equals(b)) return true
  if (a.includes(0) || b.includes(0)) return false
  return a.toString('utf8').replace(/\r\n/g, '\n') === b.toString('utf8').replace(/\r\n/g, '\n')
}

/** Compare the official source with the user's copy without trusting mtimes. */
export async function scanSourceChanges(
  sourcePath: string,
  basePath: string,
): Promise<PersonalChangedFile[]> {
  const source = await tree(sourcePath)
  const base = await tree(basePath)
  const paths = new Set([...source.keys(), ...base.keys()])
  const changes: PersonalChangedFile[] = []
  for (const path of [...paths].sort()) {
    const sourceEntry = source.get(path)
    const baseEntry = base.get(path)
    if (!sourceEntry && !baseEntry) continue
    if (sourceEntry && !baseEntry) {
      changes.push({
        path,
        status: 'added',
        beforeSha256: null,
        afterSha256: await hashEntry(sourceEntry),
        size: sourceEntry.size,
        text: isUtf8(await readFile(sourceEntry.absolute)),
      })
      continue
    }
    if (!sourceEntry && baseEntry) {
      changes.push({
        path,
        status: 'deleted',
        beforeSha256: await hashEntry(baseEntry),
        afterSha256: null,
        size: baseEntry.size,
        text: true,
      })
      continue
    }
    if (!sourceEntry || !baseEntry) continue
    // Line-ending-only differences are not a user edit; see sameContent().
    if (await sameContent(baseEntry, sourceEntry)) continue
    const [beforeSha256, afterSha256] = await Promise.all([
      hashEntry(baseEntry),
      hashEntry(sourceEntry),
    ])
    changes.push({
      path,
      status: 'modified',
      beforeSha256,
      afterSha256,
      size: sourceEntry.size,
      text: isUtf8(await readFile(sourceEntry.absolute)),
    })
  }
  return changes
}

/** Tree listing without the per-file size limits used by saved versions. */
export async function rawTree(root: string): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>()
  for (const entry of await walk(root, '', [], false)) result.set(entry.path, entry)
  return result
}
