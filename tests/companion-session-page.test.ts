import { describe, expect, it } from 'vitest'
import { getSession } from '../src/main/companion/handlers/views'
import type { CompanionServer } from '../src/main/companion/server'
import type { Session, StoredMessage } from '../src/shared/types'

// 手机端「加载更早」的分页契约：默认仍是原始消息窗口（含工具步骤，首屏靠它显示
// 执行过程），带上 `conversation: true` 时一页必须是真正的问答正文。改动前按原始
// 消息条数切页，25 条里通常只有 0–3 条正文，用户要连点很多次才翻回上一轮。

function user(id: string): StoredMessage {
  return { id, role: 'user', content: `问题 ${id}`, createdAt: '2026-01-01T00:00:00.000Z' }
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

function result(id: string, runId: string): StoredMessage {
  return {
    id,
    role: 'tool',
    content: 'ok',
    createdAt: '2026-01-01T00:00:00.700Z',
    runId,
    toolCallId: `call-${id}`,
  }
}

function answer(id: string, runId: string): StoredMessage {
  return {
    id,
    role: 'assistant',
    content: `回答 ${id}`,
    createdAt: '2026-01-01T00:00:01.000Z',
    runId,
  }
}

/** 一轮 = 提问 + 一次工具调用 + 结果 + 回答，四条原始消息里只有两条是正文。 */
function turn(index: number): StoredMessage[] {
  return [
    user(`u${index}`),
    call(`c${index}`, `run-${index}`),
    result(`t${index}`, `run-${index}`),
    answer(`a${index}`, `run-${index}`),
  ]
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

function hostOf(session: Session): CompanionServer {
  return {
    options: {
      store: { session: () => session, workspaces: () => [] },
      runner: {
        isRunning: () => false,
        pendingApprovalList: () => [],
        activeRun: () => null,
      },
    },
    phoneSafeMessages: (messages: StoredMessage[]) => messages,
  } as unknown as CompanionServer
}

describe('sessions.get paging for the phone', () => {
  it('keeps the legacy raw-message window when conversation paging is off', () => {
    const session = sessionOf([...turn(1), ...turn(2), ...turn(3), ...turn(4)])
    const data = getSession(hostOf(session), { sessionId: 'session-1', limit: 8 })

    // 首屏仍要看得见执行过程，所以默认窗口不改：8 条原始消息 = 两轮，含工具消息。
    expect(data.session.messages).toHaveLength(8)
    expect(data.session.messages.some((message) => message.role === 'tool')).toBe(true)
    expect(data.hasMore).toBe(true)
  })

  it('counts a conversation page in dialogue messages, not raw rows', () => {
    const session = sessionOf([...turn(1), ...turn(2), ...turn(3), ...turn(4)])
    const data = getSession(hostOf(session), {
      sessionId: 'session-1',
      limit: 4,
      conversation: true,
    })

    // 4 条正文 = 两轮问答，而不是 4 条原始消息（那只有一轮）。
    expect(data.session.messages.map((message) => message.id)).toEqual(['u3', 'a3', 'u4', 'a4'])
    expect(data.session.messages.some((message) => message.toolCalls?.length)).toBe(false)
    expect(data.hasMore).toBe(true)
    // 老窗口里 25 条原始消息才抵得上一页正文；这里一条工具步骤都不该混进来。
    expect(data.session.messages.some((message) => message.role === 'tool')).toBe(false)
  })

  it('walks the whole transcript backwards without gaps or repeats', () => {
    const rounds = Array.from({ length: 12 }, (_, index) => turn(index + 1)).flat()
    const session = sessionOf(rounds)
    const host = hostOf(session)
    const seen: string[] = []
    let before: string | undefined
    let pages = 0

    for (;;) {
      const data = getSession(host, {
        sessionId: 'session-1',
        limit: 5,
        conversation: true,
        ...(before ? { before } : {}),
      })
      const ids = data.session.messages.map((message) => message.id)
      if (ids.length === 0) break
      // 新的一页插在旧的更早位置：与已见集合不能重叠。
      for (const id of ids) expect(seen).not.toContain(id)
      seen.unshift(...ids)
      pages += 1
      if (!data.hasMore) break
      before = ids[0]
      expect(pages).toBeLessThan(20)
    }

    const expected = rounds
      .filter(
        (message) =>
          message.role === 'user' ||
          (message.role === 'assistant' && !message.toolCalls?.length),
      )
      .map((message) => message.id)
    expect(pages).toBeGreaterThan(1)
    // 视图给的是末尾一页（第一页），所以先翻到的在末尾；顺序必须与原文一致。
    expect(seen).toEqual(expected)
  })

  it('lets around win over conversation paging', () => {
    const session = sessionOf([...turn(1), ...turn(2), ...turn(3)])
    const data = getSession(hostOf(session), {
      sessionId: 'session-1',
      limit: 4,
      around: 'c2',
      conversation: true,
    })

    // 知识库定位命中的可能是工具消息，识别不到就退回最新窗口，不能因为
    // conversation 参数就换成别的切法。
    expect(data.session.messages.some((message) => message.id === 'c2')).toBe(true)
  })
})
