import { spawn, type ChildProcess } from 'node:child_process'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileNode, FilePreview, ShellInterpreter } from '../shared/types'
import { MEDIA_SCHEME, previewKindOf, type PreviewKind } from '../shared/media'
import { createUnifiedDiff } from './agent/diff'
import { buildSandboxPlan } from './sandbox'
import { gitBashLoginEnvironment, resolveShellLaunch } from './shell'
import { diskSpace, diskWarning } from './system-info'

const MAX_READ_BYTES = 2 * 1024 * 1024
/** Mobile file previews pull binary files (docx/pdf/images) in base64 chunks. */
export const MAX_FILE_CHUNK_BYTES = 256 * 1024
/** Phone uploads arrive chunk by chunk over the relay; keep each one bounded. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_UPLOAD_CHUNK_BYTES = 256 * 1024
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
const UPLOAD_NAME_MAX = 180
const DEFAULT_FILE_CHUNK_BYTES = 128 * 1024
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
// Command output enters the model context. 16KB is enough for ordinary build
// and test logs; truncation keeps the head and tail and reports the omitted
// size, so a narrow follow-up command is cheaper than replaying a 32KB dump.
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024
const MAX_LIST_ENTRIES = 800

export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'release',
  '.turbo',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.pilot',
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.sh': 'shell',
  '.bash': 'shell',
  '.ps1': 'powershell',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.sql': 'sql',
  '.xml': 'xml',
  '.svg': 'xml',
  '.graphql': 'graphql',
}

function normalize(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

export function assertInside(root: string, target: string): void {
  const rel = relative(normalize(root), normalize(target))
  if (rel === '') return
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Path escapes the selected workspace')
  }
}

function requestPath(input: unknown): string {
  if (typeof input !== 'string' || !input) return '.'
  if (input.includes('\0')) throw new Error('Path contains an invalid character')
  if (isAbsolute(input)) throw new Error('Only workspace-relative paths are allowed')
  return input
}

export async function workspaceRoot(root: string): Promise<string> {
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('Workspace is not a directory')
  return realpath(root)
}

export async function resolveExisting(root: string, input: unknown): Promise<string> {
  const base = await workspaceRoot(root)
  const target = resolve(base, requestPath(input))
  assertInside(base, target)
  let resolved: string
  try {
    resolved = await realpath(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // The raw realpath error only names an absolute path. State both the
      // requested path and the workspace root so the model can correct it
      // instead of re-reading the same wrong path.
      throw new Error(
        `Path does not exist: ${requestPath(input)} (current workspace: ${base}). Check the spelling and the current directory.`,
      )
    }
    throw error
  }
  assertInside(base, resolved)
  return resolved
}

async function resolveForMutation(
  root: string,
  input: unknown,
  symlinkMessage: string,
): Promise<{ base: string; target: string }> {
  const base = await workspaceRoot(root)
  const target = resolve(base, requestPath(input))
  assertInside(base, target)
  let probe = dirname(target)
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      const resolvedParent = await realpath(probe)
      assertInside(base, resolvedParent)
      break
    } catch (error) {
      const next = dirname(probe)
      if (next === probe) throw error
      probe = next
    }
  }
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error(symlinkMessage)
  } catch (error) {
    if (error instanceof Error && error.message === symlinkMessage) throw error
  }
  return { base, target }
}

export async function resolveForWrite(root: string, input: unknown): Promise<string> {
  return (await resolveForMutation(root, input, 'Writing through a symbolic link is not allowed')).target
}

export function languageFor(filePath: string): string {
  const name = basename(filePath).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  return LANGUAGE_BY_EXTENSION[extname(name)] ?? 'plaintext'
}

/** Upper-case extension chip shown beside the size for streamed previews. */
export function formatLabel(filePath: string): string {
  const ext = extname(filePath).replace(/^\./, '')
  return ext ? ext.slice(0, 6).toUpperCase() : 'FILE'
}

function fileLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000))
  return sample.includes(0)
}

export async function listDirectory(root: string, path = '.'): Promise<FileNode[]> {
  const target = await resolveExisting(root, path)
  const info = await stat(target)
  if (!info.isDirectory()) throw new Error('Target is not a directory')
  const base = await workspaceRoot(root)
  const entries = await readdir(target, { withFileTypes: true })
  const nodes: FileNode[] = []
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || SKIP_DIRS.has(entry.name)) continue
    if (entry.isSymbolicLink()) continue
    const absolute = join(target, entry.name)
    const rel = toPosix(relative(base, absolute))
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: rel, type: 'dir' })
    } else if (entry.isFile()) {
      let size: number | undefined
      try {
        size = (await stat(absolute)).size
      } catch {
        size = undefined
      }
      nodes.push({ name: entry.name, path: rel, type: 'file', ...(size !== undefined ? { size } : {}) })
    }
    if (nodes.length >= 500) break
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

