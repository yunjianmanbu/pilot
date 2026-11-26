/**
 * 工作区导出包的读与写。
 *
 * `shared/workspace-pack.ts` 定义格式，这里负责真正落盘：用 jszip 生成
 * `.pilotpack.zip`，导入时把包拆回 JSON 与文件。所有条目路径都经过
 * `isSafePackEntryPath` 校验，包里的条目永远不会写到目标目录之外。
 *
 * 密钥在这一层是明文：调用方传进来的 `secrets` 已经是解出来的原文，
 * 导入端拿到的也是原文，由 store 重新用 safeStorage 加密。这个文件不碰
 * safeStorage，也不会把密钥值写进日志。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import JSZip from 'jszip'
import type {
  MemoryEntry,
  ProfileVersion,
  QuickCommand,
  RunRecord,
  ScheduledTask,
  Session,
} from '../shared/types'
import type { ReflectionReport } from '../shared/reflect'
import type { PersistedSettings } from './store-schema'
import {
  PACK_CHECKPOINTS_DIR,
  PACK_CORE_FILE,
  PACK_FILES_DIR,
  PACK_MANIFEST_FILE,
  PACK_MAX_FILES,
  PACK_MAX_FILE_BYTES,
  PACK_MAX_UNPACKED_BYTES,
  PACK_SESSIONS_DIR,
  PACK_SECRETS_FILE,
  WORKSPACE_PACK_FORMAT,
  WORKSPACE_PACK_VERSION,
  countWorkspaceSecrets,
  emptyWorkspaceSecrets,
  isSafePackEntryPath,
  parseWorkspacePackManifest,
  sanitizeWorkspaceSecrets,
  scopeIsEmpty,
  workspaceSecretsIsEmpty,
  type WorkspacePackCounts,
  type WorkspacePackManifest,
  type WorkspacePackScope,
  type WorkspaceSecrets,
} from '../shared/workspace-pack'
import { walk } from './personal/tree'

/** 导出端交给打包器的全部内容（已解密、已脱离 store 私有状态）。 */
export interface WorkspacePackSnapshot {
  workspace: {
    memory: MemoryEntry[]
    profiles: ProfileVersion[]
    runs: RunRecord[]
  }
  /** 该工作区的全部会话，`messages` 已加载。 */
  sessions: Session[]
  scheduled: ScheduledTask[]
  settings: {
    settings: PersistedSettings
    quickCommands: QuickCommand[]
    reflectionReports: ReflectionReport[]
  } | null
  secrets: WorkspaceSecrets | null
}

/** manifest 里由打包器补齐之外的静态字段。 */
export type WorkspacePackManifestSeed = Pick<
  WorkspacePackManifest,
  'createdAt' | 'appVersion' | 'platform' | 'workspace' | 'origin'
>

export interface WriteWorkspacePackInput {
  snapshot: WorkspacePackSnapshot
  scope: WorkspacePackScope
  manifest: WorkspacePackManifestSeed
  /** 工作区根目录，`scope.files` 为真时从这里收集文件。 */
  workspacePath: string
  /** 检查点根目录（`<userData>/checkpoints`），`scope.checkpoints` 为真时打包。 */
  checkpointRoot: string
  /** 输出 zip 的绝对路径。 */
  target: string
  onProgress?: (message: string) => void
}

export interface WriteWorkspacePackResult {
  counts: WorkspacePackCounts
  /** 写进包的 manifest 本身，与文件里的内容逐字一致。 */
  manifest: WorkspacePackManifest
  secretCount: number
  /** 写出后的 zip 字节数。 */
  bytes: number
}

function sessionMeta(session: Session): Record<string, unknown> {
  const { messages: _messages, ...rest } = session
  return rest as unknown as Record<string, unknown>
}

function messagesJsonl(session: Session): string {
  return session.messages.map((message) => JSON.stringify(message)).join('\n')
}

async function listTree(root: string, limit: number): Promise<Array<{ path: string; absolute: string; size: number }>> {
  const out: Array<{ path: string; absolute: string; size: number }> = []
  const visit = async (relative: string): Promise<void> => {
    if (out.length >= limit) return
    const directory = relative ? join(root, ...relative.split('/')) : root
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(relative ? `${relative}/${entry.name}` : entry.name)
        continue
      }
      if (!entry.isFile()) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      try {
        const info = await stat(join(root, ...path.split('/')))
        out.push({ path, absolute: join(root, ...path.split('/')), size: info.size })
      } catch {
        // 被清理线程挪走的文件：跳过即可，不影响其余快照。
      }
      if (out.length >= limit) return
    }
  }
  await visit('')
  return out
}

/**
 * 生成一个导出包。
 *
 * 先扫一遍再写 zip：manifest 里的计数是给用户确认范围用的，写进 zip
 * 之后就无法再改。
 */
