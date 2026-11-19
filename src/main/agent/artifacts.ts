import type { SessionArtifact, StoredMessage } from '../../shared/types'

interface ArtifactCandidate {
  path: string
  action: SessionArtifact['action']
  tool: string
}

function candidateFor(name: string, args: Record<string, unknown>): ArtifactCandidate | null {
  if (name !== 'write_file' && name !== 'apply_patch') return null
  const path = typeof args['path'] === 'string' ? args['path'].trim() : ''
  if (!path) return null
  return {
    path: path.replace(/\\/g, '/'),
    action: name === 'write_file' ? 'write' : 'edit',
    tool: name,
  }
}

/**
 * Collect files the agent successfully wrote in this session. Paths are kept
 * relative exactly as the tools recorded them; the relay re-validates them
 * against the workspace before reading anything.
 */
export function collectSessionArtifacts(messages: StoredMessage[]): SessionArtifact[] {
  const calls = new Map<string, ArtifactCandidate>()
  const succeeded = new Set<string>()
  const failed = new Set<string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        const candidate = candidateFor(call.name, call.arguments ?? {})
        if (candidate) calls.set(call.id, candidate)
      }
      continue
    }
    if (message.role === 'tool' && message.toolCallId) {
      if (message.isError) failed.add(message.toolCallId)
      else succeeded.add(message.toolCallId)
    }
  }

  const byPath = new Map<string, SessionArtifact>()
  for (const [callId, candidate] of calls) {
    if (failed.has(callId) || !succeeded.has(callId)) continue
    const key = candidate.path.toLowerCase()
    const name = candidate.path.split('/').pop() || candidate.path
    // Later writes win, and the newest file is listed first.
    byPath.delete(key)
    byPath.set(key, {
      path: candidate.path,
      name,
      action: candidate.action,
      tool: candidate.tool,
    })
  }
  return [...byPath.values()].reverse()
}