export async function listDirectoryTree(
  root: string,
  path = '.',
  depthInput = 1,
): Promise<string> {
  const target = await resolveExisting(root, path)
  const info = await stat(target)
  if (!info.isDirectory()) throw new Error('Target is not a directory')
  const base = await workspaceRoot(root)
  const depth = Math.min(4, Math.max(1, Number(depthInput) || 1))
  const lines: string[] = []
  const visit = async (dir: string, level: number, prefix: string): Promise<void> => {
    if (lines.length >= MAX_LIST_ENTRIES) return
    const entries = await readdir(dir, { withFileTypes: true })
    const sorted = entries
      .filter((entry) => !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name) && entry.name !== '.DS_Store')
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    for (const entry of sorted) {
      if (lines.length >= MAX_LIST_ENTRIES) return
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`)
        if (level + 1 < depth) {
          await visit(absolute, level + 1, `${prefix}  `)
        }
      } else if (entry.isFile()) {
        lines.push(`${prefix}${entry.name}`)
      }
    }
  }
  await visit(target, 0, '')
  const header = toPosix(relative(base, target)) || '.'
  return `${header}${lines.length > 0 ? '\n' : ''}${lines.join('\n')}`
}

const PROJECT_MAP_MAX_FILES = 40_000
const PROJECT_MAP_MAX_OUTPUT = 12_000
const PROJECT_MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'pubspec.yaml',
  'tauri.conf.json',
  'androidmanifest.xml',
])
const PROJECT_CONFIG_PATTERN =
  /^(tsconfig.*\.json|jsconfig\.json|vite\.config\..+|vitest\.config\..+|jest\.config\..+|playwright\.config\..+|cypress\.config\..+|electron\.vite\.config\..+|electron-builder\.(yml|yaml|json)|next\.config\..+|nuxt\.config\..+|webpack\.config\..+|rollup\.config\..+|eslint\.config\..+|\.eslintrc.*|prettier\.config\..+|\.prettierrc.*|biome\.json|dockerfile|docker-compose.*|makefile|cmakelists\.txt|\.editorconfig|\.gitignore|\.npmrc|pnpm-workspace\.yaml|turbo\.json)$/i
const PROJECT_ENTRY_CANDIDATES = [
  'src/main/index.ts',
  'src/main/index.js',
  'src/main/main.ts',
  'src/index.ts',
  'src/index.tsx',
  'src/index.js',
  'src/index.jsx',
  'index.ts',
  'index.tsx',
  'index.js',
  'main.ts',
  'main.js',
  'app.ts',
  'app.js',
  'app.py',
  'main.py',
  'manage.py',
  'src-tauri/src/main.rs',
  'src-tauri/tauri.conf.json',
  'android/app/src/main/AndroidManifest.xml',
  'electron.vite.config.ts',
  'vite.config.ts',
]
const PROJECT_TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e'])
const PROJECT_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.scala',
  '.sh',
  '.ps1',
  '.lua',
  '.dart',
  '.vue',
  '.svelte',
])
const PROJECT_MAP_KEY_FILES = 48

function formatProjectSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function manifestDetail(name: string, text: string): string {
  const lower = name.toLowerCase()
  try {
    if (lower === 'package.json') {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const title =
        typeof parsed['name'] === 'string'
          ? `${parsed['name']}${typeof parsed['version'] === 'string' ? `@${parsed['version']}` : ''}`
          : ''
      const scripts =
        parsed['scripts'] && typeof parsed['scripts'] === 'object'
          ? Object.keys(parsed['scripts'] as Record<string, unknown>).slice(0, 8)
          : []
      const bits: string[] = []
      if (title) bits.push(title)
      if (Array.isArray(parsed['workspaces'])) bits.push(`workspaces: ${parsed['workspaces'].length}`)
      if (scripts.length > 0) bits.push(`scripts: ${scripts.join(', ')}`)
      return bits.join(' · ')
    }
    const match = text.match(/^\s*(?:name|module|version)\s*[:=]\s*["']?([^"'\r\n]+)/m)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * One deterministic pass over a project: file counts per top-level directory
 * and extension, manifests, entry points, configs and test layout. It replaces
 * the dozens of list_directory / shell counting calls a model otherwise makes
 * before it can answer an analysis question, and every number comes from the
 * same walk, so counts cannot drift between steps.
 */
export async function projectMap(
  root: string,
  options: { path?: string; maxFiles?: number; depth?: number } = {},
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  const target = await resolveExisting(root, options.path ?? '.')
  const targetInfo = await stat(target)
  if (!targetInfo.isDirectory()) throw new Error('path must be a directory')
  const base = await workspaceRoot(root)
  const maxFiles = Math.min(
    100_000,
    Math.max(100, Math.round(Number(options.maxFiles ?? PROJECT_MAP_MAX_FILES) || PROJECT_MAP_MAX_FILES)),
  )
  const depthLimit = Math.min(
    20,
    Math.max(1, Math.round(Number(options.depth ?? 20) || 20)),
  )

  const tops = new Map<string, { files: number; bytes: number }>()
  const extensions = new Map<string, number>()
  const manifests: string[] = []
  const configs: string[] = []
  const readmes: string[] = []
  const sourceFiles: string[] = []
  let files = 0
  let directories = 0
  let bytes = 0
  let testFiles = 0
  const testDirs = new Set<string>()
  let truncated = false
  let depthTruncated = false

  const relTo = (absolute: string): string => toPosix(relative(base, absolute))
  const visit = async (dir: string, depth: number, top: string): Promise<void> => {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink() || entry.name === '.DS_Store') continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        directories += 1
        const name = entry.name.toLowerCase()
        const relDir = relTo(join(dir, entry.name))
        if (PROJECT_TEST_SEGMENTS.has(name)) testDirs.add(relDir)
        if (depth >= depthLimit) {
          depthTruncated = true
          continue
        }
        await visit(join(dir, entry.name), depth + 1, depth === 0 ? entry.name : top)
        continue
      }
      if (!entry.isFile()) continue
      if (files >= maxFiles) {
        truncated = true
        return
      }
      const absolute = join(dir, entry.name)
      let size = 0
      try {
        size = (await stat(absolute)).size
      } catch {
        size = 0
      }
      files += 1
      bytes += size
      const key = depth === 0 ? '.' : top
      const bucket = tops.get(key) ?? { files: 0, bytes: 0 }
      bucket.files += 1
      bucket.bytes += size
      tops.set(key, bucket)
      const extension = extname(entry.name).toLowerCase()
      if (extension) extensions.set(extension, (extensions.get(extension) ?? 0) + 1)
      const rel = relTo(absolute)
      const lower = entry.name.toLowerCase()
      const inTestDir = rel
        .split('/')
        .slice(0, -1)
        .some((part) => PROJECT_TEST_SEGMENTS.has(part.toLowerCase()))
      if (inTestDir) testFiles += 1
      else if (
        PROJECT_SOURCE_EXTENSIONS.has(extension) &&
        !lower.endsWith('.min.js') &&
        !lower.endsWith('.d.ts')
      ) {
        sourceFiles.push(rel)
      }
      if (PROJECT_MANIFESTS.has(lower)) manifests.push(rel)
      if (PROJECT_CONFIG_PATTERN.test(entry.name)) configs.push(rel)
      if (/^readme(\..+)?$/i.test(entry.name) && readmes.length < 6) readmes.push(rel)
    }
  }

  await visit(target, 0, '.')

  const lines: string[] = []
  const relTarget = relTo(target) || '.'
  lines.push(`Project map: ${relTarget} (workspace ${base})`)
  lines.push(
    `Files: ${files} · Directories: ${directories} · Size: ${formatProjectSize(bytes)}${
      testFiles > 0 ? ` · Test files: ${testFiles}` : ''
    }`,
  )
  if (truncated) lines.push(`Note: stopped at ${maxFiles} files; counts are lower bounds.`)
  if (depthTruncated) lines.push(`Note: stopped descending at depth ${depthLimit}; counts are lower bounds.`)

  const formatTop = (name: string): string => (name === '.' ? '(root files)' : `${name}/`)
  const topLines = [...tops.entries()]
    .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(
      ([name, value]) =>
        `  ${formatTop(name)} — ${value.files} files, ${formatProjectSize(value.bytes)}`,
    )
  if (topLines.length > 0) {
    lines.push('', 'Top-level:', ...topLines)
    if (tops.size > 30) lines.push(`  … ${tops.size - 30} more top-level entries`)
  }

  if (sourceFiles.length > 0) {
    const rank = (value: string): number =>
      !value.includes('/') || /^(src|lib|app|packages|server|client|api|core)\//.test(value) ? 0 : 1
    const keyFiles = [...sourceFiles].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    lines.push(
      '',
      'Key source files:',
      ...keyFiles.slice(0, PROJECT_MAP_KEY_FILES).map((file) => `  ${file}`),
    )
    if (keyFiles.length > PROJECT_MAP_KEY_FILES) {
      lines.push(`  … ${keyFiles.length - PROJECT_MAP_KEY_FILES} more source files (use search_files to locate)`)
    }
  }

  const extLines = [...extensions.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 14)
    .map(([extension, count]) => `${extension} ${count}`)
  if (extLines.length > 0) lines.push('', `By extension: ${extLines.join(', ')}`)

  const packageLines: string[] = []
  const entries = new Set<string>()
  for (const manifest of manifests.slice(0, 40)) {
    let detail = ''
    try {
      const absolute = join(base, manifest)
      const info = await stat(absolute)
      if (info.size <= 512 * 1024) {
        const text = await readFile(absolute, 'utf8')
        detail = manifestDetail(basename(manifest), text)
        if (manifest.endsWith('package.json')) {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>
            for (const field of ['main', 'module']) {
              if (typeof parsed[field] === 'string') {
                const candidate = toPosix(relative(target, resolve(dirname(absolute), parsed[field])))
                if (!candidate.startsWith('..')) entries.add(candidate)
              }
            }
            const bin = parsed['bin']
            if (typeof bin === 'string') {
              const candidate = toPosix(relative(target, resolve(dirname(absolute), bin)))
              if (!candidate.startsWith('..')) entries.add(candidate)
            } else if (bin && typeof bin === 'object') {
              for (const value of Object.values(bin)) {
                if (typeof value !== 'string') continue
                const candidate = toPosix(relative(target, resolve(dirname(absolute), value)))
                if (!candidate.startsWith('..')) entries.add(candidate)
              }
            }
          } catch {
            // A malformed package.json still appears in the map.
          }
        }
      }
    } catch {
      // Keep the manifest path even when reading fails.
    }
    packageLines.push(`  ${manifest}${detail ? ` — ${detail}` : ''}`)
  }
  if (packageLines.length > 0) {
    lines.push('', 'Manifests:', ...packageLines)
  }

  for (const candidate of PROJECT_ENTRY_CANDIDATES) {
    try {
      const info = await stat(join(target, candidate))
      if (info.isFile()) entries.add(candidate)
    } catch {
      // Missing candidates are expected.
    }
  }
  const entryLines = [...entries].sort().slice(0, 12)
  if (entryLines.length > 0) lines.push('', 'Entry points:', ...entryLines.map((entry) => `  ${entry}`))

  if (configs.length > 0) {
    const unique = [...new Set(configs)].sort()
    lines.push('', `Project config: ${unique.slice(0, 20).join(', ')}${unique.length > 20 ? `, … +${unique.length - 20}` : ''}`)
  }
  if (testDirs.size > 0) {
    const dirs = [...testDirs].sort()
    lines.push('', `Test directories: ${dirs.slice(0, 12).join(', ')}${dirs.length > 12 ? `, … +${dirs.length - 12}` : ''}`)
  }
  if (readmes.length > 0) lines.push('', `Docs: ${readmes.join(', ')}`)

  const output = lines.join('\n')
  return {
    output:
      output.length > PROJECT_MAP_MAX_OUTPUT
        ? `${output.slice(0, PROJECT_MAP_MAX_OUTPUT)}… (project map truncated)`
        : output,
    metadata: { files, directories, bytes, manifests: manifests.length, truncated, depthTruncated },
  }
}

export async function readTextFile(
  root: string,
  path: string,
): Promise<{ rel: string; text: string; size: number }> {
  const target = await resolveExisting(root, path)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('Target is not a file')
  if (info.size > MAX_READ_BYTES) {
    throw new Error(`File is too large to read (${Math.round(info.size / 1024)} KB)`)
  }
  const buffer = await readFile(target)
  if (isBinary(buffer)) throw new Error('Binary files cannot be read as text')
  const base = await workspaceRoot(root)
  return {
    rel: toPosix(relative(base, target)),
    text: buffer.toString('utf8'),
    size: info.size,
  }
}

/** Read a line slice and add line numbers so the model can cite precisely. */
export async function readFileSlice(
  root: string,
  path: string,
  startLine: unknown,
  endLine: unknown,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  const { rel, text } = await readTextFile(root, path)
  const lines = fileLines(text)
  const start = Math.max(1, Number(startLine ?? 1) || 1)
  const requestedEnd = Number(endLine ?? start + 1999) || start + 1999
  const end = Math.min(lines.length, Math.max(start, requestedEnd))
  if (start > lines.length) {
    return {
      output: `${rel}: file has only ${lines.length} lines`,
      metadata: { path: rel, totalLines: lines.length, truncated: false },
    }
  }
  const width = String(end).length
  const output = lines
    .slice(start - 1, end)
    .map((line, index) => `${String(start + index).padStart(width, ' ')}| ${redactSecretLine(line, rel)}`)
    .join('\n')
  const truncated = end < lines.length
  return {
    output: `${rel} (lines ${start}-${end} of ${lines.length})\n${output}${truncated ? '\n…（more lines available）' : ''}`,
    metadata: { path: rel, startLine: start, endLine: end, totalLines: lines.length, truncated },
  }
}

function looksSecretPath(path: string): boolean {
  const name = basename(path).toLowerCase()
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name.endsWith('.pem') ||
    name.endsWith('.key') ||
    name.endsWith('.p12') ||
    name.includes('credential') ||
    name.includes('secret') ||
    name === 'id_rsa' ||
    name === 'id_ed25519'
  )
}

/** Never echo credential values into model context or the UI. */
export function redactSecretLine(line: string, path: string): string {
  let output = line
  // In known secret-bearing files, hide whole assignment values as well.
  if (looksSecretPath(path)) {
    output = output
      .replace(/^(\s*[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*).+$/u, '$1<redacted>')
      .replace(/^(\s*["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*:\s*).+$/u, '$1"<redacted>"')
  }
  // Always redact recognizable credential tokens, wherever they appear.
  return output
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, '<redacted>')
    .replace(/(ghp_[A-Za-z0-9]{10,})/g, '<redacted>')
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, '<redacted>')
    .replace(/(AKIA[0-9A-Z]{12,})/g, '<redacted>')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g, '<redacted>')
}

/** `pilot-media://local/<base64url(workspace-relative path)>` — absolute paths are refused. */
export function mediaUrlFor(relativePath: string): string {
  return `${MEDIA_SCHEME}://local/${Buffer.from(relativePath, 'utf8').toString('base64url')}`
}

/** Inverse of {@link mediaUrlFor}; returns null for anything malformed. */
export function mediaPathFromUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) return null
  const encoded = parsed.pathname.replace(/^\/+/, '')
  if (!encoded) return null
  try {
    // decodeURIComponent first: Chromium percent-encodes the base64url payload.
    const decoded = Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf8')
    return decoded || null
  } catch {
    return null
  }
}

