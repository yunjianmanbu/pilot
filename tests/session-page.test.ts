import { describe, expect, it } from 'vitest'
import type { Session, StoredMessage } from '../src/shared/types'
import { dialoguePage, isDialogueMessage, runMessages } from '../src/main/session-page'
import {
  buildTranscript,
  insertProcessMessages,
  withPendingProcesses,
  type UIMessage,
} from '../src/renderer/src/ui'

function user(id: string, content = '做这个'): StoredMessage {
  return { id, role: 'user', content, createdAt: '2026-01-01T00:00:00.000Z' }
}

function answer(id: string, runId: string, content = '已完成'): StoredMessage {
  return { id, role: 'assistant', content, createdAt: '2026-01-01T00:00:01.000Z', runId }
}

function call(id: string, runId: string): StoredMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.500Z',
    runId,
    toolCalls: [{ id: `call-${id}`, name: 'read_file', arguments: { path: 'a.ts' } }],
  }
}

function result(id: string, runId: string, failed = false): StoredMessage {
  return {
    id,
    role: 'tool',
    content: failed ? '失败' : 'ok',
    createdAt: '2026-01-01T00:00:00.700Z',
    runId,
    toolCallId: `call-${id}`,
    isError: failed,
  }
}

function sessionOf(messages: StoredMessage[]): Session {
  return {
    id: 'session-1',
    title: '测试会话',
    workspacePath: 'E:/work',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    running: false,
    paused: false,
    canContinue: false,
    messageCount: messages.length,
    queueCount: 0,
    todoCount: 0,
    approvalMode: 'manual',
    sessionModelId: '',
    plan: null,
    kind: 'coding',
    review: null,
    reviewReport: null,
    messages,
    queue: [],
    todos: [],
  } as Session
}

