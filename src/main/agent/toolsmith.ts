import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
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
import { basename, extname, join, resolve } from 'node:path'
import type {
  DynamicToolInfo,
  DynamicToolRuntime,
  DynamicToolSource,
  DynamicToolVersion,
  TestCaptchaMode,
  ToolResult,
} from '../../shared/types'
import { assertInside, workspaceRoot } from '../workspace'

const TOOLS_DIR = join('.pilot', 'tools')
const GLOBAL_DIR = join('tools', 'global')
const REGISTRY_FILE = 'tool-registry.json'
const HISTORY_DIR = join('tools', 'history')
/** Approved versions kept per tool; older snapshots are pruned. */
const MAX_VERSION_HISTORY = 5
const MAX_TOOLS_PER_SOURCE = 40
const MAX_TOOL_FILES = 60
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_CHARS = 32_000
const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 600_000
const TEST_TIMEOUT_MS = 120_000

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

export interface DynamicToolManifest {
  name: string
  description: string
  version: number
  runtime: DynamicToolRuntime
  entry: string
  test: string
  timeoutMs: number
  risk: 'read' | 'exec'
  targets: string[]
  inputSchema: Record<string, unknown>
  verification: boolean
}

interface RegistryEntry {
  approvedSha: string | null
  /** Version of the approved code. Moves forward on every code change. */
  approvedVersion?: number
  /** Approval history, oldest first; snapshots live under userData. */
  versions?: DynamicToolVersion[]
  /** Set when the tool was promoted from a workspace into the global tool set. */
  promotedAt?: string
  enabled: boolean
  createdAt: string
  successCount: number
  failureCount: number
  lastRunAt?: string
  lastError?: string
}

interface RegistryFile {
  version: 1
  workspaces: Record<string, Record<string, RegistryEntry>>
  global: Record<string, RegistryEntry>
}

interface LoadedTool {
  manifest: DynamicToolManifest
  dir: string
  sha256: string
  source: DynamicToolSource
}

export interface DynamicToolRegistryOptions {
  workspacePath: string
  userDataDir: string
  testTargets?: string[]
  testCaptchaMode?: TestCaptchaMode
  testCaptcha?: string | null
  signal?: AbortSignal
  onChange?: () => void
}

export interface RegisterToolResult {
  tool: DynamicToolInfo
  testOutput: string
  durationMs: number
}

/** Outcome of adopting one tool that shipped inside the release package. */
export interface AdoptBundledResult {
  name: string
  status: 'installed' | 'updated' | 'kept' | 'skipped'
  /** Set when the bundle was not adopted, e.g. the copy was edited locally. */
  reason?: string
}

interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

function now(): string {
  return new Date().toISOString()
}

function keyFor(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Tool names become directory names, so keep them to a strict slug. */
export function normalizeToolName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  return NAME_PATTERN.test(name) ? name : null
}

/**
 * Localhost is always allowed (dev servers the agent started itself). Every
 * other host must be explicitly listed in Settings → test targets.
 */
export function isAllowedTestTarget(target: string, allowed: string[]): boolean {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '127.0.0.1' || host === '[::1]' || host === '::1') return true
  const normalized = url.toString().replace(/\/$/, '')
  return allowed.some((entry) => {
    const base = entry.replace(/\/$/, '')
    return normalized === base || normalized.startsWith(`${base}/`)
  })
}

function optionalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function sanitizeVersions(value: unknown): DynamicToolVersion[] {
  if (!Array.isArray(value)) return []
  const out: DynamicToolVersion[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const version = Math.round(Number(record['version']))
    if (!Number.isFinite(version) || version < 1) continue
    const sha256 = typeof record['sha256'] === 'string' ? record['sha256'] : ''
    if (!sha256) continue
    const action =
      record['action'] === 'upgrade' || record['action'] === 'rollback'
        ? record['action']
        : 'register'
    out.push({
      version,
      sha256,
      approvedAt:
        typeof record['approvedAt'] === 'string' && record['approvedAt']
          ? record['approvedAt']
          : now(),
      action,
    })
  }
  return out.slice(-MAX_VERSION_HISTORY)
}

/** Replace the tail when the same version is approved twice, else append. */
function mergeVersionHistory(
  versions: DynamicToolVersion[],
  next: DynamicToolVersion,
): DynamicToolVersion[] {
  const last = versions[versions.length - 1]
  if (last && last.version === next.version && last.sha256 === next.sha256) {
    return [...versions.slice(0, -1), next]
  }
  return [...versions, next].slice(-MAX_VERSION_HISTORY)
}

function sanitizeEntry(value: unknown): RegistryEntry {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const versions = sanitizeVersions(record['versions'])
  return {
    approvedSha:
      typeof record['approvedSha'] === 'string' && record['approvedSha']
        ? record['approvedSha']
        : null,
    enabled: record['enabled'] !== false,
    createdAt:
      typeof record['createdAt'] === 'string' && Number.isFinite(Date.parse(record['createdAt']))
        ? record['createdAt']
        : now(),
    successCount: Math.max(0, Math.round(Number(record['successCount']) || 0)),
    failureCount: Math.max(0, Math.round(Number(record['failureCount']) || 0)),
    ...(typeof record['lastRunAt'] === 'string' ? { lastRunAt: record['lastRunAt'] } : {}),
    ...(typeof record['lastError'] === 'string'
      ? { lastError: record['lastError'].slice(0, 1_000) }
      : {}),
    ...(Number.isFinite(Number(record['approvedVersion']))
      ? { approvedVersion: Math.max(1, Math.round(Number(record['approvedVersion']))) }
      : {}),
    ...(versions.length > 0 ? { versions } : {}),
    ...(typeof record['promotedAt'] === 'string' && record['promotedAt']
      ? { promotedAt: record['promotedAt'] }
      : {}),
  }
}