/**
 * Absolute path of a `pilot-media` target, or null when it is not a file
 * inside the workspace. The jail reuses the same resolver as every tool.
 */
export async function resolveMediaTarget(root: string, relativePath: string): Promise<string | null> {
  try {
    return await resolveExisting(root, relativePath)
  } catch {
    return null
  }
}

export async function previewFile(root: string, path: string): Promise<FilePreview> {
  const target = await resolveExisting(root, path)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('Target is not a file')
  const base = await workspaceRoot(root)
  const rel = toPosix(relative(base, target))
  const kind: PreviewKind = previewKindOf(rel)
  // Images, video, audio and web pages are streamed to the renderer instead of
  // being read into memory: a 200 MB mp4 must not be buffered or truncated.
  if (kind !== 'text') {
    return {
      path: rel,
      size: info.size,
      content: '',
      // `language` doubles as the format chip: "MP4" reads better than
      // "plaintext" next to the size for a streamed file.
      language: formatLabel(rel),
      truncated: false,
      kind,
      url: mediaUrlFor(rel),
    }
  }
  if (info.size > MAX_READ_BYTES) throw new Error('File is too large to preview')
  const buffer = await readFile(target)
  if (isBinary(buffer)) throw new Error('Binary files cannot be previewed')
  const text = buffer.toString('utf8')
  const limit = 200_000
  return {
    path: rel,
    size: info.size,
    content: text.length > limit ? `${text.slice(0, limit)}\n…（preview truncated）` : text,
    language: languageFor(rel),
    truncated: text.length > limit,
    kind: 'text',
  }
}

