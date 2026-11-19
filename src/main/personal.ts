import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type {
  ContributionEvidence,
  PersonalChangedFile,
  PersonalContribution,
  PersonalEvolutionState,
  PersonalUpgradeConflict,
  PersonalUpgradeConflictReason,
  PersonalUpgradePlan,
  PersonalUpgradeReport,
  PersonalUpgradeResult,
  PersonalUpgradeStatus,
  PersonalUpgradeValidation,
  PersonalVersion,
  PersonalVersionInput,
  SourceProvenance,
} from '../shared/types'

const FORMAT = 'pilot-contribution/v1'
const MAX_FILES = 1_200
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_VERSIONS = 40
const MAX_CONTRIBUTIONS = 50

const HARD_SECRET_PATTERN = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|secret:\/\/)/i
const SOFT_SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})/i

/**
 * Fixtures under tests/ often contain fake keys. They are still shown to the
 * maintainer, but do not block export; real credentials and private keys do.
 */
function isFixturePath(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    lower.startsWith('tests/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/') ||
    lower.includes('/fixtures/') ||
    /\.(test|spec)\.[a-z0-9]+$/.test(lower)
  )
}

function containsSecret(text: string, path?: string): boolean {
  if (HARD_SECRET_PATTERN.test(text)) return true
  if (!SOFT_SECRET_PATTERN.test(text)) return false
  return !path || !isFixturePath(path)
}
const EXCLUDED_DIRS = new Set([
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

const EXCLUDED_FILES = new Set([
  '.DS_Store',
  'build/self-source-package.json',
  'keystore-password.txt',
])

const FORBIDDEN_SUFFIXES = ['.jks', '.keystore', '.pem', '.key', '.pfx', '.p12', '.log']

interface TreeEntry {
  path: string
  absolute: string
  size: number
  /** 用于指纹缓存的重算判据：任一文件被改写都会推高新 mtime。 */
  mtimeMs: number
}

interface ForkRecord {
  forkId: string
  name: string
  createdAt: string
  baseVersion: string
  /** Fingerprint of the official tree captured when the fork was created. */
  baseHash?: string
}

interface MergeHunk {
  baseStart: number
  baseEnd: number
  sideStart: number
  sideEnd: number
}

interface TaggedHunk extends MergeHunk {
  side: 'mine' | 'theirs'
  sideLines: string[]
}

interface MergeOutcome {
  text: string
  conflicts: number
}

interface UpgradeAction {
  path: string
  kind: 'upstream' | 'merged' | 'conflict'
  /** Official bytes for `upstream`, merged text for `merged`. */
  content?: Buffer | string
  /** Conflict-marked text when both sides changed the same lines. */
  markerText?: string
  reason?: PersonalUpgradeConflictReason
}

interface InternalUpgradePlan {
  available: boolean
  fromVersion: string
  toVersion: string
  requiresManual: boolean
  currentHash: string
  counts: PersonalUpgradePlan['counts']
  conflicts: PersonalUpgradeConflict[]
  actions: UpgradeAction[]
}

interface UpgradeBackupFile {
  path: string
  beforeSha256: string | null
}

interface UpgradeRecord {
  id: string
  createdAt: string
  fromVersion: string
  toVersion: string
  fromHash: string
  toHash: string
  files: UpgradeBackupFile[]
  applied: number
  kept: number
  merged: number
  conflicts: PersonalUpgradeConflict[]
  validation?: PersonalUpgradeValidation
  validatedAt?: string
  message?: string
  output?: string
  rolledBackAt?: string
}

const MAX_MERGE_LINES = 2_000
const MAX_MERGE_CELLS = 2_000_000

interface VersionManifest extends PersonalVersion {}

interface StoredContribution extends PersonalContribution {}

interface ContributionFile extends PersonalChangedFile {
  /** Present for added and modified files, absent when the file was deleted. */
  contentBase64?: string
}

interface ContributionPayload {
  format: typeof FORMAT
  id: string
  createdAt: string
  note: string
  fork: {
    id: string
    name: string
    baseVersion: string
  }
  version: {
    id: string
    name: string
    note: string
    baseVersion: string
  }
  appVersion: string
  files: ContributionFile[]
  evidence?: ContributionEvidence
}

interface ContributionBundle extends ContributionPayload {
  checksum: string
}

export interface PersonalServiceOptions {
  /** The user's editable copy. */
  sourcePath: string
  /** Official source tree to diff against. */
  basePath: string
  baseReadOnly: boolean
  /** Usually <userData>/personal. */
  dataDir: string
  appVersion: string
  /** Optional HTTPS receiver. Without it, submissions are exported locally. */
  endpoint?: string
  /**
   * Where `basePath` came from. Passed through to `state()` so the panel can
   * say which official commit the fork is measured against.
   */
  provenance?: SourceProvenance
}

function now(): string {
  return new Date().toISOString()
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Deterministic JSON so the client and the official importer agree on checksums. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

export function contributionChecksum(payload: unknown): string {
  return sha256(stableStringify(payload))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function safeRelative(path: string): string {
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

function resolveInside(root: string, relative: string): string {
  const normalized = safeRelative(relative)
  const base = resolve(root)
  const target = resolve(base, ...normalized.split('/'))
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`路径越出源码目录：${relative}`)
  }
  return target
}

/** Resolve a write target while refusing to traverse symlinks out of the tree. */
async function safeWriteTarget(root: string, relative: string): Promise<string> {
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

function isExcludedFile(relative: string): boolean {
  if (EXCLUDED_FILES.has(relative)) return true
  const lower = relative.toLowerCase()
  if (FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('/.env')) return true
  return false
}

async function walk(
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
async function hashTree(input: TreeEntry[]): Promise<string> {
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
function treeSignature(entries: TreeEntry[]): string {
  let bytes = 0
  let newest = 0
  for (const entry of entries) {
    bytes += entry.size
    if (entry.mtimeMs > newest) newest = entry.mtimeMs
  }
  return `${entries.length}:${bytes}:${newest}`
}

interface FingerprintMemo {
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
const FINGERPRINT_TRUST_MS = 30_000

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

async function tree(root: string): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>()
  for (const entry of await walk(root)) result.set(entry.path, entry)
  return result
}

async function hashEntry(entry: TreeEntry): Promise<string> {
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

/**
 * Create a read-only baseline from git HEAD for development runs. Installed
 * builds use the pristine copy under resources/source instead.
 */
export async function prepareGitBase(sourcePath: string, cacheRoot: string): Promise<string> {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourcePath,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (revision.status !== 0 || !revision.stdout.trim()) {
    throw new Error('开发模式下需要 git 才能保存个人版本；安装版会使用安装包内置的官方源码。')
  }
  const target = join(cacheRoot, revision.stdout.trim())
  if (await exists(join(target, 'package.json'))) return target
  const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: sourcePath,
    maxBuffer: 128 * 1024 * 1024,
  })
  if (archive.status !== 0 || !archive.stdout) {
    throw new Error('无法读取当前 git 版本的源码快照。')
  }
  await mkdir(target, { recursive: true })
  // Windows 自带的 bsdtar 在 SystemRoot 下，不能写死 C: 盘（系统盘符可能不是 C）。
  const systemTar =
    process.platform === 'win32' && process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'tar.exe')
      : null
  const tar = systemTar && existsSync(systemTar) ? systemTar : 'tar'
  const extracted = spawnSync(tar, ['-xf', '-', '-C', target], { input: archive.stdout })
  if (extracted.status !== 0) {
    await rm(target, { recursive: true, force: true })
    throw new Error('无法展开官方源码快照，请确认系统自带的 tar 可用。')
  }
  return target
}

async function latestBuild(
  sourcePath: string,
  fingerprint: string,
): Promise<{ buildPath?: string; builtAt?: string }> {
  const root = join(sourcePath, 'release-selfdev')
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Pilot-'))
      .map((entry) => join(root, entry.name))
  } catch {
    return {}
  }
  const withTime = await Promise.all(
    entries.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })),
  )
  withTime.sort((left, right) => right.mtime - left.mtime)
  for (const candidate of withTime) {
    const info = await readJson<{ builtAt?: string; sourceHash?: string }>(
      join(candidate.path, 'build-info.json'),
      {},
    )
    if (info.sourceHash === fingerprint) {
      return {
        buildPath: candidate.path,
        ...(info.builtAt ? { builtAt: info.builtAt } : {}),
      }
    }
  }
  return {}
}

