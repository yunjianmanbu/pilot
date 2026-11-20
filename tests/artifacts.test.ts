import { describe, expect, it } from 'vitest'
import {
  artifactsFromCalls,
  collectArtifactsByRun,
  collectSessionArtifacts,
} from '../src/shared/artifacts'
import type { StoredMessage } from '../src/shared/types'

function assistant(
  id: string,
  calls: Array<{ id: string; name: string; path: string }>,
  runId = 'run-1',
): StoredMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    runId,
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: { path: call.path },
    })),
  }
}

function tool(id: string, callId: string, failed = false, runId = 'run-1'): StoredMessage {
  return {
    id,
    role: 'tool',
    content: failed ? 'failed' : 'ok',
    toolCallId: callId,
    name: 'write_file',
    isError: failed,
    createdAt: '2026-01-01T00:00:00.000Z',
    runId,
  }
}

/** One stored turn that wrote `paths`, in order. */
function turn(runId: string, paths: string[]): StoredMessage[] {
  const calls = paths.map((path, index) => ({ id: `${runId}-c${index}`, name: 'write_file', path }))
  return [
    assistant(`${runId}-a`, calls, runId),
    ...calls.map((call, i) => tool(`${runId}-t${i}`, call.id, false, runId)),
  ]
}

describe('collectArtifactsByRun', () => {
  it('groups files under the run that produced them', () => {
    const messages = [...turn('run-1', ['src/a.ts']), ...turn('run-2', ['src/b.ts', 'src/c.ts'])]
    const byRun = collectArtifactsByRun(messages)
    expect([...(byRun.get('run-1') ?? [])].map((file) => file.path)).toEqual(['src/a.ts'])
    expect([...(byRun.get('run-2') ?? [])].map((file) => file.path)).toEqual(['src/c.ts', 'src/b.ts'])
  })

  it('skips runs that wrote nothing, so no empty change bar renders', () => {
    const messages: StoredMessage[] = [
      {
        ...assistant('a1', [{ id: 'c1', name: 'read_file', path: 'src/app.ts' }]),
        runId: 'run-read',
      },
      tool('t1', 'c1', true),
    ]
    expect(collectArtifactsByRun(messages).size).toBe(0)
  })

  it('keeps legacy messages without a runId out of every turn', () => {
    const legacy: StoredMessage[] = [
      {
        id: 'old-a',
        role: 'assistant',
        content: '',
        createdAt: '2025-01-01T00:00:00.000Z',
        toolCalls: [{ id: 'old-c', name: 'write_file', arguments: { path: 'old.ts' } }],
      },
      {
        id: 'old-t',
        role: 'tool',
        content: 'ok',
        toolCallId: 'old-c',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ]
    const byRun = collectArtifactsByRun([...legacy, ...turn('run-1', ['src/a.ts'])])
    expect(byRun.has('run-1')).toBe(true)
    expect(byRun.has('')).toBe(true)
    expect(byRun.get('run-1')?.map((file) => file.path)).toEqual(['src/a.ts'])
  })

  it('filters a single run by runId', () => {
    const messages = [...turn('run-1', ['src/a.ts']), ...turn('run-2', ['src/b.ts'])]
    expect(collectSessionArtifacts(messages, { runId: 'run-2' }).map((file) => file.path)).toEqual([
      'src/b.ts',
    ])
  })

  it('dedupes a path written twice in the same run and keeps the latest action', () => {
    const messages = [
      ...turn('run-1', ['src/a.ts']),
      assistant('run-1-a2', [{ id: 'e1', name: 'apply_patch', path: 'src/a.ts' }], 'run-1'),
      tool('run-1-t9', 'e1'),
    ]
    const files = collectSessionArtifacts(messages, { runId: 'run-1' })
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'src/a.ts', action: 'edit' })
  })

  it('normalises Windows separators so the drawer and the bar agree', () => {
    const files = collectSessionArtifacts(turn('run-1', ['src\\nested\\a.ts']), { runId: 'run-1' })
    expect(files[0]).toMatchObject({ path: 'src/nested/a.ts', name: 'a.ts' })
  })
})

describe('artifactsFromCalls', () => {
  it('reads the live tool views of a run that is still streaming', () => {
    const files = artifactsFromCalls([
      { name: 'write_file', args: { path: 'out/new.txt' }, ok: true },
      { name: 'apply_patch', args: { path: 'out/old.txt' }, ok: true },
      { name: 'read_file', args: { path: 'out/read.txt' }, ok: true },
      { name: 'write_file', args: { path: 'out/failed.txt' }, ok: false },
    ])
    expect(files.map((file) => `${file.action}:${file.path}`)).toEqual([
      'edit:out/old.txt',
      'write:out/new.txt',
    ])
  })

  it('returns nothing while a call is still running', () => {
    expect(
      artifactsFromCalls([{ name: 'write_file', args: { path: 'a.ts' }, ok: false }]),
    ).toEqual([])
  })
})