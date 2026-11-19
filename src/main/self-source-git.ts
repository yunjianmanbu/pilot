/**
 * Where the evolution loop's official side comes from.
 *
 * A personal fork is only auditable when its baseline is a real commit of the
 * official repository: the panel can then say which commit a version was built
 * from, and a newer official revision can be merged in without reinstalling.
 * Without git the baseline is an opaque copy inside the installer, so nothing
 * ties a personal version to the code it started from.
 *
 * Two modes close the same loop with the same comparison code:
 * - `builtin`: the editable copy under userData is diffed against a tree
 *   extracted from the official git remote (configured at build time, or by
 *   the user). Syncing fetches that remote and re-extracts the baseline.
 * - `custom`: the user points at their own checkout; its `origin/<ref>` (or
 *   `HEAD`) is the baseline, so a fork keeps working after `git pull`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type {
  SelfSourceMode,
  SelfSourceSettings,
  SourceBaseKind,
  SourceProvenance,
} from '../shared/types'

export type { SelfSourceMode, SelfSourceSettings, SourceBaseKind, SourceProvenance }

/** Defaults discovered at package time (`self-source-git.json`) or from the dev checkout. */
export interface SelfSourceDefaults {
  gitUrl: string
  gitRef: string
  gitPath: string
}

export interface SelfSourceContext {
  packaged: boolean
  appPath: string
  resourcesPath: string
  userDataPath: string
  settings: SelfSourceSettings
}

interface SelfSourceRecord {
  gitUrl: string
  gitRef: string
  gitPath: string
  revision: string
  tipRevision: string
  committedAt: string
  summary: string
  fetchedAt: string
  behind: number | null
}

const GIT_URL_PATTERN =
  /^(https?:\/\/[^\s]+|git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+|file:\/\/[^\s]+)$/i

const GIT_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 300_000

/** Strip credentials and control characters from anything we show or log. */
export function sanitizeGitOutput(text: string): string {
  return text
    .replace(/\/\/[^/@\s]+@/g, '//***@')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeGitUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const url = value.trim()
  if (!url || url.length > 512) return ''
  return GIT_URL_PATTERN.test(url) ? url : ''
}

export function normalizeGitRef(value: unknown): string {
  if (typeof value !== 'string') return 'main'
  const ref = value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '')
  if (!ref || ref.length > 120) return 'main'
  // git refuses these characters in refs; reject instead of failing at fetch time.
  if (/[\s~^:?*[\\\u0000-\u001f]/.test(ref)) return 'main'
  if (ref.startsWith('-') || ref.endsWith('.') || ref.includes('..') || ref.includes('//')) {
    return 'main'
  }
  return ref
}

/** Repository-relative, posix-style, never absolute or escaping the root. */
export function normalizeGitPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const raw = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!raw || raw.length > 400) return ''
  if (raw.split('/').some((part) => part === '' || part === '.' || part === '..')) return ''
  if (/\u0000/.test(raw)) return ''
  return raw
}

export function normalizeCustomPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const path = value.trim()
  if (!path || path.includes('\u0000') || path.length > 1000) return ''
  return path
}

export function normalizeSelfSourceSettings(value: unknown): SelfSourceSettings {
  const input = (value ?? {}) as Partial<Record<keyof SelfSourceSettings, unknown>>
  return {
    mode: input.mode === 'custom' ? 'custom' : 'builtin',
    gitUrl: normalizeGitUrl(input.gitUrl),
    gitRef: normalizeGitRef(input.gitRef),
    gitPath: normalizeGitPath(input.gitPath),
    customPath: normalizeCustomPath(input.customPath),
  }
}

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

const GIT_SHELL_HINT = process.platform === 'win32' ? 'Windows 下请确认 git 已加入 PATH' : '请确认 git 已安装'

/** Run git without ever waiting on an interactive credential prompt. */
export function runGit(args: string[], cwd?: string, timeoutMs = GIT_TIMEOUT_MS): GitResult {
  // No shell: `git` is an executable, and a shell would both mangle refs such as
  // `HEAD^{commit}` on Windows (^ is the cmd escape) and let a configured URL
  // reach the command line as shell text.
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', LC_ALL: 'C' },
  })
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').toString().trim(),
    stderr: sanitizeGitOutput(((result.stderr ?? '') || (result.error?.message ?? '')).toString()),
  }
}