export interface FileChunk {
  /** base64 bytes starting at `offset`. */
  data: string
  offset: number
  size: number
  eof: boolean
  name: string
  mtime: number
}

/**
 * Read one bounded slice of any file inside the workspace, as base64.
 *
 * The phone cannot fetch a URL from the desktop, so binary previews (images,
 * PDF, Office documents) are pulled chunk by chunk over the encrypted relay.
 * Chunks stay small so a single relay frame never grows past a few hundred KB;
 * the phone caps the total download on its side.
 */
export async function readFileChunk(
  root: string,
  path: string,
  offset = 0,
  length = DEFAULT_FILE_CHUNK_BYTES,
): Promise<FileChunk> {
  const target = await resolveExisting(root, path)
  const info = await stat(target)
  if (!info.isFile()) throw new Error('Target is not a file')
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  const requested = Number.isFinite(length)
    ? Math.floor(length)
    : DEFAULT_FILE_CHUNK_BYTES
  const take = Math.min(MAX_FILE_CHUNK_BYTES, Math.max(1, requested))
  const name = basename(target)
  const mtime = Math.round(info.mtimeMs)
  if (start >= info.size) {
    return { data: '', offset: start, size: info.size, eof: true, name, mtime }
  }
  const amount = Math.min(take, info.size - start)
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(amount)
    const { bytesRead } = await handle.read(buffer, 0, amount, start)
    return {
      data: buffer.subarray(0, bytesRead).toString('base64'),
      offset: start,
      size: info.size,
      eof: start + bytesRead >= info.size,
      name,
      mtime,
    }
  } finally {
    await handle.close()
  }
}

/* ------------------------------------------------------------------ */
/* Phone uploads                                                       */
/* ------------------------------------------------------------------ */

/**
 * Phone uploads use the same workspace jail as every other file mutation.
 * The destination is a fresh file name under a workspace-relative directory:
 * existing files are never overwritten, they get a numbered sibling instead.
 */
export interface WorkspaceUploadPlan {
  /** Hidden temporary file next to the final destination. */
  tempPath: string
  target: string
  /** Workspace-relative path shown to the phone. */
  path: string
  name: string
}

export interface FinishedWorkspaceUpload {
  path: string
  name: string
  size: number
}

function uploadName(input: unknown): string {
  if (typeof input !== 'string') throw new Error('文件名不正确')
  const name = input.trim()
  if (!name || name === '.' || name === '..') throw new Error('文件名不正确')
  if (name.length > UPLOAD_NAME_MAX) throw new Error(`文件名不能超过 ${UPLOAD_NAME_MAX} 个字符`)
  if (name.includes('\0') || /[\\/]/.test(name)) throw new Error('文件名不能包含路径分隔符')
  if (/[<>:"|?*\u0000-\u001f\u007f]/.test(name)) throw new Error('文件名包含无效字符')
  if (/[. ]$/.test(name)) throw new Error('文件名不能以空格或句点结尾')
  if (name.startsWith('.pilot-upload-')) throw new Error('文件名是系统保留名称')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) {
    throw new Error('文件名是系统保留名称')
  }
  return name
}

function uploadDirectory(input: unknown): string {
  if (input === undefined || input === null || input === '') return '.'
  if (typeof input !== 'string') throw new Error('上传目录不正确')
  const value = input.trim().replace(/\\/g, '/')
  if (!value || value === '.') return '.'
  if (value.split('/').includes('..')) throw new Error('上传目录不能跳出工作区')
  return requestPath(value)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Never overwrite an existing file: fall back to `name (1).ext`. */
function numberedName(name: string, index: number): string {
  if (index === 0) return name
  const ext = extname(name)
  const suffix = ` (${index})`
  const stem = ext ? name.slice(0, -ext.length) : name
  const room = Math.max(1, UPLOAD_NAME_MAX - ext.length - suffix.length)
  return `${stem.slice(0, room)}${suffix}${ext}`
}

async function availableUploadTarget(dir: string, name: string): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const target = join(dir, numberedName(name, index))
    if (!(await pathExists(target))) return target
  }
  throw new Error('同名文件太多，请先整理工作区后再上传')
}

/** Remove half-written temp files left behind by a crash or force-quit. */
async function pruneUploadTemps(dir: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const staleAfter = 10 * 60_000
  for (const entry of entries) {
    if (!entry.isFile() || !/^\.pilot-upload-[A-Za-z0-9_-]{8,80}\.part$/.test(entry.name)) {
      continue
    }
    const target = join(dir, entry.name)
    try {
      const info = await lstat(target)
      if (Date.now() - info.mtimeMs > staleAfter) await rm(target, { force: true })
    } catch {
      // Another upload may have finished it already.
    }
  }
}

export async function beginWorkspaceUpload(
  root: string,
  directory: unknown,
  name: unknown,
  size: unknown,
  uploadId: string,
): Promise<WorkspaceUploadPlan> {
  if (!UPLOAD_ID_RE.test(uploadId)) throw new Error('上传编号不正确')
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    throw new Error('文件大小不正确')
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(`单个文件不能超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`)
  }
  const cleanName = uploadName(name)
  const requested = await resolveForWrite(root, join(uploadDirectory(directory), cleanName))
  const parent = dirname(requested)
  await mkdir(parent, { recursive: true })
  await pruneUploadTemps(parent)
  // Anchor the destination to the real parent so a directory swapped for a
  // symlink during the upload cannot redirect the final rename.
  const base = await workspaceRoot(root)
  const realParent = await realpath(parent)
  assertInside(base, realParent)
  const target = await availableUploadTarget(realParent, cleanName)
  const tempPath = join(realParent, `.pilot-upload-${uploadId}.part`)
  await writeFile(tempPath, Buffer.alloc(0))
  return {
    tempPath,
    target,
    path: toPosix(relative(base, target)),
    name: basename(target),
  }
}

