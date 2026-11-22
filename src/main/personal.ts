import { isUtf8 } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
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
import {
  exists,
  now,
  readJson,
  resolveInside,
  safeRelative,
  safeWriteTarget,
  sha256,
  writeJson,
} from './personal/fs-utils'
import {
  FINGERPRINT_TRUST_MS,
  cachedSourceFingerprint,
  configureFingerprintCache,
  forgetSourceFingerprint,
  hashEntry,
  rawTree,
  resetFingerprintMemo,
  scanSourceChanges,
  sourceFingerprint,
  tree,
  walk,
} from './personal/tree'
import { latestBuild, prepareGitBase } from './personal/baseline'
import { diffHunks, hasConflictMarkers, mergeText } from './personal/merge'

export {
  cachedSourceFingerprint,
  configureFingerprintCache,
  diffHunks,
  forgetSourceFingerprint,
  mergeText,
  prepareGitBase,
  resetFingerprintMemo,
  scanSourceChanges,
  sourceFingerprint,
}

const FORMAT = 'pilot-contribution/v1'
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

interface ForkRecord {
  forkId: string
  name: string
  createdAt: string
  baseVersion: string
  /** Fingerprint of the official tree captured when the fork was created. */
  baseHash?: string
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
