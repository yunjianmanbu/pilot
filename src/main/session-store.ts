import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Session } from '../shared/types'
import { searchableText } from './search'

/**
 * On-disk layout (all under `<userData>`):
 *
 *   pilot-core.json              settings / workspaces / scheduled / active ids
 *   pilot-state.json             legacy single-file store, read-only fallback
 *   sessions/<id>.json           session metadata (no transcript)
 *   sessions/<id>.messages.jsonl append-only transcript, one message per line
 *   sessions/sessions.index.json summaries only, read at startup
 *   derived/search.index.json    rebuildable full-text cache (safe to delete)
 *
 * Splitting the store this way keeps a single edit from rewriting every other
 * session, which is what the old `pilot-state.json` did on all 37 save paths.
 * The transcript is append-only, so a long session no longer rewrites its whole
 * history on every message. Version-1 shards that still embed `messages` are
 * migrated on the first save; the JSONL file wins whenever both exist.
 */

export const SHARD_VERSION = 1
export const CORE_FILE = 'pilot-core.json'
export const LEGACY_FILE = 'pilot-state.json'
export const SESSIONS_DIR = 'sessions'
export const SESSION_INDEX_FILE = 'sessions.index.json'
export const DERIVED_DIR = 'derived'
export const SEARCH_INDEX_FILE = 'search.index.json'
const FILE_MODE = 0o600
const SHARD_EXT = '.json'
const MESSAGES_EXT = '.messages.jsonl'

/** Everything a session list needs, minus the bulky transcript. */
export type SessionIndexEntry = Omit<Session, 'messages' | 'queue' | 'todos'>

export interface SessionIndexFile {
  version: number
  updatedAt: string
  sessions: SessionIndexEntry[]
}

export interface SearchRecord {
  id: string
  role: 'user' | 'assistant'
  createdAt: string
  text: string
}

export interface SearchIndexFile {
  version: number
  builtAt: string
  sessions: Record<string, { updatedAt: string; messages: SearchRecord[] }>
}

export interface SessionCounts {
  messageCount: number
  instructionCount?: number
  queueCount: number
  todoCount: number
}

export function emptySearchIndex(builtAt = ''): SearchIndexFile {
  return { version: SHARD_VERSION, builtAt, sessions: {} }
}

/**
 * Summary form of a session, with counts supplied by the caller.
 *
 * Fields are copied one by one on purpose: sessions are lazily hydrated, so a
 * spread (`{ ...session }`) would read the body getters and pull every
 * transcript back into memory just to write the index.
 */
export function indexEntryFor(session: Session, counts: SessionCounts): SessionIndexEntry {
  const entry: SessionIndexEntry = {
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    running: session.running,
    paused: session.paused,
    canContinue: session.canContinue,
    messageCount: counts.messageCount,
    ...(counts.instructionCount !== undefined ? { instructionCount: counts.instructionCount } : {}),
    queueCount: counts.queueCount,
    todoCount: counts.todoCount,
    approvalMode: session.approvalMode,
    sessionModelId: session.sessionModelId,
    plan: session.plan,
    kind: session.kind,
    review: session.review,
    reviewReport: session.reviewReport,
  }
  if (session.pausedAt) entry.pausedAt = session.pausedAt
  if (session.pauseInstruction) entry.pauseInstruction = session.pauseInstruction
  if (session.runInstruction) entry.runInstruction = session.runInstruction
  if (session.runStartedAt) entry.runStartedAt = session.runStartedAt
  return entry
}

/** Searchable rows of a message list. Mirrors what `searchSessionMessages` reads. */
export function searchRecordsForMessages(messages: Session['messages']): SearchRecord[] {
  const out: SearchRecord[] = []
  for (const message of messages) {
    const text = searchableText(message)
    if (!text) continue
    out.push({
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      createdAt: message.createdAt,
      text,
    })
  }
  return out
}

/** Searchable rows of one loaded session. */
export function searchRecordsFor(session: Session): SearchRecord[] {
  return searchRecordsForMessages(session.messages)
}

