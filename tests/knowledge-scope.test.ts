import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { knowledgeScopeLabel, planKnowledgeScope, sortKnowledgePairsNewestFirst } from '../src/renderer/src/knowledge'
import type { SessionSummary } from '../src/shared/types'

// These assertions pin the Chinese source copy; the effective locale depends
// on navigator.language, which is en-US on the Linux CI runner.
setLocale('zh-CN')

function summary(id: string, workspacePath: string): SessionSummary {
  return {
    id,
    title: `会话 ${id}`,
    workspacePath,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    running: false,
    paused: false,
    canContinue: false,
    messageCount: 1,
    queueCount: 0,
    todoCount: 0,
    approvalMode: 'auto',
    sessionModelId: '',
    plan: null,
    kind: 'coding',
    review: null,
    reviewReport: null,
  }
}

const sessions = [
  summary('a', 'C:\\work\\alpha'),
  summary('b', 'C:/work/alpha'),
  summary('c', 'C:\\work\\beta'),
]

describe('planKnowledgeScope', () => {
  it('global covers every session and honors an optional workspace filter', () => {
    const all = planKnowledgeScope(sessions, {
      scope: 'global',
      activeWorkspace: 'C:\\work\\alpha',
      sessionId: 'a',
    })
    expect(all.filter).toEqual({})
    expect(all.sessions).toHaveLength(3)

    const filtered = planKnowledgeScope(sessions, {
      scope: 'global',
      activeWorkspace: 'C:\\work\\alpha',
      sessionId: 'a',
      workspaceFilter: 'C:/work/alpha/',
    })
    expect(filtered.filter).toEqual({ workspacePath: 'C:/work/alpha/' })
    expect(filtered.sessions.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('project requires an active workspace and matches path separators', () => {
    expect(
      planKnowledgeScope(sessions, {
        scope: 'project',
        activeWorkspace: null,
        sessionId: null,
      }),
    ).toEqual({ filter: null, sessions: [] })

    const project = planKnowledgeScope(sessions, {
      scope: 'project',
      activeWorkspace: 'c:/work/alpha',
      sessionId: null,
    })
    expect(project.filter).toEqual({ workspacePath: 'c:/work/alpha' })
    expect(project.sessions.map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('session requires a selection and narrows to exactly that session', () => {
    expect(
      planKnowledgeScope(sessions, {
        scope: 'session',
        activeWorkspace: 'C:\\work\\alpha',
        sessionId: null,
      }),
    ).toEqual({ filter: null, sessions: [] })

    const session = planKnowledgeScope(sessions, {
      scope: 'session',
      activeWorkspace: 'C:\\work\\alpha',
      sessionId: 'c',
    })
    expect(session.filter).toEqual({ sessionId: 'c' })
    expect(session.sessions.map((entry) => entry.id)).toEqual(['c'])
  })

  it('labels the three levels', () => {
    expect(knowledgeScopeLabel('global')).toBe('全局知识库')
    expect(knowledgeScopeLabel('project')).toBe('项目知识库')
    expect(knowledgeScopeLabel('session')).toBe('会话知识库')
  })
})

describe('sortKnowledgePairsNewestFirst', () => {
  const pairs = [
    { key: 'a', index: 1, instructionAt: '2026-01-01T08:00:00.000Z' },
    { key: 'b', index: 2, instructionAt: '2026-01-02T08:00:00.000Z' },
    { key: 'c', index: 3, instructionAt: '2026-01-03T08:00:00.000Z' },
  ]

  it('puts the newest round on top without touching the source array', () => {
    expect(sortKnowledgePairsNewestFirst(pairs).map((pair) => pair.key)).toEqual(['c', 'b', 'a'])
    expect(pairs.map((pair) => pair.key)).toEqual(['a', 'b', 'c'])
    // Round numbers stay in true chronological order, only the display order flips.
    expect(sortKnowledgePairsNewestFirst(pairs).map((pair) => pair.index)).toEqual([3, 2, 1])
  })

  it('sorts by timestamp even when the input arrives out of order', () => {
    const shuffled = [pairs[1]!, pairs[2]!, pairs[0]!]
    expect(sortKnowledgePairsNewestFirst(shuffled).map((pair) => pair.key)).toEqual(['c', 'b', 'a'])
  })

  it('falls back to the round index when timestamps are missing or equal', () => {
    expect(
      sortKnowledgePairsNewestFirst([
        { key: 'a', index: 1, instructionAt: '' },
        { key: 'b', index: 2, instructionAt: '' },
        { key: 'c', index: 3, instructionAt: '2026-01-03T08:00:00.000Z' },
      ]).map((pair) => pair.key),
    ).toEqual(['c', 'b', 'a'])

    const same = [
      { key: 'x', index: 1, instructionAt: '2026-01-01T00:00:00.000Z' },
      { key: 'y', index: 1, instructionAt: '2026-01-01T00:00:00.000Z' },
    ]
    expect(sortKnowledgePairsNewestFirst(same).map((pair) => pair.key)).toEqual(['y', 'x'])
  })
})