function emptyRegistry(): RegistryFile {
  return { version: 1, workspaces: {}, global: {} }
}

function sanitizeRegistry(raw: unknown): RegistryFile {
  const registry = emptyRegistry()
  if (!raw || typeof raw !== 'object') return registry
  const record = raw as Record<string, unknown>
  const workspaces = record['workspaces']
  if (workspaces && typeof workspaces === 'object') {
    for (const [path, tools] of Object.entries(workspaces as Record<string, unknown>)) {
      if (!tools || typeof tools !== 'object') continue
      const bucket: Record<string, RegistryEntry> = {}
      for (const [name, entry] of Object.entries(tools as Record<string, unknown>)) {
        if (normalizeToolName(name)) bucket[name] = sanitizeEntry(entry)
      }
      registry.workspaces[path] = bucket
    }
  }
  const globalTools = record['global']
  if (globalTools && typeof globalTools === 'object') {
    for (const [name, entry] of Object.entries(globalTools as Record<string, unknown>)) {
      if (normalizeToolName(name)) registry.global[name] = sanitizeEntry(entry)
    }
  }
  return registry
}

async function readManifest(dir: string): Promise<{
  manifest: DynamicToolManifest
  sha256: string
}> {
  const folder = basename(dir)
  const manifestPath = join(dir, 'tool.json')
  const raw = await readFile(manifestPath, 'utf8').catch(() => null)
  if (raw === null) throw new Error(`缺少 tool.json：${folder}`)
  if (raw.length > 64_000) throw new Error(`tool.json 过大：${folder}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`tool.json 不是合法 JSON：${folder}`)
  }
  const manifest = parseManifest(parsed, folder)
  const entryBytes = await readToolFile(dir, manifest.entry)
  const testBytes = await readToolFile(dir, manifest.test)
  const hash = createHash('sha256')
  hash.update('manifest\0')
  hash.update(raw)
  hash.update('\0entry\0')
  hash.update(entryBytes)
  hash.update('\0test\0')
  hash.update(testBytes)
  return { manifest, sha256: hash.digest('hex') }
}

/** Bump `version` inside tool.json so the file matches the approval history. */
async function writeManifestVersion(dir: string, version: number): Promise<void> {
  const manifestPath = join(dir, 'tool.json')
  const raw = await readFile(manifestPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('tool.json 不是合法 JSON，无法升级版本号')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tool.json 必须是一个对象，无法升级版本号')
  }
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...(parsed as Record<string, unknown>), version }, null, 2)}\n`,
    'utf8',
  )
}

async function readToolFile(dir: string, relativePath: string): Promise<Buffer> {
  const target = resolve(dir, relativePath)
  assertInside(dir, target)
  const info = await lstat(target)
  if (info.isSymbolicLink()) throw new Error(`工具文件不能是符号链接：${relativePath}`)
  if (!info.isFile()) throw new Error(`工具文件不存在：${relativePath}`)
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`工具文件过大（上限 ${MAX_FILE_BYTES} 字节）：${relativePath}`)
  }
  const real = await realpath(target)
  assertInside(await realpath(dir), real)
  return readFile(real)
}

function parseManifest(raw: unknown, folder: string): DynamicToolManifest {
  if (!raw || typeof raw !== 'object') throw new Error('tool.json 必须是对象')
  const record = raw as Record<string, unknown>
  const name = normalizeToolName(record['name'])
  if (!name) throw new Error('name 必须是 2-64 位小写字母、数字或连字符，且以字母开头')
  if (name !== folder) throw new Error(`name 必须与目录名一致：${folder}`)
  const description =
    typeof record['description'] === 'string' ? record['description'].trim() : ''
  if (description.length < 8) throw new Error('description 至少 8 个字符')
  if (description.length > 600) throw new Error('description 最多 600 个字符')
  const runtime: DynamicToolRuntime = record['runtime'] === 'python' ? 'python' : 'node'
  const version = Math.max(1, Math.round(Number(record['version']) || 1))
  const entry = typeof record['entry'] === 'string' ? record['entry'].trim() : ''
  const test = typeof record['test'] === 'string' ? record['test'].trim() : ''
  if (!entry) throw new Error('entry 必填（工具入口文件）')
  if (!test) throw new Error('test 必填：每个工具必须带一个自测文件')
  assertRelativeScript(entry, runtime, 'entry')
  assertRelativeScript(test, runtime, 'test')
  const timeoutMs = Math.round(
    Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, Number(record['timeoutMs']) || DEFAULT_TIMEOUT_MS),
    ),
  )
  const risk = record['risk'] === 'read' ? 'read' : 'exec'
  const targetsRaw = Array.isArray(record['targets']) ? record['targets'] : []
  const targets: string[] = []
  for (const item of targetsRaw.slice(0, 10)) {
    const target = optionalUrl(item)
    if (!target) throw new Error(`targets 里有无效的 http/https 地址：${String(item)}`)
    if (!targets.includes(target)) targets.push(target)
  }
  const schemaRaw = record['inputSchema']
  const inputSchema =
    schemaRaw && typeof schemaRaw === 'object'
      ? (schemaRaw as Record<string, unknown>)
      : { type: 'object', properties: {} }
  if (inputSchema['type'] !== 'object') throw new Error('inputSchema.type 必须是 "object"')
  return {
    name,
    description,
    version,
    runtime,
    entry,
    test,
    timeoutMs,
    risk,
    targets,
    inputSchema,
    verification: record['verification'] !== false,
  }
}