/** Tree listing without the per-file size limits used by saved versions. */
async function rawTree(root: string): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>()
  for (const entry of await walk(root, '', [], false)) result.set(entry.path, entry)
  return result
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< |^>>>>>>> /m.test(text)
}

/**
 * Line-level diff. Returns `null` when the file is too large to merge safely,
 * so callers can report a conflict instead of blocking the event loop.
 */
export function diffHunks(base: string[], side: string[]): MergeHunk[] | null {
  if (base.length > MAX_MERGE_LINES || side.length > MAX_MERGE_LINES) return null
  let prefix = 0
  while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < side.length - prefix &&
    base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const mine = base.slice(prefix, base.length - suffix)
  const theirs = side.slice(prefix, side.length - suffix)
  if (mine.length === 0 && theirs.length === 0) return []
  if (mine.length * theirs.length > MAX_MERGE_CELLS) return null
  const width = theirs.length + 1
  const table = new Uint32Array((mine.length + 1) * width)
  for (let row = 1; row <= mine.length; row += 1) {
    for (let column = 1; column <= theirs.length; column += 1) {
      table[row * width + column] =
        mine[row - 1] === theirs[column - 1]
          ? table[(row - 1) * width + (column - 1)]! + 1
          : Math.max(table[(row - 1) * width + column]!, table[row * width + (column - 1)]!)
    }
  }
  const matches: { base: number; side: number }[] = []
  let row = mine.length
  let column = theirs.length
  while (row > 0 && column > 0) {
    if (mine[row - 1] === theirs[column - 1]) {
      matches.push({ base: row - 1, side: column - 1 })
      row -= 1
      column -= 1
    } else if (table[(row - 1) * width + column]! >= table[row * width + (column - 1)]!) {
      row -= 1
    } else {
      column -= 1
    }
  }
  matches.reverse()
  const hunks: MergeHunk[] = []
  let baseCursor = 0
  let sideCursor = 0
  for (const match of matches) {
    if (match.base > baseCursor || match.side > sideCursor) {
      hunks.push({
        baseStart: prefix + baseCursor,
        baseEnd: prefix + match.base,
        sideStart: prefix + sideCursor,
        sideEnd: prefix + match.side,
      })
    }
    baseCursor = match.base + 1
    sideCursor = match.side + 1
  }
  if (baseCursor < mine.length || sideCursor < theirs.length) {
    hunks.push({
      baseStart: prefix + baseCursor,
      baseEnd: prefix + mine.length,
      sideStart: prefix + sideCursor,
      sideEnd: prefix + theirs.length,
    })
  }
  return hunks
}

function hunksOverlap(left: MergeHunk, right: MergeHunk): boolean {
  const leftInsert = left.baseStart === left.baseEnd
  const rightInsert = right.baseStart === right.baseEnd
  if (leftInsert && rightInsert) return left.baseStart === right.baseStart
  if (leftInsert) return right.baseStart < left.baseStart && left.baseStart < right.baseEnd
  if (rightInsert) return left.baseStart < right.baseStart && right.baseStart < left.baseEnd
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd
}