export async function appendWorkspaceUpload(tempPath: string, data: Buffer): Promise<void> {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('上传分块为空')
  const handle = await open(tempPath, 'a')
  try {
    await handle.appendFile(data)
  } finally {
    await handle.close()
  }
}

export async function finishWorkspaceUpload(
  root: string,
  tempPath: string,
  name: unknown,
  size: number,
): Promise<FinishedWorkspaceUpload> {
  const base = await workspaceRoot(root)
  const realTemp = await realpath(tempPath)
  assertInside(base, realTemp)
  const parent = dirname(realTemp)
  assertInside(base, parent)
  const info = await stat(realTemp)
  if (!info.isFile()) throw new Error('上传的临时文件不存在')
  if (!Number.isFinite(size) || info.size !== size) {
    throw new Error('文件分块不完整，请重新上传')
  }
  const cleanName = uploadName(name)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const target = await availableUploadTarget(parent, cleanName)
    try {
      await rename(realTemp, target)
      return {
        path: toPosix(relative(base, target)),
        name: basename(target),
        size: info.size,
      }
    } catch (error) {
      // Another upload may have claimed the same name after our check.
      if (await pathExists(target)) continue
      throw error
    }
  }
  throw new Error('同名文件太多，请先整理工作区后再上传')
}

export async function abortWorkspaceUpload(tempPath: string): Promise<void> {
  await rm(tempPath, { force: true })
}

