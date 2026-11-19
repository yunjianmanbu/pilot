import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { gunzipSync } from 'node:zlib'
import type { UpdateRelease, UpdateState } from '../shared/types'
import {
  MAX_BLOCKMAP_BLOCK_BYTES,
  type BlockMap,
  parseBlockMap,
  planDelta,
} from './update/blockmap'
import {
  MAX_INSTALLER_BYTES,
  assertReleaseUrl,
  isNewerVersion,
  parseRelease,
} from './update/manifest'

const DEFAULT_MANIFEST_URL = 'https://download.medpilot.cc/pilot/latest.json'
const TRUSTED_HOSTS = ['download.medpilot.cc']
const MANIFEST_LIMIT_BYTES = 64 * 1024
const MANIFEST_TIMEOUT_MS = 20_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 45_000
const PROGRESS_INTERVAL_MS = 150
const MAX_BLOCKMAP_BYTES = 8 * 1024 * 1024
const MAX_BLOCKMAP_UNCOMPRESSED_BYTES = 32 * 1024 * 1024

interface BaseInstaller {
  path: string
  name: string
  size: number
  blockmapPath?: string
  modifiedAt: number
}

/**
 * Result of an attempt to build the installer from cached blocks. A `skip`
 * carries the reason so the UI can say why it fell back to the full payload
 * instead of silently transferring ~120 MB.
 */
type DeltaOutcome =
  | { kind: 'delta'; downloaded: number; blockMapRaw: Buffer }
  | { kind: 'skip'; reason: string }

export interface UpdaterOptions {
  currentVersion: string
  userDataDir: string
  isPackaged: boolean
  onState: (state: UpdateState) => void
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求超时，请检查网络后重试。'
    return error.message
  }
  return String(error)
}

/**
 * Per-user installs (electron-builder `perMachine: false`) update without a
 * prompt. When Pilot was installed into a protected directory such as
 * C:\Program Files, the silent installer must elevate and Windows shows UAC.
 */
function installNeedsElevation(): boolean {
  if (process.platform !== 'win32') return false
  try {
    accessSync(dirname(process.execPath), constants.W_OK)
    return false
  } catch {
    return true
  }
}

/**
 * True when the executable sits under a machine-wide Program Files root. This
 * catches the case where Pilot happens to run elevated (or the folder happens
 * to be writable), where the write-probe above would say "no elevation needed"
 * but the install is still registered for all users and must move to the
 * per-user folder on update.
 */
export function installedForAllUsers(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (process.platform !== 'win32') return false
  const normalize = (value: string) =>
    value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
  const target = normalize(execPath)
  const roots = [env['ProgramW6432'], env['ProgramFiles'], env['ProgramFiles(x86)']]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
  return roots.some((root) => {
    const prefix = normalize(root)
    return target === prefix || target.startsWith(`${prefix}\\`)
  })
}

const PRODUCT_DIR_NAME = 'Pilot'

