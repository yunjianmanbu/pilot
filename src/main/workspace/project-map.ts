// Project overview: manifests, layout, entry points and test dirs.
// Split out of src/main/workspace.ts; statements are moved verbatim.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { FileNode, FilePreview, ShellInterpreter } from '../../shared/types'
import {
  mediaFileUrlFor,
  mediaDirUrlFor,
  mediaUrlFor,
  dirOf,
  isTextKind,
  previewKindOf,
  type PreviewKind,
} from '../../shared/media'
import { ephemeralDirSegment, looksEphemeralDirPath } from '../../shared/checkpoint-ignore'
import { gitBashLoginEnvironment, resolveShellLaunch } from '../shell'
import { diskSpace, diskWarning } from '../system-info'
import { resolveExisting, SKIP_DIRS, toPosix, workspaceRoot } from './shared'

export const PROJECT_MAP_MAX_FILES = 40_000
export const PROJECT_MAP_MAX_OUTPUT = 12_000
export const PROJECT_MANIFESTS = new Set([
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
export const PROJECT_CONFIG_PATTERN =
  /^(tsconfig.*\.json|jsconfig\.json|vite\.config\..+|vitest\.config\..+|jest\.config\..+|playwright\.config\..+|cypress\.config\..+|electron\.vite\.config\..+|electron-builder\.(yml|yaml|json)|next\.config\..+|nuxt\.config\..+|webpack\.config\..+|rollup\.config\..+|eslint\.config\..+|\.eslintrc.*|prettier\.config\..+|\.prettierrc.*|biome\.json|dockerfile|docker-compose.*|makefile|cmakelists\.txt|\.editorconfig|\.gitignore|\.npmrc|pnpm-workspace\.yaml|turbo\.json)$/i
export const PROJECT_ENTRY_CANDIDATES = [
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
export const PROJECT_TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'e2e'])
export const PROJECT_SOURCE_EXTENSIONS = new Set([
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
export const PROJECT_MAP_KEY_FILES = 48

export function formatProjectSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function manifestDetail(name: string, text: string): string {
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