export async function writeTextFile(
  root: string,
  path: string,
  content: string,
): Promise<{ output: string; diff: string; metadata: Record<string, unknown> }> {
  if (typeof path !== 'string' || !path) throw new Error('path must be a non-empty string')
  if (typeof content !== 'string') throw new Error('content must be a string')
  const target = await resolveForWrite(root, path)
  let before = ''
  let existed = false
  try {
    const info = await lstat(target)
    if (info.isFile()) {
      existed = true
      before = (await readFile(target)).toString('utf8')
    } else if (!info.isSymbolicLink()) {
      throw new Error('Target exists and is not a file')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Target exists and is not a file') throw error
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  const base = await workspaceRoot(root)
  const rel = toPosix(relative(base, target))
  return {
    output: `${existed ? 'Updated' : 'Created'} ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)`,
    diff: createUnifiedDiff(rel, before, content),
    metadata: { path: rel, created: !existed, bytes: Buffer.byteLength(content, 'utf8') },
  }
}

interface PatchEdit {
  oldText: string
  newText: string
  replaceAll: boolean
}

function patchEdits(args: Record<string, unknown>): PatchEdit[] {
  if (Array.isArray(args['edits'])) {
    const edits: PatchEdit[] = []
    for (const entry of (args['edits'] as unknown[]).slice(0, 20)) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const oldText = typeof record['oldText'] === 'string' ? record['oldText'] : ''
      const newText = typeof record['newText'] === 'string' ? record['newText'] : null
      if (!oldText || newText === null) continue
      edits.push({ oldText, newText, replaceAll: record['replaceAll'] === true })
    }
    return edits
  }
  const oldText = typeof args['oldText'] === 'string' ? args['oldText'] : ''
  const newText = typeof args['newText'] === 'string' ? args['newText'] : null
  if (!oldText || newText === null) return []
  return [{ oldText, newText, replaceAll: args['replaceAll'] === true }]
}

interface Occurrence {
  index: number
  length: number
}

function occurrences(text: string, needle: string): Occurrence[] {
  const found: Occurrence[] = []
  let from = 0
  for (;;) {
    const index = text.indexOf(needle, from)
    if (index === -1) break
    found.push({ index, length: needle.length })
    from = index + Math.max(1, needle.length)
  }
  return found
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tolerantOccurrences(text: string, needle: string): Occurrence[] {
  const lines = needle.replace(/\r\n/g, '\n').split('\n')
  const pattern = lines
    .map((line) => `${escapeRegExp(line.replace(/[ \t]+$/, ''))}[ \\t]*`)
    .join('\\r?\\n')
  const matcher = new RegExp(pattern, 'g')
  const found: Occurrence[] = []
  let match: RegExpExecArray | null
  while ((match = matcher.exec(text)) !== null) {
    found.push({ index: match.index, length: match[0].length })
    if (match[0].length === 0) matcher.lastIndex += 1
  }
  return found
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function applyEdit(
  text: string,
  edit: PatchEdit,
): { ok: true; text: string; line: number } | { ok: false; error: string } {
  let found = occurrences(text, edit.oldText)
  if (found.length === 0 && text.includes('\r\n') && !edit.oldText.includes('\r\n')) {
    found = occurrences(text, edit.oldText.replace(/\n/g, '\r\n'))
  }
  if (found.length === 0) found = tolerantOccurrences(text, edit.oldText)
  if (found.length === 0) {
    const firstLine = edit.oldText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    const hits: number[] = []
    if (firstLine) {
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if ((lines[index] ?? '').includes(firstLine)) hits.push(index + 1)
      }
    }
    return {
      ok: false,
      error: hits.length
        ? `Could not find the full oldText. Its first line appears at line(s) ${hits.slice(0, 3).join(', ')}; include more surrounding context.`
        : 'Could not find oldText in the file. Read the file first and use the exact text, including indentation.',
    }
  }
  if (found.length > 1 && !edit.replaceAll) {
    const lines = found.slice(0, 5).map((entry) => lineNumberAt(text, entry.index))
    return {
      ok: false,
      error: `oldText occurs ${found.length} times (lines ${lines.join(', ')}). Add surrounding context or set replaceAll=true.`,
    }
  }
  const targets = edit.replaceAll ? [...found].reverse() : [found[0]!]
  const newText =
    text.includes('\r\n') && !edit.newText.includes('\r\n')
      ? edit.newText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
      : edit.newText
  let after = text
  for (const target of targets) {
    after = after.slice(0, target.index) + newText + after.slice(target.index + target.length)
  }
  return { ok: true, text: after, line: lineNumberAt(text, targets[targets.length - 1]!.index) }
}

export async function applyPatch(
  root: string,
  args: Record<string, unknown>,
): Promise<{ output: string; diff: string; metadata: Record<string, unknown> }> {
  const edits = patchEdits(args)
  if (edits.length === 0) {
    throw new Error('Provide edits: [{oldText, newText}], or oldText/newText. oldText cannot be empty.')
  }
  const path = typeof args['path'] === 'string' ? args['path'] : ''
  if (!path) throw new Error('path must be a non-empty string')
  const target = await resolveForWrite(root, path)
  const info = await stat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File does not exist: ${path}. Create it with write_file first, or check the path.`)
    }
    throw error
  })
  if (!info.isFile()) throw new Error('Target is not a file')
  const text = (await readFile(target)).toString('utf8')
  let after = text
  const lines: number[] = []
  for (const edit of edits) {
    const outcome = applyEdit(after, edit)
    if (!outcome.ok) throw new Error(outcome.error)
    after = outcome.text
    lines.push(outcome.line)
  }
  if (after === text) {
    // oldText and newText were identical (or normalized to the same text).
    // The file already has the requested state; report that instead of an
    // error that makes the model retry or rewrite the whole file.
    const unchangedBase = await workspaceRoot(root)
    const unchangedRel = toPosix(relative(unchangedBase, target))
    return {
      output: `No changes needed for ${unchangedRel}; the file already matches the requested edit.`,
      diff: '',
      metadata: { path: unchangedRel, edits: edits.length, noop: true },
    }
  }
  await writeFile(target, after, 'utf8')
  const base = await workspaceRoot(root)
  const rel = toPosix(relative(base, target))
  return {
    output: `Patched ${rel} (${edits.length} edit${edits.length === 1 ? '' : 's'}; anchor line ${lines.join(', ')})`,
    diff: createUnifiedDiff(rel, text, after),
    metadata: { path: rel, edits: edits.length, bytes: Buffer.byteLength(after, 'utf8') },
  }
}

function globToRegExp(glob: string): RegExp {
  const expanded: string[] = []
  const queue = [glob]
  while (queue.length > 0 && expanded.length < 64) {
    const current = queue.shift()!
    const open = current.indexOf('{')
    const close = open === -1 ? -1 : current.indexOf('}', open + 1)
    if (open !== -1 && close !== -1) {
      const before = current.slice(0, open)
      const options = current.slice(open + 1, close).split(',')
      const after = current.slice(close + 1)
      for (const option of options) queue.push(before + option + after)
    } else {
      expanded.push(current)
    }
  }
  const patterns = expanded.map((raw) => {
    // A pattern with no slash is a bare filename pattern. Models pass it the
    // way ripgrep reads it — "*.ts" means "every *.ts below the search root"
    // — so match it at any depth instead of only at the root, where it would
    // silently select zero files.
    const trimmed = raw.replace(/^\.\//, '')
    const pattern = trimmed.includes('/') ? trimmed : `**/${trimmed}`
    let out = ''
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index]!
      if (char === '*') {
        if (pattern[index + 1] === '*') {
          index += 1
          if (pattern[index + 1] === '/') index += 1
          out += '(?:.*/)?'
        } else {
          out += '[^/]*'
        }
      } else if (char === '?') {
        out += '[^/]'
      } else if ('\\^$+.|()[]{}'.includes(char)) {
        out += `\\${char}`
      } else {
        out += char
      }
    }
    return out
  })
  return new RegExp(`^(?:${patterns.join('|')})$`, process.platform === 'win32' ? 'i' : '')
}

export interface SearchMatch {
  path: string
  line: number
  text: string
}

export async function searchFiles(
  root: string,
  options: {
    query: string
    path?: string
    glob?: string
    regex?: boolean
    caseSensitive?: boolean
    maxResults?: number
    context?: number
  },
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  const query = options.query
  if (!query) throw new Error('query must be a non-empty string')
  const start = await resolveExisting(root, options.path ?? '.')
  const startInfo = await stat(start)
  // Treat a file path as "search exactly this file" instead of failing with
  // ENOTDIR. Models routinely pass the file they just read.
  const singleFile = startInfo.isFile() ? start : null
  const startDirectory = singleFile ? dirname(start) : start
  const base = await workspaceRoot(root)
  const maxResults = Math.min(200, Math.max(1, Number(options.maxResults ?? 80) || 80))
  const matcher = options.regex
    ? new RegExp(query, options.caseSensitive ? '' : 'i')
    : null
  const literal = options.caseSensitive ? query : query.toLowerCase()
  const glob = options.glob ? globToRegExp(options.glob) : null
  const matches: SearchMatch[] = []
  let filesSearched = 0
  let truncated = false
  let visited = 0

  const visit = async (dir: string): Promise<void> => {
    if (truncated) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (truncated) return
      if (entry.isSymbolicLink() || entry.name === '.DS_Store') continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await visit(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const absolute = join(dir, entry.name)
      if (singleFile && absolute !== singleFile) continue
      const rel = toPosix(relative(base, absolute))
      if (glob && !glob.test(rel)) continue
      visited += 1
      if (visited > 20_000) {
        truncated = true
        return
      }
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      if (info.size > MAX_SEARCH_FILE_BYTES) continue
      let buffer: Buffer
      try {
        buffer = await readFile(absolute)
      } catch {
        continue
      }
      if (isBinary(buffer)) continue
      filesSearched += 1
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const hit = matcher
          ? matcher.test(line)
          : (options.caseSensitive ? line : line.toLowerCase()).includes(literal)
        if (!hit) continue
        matches.push({ path: rel, line: index + 1, text: redactSecretLine(line.trim().slice(0, 300), rel) })
        if (matches.length >= maxResults) {
          truncated = true
          return
        }
      }
    }
  }

  await visit(startDirectory)
  if (matches.length === 0) {
    const scope = options.path && options.path !== '.' ? ` in ${options.path}` : ''
    const baseRel = toPosix(relative(base, startDirectory)) || '.'
    const reason =
      glob && visited === 0
        ? ` The glob "${options.glob}" selected no file paths under ${baseRel}; use a recursive pattern such as "**/*.ts" or drop the glob.`
        : filesSearched === 0
          ? ` No readable text file was found under ${baseRel}; check the path or use list_directory first.`
          : ''
    return {
      output: `No matches${scope} (searched ${filesSearched} files).${reason}`,
      metadata: { matches: 0, filesSearched, globMatched: visited, truncated: false },
    }
  }
  const context = Math.min(5, Math.max(0, Number(options.context ?? 0) || 0))
  if (context === 0) {
    const output = matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n')
    return {
      output: `${output}${truncated ? '\n…（reached result limit; narrow the glob or query）' : ''}`,
      metadata: { matches: matches.length, filesSearched, truncated },
    }
  }

  const grouped = new Map<string, number[]>()
  for (const match of matches) {
    const bucket = grouped.get(match.path) ?? []
    bucket.push(match.line)
    grouped.set(match.path, bucket)
  }
  const out: string[] = []
  for (const [file, numbers] of grouped) {
    let lines: string[]
    try {
      lines = (await readTextFile(root, file)).text.split(/\r?\n/)
    } catch {
      out.push(...numbers.map((line) => `${file}:${line}: (context unavailable)`))
      continue
    }
    let lastPrinted = 0
    for (const number of numbers) {
      const from = Math.max(1, number - context)
      const to = Math.min(lines.length, number + context)
      if (lastPrinted > 0 && from > lastPrinted + 1) out.push('--')
      for (let line = Math.max(from, lastPrinted + 1); line <= to; line += 1) {
        const text = redactSecretLine((lines[line - 1] ?? '').slice(0, 300), file)
        out.push(line === number ? `${file}:${line}: ${text}` : `${file}-${line}- ${text}`)
        lastPrinted = line
      }
      if (out.length >= 500) break
    }
    if (out.length >= 500) break
  }
  return {
    output: `${out.join('\n')}${truncated ? '\n…（reached result limit）' : ''}`,
    metadata: { matches: matches.length, filesSearched, truncated },
  }
}

export async function getFileInfo(
  root: string,
  path: string,
): Promise<string> {
  const target = await resolveExisting(root, path)
  const info = await stat(target)
  const base = await workspaceRoot(root)
  const rel = toPosix(relative(base, target))
  return [
    `path: ${rel}`,
    `type: ${info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'}`,
    `size: ${info.size} bytes`,
    `modified: ${info.mtime.toISOString()}`,
  ].join('\n')
}

export interface CommandOutput {
  ok: boolean
  output: string
  error?: string
  exitCode: number | null
  durationMs: number
  metadata: Record<string, unknown>
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= MAX_COMMAND_OUTPUT_BYTES) return { text, truncated: false }
  const headBytes = Math.floor(MAX_COMMAND_OUTPUT_BYTES * 0.65)
  const tailBytes = Math.floor(MAX_COMMAND_OUTPUT_BYTES * 0.25)
  const head = buffer.subarray(0, headBytes).toString('utf8')
  const tail = buffer.subarray(buffer.length - tailBytes).toString('utf8')
  return {
    text: `${head}\n…（output truncated: ${buffer.length - headBytes - tailBytes} bytes omitted; tail kept）…\n${tail}`,
    truncated: true,
  }
}

const DENY_COMMANDS = new Set([
  'mkfs',
  'mkfs.ext4',
  'fdisk',
  'diskpart',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
])

function exitCodeHint(exitCode: number | null): string | null {
  switch (exitCode) {
    case 126:
      return 'found but not executable'
    case 127:
      return 'command not found; check that it is installed and on PATH'
    case 130:
      return 'interrupted'
    case 137:
      return 'killed, often by a timeout or memory limit'
    case 143:
      return 'terminated by SIGTERM'
    case 9009:
      return 'command not found (Windows cmd); check that it is installed and on PATH'
    default:
      return null
  }
}

function commandFailureMessage(exitCode: number | null): string {
  if (exitCode === null) return 'Command was terminated before it reported an exit code (signal or crash)'
  const hint = exitCodeHint(exitCode)
  return `Command failed with exit code ${exitCode}${hint ? ` (${hint})` : ''}`
}

function timeoutFailureMessage(timeoutMs: number): string {
  return `Command timed out after ${timeoutMs}ms (partial output included). Raise timeoutMs (max 600000) or split the command into smaller steps.`
}

export interface PlannedCommand {
  /** Program name or workspace-relative executable path. */
  command: string
  argv: string[]
  cwd: string
  /** Real workspace root, used for the PILOT_WORKSPACE environment variable. */
  base: string
}

/**
 * Validate a `run_command`-shaped request and resolve its workspace-jailed
 * cwd/executable. Shared by one-shot commands and managed long-lived
 * processes so both obey the same deny list and path checks.
 */
export async function planCommand(
  root: string,
  args: Record<string, unknown>,
): Promise<PlannedCommand> {
  const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
  if (!command || command.includes('\0')) throw new Error('command must be a non-empty string')
  const name = basename(command).toLowerCase()
  if (DENY_COMMANDS.has(name)) throw new Error(`Command "${name}" is blocked by Pilot`)
  const rawArgs = Array.isArray(args['args']) ? args['args'] : []
  const argv = rawArgs.map((item) => String(item))
  const base = await workspaceRoot(root)
  const cwdInput = typeof args['cwd'] === 'string' ? args['cwd'] : '.'
  const cwd = await resolveExisting(root, cwdInput)
  const cwdInfo = await stat(cwd)
  if (!cwdInfo.isDirectory()) throw new Error('cwd is not a directory')
  assertInside(base, cwd)

  // Bare program names are resolved through PATH. Anything with a separator is
  // a filesystem path, so it must resolve inside the workspace (including
  // through symlinks). This blocks "../../evil" style escapes.
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const candidate = isAbsolute(command) ? command : resolve(cwd, command)
    assertInside(base, candidate)
    const real = await realpath(candidate).catch(() => null)
    if (real) assertInside(base, real)
    else throw new Error('Command executable was not found')
  }
  return { command, argv, cwd, base }
}

