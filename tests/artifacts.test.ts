import { describe, expect, it } from 'vitest'
import { collectSessionArtifacts } from '../src/main/agent/artifacts'
import type { StoredMessage } from '../src/shared/types'

function assistant(
  id: string,
  calls: Array<{ id: string; name: string; path: string }>,
): StoredMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: { path: call.path },
    })),
  }
}

function tool(id: string, callId: string, failed = false): StoredMessage {
  return {
    id,
    role: 'tool',
    content: failed ? 'failed' : 'ok',
    toolCallId: callId,
    name: 'write_file',
    isError: failed,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('collectSessionArtifacts', () => {
  it('lists successful writes newest first and skips failed calls', () => {
    const messages: StoredMessage[] = [
      assistant('a1', [
        { id: 'c1', name: 'write_file', path: 'src\\app.ts' },
        { id: 'c2', name: 'apply_patch', path: 'README.md' },
      ]),
      tool('t1', 'c1'),
      tool('t2', 'c2', true),
    ]
    const artifacts = collectSessionArtifacts(messages)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      path: 'src/app.ts',
      name: 'app.ts',
      action: 'write',
      tool: 'write_file',
    })
  })

  it('dedupes by path case-insensitively and keeps the latest action', () => {
    const messages: StoredMessage[] = [
      assistant('a1', [{ id: 'c1', name: 'write_file', path: 'SRC/App.ts' }]),
      tool('t1', 'c1'),
      assistant('a2', [{ id: 'c2', name: 'apply_patch', path: 'src/app.ts' }]),
      tool('t2', 'c2'),
    ]
    const artifacts = collectSessionArtifacts(messages)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ path: 'src/app.ts', action: 'edit' })
  })

  it('ignores read-only and unknown tools', () => {
    const messages: StoredMessage[] = [
      assistant('a1', [{ id: 'c1', name: 'read_file', path: 'src/app.ts' }]),
      tool('t1', 'c1'),
    ]
    expect(collectSessionArtifacts(messages)).toEqual([])
  })
})
