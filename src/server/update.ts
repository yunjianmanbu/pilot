/**
 * Incremental updates for `pilot serve` (CLI + browser console).
 *
 * The desktop build ships one NSIS installer and keeps its download small with a
 * blockmap delta over that single file. A server deployment is a plain directory
 * instead, so the same idea is expressed per file:
 *
 * - the release manifest lists every shipped file with its size and SHA-256;
 * - the updater hashes the local tree and downloads only the files whose hash
 *   changed, so a release that touches one bundle costs one bundle;
 * - files that disappeared from the manifest are removed, anything else is left
 *   alone (logs, local notes, unrelated files survive);
 * - the swap is two-phase: stage + verify, then move into place with a backup
 *   that is restored if any step fails.
 *
 * The trust model matches the desktop updater: the manifest must be HTTPS on a
 * trusted host, every file is verified against its own SHA-256 before it is
 * moved, and a manifest path may never escape the install tree.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertReleaseUrl, isNewerVersion, normalizeVersion } from '../main/update/manifest'
import type { UpdateRelease, UpdateState } from '../shared/types'

/** Server releases live next to the desktop manifest, on the same host. */
export const DEFAULT_SERVER_MANIFEST_URL = 'https://download.medpilot.cc/pilot/server.json'
export const TRUSTED_SERVER_HOSTS: ReadonlySet<string> = new Set(['download.medpilot.cc'])
/** Written into the install root so the next update knows what is installed. */
export const SERVER_INDEX_FILE = 'pilot-server.json'
/** Staging and backups live here, inside the install root but never indexed. */
export const UPDATE_WORK_DIR = '.pilot-update'

const MANIFEST_LIMIT_BYTES = 1024 * 1024
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_PATH_LENGTH = 240
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,40})?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export interface ServerReleaseFile {
  /** POSIX path relative to the install root. */
  path: string
  size: number
  sha256: string
}

export interface ServerRelease {
  version: string
  channel: string
  date: string
  notes: string
  /** Directory URL that file paths are appended to; always ends with `/`. */
  base: string
  files: ServerReleaseFile[]
  totalBytes: number
}

export interface LocalServerFile {
  size: number
  sha256: string
}

export interface ServerUpdatePlan {
  download: ServerReleaseFile[]
  unchanged: string[]
  removed: string[]
  downloadBytes: number
  unchangedBytes: number
  totalBytes: number
}

/** Minimal response shape so callers (and tests) can inject their own fetch. */
export interface UpdateResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export type UpdateFetch = (url: string) => Promise<UpdateResponse>