export async function writeWorkspacePack(
  input: WriteWorkspacePackInput,
): Promise<WriteWorkspacePackResult> {
  const { snapshot, scope, workspacePath, checkpointRoot, target } = input
  if (scopeIsEmpty(scope)) throw new Error('至少需要勾选一项导出内容')

  const zip = new JSZip()
  const counts: WorkspacePackCounts = {
    files: 0,
    fileBytes: 0,
    skippedFiles: 0,
    sessions: 0,
    messages: 0,
    todos: 0,
    scheduled: 0,
    checkpoints: 0,
  }

  // ---- 会话（含待办、队列、计划、评审报告）----
  if (scope.sessions) {
    for (const session of snapshot.sessions) {
      zip.file(`${PACK_SESSIONS_DIR}/${session.id}.json`, JSON.stringify(sessionMeta(session)))
      zip.file(`${PACK_SESSIONS_DIR}/${session.id}.messages.jsonl`, messagesJsonl(session))
      counts.sessions += 1
      counts.messages += session.messages.length
      counts.todos += session.todos.length
    }
    counts.scheduled = snapshot.scheduled.length
  }

  // ---- 设置与密钥 ----
  const secrets = scope.secrets ? (snapshot.secrets ?? emptyWorkspaceSecrets()) : null
  const secretCount = secrets ? countWorkspaceSecrets(secrets) : 0
  const core: Record<string, unknown> = {
    version: WORKSPACE_PACK_VERSION,
    exportedAt: input.manifest.createdAt,
    workspace: {
      name: input.manifest.workspace.name,
      path: input.manifest.workspace.path,
      memory: snapshot.workspace.memory,
      profiles: snapshot.workspace.profiles,
      runs: snapshot.workspace.runs,
    },
    scheduled: scope.sessions ? snapshot.scheduled : [],
  }
  if (scope.settings && snapshot.settings) {
    core['settings'] = snapshot.settings.settings
    core['quickCommands'] = snapshot.settings.quickCommands
    core['reflectionReports'] = snapshot.settings.reflectionReports
  }
  zip.file(PACK_CORE_FILE, JSON.stringify(core, null, 2))
  if (secrets && !workspaceSecretsIsEmpty(secrets)) {
    zip.file(PACK_SECRETS_FILE, JSON.stringify(secrets))
  }

  // ---- 工作区文件 ----
  if (scope.files) {
    input.onProgress?.('正在收集工作区文件…')
    let entries: Awaited<ReturnType<typeof walk>> = []
    try {
      entries = await walk(workspacePath, '', [], false)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (counts.files >= PACK_MAX_FILES) {
        counts.skippedFiles += 1
        continue
      }
      if (entry.size > PACK_MAX_FILE_BYTES) {
        counts.skippedFiles += 1
        continue
      }
      try {
        zip.file(`${PACK_FILES_DIR}/${entry.path}`, await readFile(entry.absolute))
        counts.files += 1
        counts.fileBytes += entry.size
      } catch {
        counts.skippedFiles += 1
      }
    }
  }

  // ---- 检查点 ----
  if (scope.checkpoints) {
    input.onProgress?.('正在收集检查点…')
    for (const file of await listTree(checkpointRoot, PACK_MAX_FILES * 4)) {
      try {
        zip.file(`${PACK_CHECKPOINTS_DIR}/${file.path}`, await readFile(file.absolute))
        counts.checkpoints += 1
      } catch {
        // 单个快照文件读不到不影响其余内容。
      }
    }
  }

  const manifest: WorkspacePackManifest = {
    ...input.manifest,
    format: WORKSPACE_PACK_FORMAT,
    version: WORKSPACE_PACK_VERSION,
    scope,
    counts,
    includesSecrets: Boolean(secrets && !workspaceSecretsIsEmpty(secrets)),
  }
  zip.file(PACK_MANIFEST_FILE, JSON.stringify(manifest, null, 2))

  input.onProgress?.('正在压缩…')
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, buffer)
  return { counts, manifest, secretCount, bytes: buffer.length }
}

export interface PackSessionPayload {
  /** 包里的会话 id。 */
  id: string
  meta: Record<string, unknown>
  messages: unknown[]
}

export interface ReadWorkspacePackOptions {
  /**
   * 包内结构校验通过后立刻回调一次，让调用方能在落盘大量文件前确认
   * 「这个包里有密钥 / 有多大」。
   */
  onManifest?: (manifest: WorkspacePackManifest) => void | Promise<void>
  /** 工作区文件落地回调，`relative` 是 `workspace/` 之后的部分。 */
  writeWorkspaceFile?: (relative: string, data: Buffer) => Promise<void>
  /** 检查点条目落地回调，`relative` 是 `checkpoints/` 之后的部分。 */
  writeCheckpointFile?: (relative: string, data: Buffer) => Promise<void>
}

