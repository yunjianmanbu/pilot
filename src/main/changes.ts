import { open, stat } from 'node:fs/promises'
import type { RevertChangeResult, Session, SessionChange } from '../shared/types'
import { collectSessionArtifacts } from './agent/artifacts'
import { createUnifiedDiff } from './agent/diff'
import type { CheckpointService } from './checkpoints'
import { resolveExisting } from './workspace'

const MAX_FILE_BYTES = 512 * 1024
const MAX_DIFF_CHARS = 80_000

interface CurrentFile {
  state: 'text' | 'binary' | 'missing'
  content: string
  bytes: number
}

function normalizeRel(value: string): string {
  return value.split('\\').join('/')
}

async function readWorkspaceFile(root: string, relPath: string): Promise<CurrentFile> {
  let target: string
  try {
    target = await resolveExisting(root, relPath)
  } catch {
    return { state: 'missing', content: '', bytes: 0 }
  }
  const info = await stat(target).catch(() => null)
  if (!info || !info.isFile()) return { state: 'missing', content: '', bytes: 0 }
  const length = Math.min(info.size, MAX_FILE_BYTES)
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const sample = buffer.subarray(0, Math.min(bytesRead, 8_000))
    if (sample.includes(0)) {
      return { state: 'binary', content: '', bytes: info.size }
    }
    return {
      state: 'text',
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      bytes: info.size,
    }
  } finally {
    await handle.close()
  }
}

/** Count changed lines in a unified diff, excluding headers. */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/**
 * Compare every file the agent wrote in this session against the session
 * baseline. The baseline is the first snapshot of the session, which the store
 * pins against retention: "the oldest still retained" would otherwise slide
 * forward and change what "before the run" means.
 */
export async function listSessionChanges(
  session: Session,
  checkpoints: CheckpointService | null,
): Promise<SessionChange[]> {
  const artifacts = collectSessionArtifacts(session.messages)
  if (artifacts.length === 0) return []
  const baseline = checkpoints ? await checkpoints.oldest(session.id) : null
  const changes: SessionChange[] = []

  for (const artifact of artifacts) {
    const path = normalizeRel(artifact.path)
    const current = await readWorkspaceFile(session.workspacePath, path)
    if (current.state === 'binary') {
      changes.push({
        path,
        name: artifact.name,
        action: artifact.action,
        status: 'unreadable',
        diff: '',
        added: 0,
        removed: 0,
        canRevert: Boolean(baseline),
        note: '二进制文件无法预览差异。',
      })
      continue
    }
    if (!baseline) {
      changes.push({
        path,
        name: artifact.name,
        action: artifact.action,
        status: current.state === 'missing' ? 'deleted' : 'modified',
        diff: '',
        added: 0,
        removed: 0,
        canRevert: false,
        note: '这个会话没有可用的基线回退点，无法安全撤销。',
      })
      continue
    }

    const snapshot = await checkpoints!.readBaselineFile(session.id, baseline.id, path).catch(
      () => null,
    )
    if (snapshot === null) {
      changes.push({
        path,
        name: artifact.name,
        action: artifact.action,
        status: 'unreadable',
        diff: '',
        added: 0,
        removed: 0,
        canRevert: false,
        note: '基线快照读取失败，无法比较或撤销。',
      })
      continue
    }
    if (snapshot.found && snapshot.content === null) {
      changes.push({
        path,
        name: artifact.name,
        action: artifact.action,
        status: 'unreadable',
        diff: '',
        added: 0,
        removed: 0,
        canRevert: true,
        note: '基线中的这个文件是二进制内容，无法预览差异，但仍可撤销。',
      })
      continue
    }

    const baselineContent = snapshot.found ? snapshot.content ?? '' : ''
    const currentContent = current.state === 'text' ? current.content : ''
    const status: SessionChange['status'] = snapshot.found
      ? current.state === 'missing'
        ? 'deleted'
        : 'modified'
      : 'added'
    const diff = baseline.complete || snapshot.found
      ? createUnifiedDiff(path, baselineContent, currentContent).slice(0, MAX_DIFF_CHARS)
      : ''
    const counts = countDiffLines(diff)
    const canRevert = snapshot.found || baseline.complete
    changes.push({
      path,
      name: artifact.name,
      action: artifact.action,
      status,
      diff,
      ...counts,
      canRevert,
      ...(canRevert
        ? {}
        : { note: '基线回退点不完整，无法确认这个文件是否为新建，已禁用撤销。' }),
    })
  }
  return changes
}

/** Revert exactly one file changed by the agent, moving new files to trash. */
export async function revertSessionFile(
  session: Session,
  checkpoints: CheckpointService | null,
  path: string,
): Promise<RevertChangeResult> {
  if (!checkpoints) throw new Error('回退点服务未初始化')
  const rel = normalizeRel(path)
  const known = collectSessionArtifacts(session.messages).some(
    (artifact) => normalizeRel(artifact.path).toLowerCase() === rel.toLowerCase(),
  )
  if (!known) throw new Error('这个文件不是本次会话修改的产物')
  const baseline = await checkpoints.oldest(session.id)
  if (!baseline) throw new Error('这个会话没有可用的基线回退点')
  const result = await checkpoints.revertPaths(session.id, baseline.id, [rel])
  return {
    path: rel,
    restored: result.restored > 0,
    removed: result.removed > 0,
  }
}
