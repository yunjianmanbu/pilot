import { constants, watch, type Dirent, type FSWatcher } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  copyFile,
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
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import type {
  Checkpoint,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  CheckpointTrigger,
} from '../shared/types'
import {
  ephemeralDirSegment,
  isEphemeralDirName,
  looksEphemeralDirPath,
  matchesCheckpointIgnore,
  normalizeCheckpointIgnore,
} from '../shared/checkpoint-ignore'
import { resolveForWrite, SKIP_DIRS } from './workspace'
import type { Store } from './store'

/**
 * Checkpoints are stored as content-addressed blobs:
 *
 *   checkpoints/blobs/<sha256[0:2]>/<sha256>       immutable file content
 *   checkpoints/<sessionId>/<checkpointId>/meta.json
 *   checkpoints/<sessionId>/<checkpointId>/manifest.json
 *   checkpoints/trash/<batch>/<sessionId>/<rel>    files moved out of the workspace
 *
 * A snapshot only writes files whose content is new; unchanged files are
 * shared with every earlier snapshot. Manifests keep `{ path, size, sha256 }`
 * and resolve their content through the blob hash. Version-1 snapshots keep
 * their own `files/` directory and are still readable and restorable.
 *
 * Disk usage is bounded two ways: per-session retention (existing) and a
 * global `checkpointMaxBytes` budget. Maintenance sweeps unreferenced blobs
 * and evicts the oldest snapshots, always keeping the newest one per session
 * and each session's pinned baseline.
 *
 * A restore or per-file revert moves displaced files to `checkpoints/trash`,
 * which lives outside every snapshot directory: retention and the global
 * budget must never delete the only copy of a user file. Trash is swept on its
 * own budget instead (see `sweepTrash`).
 */

const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 250 * 1024 * 1024
const META_FILE = 'meta.json'
const MANIFEST_FILE = 'manifest.json'
const BLOBS_DIR = 'blobs'
const BLOB_TEMP_DIR = '.tmp'
const INDEX_DIR = '.workspace-index'
const INDEX_VERSION = 1
const MIN_RETENTION = 5
// Files a restore or a per-file revert moved out of the workspace live in their
// own tree: `checkpoints/trash/<batch>/<sessionId>/<rel>`.
//
// It deliberately sits *outside* the per-session snapshot directories, so
// retention (`prune`), the global budget (`enforceGlobalCap`) and blob sweeping
// can never delete a user file that a revert put there. It has its own budget.
const TRASH_DIR = 'trash'
const TRASH_MAX_AGE_MS = 14 * 24 * 60 * 60_000
const TRASH_MAX_BYTES = 512 * 1024 * 1024
const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60_000
const MAINTENANCE_STATE_FILE = '.maintenance.json'
const MAINTENANCE_STATE_VERSION = 1
// A full audit corrects the incremental byte counter and collects blobs that
// became unreferenced. It is deliberately rare: cap pressure handles the normal
// case without any directory walk.
const MAINTENANCE_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60_000
// Maintenance walks tens of thousands of blob files on large stores. Yield
// regularly so the main process can still paint and answer IPC while it runs.
const YIELD_EVERY = 256
// A full walk is still needed periodically in case the recursive watcher drops
// an event. Between full walks, changed paths reported by the watcher drive the
// snapshot, so a shell command on a large repository costs a few stats instead
// of a walk over every file.
const FULL_SCAN_MAX_AGE_MS = 5 * 60_000
const FULL_SCAN_EVERY = 20
// A walk that already costs more than this is worth replacing with the dirty
// set even when the workspace holds fewer files than `fastPathMinFiles`: the
// threshold is a guess, the measurement is not.
const FULL_SCAN_COST_MS = 250
const WATCH_DIRTY_LIMIT = 5_000
// The recursive watcher can die on its own (Windows buffer overflow, network
// volume, a directory removed under it). Retry it on a bounded schedule
// instead of falling back to a full walk for the rest of the session.
const WATCH_RETRY_BASE_MS = 15_000
const WATCH_RETRY_MAX_DELAY_MS = 10 * 60_000
const WATCH_RETRY_WINDOW_MS = 60 * 60_000
const WATCH_RETRY_BUDGET = 12
// A watcher that worked for this long and then died is treated as a new
// incident (immediate retry, fresh budget). Anything shorter is a flap: the
// retry counter keeps accumulating so a broken filesystem cannot turn into an
// attach-per-snapshot loop.
const WATCH_HEALTHY_MS = 5 * 60_000
const IGNORE_PATTERN_LIMIT = 200
const DIR_CONCURRENCY = 16
const STAT_CONCURRENCY = 32
const HASH_CONCURRENCY = 4
const BLOB_CHECK_CONCURRENCY = 32
// Binary/media files would consume the 250 MB budget without giving the model
// anything to read on rollback. Skipping them keeps the snapshot focused on
// source and documents; the checkpoint stays `complete` because the exclusion
// is intentional.
const SNAPSHOT_SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.zip', '.7z', '.rar', '.gz', '.tgz', '.bz2', '.xz', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.mdb',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.jar', '.class', '.pyc', '.node', '.wasm',
  '.iso', '.dmg', '.msi', '.apk', '.ipa', '.aab', '.psd', '.ai', '.sketch', '.fig',
])
// The settings UI enforces 512 MB–20 GB; the service only rejects nonsense so
// tests and future callers can drive the budget directly.
const MIN_GLOBAL_BYTES = 1
const MAX_GLOBAL_BYTES = 20 * 1024 * 1024 * 1024
const DEFAULT_GLOBAL_BYTES = 2 * 1024 * 1024 * 1024
const MAINTENANCE_INTERVAL_MS = 5 * 60_000
/**
 * How long an identical shell snapshot stays reusable. Long enough to collapse
 * a burst of commands from one run, short enough that "before this command"
 * still means something for a follow-up task minutes later.
 */
const CHECKPOINT_SHELL_REUSE_MS = 10 * 60_000
const MAINTENANCE_MAX_ROUNDS = 100

interface ManifestEntry {
  path: string
  size: number
  sha256: string
}

interface IndexEntry {
  size: number
  mtimeMs: number
  sha256: string
}

interface WorkspaceState {
  index: Map<string, IndexEntry>
  loaded: boolean
  dirty: Set<string>
  watcher: FSWatcher | null
  watchHealthy: boolean
  /** Files the last full scan would snapshot, i.e. after every ignore rule. */
  snapshottable: number
  /** What the last full walk cost, used to decide whether the fast path pays. */
  lastScanMs: number
  lastFullScanAt: number
  snapshotsSinceFullScan: number
  /** Patterns in effect last time this workspace was scanned. */
  ignore: string[]
  /** Watcher self-heal bookkeeping: attempts inside the current window. */
  watchAttempts: number
  watchRetryAt: number
  watchWindowStart: number
  watchAttachedAt: number
  /** The last full walk hit the size budget or failed to read a file. */
  lastIncomplete: boolean
  /**
   * Directories a tool created that look generated (`build-output`, `run-tmp`)
   * and are therefore kept out of snapshots for this session. Built-in names
   * do not land here: they are ignored unconditionally.
   */
  autoIgnore: string[]
}

export interface CheckpointServiceOptions {
  /** Watch the workspace so repeated snapshots skip the full tree walk. */
  watch?: boolean
  /** Workspaces with fewer files are small enough that a walk is cheap. */
  fastPathMinFiles?: number
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await worker(item, index)
    }
  })
  await Promise.all(runners)
  return results
}

function hasSkippedExtension(rel: string): boolean {
  return SNAPSHOT_SKIP_EXTENSIONS.has(extname(rel).toLowerCase())
}

function isIgnoredPath(rel: string, ignore?: readonly string[]): boolean {
  const segments = rel.split('/')
  // Scratch and generated names are excluded whether or not the user
  // configured anything: a build tree must never join the walk.
  if (ephemeralDirSegment(rel) !== null) return true
  if (segments.includes('.pilot-checkpoints')) return true
  for (const segment of segments) {
    if (SKIP_DIRS.has(segment)) return true
  }
  return ignore !== undefined && matchesCheckpointIgnore(rel, ignore)
}

/** Normalized label for a snapshot; shared by the reuse fast path. */
function checkpointLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 120) || '快照'
}

function workspaceIndexKey(workspacePath: string): string {
  return createHash('sha256').update(comparePath(resolve(workspacePath))).digest('hex')
}

interface CheckpointMeta extends Checkpoint {
  version: 1 | 2
  /**
   * Digest of the manifest contents. Lets a shell-triggered snapshot notice
   * that the workspace is byte-identical to the previous snapshot and reuse it
   * instead of writing a duplicate directory with the same tree.
   */
  manifestDigest?: string
}