export interface ReadWorkspacePackResult {
  manifest: WorkspacePackManifest
  core: Record<string, unknown>
  sessions: PackSessionPayload[]
  secrets: WorkspaceSecrets | null
  /** 被跳过的条目：路径不安全、单文件超限或读不出来。 */
  skipped: string[]
  filesWritten: number
  checkpointFilesWritten: number
}

/**
 * 读一个导出包。
 *
 * 先解析 manifest 与 JSON 结构，再逐个落地文件：同一时刻只有一个文件在
 * 内存里，累计解压量超过上限就中止，避免 zip 炸弹写满磁盘。
 */
export async function readWorkspacePack(
  zipPath: string,
  options: ReadWorkspacePackOptions = {},
): Promise<ReadWorkspacePackResult> {
  const buffer = await readFile(zipPath)
  const zip = await JSZip.loadAsync(buffer)
  const skipped: string[] = []

  const manifestEntry = zip.file(PACK_MANIFEST_FILE)
  if (!manifestEntry) throw new Error('这不是 Pilot 工作区导出包：缺少 manifest.json')
  const manifest = parseWorkspacePackManifest(JSON.parse(await manifestEntry.async('string')))
  if (!manifest) throw new Error('导出包的 manifest 不完整或版本不受支持')
  await options.onManifest?.(manifest)

  const coreEntry = zip.file(PACK_CORE_FILE)
  const core = coreEntry
    ? (JSON.parse(await coreEntry.async('string')) as Record<string, unknown>)
    : {}

  const secretsEntry = zip.file(PACK_SECRETS_FILE)
  const secrets = secretsEntry
    ? sanitizeWorkspaceSecrets(JSON.parse(await secretsEntry.async('string')))
    : null

  const sessionMetaFiles = new Map<string, typeof manifestEntry>()
  const sessionMessageFiles = new Map<string, typeof manifestEntry>()
  const payloadEntries: Array<{ name: string; entry: (typeof manifestEntry) & object }> = []
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const name = entry.name
    if (!isSafePackEntryPath(name)) {
      skipped.push(name)
      continue
    }
    if (name.startsWith(`${PACK_SESSIONS_DIR}/`)) {
      const rest = name.slice(PACK_SESSIONS_DIR.length + 1)
      if (rest.endsWith('.messages.jsonl')) {
        sessionMessageFiles.set(rest.slice(0, -'.messages.jsonl'.length), entry)
      } else if (rest.endsWith('.json')) {
        sessionMetaFiles.set(rest.slice(0, -'.json'.length), entry)
      }
      continue
    }
    if (name.startsWith(`${PACK_FILES_DIR}/`) || name.startsWith(`${PACK_CHECKPOINTS_DIR}/`)) {
      payloadEntries.push({ name, entry })
    }
  }

  let unpacked = 0
  let filesWritten = 0
  let checkpointFilesWritten = 0
  for (const { name, entry } of payloadEntries) {
    const data = await entry.async('nodebuffer')
    unpacked += data.length
    if (unpacked > PACK_MAX_UNPACKED_BYTES) {
      throw new Error('导出包解压后超过 2 GiB，已中止导入')
    }
    if (data.length > PACK_MAX_FILE_BYTES) {
      skipped.push(name)
      continue
    }
    if (name.startsWith(`${PACK_FILES_DIR}/`)) {
      if (!options.writeWorkspaceFile) continue
      await options.writeWorkspaceFile(name.slice(PACK_FILES_DIR.length + 1), data)
      filesWritten += 1
      continue
    }
    if (!options.writeCheckpointFile) continue
    await options.writeCheckpointFile(name.slice(PACK_CHECKPOINTS_DIR.length + 1), data)
    checkpointFilesWritten += 1
  }

  const sessions: PackSessionPayload[] = []
  for (const [id, metaEntry] of sessionMetaFiles) {
    let meta: Record<string, unknown>
    try {
      meta = JSON.parse(await metaEntry.async('string')) as Record<string, unknown>
    } catch {
      skipped.push(`${PACK_SESSIONS_DIR}/${id}.json`)
      continue
    }
    const messages: unknown[] = []
    const messageEntry = sessionMessageFiles.get(id)
    if (messageEntry) {
      const text = await messageEntry.async('string')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          messages.push(JSON.parse(trimmed))
        } catch {
          // 损坏的一行跳过，其余消息仍然可用。
        }
      }
    }
    sessions.push({ id, meta, messages })
  }

  return { manifest, core, sessions, secrets, skipped, filesWritten, checkpointFilesWritten }
}
