import { describe, expect, it } from 'vitest'
import type { Session, StoredMessage } from '../src/shared/types'
import {
  alignTailStart,
  dialoguePage,
  isDialogueMessage,
  runMessages,
  sessionPage,
  TAIL_RUN_LIMIT,
} from '../src/main/session-page'
import {
  buildTranscript,
  insertProcessMessages,
  mergePendingProcesses,
  processPlaceholders,
  restoreCachedRuns,
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

function turn(index: number): StoredMessage[] {
  return [
    user(`u${index}`, `第 ${index} 个问题`),
    call(`c${index}`, `run-${index}`),
    result(`t${index}`, `run-${index}`),
    answer(`a${index}`, `run-${index}`, `第 ${index} 个回答`),
  ]
}

describe('dialogue-only paging', () => {

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

  it('never stacks a run without an anchor above the conversation', () => {
    const blocks = withPendingProcesses(transcriptOf(dialogueOnly), [
      { runId: 'run-0', stepCount: 1, toolCount: 1, failed: 0 },
    ])

    // Its question is not in this window, so it belongs to the earlier history:
    // a box here would sit above the reader's first message, unrelated to it.
    expect(blocks.map((block) => block.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('shows no box at all in a fresh conversation that has no messages', () => {
    // 新建任务后 session 是空的，但状态里可能还留着上一个会话的占位框。它们
    // 都带着旧会话的 afterId，在本窗口一条也对不上，就一个都不该出现。
    const blocks = withPendingProcesses(transcriptOf([]), [
      { runId: 'run-1', afterId: 'u1', stepCount: 2, toolCount: 1, failed: 0 },
      { runId: 'run-2', afterId: 'u2', stepCount: 3, toolCount: 2, failed: 0 },
    ])

    expect(blocks).toEqual([])
  })
})

describe('which skipped runs still deserve a placeholder', () => {
  const summary = (runId: string, afterId: string) => ({
    runId,
    afterId,
    stepCount: 2,
    toolCount: 1,
    failed: 0,
  })

  it('drops the runs whose answer the reader already sees', () => {
    // 每一轮都只丢下它的工具调用，回答本身在页里。给这种轮次再挂一个「未加载」
    // 灰框，翻一页就多一排，正是长会话上拉变成一墙执行框的原因。
    const messages = [...turn(1), ...turn(2)].filter((message) => message.role !== 'tool')
    expect(
      processPlaceholders([summary('run-1', 'u1'), summary('run-2', 'u2')], messages),
    ).toEqual([])
  })

  it('keeps the run that stopped without an answer', () => {
    // 中断的那一轮只留下工具调用，没有回答：框就是它唯一剩下的东西。
    const messages = [user('u1'), call('c1', 'run-1'), result('t1', 'run-1')]
    expect(processPlaceholders([summary('run-1', 'u1')], messages)).toEqual([
      summary('run-1', 'u1'),
    ])
  })

  it('keeps a run whose answer falls outside the window', () => {
    // 回答在下一页时，这一轮在屏幕上确实没有结果，框留着才能展开看过程。
    expect(processPlaceholders([summary('run-1', 'u1')], [user('u1')])).toEqual([
      summary('run-1', 'u1'),
    ])
  })
})

describe('aligning a tail boundary to run edges', () => {
  it('moves the boundary to the start of the run it lands inside', () => {
    const messages = [...turn(1), ...turn(2)]
    const index = messages.findIndex((message) => message.id === 't2')

    // `u2` asks for the run, so it must stay inside the window with its steps.
    expect(alignTailStart(messages, index, messages.length)).toBe(
      messages.findIndex((message) => message.id === 'u2'),
    )
  })

  it('keeps a boundary that already opens a run or starts the window', () => {
    const messages = [...turn(1), ...turn(2)]
    const head = messages.findIndex((message) => message.id === 'u2')

    expect(alignTailStart(messages, head, messages.length)).toBe(head)
    expect(alignTailStart(messages, 0, messages.length)).toBe(0)
  })

  it('skips a run too large to pull in so it stays a placeholder', () => {
    const huge = [user('u1')]
    for (let step = 0; step < 500; step += 1) huge.push(call(`c${step}`, 'run-huge'))
    huge.push(answer('a1', 'run-huge'))
    const boundary = huge.findIndex((message) => message.id === 'c450')

    expect(alignTailStart(huge, boundary, huge.length)).toBe(huge.length)
  })
})

describe('opening a session page', () => {
  const fiveTurns = sessionOf([
    ...turn(1),
    ...turn(2),
    ...turn(3),
    ...turn(4),
    ...turn(5),
  ])

  it('never opens inside a run and keeps the older turns behind load earlier', () => {
    const page = sessionPage(fiveTurns, undefined, 6)
    const ids = page.session.messages.map((message) => message.id)

    // The window would have started at `t4`, halfway through run-4.
    expect(ids).toEqual(['u4', 'c4', 't4', 'a4', 'u5', 'c5', 't5', 'a5'])
    expect(page.hasMore).toBe(true)
    // Runs older than the window are not reported: opening a conversation must
    // show its last turns, not a stack of placeholders for every old run.
    expect(page.processes).toBeUndefined()
  })

  it('shows the same window when the session is opened again', () => {
    const first = sessionPage(fiveTurns, undefined, 6)
    const second = sessionPage(fiveTurns, undefined, 6)

    expect(second.processes).toBeUndefined()
    expect(second.session.messages.map((message) => message.id)).toEqual(
      first.session.messages.map((message) => message.id),
    )
  })

  it('caps the newest page at a few runs even when the message budget is large', () => {
    const manyTurns = sessionOf(
      Array.from({ length: 12 }, (_, index) => turn(index + 1)).flat(),
    )
    const page = sessionPage(manyTurns, undefined, 500)
    const runs = new Set(
      page.session.messages
        .map((message) => message.runId)
        .filter((runId): runId is string => Boolean(runId)),
    )
    const ids = page.session.messages.map((message) => message.id)

    expect(runs.size).toBe(TAIL_RUN_LIMIT)
    expect(page.session.messages).toHaveLength(TAIL_RUN_LIMIT * 4)
    // The question that introduced the oldest run stays with its steps.
    expect(ids[0]).toBe(`u${12 - TAIL_RUN_LIMIT + 1}`)
    expect(page.hasMore).toBe(true)
  })

  it('reports nothing when every run fits in the window', () => {
    const page = sessionPage(sessionOf(turn(1)), undefined, 120)

    expect(page.processes).toBeUndefined()
    expect(page.hasMore).toBe(false)
  })
})

describe('merging reported placeholders with the loaded ones', () => {
  const entry = (runId: string) => ({ runId, stepCount: 1, toolCount: 0, failed: 0 })

  it('keeps earlier placeholders and drops runs already in the transcript', () => {
    const merged = mergePendingProcesses(
      [entry('run-1'), entry('run-2')],
      [entry('run-2'), entry('run-3')],
      new Set(['run-3']),
    )

    expect(merged.map((item) => item.runId)).toEqual(['run-1', 'run-2'])
  })

  it('does not duplicate a run reported twice', () => {
    expect(mergePendingProcesses([], [entry('run-1'), entry('run-1')], new Set()).length).toBe(1)
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

  it('lands in transcript order when the anchor is not loaded', () => {
    const loaded = [user('u2'), answer('a2', 'run-2')]
    const merged = insertProcessMessages(loaded, [call('c1', 'run-1')], 'u1')

    // `c1` was written a moment after `u2`, so it follows that message instead
    // of jumping above the whole conversation.
    expect(merged.map((message) => message.id)).toEqual(['u2', 'c1', 'a2'])
  })

  it('appends steps written after every loaded message', () => {
    const loaded = [user('u1'), answer('a1', 'run-1')]
    const later: StoredMessage = {
      ...call('c9', 'run-9'),
      createdAt: '2026-01-01T00:00:09.000Z',
    }
    const merged = insertProcessMessages(loaded, [later])

    expect(merged.map((message) => message.id)).toEqual(['u1', 'a1', 'c9'])
  })
})

describe('returning to a conversation the reader already expanded', () => {
  it('keeps the window clean when the opened run belongs to earlier history', () => {
    // A 4-message window over three turns opens at `t3`; run-1 ends long before
    // it, so its steps belong to history the reader has not scrolled back to.
    const page = sessionPage(sessionOf([...turn(1), ...turn(2), ...turn(3)]), undefined, 4)
    const cached = new Map([
      ['run-1', { afterId: 'u1', messages: [call('c1', 'run-1'), result('t1', 'run-1')] }],
    ])

    const restored = restoreCachedRuns(page.session.messages, cached)

    expect(restored.map((message) => message.id)).toEqual(
      page.session.messages.map((message) => message.id),
    )
  })

  it('splices steps after their anchor when the window still holds it', () => {
    const messages = [user('u1'), answer('a1', 'run-1'), user('u2')]
    const cached = new Map([
      ['run-1', { afterId: 'u1', messages: [call('c1', 'run-1'), result('t1', 'run-1')] }],
    ])

    const restored = restoreCachedRuns(messages, cached)

    expect(restored.map((message) => message.id)).toEqual(['u1', 'c1', 't1', 'a1', 'u2'])
  })

  it('does not duplicate the steps it already restored', () => {
    const messages = [user('u1'), answer('a1', 'run-1')]
    const cached = new Map([
      ['run-1', { afterId: 'u1', messages: [call('c1', 'run-1'), result('t1', 'run-1')] }],
      ['run-2', { afterId: 'u2', messages: [call('c2', 'run-2')] }],
    ])

    const once = restoreCachedRuns(messages, cached)
    const twice = restoreCachedRuns(once, cached)

    expect(once.map((message) => message.id)).toEqual(['u1', 'c1', 't1', 'a1'])
    expect(twice.map((message) => message.id)).toEqual(once.map((message) => message.id))
  })

  it('keeps two runs that share one anchor in order', () => {
    const messages = [user('u1'), answer('a1', 'run-2')]
    const later: StoredMessage = {
      ...call('c2', 'run-2'),
      createdAt: '2026-01-01T00:00:00.600Z',
    }
    const cached = new Map([
      ['run-2', { afterId: 'u1', messages: [later] }],
      ['run-1', { afterId: 'u1', messages: [call('c1', 'run-1')] }],
    ])

    const restored = restoreCachedRuns(messages, cached)

    // Both runs hang off one question; the one written first stays first even
    // though its cache entry is newer.
    expect(restored.map((message) => message.id)).toEqual(['u1', 'c1', 'c2', 'a1'])
  })
})
