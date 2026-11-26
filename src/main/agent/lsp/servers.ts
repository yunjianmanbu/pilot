// 语言规格与 language server 发现。
//
// 设计约束：
// 1. 不加 npm 依赖 —— Pilot 不捆绑任何 language server，也不引入 LSP 客户端库。
//    server 从「工作区自己的 node_modules/.bin」或 PATH 上找，找不到就由调用方降级。
// 2. Windows 上的 `pyright-langserver` / `jdtls` 是 .cmd / .bat shim，Node 不能直接
//    spawn（shell:false 会 EINVAL），必须显式解析后交给 cmd.exe。这里复用
//    agent/processes.ts 的同一套做法。
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export type LanguageId =
  | 'typescript'
  | 'python'
  | 'go'
  | 'java'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'ruby'
  | 'php'
  | 'csharp'

export interface ServerCandidate {
  /** Executable looked up in node_modules/.bin first, then PATH. */
  command: string
  args: string[]
  /** Shown to the model when nothing is installed. */
  install: string
}

export interface LanguageSpec {
  id: LanguageId
  /** Lower-case extensions without the dot. */
  extensions: string[]
  servers: ServerCandidate[]
  /** Human name used in messages. */
  label: string
}

/** Found server, ready to spawn. */
export interface ResolvedServer {
  language: LanguageId
  command: string
  args: string[]
  install: string
}

export const LANGUAGES: LanguageSpec[] = [
  {
    id: 'python',
    label: 'Python',
    extensions: ['py', 'pyi'],
    servers: [
      {
        command: 'pyright-langserver',
        args: ['--stdio'],
        install: 'npm i -D pyright   (or: pip install pyright)',
      },
      {
        command: 'pylsp',
        args: [],
        install: 'pip install python-lsp-server',
      },
    ],
  },
  {
    id: 'go',
    label: 'Go',
    extensions: ['go'],
    servers: [
      {
        command: 'gopls',
        args: [],
        install: 'go install golang.org/x/tools/gopls@latest',
      },
    ],
  },
  {
    id: 'java',
    label: 'Java',
    extensions: ['java'],
    servers: [
      {
        command: 'jdtls',
        args: ['-data', '.'],
        install:
          'download eclipse.jdt.ls (https://download.eclipse.org/jdtls/) and put its bin/jdtls on PATH',
      },
    ],
  },
  {
    id: 'rust',
    label: 'Rust',
    extensions: ['rs'],
    servers: [
      {
        command: 'rust-analyzer',
        args: [],
        install: 'rustup component add rust-analyzer',
      },
    ],
  },
  {
    id: 'c',
    label: 'C',
    extensions: ['c', 'h'],
    servers: [{ command: 'clangd', args: [], install: 'install clangd (LLVM release)' }],
  },
  {
    id: 'cpp',
    label: 'C++',
    extensions: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
    servers: [{ command: 'clangd', args: [], install: 'install clangd (LLVM release)' }],
  },
  {
    id: 'ruby',
    label: 'Ruby',
    extensions: ['rb'],
    servers: [{ command: 'solargraph', args: ['stdio'], install: 'gem install solargraph' }],
  },
  {
    id: 'php',
    label: 'PHP',
    extensions: ['php'],
    servers: [
      { command: 'intelephense', args: ['--stdio'], install: 'npm i -g intelephense' },
    ],
  },
  {
    id: 'csharp',
    label: 'C#',
    extensions: ['cs'],
    servers: [
      { command: 'omnisharp', args: ['-lsp'], install: 'install OmniSharp (omnisharp-roslyn)' },
    ],
  },
]

const BY_EXTENSION = new Map<string, LanguageSpec>()
for (const spec of LANGUAGES) {
  for (const ext of spec.extensions) BY_EXTENSION.set(ext, spec)
}

/** Extensions handled by the in-process TypeScript engine, not by an LSP server. */
export const TS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])