let gitChecked: boolean | null = null

export async function isGitAvailable(): Promise<boolean> {
  if (gitChecked !== null) return gitChecked
  const result = runGit(['--version'], undefined, 15_000)
  gitChecked = result.ok && /git version/i.test(result.stdout)
  return gitChecked
}

/** Test seam: forget the cached `git --version` probe. */
export function resetGitProbe(): void {
  gitChecked = null
}

export function isGitRepository(path: string): boolean {
  if (!path || !existsSync(path)) return false
  return runGit(['rev-parse', '--git-dir'], path).ok
}

export function gitRevision(repo: string, ref: string): string {
  const result = runGit(['rev-parse', '--verify', `${ref}^{commit}`], repo)
  return result.ok ? result.stdout : ''
}

/** True when the commit's tree actually contains `gitPath`. */
export function treeHasPath(repo: string, revision: string, gitPath: string): boolean {
  if (!gitPath) return true
  return runGit(['cat-file', '-e', `${revision}:${gitPath}`], repo).ok
}

/** Remote branches whose tip actually contains `gitPath`, for error hints. */
export function refsContainingPath(repo: string, gitPath: string, limit = 5): string[] {
  if (!gitPath) return []
  const listed = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], repo)
  if (!listed.ok) return []
  const found: string[] = []
  for (const name of listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/HEAD'))) {
    const revision = gitRevision(repo, name)
    if (revision && treeHasPath(repo, revision, gitPath)) {
      found.push(name.replace(/^origin\//, ''))
      if (found.length >= limit) break
    }
  }
  return found
}

/**
 * Best existing ref inside `repo`, preferring the official remote branch.
 *
 * A candidate is only accepted when its tree contains `gitPath`: a stale
 * `origin/main` that never had the client subdirectory (or a repository that
 * moved it) would otherwise produce an empty baseline while claiming to be the
 * official tip. In a custom checkout the checked-out commit wins, because that
 * is the code the user actually builds.
 */
export function resolveBaseRef(repo: string, ref: string, gitPath = '', preferRemote = true): string {
  const candidates = preferRemote
    ? [`origin/${ref}`, ref, 'HEAD']
    : ['HEAD', ref, `origin/${ref}`]
  const unique = [...new Set(candidates)]
  for (const candidate of unique) {
    const revision = gitRevision(repo, candidate)
    if (revision && treeHasPath(repo, revision, gitPath)) return candidate
  }
  return ''
}

function stateFile(userDataPath: string): string {
  return join(userDataPath, 'self-source-state.json')
}

function basesRoot(userDataPath: string): string {
  return join(userDataPath, 'self-source-bases')
}

export function officialRepoPath(userDataPath: string): string {
  return join(userDataPath, 'self-source-git')
}

export async function readSelfSourceRecord(userDataPath: string): Promise<SelfSourceRecord | null> {
  try {
    const raw = JSON.parse(await readFile(stateFile(userDataPath), 'utf8')) as Partial<SelfSourceRecord>
    const revision = typeof raw.revision === 'string' ? raw.revision : ''
    if (!/^[a-f0-9]{40}$/i.test(revision)) return null
    return {
      gitUrl: typeof raw.gitUrl === 'string' ? raw.gitUrl : '',
      gitRef: normalizeGitRef(raw.gitRef),
      gitPath: typeof raw.gitPath === 'string' ? normalizeGitPath(raw.gitPath) : '',
      revision,
      tipRevision: typeof raw.tipRevision === 'string' ? raw.tipRevision : revision,
      committedAt: typeof raw.committedAt === 'string' ? raw.committedAt : '',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '',
      behind: typeof raw.behind === 'number' ? raw.behind : null,
    }
  } catch {
    return null
  }
}

async function writeSelfSourceRecord(userDataPath: string, record: SelfSourceRecord): Promise<void> {
  const target = stateFile(userDataPath)
  await mkdir(userDataPath, { recursive: true })
  const temp = `${target}.tmp`
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`)
  await rename(temp, target)
}

/**
 * Extract one commit (optionally a subdirectory) into a cache directory. The
 * marker file makes a half-written extraction retryable instead of trusted.
 */
export async function extractGitTree(options: {
  repo: string
  revision: string
  gitPath: string
  target: string
}): Promise<{ ok: boolean; error?: string }> {
  const marker = join(options.target, '.pilot-base.json')
  if (existsSync(marker)) return { ok: true }
  await rm(options.target, { recursive: true, force: true })
  await mkdir(options.target, { recursive: true })
  const paths = options.gitPath ? ['--', options.gitPath] : []
  const archive = spawnSync('git', ['archive', '--format=tar', options.revision, ...paths], {
    cwd: options.repo,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  })
  if (archive.status !== 0 || !archive.stdout?.length) {
    await rm(options.target, { recursive: true, force: true })
    return {
      ok: false,
      error: sanitizeGitOutput(
        ((archive.stderr ?? '') || archive.error?.message || 'git archive 没有输出任何内容').toString(),
      ),
    }
  }
  const depth = options.gitPath ? options.gitPath.split('/').filter(Boolean).length : 0
  const tarArgs = depth ? ['-x', '--strip-components', String(depth)] : ['-x']
  // Extract with the target as cwd instead of `-C <path>`: on Windows the path
  // contains backslashes, which tar reads as escapes.
  const tar = spawnSync('tar', tarArgs, {
    cwd: options.target,
    input: archive.stdout,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  })
  if (tar.status !== 0) {
    await rm(options.target, { recursive: true, force: true })
    return {
      ok: false,
      error: sanitizeGitOutput(
        ((tar.stderr ?? '') || tar.error?.message || 'tar 解包失败').toString(),
      ),
    }
  }
  await writeFile(
    marker,
    `${JSON.stringify({ revision: options.revision, gitPath: options.gitPath }, null, 2)}\n`,
  )
  return { ok: true }
}

function baseDir(userDataPath: string, revision: string, gitPath: string): string {
  const key = createHash('sha256').update(`${revision}\0${gitPath}`).digest('hex').slice(0, 12)
  return join(basesRoot(userDataPath), `${revision.slice(0, 12)}-${key}`)
}

/**
 * Default official remote. Packaged builds ship `self-source-git.json` produced
 * by `scripts/prepare-self-source.mjs` from the checkout that was built; dev
 * runs read the current repository instead.
 */
export async function loadSelfSourceDefaults(ctx: {
  packaged: boolean
  appPath: string
  resourcesPath: string
}): Promise<SelfSourceDefaults> {
  if (ctx.packaged) {
    try {
      const raw = JSON.parse(
        await readFile(join(ctx.resourcesPath, 'self-source-git.json'), 'utf8'),
      ) as Partial<SelfSourceDefaults>
      return {
        gitUrl: normalizeGitUrl(raw.gitUrl),
        gitRef: normalizeGitRef(raw.gitRef),
        gitPath: normalizeGitPath(raw.gitPath),
      }
    } catch {
      return { gitUrl: '', gitRef: 'main', gitPath: '' }
    }
  }
  const top = runGit(['rev-parse', '--show-toplevel'], ctx.appPath)
  const remote = top.ok ? runGit(['remote', 'get-url', 'origin'], top.stdout) : { ok: false, stdout: '' }
  const gitPath = top.ok
    ? relative(top.stdout, ctx.appPath).split(sep).join('/')
    : ''
  // The checked-out branch instead of a hardcoded `main`: a repository whose
  // `main` predates this client directory would default to a ref that cannot
  // produce a baseline.
  const branch = top.ok
    ? runGit(['rev-parse', '--abbrev-ref', 'HEAD'], top.stdout)
    : { ok: false, stdout: '' }
  return {
    gitUrl: normalizeGitUrl(remote.ok ? remote.stdout : ''),
    gitRef: normalizeGitRef(branch.ok ? branch.stdout : ''),
    gitPath: normalizeGitPath(gitPath),
  }
}

export function effectiveSettings(
  settings: SelfSourceSettings,
  defaults: SelfSourceDefaults,
): SelfSourceSettings {
  return {
    mode: settings.mode,
    gitUrl: settings.gitUrl || defaults.gitUrl,
    gitRef: settings.gitRef || defaults.gitRef,
    gitPath: settings.gitPath || defaults.gitPath,
    customPath: settings.customPath,
  }
}

/**
 * Closure is a property of the baseline, not of the UI: a real commit from the
 * official remote, current with that remote, and produced by git rather than by
 * copying the installer payload.
 */
export function decideClosure(input: {
  gitAvailable: boolean
  baseKind: SourceBaseKind
  revision: string
  behind: number | null
  error?: string
}): { closed: boolean; reason: string } {
  if (input.error) return { closed: false, reason: input.error }
  if (!input.gitAvailable) {
    return { closed: false, reason: '未检测到 git，基线无法对应官方提交' }
  }
  if (input.baseKind === 'installer-copy') {
    return {
      closed: false,
      reason: '基线是安装包内的源码快照，尚未绑定官方提交；配置官方 git 后同步一次即可闭环',
    }
  }
  if (!input.revision) {
    return { closed: false, reason: '基线还没有对应的提交，请先同步官方仓库' }
  }
  const short = input.revision.slice(0, 12)
  if (input.baseKind === 'custom-git') {
    // A custom checkout is closed once its commit is pinned: that commit *is*
    // the code the user builds and tests against. Whether it trails the
    // official branch is information, not a reason to call the loop open.
    const drift =
      input.behind && input.behind > 0 ? `（比远端分支早 ${input.behind} 个提交）` : ''
    return {
      closed: true,
      reason: `以你仓库的提交 ${short} 为基线${drift}，改动与构建都针对这个提交，进化闭环成立`,
    }
  }
  if (input.behind === null) {
    return { closed: false, reason: `基线 ${short} 已固定，但还没和官方仓库比对过新旧` }
  }
  if (input.behind > 0) {
    return {
      closed: false,
      reason: `官方已有 ${input.behind} 个新提交，基线还停在 ${short}；同步后即可用最新官方代码合并`,
    }
  }
  return { closed: true, reason: `基线对应官方提交 ${short}，与远端一致，进化闭环成立` }
}

function commitInfo(repo: string, revision: string): { committedAt: string; summary: string } {
  const result = runGit(['show', '-s', '--format=%cI%n%s', revision], repo)
  if (!result.ok) return { committedAt: '', summary: '' }
  const [committedAt = '', ...rest] = result.stdout.split('\n')
  return { committedAt: committedAt.trim(), summary: rest.join(' ').trim() }
}

/** Commits in `tip` that `revision` does not contain; null when unrelated. */
export function commitsBehind(repo: string, revision: string, tip: string): number | null {
  if (!revision || !tip) return null
  if (revision === tip) return 0
  const ancestor = runGit(['merge-base', '--is-ancestor', revision, tip], repo)
  if (!ancestor.ok) return null
  const count = runGit(['rev-list', '--count', `${revision}..${tip}`], repo)
  const parsed = Number.parseInt(count.stdout, 10)
  return count.ok && Number.isFinite(parsed) ? parsed : null
}

interface ResolvedBase {
  basePath: string
  baseKind: SourceBaseKind
  revision: string
  committedAt: string
  summary: string
  behind: number | null
  error?: string
}

const NO_BASE: ResolvedBase = {
  basePath: '',
  baseKind: 'none',
  revision: '',
  committedAt: '',
  summary: '',
  behind: null,
}

/**
 * Baseline for a repository the user (or this app) already has locally. No
 * network: only objects that are present are used.
 */
async function resolveLocalBase(options: {
  repo: string
  gitPath: string
  ref: string
  userDataPath: string
  behind: number | null
  /** A custom checkout is measured against its own checked-out commit. */
  preferRemote?: boolean
}): Promise<ResolvedBase> {
  const baseRef = resolveBaseRef(options.repo, options.ref, options.gitPath, options.preferRemote ?? true)
  if (!baseRef) {
    return {
      ...NO_BASE,
      error: options.gitPath
        ? `仓库里没有包含 ${options.gitPath} 的提交，请检查仓库内路径与分支`
        : '仓库里找不到可用的分支或提交',
    }
  }
  const revision = gitRevision(options.repo, baseRef)
  if (!revision) return { ...NO_BASE, error: '无法解析官方提交' }
  const target = baseDir(options.userDataPath, revision, options.gitPath)
  const extracted = await extractGitTree({
    repo: options.repo,
    revision,
    gitPath: options.gitPath,
    target,
  })
  if (!extracted.ok) {
    return {
      ...NO_BASE,
      error: `无法从该提交导出官方源码树：${extracted.error ?? '未知错误'}`,
    }
  }
  const info = commitInfo(options.repo, revision)
  return {
    basePath: target,
    baseKind: 'official-git',
    revision,
    committedAt: info.committedAt,
    summary: info.summary,
    behind: options.behind,
  }
}

function baseKindFor(mode: SelfSourceMode): SourceBaseKind {
  return mode === 'custom' ? 'custom-git' : 'official-git'
}

function buildProvenance(
  ctx: SelfSourceContext,
  settings: SelfSourceSettings,
  base: ResolvedBase,
  sourcePath: string,
  record: SelfSourceRecord | null,
): SourceProvenance {
  const gitAvailable = gitChecked === true
  const baseKind = base.baseKind === 'official-git' ? baseKindFor(settings.mode) : base.baseKind
  const closure = decideClosure({
    gitAvailable,
    baseKind,
    revision: base.revision,
    behind: base.behind,
    ...(base.error ? { error: base.error } : {}),
  })
  return {
    mode: settings.mode,
    sourcePath,
    basePath: base.basePath,
    baseKind,
    baseReadOnly: true,
    gitUrl: settings.gitUrl,
    gitRef: settings.gitRef,
    gitPath: settings.gitPath,
    customPath: settings.customPath,
    revision: base.revision,
    committedAt: base.committedAt,
    summary: base.summary,
    behind: base.behind,
    fetchedAt: record?.fetchedAt ?? '',
    gitAvailable,
    closed: closure.closed,
    reason: closure.reason,
    ...(base.error ? { error: base.error } : {}),
  }
}

function clientRoot(repo: string, gitPath: string): string {
  if (gitPath) {
    const candidate = join(repo, ...gitPath.split('/').filter(Boolean))
    if (existsSync(candidate)) return candidate
  }
  return repo
}

/**
 * Resolve source + baseline for the current settings without touching the
 * network. Never throws: a broken configuration degrades to the installer copy
 * (or the plain working tree) and reports why in `reason`.
 */
export async function resolveSelfSource(
  ctx: SelfSourceContext,
): Promise<{ sourcePath: string; basePath: string; baseReadOnly: boolean; provenance: SourceProvenance }> {
  const defaults = await loadSelfSourceDefaults(ctx)
  const settings = effectiveSettings(normalizeSelfSourceSettings(ctx.settings), defaults)
  await isGitAvailable()
  const record = await readSelfSourceRecord(ctx.userDataPath)
  const builtinSource = ctx.packaged ? join(ctx.userDataPath, 'self-src') : ctx.appPath

  if (settings.mode === 'custom') {
    const customPath = settings.customPath
    if (!customPath) {
      const base = { ...NO_BASE, error: '还没有选择自定义源码目录' }
      return {
        sourcePath: builtinSource,
        basePath: '',
        baseReadOnly: true,
        provenance: buildProvenance(ctx, settings, base, builtinSource, record),
      }
    }
    if (!existsSync(customPath)) {
      const base = { ...NO_BASE, error: '自定义源码目录不存在' }
      return {
        sourcePath: customPath,
        basePath: '',
        baseReadOnly: true,
        provenance: buildProvenance(ctx, settings, base, customPath, record),
      }
    }
    const isRepo = isGitRepository(customPath)
    if (!isRepo) {
      const base = {
        ...NO_BASE,
        error: '自定义源码不是 git 仓库：没有基线就无法判断你改了哪些文件',
      }
      return {
        sourcePath: customPath,
        basePath: '',
        baseReadOnly: false,
        provenance: buildProvenance(ctx, settings, base, customPath, record),
      }
    }
    const sourcePath = clientRoot(customPath, settings.gitPath)
    // The baseline is the checked-out commit, so "behind" only describes how far
    // the user's branch trails the remote branch — it never invalidates it.
    const head = gitRevision(customPath, 'HEAD')
    const remoteTip = gitRevision(customPath, `origin/${settings.gitRef}`)
    const behind = head && remoteTip ? commitsBehind(customPath, head, remoteTip) : null
    const base = await resolveLocalBase({
      repo: customPath,
      gitPath: settings.gitPath,
      ref: settings.gitRef,
      userDataPath: ctx.userDataPath,
      behind,
      preferRemote: false,
    })
    return {
      sourcePath,
      basePath: base.basePath,
      baseReadOnly: false,
      provenance: buildProvenance(ctx, settings, base, sourcePath, record),
    }
  }

  // Built-in source: prefer a synced official baseline, then (in development)
  // the checkout we are running from, and only then the installer snapshot.
  const sameRecord =
    record !== null &&
    record.gitUrl === settings.gitUrl &&
    record.gitPath === settings.gitPath &&
    record.gitRef === settings.gitRef
  if (sameRecord) {
    const cached = baseDir(ctx.userDataPath, record.revision, record.gitPath)
    if (existsSync(join(cached, '.pilot-base.json'))) {
      const base: ResolvedBase = {
        basePath: cached,
        baseKind: 'official-git',
        revision: record.revision,
        committedAt: record.committedAt,
        summary: record.summary,
        behind: record.behind,
      }
      return {
        sourcePath: builtinSource,
        basePath: base.basePath,
        baseReadOnly: true,
        provenance: buildProvenance(ctx, settings, base, builtinSource, record),
      }
    }
  }

  if (!ctx.packaged && isGitRepository(ctx.appPath)) {
    const base = await resolveLocalBase({
      repo: ctx.appPath,
      gitPath: settings.gitPath,
      ref: settings.gitRef,
      userDataPath: ctx.userDataPath,
      behind: sameRecord ? (record?.behind ?? null) : null,
    })
    if (!base.error) {
      return {
        sourcePath: builtinSource,
        basePath: base.basePath,
        baseReadOnly: true,
        provenance: buildProvenance(ctx, settings, base, builtinSource, record),
      }
    }
  }

  const installer = join(ctx.resourcesPath, 'source')
  const base: ResolvedBase = existsSync(join(installer, 'package.json'))
    ? {
        basePath: installer,
        baseKind: 'installer-copy',
        revision: '',
        committedAt: '',
        summary: '',
        behind: null,
      }
    : NO_BASE
  return {
    sourcePath: builtinSource,
    basePath: base.basePath,
    baseReadOnly: true,
    provenance: buildProvenance(ctx, settings, base, builtinSource, record),
  }
}

function fetchOfficial(repo: string, settings: SelfSourceSettings): { ok: boolean; error?: string } {
  const mapping = `+refs/heads/${settings.gitRef}:refs/remotes/origin/${settings.gitRef}`
  const result = runGit(['fetch', '--no-tags', '--prune', 'origin', mapping], repo, FETCH_TIMEOUT_MS)
  if (result.ok) return { ok: true }
  // Tags and some servers only accept a plain refspec.
  const plain = runGit(['fetch', '--no-tags', 'origin', settings.gitRef], repo, FETCH_TIMEOUT_MS)
  return plain.ok
    ? { ok: true }
    : { ok: false, error: `拉取官方仓库失败：${result.stderr || plain.stderr || '未知错误'}` }
}

async function ensureBareRepo(repo: string, gitUrl: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(join(repo, 'config'))) {
    await mkdir(repo, { recursive: true })
    const init = runGit(['init', '--bare', '--quiet'], repo)
    if (!init.ok) return { ok: false, error: `无法初始化源码仓库：${init.stderr}` }
  }
  const existing = runGit(['remote', 'get-url', 'origin'], repo)
  const set = existing.ok
    ? runGit(['remote', 'set-url', 'origin', gitUrl], repo)
    : runGit(['remote', 'add', 'origin', gitUrl], repo)
  return set.ok ? { ok: true } : { ok: false, error: `无法设置官方地址：${set.stderr}` }
}

/**
 * Point the baseline at the newest commit of the official remote. This is the
 * only step that uses the network, and it is always user-initiated.
 */
export async function syncSelfSource(ctx: SelfSourceContext): Promise<SourceProvenance> {
  const defaults = await loadSelfSourceDefaults(ctx)
  const settings = effectiveSettings(normalizeSelfSourceSettings(ctx.settings), defaults)
  const gitAvailable = await isGitAvailable()
  const sourcePathForSync =
    settings.mode === 'custom'
      ? clientRoot(settings.customPath, settings.gitPath)
      : ctx.packaged
        ? join(ctx.userDataPath, 'self-src')
        : ctx.appPath

  const fail = (error: string): Promise<SourceProvenance> =>
    Promise.resolve(
      buildProvenance(
        ctx,
        settings,
        { ...NO_BASE, error },
        sourcePathForSync,
        null,
      ),
    )

  if (!gitAvailable) return fail('本机没有可用的 git，无法把基线固定到官方提交')

  const repo =
    settings.mode === 'custom'
      ? settings.customPath
      : ctx.packaged
        ? officialRepoPath(ctx.userDataPath)
        : ctx.appPath

  if (!repo) return fail('还没有选择自定义源码目录')
  if (settings.mode === 'custom' && !existsSync(repo)) {
    return fail('自定义源码目录不存在')
  }

  if (settings.mode === 'builtin') {
    if (!settings.gitUrl) {
      return fail('还没有配置官方 git 地址；填好后同步一次即可闭环')
    }
    if (ctx.packaged) {
      const prepared = await ensureBareRepo(repo, settings.gitUrl)
      if (!prepared.ok) return fail(prepared.error ?? '无法准备官方仓库')
    }
    const fetched = fetchOfficial(repo, settings)
    if (!fetched.ok) return fail(fetched.error ?? '拉取官方仓库失败')
  } else if (!isGitRepository(repo)) {
    return fail('自定义源码不是 git 仓库（缺少 .git）')
  }

  const baseRef = resolveBaseRef(
    repo,
    settings.gitRef,
    settings.gitPath,
    settings.mode === 'builtin',
  )
  if (!baseRef) {
    const hint = settings.mode === 'builtin' ? refsContainingPath(repo, settings.gitPath) : []
    return fail(
      `${settings.gitRef} 里没有 ${settings.gitPath || '仓库根目录'}` +
        (hint.length
          ? `；包含该目录的远端分支有 ${hint.join('、')}，把分支改成其中一个再同步`
          : '，请检查真实仓库的目录结构'),
    )
  }
  const revision = gitRevision(repo, baseRef)
  if (!revision) return fail('无法解析官方提交')

  const target = baseDir(ctx.userDataPath, revision, settings.gitPath)
  const extracted = await extractGitTree({
    repo,
    revision,
    gitPath: settings.gitPath,
    target,
  })
  if (!extracted.ok) {
    return fail(
      settings.gitPath
        ? `官方仓库的 ${settings.gitPath} 目录导出失败：${extracted.error ?? '未知错误'}`
        : `无法导出官方源码树：${extracted.error ?? '未知错误'}`,
    )
  }

  const previous = await readSelfSourceRecord(ctx.userDataPath)
  const behind =
    previous && previous.gitUrl === settings.gitUrl && previous.gitRef === settings.gitRef
      ? commitsBehind(repo, previous.revision, revision)
      : 0
  const info = commitInfo(repo, revision)
  const record: SelfSourceRecord = {
    gitUrl: settings.gitUrl,
    gitRef: settings.gitRef,
    gitPath: settings.gitPath,
    revision,
    tipRevision: revision,
    committedAt: info.committedAt,
    summary: info.summary,
    fetchedAt: new Date().toISOString(),
    behind,
  }
  await writeSelfSourceRecord(ctx.userDataPath, record)

  const base: ResolvedBase = {
    basePath: target,
    baseKind: 'official-git',
    revision,
    committedAt: info.committedAt,
    summary: info.summary,
    behind,
  }
  return buildProvenance(ctx, settings, base, sourcePathForSync, record)
}