interface CheckpointRef {
  sessionId: string
  dir: string
  meta: CheckpointMeta
}

interface ScanResult {
  refs: CheckpointRef[]
  hashes: Set<string>
  /** Bytes held by legacy version-1 `files/` directories. */
  legacyBytes: number
}

/**
 * Persisted between launches so startup does not have to walk the blob store to
 * decide whether maintenance is needed. `blobBytes` is incremented when a new
 * blob is written and corrected by a full scan; the audit interval bounds any
 * drift (a crash between a blob write and the state save).
 */
interface MaintenanceState {
  version: typeof MAINTENANCE_STATE_VERSION
  blobBytes: number
  legacyBytes: number
  lastMaintenanceAt: number
  lastAuditAt: number
  lastTrashSweepAt: number
}

type MetaState =
  | { state: 'ok'; meta: CheckpointMeta }
  | { state: 'missing' }
  | { state: 'invalid' }

function now(): string {
  return new Date().toISOString()
}

function normalizeRel(value: string): string {
  return value.split('\\').join('/')
}

function safeSessionDir(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(sessionId)) throw new Error('Invalid session id')
  return sessionId
}

function safeCheckpointDir(id: string): string {
  if (!/^[A-Za-z0-9-]{1,120}$/.test(id)) throw new Error('Invalid checkpoint id')
  return id
}

function safeRelative(rel: string): boolean {
  if (!rel || isAbsolute(rel) || rel.includes('\0')) return false
  const normalized = normalizeRel(rel)
  if (normalized === '..' || normalized.startsWith('../')) return false
  if (normalized.split('/').includes('..')) return false
  return true
}

function comparePath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function refKey(ref: CheckpointRef): string {
  return `${ref.sessionId}/${ref.meta.id}`
}

function clampGlobalBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GLOBAL_BYTES
  return Math.round(Math.max(MIN_GLOBAL_BYTES, Math.min(MAX_GLOBAL_BYTES, value)))
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function moveFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  try {
    await rename(source, target)
  } catch {
    await copyFile(source, target)
    await rm(source, { force: true })
  }
}

export class CheckpointService {
  private readonly root: string
  /**
   * Serialization is per workspace, not global.
   *
   * Its original form was one promise chain for the whole service, so three
   * concurrent runs put every snapshot of every workspace behind each other:
   * the third run's `beforeShell` snapshot waited for two unrelated trees to be
   * walked, and that wait landed in its checkpoint timing. Snapshots of two
   * workspaces share nothing but the blob store, whose writes are
   * content-addressed (`<hash>.tmp` + rename) and therefore safe to interleave.
   *
   * `undefined` means store-wide work (maintenance, blob sweeps): it is gated
   * on the global chain and additionally waits for whatever is already
   * executing, because a sweep must never delete a blob another workspace is
   * about to reference.
   */
  private storeChain: Promise<unknown> = Promise.resolve()
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Tokens of tasks that passed the gate and are executing right now. */
  private readonly running = new Set<Promise<void>>()
  // Tracks the async context of the task currently holding a lock, so a nested
  // call (a restore creating its safety snapshot) runs inline instead of
  // queueing behind itself, while an unrelated concurrent caller still waits.
  private readonly lockContext = new AsyncLocalStorage<true>()
  private lastMaintenance = 0
  private maintenanceState: MaintenanceState | null = null
  private maintenanceStatePromise: Promise<MaintenanceState | null> | null = null
  private maintenanceStateDirty = false
  // A blob can be written twice concurrently for the same content (two files
  // with identical bytes in one snapshot). Count it once; a full scan clears
  // this set so a blob deleted and later recreated is counted again.
  private readonly countedBlobs = new Set<string>()
  private readonly workspaces = new Map<string, WorkspaceState>()
  private readonly watchEnabled: boolean
  private readonly fastPathMinFiles: number

  constructor(
    baseDir: string,
    private readonly store: Store,
    options: CheckpointServiceOptions = {},
  ) {
    this.root = join(baseDir, 'checkpoints')
    this.watchEnabled = options.watch !== false
    this.fastPathMinFiles = Math.max(0, Math.round(options.fastPathMinFiles ?? 2_000))
  }

  /** Stop workspace watchers; safe to call more than once. */
  dispose(): void {
    for (const state of this.workspaces.values()) {
      state.watcher?.close()
      state.watcher = null
    }
    this.workspaces.clear()
  }

  /**
   * Serialize store mutations for one `key` (a workspace path), or for the
   * whole store when `key` is omitted. A task that already holds a lock may
   * call `exclusive` again (a restore creates a safety snapshot), in which case
   * the nested work runs inline instead of queueing behind itself.
   */
  private exclusive<T>(task: () => Promise<T>, key?: string): Promise<T> {
    if (this.lockContext.getStore()) return task()
    const gate = this.storeChain
    const chainKey = key ?? ''
    const previous = this.chains.get(chainKey)
    let release: () => void = () => undefined
    // Resolves when this task finishes, so a store-wide task can wait for it.
    const token = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = (async () => {
      if (previous) await previous.catch(() => undefined)
      await gate.catch(() => undefined)
      // A sweep must not overlap a snapshot that is already writing blobs.
      if (key === undefined) await this.drainRunning()
      this.running.add(token)
      try {
        return await this.lockContext.run(true, task)
      } finally {
        this.running.delete(token)
        release()
      }
    })()
    const tail = run.catch(() => undefined)
    this.chains.set(chainKey, tail)
    void tail.finally(() => {
      if (this.chains.get(chainKey) === tail) this.chains.delete(chainKey)
    })
    if (key === undefined) this.storeChain = tail
    return run
  }

  /** Wait for every task that is already executing to settle. */
  private async drainRunning(): Promise<void> {
    for (;;) {
      const tokens = [...this.running]
      if (tokens.length === 0) return
      await Promise.allSettled(tokens)
    }
  }

  /**
   * Keep a directory a tool just created out of the next snapshot.
   *
   * Without this a `write_file` into `build-output/` adds that whole tree to
   * every later walk. Registering the path at creation time costs one string;
   * discovering it on the next snapshot costs a walk over the new files.
   *
   * Returns the workspace-relative directory when it was newly excluded.
   */
  noteEphemeralDir(workspacePath: string, relDir: string): string | null {
    const rel = normalizeRel(relDir).replace(/^\/+|\/+$/g, '')
    if (!rel || !safeRelative(rel)) return null
    if (!looksEphemeralDirPath(rel)) return null
    const state = this.stateFor(workspacePath)
    // A built-in name or a settings pattern already covers it: that decision
    // belongs to the setting, and the next snapshot drops the entry by itself.
    if (isIgnoredPath(rel, state.ignore)) return null
    if (state.autoIgnore.includes(rel)) return null
    state.autoIgnore.push(rel)
    // The cached index still lists that tree; one walk is what removes it, and
    // it runs on the next snapshot instead of on every snapshot after.
    state.lastFullScanAt = 0
    state.snapshotsSinceFullScan = 0
    // Persist the decision with the index when it is already loaded; otherwise
    // the snapshot that follows this write saves it.
    if (state.loaded) void this.saveIndex(workspacePath, state)
    return rel
  }

  /** Root of the revert/restore trash; independent from the snapshot tree. */
  private get trashRoot(): string {
    return join(this.root, TRASH_DIR)
  }

  /**
   * Open one trash batch for a single revert/restore. The batch name sorts by
   * time and carries a random suffix so two operations in the same millisecond
   * cannot overwrite each other's backups.
   *
   * Created lazily: an operation that replaces nothing must not leave an empty
   * batch behind for the sweeper to keep forever.
   */
  private trashOpener(sessionId: string): () => Promise<string> {
    let created: Promise<string> | null = null
    return () => {
      created ??= (async () => {
        const dir = join(
          this.trashRoot,
          `${Date.now()}-${randomUUID().slice(0, 8)}`,
          safeSessionDir(sessionId),
        )
        await mkdir(dir, { recursive: true })
        return dir
      })()
      return created
    }
  }

  /** Keep a copy of a workspace file that is about to be overwritten. */
  private async trashCopy(trashDir: string, rel: string, source: string): Promise<void> {
    const target = join(trashDir, rel)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  private async measureTree(dir: string): Promise<number> {
    let total = 0
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        total += await this.measureTree(child)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(child).catch(() => null)
      if (info) total += info.size
    }
    return total
  }