export const defaultUpdateFetch: UpdateFetch = async (url) => {
  const nativeFetch = (
    globalThis as {
      fetch?: (input: string, init?: { redirect?: 'follow' }) => Promise<unknown>
    }
  ).fetch
  if (!nativeFetch) throw new Error('当前 Node 运行时缺少 fetch（需要 Node 22 及以上）。')
  return (await nativeFetch(url, { redirect: 'follow' })) as UpdateResponse
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}格式不正确：应为 JSON 对象。`)
  }
  return value as Record<string, unknown>
}

function readString(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`更新清单缺少「${label}」。`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`更新清单的「${label}」应为字符串。`)
  const text = value.trim()
  if (required && !text) throw new Error(`更新清单的「${label}」为空。`)
  if (text.length > max) throw new Error(`更新清单的「${label}」过长。`)
  return text
}

/**
 * Rejects absolute paths, Windows drive letters, backslashes, empty segments
 * and `..`, so a manifest can never write outside the install root.
 */
export function normalizeReleasePath(raw: string): string {
  const text = raw.trim().replace(/\\/g, '/')
  if (!text) throw new Error('更新清单包含空文件路径。')
  if (text.length > MAX_PATH_LENGTH) {
    throw new Error(`更新清单的文件路径过长：${text.slice(0, 40)}…`)
  }
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) {
    throw new Error(`更新清单的文件路径不能是绝对路径：${text}`)
  }
  const segments = text.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`更新清单的文件路径不合法：${text}`)
  }
  return segments.join('/')
}

/** Parse and validate a server release manifest. Every field is untrusted. */
export function parseServerRelease(
  raw: unknown,
  allowedHosts: ReadonlySet<string> = TRUSTED_SERVER_HOSTS,
): ServerRelease {
  const record = asRecord(raw, '更新清单')
  const version = normalizeVersion(readString(record['version'], '版本号', 40, true))
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`更新清单的版本号不合法：${version}`)
  }
  const baseUrl = assertReleaseUrl(readString(record['base'], '下载地址', 300, true), allowedHosts)
  baseUrl.search = ''
  baseUrl.hash = ''
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname = `${baseUrl.pathname}/`

  const filesRaw = record['files']
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
    throw new Error('更新清单没有列出任何文件。')
  }
  if (filesRaw.length > MAX_FILES) {
    throw new Error(`更新清单列出的文件过多：${filesRaw.length} 个。`)
  }

  const seen = new Set<string>()
  const files: ServerReleaseFile[] = []
  let totalBytes = 0
  for (const entry of filesRaw) {
    const fileRecord = asRecord(entry, '更新清单的文件项')
    const path = normalizeReleasePath(
      readString(fileRecord['path'], '文件路径', MAX_PATH_LENGTH, true),
    )
    if (seen.has(path)) throw new Error(`更新清单重复列出文件：${path}`)
    seen.add(path)
    const size = fileRecord['size']
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new Error(`更新清单的文件大小不合法：${path}`)
    }
    if (size > MAX_FILE_BYTES) throw new Error(`更新清单的文件过大：${path}`)
    const sha256 = readString(fileRecord['sha256'], `校验值（${path}）`, 64, true).toLowerCase()
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`更新清单的 SHA-256 不合法：${path}`)
    totalBytes += size
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('更新清单的总大小超出上限，已停止。')
    files.push({ path, size, sha256 })
  }

  return {
    version,
    channel: readString(record['channel'], '通道', 20, false) || 'stable',
    date: readString(record['date'], '发布日期', 40, false),
    notes: readString(record['notes'], '更新说明', 2000, false),
    base: baseUrl.toString(),
    files,
    totalBytes,
  }
}

/** Which files actually need to move for this release. */
export function planServerUpdate(
  release: ServerRelease,
  local: ReadonlyMap<string, LocalServerFile>,
): ServerUpdatePlan {
  const download: ServerReleaseFile[] = []
  const unchanged: string[] = []
  let downloadBytes = 0
  let unchangedBytes = 0
  for (const file of release.files) {
    const current = local.get(file.path)
    if (current && current.size === file.size && current.sha256 === file.sha256) {
      unchanged.push(file.path)
      unchangedBytes += file.size
    } else {
      download.push(file)
      downloadBytes += file.size
    }
  }
  const shipped = new Set(release.files.map((file) => file.path))
  const removed = [...local.keys()].filter((path) => !shipped.has(path)).sort()
  return {
    download,
    unchanged,
    removed,
    downloadBytes,
    unchangedBytes,
    totalBytes: release.totalBytes,
  }
}

export function sha256Of(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export async function hashFile(path: string): Promise<string> {
  return sha256Of(await readFile(path))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The index written by a previous update, if this install has one. */
export async function readServerIndex(root: string): Promise<Map<string, LocalServerFile>> {
  const index = new Map<string, LocalServerFile>()
  let raw: string
  try {
    raw = await readFile(join(root, SERVER_INDEX_FILE), 'utf8')
  } catch {
    return index
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return index
  }
  const files = (parsed as { files?: unknown }).files
  if (!Array.isArray(files)) return index
  for (const entry of files) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const path = record['path']
    const size = record['size']
    const sha256 = typeof record['sha256'] === 'string' ? record['sha256'].toLowerCase() : ''
    if (typeof path !== 'string' || typeof size !== 'number' || !SHA256_PATTERN.test(sha256)) {
      continue
    }
    try {
      index.set(normalizeReleasePath(path), { size, sha256 })
    } catch {
      // A corrupt index entry must not block the whole update.
    }
  }
  return index
}

/**
 * Hash the files this release ships that exist locally with the expected size.
 * A missing file, or one whose size already differs, is left out of the result
 * so the planner downloads it.
 */
export async function scanLocalServerState(
  root: string,
  candidates: readonly ServerReleaseFile[],
): Promise<Map<string, LocalServerFile>> {
  const state = new Map<string, LocalServerFile>()
  const shipped = new Set(candidates.map((file) => file.path))
  for (const file of candidates) {
    const target = join(root, ...file.path.split('/'))
    try {
      const info = await stat(target)
      if (!info.isFile() || info.size !== file.size) continue
      state.set(file.path, { size: info.size, sha256: await hashFile(target) })
    } catch {
      // Missing file: the planner will download it.
    }
  }
  // Files the previous index knew about but this release dropped are reported as
  // removed even though they are no longer part of the manifest.
  for (const [path, entry] of await readServerIndex(root)) {
    if (!shipped.has(path) && (await pathExists(join(root, ...path.split('/'))))) {
      state.set(path, entry)
    }
  }
  return state
}

export interface StagedServerUpdate {
  root: string
  workDir: string
  version: string
  release: ServerRelease
  plan: ServerUpdatePlan
  stagingDir: string
}

export interface StageOptions {
  root: string
  release: ServerRelease
  plan: ServerUpdatePlan
  fetch?: UpdateFetch
  allowedHosts?: ReadonlySet<string>
  onProgress?: (progress: { transferred: number; total: number; progress: number }) => void
}

function resolveFileUrl(
  release: ServerRelease,
  path: string,
  allowedHosts: ReadonlySet<string>,
): string {
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  const url = new URL(encoded, release.base).toString()
  assertReleaseUrl(url, allowedHosts)
  return url
}

/** Download and verify every changed file into a staging directory. */
export async function stageServerUpdate(options: StageOptions): Promise<StagedServerUpdate> {
  const fetchImpl = options.fetch ?? defaultUpdateFetch
  const allowedHosts = options.allowedHosts ?? TRUSTED_SERVER_HOSTS
  const workDir = join(options.root, UPDATE_WORK_DIR)
  const stagingDir = join(workDir, `staging-${options.release.version}`)
  await rm(stagingDir, { recursive: true, force: true })
  await mkdir(stagingDir, { recursive: true })

  const total = options.plan.downloadBytes
  let transferred = 0
  options.onProgress?.({ transferred, total, progress: total === 0 ? 1 : 0 })

  for (const file of options.plan.download) {
    const url = resolveFileUrl(options.release, file.path, allowedHosts)
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`下载 ${file.path} 失败：HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== file.size) {
      throw new Error(
        `下载 ${file.path} 的大小不符：期望 ${file.size} 字节，实际 ${bytes.length} 字节。`,
      )
    }
    const digest = sha256Of(bytes)
    if (digest !== file.sha256) {
      throw new Error(`下载 ${file.path} 的校验失败（SHA-256 不符），已丢弃。`)
    }
    const target = join(stagingDir, ...file.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    transferred += bytes.length
    options.onProgress?.({
      transferred,
      total,
      progress: total === 0 ? 1 : Math.min(1, transferred / total),
    })
  }

  return {
    root: options.root,
    workDir,
    version: options.release.version,
    release: options.release,
    plan: options.plan,
    stagingDir,
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

export interface ApplyResult {
  version: string
  applied: number
  removed: number
  backupDir: string
}

/**
 * Move the staged files into the install tree. Every overwritten path is moved
 * into a backup directory first; any failure restores the tree exactly as it
 * was, so a broken download can never leave a half-updated install.
 */
export async function applyStagedUpdate(staged: StagedServerUpdate): Promise<ApplyResult> {
  const backupDir = join(staged.workDir, `backup-${staged.version}-${Date.now()}`)
  const restores: { target: string; backup: string | null }[] = []

  const swap = async (from: string, target: string, backupPath: string): Promise<void> => {
    if (await pathExists(target)) {
      await mkdir(dirname(backupPath), { recursive: true })
      await moveFile(target, backupPath)
      restores.push({ target, backup: backupPath })
    } else {
      restores.push({ target, backup: null })
    }
    await mkdir(dirname(target), { recursive: true })
    await moveFile(from, target)
  }

  try {
    for (const file of staged.plan.download) {
      const segments = file.path.split('/')
      await swap(
        join(staged.stagingDir, ...segments),
        join(staged.root, ...segments),
        join(backupDir, ...segments),
      )
    }
    for (const path of staged.plan.removed) {
      const segments = path.split('/')
      const target = join(staged.root, ...segments)
      if (!(await pathExists(target))) continue
      const backupPath = join(backupDir, ...segments)
      await mkdir(dirname(backupPath), { recursive: true })
      await moveFile(target, backupPath)
      restores.push({ target, backup: backupPath })
    }

    // The index describes the tree after the swap, so it is written last.
    const indexTarget = join(staged.root, SERVER_INDEX_FILE)
    const indexBackup = join(backupDir, SERVER_INDEX_FILE)
    if (await pathExists(indexTarget)) {
      await mkdir(dirname(indexBackup), { recursive: true })
      await moveFile(indexTarget, indexBackup)
      restores.push({ target: indexTarget, backup: indexBackup })
    } else {
      restores.push({ target: indexTarget, backup: null })
    }
    await writeFile(
      indexTarget,
      `${JSON.stringify(
        {
          version: staged.release.version,
          channel: staged.release.channel,
          installedAt: new Date().toISOString(),
          files: staged.release.files,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  } catch (error) {
    for (const restore of [...restores].reverse()) {
      try {
        await rm(restore.target, { force: true })
        if (restore.backup) {
          await mkdir(dirname(restore.target), { recursive: true })
          await moveFile(restore.backup, restore.target)
        }
      } catch {
        // Best effort: keep trying the remaining files.
      }
    }
    throw error
  }

  await rm(staged.stagingDir, { recursive: true, force: true })
  return {
    version: staged.version,
    applied: staged.plan.download.length,
    removed: staged.plan.removed.length,
    backupDir,
  }
}

export interface ServerUpdaterOptions {
  /** Install root that the manifest paths are relative to. */
  root: string
  currentVersion: string
  manifestUrl?: string
  fetch?: UpdateFetch
  /** Extra trusted hosts, for a self-hosted mirror. */
  extraHosts?: readonly string[]
  /** Called on every state change so the console can push it to browsers. */
  onChange?: (state: UpdateState) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Update service for the headless server. It exposes the same three methods the
 * companion server calls for the desktop build (`check`, `download`, `install`),
 * so the browser console's update panel works unchanged.
 */
export class ServerUpdater {
  private readonly root: string
  private readonly currentVersion: string
  private readonly manifestUrl: string
  private readonly fetchImpl: UpdateFetch
  private readonly allowedHosts: ReadonlySet<string>
  private readonly onChange: ((state: UpdateState) => void) | undefined
  private staged: StagedServerUpdate | null = null
  /** Manifest parsed by the last `check`, reused by `download`. */
  private release: ServerRelease | null = null
  private readonly listeners = new Set<(state: UpdateState) => void>()
  private state: UpdateState

  constructor(options: ServerUpdaterOptions) {
    this.root = options.root
    this.currentVersion = options.currentVersion
    this.manifestUrl = options.manifestUrl ?? DEFAULT_SERVER_MANIFEST_URL
    this.fetchImpl = options.fetch ?? defaultUpdateFetch
    this.allowedHosts = new Set([...TRUSTED_SERVER_HOSTS, ...(options.extraHosts ?? [])])
    this.onChange = options.onChange
    this.state = {
      status: 'idle',
      currentVersion: this.currentVersion,
      release: null,
      progress: 0,
      transferred: 0,
      total: 0,
      message: '尚未检查更新。',
      checkedAt: null,
      canInstall: false,
      elevationRequired: false,
      relocatingToUserDir: false,
    }
  }

  stateSnapshot(): UpdateState {
    return { ...this.state }
  }

  /** Extra listeners (the CLI console) get the same progress the browsers see. */
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.stateSnapshot()
    this.onChange?.(snapshot)
    for (const listener of this.listeners) listener(snapshot)
  }

  /** Fetch the manifest and decide whether this install is behind. */
  async check(): Promise<UpdateState> {
    this.set({ status: 'checking', progress: 0, transferred: 0, total: 0, message: '正在检查更新…' })
    try {
      const response = await this.fetchImpl(this.manifestUrl)
      if (!response.ok) throw new Error(`更新清单下载失败：HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > MANIFEST_LIMIT_BYTES) throw new Error('更新清单过大，已拒绝。')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('更新清单不是合法的 JSON。')
      }
      const release = parseServerRelease(parsed, this.allowedHosts)
      const checkedAt = new Date().toISOString()
      if (!isNewerVersion(release.version, this.currentVersion)) {
        this.staged = null
        this.release = null
        this.set({
          status: 'up-to-date',
          release: null,
          checkedAt,
          canInstall: false,
          message: `已是最新版本 ${this.currentVersion}。`,
        })
        return this.stateSnapshot()
      }
      const descriptor: UpdateRelease = {
        version: release.version,
        channel: release.channel,
        platform: `服务器 · ${process.platform}/${process.arch}`,
        date: release.date,
        url: release.base,
        size: release.totalBytes,
        sha256: '',
        notes: release.notes,
      }
      this.release = release
      this.set({
        status: 'available',
        release: descriptor,
        checkedAt,
        canInstall: false,
        message: `发现新版本 ${release.version}，共 ${release.files.length} 个文件（${formatBytes(
          release.totalBytes,
        )}）。`,
      })
      return this.stateSnapshot()
    } catch (error) {
      this.set({ status: 'error', release: null, canInstall: false, message: errorMessage(error) })
      return this.stateSnapshot()
    }
  }

  /**
   * Download only the files whose hash changed. The plan is computed against
   * the local tree, so an install that is one bundle behind transfers one
   * bundle.
   */
  async download(): Promise<UpdateState> {
    try {
      const release = await this.currentRelease()
      if (!release) return this.stateSnapshot()
      const local = await scanLocalServerState(this.root, release.files)
      const plan = planServerUpdate(release, local)
      if (plan.download.length === 0) {
        this.set({
          status: 'up-to-date',
          release: this.state.release,
          progress: 1,
          transferred: 0,
          total: 0,
          canInstall: false,
          message: `本地文件已与 ${release.version} 一致，无需下载。`,
        })
        return this.stateSnapshot()
      }
      const reused = plan.unchangedBytes
      this.set({
        status: 'downloading',
        progress: 0,
        transferred: 0,
        total: plan.downloadBytes,
        canInstall: false,
        message:
          reused > 0
            ? `增量更新：${plan.download.length} 个文件需下载（${formatBytes(
                plan.downloadBytes,
              )}），复用 ${formatBytes(reused)}。`
            : `下载 ${plan.download.length} 个文件（${formatBytes(plan.downloadBytes)}）…`,
      })
      const staged = await stageServerUpdate({
        root: this.root,
        release,
        plan,
        fetch: this.fetchImpl,
        allowedHosts: this.allowedHosts,
        onProgress: ({ transferred, total, progress }) => {
          this.set({ transferred, total, progress })
        },
      })
      this.staged = staged
      this.set({
        status: 'ready',
        progress: 1,
        transferred: plan.downloadBytes,
        total: plan.downloadBytes,
        canInstall: true,
        message: `已下载并校验 ${plan.download.length} 个文件，可以安装 ${release.version}。`,
      })
      return this.stateSnapshot()
    } catch (error) {
      this.staged = null
      this.set({ status: 'error', canInstall: false, message: `下载失败：${errorMessage(error)}` })
      return this.stateSnapshot()
    }
  }

  /**
   * Replace the files in place. The running process keeps its already-loaded
   * modules, so the new code is live after a restart; the panel assets are read
   * from disk per request and are therefore new immediately.
   */
  async install(): Promise<UpdateState> {
    const staged = this.staged
    if (!staged) throw new Error('还没有下载好的更新，请先检查并下载。')
    this.set({ status: 'installing', canInstall: false, message: '正在替换文件…' })
    try {
      const result = await applyStagedUpdate(staged)
      this.staged = null
      this.set({
        status: 'ready',
        progress: 1,
        canInstall: false,
        currentVersion: result.version,
        message: `已更新到 ${result.version}（替换 ${result.applied} 个文件，移除 ${result.removed} 个）。重启 \`pilot serve\` 后生效。`,
      })
      return this.stateSnapshot()
    } catch (error) {
      this.set({ status: 'error', message: `安装失败，已回滚：${errorMessage(error)}` })
      throw error
    }
  }

  /** Check, download and install in one go — what the CLI `update` command runs. */
  async runNow(): Promise<UpdateState> {
    const checked = await this.check()
    if (checked.status !== 'available') return checked
    const downloaded = await this.download()
    if (downloaded.status !== 'ready') return downloaded
    return this.install()
  }

  private async currentRelease(): Promise<ServerRelease | null> {
    // `download` may run right after `check`, or on its own from the console.
    if (this.release) return this.release
    const checked = await this.check()
    return checked.status === 'available' ? this.release : null
  }
}
