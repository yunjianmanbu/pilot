import type { SessionArtifact, StoredMessage } from './types'

/**
 * Files the agent wrote, derived from recorded tool calls.
 *
 * The collector lives in `shared` because both sides need the same answer: the
 * main process lists a session's output for the drawer, and the renderer shows
 * the per-answer change bar straight from the messages it already renders. Two
 * implementations would drift on the one detail that matters (a `write_file`
 * only counts once its tool result succeeded).
 */
export interface ArtifactCandidate {
  path: string
  action: SessionArtifact['action']
  tool: string
}

/** Tools that create or modify a file. Everything else is read-only noise. */
export function artifactCandidate(name: string, args: Record<string, unknown>): ArtifactCandidate | null {
  if (name !== 'write_file' && name !== 'apply_patch') return null
  const path = typeof args['path'] === 'string' ? args['path'].trim() : ''
  if (!path) return null
  return {
    path: path.replace(/\\/g, '/'),
    action: name === 'write_file' ? 'write' : 'edit',
    tool: name,
  }
}

function toArtifact(candidate: ArtifactCandidate): SessionArtifact {
  return {
    path: candidate.path,
    name: candidate.path.split('/').pop() || candidate.path,
    action: candidate.action,
    tool: candidate.tool,
  }
}

/**
 * Dedupe by path (case-insensitively, because Windows and macOS both hand back
 * differently-cased paths for the same file). Later writes win and the newest
 * file is listed first.
 */
function finalize(candidates: Iterable<ArtifactCandidate>): SessionArtifact[] {
  const byPath = new Map<string, SessionArtifact>()
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase()
    byPath.delete(key)
    byPath.set(key, toArtifact(candidate))
  }
  return [...byPath.values()].reverse()
}

/**
 * Collect files the agent successfully wrote in this session. Paths are kept
 * relative exactly as the tools recorded them; the relay re-validates them
 * against the workspace before reading anything.
 *
 * `runId` narrows the result to one turn, which is what the answer's change
 * bar needs.
 */
export function collectSessionArtifacts(
  messages: StoredMessage[],
  options: { runId?: string } = {},
): SessionArtifact[] {
  const scoped =
    options.runId === undefined ? messages : messages.filter((message) => message.runId === options.runId)
  const calls = new Map<string, ArtifactCandidate>()
  const succeeded = new Set<string>()
  const failed = new Set<string>()

  for (const message of scoped) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        const candidate = artifactCandidate(call.name, call.arguments ?? {})
        if (candidate) calls.set(call.id, candidate)
      }
      continue
    }
    if (message.role === 'tool' && message.toolCallId) {
      if (message.isError) failed.add(message.toolCallId)
      else succeeded.add(message.toolCallId)
    }
  }

  const done: ArtifactCandidate[] = []
  for (const [callId, candidate] of calls) {
    if (failed.has(callId) || !succeeded.has(callId)) continue
    done.push(candidate)
  }
  return finalize(done)
}

/**
 * One entry per run, so a transcript can put the files under the answer that
 * produced them. Messages written before runs were tracked carry no `runId`;
 * they are folded into the `''` bucket and never shown per answer.
 */
export function collectArtifactsByRun(messages: StoredMessage[]): Map<string, SessionArtifact[]> {
  const grouped = new Map<string, StoredMessage[]>()
  for (const message of messages) {
    const runId = message.runId ?? ''
    const bucket = grouped.get(runId)
    if (bucket) bucket.push(message)
    else grouped.set(runId, [message])
  }
  const out = new Map<string, SessionArtifact[]>()
  for (const [runId, bucket] of grouped) {
    const files = collectSessionArtifacts(bucket)
    if (files.length > 0) out.set(runId, files)
  }
  return out
}

/**
 * Same filtering for a run that has not been persisted yet: the renderer only
 * knows the live tool views while the answer is still streaming.
 */
export function artifactsFromCalls(
  calls: Array<{ name: string; args: Record<string, unknown>; ok: boolean }>,
): SessionArtifact[] {
  const done: ArtifactCandidate[] = []
  for (const call of calls) {
    if (!call.ok) continue
    const candidate = artifactCandidate(call.name, call.args)
    if (candidate) done.push(candidate)
  }
  return finalize(done)
}