export async function runCommand(
  root: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CommandOutput> {
  const { command, argv, cwd, base } = await planCommand(root, args)
  const timeoutMs = Math.min(600_000, Math.max(1_000, Number(args['timeoutMs'] ?? 120_000) || 120_000))
  const startedAt = Date.now()
  // Cheap statfs before every command: a nearly full volume explains an
  // ENOSPC that would otherwise surface only midway through a long build.
  const disk = await diskSpace(base)

  return new Promise<CommandOutput>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    const child = spawn(command, argv, {
      cwd,
      env: { ...process.env, PILOT_WORKSPACE: base },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
      const warning = diskWarning(disk)
      const { text, truncated } = truncateOutput(
        warning ? `${combined || '(no output)'}\n\n${warning}` : combined || '(no output)',
      )
      const failure =
        error ??
        (timedOut
          ? timeoutFailureMessage(timeoutMs)
          : aborted
            ? 'Run cancelled'
            : exitCode !== 0
              ? commandFailureMessage(exitCode)
              : undefined)
      const failed = Boolean(failure) || exitCode !== 0 || exitCode === null
      resolvePromise({
        ok: !failed,
        output: text,
        ...(failure ? { error: failure } : {}),
        exitCode,
        durationMs: Date.now() - startedAt,
        metadata: {
          command,
          args: argv,
          exitCode,
          timedOut,
          aborted,
          truncated,
          diskFreeBytes: disk.freeBytes,
        },
      })
    }

    const killTree = (): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      killTree()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_COMMAND_OUTPUT_BYTES * 3) stdout = stdout.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_COMMAND_OUTPUT_BYTES * 3) stderr = stderr.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
    })
    child.on('error', (error) =>
      finish(null, `Failed to start "${command}" (working directory: ${cwd}): ${error.message}`),
    )
    child.on('close', (code) => finish(code))
  })
}

/**
 * Run a full shell command line inside the workspace. This intentionally
 * supports pipes, redirects, chaining and environment expansion, so it can
 * reach outside the workspace. It is only exposed when the user enables
 * shell mode, and the agent loop is required to ask for approval per call.
 */