/** electron-builder's per-user default: %LOCALAPPDATA%\Programs\Pilot. */
function perUserProgramDir(): string | null {
  if (process.platform !== 'win32') return null
  const base = process.env['LOCALAPPDATA']?.trim()
  return base ? join(base, 'Programs', PRODUCT_DIR_NAME) : null
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export class UpdaterService {
  private readonly currentVersion: string
  private readonly isPackaged: boolean
  private readonly onState: (state: UpdateState) => void
  private readonly updateDir: string
  private readonly manifestUrl: string
  private readonly allowedHosts: Set<string>
  private readonly supported: boolean
  private readonly relocatingToUserDir: boolean
  private state: UpdateState
  private checkPromise: Promise<UpdateState> | null = null
  private downloadPromise: Promise<UpdateState> | null = null
  private installerPath: string | null = null

  constructor(options: UpdaterOptions) {
    this.currentVersion = options.currentVersion
    this.isPackaged = options.isPackaged
    this.onState = options.onState
    this.updateDir = join(options.userDataDir, 'updates')
    this.supported = process.platform === 'win32'
    this.manifestUrl = process.env['PILOT_UPDATE_MANIFEST']?.trim() || DEFAULT_MANIFEST_URL

    const hosts = new Set(TRUSTED_HOSTS)
    try {
      hosts.add(new URL(this.manifestUrl).hostname)
    } catch {
      // The URL is validated before every request.
    }
    this.allowedHosts = hosts

    const disabled = !this.supported || process.env['PILOT_DISABLE_UPDATER'] === '1'
    const elevationRequired = this.isPackaged && installNeedsElevation()
    const perUserDir = perUserProgramDir()
    // A protected install (typically C:\Program Files) can be updated into the
    // per-user folder with `/currentuser`, which needs no UAC prompt. The old
    // copy stays on disk until the user uninstalls it; settings and sessions
    // live in userData and carry over.
    // Program Files counts even when the write probe succeeds (Pilot started
    // elevated): such an install is machine-wide and must not silently update
    // itself back into Program Files.
    this.relocatingToUserDir =
      (elevationRequired || (this.isPackaged && installedForAllUsers())) &&
      perUserDir !== null &&
      !sameDirectory(perUserDir, dirname(process.execPath))

    this.state = {
      status: disabled ? 'disabled' : 'idle',
      currentVersion: this.currentVersion,
      release: null,
      progress: 0,
      transferred: 0,
      total: 0,
      message: !this.supported
        ? '当前平台暂不支持应用内更新。'
        : disabled
          ? '在线更新已被禁用。'
          : '尚未检查更新。',
      checkedAt: null,
      canInstall: this.supported && this.isPackaged,
      elevationRequired,
      relocatingToUserDir: this.relocatingToUserDir,
    }
  }

  stateSnapshot(): UpdateState {
    return {
      ...this.state,
      release: this.state.release ? { ...this.state.release } : null,
    }
  }

  private publish(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    try {
      this.onState(this.stateSnapshot())
    } catch {
      // The window may be closing; state is still available via IPC.
    }
  }

  check(): Promise<UpdateState> {
    if (this.checkPromise) return this.checkPromise
    if (
      this.state.status === 'downloading' ||
      this.state.status === 'installing' ||
      this.state.status === 'ready'
    ) {
      return Promise.resolve(this.stateSnapshot())
    }
    this.checkPromise = this.runCheck().finally(() => {
      this.checkPromise = null
    })
    return this.checkPromise
  }

  private async runCheck(): Promise<UpdateState> {
    if (this.state.status === 'disabled') return this.stateSnapshot()

    this.publish({
      status: 'checking',
      message: '正在检查更新…',
      progress: 0,
      transferred: 0,
      total: 0,
    })

    try {
      const release = await this.fetchRelease()
      const checkedAt = new Date().toISOString()
      if (isNewerVersion(release.version, this.currentVersion)) {
        this.publish({
          status: 'available',
          release,
          message: `发现新版本 v${release.version}（${formatBytes(release.size)}）。`,
          checkedAt,
          total: release.size,
        })
      } else {
        this.publish({
          status: 'up-to-date',
          release: null,
          message: '已是最新版本。',
          checkedAt,
        })
      }
    } catch (error) {
      this.publish({
        status: 'error',
        release: null,
        message: `检查更新失败：${errorMessage(error)}`,
        checkedAt: new Date().toISOString(),
        progress: 0,
        transferred: 0,
        total: 0,
      })
    }
    return this.stateSnapshot()
  }

  private async fetchRelease(): Promise<UpdateRelease> {
    const url = assertReleaseUrl(this.manifestUrl, this.allowedHosts)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)

    let text: string
    try {
      const response = await net.fetch(url.toString(), {
        signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      })
      if (!response.ok) {
        throw new Error(`更新服务器返回 HTTP ${response.status}。`)
      }
      if (response.url) assertReleaseUrl(response.url, this.allowedHosts)

      const announced = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(announced) && announced > MANIFEST_LIMIT_BYTES) {
        throw new Error('更新清单过大。')
      }
      text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MANIFEST_LIMIT_BYTES) {
        throw new Error('更新清单过大。')
      }
    } finally {
      clearTimeout(timer)
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error('更新清单不是有效的 JSON。')
    }
    const release = parseRelease(raw, this.allowedHosts)
    assertReleaseUrl(release.url, this.allowedHosts)
    return release
  }

  download(): Promise<UpdateState> {
    if (this.downloadPromise) return this.downloadPromise
    if (this.state.status === 'ready') return Promise.resolve(this.stateSnapshot())
    const release = this.state.release
    if (this.state.status !== 'available' || !release) {
      return Promise.resolve(this.stateSnapshot())
    }
    this.downloadPromise = this.runDownload(release).finally(() => {
      this.downloadPromise = null
    })
    return this.downloadPromise
  }

  private async runDownload(release: UpdateRelease): Promise<UpdateState> {
    this.publish({
      status: 'downloading',
      release,
      progress: 0,
      transferred: 0,
      total: release.size,
      message: `正在下载 v${release.version}…`,
    })

    const target = join(this.updateDir, this.installerFilename(release))
    const temporary = `${target}.part`

    try {
      const url = assertReleaseUrl(release.url, this.allowedHosts)
      await mkdir(this.updateDir, { recursive: true })
      await this.cleanupPartials()

      // A previous installer is the base for a block-level delta. Keeping it
      // costs disk space but turns the next ~120 MB download into ~1-3 MB.
      const base = await this.findBaseInstaller(target)
      let blockMapRaw: Buffer | null = null
      let deltaBytes: number | null = null
      let skipReason: string | null = null

      if (base) {
        try {
          const outcome = await this.downloadIncremental(release, url, temporary, base)
          if (outcome.kind === 'delta') {
            deltaBytes = outcome.downloaded
            blockMapRaw = outcome.blockMapRaw
          } else {
            skipReason = outcome.reason
          }
        } catch (error) {
          // Any delta failure falls back to the full installer; the base file
          // may be stale, partially written, or the host may not allow Range.
          skipReason = errorMessage(error)
        }
      } else {
        skipReason = `本地没有 ${this.installerFilename(release)} 之前版本的安装包作为基线`
      }

      if (deltaBytes === null) {
        await this.downloadFull(release, url, temporary)
      }

      await this.finishDownload(release, target, temporary, deltaBytes, blockMapRaw, skipReason)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      this.installerPath = null
      this.publish({
        status: 'error',
        release,
        progress: 0,
        transferred: 0,
        total: 0,
        message: `下载更新失败：${errorMessage(error)}`,
      })
    }
    return this.stateSnapshot()
  }

  /** Stream the full installer; verifies size and SHA-256 before returning. */
  private async downloadFull(
    release: UpdateRelease,
    url: URL,
    temporary: string,
  ): Promise<void> {
    await rm(temporary, { force: true }).catch(() => undefined)
    const controller = new AbortController()
    let timer: NodeJS.Timeout | null = null
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), ms)
    }
    arm(MANIFEST_TIMEOUT_MS)

    let stream: ReturnType<typeof createWriteStream> | null = null
    try {
      this.publish({
        status: 'downloading',
        release,
        progress: 0,
        transferred: 0,
        total: release.size,
        message: `正在下载 v${release.version}…`,
      })

      const response = await net.fetch(url.toString(), {
        signal: controller.signal,
        headers: { accept: 'application/octet-stream', 'cache-control': 'no-cache' },
      })
      if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}。`)
      if (response.url) assertReleaseUrl(response.url, this.allowedHosts)
      const body = response.body
      if (!body) throw new Error('更新服务器没有返回安装包内容。')

      const announced = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(announced) && announced > MAX_INSTALLER_BYTES) {
        throw new Error('安装包大小超出允许范围。')
      }

      stream = createWriteStream(temporary, { flags: 'wx' })
      const output = stream
      let writeError: Error | null = null
      output.on('error', (error) => {
        writeError = error
      })
      const reader = body.getReader()
      const hash = createHash('sha256')
      let transferred = 0
      let lastPublished = 0
      arm(DOWNLOAD_IDLE_TIMEOUT_MS)

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        if (writeError) throw writeError
        const chunk = Buffer.from(value)
        transferred += chunk.length
        if (transferred > release.size || transferred > MAX_INSTALLER_BYTES) {
          throw new Error('安装包大小与更新清单不一致。')
        }
        hash.update(chunk)
        await this.writeChunk(output, chunk)
        arm(DOWNLOAD_IDLE_TIMEOUT_MS)

        const now = Date.now()
        if (now - lastPublished >= PROGRESS_INTERVAL_MS || transferred === release.size) {
          lastPublished = now
          this.publish({
            status: 'downloading',
            progress: Math.min(1, transferred / release.size),
            transferred,
            total: release.size,
            message: `正在下载 v${release.version}… ${Math.round((transferred / release.size) * 100)}%`,
          })
        }
      }

      output.end()
      await finished(output)
      stream = null

      if (transferred !== release.size) {
        throw new Error(
          `安装包大小不一致（期望 ${release.size} 字节，实际 ${transferred} 字节）。`,
        )
      }
      const digest = hash.digest('hex').toLowerCase()
      if (digest !== release.sha256.toLowerCase()) {
        throw new Error('安装包 SHA-256 校验失败，请重试。')
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (stream) stream.destroy()
    }
  }

  /**
   * Rebuild the new installer from the previous installer plus the ranges that
   * changed. Returns the number of network bytes used, or null when a delta is
   * not possible (no blockmap, no cached installer, no Range support).
   */
  private async downloadIncremental(
    release: UpdateRelease,
    url: URL,
    temporary: string,
    base: BaseInstaller,
  ): Promise<DeltaOutcome> {
    const next = await this.fetchBlockMap(this.blockMapUrl(url), release.size)
    if (!next) return { kind: 'skip', reason: '无法获取新版本的 blockmap' }
    const previous = await this.oldBlockMap(base, url)
    if (!previous) return { kind: 'skip', reason: `无法获取基线 ${base.name} 的 blockmap` }

    const plan = planDelta(next.map, previous)
    // If almost everything changed, the full installer is simpler and not
    // meaningfully slower. Keep the base for a future version.
    if (plan.downloadBytes > release.size * 0.9) {
      return {
        kind: 'skip',
        reason: `新旧安装包差异过大（需传输 ${formatBytes(plan.downloadBytes)}）`,
      }
    }

    await rm(temporary, { force: true }).catch(() => undefined)
    const total = Math.max(1, plan.downloadBytes)
    this.publish({
      status: 'downloading',
      release,
      progress: 0,
      transferred: 0,
      total,
      message: `正在增量下载 v${release.version}…`,
    })

    const output = createWriteStream(temporary, { flags: 'wx' })
    let writeError: Error | null = null
    output.on('error', (error) => {
      writeError = error
    })
    const handle = await open(base.path, 'r')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(MAX_BLOCKMAP_BLOCK_BYTES, 1024 * 1024))
    let transferred = 0
    let written = 0
    let lastPublished = 0

    try {
      for (const segment of plan.segments) {
        if (writeError) throw writeError
        if (segment.kind === 'copy') {
          let copied = 0
          while (copied < segment.size) {
            const length = Math.min(buffer.length, segment.size - copied)
            const { bytesRead } = await handle.read(
              buffer,
              0,
              length,
              segment.sourceOffset + copied,
            )
            if (bytesRead === 0) throw new Error('旧的安装包不完整，无法增量更新。')
            const chunk = buffer.subarray(0, bytesRead)
            hash.update(chunk)
            await this.writeChunk(output, chunk)
            copied += bytesRead
            written += bytesRead
          }
          continue
        }

        const controller = new AbortController()
        let timer: NodeJS.Timeout | null = null
        const arm = (ms: number) => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => controller.abort(), ms)
        }
        arm(MANIFEST_TIMEOUT_MS)
        try {
          const start = segment.targetOffset
          const end = start + segment.size - 1
          const response = await net.fetch(url.toString(), {
            signal: controller.signal,
            headers: {
              accept: 'application/octet-stream',
              'cache-control': 'no-cache',
              range: `bytes=${start}-${end}`,
            },
          })
          if (response.status !== 206) {
            await response.body?.cancel().catch(() => undefined)
            throw new Error('更新服务器不支持增量下载。')
          }
          if (response.url) assertReleaseUrl(response.url, this.allowedHosts)
          const announced = Number(response.headers.get('content-length') ?? '')
          if (Number.isFinite(announced) && announced !== segment.size) {
            throw new Error('增量分块大小不一致。')
          }
          const body = response.body
          if (!body) throw new Error('更新服务器没有返回增量内容。')
          const reader = body.getReader()
          let received = 0
          arm(DOWNLOAD_IDLE_TIMEOUT_MS)
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            if (writeError) throw writeError
            const chunk = Buffer.from(value)
            received += chunk.length
            if (received > segment.size) throw new Error('增量分块大小不一致。')
            transferred += chunk.length
            written += chunk.length
            hash.update(chunk)
            await this.writeChunk(output, chunk)
            arm(DOWNLOAD_IDLE_TIMEOUT_MS)

            const now = Date.now()
            if (now - lastPublished >= PROGRESS_INTERVAL_MS || transferred === plan.downloadBytes) {
              lastPublished = now
              this.publish({
                status: 'downloading',
                release,
                progress: Math.min(1, transferred / total),
                transferred,
                total,
                message: `正在增量下载 v${release.version}… ${Math.round((transferred / total) * 100)}%`,
              })
            }
          }
          if (received !== segment.size) throw new Error('增量分块大小不一致。')
        } finally {
          if (timer) clearTimeout(timer)
        }
      }

      output.end()
      await finished(output)
      if (written !== release.size) {
        throw new Error(
          `安装包大小不一致（期望 ${release.size} 字节，实际 ${written} 字节）。`,
        )
      }
      const digest = hash.digest('hex').toLowerCase()
      if (digest !== release.sha256.toLowerCase()) {
        throw new Error('安装包 SHA-256 校验失败，请重试。')
      }
      return { kind: 'delta', downloaded: transferred, blockMapRaw: next.raw }
    } catch (error) {
      output.destroy()
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  private async finishDownload(
    release: UpdateRelease,
    target: string,
    temporary: string,
    deltaBytes: number | null,
    blockMapRaw: Buffer | null,
    skipReason: string | null,
  ): Promise<void> {
    await rm(target, { force: true })
    await rename(temporary, target)
    this.installerPath = target

    const raw = blockMapRaw ?? (await this.tryFetchBlockMap(this.blockMapUrl(new URL(release.url)), release.size))
    if (raw) await writeFile(`${target}.blockmap`, raw).catch(() => undefined)
    await this.pruneDownloads(target)

    const fullLabel = skipReason
      ? `全量 ${formatBytes(release.size)}，未增量：${skipReason}`
      : `全量 ${formatBytes(release.size)}`
    const readyMessage = (suffix: string) =>
      deltaBytes === null
        ? `v${release.version} 已下载并通过校验（${fullLabel}）${suffix}`
        : `v${release.version} 已下载并通过校验（增量 ${formatBytes(deltaBytes)}）${suffix}`
    this.publish({
      status: 'ready',
      release,
      progress: 1,
      transferred: release.size,
      total: release.size,
      message: this.canInstall()
        ? `${readyMessage('，重启后安装。')}`
        : `${readyMessage('；开发模式下不会执行安装。')}`,
    })
  }

  private blockMapUrl(url: URL): URL {
    const next = new URL(url.toString())
    next.pathname = `${next.pathname}.blockmap`
    return assertReleaseUrl(next.toString(), this.allowedHosts)
  }

  private async fetchBlockMap(
    url: URL,
    expectedSize: number,
  ): Promise<{ map: ReturnType<typeof parseBlockMap>; raw: Buffer } | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
    try {
      const response = await net.fetch(url.toString(), {
        signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      if (response.url) assertReleaseUrl(response.url, this.allowedHosts)
      const announced = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(announced) && announced > MAX_BLOCKMAP_BYTES) return null
      const raw = Buffer.from(await response.arrayBuffer())
      if (raw.length === 0 || raw.length > MAX_BLOCKMAP_BYTES) return null
      const payload =
        raw[0] === 0x1f && raw[1] === 0x8b
          ? gunzipSync(raw, { maxOutputLength: MAX_BLOCKMAP_UNCOMPRESSED_BYTES })
          : raw
      if (payload.length > MAX_BLOCKMAP_UNCOMPRESSED_BYTES) return null
      const json: unknown = JSON.parse(payload.toString('utf8'))
      return { map: parseBlockMap(json, expectedSize), raw }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async tryFetchBlockMap(url: URL, expectedSize: number): Promise<Buffer | null> {
    return (await this.fetchBlockMap(url, expectedSize))?.raw ?? null
  }

  private async oldBlockMap(base: BaseInstaller, releaseUrl: URL): Promise<BlockMap | null> {
    if (base.blockmapPath) {
      try {
        const raw = await readFile(base.blockmapPath)
        const payload =
          raw[0] === 0x1f && raw[1] === 0x8b
            ? gunzipSync(raw, { maxOutputLength: MAX_BLOCKMAP_UNCOMPRESSED_BYTES })
            : raw
        return parseBlockMap(JSON.parse(payload.toString('utf8')), base.size)
      } catch {
        // Fall through and try the copy next to the remote installer.
      }
    }
    const url = new URL(releaseUrl.toString())
    const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)
    url.pathname = `${directory}${base.name}.blockmap`
    const fetched = await this.fetchBlockMap(url, base.size)
    if (!fetched) return null
    if (base.blockmapPath) {
      await writeFile(base.blockmapPath, fetched.raw).catch(() => undefined)
    }
    return fetched.map
  }

  private async findBaseInstaller(target: string): Promise<BaseInstaller | null> {
    try {
      const targetName = basename(target)
      const names = await readdir(this.updateDir)
      const candidates: BaseInstaller[] = []
      for (const name of names) {
        if (!/\.exe$/i.test(name) || name === targetName) continue
        const path = join(this.updateDir, name)
        const info = await stat(path).catch(() => null)
        if (!info?.isFile() || info.size <= 0 || info.size > MAX_INSTALLER_BYTES) continue
        const blockmapPath = `${path}.blockmap`
        const cached = await stat(blockmapPath).catch(() => null)
        candidates.push({
          path,
          name,
          size: info.size,
          blockmapPath: cached?.isFile() ? blockmapPath : undefined,
          modifiedAt: info.mtimeMs,
        })
      }
      candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
      return candidates[0] ?? null
    } catch {
      return null
    }
  }

  private async cleanupPartials(): Promise<void> {
    try {
      const names = await readdir(this.updateDir)
      await Promise.all(
        names
          .filter((name) => /\.part$/i.test(name))
          .map((name) => rm(join(this.updateDir, name), { force: true }).catch(() => undefined)),
      )
    } catch {
      // No previous downloads or the directory is unavailable.
    }
  }

  private async pruneDownloads(keepInstaller: string): Promise<void> {
    try {
      const keep = new Set([basename(keepInstaller), `${basename(keepInstaller)}.blockmap`])
      // The previous installer is the base that turns the next update into a
      // ~1-3 MB block delta. Deleting it here forced every later upgrade into a
      // full ~120 MB download, so keep the newest one next to the new installer.
      const base = await this.preferredBaseInstaller(basename(keepInstaller))
      if (base) {
        keep.add(base)
        keep.add(`${base}.blockmap`)
      }
      const names = await readdir(this.updateDir)
      await Promise.all(
        names
          .filter((name) => /\.(exe|blockmap|part)$/i.test(name) && !keep.has(name))
          .map((name) => rm(join(this.updateDir, name), { force: true }).catch(() => undefined)),
      )
    } catch {
      // Best effort; a leftover installer is harmless.
    }
  }

  /**
   * Picks the installer kept as the next delta base. The highest version wins
   * so a stray older download cannot displace the real predecessor; mtime only
   * breaks ties between identical version strings.
   */
  private async preferredBaseInstaller(excludeName: string): Promise<string | null> {
    try {
      const names = await readdir(this.updateDir)
      const entries: { name: string; version: string; modifiedAt: number }[] = []
      for (const name of names) {
        if (!/\.exe$/i.test(name) || name === excludeName) continue
        const version = /Pilot-(\d+\.\d+\.\d+)/i.exec(name)?.[1]
        if (!version) continue
        const info = await stat(join(this.updateDir, name))
        entries.push({ name, version, modifiedAt: info.mtimeMs })
      }
      entries.sort((left, right) => {
        if (left.version !== right.version) return isNewerVersion(left.version, right.version) ? -1 : 1
        return right.modifiedAt - left.modifiedAt
      })
      return entries[0]?.name ?? null
    } catch {
      return null
    }
  }

  private async writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
    if (stream.write(chunk)) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        stream.off('drain', onDrain)
        stream.off('error', onError)
      }
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      stream.once('drain', onDrain)
      stream.once('error', onError)
    })
  }

  private canInstall(): boolean {
    return this.supported && this.isPackaged
  }

  async install(): Promise<void> {
    if (!this.canInstall()) throw new Error('当前环境不支持自动安装更新。')
    if (this.state.status !== 'ready' || !this.installerPath || !this.state.release) {
      throw new Error('没有已下载的更新。')
    }

    const release = this.state.release
    const installer = this.installerPath
    try {
      const info = await stat(installer)
      if (info.size !== release.size) {
        throw new Error('安装包大小与清单不一致，请重新下载。')
      }
      const digest = await this.sha256File(installer)
      if (digest !== release.sha256.toLowerCase()) {
        throw new Error('安装包校验失败，请重新下载。')
      }
    } catch (error) {
      if (this.state.status === 'ready') {
        await this.discardInstaller(errorMessage(error))
      }
      throw error
    }

    this.publish({
      status: 'installing',
      message: this.state.relocatingToUserDir
        ? '正在安装到当前用户目录并更新，Pilot 将退出并在完成后重新启动…'
        : '正在安装更新，Pilot 将退出并在完成后重新启动…',
    })

    // Assisted NSIS installers skip the finish page when silent, so ask the
    // installer itself to relaunch the app once the update is applied.
    const args = ['/S', '--updated', '--force-run']
    // Force the per-user install mode. electron-builder then installs to
    // %LOCALAPPDATA%\Programs\Pilot, which the current user can write to, so
    // the silent update does not raise UAC even though the running copy sits in
    // a protected directory. `/D` is unnecessary: the per-user default is the
    // intended target, and a previous per-user location in HKCU wins.
    if (this.state.relocatingToUserDir) args.push('/currentuser')
    const child = spawn(installer, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => resolve())
    })
    child.unref()

    if (this.state.relocatingToUserDir) {
      // A per-user install never elevates; quit so the installer can relaunch
      // the new copy without fighting this process for the instance lock.
      setTimeout(() => app.quit(), 300)
      return
    }

    if (this.state.elevationRequired) {
      // The installer raises UAC on the computer. If the user cancels it, the
      // installer exits without changing anything, so keep Pilot running and
      // let the phone retry instead of quitting the app first.
      child.once('exit', (code) => {
        if (code === 0) {
          app.quit()
          return
        }
        this.publish({
          status: 'ready',
          message: '安装已取消：需要在 Windows 授权框里点「是」才能继续。',
        })
      })
      return
    }

    setTimeout(() => app.quit(), 300)
  }

  private async discardInstaller(message: string): Promise<void> {
    const installer = this.installerPath
    this.installerPath = null
    if (installer) {
      await rm(installer, { force: true }).catch(() => undefined)
      await rm(`${installer}.blockmap`, { force: true }).catch(() => undefined)
    }
    this.publish({
      status: 'error',
      release: null,
      progress: 0,
      transferred: 0,
      total: 0,
      message,
    })
  }

  private async sha256File(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk)
    }
    return hash.digest('hex').toLowerCase()
  }

  private installerFilename(release: UpdateRelease): string {
    try {
      const name = basename(new URL(release.url).pathname)
      if (/^[A-Za-z0-9._-]{1,120}\.exe$/i.test(name)) return name
    } catch {
      // Fall through to a generated name.
    }
    const version = release.version.replace(/[^0-9A-Za-z._-]/g, '_')
    return `Pilot-${version}-setup.exe`
  }
}