/**
 * Rebuild a session-shaped object from derived search rows. Explicit field copy
 * again, so searching a not-yet-loaded session never hydrates its shard.
 */
export function sessionFromSearchRecords(session: Session, records: SearchRecord[]): Session {
  return {
    id: session.id,
    title: session.title,
    workspacePath: session.workspacePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    running: session.running,
    paused: session.paused,
    pausedAt: session.pausedAt,
    pauseInstruction: session.pauseInstruction,
    canContinue: session.canContinue,
    messageCount: records.length,
    instructionCount: records.filter((record) => record.role === 'user').length,
    queueCount: session.queueCount,
    todoCount: session.todoCount,
    runInstruction: session.runInstruction,
    runStartedAt: session.runStartedAt,
    approvalMode: session.approvalMode,
    sessionModelId: session.sessionModelId,
    plan: session.plan,
    kind: session.kind,
    review: session.review,
    reviewReport: session.reviewReport,
    queue: [],
    todos: [],
    messages: records.map((record) => ({
      id: record.id,
      role: record.role,
      content: record.text,
      createdAt: record.createdAt,
    })),
  }
}

/** Session ids double as file names, so keep them filesystem-safe. */
export function shardFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9_-]/g, '_')}${SHARD_EXT}`
}

/** Append-only transcript file that sits next to the metadata shard. */
export function messagesFileName(id: string): string {
  return `${shardFileName(id).slice(0, -SHARD_EXT.length)}${MESSAGES_EXT}`
}

export class SessionStorage {
  /** Last serialized bytes per file; see writeJson/writeSessionShard. */
  private readonly lastBodies = new Map<string, string>()

  constructor(private readonly root: string) {}

  get corePath(): string {
    return join(this.root, CORE_FILE)
  }

  get legacyPath(): string {
    return join(this.root, LEGACY_FILE)
  }

  get sessionsDir(): string {
    return join(this.root, SESSIONS_DIR)
  }

  get indexPath(): string {
    return join(this.sessionsDir, SESSION_INDEX_FILE)
  }

  get searchIndexPath(): string {
    return join(this.root, DERIVED_DIR, SEARCH_INDEX_FILE)
  }

  sessionPath(id: string): string {
    return join(this.sessionsDir, shardFileName(id))
  }

  messagesPath(id: string): string {
    return join(this.sessionsDir, messagesFileName(id))
  }

  /** Whether the append-only transcript exists (new layout or finished migration). */
  hasMessagesFile(id: string): boolean {
    return existsSync(this.messagesPath(id))
  }

  /**
   * Synchronous transcript read: callers are sync accessors that must not go
   * async. A partially written tail line is ignored rather than failing the
   * whole session.
   */
  readMessagesSync(id: string): unknown[] | null {
    let text: string
    try {
      text = readFileSync(this.messagesPath(id), 'utf8')
    } catch {
      return null
    }
    const out: unknown[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed))
      } catch {
        // A crash can leave the last line incomplete; earlier messages stay valid.
      }
    }
    return out
  }

  /**
   * Synchronous shard read. The metadata shard and the append-only transcript
   * are merged here; older shards that still embed `messages` are returned
   * as-is until the next save migrates them.
   */
  readSessionSync(id: string): unknown {
    const shard = JSON.parse(readFileSync(this.sessionPath(id), 'utf8')) as Record<string, unknown>
    const messages = this.readMessagesSync(id)
    return messages ? { ...shard, messages } : shard
  }

  async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch {
      return null
    }
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value)
    // A save touches several files; most of them did not change since the last
    // one. Comparing the serialized bytes turns those into a string compare
    // instead of a temp file plus rename (which dominates on Windows).
    if (this.lastBodies.get(path) === body) return
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    // Compact JSON: indentation can double the bytes on disk without helping
    // any reader (the UI parses it; humans rarely open these files).
    await writeFile(temp, body, { encoding: 'utf8', mode: FILE_MODE })
    await rename(temp, path)
    this.lastBodies.set(path, body)
  }

  readCore(): Promise<Record<string, unknown> | null> {
    return this.readJson<Record<string, unknown>>(this.corePath)
  }

  writeCore(record: Record<string, unknown>): Promise<void> {
    return this.writeJson(this.corePath, record)
  }

  readIndex(): Promise<SessionIndexFile | null> {
    return this.readJson<SessionIndexFile>(this.indexPath)
  }

  writeIndex(file: SessionIndexFile): Promise<void> {
    return this.writeJson(this.indexPath, file)
  }

  readSearchIndex(): Promise<SearchIndexFile | null> {
    return this.readJson<SearchIndexFile>(this.searchIndexPath)
  }

  writeSearchIndex(file: SearchIndexFile): Promise<void> {
    return this.writeJson(this.searchIndexPath, file)
  }

  readLegacy(): Promise<unknown> {
    return this.readJson<unknown>(this.legacyPath)
  }

  /** Keep the old single file around as `.bak` so a bad migration stays recoverable. */
  async archiveLegacy(): Promise<void> {
    try {
      await rename(this.legacyPath, `${this.legacyPath}.bak`)
    } catch {
      // Nothing to archive (first run) or the file is locked; both are fine.
    }
  }

  /**
   * Write the small metadata shard. The transcript is deliberately excluded:
   * it lives in the append-only JSONL file and is never rewritten wholesale
   * unless an edit or truncation changes history.
   *
   * A save touches every session loaded in memory, but in practice only one
   * changed. The serialized bytes of the previous write are kept so unchanged
   * shards cost a string compare instead of a temp file plus rename.
   */
  writeSessionShard(session: Session): Promise<void> {
    const meta: Record<string, unknown> = { ...session }
    delete meta.messages
    return this.writeJson(this.sessionPath(session.id), meta)
  }

  /** Replace the whole transcript atomically (edit, truncation, migration). */
  async writeSessionMessages(id: string, messages: Session['messages']): Promise<void> {
    const path = this.messagesPath(id)
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    const body = messages.length > 0 ? `${messages.map((item) => JSON.stringify(item)).join('\n')}\n` : ''
    await writeFile(temp, body, { encoding: 'utf8', mode: FILE_MODE })
    await rename(temp, path)
  }

  /** Append new messages without touching the existing transcript. */
  async appendSessionMessages(id: string, messages: Session['messages']): Promise<void> {
    if (messages.length === 0) return
    const path = this.messagesPath(id)
    await mkdir(dirname(path), { recursive: true })
    const body = `${messages.map((item) => JSON.stringify(item)).join('\n')}\n`
    await appendFile(path, body, { encoding: 'utf8', mode: FILE_MODE })
  }

  async deleteSessionShard(id: string): Promise<void> {
    // Deleting a file invalidates the write cache: a later save may produce the
    // same bytes and must recreate the file instead of being skipped.
    this.lastBodies.delete(this.sessionPath(id))
    await Promise.all([
      unlink(this.sessionPath(id)).catch(() => undefined),
      unlink(this.messagesPath(id)).catch(() => undefined),
    ])
  }

  /** Shard files on disk, so a crash between shard and index writes cannot lose a session. */
  async listShardNames(): Promise<string[]> {
    try {
      const names = await readdir(this.sessionsDir)
      return names.filter((name) => name.endsWith(SHARD_EXT) && name !== SESSION_INDEX_FILE)
    } catch {
      return []
    }
  }

  /** Bodies of shards the index does not know about yet (crash-orphaned sessions). */
  async readOrphanShards(known: Set<string>): Promise<unknown[]> {
    const names = await this.listShardNames()
    const knownNames = new Set([...known].map((id) => shardFileName(id)))
    const out: unknown[] = []
    for (const name of names) {
      if (knownNames.has(name)) continue
      const parsed = await this.readJson<Record<string, unknown>>(join(this.sessionsDir, name))
      if (!parsed) continue
      const id =
        typeof parsed['id'] === 'string' ? parsed['id'] : name.slice(0, -SHARD_EXT.length)
      const messages = this.readMessagesSync(id)
      out.push(messages ? { ...parsed, messages } : parsed)
    }
    return out
  }
}
