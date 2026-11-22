// Workspace jail, path resolution, size limits and small text helpers.
// Split out of src/main/workspace.ts; statements are moved verbatim.
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
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

export const MAX_READ_BYTES = 2 * 1024 * 1024
/** Mobile file previews pull binary files (docx/pdf/images) in base64 chunks. */
export const MAX_FILE_CHUNK_BYTES = 256 * 1024
/** Phone uploads arrive chunk by chunk over the relay; keep each one bounded. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_UPLOAD_CHUNK_BYTES = 256 * 1024
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
export const UPLOAD_NAME_MAX = 180
export const DEFAULT_FILE_CHUNK_BYTES = 128 * 1024
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024
// Command output enters the model context. 16KB is enough for ordinary build
// and test logs; truncation keeps the head and tail and reports the omitted
// size, so a narrow follow-up command is cheaper than replaying a 32KB dump.
export const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024
export const MAX_LIST_ENTRIES = 800

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

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
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

export function normalize(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function toPosix(value: string): string {
  return value.split(sep).join('/')
}

export function assertInside(root: string, target: string): void {
  const rel = relative(normalize(root), normalize(target))
  if (rel === '') return
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Path escapes the selected workspace')
  }
}

export function requestPath(input: unknown): string {
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

export async function resolveForMutation(
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

export function fileLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000))
  return sample.includes(0)
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