function assertRelativeScript(value: string, runtime: DynamicToolRuntime, field: string): void {
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${field} 必须是工具目录内的相对路径`)
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new Error(`${field} 不能跳出工具目录`)
  }
  const extension = extname(value).toLowerCase()
  const allowed =
    runtime === 'node'
      ? new Set(['.js', '.mjs', '.cjs'])
      : new Set(['.py'])
  if (!allowed.has(extension)) {
    throw new Error(`${field} 的扩展名不适用于 ${runtime} 运行时`)
  }
}

/**
 * Registry for tools the agent wrote into `.pilot/tools/<name>/`.
 *
 * Registration is the trust boundary: the manifest and both scripts are
 * validated, the declared test runs inside a bounded child process, and only a
 * passing test records an approved SHA-256. Editing any of the three files
 * changes that hash and revokes the tool until it is registered again.
 */
export class DynamicToolRegistry {
  private readonly workspacePath: string
  private readonly userDataDir: string
  private readonly testTargets: string[]
  private readonly testCaptchaMode: TestCaptchaMode
  private readonly testCaptcha: string | null
  private readonly signal: AbortSignal | undefined
  private readonly onChange: (() => void) | undefined
  private rootPromise: Promise<string> | null = null

  constructor(options: DynamicToolRegistryOptions) {
    this.workspacePath = options.workspacePath
    this.userDataDir = options.userDataDir
    this.testTargets = options.testTargets ?? []
    this.testCaptchaMode = options.testCaptchaMode ?? 'off'
    this.testCaptcha = options.testCaptcha ?? null
    this.signal = options.signal
    this.onChange = options.onChange
  }

  private async root(): Promise<string> {
    this.rootPromise ??= workspaceRoot(this.workspacePath)
    return this.rootPromise
  }

  private async workspaceToolsRoot(): Promise<string> {
    return join(await this.root(), TOOLS_DIR)
  }

  private globalToolsRoot(): string {
    return join(this.userDataDir, GLOBAL_DIR)
  }

  private registryPath(): string {
    return join(this.userDataDir, REGISTRY_FILE)
  }

  private async loadRegistry(): Promise<RegistryFile> {
    const raw = await readFile(this.registryPath(), 'utf8').catch(() => null)
    if (raw === null) return emptyRegistry()
    try {
      return sanitizeRegistry(JSON.parse(raw))
    } catch {
      return emptyRegistry()
    }
  }

  private async saveRegistry(registry: RegistryFile): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true })
    const path = this.registryPath()
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  private async workspaceKey(): Promise<string> {
    return keyFor(await this.root())
  }

  private async loadTools(root: string, source: DynamicToolSource): Promise<LoadedTool[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const out: LoadedTool[] = []
    for (const entry of entries.slice(0, MAX_TOOLS_PER_SOURCE * 2)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const dir = join(root, entry.name)
      try {
        const loaded = await readManifest(dir)
        out.push({ ...loaded, dir, source })
      } catch {
        // A half-written or invalid tool is simply not offered. register_tool
        // reports the exact validation error so the toolsmith can fix it.
      }
      if (out.length >= MAX_TOOLS_PER_SOURCE) break
    }
    return out
  }

  private infoFor(
    tool: LoadedTool,
    entry: RegistryEntry | undefined,
  ): DynamicToolInfo {
    const approved = Boolean(entry?.approvedSha && entry.approvedSha === tool.sha256)
    return {
      name: tool.manifest.name,
      description: tool.manifest.description,
      version: tool.manifest.version,
      ...(entry?.approvedVersion ? { approvedVersion: entry.approvedVersion } : {}),
      ...(entry?.versions && entry.versions.length > 0 ? { versions: entry.versions } : {}),
      runtime: tool.manifest.runtime,
      risk: tool.manifest.risk,
      source: tool.source,
      enabled: entry?.enabled !== false,
      approved,
      sha256: tool.sha256,
      timeoutMs: tool.manifest.timeoutMs,
      targets: [...tool.manifest.targets],
      inputSchema: tool.manifest.inputSchema,
      verification: tool.manifest.verification,
      createdAt: entry?.createdAt ?? now(),
      ...(entry?.promotedAt ? { promotedAt: entry.promotedAt } : {}),
      ...(entry?.lastRunAt ? { lastRunAt: entry.lastRunAt } : {}),
      successCount: entry?.successCount ?? 0,
      failureCount: entry?.failureCount ?? 0,
      ...(entry?.lastError ? { lastError: entry.lastError } : {}),
    }
  }

  /** Workspace tools first; a workspace tool with the same name overrides global. */
  async list(): Promise<DynamicToolInfo[]> {
    const [registry, workspaceTools, globalTools] = await Promise.all([
      this.loadRegistry(),
      this.workspaceToolsRoot().then((root) => this.loadTools(root, 'workspace')),
      this.loadTools(this.globalToolsRoot(), 'global'),
    ])
    const key = await this.workspaceKey()
    const workspaceEntries = registry.workspaces[key] ?? {}
    const globalByName = new Map(globalTools.map((tool) => [tool.manifest.name, tool]))
    const out = workspaceTools.map((tool) => {
      const info = this.infoFor(tool, workspaceEntries[tool.manifest.name])
      // The workspace copy shadows the promoted one, but the agent still needs
      // to know that this capability is already a system default.
      const globalEntry = registry.global[tool.manifest.name]
      const globalTool = globalByName.get(tool.manifest.name)
      if (globalEntry?.promotedAt && globalTool?.sha256 === globalEntry.approvedSha) {
        info.promotedAt = globalEntry.promotedAt
      }
      return info
    })
    const names = new Set(out.map((tool) => tool.name))
    for (const tool of globalTools) {
      if (names.has(tool.manifest.name)) continue
      out.push(this.infoFor(tool, registry.global[tool.manifest.name]))
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async find(nameInput: unknown): Promise<LoadedTool | null> {
    const name = normalizeToolName(nameInput)
    if (!name) return null
    const workspaceRootPath = await this.workspaceToolsRoot()
    const workspace = (await this.loadTools(workspaceRootPath, 'workspace')).find(
      (tool) => tool.manifest.name === name,
    )
    if (workspace) return workspace
    return (
      (await this.loadTools(this.globalToolsRoot(), 'global')).find(
        (tool) => tool.manifest.name === name,
      ) ?? null
    )
  }

  /** Validate a workspace tool and approve it only after its own test passes. */
  /** Approved snapshots for this workspace, keyed by a hash of its path. */
  private historyRoot(source: DynamicToolSource = 'workspace'): string {
    // Promoted tools keep their snapshots under `global`, so they stay
    // restorable after the workspace copy is gone.
    const key =
      source === 'global'
        ? 'global'
        : createHash('sha256').update(keyFor(this.workspacePath)).digest('hex').slice(0, 16)
    return join(this.userDataDir, HISTORY_DIR, key)
  }

  private snapshotPath(
    name: string,
    version: number,
    source: DynamicToolSource = 'workspace',
  ): string {
    return join(this.historyRoot(source), name, `v${version}`)
  }

  /** Keep the exact approved bytes so a later upgrade can be rolled back. */
  private async snapshotTool(
    name: string,
    version: number,
    dir: string,
    source: DynamicToolSource = 'workspace',
  ): Promise<void> {
    const destination = this.snapshotPath(name, version, source)
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })
    await copyToolDirectory(dir, destination)
  }

  async register(nameInput: unknown): Promise<RegisterToolResult> {
    const name = normalizeToolName(nameInput)
    if (!name) throw new Error('工具名不合法：需要 2-64 位小写字母、数字或连字符')
    const toolsRoot = await this.workspaceToolsRoot()
    const dir = join(toolsRoot, name)
    const dirInfo = await lstat(dir).catch(() => null)
    if (!dirInfo) throw new Error(`工具目录不存在：.pilot/tools/${name}`)
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error(`工具目录必须是真实目录，不能是符号链接：.pilot/tools/${name}`)
    }
    assertInside(toolsRoot, await realpath(dir))
    const loaded = await readManifest(dir)
    const existing = await this.list()
    const sameName = existing.find((tool) => tool.name === name && tool.source === 'workspace')
    if (!sameName && existing.filter((tool) => tool.source === 'workspace').length >= MAX_TOOLS_PER_SOURCE) {
      throw new Error(`每个工作区最多 ${MAX_TOOLS_PER_SOURCE} 个工具`)
    }
    this.assertTargetsAllowed(loaded.manifest)
    const execution = await this.execute(
      loaded.manifest,
      dir,
      {},
      Math.min(loaded.manifest.timeoutMs, TEST_TIMEOUT_MS),
      true,
    )
    if (execution.code !== 0 || execution.timedOut || execution.aborted) {
      const detail = [execution.stderr, execution.stdout].filter(Boolean).join('\n').trim()
      const reason = execution.aborted
        ? '自测被取消'
        : execution.timedOut
          ? '自测超时'
          : `自测失败（退出码 ${execution.code ?? 'unknown'}）`
      throw new Error(`${reason}。修复 test 后重新登记。\n${detail.slice(-4_000)}`)
    }
    const registry = await this.loadRegistry()
    const key = await this.workspaceKey()
    const bucket = registry.workspaces[key] ?? {}
    const previous = bucket[name]
    const versions = previous?.versions ?? []
    const codeChanged = Boolean(previous?.approvedSha && previous.approvedSha !== loaded.sha256)
    // 改过代码再登记就是一次升级：版本号必须前进，否则批准历史里两版无法区分，
    // 回滚也没有可辨认的目标版本。
    let approved = loaded
    if (codeChanged) {
      const latest = Math.max(
        previous?.approvedVersion ?? 0,
        versions.length > 0 ? versions[versions.length - 1]!.version : 0,
      )
      const next = Math.max(loaded.manifest.version, latest + 1)
      if (next !== loaded.manifest.version) {
        await writeManifestVersion(dir, next)
        approved = await readManifest(dir)
      }
    }
    const version = approved.manifest.version
    try {
      await this.snapshotTool(name, version, dir)
    } catch (error) {
      throw new Error(
        `无法保存批准快照，已取消登记：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const record: DynamicToolVersion = {
      version,
      sha256: approved.sha256,
      approvedAt: now(),
      action: codeChanged ? 'upgrade' : 'register',
    }
    bucket[name] = {
      approvedSha: approved.sha256,
      approvedVersion: version,
      versions: mergeVersionHistory(versions, record),
      enabled: true,
      createdAt: previous?.createdAt ?? now(),
      // 升级后的统计从零开始：旧版本的失败次数不代表新版本。
      successCount: codeChanged ? 0 : (previous?.successCount ?? 0),
      failureCount: codeChanged ? 0 : (previous?.failureCount ?? 0),
      ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}),
      ...(!codeChanged && previous?.lastError ? { lastError: previous.lastError } : {}),
    }
    registry.workspaces[key] = bucket
    await this.saveRegistry(registry)
    this.onChange?.()
    const info = this.infoFor({ ...approved, dir, source: 'workspace' }, bucket[name])
    return {
      tool: info,
      testOutput: execution.stdout.trim().slice(-8_000),
      durationMs: execution.durationMs,
    }
  }

  /**
   * A promoted tool must work in any workspace, so it may not hardcode this
   * workspace's absolute path (the global copy is visible to every project).
   */
  private async assertGeneric(
    name: string,
    loaded: { manifest: DynamicToolManifest },
    dir: string,
  ): Promise<void> {
    const normalize = (value: string): string =>
      value.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase()
    const workspace = normalize(await this.root()).replace(/\/+$/, '')
    if (workspace.length < 4) return
    for (const file of [loaded.manifest.entry, loaded.manifest.test]) {
      const text = await readFile(join(dir, file), 'utf8').catch(() => '')
      if (!text) continue
      if (normalize(text).includes(workspace)) {
        throw new Error(
          `工具 ${name} 不通用：${file} 里写死了当前工作区路径。` +
            '改成参数、相对路径或 PILOT_WORKSPACE 环境变量后再提升。',
        )
      }
    }
  }

  private assertTargetsAllowed(manifest: DynamicToolManifest): void {
    const blocked = manifest.targets.filter(
      (target) => !isAllowedTestTarget(target, this.testTargets),
    )
    if (blocked.length > 0) {
      throw new Error(
        `工具声明的测试目标不在白名单：${blocked.join(', ')}。请先在 设置 → 测试目标 里加入该地址，或改用 localhost。`,
      )
    }
  }

  /**
   * Restore a previously approved snapshot of a tool.
   *
   * Rolling back is an approval event: the restored bytes must match the
   * recorded SHA-256 and pass the tool's own test, otherwise the live copy is
   * put back exactly as it was. The version reverts to the restored code's
   * version and the history records the rollback. `source` picks the workspace
   * copy or the promoted system-default copy; when omitted, an existing
   * workspace tool wins and a promoted-only tool is rolled back globally.
   */
  async rollback(
    nameInput: unknown,
    versionInput?: unknown,
    sourceInput?: unknown,
  ): Promise<RegisterToolResult> {
    const name = normalizeToolName(nameInput)
    if (!name) throw new Error('工具名不合法：需要 2-64 位小写字母、数字或连字符')
    const requested =
      sourceInput === 'global' || sourceInput === 'workspace' ? sourceInput : undefined
    const toolsRoot = await this.workspaceToolsRoot()
    const globalRoot = this.globalToolsRoot()
    const workspaceDir = join(toolsRoot, name)
    const globalDir = join(globalRoot, name)
    const source: DynamicToolSource =
      requested ?? ((await lstat(workspaceDir).catch(() => null)) ? 'workspace' : 'global')
    const dir = source === 'global' ? globalDir : workspaceDir
    const dirInfo = await lstat(dir).catch(() => null)
    if (!dirInfo) {
      throw new Error(
        source === 'global'
          ? `系统默认工具不存在：${name}`
          : `工具目录不存在：.pilot/tools/${name}（它可能已被提升为系统默认工具，用 scope: "global"）`,
      )
    }
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error(`工具目录必须是真实目录，不能是符号链接：${name}`)
    }
    assertInside(source === 'global' ? globalRoot : toolsRoot, await realpath(dir))
    const registry = await this.loadRegistry()
    const key = await this.workspaceKey()
    const entry = source === 'global' ? registry.global[name] : registry.workspaces[key]?.[name]
    const versions = entry?.versions ?? []
    if (versions.length === 0) {
      throw new Error(`工具 ${name} 没有批准历史；快照只在 register_tool 通过后生成。`)
    }
    const target = await this.pickRollbackTarget(name, entry, versions, versionInput, source)
    const backup = join(this.historyRoot(source), name, `.backup-${randomUUID()}`)
    await mkdir(backup, { recursive: true })
    await copyToolDirectory(dir, backup)
    try {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await copyToolDirectory(this.snapshotPath(name, target.version, source), dir)
      const restored = await readManifest(dir)
      if (restored.sha256 !== target.sha256) {
        throw new Error(`历史版本 v${target.version} 的文件与记录的哈希不一致，已取消回滚`)
      }
      this.assertTargetsAllowed(restored.manifest)
      const execution = await this.execute(
        restored.manifest,
        dir,
        {},
        Math.min(restored.manifest.timeoutMs, TEST_TIMEOUT_MS),
        true,
      )
      if (execution.code !== 0 || execution.timedOut || execution.aborted) {
        const detail = [execution.stderr, execution.stdout].filter(Boolean).join('\n').trim()
        const reason = execution.aborted
          ? '自测被取消'
          : execution.timedOut
            ? '自测超时'
            : `自测失败（退出码 ${execution.code ?? 'unknown'}）`
        throw new Error(
          `历史版本 v${target.version} ${reason}，已保留当前版本。\n${detail.slice(-4_000)}`,
        )
      }
      const record: DynamicToolVersion = {
        version: restored.manifest.version,
        sha256: restored.sha256,
        approvedAt: now(),
        action: 'rollback',
      }
      const bucket = source === 'global' ? registry.global : (registry.workspaces[key] ?? {})
      bucket[name] = {
        approvedSha: restored.sha256,
        approvedVersion: restored.manifest.version,
        versions: mergeVersionHistory(versions, record),
        enabled: true,
        createdAt: entry?.createdAt ?? now(),
        successCount: entry?.successCount ?? 0,
        failureCount: entry?.failureCount ?? 0,
        ...(entry?.lastRunAt ? { lastRunAt: entry.lastRunAt } : {}),
      }
      if (source === 'global') registry.global = bucket
      else registry.workspaces[key] = bucket
      await this.saveRegistry(registry)
      this.onChange?.()
      return {
        tool: this.infoFor({ ...restored, dir, source }, bucket[name]),
        testOutput: execution.stdout.trim().slice(-8_000),
        durationMs: execution.durationMs,
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await mkdir(dir, { recursive: true }).catch(() => {})
      await copyToolDirectory(backup, dir).catch(() => {})
      throw error
    } finally {
      await rm(backup, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Parse the requested version, else fall back to the newest other approved one. */
  private async pickRollbackTarget(
    name: string,
    entry: RegistryEntry | undefined,
    versions: DynamicToolVersion[],
    versionInput: unknown,
    source: DynamicToolSource = 'workspace',
  ): Promise<DynamicToolVersion> {
    if (versionInput !== undefined && versionInput !== null && versionInput !== '') {
      const wanted = Math.round(Number(versionInput))
      if (!Number.isFinite(wanted) || wanted < 1) throw new Error('version 必须是正整数')
      const match = versions.find((item) => item.version === wanted)
      if (!match) throw new Error(`工具 ${name} 没有 v${wanted} 的批准记录`)
      return match
    }
    for (let index = versions.length - 1; index >= 0; index -= 1) {
      const candidate = versions[index]!
      if (candidate.sha256 === entry?.approvedSha) continue
      const info = await stat(this.snapshotPath(name, candidate.version, source)).catch(
        () => null,
      )
      if (info?.isDirectory()) return candidate
    }
    throw new Error(`工具 ${name} 没有可回退的旧版本快照`)
  }

  /** Run a registered tool. Refuses disabled tools and any code change. */
  async run(nameInput: unknown, args: Record<string, unknown>): Promise<ToolResult> {
    const name = normalizeToolName(nameInput)
    if (!name) throw new Error('工具名不合法')
    const tool = await this.find(name)
    if (!tool) throw new Error(`没有已登记的工具：${name}`)
    const registry = await this.loadRegistry()
    const key = await this.workspaceKey()
    const entry =
      tool.source === 'workspace' ? registry.workspaces[key]?.[name] : registry.global[name]
    if (entry?.enabled === false) throw new Error(`工具已停用：${name}`)
    if (!entry?.approvedSha || entry.approvedSha !== tool.sha256) {
      throw new Error(
        `工具代码已变化或尚未通过自测：${name}。先用 register_tool 重新登记，或在工具面板检查。`,
      )
    }
    this.assertTargetsAllowed(tool.manifest)
    const execution = await this.execute(
      tool.manifest,
      tool.dir,
      args,
      tool.manifest.timeoutMs,
      false,
    )
    const ok = execution.code === 0 && !execution.timedOut && !execution.aborted
    const detail = [execution.stdout, execution.stderr].filter(Boolean).join('\n').trim()
    const error = ok
      ? undefined
      : execution.aborted
        ? '工具运行被取消'
        : execution.timedOut
          ? `工具运行超时（${tool.manifest.timeoutMs}ms）`
          : `工具退出码 ${execution.code ?? 'unknown'}`
    await this.recordRun(tool, ok, error)
    return {
      ok,
      output: detail.slice(0, MAX_OUTPUT_CHARS),
      ...(error ? { error } : {}),
      durationMs: execution.durationMs,
      metadata: {
        tool: tool.manifest.name,
        source: tool.source,
        sha256: tool.sha256,
        timedOut: execution.timedOut,
      },
    }
  }

  private async recordRun(
    tool: LoadedTool,
    ok: boolean,
    error: string | undefined,
  ): Promise<void> {
    try {
      const registry = await this.loadRegistry()
      const key = await this.workspaceKey()
      const bucket =
        tool.source === 'workspace'
          ? (registry.workspaces[key] ?? (registry.workspaces[key] = {}))
          : registry.global
      const previous = bucket[tool.manifest.name] ?? {
        approvedSha: tool.sha256,
        enabled: true,
        createdAt: now(),
        successCount: 0,
        failureCount: 0,
      }
      bucket[tool.manifest.name] = {
        ...previous,
        successCount: previous.successCount + (ok ? 1 : 0),
        failureCount: previous.failureCount + (ok ? 0 : 1),
        lastRunAt: now(),
        ...(error ? { lastError: error.slice(0, 1_000) } : { lastError: undefined }),
      }
      // `lastError: undefined` would serialize away; delete explicitly.
      if (!error) delete bucket[tool.manifest.name]!.lastError
      await this.saveRegistry(registry)
      this.onChange?.()
    } catch {
      // Statistics are best-effort and must never turn a successful run red.
    }
  }

  async setEnabled(
    source: DynamicToolSource,
    nameInput: unknown,
    enabled: boolean,
  ): Promise<DynamicToolInfo[]> {
    const name = normalizeToolName(nameInput)
    if (!name) throw new Error('工具名不合法')
    const tool = await this.find(name)
    if (!tool) throw new Error(`没有已登记的工具：${name}`)
    const registry = await this.loadRegistry()
    const key = await this.workspaceKey()
    const bucket =
      source === 'global' ? registry.global : (registry.workspaces[key] ?? (registry.workspaces[key] = {}))
    const current = bucket[name] ?? {
      approvedSha: tool.sha256,
      enabled: true,
      createdAt: now(),
      successCount: 0,
      failureCount: 0,
    }
    bucket[name] = { ...current, enabled }
    if (source === 'global') registry.global = bucket
    else registry.workspaces[key] = bucket
    await this.saveRegistry(registry)
    this.onChange?.()
    return this.list()
  }

  async remove(source: DynamicToolSource, nameInput: unknown): Promise<DynamicToolInfo[]> {
    const name = normalizeToolName(nameInput)
    if (!name) throw new Error('工具名不合法')
    const root =
      source === 'workspace' ? await this.workspaceToolsRoot() : this.globalToolsRoot()
    const dir = join(root, name)
    const info = await lstat(dir).catch(() => null)
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`工具目录不存在：${name}`)
    }
    assertInside(root, await realpath(dir))
    await rm(dir, { recursive: true, force: true })
    const registry = await this.loadRegistry()
    if (source === 'global') delete registry.global[name]
    else {
      const key = await this.workspaceKey()
      delete registry.workspaces[key]?.[name]
    }
    await this.saveRegistry(registry)
    this.onChange?.()
    return this.list()
  }

  /**
   * Promote an approved workspace tool into the global tool set, where every
   * workspace starts with it: this is how a generic tool becomes a
   * system-default tool.
   *
   * Promotion is held to a generality bar: the code may not hardcode this
   * workspace's absolute path, and a tool that never ran successfully is refused
   * unless `force` is set. The promoted copy keeps the version history and its
   * snapshots, so it can be rolled back globally afterwards.
   */
  async promote(
    nameInput: unknown,
    options: { force?: boolean } = {},
  ): Promise<DynamicToolInfo[]> {
    const name = normalizeToolName(nameInput)
    if (!name) throw new Error('工具名不合法')
    const toolsRoot = await this.workspaceToolsRoot()
    const sourceDir = join(toolsRoot, name)
    const sourceInfo = await lstat(sourceDir).catch(() => null)
    if (!sourceInfo || sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
      throw new Error(`工作区工具不存在：${name}`)
    }
    const loaded = await readManifest(sourceDir)
    const registry = await this.loadRegistry()
    const key = await this.workspaceKey()
    const entry = registry.workspaces[key]?.[name]
    if (!entry?.approvedSha || entry.approvedSha !== loaded.sha256) {
      throw new Error('只允许提升已通过自测且代码未变化的工具')
    }
    this.assertTargetsAllowed(loaded.manifest)
    await this.assertGeneric(name, loaded, sourceDir)
    if (entry.successCount < 1 && options.force !== true) {
      throw new Error(
        `工具 ${name} 还没有成功运行记录（ok 0 次）。先用 run_tool 跑通一次证明它可复用；` +
          '若确知通用，可传 force: true。',
      )
    }
    const globalRoot = this.globalToolsRoot()
    await mkdir(globalRoot, { recursive: true })
    const destination = join(globalRoot, name)
    const staging = join(globalRoot, `.${name}-${randomUUID()}.tmp`)
    await mkdir(staging, { recursive: true })
    try {
      await copyToolDirectory(sourceDir, staging)
      await rm(destination, { recursive: true, force: true })
      await rename(staging, destination)
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    const copied = await readManifest(destination)
    if (copied.sha256 !== loaded.sha256) {
      throw new Error('提升后的工具内容与源文件不一致，已中止')
    }
    // Carry the approved snapshots into the global history so the promoted tool
    // stays restorable after the workspace copy is gone.
    const versions = entry.versions ?? []
    for (const version of versions) {
      const to = this.snapshotPath(name, version.version, 'global')
      if ((await stat(to).catch(() => null))?.isDirectory()) continue
      const from = this.snapshotPath(name, version.version)
      if (!(await stat(from).catch(() => null))?.isDirectory()) continue
      await mkdir(to, { recursive: true })
      await copyToolDirectory(from, to)
    }
    await this.snapshotTool(name, copied.manifest.version, destination, 'global')
    const previous = registry.global[name]
    const base =
      previous?.versions && previous.versions.length > 0
        ? previous.versions
        : versions.length > 0
          ? versions
          : []
    const record: DynamicToolVersion = {
      version: copied.manifest.version,
      sha256: copied.sha256,
      approvedAt: now(),
      action: previous?.approvedSha ? 'upgrade' : 'register',
    }
    registry.global[name] = {
      approvedSha: copied.sha256,
      approvedVersion: copied.manifest.version,
      versions: base.length > 0 ? mergeVersionHistory(base, record) : [record],
      enabled: true,
      createdAt: previous?.createdAt ?? now(),
      successCount: previous?.successCount ?? entry.successCount,
      failureCount: previous?.failureCount ?? entry.failureCount,
      promotedAt: now(),
    }
    await this.saveRegistry(registry)
    this.onChange?.()
    return this.list()
  }

  /**
   * Adopt a tool that ships inside the release package as a system-default tool.
   *
   * The bundle is vendor-authored, but it is held to the same trust boundary as
   * a promoted tool: `index.json` in the bundle records the SHA-256 the pack
   * script computed *after* running the tool's own self-test, the bytes copied
   * here must hash to that value, and only then is an approval recorded. A
   * bundle whose files do not match the recorded hash is refused instead of
   * being silently trusted.
   *
   * The user always wins: a global copy that was edited (its SHA-256 no longer
   * matches the approval) is never overwritten. Only an untouched, still
   * approved copy of an older bundled version is upgraded in place.
   */
  async adoptBundled(input: { dir: string; sha256: string }): Promise<AdoptBundledResult> {
    const name = normalizeToolName(basename(input.dir)) ?? basename(input.dir)
    let bundled: Awaited<ReturnType<typeof readManifest>>
    try {
      bundled = await readManifest(input.dir)
    } catch (error) {
      return {
        name,
        status: 'skipped',
        reason: error instanceof Error ? error.message : '内置工具无法读取',
      }
    }
    const toolName = normalizeToolName(bundled.manifest.name)
    if (!toolName || toolName !== name) {
      return { name, status: 'skipped', reason: '内置工具的目录名与 name 不一致' }
    }
    if (!/^[0-9a-f]{64}$/.test(input.sha256) || bundled.sha256 !== input.sha256) {
      return { name, status: 'skipped', reason: '内置清单记录的 SHA-256 与文件不一致' }
    }
    const blocked = bundled.manifest.targets.filter(
      (target) => !isAllowedTestTarget(target, this.testTargets),
    )
    if (blocked.length > 0) {
      return {
        name,
        status: 'skipped',
        reason: `测试目标不在白名单：${blocked.join(', ')}`,
      }
    }
    const registry = await this.loadRegistry()
    const bucket = registry.global
    const previous = bucket[name]
    const target = join(this.globalToolsRoot(), name)
    const existing = await readManifest(target).catch(() => null)
    if (existing) {
      if (existing.sha256 === bundled.sha256) {
        // Byte-for-byte the bundled tool. Re-approving is safe even when the
        // registry entry was lost or the approval was revoked by an edit that
        // was later undone, so only a matching approval is reported as kept.
        if (previous?.approvedSha === existing.sha256 && previous.approvedVersion === bundled.manifest.version) {
          return { name, status: 'kept', reason: '已是最新版本' }
        }
      } else if (!previous?.approvedSha || previous.approvedSha !== existing.sha256) {
        // Edited or revoked locally: keep the user's bytes, do not re-approve.
        return {
          name,
          status: 'kept',
          reason: '本地已有修改过或未批准的同名工具，未覆盖',
        }
      }
    } else if (Object.keys(bucket).length >= MAX_TOOLS_PER_SOURCE) {
      return { name, status: 'skipped', reason: `全局工具数量已达上限 ${MAX_TOOLS_PER_SOURCE}` }
    }
    // Copy through a temporary directory so a crash cannot leave half a tool
    // next to a recorded approval.
    const staging = `${target}.incoming`
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    await mkdir(staging, { recursive: true })
    await copyToolDirectory(input.dir, staging)
    await rm(target, { recursive: true, force: true }).catch(() => {})
    await rename(staging, target)
    const adopted = await readManifest(target)
    if (adopted.sha256 !== input.sha256) {
      await rm(target, { recursive: true, force: true }).catch(() => {})
      return { name, status: 'skipped', reason: '内置工具复制后校验失败' }
    }
    const version = adopted.manifest.version
    await this.snapshotTool(name, version, target, 'global')
    bucket[name] = {
      approvedSha: adopted.sha256,
      approvedVersion: version,
      versions: mergeVersionHistory(previous?.versions ?? [], {
        version,
        sha256: adopted.sha256,
        approvedAt: now(),
        action: previous?.approvedVersion ? 'upgrade' : 'register',
      }),
      enabled: true,
      createdAt: previous?.createdAt ?? now(),
      successCount: previous?.successCount ?? 0,
      failureCount: previous?.failureCount ?? 0,
      ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}),
      ...(previous?.lastError ? { lastError: previous.lastError } : {}),
      promotedAt: now(),
    }
    registry.global = bucket
    await this.saveRegistry(registry)
    this.onChange?.()
    return { name, status: existing ? 'updated' : 'installed' }
  }

  private async execute(
    manifest: DynamicToolManifest,
    dir: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    selfTest: boolean,
  ): Promise<ExecResult> {
    const entryPath = resolve(dir, selfTest ? manifest.test : manifest.entry)
    assertInside(dir, entryPath)
    const real = await realpath(entryPath)
    assertInside(await realpath(dir), real)
    const command =
      manifest.runtime === 'node' ? process.execPath : await pythonCommand()
    const commandArgs = manifest.runtime === 'node' ? [real] : [real]
    const env = this.toolEnv(manifest, dir, selfTest)
    return runChild(command, commandArgs, {
      cwd: await this.root(),
      env,
      timeoutMs,
      stdin: JSON.stringify(args ?? {}),
      ...(this.signal ? { signal: this.signal } : {}),
    })
  }

  private toolEnv(
    manifest: DynamicToolManifest,
    dir: string,
    selfTest: boolean,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '',
      SystemRoot: process.env['SystemRoot'] ?? '',
      ComSpec: process.env['ComSpec'] ?? '',
      PATHEXT: process.env['PATHEXT'] ?? '',
      TEMP: process.env['TEMP'] ?? process.env['TMP'] ?? '',
      TMP: process.env['TMP'] ?? process.env['TEMP'] ?? '',
      HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
      USERPROFILE: process.env['USERPROFILE'] ?? '',
      APPDATA: process.env['APPDATA'] ?? '',
      LOCALAPPDATA: process.env['LOCALAPPDATA'] ?? '',
      LANG: process.env['LANG'] ?? '',
      PILOT_TOOL_NAME: manifest.name,
      PILOT_TOOL_DIR: dir,
      PILOT_WORKSPACE: this.workspacePath,
      PILOT_SELF_TEST: selfTest ? '1' : '0',
      PILOT_TEST_TARGETS: JSON.stringify(this.testTargets),
      PILOT_TEST_CAPTCHA_MODE: this.testCaptchaMode,
      ELECTRON_RUN_AS_NODE: '1',
    }
    if (this.testCaptchaMode !== 'off' && this.testCaptcha) {
      // Only test-environment values; never an API key or user credential.
      env['PILOT_TEST_CAPTCHA'] = this.testCaptcha
      env['PILOT_TEST_CAPTCHA_HEADER'] = 'X-Pilot-Test-Captcha'
    }
    return env
  }
}

