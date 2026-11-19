import type { MessageSearchFilter, SessionSummary } from '../../shared/types'
import { t } from './i18n'

/** Three knowledge levels: every session, the active project, one session. */
export type KnowledgeScope = 'global' | 'project' | 'session'

export interface KnowledgeScopeInput {
  scope: KnowledgeScope
  activeWorkspace: string | null
  sessionId: string | null
  /** Global-level workspace narrowing, chosen in the filter bar. */
  workspaceFilter?: string
}

export interface KnowledgeScopePlan {
  /** Search filter, or null when the scope lacks its required selection. */
  filter: MessageSearchFilter | null
  /** Sessions covered by the scope, used for browse lists and counters. */
  sessions: SessionSummary[]
}

function pathKey(path: string): string {
  return path.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function planKnowledgeScope(
  sessions: SessionSummary[],
  input: KnowledgeScopeInput,
): KnowledgeScopePlan {
  if (input.scope === 'global') {
    const workspacePath = (input.workspaceFilter ?? '').trim()
    if (!workspacePath) return { filter: {}, sessions: [...sessions] }
    return {
      filter: { workspacePath },
      sessions: sessions.filter(
        (session) => pathKey(session.workspacePath) === pathKey(workspacePath),
      ),
    }
  }
  if (input.scope === 'project') {
    const workspacePath = input.activeWorkspace
    if (!workspacePath) return { filter: null, sessions: [] }
    return {
      filter: { workspacePath },
      sessions: sessions.filter(
        (session) => pathKey(session.workspacePath) === pathKey(workspacePath),
      ),
    }
  }
  const sessionId = input.sessionId
  if (!sessionId) return { filter: null, sessions: [] }
  return {
    filter: { sessionId },
    sessions: sessions.filter((session) => session.id === sessionId),
  }
}

/**
 * Knowledge pairs always render newest first: the last round you had sits on top.
 * Sorting by timestamp (instead of a blind reverse) keeps the order right even when
 * the main process returns pairs in a different order, and an equal/missing stamp
 * falls back to the round index so the list never reshuffles between renders.
 */
export function sortKnowledgePairsNewestFirst<T extends { instructionAt?: string; index?: number }>(
  pairs: T[],
): T[] {
  return pairs
    .map((pair, position) => ({ pair, position }))
    .sort((left, right) => {
      const byTime = stamp(right.pair.instructionAt) - stamp(left.pair.instructionAt)
      if (byTime) return byTime
      const byIndex = (right.pair.index ?? 0) - (left.pair.index ?? 0)
      if (byIndex) return byIndex
      return right.position - left.position
    })
    .map((entry) => entry.pair)
}

function stamp(value?: string | number | null): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const time = Date.parse(String(value ?? ''))
  return Number.isFinite(time) ? time : 0
}

export function knowledgeScopeLabel(scope: KnowledgeScope): string {
  if (scope === 'global') return t("全局知识库")
  if (scope === 'project') return t("项目知识库")
  return t("会话知识库")
}