describe('dialogue-only paging', () => {
  const turn = (index: number): StoredMessage[] => [
    user(`u${index}`, `第 ${index} 个问题`),
    call(`c${index}`, `run-${index}`),
    result(`t${index}`, `run-${index}`),
    answer(`a${index}`, `run-${index}`, `第 ${index} 个回答`),
  ]

  it('returns dialogue messages only and reports the runs it skipped', () => {
    const session = sessionOf([...turn(1), ...turn(2), ...turn(3)])
    const page = dialoguePage(session, undefined, 2)

    expect(page.session.messages.map((message) => message.id)).toEqual(['u3', 'a3'])
    expect(page.session.messages.some((message) => message.role === 'tool')).toBe(false)
    expect(page.processes?.map((entry) => entry.runId)).toEqual(['run-3'])
    expect(page.processes?.map((entry) => entry.toolCount)).toEqual([1])
    expect(page.hasMore).toBe(true)
  })

  it('anchors each skipped run on the dialogue message it follows', () => {
    const session = sessionOf([...turn(1), ...turn(2)])
    const page = dialoguePage(session, undefined, 5)

    expect(page.processes).toEqual([
      { runId: 'run-1', afterId: 'u1', stepCount: 2, toolCount: 1, failed: 0 },
      { runId: 'run-2', afterId: 'u2', stepCount: 2, toolCount: 1, failed: 0 },
    ])
  })

  it('counts failures so the placeholder can warn', () => {
    const session = sessionOf([
      user('u1'),
      call('c1', 'run-1'),
      result('t1', 'run-1', true),
      answer('a1', 'run-1'),
    ])
    expect(dialoguePage(session, undefined, 10).processes?.[0]?.failed).toBe(1)
  })

  it('never cuts a run in half, even when asked to page before a step', () => {
    const session = sessionOf([...turn(1), ...turn(2), ...turn(3)])
    // `t2` sits inside run-2; the boundary moves to the start of that run so the
    // same run is not summarized twice. `u2` opens the older slice, so it comes
    // back with it; run-2's steps stay on the newer side.
    const page = dialoguePage(session, 't2', 10)

    expect(page.session.messages.map((message) => message.id)).toEqual(['u1', 'a1', 'u2'])
    expect(page.processes?.map((entry) => entry.runId)).toEqual(['run-1'])
    expect(page.hasMore).toBe(false)
  })

  it('reports no earlier messages when only the newest turn exists', () => {
    const page = dialoguePage(sessionOf(turn(1)), undefined, 10)
    expect(page.session.messages.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(page.hasMore).toBe(false)
  })

  it('keeps internal control prompts in the dialogue stream', () => {
    const control = user('u1')
    control.control = true
    const page = dialoguePage(sessionOf([control, ...turn(1).slice(1)]), undefined, 10)
    expect(page.session.messages.map((message) => message.id)).toEqual(['u1', 'a1'])
  })

  it('classifies tool turns as execution rather than dialogue', () => {
    expect(isDialogueMessage(call('c1', 'run-1'))).toBe(false)
    expect(isDialogueMessage(result('t1', 'run-1'))).toBe(false)
    expect(isDialogueMessage(answer('a1', 'run-1'))).toBe(true)
    expect(isDialogueMessage(user('u1'))).toBe(true)
  })
})

describe('loading one run on demand', () => {
  it('returns just that run, oldest first', () => {
    const session = sessionOf([...turnOf(1), ...turnOf(2)])
    expect(runMessages(session.messages, 'run-1').map((message) => message.id)).toEqual([
      'c1',
      't1',
      'a1',
    ])
  })

  it('caps a huge run instead of sending everything', () => {
    const messages: StoredMessage[] = [user('u1')]
    for (let index = 0; index < 20; index += 1) {
      messages.push(call(`c${index}`, 'run-1'), result(`t${index}`, 'run-1'))
    }
    expect(runMessages(messages, 'run-1', 5)).toHaveLength(5)
  })

  function turnOf(index: number): StoredMessage[] {
    return [
      user(`u${index}`, `问题 ${index}`),
      call(`c${index}`, `run-${index}`),
      result(`t${index}`, `run-${index}`),
      answer(`a${index}`, `run-${index}`, `回答 ${index}`),
    ]
  }
})

describe('pending execution placeholders', () => {
  function transcriptOf(messages: StoredMessage[]): UIMessage[] {
    return buildTranscript(messages)
  }

  const dialogueOnly = [user('u1'), answer('a1', 'run-1'), user('u2'), answer('a2', 'run-2')]

  it('places a placeholder right after the message its run follows', () => {
    const blocks = withPendingProcesses(transcriptOf(dialogueOnly), [
      { runId: 'run-1', afterId: 'u1', stepCount: 2, toolCount: 1, failed: 0 },
      { runId: 'run-2', afterId: 'u2', stepCount: 3, toolCount: 2, failed: 1 },
    ])

    expect(blocks.map((block) => block.id)).toEqual([
      'u1',
      'pending-run-1',
      'a1',
      'u2',
      'pending-run-2',
      'a2',
    ])
    const first = blocks[1]
    expect(first?.kind === 'process' && first.pending).toEqual({
      stepCount: 2,
      toolCount: 1,
      failed: 0,
    })
  })

  it('keeps runs that share one anchor in order and drops loaded ones', () => {
    const loaded = [...dialogueOnly, call('c1', 'run-1'), result('t1', 'run-1')]
    const blocks = withPendingProcesses(transcriptOf(loaded), [
      { runId: 'run-1', afterId: 'u1', stepCount: 2, toolCount: 1, failed: 0 },
      { runId: 'run-3', afterId: 'u1', stepCount: 1, toolCount: 1, failed: 0 },
      { runId: 'run-4', afterId: 'u1', stepCount: 1, toolCount: 1, failed: 0 },
    ])

    expect(blocks.some((block) => block.id === 'pending-run-1')).toBe(false)
    const pending = blocks.filter(
      (block) => block.kind === 'process' && block.pending,
    )
    expect(pending.map((block) => block.id)).toEqual(['pending-run-3', 'pending-run-4'])
  })

  it('puts a run without an anchor at the top of the loaded window', () => {
    const blocks = withPendingProcesses(transcriptOf(dialogueOnly), [
      { runId: 'run-0', stepCount: 1, toolCount: 1, failed: 0 },
    ])
    expect(blocks[0]?.id).toBe('pending-run-0')
  })
})

describe('splicing a loaded run back in', () => {
  it('inserts the steps after their anchor and skips messages already present', () => {
    const loaded = [user('u1'), answer('a1', 'run-1'), user('u2'), answer('a2', 'run-2')]
    const merged = insertProcessMessages(
      loaded,
      [user('u1'), call('c1', 'run-1'), result('t1', 'run-1'), answer('a1', 'run-1')],
      'u1',
    )

    expect(merged.map((message) => message.id)).toEqual(['u1', 'c1', 't1', 'a1', 'u2', 'a2'])
  })

  it('prepends when the anchor has not been loaded', () => {
    const loaded = [user('u2'), answer('a2', 'run-2')]
    const merged = insertProcessMessages(loaded, [call('c1', 'run-1')], 'u1')
    expect(merged.map((message) => message.id)).toEqual(['c1', 'u2', 'a2'])
  })
})
