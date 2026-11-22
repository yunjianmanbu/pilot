// apply_patch: tolerant occurrence matching, retry snippets, unified diff.
// Split out of src/main/workspace.ts; statements are moved verbatim.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { relative } from 'node:path'
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
import { createUnifiedDiff } from '../agent/diff'
import { ephemeralDirSegment, looksEphemeralDirPath } from '../../shared/checkpoint-ignore'
import { gitBashLoginEnvironment, resolveShellLaunch } from '../shell'
import { diskSpace, diskWarning } from '../system-info'
import { resolveForWrite, toPosix, workspaceRoot } from './shared'

export interface PatchEdit {
  oldText: string
  newText: string
  replaceAll: boolean
}

export function patchEdits(args: Record<string, unknown>): PatchEdit[] {
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

export interface Occurrence {
  index: number
  length: number
}

export function occurrences(text: string, needle: string): Occurrence[] {
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function tolerantOccurrences(text: string, needle: string): Occurrence[] {
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

export function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

export const PATCH_SNIPPET_CONTEXT = 2
export const PATCH_SNIPPET_LINE_CHARS = 200
export const PATCH_SNIPPET_MAX_CHARS = 1_200

/**
 * Quote the real file text around a line so a failed patch can be repaired in
 * one retry. Without it the model has to re-read the whole file just to learn
 * how its `oldText` is actually spelled (indentation, commas, quotes).
 */
export function patchFailureSnippet(text: string, line: number): string {
  const lines = text.split(/\r?\n/)
  const from = Math.max(1, line - PATCH_SNIPPET_CONTEXT)
  const to = Math.min(lines.length, line + PATCH_SNIPPET_CONTEXT)
  const width = String(to).length
  const render = (cursor: number): string => {
    const marker = cursor === line ? '>' : ' '
    const raw = lines[cursor - 1] ?? ''
    const clipped =
      raw.length > PATCH_SNIPPET_LINE_CHARS ? `${raw.slice(0, PATCH_SNIPPET_LINE_CHARS)}…` : raw
    return `${marker} ${String(cursor).padStart(width, ' ')}| ${clipped}`
  }
  const rows: number[] = []
  for (let cursor = from; cursor <= to; cursor += 1) rows.push(cursor)
  // Trim the quoted block from the outside in, but never drop the hit itself.
  let rendered = rows.map(render)
  while (
    rendered.join('\n').length > PATCH_SNIPPET_MAX_CHARS &&
    rendered.length > 1
  ) {
    if (rows[0] !== line && rows.length > 2) {
      rows.shift()
    } else if (rows[rows.length - 1] !== line && rows.length > 2) {
      rows.pop()
    } else {
      rows.shift()
    }
    rendered = rows.map(render)
  }
  return rendered.join('\n')
}

export function applyEdit(
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
    if (hits.length === 0) {
      return {
        ok: false,
        error:
          'Could not find oldText in the file. Read the file first and use the exact text, including indentation.',
      }
    }
    const listed = hits.slice(0, 3).join(', ')
    const others = hits.length > 3 ? ` (and ${hits.length - 3} more)` : ''
    return {
      ok: false,
      error: `Could not find the full oldText. Its first line appears at line(s) ${listed}${others}:\n${patchFailureSnippet(
        text,
        hits[0]!,
      )}\nRe-send oldText using these exact lines (indentation included).`,
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