function clusterHunks(hunks: TaggedHunk[]): TaggedHunk[][] {
  const sorted = [...hunks].sort(
    (left, right) =>
      left.baseStart - right.baseStart ||
      left.baseEnd - right.baseEnd ||
      (left.side === right.side ? 0 : left.side === 'mine' ? -1 : 1),
  )
  const clusters: TaggedHunk[][] = []
  let current: TaggedHunk[] = []
  for (const hunk of sorted) {
    if (current.length === 0) {
      current = [hunk]
      continue
    }
    if (current.some((entry) => hunksOverlap(entry, hunk))) {
      current.push(hunk)
      continue
    }
    clusters.push(current)
    current = [hunk]
  }
  if (current.length > 0) clusters.push(current)
  return clusters
}

function renderClusterSide(
  base: string[],
  hunks: TaggedHunk[],
  start: number,
  end: number,
): string[] {
  const ordered = [...hunks].sort((left, right) => left.baseStart - right.baseStart)
  const output: string[] = []
  let cursor = start
  for (const hunk of ordered) {
    while (cursor < hunk.baseStart) {
      output.push(base[cursor]!)
      cursor += 1
    }
    output.push(...hunk.sideLines)
    cursor = hunk.baseEnd
  }
  while (cursor < end) {
    output.push(base[cursor]!)
    cursor += 1
  }
  return output
}

/**
 * Three-way merge of text files. Non-overlapping edits are combined; overlapping
 * edits produce standard conflict markers that a coding agent can resolve.
 */
export function mergeText(
  ancestor: string,
  mine: string,
  theirs: string,
  officialVersion: string,
): MergeOutcome | null {
  if (hasConflictMarkers(mine) || hasConflictMarkers(theirs) || hasConflictMarkers(ancestor)) {
    return null
  }
  const base = splitLines(ancestor)
  const mineLines = splitLines(mine)
  const theirLines = splitLines(theirs)
  const mineHunks = diffHunks(base, mineLines)
  const theirHunks = diffHunks(base, theirLines)
  if (!mineHunks || !theirHunks) return null
  const tagged: TaggedHunk[] = [
    ...mineHunks.map((hunk) => ({
      ...hunk,
      side: 'mine' as const,
      sideLines: mineLines.slice(hunk.sideStart, hunk.sideEnd),
    })),
    ...theirHunks.map((hunk) => ({
      ...hunk,
      side: 'theirs' as const,
      sideLines: theirLines.slice(hunk.sideStart, hunk.sideEnd),
    })),
  ]
  const clusters = clusterHunks(tagged)
  const output: string[] = []
  let cursor = 0
  let conflicts = 0
  for (const cluster of clusters) {
    const start = Math.min(...cluster.map((hunk) => hunk.baseStart))
    const end = Math.max(...cluster.map((hunk) => hunk.baseEnd))
    while (cursor < start) {
      output.push(base[cursor]!)
      cursor += 1
    }
    const mineCluster = cluster.filter((hunk) => hunk.side === 'mine')
    const theirCluster = cluster.filter((hunk) => hunk.side === 'theirs')
    if (mineCluster.length > 0 && theirCluster.length > 0) {
      const mineRegion = renderClusterSide(base, mineCluster, start, end)
      const theirRegion = renderClusterSide(base, theirCluster, start, end)
      if (
        mineRegion.length === theirRegion.length &&
        mineRegion.every((line, index) => line === theirRegion[index])
      ) {
        output.push(...mineRegion)
      } else {
        conflicts += 1
        output.push(
          '<<<<<<< 我的版本',
          ...mineRegion,
          '=======',
          ...theirRegion,
          `>>>>>>> 官方 v${officialVersion}`,
        )
      }
    } else {
      output.push(...renderClusterSide(base, cluster, start, end))
    }
    cursor = Math.max(cursor, end)
  }
  while (cursor < base.length) {
    output.push(base[cursor]!)
    cursor += 1
  }
  const crlf = [ancestor, mine, theirs].some((text) => text.includes('\r\n'))
  const text = output.join('\n')
  return { text: crlf ? text.replace(/\n/g, '\r\n') : text, conflicts }
}

interface CommandResult {
  code: number
  output: string
}

/** Run a fixed gate command, keeping only the tail of its output. */
function runCommand(cwd: string, command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = ''
    const append = (chunk: Buffer | string): void => {
      output += String(chunk)
      if (output.length > 64_000) output = output.slice(-64_000)
    }
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      env: process.env,
    })
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: CommandResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      child.kill()
      finish({ code: -1, output: `${output}\n命令超时` })
    }, timeoutMs)
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => finish({ code: -1, output: `${output}\n${error.message}` }))
    child.on('close', (code) => finish({ code: code ?? -1, output }))
  })
}

function validateText(value: string, label: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (!cleaned) throw new Error(`${label}不能为空`)
  if (cleaned.length > 2_000) throw new Error(`${label}过长（最多 2000 字）`)
  if (containsSecret(cleaned)) throw new Error(`${label}疑似包含密钥，不能提交`)
  return cleaned
}

export class PersonalEvolutionService {
  constructor(private readonly options: PersonalServiceOptions) {}

  private get dataDir(): string {
    return this.options.dataDir
  }

  private get versionsDir(): string {
    return join(this.dataDir, 'versions')
  }

  private get contributionsDir(): string {
    return join(this.dataDir, 'contributions')
  }

  private get basesDir(): string {
    return join(this.dataDir, 'bases')
  }

  private get upgradesDir(): string {
    return join(this.dataDir, 'upgrades')
  }