  /**
   * Trim the trash on its own budget. Reverted files must outlive checkpoint
   * eviction, but not forever: the newest batch is always kept.
   */
  private async sweepTrash(): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(this.trashRoot, { withFileTypes: true })
    } catch {
      return
    }
    const batches = entries
      .filter((entry) => entry.isDirectory() && /^\d{13}(-[0-9a-f]{8})?$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left))
    const cutoff = Date.now() - TRASH_MAX_AGE_MS
    let kept = 0
    for (let index = 0; index < batches.length; index += 1) {
      const name = batches[index] as string
      const dir = join(this.trashRoot, name)
      const bytes = await this.measureTree(dir)
      // `index === 0` is the newest batch and is never dropped.
      const expired = Number(name.slice(0, 13)) < cutoff
      const overBudget = index > 0 && kept + bytes > TRASH_MAX_BYTES
      if (index > 0 && (expired || overBudget)) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      kept += bytes
    }
  }

  /**
   * Last snapshot written per session. Lets a repeated shell command reuse a
   * byte-identical snapshot without scanning the session directory.
   */
  private readonly recentShellSnapshot = new Map<string, CheckpointMeta>()

  private async isFirstSnapshot(sessionId: string): Promise<boolean> {
    try {
      const entries = await readdir(this.sessionRoot(sessionId))
      return entries.length === 0
    } catch {
      return true
    }
  }

  /** Flag an existing snapshot as the session baseline (legacy sessions). */
  private async markBaseline(sessionId: string, checkpointId: string): Promise<void> {
    const meta = await this.readMeta(sessionId, checkpointId)
    if (!meta || meta.baseline) return
    await writeFile(
      join(this.checkpointRoot(sessionId, checkpointId), META_FILE),
      JSON.stringify({ ...meta, baseline: true }),
      { encoding: 'utf8', mode: 0o600 },
    ).catch(() => undefined)
  }

  private sessionRoot(sessionId: string): string {
    return join(this.root, safeSessionDir(sessionId))
  }

  private checkpointRoot(sessionId: string, checkpointId: string): string {
    return join(this.sessionRoot(sessionId), safeCheckpointDir(checkpointId))
  }

  private get blobsRoot(): string {
    return join(this.root, BLOBS_DIR)
  }

  private blobPath(sha256: string): string {
    if (!isSha256(sha256)) throw new Error('Invalid checkpoint blob hash')
    return join(this.blobsRoot, sha256.slice(0, 2), sha256)
  }

  private get maintenanceStateFile(): string {
    return join(this.root, MAINTENANCE_STATE_FILE)
  }

  /**
   * Load the persisted byte estimate once. Concurrent callers share the same
   * promise: a `mapLimit` blob-copy batch must not observe a half-loaded state.
   */
  private loadMaintenanceState(): Promise<MaintenanceState | null> {
    this.maintenanceStatePromise ??= this.readMaintenanceState()
    return this.maintenanceStatePromise
  }

  private async readMaintenanceState(): Promise<MaintenanceState | null> {
    try {
      const parsed = JSON.parse(
        await readFile(this.maintenanceStateFile, 'utf8'),
      ) as Partial<MaintenanceState>
      if (
        parsed.version !== MAINTENANCE_STATE_VERSION ||
        !isNonNegativeFinite(parsed.blobBytes) ||
        !isNonNegativeFinite(parsed.legacyBytes) ||
        !isNonNegativeFinite(parsed.lastMaintenanceAt) ||
        !isNonNegativeFinite(parsed.lastAuditAt)
      ) {
        return null
      }
      this.maintenanceState = {
        version: MAINTENANCE_STATE_VERSION,
        blobBytes: parsed.blobBytes,
        legacyBytes: parsed.legacyBytes,
        lastMaintenanceAt: parsed.lastMaintenanceAt,
        lastAuditAt: parsed.lastAuditAt,
        // State written before the trash timer existed gets one immediate sweep.
        lastTrashSweepAt: isNonNegativeFinite(parsed.lastTrashSweepAt)
          ? parsed.lastTrashSweepAt
          : 0,
      }
      return this.maintenanceState
    } catch {
      // Missing or corrupt state means "scan once, then start tracking".
      return null
    }
  }

  private async saveMaintenanceState(): Promise<void> {
    if (!this.maintenanceState) return
    const path = this.maintenanceStateFile
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(this.root, { recursive: true })
      await writeFile(temp, JSON.stringify(this.maintenanceState), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await moveFile(temp, path)
      this.maintenanceStateDirty = false
    } catch {
      // Losing the estimate only costs one extra scan on a later launch.
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  /** Account for a newly written blob without walking the store. */
  private async noteBlobCreated(sha256: string, size: number): Promise<void> {
    const state = await this.loadMaintenanceState()
    if (!state || this.countedBlobs.has(sha256)) return
    this.countedBlobs.add(sha256)
    state.blobBytes = Math.max(0, state.blobBytes + Math.max(0, size))
    this.maintenanceStateDirty = true
  }

  private indexFile(workspacePath: string): string {
    return join(this.root, INDEX_DIR, `${workspaceIndexKey(workspacePath)}.json`)
  }

  private stateFor(workspacePath: string): WorkspaceState {
    const key = comparePath(resolve(workspacePath))
    let state = this.workspaces.get(key)
    if (!state) {
      state = {
        index: new Map(),
        loaded: false,
        dirty: new Set(),
        watcher: null,
        watchHealthy: this.watchEnabled,
        snapshottable: 0,
        lastScanMs: 0,
        // Force a full scan after an app restart: files changed while Pilot was
        // closed produced no watcher events, so the cached index cannot be
        // trusted until one walk has refreshed it.
        lastFullScanAt: 0,
        snapshotsSinceFullScan: 0,
        ignore: [],
        watchAttempts: 0,
        watchRetryAt: 0,
        watchWindowStart: 0,
        watchAttachedAt: 0,
        lastIncomplete: false,
        autoIgnore: [],
      }
      this.workspaces.set(key, state)
    }
    return state
  }

  private async loadIndexIfNeeded(
    workspacePath: string,
    state: WorkspaceState,
    indexDirty: { value: boolean },
  ): Promise<void> {
    if (state.loaded) return
    state.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.indexFile(workspacePath), 'utf8')) as {
        version?: unknown
        files?: Record<string, { size?: unknown; mtimeMs?: unknown; sha256?: unknown }>
        autoIgnore?: unknown
      }
      if (parsed.version !== INDEX_VERSION) return
      // Directories a tool excluded survive a restart with the index that knows
      // about them, so the tree does not rejoin a walk after an app upgrade.
      // Anything registered before the index was read stays: a write can land
      // in the same run before the first snapshot loads the index.
      state.autoIgnore = normalizeCheckpointIgnore([...state.autoIgnore, ...(Array.isArray(parsed.autoIgnore) ? parsed.autoIgnore : [])])
      if (!parsed.files) {
        indexDirty.value = true
        return
      }
      for (const [rel, entry] of Object.entries(parsed.files)) {
        if (!entry || typeof entry !== 'object') continue
        if (
          typeof entry.size !== 'number' ||
          !Number.isFinite(entry.size) ||
          entry.size < 0 ||
          typeof entry.mtimeMs !== 'number' ||
          !Number.isFinite(entry.mtimeMs) ||
          !isSha256(entry.sha256) ||
          !safeRelative(rel)
        ) {
          continue
        }
        state.index.set(normalizeRel(rel), {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          sha256: entry.sha256,
        })
      }
    } catch {
      // No index yet (or it was truncated): the first snapshot walks the tree.
      indexDirty.value = true
    }
  }

  private async saveIndex(workspacePath: string, state: WorkspaceState): Promise<void> {
    const files: Record<string, IndexEntry> = {}
    for (const [rel, entry] of state.index) files[rel] = entry
    const path = this.indexFile(workspacePath)
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(
        temp,
        JSON.stringify({ version: INDEX_VERSION, files, autoIgnore: state.autoIgnore }),
        {
          encoding: 'utf8',
          mode: 0o600,
        },
      )
      await moveFile(temp, path)
    } catch {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Attach the recursive watcher, or retry it when an earlier attempt died.
   *
   * A dead watcher used to be final for the session: every later snapshot fell
   * back to a full walk. On a repository with a generated tree that is the
   * difference between ~140 ms and ~4.6 s per snapshot, so it is worth a bounded
   * retry schedule. Retries stay inside a one-hour window and a fixed budget;
   * once either is spent the workspace stays on the full-walk path.
   */
  private ensureWatcher(workspacePath: string, state: WorkspaceState): void {
    if (!this.watchEnabled || state.watcher) return
    if (!state.watchHealthy) {
      const now = Date.now()
      if (state.watchWindowStart === 0) state.watchWindowStart = now
      if (now - state.watchWindowStart > WATCH_RETRY_WINDOW_MS) return
      if (state.watchAttempts >= WATCH_RETRY_BUDGET) return
      if (now < state.watchRetryAt) return
      state.watchAttempts += 1
      state.watchRetryAt =
        now + Math.min(WATCH_RETRY_BASE_MS * 2 ** (state.watchAttempts - 1), WATCH_RETRY_MAX_DELAY_MS)
    }
    let watcher: FSWatcher | null = null
    // Every failure path has to release the handle and forget the dirty set:
    // once the watcher reported an error or dropped events, the collected paths
    // are incomplete, and a leaked handle keeps firing into a dead state.
    const fail = (): void => {
      const now = Date.now()
      // A watcher that ran long enough to be trusted starts a fresh incident;
      // a flap keeps the retry budget it already burned.
      if (state.watchAttachedAt > 0 && now - state.watchAttachedAt >= WATCH_HEALTHY_MS) {
        state.watchAttempts = 0
        state.watchWindowStart = now
        state.watchRetryAt = 0
      }
      state.watchAttachedAt = 0
      state.watchHealthy = false
      state.dirty.clear()
      if (state.watcher === watcher) state.watcher = null
      try {
        watcher?.close()
      } catch {
        // Already closed.
      }
    }
    try {
      watcher = watch(workspacePath, { recursive: true }, (_event, filename) => {
        if (!filename) {
          // A null filename means the platform could not attribute the change.
          fail()
          return
        }
        const rel = normalizeRel(String(filename))
        if (isIgnoredPath(rel, state.ignore)) return
        state.dirty.add(rel)
        if (state.dirty.size > WATCH_DIRTY_LIMIT) fail()
      })
      watcher.on('error', fail)
      state.watcher = watcher
      state.watchHealthy = true
      state.watchAttachedAt = Date.now()
      // `watchRetryAt` deliberately stays where the attempt gate put it: if this
      // watcher dies immediately, the next attempt still has to wait.
    } catch {
      // Recursive watching is unavailable on some platforms/filesystems. A
      // full walk remains correct, just slower; the retry budget stops us from
      // re-attempting it on every snapshot.
      fail()
    }
  }

  private async statRelative(
    workspacePath: string,
    rel: string,
    ignore?: readonly string[],
  ): Promise<{ rel: string; size: number; mtimeMs: number } | null> {
    if (!safeRelative(rel) || isIgnoredPath(rel, ignore)) return null
    const absolute = join(workspacePath, rel)
    const info = await stat(absolute).catch(() => null)
    if (!info || !info.isFile()) return null
    return { rel, size: info.size, mtimeMs: info.mtimeMs }
  }

  /**
   * Walk the workspace with bounded concurrency. The old sequential walk spent
   * ~5s on a 16k-file repository just in `stat` calls on Windows.
   */
  private async collectWorkspaceFiles(
    workspacePath: string,
    ignore: readonly string[] = [],
  ): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const directories: string[] = ['']
    const files: Array<{ rel: string; absolute: string }> = []
    const checkpointRootKey = comparePath(resolve(this.root))
    while (directories.length > 0) {
      const batch = directories.splice(0, DIR_CONCURRENCY)
      const listings = await Promise.all(
        batch.map(async (relativeDir) => {
          const absolute = relativeDir ? join(workspacePath, relativeDir) : workspacePath
          const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null)
          return { relativeDir, entries }
        }),
      )
      for (const listing of listings) {
        if (!listing.entries) continue
        for (const entry of listing.entries) {
          if (entry.isSymbolicLink()) continue
          const rel = normalizeRel(
            listing.relativeDir ? join(listing.relativeDir, entry.name) : entry.name,
          )
          if (entry.isDirectory()) {
            if (isIgnoredPath(rel, ignore)) continue
            // Don't recursively snapshot our own checkpoint store when the
            // selected workspace happens to contain Electron's userData.
            if (comparePath(resolve(workspacePath, rel)) === checkpointRootKey) continue
            directories.push(rel)
            continue
          }
          if (!entry.isFile() || entry.name === '.DS_Store') continue
          if (isIgnoredPath(rel, ignore)) continue
          // Media/binaries stay in the walk so `create()` can report them as
          // intentionally skipped; they are never hashed or stored.
          files.push({ rel, absolute: join(workspacePath, rel) })
        }
      }
    }

    const stats = await mapLimit(files, STAT_CONCURRENCY, async (file) => {
      const info = await stat(file.absolute).catch(() => null)
      if (!info || !info.isFile()) return null
      return { rel: file.rel, size: info.size, mtimeMs: info.mtimeMs }
    })
    const result = new Map<string, { size: number; mtimeMs: number }>()
    for (const info of stats) {
      if (info) result.set(info.rel, { size: info.size, mtimeMs: info.mtimeMs })
    }
    return result
  }

  /** Which of these hashes still have a blob on disk. */
  private async existingBlobs(hashes: Iterable<string>): Promise<Set<string>> {
    const unique = [...new Set(hashes)]
    const present = await mapLimit(unique, BLOB_CHECK_CONCURRENCY, async (sha256) => {
      const info = await stat(this.blobPath(sha256)).catch(() => null)
      return info?.isFile() ? sha256 : null
    })
    return new Set(present.filter((value): value is string => Boolean(value)))
  }

  /**
   * Load and validate `meta.json`. Distinguishes "not written yet" (a crash
   * during create) from "present but unusable" so maintenance can clean up the
   * former without ever deleting data it does not understand.
   */
  private async loadMeta(sessionId: string, checkpointId: string): Promise<MetaState> {
    let raw: string
    try {
      raw = await readFile(join(this.checkpointRoot(sessionId, checkpointId), META_FILE), 'utf8')
    } catch {
      return { state: 'missing' }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CheckpointMeta> & { version?: unknown }
      if (
        (parsed.version !== 1 && parsed.version !== 2) ||
        parsed.sessionId !== sessionId ||
        typeof parsed.id !== 'string' ||
        typeof parsed.workspacePath !== 'string'
      ) {
        return { state: 'invalid' }
      }
      return { state: 'ok', meta: parsed as CheckpointMeta }
    } catch {
      return { state: 'invalid' }
    }
  }

  private async readMeta(sessionId: string, checkpointId: string): Promise<CheckpointMeta | null> {
    const loaded = await this.loadMeta(sessionId, checkpointId)
    return loaded.state === 'ok' ? loaded.meta : null
  }

  /** `null` means the manifest exists but is unreadable/unsafe to act on. */
  private async loadManifest(dir: string): Promise<ManifestEntry[] | null> {
    try {
      const parsed = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')) as unknown
      if (!Array.isArray(parsed)) return null
      const out: ManifestEntry[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        if (
          typeof record['path'] !== 'string' ||
          typeof record['size'] !== 'number' ||
          !Number.isFinite(record['size']) ||
          record['size'] < 0 ||
          !isSha256(record['sha256'])
        ) {
          return null
        }
        out.push({ path: record['path'], size: record['size'], sha256: record['sha256'] })
      }
      return out
    } catch {
      return null
    }
  }

  private async manifestOrThrow(dir: string): Promise<ManifestEntry[]> {
    const manifest = await this.loadManifest(dir)
    if (!manifest) throw new Error('Checkpoint manifest is unreadable')
    return manifest
  }

  /** Resolve a manifest entry to its backing file (blob or version-1 copy). */
  private entrySource(version: number, dir: string, entry: ManifestEntry): string {
    if (version >= 2) return this.blobPath(entry.sha256)
    return join(dir, 'files', normalizeRel(entry.path))
  }

  /** Verify a snapshot file is present and intact before reading or copying it. */
  private async verifyEntry(
    version: number,
    dir: string,
    entry: ManifestEntry,
  ): Promise<string> {
    const rel = normalizeRel(entry.path)
    const source = this.entrySource(version, dir, entry)
    const info = await stat(source).catch(() => null)
    if (!info || info.size !== entry.size) {
      throw new Error(`Checkpoint file is missing or damaged: ${rel}`)
    }
    // Verify content on every access, including blobs: a restore must never
    // write data that no longer matches the snapshot's manifest.
    if ((await hashFile(source)) !== entry.sha256) {
      throw new Error(`Checkpoint file failed integrity check: ${rel}`)
    }
    return source
  }

  async list(sessionId: string): Promise<Checkpoint[]> {
    let entries
    try {
      entries = await readdir(this.sessionRoot(sessionId), { withFileTypes: true })
    } catch {
      return []
    }
    const result: Checkpoint[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = await this.readMeta(sessionId, entry.name)
      if (meta) result.push(meta)
    }
    return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * Baseline snapshot for change review: the session's first snapshot, which is
   * pinned so neither retention nor the global budget evicts it. Sessions
   * created before baselines were pinned fall back to the oldest retained
   * snapshot (and are healed on the next prune).
   */
  async oldest(sessionId: string): Promise<Checkpoint | null> {
    const list = await this.list(sessionId)
    const pinned = list.find((checkpoint) => checkpoint.baseline)
    return pinned ?? list[list.length - 1] ?? null
  }

  /**
   * Read one file from a snapshot without restoring anything. Returns
   * `found: false` when the snapshot does not contain the path; a binary file
   * yields `content: null`.
   */
  async readBaselineFile(
    sessionId: string,
    checkpointId: string,
    relPath: string,
  ): Promise<{ found: boolean; content: string | null }> {
    if (!safeRelative(relPath)) throw new Error('Invalid file path')
    const meta = await this.readMeta(sessionId, checkpointId)
    if (!meta) throw new Error('Checkpoint not found')
    const dir = this.checkpointRoot(sessionId, checkpointId)
    const manifest = await this.manifestOrThrow(dir)
    const rel = normalizeRel(relPath)
    const entry = manifest.find((item) => comparePath(item.path) === comparePath(rel))
    if (!entry) return { found: false, content: null }
    const source = await this.verifyEntry(meta.version, dir, entry)
    const buffer = await readFile(source)
    if (buffer.subarray(0, Math.min(buffer.length, 8_000)).includes(0)) {
      return { found: true, content: null }
    }
    return { found: true, content: buffer.toString('utf8') }
  }

  /**
   * Restore or remove specific files from a snapshot. Files that were created
   * after the snapshot are moved into that checkpoint's trash folder instead
   * of being deleted, so a mistaken revert remains recoverable on disk.
   */
  async revertPaths(
    sessionId: string,
    checkpointId: string,
    paths: string[],
  ): Promise<{ restored: number; removed: number }> {
    return this.exclusive(async () => {
      this.recentShellSnapshot.delete(sessionId)
      const meta = await this.readMeta(sessionId, checkpointId)
      if (!meta) throw new Error('Checkpoint not found')
      const session = this.store.session(sessionId)
      if (!session) throw new Error('Session not found')
      const checkpointWorkspace = await realpath(meta.workspacePath).catch(() => null)
      const currentWorkspace = await realpath(session.workspacePath).catch(() => null)
      if (
        !checkpointWorkspace ||
        !currentWorkspace ||
        comparePath(checkpointWorkspace) !== comparePath(currentWorkspace)
      ) {
        throw new Error('Checkpoint belongs to a different workspace')
      }

      const dir = this.checkpointRoot(sessionId, checkpointId)
      const manifest = await this.manifestOrThrow(dir)
      const byPath = new Map(manifest.map((entry) => [comparePath(entry.path), entry]))
      const requested = new Map<string, { rel: string; target: string }>()
      for (const raw of paths) {
        if (!safeRelative(raw)) throw new Error(`Invalid file path: ${raw}`)
        const rel = normalizeRel(raw)
        const target = await resolveForWrite(session.workspacePath, rel)
        const within = relative(session.workspacePath, target)
        if (within.startsWith('..') || isAbsolute(within)) {
          throw new Error(`Path escapes the workspace: ${rel}`)
        }
        requested.set(comparePath(rel), { rel, target })
      }

      // Verify every snapshot file before touching the workspace.
      const verified: Array<{ rel: string; source: string; target: string }> = []
      const deletions: Array<{ rel: string; target: string }> = []
      for (const [key, item] of requested) {
        const entry = byPath.get(key)
        const { rel, target } = item
        if (entry) {
          const source = await this.verifyEntry(meta.version, dir, entry)
          verified.push({ rel, source, target })
        } else {
          if (!meta.complete) {
            throw new Error(`回退点不完整，无法安全删除 ${rel}`)
          }
          if (hasSkippedExtension(rel)) {
            throw new Error(`回退点未包含 ${rel}（媒体或二进制文件），无法安全删除`)
          }
          const info = await stat(target).catch(() => null)
          if (info && info.size > MAX_FILE_BYTES) {
            throw new Error(`回退点未包含 ${rel}（文件超过单文件上限），无法安全删除`)
          }
          deletions.push({ rel, target })
        }
      }

      let restored = 0
      // One trash batch per call, outside the snapshot tree.
      const openTrash = this.trashOpener(sessionId)
      for (const item of verified) {
        const info = await lstat(item.target).catch(() => null)
        if (info?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${item.rel}`)
        await mkdir(dirname(item.target), { recursive: true })
        // Keep the content being replaced: a per-file revert has no safety
        // snapshot, so this trash copy is the only way back.
        if (info?.isFile()) await this.trashCopy(await openTrash(), item.rel, item.target)
        await copyFile(item.source, item.target)
        restored += 1
      }

      let removed = 0
      for (const item of deletions) {
        const info = await lstat(item.target).catch(() => null)
        if (!info) continue
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error(`Refusing to remove a non-regular file: ${item.rel}`)
        }
        await moveFile(item.target, join(await openTrash(), item.rel))
        removed += 1
      }
      return { restored, removed }
    }, this.workspaceLockKey(sessionId))
  }

  /** Lock key for a session's workspace; store-wide work uses `undefined`. */
  private workspaceLockKey(sessionId: string): string {
    const session = this.store.session(sessionId)
    return session ? comparePath(resolve(session.workspacePath)) : `session:${sessionId}`
  }

  private async prune(
    sessionId: string,
    retention: number,
    protectIds: readonly string[] = [],
  ): Promise<void> {
    const list = await this.list(sessionId)
    // Keep the newest run-start snapshot even when a long run writes more
    // shell snapshots than the retention window: it is the only rollback
    // point that covers everything the run changed.
    const runStart = list.find((checkpoint) => checkpoint.trigger === 'prompt')
    const pinned = new Set<string>(protectIds)
    if (runStart) pinned.add(runStart.id)
    // The baseline is what review and per-file revert compare against, so it is
    // pinned too. Sessions whose snapshots predate the flag are healed here: the
    // oldest survivor becomes the baseline and stops sliding from now on.
    const baseline = list.find((checkpoint) => checkpoint.baseline)
    if (baseline) {
      pinned.add(baseline.id)
    } else {
      const oldest = list[list.length - 1]
      if (oldest) {
        pinned.add(oldest.id)
        await this.markBaseline(sessionId, oldest.id)
      }
    }
    const removable = list.slice(Math.max(0, retention)).filter((c) => !pinned.has(c.id))
    for (const checkpoint of removable) {
      await rm(this.checkpointRoot(sessionId, checkpoint.id), {
        recursive: true,
        force: true,
      }).catch(() => undefined)
    }
  }

  /** Copy a workspace file into the blob store, reusing identical content. */
  private async storeBlob(source: string): Promise<{ sha256: string; size: number }> {
    const sha256 = await hashFile(source)
    const target = this.blobPath(sha256)
    const existing = await stat(target).catch(() => null)
    if (existing?.isFile()) return { sha256, size: existing.size }
    const temp = join(this.blobsRoot, BLOB_TEMP_DIR, randomUUID())
    await mkdir(dirname(temp), { recursive: true })
    try {
      await copyFile(source, temp, constants.COPYFILE_FICLONE)
      const copied = await stat(temp)
      // The source can change between hashing and copying. Storing content
      // under a hash it no longer matches would poison the dedup store.
      if ((await hashFile(temp)) !== sha256) {
        throw new Error('Checkpoint file changed while copying')
      }
      await moveFile(temp, target)
      await this.noteBlobCreated(sha256, copied.size)
      return { sha256, size: copied.size }
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async create(input: {
    sessionId: string
    workspacePath: string
    label: string
    messageCount: number
    trigger: CheckpointTrigger
    retention: number
    maxBytes?: number
    /**
     * Snapshot-only ignore patterns for this workspace (Settings → 回退点).
     * They narrow what a snapshot captures; `SKIP_DIRS` stays untouched so the
     * file tree still shows and edits these paths.
     */
    ignore?: readonly string[]
    /**
     * Checkpoints that must survive the eviction this snapshot triggers. A
     * restore passes its own target so the protection step cannot delete the
     * snapshot that is about to be applied.
     */
    protectIds?: readonly string[]
  }): Promise<Checkpoint> {
    const maxBytes = clampGlobalBytes(input.maxBytes)
    let reusedSnapshot: Checkpoint | null = null
    const meta = await this.exclusive(async () => {
      const state = this.stateFor(input.workspacePath)
      const indexDirty = { value: false }
      // Directories the tools excluded at creation time travel with the settings
      // list, so one comparison covers both and a change forces one full walk.
      const ignore = normalizeCheckpointIgnore([...(input.ignore ?? []), ...state.autoIgnore])
      let ignoreChanged = false
      if (state.ignore.join('\n') !== ignore.join('\n')) {
        state.ignore = ignore
        // A narrower ignore list leaves stale entries behind; a full walk is
        // the cheapest way to drop them, and it happens exactly once per edit.
        state.lastFullScanAt = 0
        state.dirty.clear()
        ignoreChanged = true
      }
      await this.loadIndexIfNeeded(input.workspacePath, state, indexDirty)
      this.ensureWatcher(input.workspacePath, state)

      // Nothing changed since this session's last snapshot: the watcher reported
      // no event, the ignore list is the one that walk used, and the cached
      // index is trusted. Rolling back to that tree restores exactly the same
      // bytes, so relabel it instead of walking and hashing the workspace again.
      // `beforeShell` fires before every command, and this is what keeps the
      // hundredth command of a long run as cheap as the first.
      if (
        input.trigger === 'shell' &&
        state.watchHealthy &&
        !ignoreChanged &&
        !indexDirty.value &&
        state.dirty.size === 0
      ) {
        // A tool's write completes before this snapshot but its watcher event is
        // delivered on the event loop. One turn lets a pending event land, so the
        // reuse decision is never made against an event still in flight.
        await yieldEventLoop()
        const previous = this.recentShellSnapshot.get(input.sessionId)
        const previousMeta = previous
          ? join(this.checkpointRoot(input.sessionId, previous.id), META_FILE)
          : null
        if (
          previous &&
          previousMeta &&
          state.dirty.size === 0 &&
          Date.now() - Date.parse(previous.createdAt) < CHECKPOINT_SHELL_REUSE_MS &&
          (await stat(previousMeta).catch(() => null))
        ) {
          // Keep `createdAt`: the reuse window stays bounded by the tree the user
          // could actually roll back to, not by the last command that ran.
          const refreshed: CheckpointMeta = {
            ...previous,
            label: checkpointLabel(input.label),
            messageCount: Math.max(0, Math.round(input.messageCount)),
          }
          if (
            refreshed.label !== previous.label ||
            refreshed.messageCount !== previous.messageCount
          ) {
            await writeFile(previousMeta, JSON.stringify(refreshed), {
              encoding: 'utf8',
              mode: 0o600,
            }).catch(() => undefined)
          }
          this.recentShellSnapshot.set(input.sessionId, refreshed)
          reusedSnapshot = refreshed
          return refreshed
        }
      }

      // The fast path exists to avoid a walk that costs seconds. That is a
      // question about the size of the snapshot, not the size of the workspace:
      // 19k files of build output and 600 files of source cost very different
      // walks, and a workspace that is mostly ignored is small whatever its
      // raw file count says. `lastScanMs` catches the case the threshold guesses
      // wrong.
      const fastEligible =
        state.loaded &&
        state.watchHealthy &&
        (state.snapshottable >= this.fastPathMinFiles || state.lastScanMs >= FULL_SCAN_COST_MS) &&
        state.snapshotsSinceFullScan < FULL_SCAN_EVERY &&
        Date.now() - state.lastFullScanAt < FULL_SCAN_MAX_AGE_MS
      const fullScan = !fastEligible

      // `stats` holds the files inspected this round. On a full scan it is the
      // whole workspace; on the fast path it is only the paths the watcher
      // reported since the last snapshot.
      const stats = new Map<string, { size: number; mtimeMs: number }>()
      if (fullScan) {
        const walkStartedAt = Date.now()
        const walked = await this.collectWorkspaceFiles(input.workspacePath, ignore)
        state.lastScanMs = Date.now() - walkStartedAt
        for (const [rel, info] of walked) stats.set(rel, info)
        for (const rel of [...state.index.keys()]) {
          if (!stats.has(rel)) {
            state.index.delete(rel)
            indexDirty.value = true
          }
        }
        state.snapshottable = stats.size
        state.snapshotsSinceFullScan = 0
        state.lastFullScanAt = Date.now()
      } else {
        state.snapshotsSinceFullScan += 1
        const dirty = [...state.dirty]
        state.dirty.clear()
        const changes = await mapLimit(dirty, STAT_CONCURRENCY, (rel) =>
          this.statRelative(input.workspacePath, rel, ignore),
        )
        for (const change of changes) {
          if (change) stats.set(change.rel, { size: change.size, mtimeMs: change.mtimeMs })
        }
        const seen = new Set(changes.filter(Boolean).map((change) => change!.rel))
        for (const rel of dirty) {
          if (seen.has(rel)) continue
          if (state.index.delete(rel)) indexDirty.value = true
        }
      }

      // An entry outside the current ignore list can only come from an older
      // configuration; drop it instead of describing a file we would not walk.
      if (ignore.length > 0) {
        for (const rel of [...state.index.keys()]) {
          if (!isIgnoredPath(rel, ignore)) continue
          state.index.delete(rel)
          indexDirty.value = true
        }
      }

      const candidates = new Set<string>(state.index.keys())
      for (const rel of stats.keys()) candidates.add(rel)
      const ordered = [...candidates].sort((left, right) => left.localeCompare(right))

      // A blob can disappear when maintenance evicts snapshots, so reuse is
      // only valid while the content-addressed file is still on disk.
      const present = await this.existingBlobs(
        [...state.index.values()].map((entry) => entry.sha256),
      )

      const manifest: ManifestEntry[] = []
      const toHash: Array<{ rel: string; size: number; mtimeMs: number }> = []
      let reservedBytes = 0
      let skipped = 0
      let capHit = false
      let errors = 0
      let hashed = 0
      let reused = 0

      for (const rel of ordered) {
        const info = stats.get(rel) ?? state.index.get(rel)
        if (!info) {
          if (state.index.delete(rel)) indexDirty.value = true
          continue
        }
        if (hasSkippedExtension(rel) || info.size > MAX_FILE_BYTES) {
          if (state.index.delete(rel)) indexDirty.value = true
          skipped += 1
          continue
        }
        if (reservedBytes + info.size > MAX_TOTAL_BYTES) {
          if (state.index.delete(rel)) indexDirty.value = true
          skipped += 1
          capHit = true
          continue
        }
        const known = state.index.get(rel)
        if (
          known &&
          known.size === info.size &&
          known.mtimeMs === info.mtimeMs &&
          present.has(known.sha256)
        ) {
          manifest.push({ path: rel, size: info.size, sha256: known.sha256 })
          reservedBytes += info.size
          reused += 1
          continue
        }
        toHash.push({ rel, size: info.size, mtimeMs: info.mtimeMs })
        reservedBytes += info.size
      }

      const hashedEntries = await mapLimit(toHash, HASH_CONCURRENCY, async (item) => {
        const source = join(input.workspacePath, item.rel)
        try {
          const stored = await this.storeBlob(source)
          const fresh = await stat(source).catch(() => null)
          return {
            rel: item.rel,
            entry: {
              size: fresh?.size ?? stored.size,
              mtimeMs: fresh?.mtimeMs ?? item.mtimeMs,
              sha256: stored.sha256,
            } satisfies IndexEntry,
          }
        } catch {
          return null
        }
      })

      for (let index = 0; index < hashedEntries.length; index += 1) {
        const result = hashedEntries[index]
        const item = toHash[index]
        if (!item) continue
        if (!result) {
          skipped += 1
          errors += 1
          reservedBytes -= item.size
          continue
        }
        state.index.set(result.rel, result.entry)
        manifest.push({ path: result.rel, size: result.entry.size, sha256: result.entry.sha256 })
        reservedBytes += result.entry.size - item.size
        hashed += 1
        indexDirty.value = true
      }

      manifest.sort((left, right) => left.path.localeCompare(right.path))
      const bytes = manifest.reduce((total, entry) => total + entry.size, 0)
      const complete = !capHit && errors === 0 && !(fullScan ? false : state.lastIncomplete)
      if (fullScan) state.lastIncomplete = !complete
      // A shell-triggered snapshot fires before every command; a model that
      // re-runs the same command (or a bare retry of it) would otherwise write
      // byte-identical directories. Reuse the previous snapshot only when the
      // label and the tree both match exactly and it is still fresh: rolling
      // back to it restores precisely the same bytes.
      const label = checkpointLabel(input.label)
      const manifestDigest = createHash('sha256')
        .update(manifest.map((entry) => `${entry.path}\u0000${entry.sha256}`).join('\n'))
        .digest('hex')
      if (input.trigger === 'shell') {
        // The candidate is the last snapshot this process wrote, not a directory
        // scan: a shell snapshot must stay cheap, and after a restart the cache
        // is simply empty (reuse is an optimisation, not a correctness rule).
        const previous = this.recentShellSnapshot.get(input.sessionId)
        if (
          previous &&
          previous.label === label &&
          previous.manifestDigest === manifestDigest &&
          Date.now() - Date.parse(previous.createdAt) < CHECKPOINT_SHELL_REUSE_MS &&
          // Retention may have evicted it since; never hand back a dead id.
          (await stat(join(this.checkpointRoot(input.sessionId, previous.id), META_FILE)).catch(
            () => null,
          ))
        ) {
          if (indexDirty.value) {
            await this.saveIndex(input.workspacePath, state).catch(() => undefined)
          }
          reusedSnapshot = previous
          return previous
        }
      }
      // The first snapshot of a session is its baseline. Change review and the
      // per-file revert compare against it, so it must stay pinned: "the oldest
      // still retained" slides forward every time retention evicts a snapshot
      // and would silently change what "before the run" means.
      const baseline = await this.isFirstSnapshot(input.sessionId)
      const id = randomUUID()
      const dir = this.checkpointRoot(input.sessionId, id)
      await mkdir(dir, { recursive: true })
      const meta: CheckpointMeta = {
        version: 2,
        id,
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        label: label,
        createdAt: now(),
        messageCount: Math.max(0, Math.round(input.messageCount)),
        files: manifest.length,
        bytes,
        trigger: input.trigger,
        complete,
        skipped,
        hashed,
        reused,
        manifestDigest,
        ...(baseline ? { baseline: true } : {}),
      }
      // Manifest first: a crash in between leaves a directory without meta,
      // which maintenance treats as abandoned.
      await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(manifest), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await writeFile(join(dir, META_FILE), JSON.stringify(meta), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await this.prune(
        input.sessionId,
        Math.max(MIN_RETENTION, input.retention),
        input.protectIds ?? [],
      )
      if (indexDirty.value) {
        await this.saveIndex(input.workspacePath, state).catch(() => undefined)
      }
      this.recentShellSnapshot.set(input.sessionId, meta)
      return meta
    }, comparePath(resolve(input.workspacePath)))

    // Persist the incremental byte count even when the maintenance gate below
    // decides no scan is needed (the common case). Otherwise a crash would lose
    // the bytes written by this snapshot.
    if (this.maintenanceStateDirty) await this.saveMaintenanceState()

    // Keep the store bounded without paying a full scan on every snapshot.
    // A pre-restore safety snapshot is different: the restore is waiting on it
    // and a full scan there would only delay the operation it protects.
    // A reused snapshot did not grow the store, so it needs no sweep either.
    if (input.trigger !== 'prerestore' && !reusedSnapshot) {
      await this.maintain({ maxBytes }).catch(() => undefined)
    }
    return meta
  }

  async restore(
    sessionId: string,
    checkpointId: string,
    mode: CheckpointRestoreMode,
  ): Promise<CheckpointRestoreResult> {
    return this.exclusive(async () => {
      // The restore rewrites the tree, so a snapshot cached a moment ago no
      // longer describes what is on disk.
      this.recentShellSnapshot.delete(sessionId)
      const meta = await this.readMeta(sessionId, checkpointId)
      if (!meta) throw new Error('Checkpoint not found')
      const session = this.store.session(sessionId)
      if (!session) throw new Error('Session not found')
      if (mode !== 'code' && mode !== 'conversation' && mode !== 'both') {
        throw new Error('Invalid restore mode')
      }
      if ((mode === 'code' || mode === 'both') && !meta.complete) {
        throw new Error('Incomplete checkpoint cannot restore files safely')
      }

      let restoredFiles = 0
      let removedFiles = 0
      let safety: Checkpoint | null = null
      if (mode === 'code' || mode === 'both') {
        const checkpointWorkspace = await realpath(meta.workspacePath).catch(() => null)
        const currentWorkspace = await realpath(session.workspacePath).catch(() => null)
        if (
          !checkpointWorkspace ||
          !currentWorkspace ||
          comparePath(checkpointWorkspace) !== comparePath(currentWorkspace)
        ) {
          throw new Error('Checkpoint belongs to a different workspace')
        }

        const dir = this.checkpointRoot(sessionId, checkpointId)
        const manifest = await this.manifestOrThrow(dir)
        const known = new Set<string>()

        // Verify the whole manifest and every destination path before writing
        // anything, so a damaged snapshot cannot leave a half-restored tree.
        const verified: Array<{ rel: string; source: string; target: string }> = []
        for (const entry of manifest) {
          if (!safeRelative(entry.path)) continue
          const rel = normalizeRel(entry.path)
          const source = await this.verifyEntry(meta.version, dir, entry)
          const target = resolve(session.workspacePath, rel)
          const within = relative(session.workspacePath, target)
          if (within.startsWith('..') || isAbsolute(within)) {
            throw new Error(`Checkpoint path escapes the workspace: ${rel}`)
          }
          verified.push({ rel, source, target })
        }

        // A restore overwrites and deletes user files, so it has to be undoable.
        // Snapshot the current workspace first; the target checkpoint is pinned
        // so this new snapshot's eviction pass cannot delete what we are about
        // to apply. If the snapshot cannot be taken, the restore is aborted
        // instead of destroying data with no way back.
        const settings = this.store.settings()
        try {
          safety = await this.create({
            sessionId,
            workspacePath: session.workspacePath,
            label: '回退前自动快照',
            messageCount: session.messages.length,
            trigger: 'prerestore',
            retention: settings.checkpointRetention,
            maxBytes: settings.checkpointMaxBytes,
            ignore: settings.checkpointIgnore,
            protectIds: [checkpointId],
          })
        } catch (error) {
          throw new Error(
            `无法创建回退前快照，已取消回退：${error instanceof Error ? error.message : String(error)}`,
          )
        }

        // The safety snapshot normally covers every file being overwritten. If
        // it came back incomplete (budget cap or unreadable file) it may miss
        // some of them, so fall back to copying each one into the trash.
        const safetyComplete = safety?.complete === true
        const openTrash = this.trashOpener(sessionId)
        for (const item of verified) {
          await mkdir(dirname(item.target), { recursive: true })
          if (!safetyComplete) {
            const current = await lstat(item.target).catch(() => null)
            if (current?.isFile()) await this.trashCopy(await openTrash(), item.rel, item.target)
          }
          await copyFile(item.source, item.target)
          known.add(comparePath(item.rel))
          restoredFiles += 1
        }

        if (meta.complete) {
          const removeExtras = async (relativePath: string): Promise<void> => {
            const absolute = relativePath
              ? join(session.workspacePath, relativePath)
              : session.workspacePath
            let entries
            try {
              entries = await readdir(absolute, { withFileTypes: true })
            } catch {
              return
            }
            for (const entry of entries) {
              if (entry.isSymbolicLink()) continue
              const rel = normalizeRel(
                relativePath ? join(relativePath, entry.name) : entry.name,
              )
              if (entry.isDirectory()) {
                // Directories a snapshot never captured (build output, scratch,
                // checkpoints) are not in the manifest by design. Deleting their
                // files here would destroy data no rollback point could restore.
                if (
                  SKIP_DIRS.has(entry.name) ||
                  isEphemeralDirName(entry.name) ||
                  entry.name === '.pilot-checkpoints'
                ) {
                  continue
                }
                await removeExtras(rel)
                continue
              }
              if (!entry.isFile()) continue
              if (known.has(comparePath(rel))) continue
              // Snapshotting intentionally leaves binary/media files and files
              // over the size limit out of the manifest. They were never
              // captured, so deleting them here would destroy user data that
              // the snapshot could not restore. Apply the same rules as create.
              if (hasSkippedExtension(rel)) continue
              const info = await stat(join(session.workspacePath, rel)).catch(() => null)
              if (!info || info.size > MAX_FILE_BYTES) continue
              await moveFile(join(session.workspacePath, rel), join(await openTrash(), rel))
              removedFiles += 1
            }
          }
          await removeExtras('')
        }
      }

      let truncatedMessages = 0
      if (mode === 'conversation' || mode === 'both') {
        truncatedMessages = await this.store.truncateMessages(sessionId, meta.messageCount)
      }
      const updated = this.store.session(sessionId)
      if (!updated) throw new Error('Session not found after restore')
      return {
        checkpoint: meta,
        session: updated,
        restoredFiles,
        removedFiles,
        truncatedMessages,
        safetyCheckpointId: safety?.id,
      }
    }, this.workspaceLockKey(sessionId))
  }

  async removeSession(sessionId: string): Promise<void> {
    await rm(this.sessionRoot(sessionId), { recursive: true, force: true }).catch(() => undefined)
  }

  /**
   * Sweep unreferenced blobs and enforce the global size budget.
   *
   * The scan is all-or-nothing: if any manifest is present but unreadable, the
   * reference set cannot be trusted and nothing is deleted. Snapshots whose
   * `meta.json` was never written (crash during create) are removed instead.
   *
   * A full scan is expensive on a large store, so it only runs when the
   * persisted estimate says the budget is exceeded, when the weekly audit is
   * due, or when forced. `lastMaintenanceAt` also throttles repeated attempts
   * while a run is writing snapshots.
   */
  async maintain(options: { maxBytes?: number; force?: boolean } = {}): Promise<void> {
    const maxBytes = clampGlobalBytes(options.maxBytes)
    const force = options.force === true
    const startedAt = Date.now()
    await this.exclusive(async () => {
      const state = await this.loadMaintenanceState()
      // Trash has its own budget and is independent from the snapshot store.
      // Sweep it daily even when the blob gate below skips the full scan.
      if (state && startedAt - state.lastTrashSweepAt >= TRASH_SWEEP_INTERVAL_MS) {
        await this.sweepTrash().catch(() => undefined)
        state.lastTrashSweepAt = startedAt
        this.maintenanceStateDirty = true
        await this.saveMaintenanceState()
      }
      const lastRun = Math.max(this.lastMaintenance, state?.lastMaintenanceAt ?? 0)
      if (!force && lastRun > 0 && startedAt - lastRun < MAINTENANCE_INTERVAL_MS) {
        return
      }
      if (!force && state) {
        const usage = state.blobBytes + state.legacyBytes
        const auditDue = startedAt - state.lastAuditAt >= MAINTENANCE_AUDIT_INTERVAL_MS
        if (usage <= maxBytes && !auditDue) return
      }
      this.lastMaintenance = startedAt
      if (!state) await this.sweepTrash().catch(() => undefined)
      const scan = await this.scanAll()
      if (!scan) {
        // Keep the throttle so a corrupt manifest does not force a full scan on
        // every launch; leave the byte estimate untouched until the next audit.
        if (state) {
          state.lastMaintenanceAt = startedAt
          await this.saveMaintenanceState()
        }
        return
      }
      let blobBytes = await this.sweepBlobs(scan.hashes)
      let legacyBytes = scan.legacyBytes
      if (blobBytes + legacyBytes > maxBytes) {
        const capped = await this.enforceGlobalCap(maxBytes, scan, blobBytes, true)
        blobBytes = capped.blobBytes
        legacyBytes = capped.legacyBytes
        if (capped.over) {
          // Still over budget with baselines pinned: the hard limit wins.
          const retry = await this.scanAll()
          if (retry) {
            const forced = await this.enforceGlobalCap(maxBytes, retry, blobBytes, false)
            blobBytes = forced.blobBytes
            legacyBytes = forced.legacyBytes
          }
        }
      }
      this.maintenanceState = {
        version: MAINTENANCE_STATE_VERSION,
        blobBytes,
        legacyBytes,
        lastMaintenanceAt: startedAt,
        lastAuditAt: startedAt,
        lastTrashSweepAt: state?.lastTrashSweepAt ?? startedAt,
      }
      this.maintenanceStatePromise = Promise.resolve(this.maintenanceState)
      this.maintenanceStateDirty = false
      this.countedBlobs.clear()
      await this.saveMaintenanceState()
    })
  }

  private async scanAll(): Promise<ScanResult | null> {
    const refs: CheckpointRef[] = []
    const hashes = new Set<string>()
    let legacyBytes = 0
    let steps = 0
    const yieldIfNeeded = async (): Promise<void> => {
      steps += 1
      if (steps % YIELD_EVERY === 0) await yieldEventLoop()
    }
    let sessions
    try {
      sessions = await readdir(this.root, { withFileTypes: true })
    } catch {
      // Never sweep without a complete view of the store: a permission or I/O
      // error must not look like "no snapshots reference these blobs".
      return null
    }
    for (const session of sessions) {
      if (!session.isDirectory() || session.name === BLOBS_DIR || session.name === TRASH_DIR) continue
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(session.name)) continue
      let entries
      try {
        entries = await readdir(join(this.root, session.name), { withFileTypes: true })
      } catch {
        return null
      }
      await yieldIfNeeded()
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!/^[A-Za-z0-9-]{1,120}$/.test(entry.name)) continue
        const loaded = await this.loadMeta(session.name, entry.name)
        const dir = join(this.root, session.name, entry.name)
        if (loaded.state === 'missing') {
          // Crash between mkdir and meta.json: not a listable snapshot.
          await rm(dir, { recursive: true, force: true }).catch(() => undefined)
          await yieldIfNeeded()
          continue
        }
        if (loaded.state === 'invalid') return null
        const manifest = await this.loadManifest(dir)
        if (!manifest) return null
        for (const item of manifest) hashes.add(item.sha256)
        refs.push({ sessionId: session.name, dir, meta: loaded.meta })
        if (loaded.meta.version === 1) legacyBytes += Math.max(0, loaded.meta.bytes)
        await yieldIfNeeded()
      }
    }
    return { refs, hashes, legacyBytes }
  }

  /**
   * Delete blobs no manifest references and return the bytes kept.
   *
   * Summing kept blob sizes here avoids a second full `stat` walk solely to
   * measure the store. Orphans are removed, so they are not part of the total.
   */
  private async sweepBlobs(hashes: Set<string>): Promise<number> {
    await rm(join(this.blobsRoot, BLOB_TEMP_DIR), { recursive: true, force: true }).catch(
      () => undefined,
    )
    let prefixes
    try {
      prefixes = await readdir(this.blobsRoot)
    } catch {
      return 0
    }
    let bytes = 0
    let steps = 0
    const yieldIfNeeded = async (): Promise<void> => {
      steps += 1
      if (steps % YIELD_EVERY === 0) await yieldEventLoop()
    }
    for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue
      const dir = join(this.blobsRoot, prefix)
      let names
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      let kept = 0
      for (const name of names) {
        if (hashes.has(name)) {
          kept += 1
          const info = await stat(join(dir, name)).catch(() => null)
          if (info?.isFile()) bytes += info.size
          await yieldIfNeeded()
          continue
        }
        await rm(join(dir, name), { force: true }).catch(() => undefined)
        await yieldIfNeeded()
      }
      if (kept === 0 && names.length > 0) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return bytes
  }

  /**
   * Evict snapshots until the blob store fits `maxBytes`. `over` is true when
   * the budget is still exceeded, which only happens when everything left is
   * protected.
   */
  private async enforceGlobalCap(
    maxBytes: number,
    initial: ScanResult,
    initialBlobBytes: number,
    protectBaselines = true,
  ): Promise<{ over: boolean; blobBytes: number; legacyBytes: number }> {
    let scan = initial
    let blobBytes = initialBlobBytes
    let usage = blobBytes + scan.legacyBytes
    for (let round = 0; round < MAINTENANCE_MAX_ROUNDS && usage > maxBytes; round += 1) {
      // Always keep the newest snapshot of every session: it is the baseline
      // users are most likely to need.
      const protectedKeys = new Set<string>()
      const newestBySession = new Map<string, CheckpointRef>()
      for (const ref of scan.refs) {
        const current = newestBySession.get(ref.sessionId)
        if (!current || ref.meta.createdAt > current.meta.createdAt) {
          newestBySession.set(ref.sessionId, ref)
        }
      }
      for (const ref of newestBySession.values()) protectedKeys.add(refKey(ref))
      // Baselines are what review and per-file revert compare against; evicting
      // one would silently redefine "before the run" for that session. The hard
      // budget still wins: `maintain` retries with this disabled.
      if (protectBaselines) {
        for (const ref of scan.refs) {
          if (ref.meta.baseline) protectedKeys.add(refKey(ref))
        }
      }

      const candidates = scan.refs
        .filter((ref) => !protectedKeys.has(refKey(ref)))
        .sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt))
      if (candidates.length === 0) {
        return { over: usage > maxBytes, blobBytes, legacyBytes: scan.legacyBytes }
      }

      // Delete a batch roughly half the overshoot before paying for another
      // full scan; logical sizes over-count shared blobs, so overshooting on
      // the small side risks another expensive round.
      const target = usage - maxBytes
      let freed = 0
      const doomed = new Set<string>()
      for (const ref of candidates) {
        if (doomed.size > 0 && freed >= target / 2) break
        doomed.add(refKey(ref))
        freed += Math.max(0, ref.meta.bytes)
      }
      if (doomed.size === 0) {
        return { over: usage > maxBytes, blobBytes, legacyBytes: scan.legacyBytes }
      }
      for (const ref of scan.refs) {
        if (!doomed.has(refKey(ref))) continue
        await rm(ref.dir, { recursive: true, force: true }).catch(() => undefined)
      }

      const next = await this.scanAll()
      if (!next) return { over: usage > maxBytes, blobBytes, legacyBytes: scan.legacyBytes }
      blobBytes = await this.sweepBlobs(next.hashes)
      scan = next
      usage = blobBytes + scan.legacyBytes
    }
    return { over: usage > maxBytes, blobBytes, legacyBytes: scan.legacyBytes }
  }
}
