import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { FileNode, FilePreview } from '../shared/types'
import {
  mediaFileUrlFor,
  mediaDirUrlFor,
  mediaUrlFor,
  dirOf,
  isTextKind,
  previewKindOf,
  type PreviewKind,
} from '../shared/media'
import { createUnifiedDiff } from './agent/diff'
import { ephemeralDirSegment, looksEphemeralDirPath } from '../shared/checkpoint-ignore'
import { gitBashLoginEnvironment, resolveShellLaunch } from './shell'
import { diskSpace, diskWarning } from './system-info'

import {
  DEFAULT_FILE_CHUNK_BYTES,
  fileLines,
  formatLabel,
  isBinary,
  languageFor,
  MAX_FILE_CHUNK_BYTES,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_SEARCH_FILE_BYTES,
  pathExists,
  resolveExisting,
  resolveForWrite,
  SKIP_DIRS,
  toPosix,
  workspaceRoot,
} from './workspace/shared'

// The file tools below stay in this module; uploads, patch, project map and
// command execution live in ./workspace/*. Every pre-existing export is
// re-exported here so callers keep importing from 'main/workspace'.
export {
  MAX_FILE_CHUNK_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
  SKIP_DIRS,
  assertInside,
  workspaceRoot,
  resolveExisting,
  resolveForWrite,
  languageFor,
  formatLabel,
} from './workspace/shared'
export {
  beginWorkspaceUpload,
  appendWorkspaceUpload,
  finishWorkspaceUpload,
  abortWorkspaceUpload,
  importWorkspaceFile,
  importWorkspaceBytes,
} from './workspace/uploads'
export type { WorkspaceUploadPlan, FinishedWorkspaceUpload } from './workspace/uploads'
export { projectMap } from './workspace/project-map'
export { patchFailureSnippet, applyPatch } from './workspace/patch'
export { planCommand, runCommand, runShell, runGit, gitStatus, gitDiff, gitLog } from './workspace/commands'
export type { CommandOutput, PlannedCommand, CommandScope } from './workspace/commands'

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
  const nextStartLine = truncated ? end + 1 : null
  return {
    output: `${rel} (lines ${start}-${end} of ${lines.length})\n${output}${
      truncated ? `\n…（more lines available; continue with startLine=${nextStartLine}）` : ''
    }`,
    metadata: {
      path: rel,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      truncated,
      ...(nextStartLine ? { nextStartLine } : {}),
    },
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

export { mediaPathFromUrl, mediaUrlFor } from '../shared/media'

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
  // HTML goes through the folder-scoped URL so its own css/img/script resolve.
  if (!isTextKind(kind)) {
    return {
      path: rel,
      size: info.size,
      content: '',
      // `language` doubles as the format chip: "MP4" reads better than
      // "plaintext" next to the size for a streamed file.
      language: formatLabel(rel),
      truncated: false,
      kind,
      url: kind === 'html' ? mediaFileUrlFor(rel) : mediaUrlFor(rel),
      // Same-folder assets of an HTML page or a markdown body.
      baseUrl: mediaDirUrlFor(dirOf(rel)),
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
    // `markdown` is still read as text; the renderer only formats it differently.
    kind: kind === 'markdown' ? 'markdown' : 'text',
    // Relative images inside a markdown file resolve against its folder.
    baseUrl: mediaDirUrlFor(dirOf(rel)),
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

/**
 * Say so when a write creates a directory a rollback point will not capture.
 *
 * A build tree created by accident (`build-output/`, `run-tmp/`) used to join
 * every later snapshot walk: 80 000 extra files to stat and hash per command.
 * The checkpoint service drops such a directory on its own; this line is what
 * tells the model, so it does not later promise the user a rollback of files
 * that were never captured.
 */
function checkpointDirNote(dirRel: string): string {
  if (!dirRel) return ''
  const ephemeral = ephemeralDirSegment(dirRel)
  if (ephemeral) {
    return `\nNote: ${dirRel} is a scratch/generated directory ("${ephemeral}"), so rollback points never capture its files.`
  }
  if (looksEphemeralDirPath(dirRel)) {
    return `\nNote: ${dirRel} looks generated, so it is left out of later rollback points.`
  }
  return ''
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
  const parent = dirname(target)
  const base = await workspaceRoot(root)
  // A directory this write is about to create may be one no snapshot should
  // ever walk; check it before it exists so the answer costs one lstat.
  const newDir = (await pathExists(parent)) ? '' : toPosix(relative(base, parent))
  await mkdir(parent, { recursive: true })
  await writeFile(target, content, 'utf8')
  const rel = toPosix(relative(base, target))
  const bytes = Buffer.byteLength(content, 'utf8')
  return {
    output: `${existed ? 'Updated' : 'Created'} ${rel} (${bytes} bytes)${checkpointDirNote(newDir)}`,
    diff: createUnifiedDiff(rel, before, content),
    metadata: {
      path: rel,
      created: !existed,
      bytes,
      ...(newDir ? { newDir } : {}),
    },
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