  /**
   * Keep an immutable copy of the official tree at fork time. When the installed
   * app is updated, this snapshot is the common ancestor for a three-way merge.
   */
  private async captureBaseSnapshot(): Promise<{ hash: string; tree: string } | null> {
    if (!(await exists(join(this.options.basePath, 'package.json')))) return null
    try {
      const hash = await sourceFingerprint(this.options.basePath)
      const target = join(this.basesDir, hash)
      const tree = join(target, 'tree')
      if (!(await exists(join(tree, 'package.json')))) {
        const staging = join(this.basesDir, `.staging-${randomUUID()}`)
        try {
          for (const entry of await walk(this.options.basePath, '', [], false)) {
            const destination = join(staging, 'tree', ...entry.path.split('/'))
            await mkdir(dirname(destination), { recursive: true })
            await cp(entry.absolute, destination)
          }
          await writeJson(join(staging, 'meta.json'), {
            hash,
            version: this.options.appVersion,
            capturedAt: now(),
          })
          await mkdir(this.basesDir, { recursive: true })
          await rm(target, { recursive: true, force: true })
          await rename(staging, target)
        } catch (caught) {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined)
          throw caught
        }
      }
      await this.pruneBases(hash)
      return { hash, tree }
    } catch {
      // A missing snapshot only degrades future upgrades to manual migration.
      return null
    }
  }

  private async pruneBases(keep: string): Promise<void> {
    try {
      const entries = await readdir(this.basesDir, { withFileTypes: true })
      const snapshots = (
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/i.test(entry.name))
            .map(async (entry) => ({
              name: entry.name,
              meta: await readJson<{ capturedAt?: string }>(
                join(this.basesDir, entry.name, 'meta.json'),
                {},
              ),
            })),
        )
      ).sort((left, right) =>
        (right.meta.capturedAt ?? '').localeCompare(left.meta.capturedAt ?? ''),
      )
      for (const snapshot of snapshots.slice(3)) {
        if (snapshot.name === keep) continue
        await rm(join(this.basesDir, snapshot.name), { recursive: true, force: true })
      }
    } catch {
      // Pruning is housekeeping only.
    }
  }

  private async ensureFork(): Promise<ForkRecord> {
    const path = join(this.dataDir, 'fork.json')
    const existing = await readJson<Partial<ForkRecord>>(path, {})
    if (existing.forkId && existing.createdAt && existing.baseVersion) {
      if (!existing.baseHash && existing.baseVersion === this.options.appVersion) {
        // The version did not move, so the current official tree is still the
        // ancestor this fork was created from; capture it before an update.
        const snapshot = await this.captureBaseSnapshot()
        if (snapshot) {
          const updated: ForkRecord = {
            forkId: existing.forkId,
            name: existing.name || '我的 Pilot 版本',
            createdAt: existing.createdAt,
            baseVersion: existing.baseVersion,
            baseHash: snapshot.hash,
          }
          await writeJson(path, updated)
          return updated
        }
      }
      return {
        forkId: existing.forkId,
        name: existing.name || '我的 Pilot 版本',
        createdAt: existing.createdAt,
        baseVersion: existing.baseVersion,
        ...(existing.baseHash ? { baseHash: existing.baseHash } : {}),
      }
    }
    const snapshot = await this.captureBaseSnapshot()
    const fork: ForkRecord = {
      forkId: randomUUID(),
      name: '我的 Pilot 版本',
      createdAt: now(),
      baseVersion: this.options.appVersion,
      ...(snapshot ? { baseHash: snapshot.hash } : {}),
    }
    await writeJson(path, fork)
    return fork
  }

  private async versionManifest(id: string): Promise<VersionManifest | null> {
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return null
    return readJson<VersionManifest | null>(join(this.versionsDir, id, 'manifest.json'), null)
  }

  private async contributionRecord(id: string): Promise<StoredContribution | null> {
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) return null
    return readJson<StoredContribution | null>(join(this.contributionsDir, id, 'record.json'), null)
  }

  private async currentBaseHash(): Promise<string | null> {
    if (!(await exists(join(this.options.basePath, 'package.json')))) return null
    try {
      return await cachedSourceFingerprint(this.options.basePath, FINGERPRINT_TRUST_MS)
    } catch {
      return null
    }
  }

  private async upgradeStatus(
    fork: ForkRecord,
    currentHash: string | null,
  ): Promise<PersonalUpgradeStatus> {
    const fromVersion = fork.baseVersion
    const toVersion = this.options.appVersion
    if (fromVersion === toVersion && (!fork.baseHash || fork.baseHash === currentHash)) {
      return { available: false, fromVersion, toVersion, requiresManual: false }
    }
    if (!fork.baseHash || !currentHash) {
      return { available: fromVersion !== toVersion, fromVersion, toVersion, requiresManual: true }
    }
    if (fork.baseHash === currentHash) {
      return { available: false, fromVersion, toVersion, requiresManual: false }
    }
    const ancestor = join(this.basesDir, fork.baseHash, 'tree', 'package.json')
    return {
      available: true,
      fromVersion,
      toVersion,
      requiresManual: !(await exists(ancestor)),
    }
  }

  /** 已保存的个人版本，最新在前。 */
  private async savedVersions(): Promise<PersonalVersion[]> {
    const versions: PersonalVersion[] = []
    try {
      const entries = await readdir(this.versionsDir, { withFileTypes: true })
      const manifests = await Promise.all(
        entries.filter((entry) => entry.isDirectory()).map((entry) => this.versionManifest(entry.name)),
      )
      for (const manifest of manifests) if (manifest) versions.push(manifest)
    } catch {
      // No versions yet.
    }
    return versions.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /** 已提交的贡献记录，最新在前。 */
  private async storedContributions(): Promise<PersonalContribution[]> {
    const contributions: PersonalContribution[] = []
    try {
      const entries = await readdir(this.contributionsDir, { withFileTypes: true })
      const records = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => this.contributionRecord(entry.name)),
      )
      for (const record of records) if (record) contributions.push(record)
    } catch {
      // No contributions yet.
    }
    return contributions.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async state(): Promise<PersonalEvolutionState> {
    // 进化页一打开就要这几个，彼此无依赖，串行等于把三倍等待叠在一起。
    const [fork, currentHash, available] = await Promise.all([
      this.ensureFork(),
      this.currentBaseHash(),
      exists(join(this.options.sourcePath, 'package.json')),
    ])
    const [upgrade, versions, contributions, lastUpgrade] = await Promise.all([
      this.upgradeStatus(fork, currentHash),
      this.savedVersions(),
      this.storedContributions(),
      this.latestUpgrade(),
    ])
    if (lastUpgrade && lastUpgrade.validation !== 'passed' && available) {
      // A successful self-build runs the test suite before packaging, so a
      // matching build made after the merge is equivalent to the gate passing.
      try {
        const fingerprint = await cachedSourceFingerprint(this.options.sourcePath)
        const build = await latestBuild(this.options.sourcePath, fingerprint)
        if (
          build.buildPath &&
          build.builtAt &&
          Date.parse(build.builtAt) >= Date.parse(lastUpgrade.createdAt)
        ) {
          lastUpgrade.validation = 'passed'
          lastUpgrade.validatedAt = now()
          lastUpgrade.message = '个人版自构建成功，构建过程已运行测试。'
          delete lastUpgrade.output
          await writeJson(join(this.upgradesDir, lastUpgrade.id, 'backup.json'), lastUpgrade)
        }
      } catch {
        // Leave the merge as pending; the user can run the gate explicitly.
      }
    }
    return {
      forkId: fork.forkId,
      name: fork.name,
      createdAt: fork.createdAt,
      baseVersion: fork.baseVersion,
      sourcePath: this.options.sourcePath,
      basePath: this.options.basePath,
      available,
      baseReadOnly: this.options.baseReadOnly,
      ...(this.options.provenance ? { provenance: this.options.provenance } : {}),
      versions,
      contributions,
      ...(this.options.endpoint ? { uploadEndpoint: this.options.endpoint } : {}),
      upgrade,
      ...(lastUpgrade ? { lastUpgrade: this.upgradeReport(lastUpgrade) } : {}),
    }
  }

  async saveVersion(input: PersonalVersionInput): Promise<PersonalVersion> {
    if (!(await exists(join(this.options.sourcePath, 'package.json')))) {
      throw new Error('请先打开自身源码工作区，再保存个人版本。')
    }
    if (!(await exists(join(this.options.basePath, 'package.json')))) {
      throw new Error('找不到官方源码基线，无法比较改动。')
    }
    const name = validateText(input.name, '版本名称')
    const note = input.note ? validateText(input.note, '版本说明') : ''
    const fork = await this.ensureFork()
    const status = await this.upgradeStatus(fork, await this.currentBaseHash())
    if (status.available) {
      throw new Error(
        `官方已升级到 v${status.toVersion}，请先合并官方更新，再保存个人版本，避免把官方改动误记为你的改动。`,
      )
    }
    const changes = await scanSourceChanges(this.options.sourcePath, this.options.basePath)
    if (changes.length === 0) throw new Error('当前源码与官方基线没有差异，不需要保存新版本。')
    const total = changes.reduce((sum, file) => sum + file.size, 0)
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`改动总大小超过 ${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MiB，请拆分成更小的版本。`)
    }
    const id = randomUUID()
    const versionDir = join(this.versionsDir, id)
    for (const file of changes) {
      const relative = safeRelative(file.path)
      if (file.status !== 'deleted') {
        const target = join(versionDir, 'after', ...relative.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await cp(resolveInside(this.options.sourcePath, file.path), target)
      }
      if (file.status !== 'added') {
        const target = join(versionDir, 'before', ...relative.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await cp(resolveInside(this.options.basePath, file.path), target)
      }
    }
    const fingerprint = await sourceFingerprint(this.options.sourcePath)
    const build = await latestBuild(this.options.sourcePath, fingerprint)
    const manifest: VersionManifest = {
      id,
      forkId: fork.forkId,
      name,
      note,
      baseVersion: this.options.appVersion,
      createdAt: now(),
      files: changes,
      contributionIds: [],
      ...build,
    }
    await writeJson(join(versionDir, 'manifest.json'), manifest)
    await this.pruneVersions()
    return manifest
  }

  private async pruneVersions(): Promise<void> {
    const entries = (await readdir(this.versionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const manifests = (
      await Promise.all(
        entries.map(async (id) => ({ id, manifest: await this.versionManifest(id) })),
      )
    )
      .filter((entry): entry is { id: string; manifest: VersionManifest } => Boolean(entry.manifest))
      .sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt))
    for (const entry of manifests.slice(MAX_VERSIONS)) {
      await rm(join(this.versionsDir, entry.id), { recursive: true, force: true })
    }
  }

  async restoreVersion(versionId: string): Promise<void> {
    if (!(await exists(join(this.options.sourcePath, 'package.json')))) {
      throw new Error('请先打开自身源码工作区。')
    }
    const manifest = await this.versionManifest(versionId)
    if (!manifest) throw new Error('找不到这个个人版本。')
    for (const file of manifest.files) {
      const target = await safeWriteTarget(this.options.sourcePath, file.path)
      if (file.status === 'deleted') {
        await rm(target, { force: true })
        continue
      }
      const snapshot = resolveInside(join(this.versionsDir, versionId, 'after'), file.path)
      const content = await readFile(snapshot)
      if (sha256(content) !== file.afterSha256) {
        throw new Error(`版本快照已损坏：${file.path}`)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    forgetSourceFingerprint(this.options.sourcePath)
  }

  /**
   * Three-way plan: ancestor = the official tree captured at fork time,
   * mine = the user's source workspace, theirs = the newly installed official
   * tree. Upstream-only changes are taken, personal-only changes are kept, and
   * overlapping edits become conflicts.
   */
  private async planUpgrade(): Promise<InternalUpgradePlan> {
    const fork = await this.ensureFork()
    const currentHash = await this.currentBaseHash()
    const fromVersion = fork.baseVersion
    const toVersion = this.options.appVersion
    const counts = { upstream: 0, kept: 0, merged: 0, conflicts: 0 }
    const manual = (requiresManual: boolean): InternalUpgradePlan => ({
      available: true,
      fromVersion,
      toVersion,
      requiresManual,
      currentHash: currentHash ?? '',
      counts,
      conflicts: [],
      actions: [],
    })
    if (!(await exists(join(this.options.sourcePath, 'package.json')))) {
      throw new Error('请先打开自身源码工作区，再合并官方更新。')
    }
    const status = await this.upgradeStatus(fork, currentHash)
    if (!status.available) {
      return {
        available: false,
        fromVersion,
        toVersion,
        requiresManual: false,
        currentHash: currentHash ?? '',
        counts,
        conflicts: [],
        actions: [],
      }
    }
    if (!fork.baseHash || !currentHash) return manual(true)
    const ancestorRoot = join(this.basesDir, fork.baseHash, 'tree')
    if (!(await exists(join(ancestorRoot, 'package.json')))) return manual(true)

    const [ancestor, mine, official] = await Promise.all([
      rawTree(ancestorRoot),
      rawTree(this.options.sourcePath),
      rawTree(this.options.basePath),
    ])
    const paths = [...new Set([...ancestor.keys(), ...mine.keys(), ...official.keys()])].sort()
    const actions: UpgradeAction[] = []
    const conflicts: PersonalUpgradeConflict[] = []
    for (const path of paths) {
      const ancestorEntry = ancestor.get(path)
      const mineEntry = mine.get(path)
      const officialEntry = official.get(path)
      const [before, after, next] = await Promise.all([
        ancestorEntry ? hashEntry(ancestorEntry) : Promise.resolve(null),
        mineEntry ? hashEntry(mineEntry) : Promise.resolve(null),
        officialEntry ? hashEntry(officialEntry) : Promise.resolve(null),
      ])
      const userChanged = after !== before
      const officialChanged = next !== before
      if (!officialChanged) {
        if (userChanged) counts.kept += 1
        continue
      }
      if (!userChanged) {
        counts.upstream += 1
        actions.push({
          path,
          kind: 'upstream',
          ...(officialEntry ? { content: await readFile(officialEntry.absolute) } : {}),
        })
        continue
      }
      if ((after === null && next === null) || (after !== null && next !== null && after === next)) {
        // Both sides reached the same content; nothing to write.
        counts.merged += 1
        continue
      }
      const conflict = (reason: PersonalUpgradeConflictReason): void => {
        counts.conflicts += 1
        conflicts.push({ path, reason })
        actions.push({ path, kind: 'conflict', reason })
      }
      if (after === null) {
        conflict('deleted-by-you')
        continue
      }
      if (next === null) {
        conflict('deleted-officially')
        continue
      }
      if (before === null) {
        conflict('both-added')
        continue
      }
      const ancestorBuffer = await readFile(ancestorEntry!.absolute)
      const mineBuffer = await readFile(mineEntry!.absolute)
      const officialBuffer = await readFile(officialEntry!.absolute)
      if (!isUtf8(ancestorBuffer) || !isUtf8(mineBuffer) || !isUtf8(officialBuffer)) {
        conflict('binary')
        continue
      }
      const outcome = mergeText(
        ancestorBuffer.toString('utf8'),
        mineBuffer.toString('utf8'),
        officialBuffer.toString('utf8'),
        toVersion,
      )
      if (!outcome) {
        const bothText = mineBuffer.toString('utf8')
        conflict(
          hasConflictMarkers(bothText) || hasConflictMarkers(officialBuffer.toString('utf8'))
            ? 'already-conflicted'
            : 'too-large',
        )
        continue
      }
      if (outcome.conflicts === 0) {
        counts.merged += 1
        actions.push({ path, kind: 'merged', content: outcome.text })
      } else {
        counts.conflicts += 1
        conflicts.push({ path, reason: 'both-modified' })
        actions.push({ path, kind: 'conflict', reason: 'both-modified', markerText: outcome.text })
      }
    }
    return {
      available: true,
      fromVersion,
      toVersion,
      requiresManual: false,
      currentHash,
      counts,
      conflicts,
      actions,
    }
  }

  async prepareUpgrade(): Promise<PersonalUpgradePlan> {
    const plan = await this.planUpgrade()
    const base: PersonalUpgradePlan = {
      available: plan.available,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      requiresManual: plan.requiresManual,
      counts: plan.counts,
      conflicts: plan.conflicts,
    }
    if (!plan.available || !plan.requiresManual) return base
    const officialCopyPath = await this.copyOfficialForManual()
    return officialCopyPath ? { ...base, officialCopyPath } : base
  }

  /** Copy the new official tree into the workspace so Pilot can migrate by reading it. */
  private async copyOfficialForManual(): Promise<string | undefined> {
    try {
      const root = join(this.options.sourcePath, '.pilot-upgrade')
      const staging = join(root, `.staging-${randomUUID()}`)
      for (const entry of await walk(this.options.basePath, '', [], false)) {
        const destination = join(staging, ...entry.path.split('/'))
        await mkdir(dirname(destination), { recursive: true })
        await cp(entry.absolute, destination)
      }
      await mkdir(root, { recursive: true })
      await rm(join(root, 'official'), { recursive: true, force: true })
      await rename(staging, join(root, 'official'))
      return '.pilot-upgrade/official'
    } catch {
      return undefined
    }
  }

  async applyUpgrade(): Promise<PersonalUpgradeResult> {
    if (!(await exists(join(this.options.sourcePath, 'package.json')))) {
      throw new Error('请先打开自身源码工作区，再合并官方更新。')
    }
    const plan = await this.planUpgrade()
    if (!plan.available) throw new Error('当前已经是最新官方基线，不需要合并。')
    if (plan.requiresManual) {
      throw new Error('找不到升级前的官方基线，无法自动三方合并。请让 Pilot 对照新版官方源码手动迁移。')
    }
    const fork = await this.ensureFork()
    const id = randomUUID()
    const backupDir = join(this.upgradesDir, id)
    const record: UpgradeRecord = {
      id,
      createdAt: now(),
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      fromHash: fork.baseHash ?? '',
      toHash: plan.currentHash,
      files: [],
      applied: 0,
      kept: plan.counts.kept,
      merged: 0,
      conflicts: plan.conflicts,
      validation: 'pending',
    }
    for (const action of plan.actions) {
      const target = await safeWriteTarget(this.options.sourcePath, action.path)
      if (await exists(target)) {
        const content = await readFile(target)
        const destination = join(backupDir, 'before', ...safeRelative(action.path).split('/'))
        await mkdir(dirname(destination), { recursive: true })
        await cp(target, destination)
        record.files.push({ path: action.path, beforeSha256: sha256(content) })
      } else {
        record.files.push({ path: action.path, beforeSha256: null })
      }
    }
    await writeJson(join(backupDir, 'backup.json'), record)

    let applied = 0
    for (const action of plan.actions) {
      const target = await safeWriteTarget(this.options.sourcePath, action.path)
      if (action.kind === 'upstream') {
        if (action.content === undefined) {
          await rm(target, { force: true })
          continue
        }
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, action.content)
        applied += 1
        continue
      }
      if (action.kind === 'merged' && typeof action.content === 'string') {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, action.content)
        applied += 1
        continue
      }
      if (action.markerText) {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, action.markerText)
        applied += 1
      }
    }

    // A manual-migration reference copy becomes stale after a successful merge.
    await rm(join(this.options.sourcePath, '.pilot-upgrade'), {
      recursive: true,
      force: true,
    }).catch(() => undefined)

    const snapshot = await this.captureBaseSnapshot()
    // 合并改过自己的源码，基线快照也重建了，两份指纹都要重算。
    forgetSourceFingerprint(this.options.sourcePath)
    forgetSourceFingerprint(this.options.basePath)
    const updated: ForkRecord = {
      ...fork,
      baseVersion: this.options.appVersion,
      ...(snapshot ? { baseHash: snapshot.hash } : {}),
    }
    if (!snapshot) delete updated.baseHash
    await writeJson(join(this.dataDir, 'fork.json'), updated)

    record.applied = applied
    record.merged = plan.counts.merged
    record.validation = 'pending'
    await writeJson(join(backupDir, 'backup.json'), record)

    const result: PersonalUpgradeResult = {
      id,
      fromVersion: plan.fromVersion,
      toVersion: plan.toVersion,
      applied,
      kept: plan.counts.kept,
      merged: plan.counts.merged,
      conflicts: plan.conflicts,
      backupPath: backupDir,
    }
    await writeJson(join(backupDir, 'result.json'), result)
    return result
  }

  private async latestUpgrade(): Promise<UpgradeRecord | null> {
    try {
      const entries = (await readdir(this.upgradesDir, { withFileTypes: true })).filter((entry) =>
        entry.isDirectory(),
      )
      const records = (
        await Promise.all(
          entries.map((entry) =>
            readJson<UpgradeRecord | null>(join(this.upgradesDir, entry.name, 'backup.json'), null),
          ),
        )
      )
        .filter((record): record is UpgradeRecord => Boolean(record && !record.rolledBackAt))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      return records[0] ?? null
    } catch {
      return null
    }
  }

  private upgradeReport(record: UpgradeRecord): PersonalUpgradeReport {
    return {
      id: record.id,
      fromVersion: record.fromVersion,
      toVersion: record.toVersion,
      applied: record.applied,
      kept: record.kept,
      merged: record.merged,
      conflicts: record.conflicts,
      backupPath: join(this.upgradesDir, record.id),
      createdAt: record.createdAt,
      validation: record.validation ?? 'pending',
      ...(record.validatedAt ? { validatedAt: record.validatedAt } : {}),
      ...(record.message ? { message: record.message } : {}),
      ...(record.output ? { output: record.output } : {}),
    }
  }

  /**
   * A textual merge cannot see cross-file semantics: the official version may
   * rename a method while the user's file still calls the old one. The gate is
   * typecheck plus the project test suite; it is not proof, but it catches the
   * common signature and behavior regressions before a build or submission.
   */
  async validateUpgrade(): Promise<PersonalUpgradeReport> {
    const record = await this.latestUpgrade()
    if (!record) throw new Error('没有需要验证的升级合并。')
    const fail = async (
      validation: PersonalUpgradeValidation,
      message: string,
      output?: string,
    ): Promise<PersonalUpgradeReport> => {
      record.validation = validation
      record.validatedAt = now()
      record.message = message
      if (output) record.output = output.slice(-6_000)
      else delete record.output
      await writeJson(join(this.upgradesDir, record.id, 'backup.json'), record)
      return this.upgradeReport(record)
    }
    if (!(await exists(join(this.options.sourcePath, 'package.json')))) {
      return fail('skipped', '请先打开自身源码工作区，再检查合并结果。')
    }
    if (!(await exists(join(this.options.sourcePath, 'node_modules')))) {
      return fail(
        'skipped',
        '还没有安装依赖，无法自动检查；让 Pilot 构建个人版时会安装依赖并运行测试。',
      )
    }
    const typecheck = await runCommand(this.options.sourcePath, 'pnpm', ['typecheck'], 10 * 60_000)
    if (typecheck.code !== 0) {
      return fail(
        'failed',
        'typecheck 未通过：官方更新和你的改动可能存在跨文件调用不一致。',
        typecheck.output,
      )
    }
    const tests = await runCommand(this.options.sourcePath, 'pnpm', ['test'], 20 * 60_000)
    if (tests.code !== 0) {
      return fail('failed', '测试未通过：合并后的行为可能已经改变。', tests.output)
    }
    record.validation = 'passed'
    record.validatedAt = now()
    delete record.message
    delete record.output
    await writeJson(join(this.upgradesDir, record.id, 'backup.json'), record)
    return this.upgradeReport(record)
  }

  /** Restore every file the last merge touched and point the fork at its old baseline. */
  async rollbackUpgrade(): Promise<void> {
    const record = await this.latestUpgrade()
    if (!record) throw new Error('没有可以撤销的升级合并。')
    const backupDir = join(this.upgradesDir, record.id)
    for (const file of record.files) {
      const target = await safeWriteTarget(this.options.sourcePath, file.path)
      if (file.beforeSha256 === null) {
        await rm(target, { force: true })
        continue
      }
      const snapshot = resolveInside(join(backupDir, 'before'), file.path)
      const content = await readFile(snapshot)
      if (sha256(content) !== file.beforeSha256) {
        throw new Error(`升级备份已损坏：${file.path}`)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    const fork = await this.ensureFork()
    const restored: ForkRecord = {
      ...fork,
      baseVersion: record.fromVersion,
      ...(record.fromHash ? { baseHash: record.fromHash } : {}),
    }
    if (!record.fromHash) delete restored.baseHash
    await writeJson(join(this.dataDir, 'fork.json'), restored)
    forgetSourceFingerprint(this.options.sourcePath)
    record.rolledBackAt = now()
    await writeJson(join(backupDir, 'backup.json'), record)
  }

  private async buildBundle(
    manifest: VersionManifest,
    note: string,
    evidence?: ContributionEvidence,
  ): Promise<ContributionBundle> {
    const files: ContributionFile[] = []
    for (const file of manifest.files) {
      const entry: ContributionFile = { ...file }
      if (file.status !== 'deleted') {
        const snapshot = resolveInside(join(this.versionsDir, manifest.id, 'after'), file.path)
        const content = await readFile(snapshot)
        if (sha256(content) !== file.afterSha256) {
          throw new Error(`版本快照已损坏：${file.path}`)
        }
        if (file.text && containsSecret(content.toString('utf8'), file.path)) {
          throw new Error(`改动文件疑似包含密钥，已停止提交：${file.path}`)
        }
        entry.contentBase64 = content.toString('base64')
      }
      files.push(entry)
    }
    const payload: ContributionPayload = {
      format: FORMAT,
      id: randomUUID(),
      createdAt: now(),
      note,
      fork: {
        id: manifest.forkId,
        name: '我的 Pilot 版本',
        baseVersion: manifest.baseVersion,
      },
      version: {
        id: manifest.id,
        name: manifest.name,
        note: manifest.note,
        baseVersion: manifest.baseVersion,
      },
      appVersion: this.options.appVersion,
      files,
      ...(evidence ? { evidence } : {}),
    }
    return { ...payload, checksum: contributionChecksum(payload) }
  }

  async submitVersion(
    versionId: string,
    note: string,
    evidence?: ContributionEvidence,
  ): Promise<PersonalContribution> {
    const manifest = await this.versionManifest(versionId)
    if (!manifest) throw new Error('找不到这个个人版本。')
    const cleaned = validateText(note, '提交说明')
    if (evidence) {
      const text = JSON.stringify(evidence)
      if (containsSecret(text)) throw new Error('进化证据疑似包含密钥，不能提交。')
    }
    const bundle = await this.buildBundle(manifest, cleaned, evidence)
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`
    const bytes = Buffer.byteLength(serialized)
    if (bytes > MAX_TOTAL_BYTES) {
      throw new Error('贡献包过大，请拆分成更小的版本。')
    }
    const bundlePath = join(this.contributionsDir, bundle.id, 'version.pilot.json')
    await writeJson(bundlePath, bundle)

    let status: PersonalContribution['status'] = 'ready'
    let error: string | undefined
    if (this.options.endpoint) {
      try {
        await this.upload(this.options.endpoint, serialized)
        status = 'uploaded'
      } catch (caught) {
        status = 'failed'
        error = caught instanceof Error ? caught.message : String(caught)
      }
    }
    const record: PersonalContribution = {
      id: bundle.id,
      versionId,
      forkId: manifest.forkId,
      note: cleaned,
      createdAt: bundle.createdAt,
      status,
      path: bundlePath,
      bytes,
      sha256: sha256(serialized),
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
      ...(error ? { error } : {}),
    }
    await writeJson(join(this.contributionsDir, bundle.id, 'record.json'), record)

    const updated: VersionManifest = {
      ...manifest,
      contributionIds: [...manifest.contributionIds, record.id].slice(-MAX_CONTRIBUTIONS),
    }
    await writeJson(join(this.versionsDir, versionId, 'manifest.json'), updated)
    await this.pruneContributions()
    return record
  }

  private async upload(endpoint: string, body: string): Promise<void> {
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new Error('贡献上传地址无效')
    }
    const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error('贡献只允许上传到 HTTPS 地址（本机测试地址除外）')
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `Pilot/${this.options.appVersion}` },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`官方接收端返回 ${response.status}`)
  }

  private async pruneContributions(): Promise<void> {
    const entries = (await readdir(this.contributionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const records = (
      await Promise.all(
        entries.map(async (id) => ({ id, record: await this.contributionRecord(id) })),
      )
    )
      .filter(
        (entry): entry is { id: string; record: StoredContribution } => Boolean(entry.record),
      )
      .sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt))
    for (const entry of records.slice(MAX_CONTRIBUTIONS)) {
      await rm(join(this.contributionsDir, entry.id), { recursive: true, force: true })
    }
  }

  async contributionPath(id: string): Promise<string> {
    const record = await this.contributionRecord(id)
    if (!record) throw new Error('找不到这个贡献包。')
    return record.path
  }
}