async function pythonCommand(): Promise<string> {
  for (const command of ['python', 'python3']) {
    const ok = await probeCommand(command)
    if (ok) return command
  }
  throw new Error('未找到 Python 运行时（python / python3）。请先安装 Python，或改用 node 运行时。')
}

async function probeCommand(command: string): Promise<boolean> {
  const result = await runChild(command, ['--version'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env['PATH'] ?? '',
      SystemRoot: process.env['SystemRoot'] ?? '',
      ComSpec: process.env['ComSpec'] ?? '',
    },
    timeoutMs: 3_000,
    stdin: '',
  }).catch(() => null)
  return Boolean(result && result.code === 0)
}

async function copyToolDirectory(source: string, destination: string): Promise<void> {
  let files = 0
  let total = 0
  async function walk(from: string, to: string): Promise<void> {
    const entries = await readdir(from, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = join(from, entry.name)
      const targetPath = join(to, entry.name)
      if (entry.isSymbolicLink()) throw new Error('工具目录不能包含符号链接')
      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true })
        await walk(sourcePath, targetPath)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(sourcePath)
      files += 1
      total += info.size
      if (files > MAX_TOOL_FILES) throw new Error(`工具文件数超过 ${MAX_TOOL_FILES}`)
      if (info.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        throw new Error('工具目录超过大小上限')
      }
      await writeFile(targetPath, await readFile(sourcePath))
    }
  }
  await walk(source, destination)
}

function runChild(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    stdin: string
    signal?: AbortSignal
  },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const onAbort = (): void => {
      aborted = true
      killTree(child.pid)
      setTimeout(() => finish(null), 1_500)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise({
        code,
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      })
    }
    const collect = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') {
        if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += text
      } else if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += text
    }
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))
    child.on('error', (error) => {
      stderr += `\n${error.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      setTimeout(() => finish(null), 1_500)
    }, Math.max(MIN_TIMEOUT_MS, Math.round(options.timeoutMs)))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.stdin)
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}
