import { describe, expect, it } from 'vitest'
import type { Session, StoredMessage } from '../src/shared/types'
import {
  buildKnowledgePairs,
  clipKnowledgePair,
  knowledgePairsFor,
  searchSessionMessages,
} from '../src/main/search'

function message(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'role'>): StoredMessage {
  return {
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as StoredMessage
}

function session(id: string, messages: StoredMessage[], updatedAt = '2026-01-01T00:00:00.000Z'): Session {
  return {
    id,
    title: `会话 ${id}`,
    workspacePath: 'C:/work/demo',
    createdAt: updatedAt,
    updatedAt,
    messages,
    queue: [],
    todos: [],
    approvalMode: 'auto',
    running: false,
    paused: false,
    canContinue: false,
  } as unknown as Session
}

describe('searchSessionMessages', () => {
  it('matches user and assistant content case-insensitively', () => {
    const hits = searchSessionMessages(
      [
        session('a', [
          message({ id: 'm1', role: 'user', content: 'Fix the LOGIN bug' }),
          message({ id: 'm2', role: 'assistant', content: 'Login 已经修复' }),
        ]),
      ],
      'login',
    )
    expect(hits.map((hit) => hit.messageId)).toEqual(['m2', 'm1'])
    expect(hits[0]?.role).toBe('assistant')
    expect(hits[0]?.sessionId).toBe('a')
    expect(hits[0]?.workspacePath).toBe('C:/work/demo')
  })

  it('matches CJK queries and builds context snippets', () => {
    const hits = searchSessionMessages(
      [session('a', [message({ id: 'm1', role: 'user', content: `${'前'.repeat(80)}需要修改构建脚本${'后'.repeat(80)}` })])],
      '构建脚本',
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.snippet).toContain('构建脚本')
    expect(hits[0]?.snippet.startsWith('…')).toBe(true)
    expect(hits[0]?.snippet.endsWith('…')).toBe(true)
  })

  it('ignores tool messages and internal control prompts', () => {
    const hits = searchSessionMessages(
      [
        session('a', [
          message({ id: 'm1', role: 'tool', content: 'secret token' }),
          message({ id: 'm2', role: 'user', content: 'secret token', control: true }),
          message({ id: 'm3', role: 'assistant', content: 'secret token' }),
        ]),
      ],
      'secret',
    )
    expect(hits.map((hit) => hit.messageId)).toEqual(['m3'])
  })

  it('prefers the most recently updated sessions and respects the limit', () => {
    const hits = searchSessionMessages(
      [
        session('old', [message({ id: 'old-1', role: 'user', content: 'needle' })], '2026-01-01T00:00:00.000Z'),
        session('new', [message({ id: 'new-1', role: 'user', content: 'needle' })], '2026-02-01T00:00:00.000Z'),
      ],
      'needle',
      1,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe('new')
  })

  it('returns nothing for an empty query', () => {
    expect(searchSessionMessages([session('a', [message({ id: 'm1', role: 'user', content: 'x' })])], '   ')).toEqual([])
  })

  it('narrows by workspace, session, role and time for the knowledge base', () => {
    const messages = [
      message({ id: 'u1', role: 'user', content: 'deploy token', createdAt: '2026-01-01T00:00:00.000Z' }),
      message({
        id: 'a1',
        role: 'assistant',
        content: 'deploy token ok',
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    ]
    const sessions = [
      session('a', messages),
      { ...session('b', messages), workspacePath: 'C:/work/other' },
    ]

    expect(
      searchSessionMessages(sessions, 'deploy', 20, { workspacePath: 'c:\\WORK\\other\\' })
        .map((hit) => hit.sessionId),
    ).toEqual(['b', 'b'])
    expect(
      searchSessionMessages(sessions, 'deploy', 20, { sessionId: 'a' }).map(
        (hit) => hit.sessionId,
      ),
    ).toEqual(['a', 'a'])
    expect(
      searchSessionMessages(sessions, 'deploy', 20, { role: 'assistant' }).map(
        (hit) => hit.role,
      ),
    ).toEqual(['assistant', 'assistant'])
    expect(
      searchSessionMessages(sessions, 'deploy', 20, { since: '2026-01-15T00:00:00.000Z' }).map(
        (hit) => hit.messageId,
      ),
    ).toEqual(['a1', 'a1'])
  })

  it('caps the knowledge-base result limit at 200', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message({ id: `m${index}`, role: 'assistant', content: 'needle' }),
    )
    const sessions = Array.from({ length: 30 }, (_, index) => session(`s${index}`, messages))
    expect(searchSessionMessages(sessions, 'needle', 500)).toHaveLength(200)
  })
})

describe('buildKnowledgePairs', () => {
  it('pairs each instruction with the assistant replies that follow it', () => {
    const pairs = buildKnowledgePairs([
      message({ id: 'u1', role: 'user', content: '第一个问题' }),
      message({ id: 'a1', role: 'assistant', content: '先看看' }),
      message({ id: 'a2', role: 'assistant', content: '结论一' }),
      message({ id: 't1', role: 'tool', content: '工具输出' }),
      message({ id: 'u2', role: 'user', content: '第二个问题' }),
      message({ id: 'a3', role: 'assistant', content: '结论二' }),
    ])

    expect(pairs.map((pair) => [pair.index, pair.instruction, pair.reply])).toEqual([
      [1, '第一个问题', '先看看\n\n结论一'],
      [2, '第二个问题', '结论二'],
    ])
    expect(pairs[0]?.instructionId).toBe('u1')
    expect(pairs[0]?.replyId).toBe('a1')
    expect(pairs[0]?.replyCount).toBe(2)
    expect(pairs[1]?.replyAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('skips internal control prompts and keeps instructions still awaiting a reply', () => {
    const pairs = buildKnowledgePairs([
      message({ id: 'c1', role: 'user', content: '内部续跑', control: true }),
      message({ id: 't1', role: 'tool', content: '结果是 ok' }),
      message({ id: 'u1', role: 'user', content: '还在等回复' }),
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.instruction).toBe('还在等回复')
    expect(pairs[0]?.reply).toBe('')
    expect(pairs[0]?.replyCount).toBe(0)
  })

  it('clips long instructions and replies for the relay payload', () => {
    const [pair] = buildKnowledgePairs([
      message({ id: 'u1', role: 'user', content: 'x'.repeat(2_000) }),
      message({ id: 'a1', role: 'assistant', content: 'y'.repeat(4_000) }),
    ])
    const clipped = clipKnowledgePair(pair!)
    expect(clipped.instructionTruncated).toBe(true)
    expect(clipped.replyTruncated).toBe(true)
    expect(clipped.instruction).toHaveLength(1_601)
    expect(clipped.reply).toHaveLength(3_201)
  })
})

describe('knowledgePairsFor', () => {
  const messages = [
    message({ id: 'u1', role: 'user', content: '怎么部署？' }),
    message({ id: 'a1', role: 'assistant', content: '用 pnpm build，然后上传 dist。' }),
    message({ id: 'u2', role: 'user', content: '日志在哪里看？' }),
    message({ id: 'a2', role: 'assistant', content: '在 /var/log/pilot.log。' }),
  ]

  it('browses the newest pairs last and reports the full total', () => {
    const result = knowledgePairsFor(messages, '', 1)
    expect(result.total).toBe(2)
    expect(result.pairs).toHaveLength(1)
    expect(result.pairs[0]?.instructionId).toBe('u2')
  })

  it('searches instruction and reply text case-insensitively', () => {
    const result = knowledgePairsFor(messages, 'PNPM BUILD')
    expect(result.total).toBe(1)
    expect(result.pairs[0]?.instructionId).toBe('u1')
    expect(result.pairs[0]?.replyId).toBe('a1')
  })

  it('returns nothing for a query that matches no pair', () => {
    expect(knowledgePairsFor(messages, '不存在的关键词')).toEqual({ pairs: [], total: 0 })
  })
})