export async function runShell(
  root: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  sandbox?: { network: boolean } | null,
  shellInterpreter: ShellInterpreter = 'auto',
): Promise<CommandOutput> {
  const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
  if (!command || command.includes('\0')) throw new Error('command must be a non-empty string')
  const base = await workspaceRoot(root)
  const cwdInput = typeof args['cwd'] === 'string' ? args['cwd'] : '.'
  const cwd = await resolveExisting(root, cwdInput)
  const cwdInfo = await stat(cwd)
  if (!cwdInfo.isDirectory()) throw new Error('cwd is not a directory')
  assertInside(base, cwd)

  const timeoutMs = Math.min(600_000, Math.max(1_000, Number(args['timeoutMs'] ?? 120_000) || 120_000))
  const sandboxPlan = sandbox
    ? await buildSandboxPlan({
        workspacePath: base,
        cwd,
        command,
        network: sandbox.network,
      })
    : null
  if (sandbox && !sandboxPlan) {
    throw new Error(
      'The OS sandbox was requested but is not available. Refusing to run the command unsandboxed.',
    )
  }
  // Sandbox plans bring their own bash; only resolve an interpreter when the
  // command runs directly on the host.
  const launch = sandboxPlan ? null : resolveShellLaunch(shellInterpreter, command)
  const startedAt = Date.now()
  const disk = await diskSpace(base)

  const env: NodeJS.ProcessEnv = { ...process.env }
  // Git Bash commands no longer run as login shells. Merge the login
  // environment captured once at startup so PATH and other profile additions
  // still apply without paying the profile cost on every command.
  if (launch?.label === 'Git Bash' && process.platform === 'win32') {
    const loginEnv = await gitBashLoginEnvironment(launch.file)
    if (loginEnv) Object.assign(env, loginEnv)
  }
  // BASH_ENV/ENV would make every non-interactive shell source a startup file
  // again, defeating the cached environment.
  delete env['BASH_ENV']
  delete env['ENV']
  env['PILOT_WORKSPACE'] = base
  // Never expose Pilot's own key material to shell commands; project-level
  // variables such as DEEPSEEK_API_KEY remain available for legitimate builds.
  delete env['PILOT_API_KEY']

  return new Promise<CommandOutput>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let forceTimer: NodeJS.Timeout | null = null
    let drainTimer: NodeJS.Timeout | null = null
    let child: ChildProcess
    try {
      child = sandboxPlan
        ? spawn(sandboxPlan.file, sandboxPlan.args, {
            cwd: sandboxPlan.cwd,
            env,
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(launch!.file, launch!.args, {
            cwd,
            env,
            shell: launch!.shell,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
    } catch (error) {
      resolvePromise({
        ok: false,
        output: '',
        error: `Failed to start shell (working directory: ${cwd}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          command,
          shell: sandboxPlan?.backend ?? launch?.label ?? 'shell',
          sandbox: sandboxPlan?.display ?? null,
          exitCode: null,
        },
      })
      return
    }

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      if (drainTimer) clearTimeout(drainTimer)
      signal.removeEventListener('abort', onAbort)
      const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
      const warning = diskWarning(disk)
      const { text, truncated } = truncateOutput(
        warning ? `${combined || '(no output)'}\n\n${warning}` : combined || '(no output)',
      )
      const failure =
        error ??
        (timedOut
          ? timeoutFailureMessage(timeoutMs)
          : aborted
            ? 'Run cancelled'
            : exitCode !== 0
              ? commandFailureMessage(exitCode)
              : undefined)
      const failed = Boolean(failure) || exitCode !== 0 || exitCode === null
      resolvePromise({
        ok: !failed,
        output: text,
        ...(failure ? { error: failure } : {}),
        exitCode,
        durationMs: Date.now() - startedAt,
        metadata: {
          command,
          shell: sandboxPlan?.backend ?? launch?.label ?? 'shell',
          sandbox: sandboxPlan?.display ?? null,
          exitCode,
          timedOut,
          aborted,
          truncated,
          diskFreeBytes: disk.freeBytes,
        },
      })
    }

    const killTree = (): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        // Absolute path: the login environment merged into `env` may not
        // include System32, and spawn() resolves against PATH.
        const taskkill = process.env['SystemRoot']
          ? join(process.env['SystemRoot'], 'System32', 'taskkill.exe')
          : 'taskkill'
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // The process is already gone.
          }
        })
        // A launcher process may have exited while its real child lives on.
        // Kill the direct child too; the force timer below guarantees the
        // tool call settles even if the tree cannot be reached.
        try {
          child.kill('SIGKILL')
        } catch {
          // The process is already gone.
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }

    /**
     * A timed-out or cancelled command must never leave the agent waiting
     * forever. Give the kill a short grace period, then settle the tool call
     * even if some descendant still holds the stdout/stderr pipes open.
     */
    const forceFinishAfterKill = (): void => {
      if (settled || forceTimer) return
      forceTimer = setTimeout(() => finish(null), 3_000)
      forceTimer.unref?.()
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
      forceFinishAfterKill()
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      killTree()
      forceFinishAfterKill()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_COMMAND_OUTPUT_BYTES * 3) {
        stdout = stdout.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_COMMAND_OUTPUT_BYTES * 3) {
        stderr = stderr.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
      }
    })
    child.on('error', (error) =>
      finish(null, `Failed to start shell (working directory: ${cwd}): ${error.message}`),
    )
    // `exit` fires when the shell itself is done. `close` waits for every
    // stdio pipe to close, which a background child can hold open forever
    // (e.g. `server &`). The shell's exit is the command's completion; drain
    // the pipes briefly, then settle instead of hanging the whole agent run.
    child.on('exit', (code) => {
      if (settled) return
      drainTimer = setTimeout(() => finish(code), 500)
      drainTimer.unref?.()
    })
    child.on('close', (code) => finish(code))
  })
}

export async function runGit(
  root: string,
  args: string[],
  signal: AbortSignal,
): Promise<CommandOutput> {
  return runCommand(root, { command: 'git', args, timeoutMs: 30_000 }, signal)
}

export async function gitStatus(root: string, signal: AbortSignal): Promise<string> {
  const branch = await runGit(root, ['branch', '--show-current'], signal)
  const status = await runGit(root, ['status', '--porcelain=v1', '-b'], signal)
  return `${branch.output}\n${status.output}`.trim()
}

export async function gitDiff(
  root: string,
  options: { path?: string; staged?: boolean; stat?: boolean },
  signal: AbortSignal,
): Promise<string> {
  const args = ['diff', '--no-color']
  if (options.staged) args.push('--cached')
  if (options.stat) args.push('--stat')
  if (options.path) args.push('--', String(options.path))
  const result = await runGit(root, args, signal)
  return result.output
}

export async function gitLog(
  root: string,
  options: { limit?: number; path?: string },
  signal: AbortSignal,
): Promise<string> {
  const args = ['log', `-${Math.min(50, Math.max(1, Number(options.limit ?? 20) || 20))}`, '--date=short', '--pretty=format:%h %ad %an: %s']
  if (options.path) args.push('--', String(options.path))
  const result = await runGit(root, args, signal)
  return result.output
}