export function extensionOf(file: string): string {
  const clean = file.split('\\').join('/')
  const base = clean.slice(clean.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Language for a file path, or null when Pilot has no engine for it. */
export function languageForFile(file: string): LanguageSpec | null {
  return BY_EXTENSION.get(extensionOf(file)) ?? null
}

export function languageById(id: LanguageId): LanguageSpec | null {
  return LANGUAGES.find((spec) => spec.id === id) ?? null
}

/** True when the in-process TypeScript engine can answer for this path. */
export function isTypeScriptFile(file: string): boolean {
  return TS_EXTENSIONS.has(extensionOf(file))
}

function exists(file: string): boolean {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

function whichSync(command: string): string[] {
  if (/[\\/]/.test(command)) return exists(command) ? [command] : []
  if (process.platform === 'win32') {
    const where = process.env['SystemRoot']
      ? join(process.env['SystemRoot'], 'System32', 'where.exe')
      : 'where.exe'
    try {
      const result = spawnSync(where, [command], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
        windowsVerbatimArguments: false,
      })
      if (result.error || result.status !== 0) return []
      return String(result.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }
  try {
    const result = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], {
      encoding: 'utf8',
      timeout: 3_000,
    })
    if (result.error || result.status !== 0) return []
    const line = String(result.stdout ?? '').trim()
    return line ? [line] : []
  } catch {
    return []
  }
}

/** npm/pnpm install the Windows launchers as `.cmd` shims next to the script. */
const SHIM_SUFFIXES = process.platform === 'win32' ? ['', '.cmd', '.bat', '.exe'] : ['']

function moduleBinDirs(root: string): string[] {
  const dirs: string[] = []
  let current = resolve(root)
  for (let depth = 0; depth < 3; depth += 1) {
    dirs.push(join(current, 'node_modules', '.bin'))
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return dirs
}

function findInProjectBins(root: string, command: string): string | null {
  for (const dir of moduleBinDirs(root)) {
    for (const suffix of SHIM_SUFFIXES) {
      const candidate = join(dir, `${command}${suffix}`)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

function findOnPath(command: string): string | null {
  const hits = whichSync(command)
  if (hits.length === 0) return null
  if (process.platform !== 'win32') return hits[0] ?? null
  // Prefer a real .exe over a shim only when both exist; shims are fine too.
  return hits.find((hit) => /\.exe$/i.test(hit)) ?? hits[0] ?? null
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '')}"`
}

export interface LaunchSpec {
  file: string
  args: string[]
  /**
   * True when `args` is already a finished cmd.exe command line.
   *
   * Node would otherwise re-escape it with MSVCRT rules, turning
   * `"C:\x.cmd" "--stdio"` into `\"C:\x.cmd\" \"--stdio\"`; cmd.exe then looks
   * for a program whose name contains the quotes and fails with "not recognized
   * as an internal or external command". Node's own `shell: true` path sets the
   * same flag for the same reason.
   */
  verbatim: boolean
}

/**
 * Turn an absolute launcher path into spawn(file, args).
 *
 * `.cmd` / `.bat` cannot be spawned with shell:false on Windows (Node refuses since
 * the CVE-2024-27980 fix), so route them through cmd.exe with every argument quoted
 * and the whole line marked verbatim.
 */
export function launchFor(file: string, args: string[]): LaunchSpec {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) {
    return { file, args, verbatim: false }
  }
  const line = [file, ...args].map(quoteCmd).join(' ')
  return { file: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/**
 * Resolve a language server for `root`.
 *
 * `root` only affects the node_modules/.bin probe (a project-local
 * `npm i -D pyright` wins over a global install), not PATH lookup order.
 */
export function findServer(root: string, language: LanguageSpec): ResolvedServer | null {
  for (const candidate of language.servers) {
    const projectHit = findInProjectBins(root, candidate.command)
    if (projectHit) {
      return {
        language: language.id,
        command: projectHit,
        args: candidate.args,
        install: candidate.install,
      }
    }
    const pathHit = findOnPath(candidate.command)
    if (pathHit) {
      return {
        language: language.id,
        command: pathHit,
        args: candidate.args,
        install: candidate.install,
      }
    }
  }
  return null
}

/** Install hints for every server that could serve this language, one per line. */
export function installHints(language: LanguageSpec): string {
  return language.servers.map((candidate) => `${candidate.command}: ${candidate.install}`).join('; ')
}

/** Cached discovery, keyed by root + language. Missing entries are cached as null. */
const discovery = new Map<string, ResolvedServer | null>()

export function discoverServer(root: string, language: LanguageSpec): ResolvedServer | null {
  const key = `${process.platform === 'win32' ? root.toLowerCase() : root}::${language.id}`
  // PATH contents can change while Pilot is open (user installs a server), but a
  // cheap re-probe on every call is the whole point of this tool. Cache only hits.
  const cached = discovery.get(key)
  if (cached) return cached
  const found = findServer(root, language)
  if (found) discovery.set(key, found)
  return found
}

/** Tests only: forget discovery results so install state can be re-probed. */
export function resetServerDiscovery(): void {
  discovery.clear()
}

/** Directories that are never worth scanning for source files. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  'release',
  'unpackage',
  '.pilot',
  '.build',
  'tmp',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  'vendor',
  'target',
  '__pycache__',
  '.cache',
  '.idea',
  '.gradle',
  '.mvn',
])

export interface ScanResult {
  /** Absolute paths, workspace sources only. */
  files: string[]
  truncated: boolean
  /** Extension → file count, most common first. */
  byExtension: Array<{ ext: string; count: number }>
}

/**
 * Collect source files whose extension is in `extensions` under `root`.
 *
 * Bounded by `limit` files and depth 14 so a huge repo cannot stall a query.
 * Async on purpose: this runs on the Electron main process, which must stay
 * responsive while a query walks a large tree.
 */
export async function scanSources(
  root: string,
  extensions: ReadonlySet<string>,
  limit: number,
): Promise<ScanResult> {
  const files: string[] = []
  const counts = new Map<string, number>()
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > 14) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const name = entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        await walk(join(dir, name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extensionOf(name)
      if (!ext || !extensions.has(ext)) continue
      if (files.length >= limit) {
        truncated = true
        return
      }
      counts.set(ext, (counts.get(ext) ?? 0) + 1)
      files.push(join(dir, name))
    }
  }
  await walk(root, 0)

  const byExtension = [...counts.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count)
  return { files, truncated, byExtension }
}
