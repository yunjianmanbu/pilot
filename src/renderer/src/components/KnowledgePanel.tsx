import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  KnowledgePair,
  MessageSearchFilter,
  MessageSearchHit,
  SessionSummary,
  WorkspaceSummary,
} from '../../../shared/types'
import { HistoryIcon, SearchIcon, XIcon } from '../icons'
import { SelectMenu } from './SelectMenu'
import {
  knowledgeScopeLabel,
  planKnowledgeScope,
  sortKnowledgePairsNewestFirst,
  type KnowledgeScope,
} from '../knowledge'
import { formatNumber, formatRelative } from '../ui'
import { t } from '../i18n'

type RoleFilter = 'all' | 'user' | 'assistant'
type RangeFilter = 'all' | '7d' | '30d'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_QUERY = 2
const HIT_LIMIT = 120
const PAIR_LIMIT = 80

interface HitGroup {
  sessionId: string
  sessionTitle: string
  workspacePath: string
  hits: MessageSearchHit[]
}

function pathKey(path: string): string {
  return path.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function stamp(value?: string): number {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const haystack = text.toLowerCase()
  const target = needle.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let at = haystack.indexOf(target)
  let key = 0
  while (at >= 0 && key < 60) {
    if (at > cursor) parts.push(text.slice(cursor, at))
    parts.push(<mark key={`m-${key}`}>{text.slice(at, at + needle.length)}</mark>)
    key += 1
    cursor = at + needle.length
    at = haystack.indexOf(target, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.length > 0 ? parts : text
}

function scopeDescription(scope: KnowledgeScope): string {
  if (scope === 'global') return t("检索所有工作区里的历史会话，找到结论、决策和原始消息并直接跳回。")
  if (scope === 'project') return t("只看当前工作区的历史会话，适合查阅这个项目自己的方案与约定。")
  return t("把当前会话整理成「我的指令 → Pilot 回复」的轮次，支持检索并跳回原始消息。")
}

function searchPlaceholder(scope: KnowledgeScope): string {
  if (scope === 'global') return t("搜索所有会话，例如：登录超时、部署脚本、鉴权方案")
  if (scope === 'project') return t("搜索当前项目的历史会话…")
  return t("搜索这个会话的提问与回复…")
}

export function KnowledgePanel({
  workspaces,
  sessions,
  activeWorkspace,
  activeSessionId,
  scope,
  sessionId,
  onScopeChange,
  onSessionChange,
  onOpenHit,
  onOpenMessage,
  onOpenSession,
  onError,
}: {
  workspaces: WorkspaceSummary[]
  sessions: SessionSummary[]
  activeWorkspace: string | null
  activeSessionId: string | null
  scope: KnowledgeScope
  sessionId: string | null
  onScopeChange: (scope: KnowledgeScope) => void
  onSessionChange: (sessionId: string | null) => void
  onOpenHit: (hit: MessageSearchHit) => void
  onOpenMessage: (sessionId: string, messageId: string) => void
  onOpenSession: (session: SessionSummary) => void
  onError: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>('all')
  const [hits, setHits] = useState<MessageSearchHit[]>([])
  const [pairs, setPairs] = useState<KnowledgePair[]>([])
  const [pairTotal, setPairTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  const [pairsLoading, setPairsLoading] = useState(false)
  const [error, setError] = useState('')
  const searchSeq = useRef(0)

  const needle = query.trim()
  const ready = needle.length >= MIN_QUERY
  const workspaceByKey = useMemo(
    () => new Map(workspaces.map((workspace) => [pathKey(workspace.path), workspace])),
    [workspaces],
  )
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  const plan = useMemo(
    () => planKnowledgeScope(sessions, { scope, activeWorkspace, sessionId, workspaceFilter }),
    [activeWorkspace, scope, sessionId, sessions, workspaceFilter],
  )
  const projectCount = useMemo(
    () =>
      planKnowledgeScope(sessions, { scope: 'project', activeWorkspace, sessionId: null }).sessions
        .length,
    [activeWorkspace, sessions],
  )
  const selectedSession = useMemo(
    () => (sessionId ? sessionById.get(sessionId) ?? null : null),
    [sessionById, sessionId],
  )
  const orderedSessions = useMemo(
    () => [...sessions].sort((left, right) => stamp(right.updatedAt) - stamp(left.updatedAt)),
    [sessions],
  )
  const scopedSessions = plan.sessions
  const totalMessages = useMemo(
    () => scopedSessions.reduce((total, session) => total + (Number(session.messageCount) || 0), 0),
    [scopedSessions],
  )
  const recent = useMemo(
    () => [...scopedSessions].sort((left, right) => stamp(right.updatedAt) - stamp(left.updatedAt)),
    [scopedSessions],
  )
  // Session knowledge renders newest first, so the round you just had is on top.
  const visiblePairs = useMemo(() => sortKnowledgePairsNewestFirst(pairs), [pairs])

  const workspaceName = (path: string) =>
    workspaceByKey.get(pathKey(path))?.name || path.split(/[\\/]/).pop() || path

  // Global and project levels search message hits through the derived index.
  useEffect(() => {
    if (scope === 'session' || (scope === 'project' && !activeWorkspace) || !ready) {
      searchSeq.current += 1
      setHits([])
      setSearching(false)
      setError('')
      return
    }
    const seq = ++searchSeq.current
    setSearching(true)
    setError('')
    const timer = window.setTimeout(() => {
      const filter: MessageSearchFilter = {}
      if (scope === 'global' && workspaceFilter) filter.workspacePath = workspaceFilter
      if (scope === 'project' && activeWorkspace) filter.workspacePath = activeWorkspace
      if (roleFilter !== 'all') filter.role = roleFilter
      if (rangeFilter !== 'all') {
        filter.since = new Date(Date.now() - (rangeFilter === '7d' ? 7 : 30) * DAY_MS).toISOString()
      }
      void window.pilot
        .searchMessages(needle, HIT_LIMIT, filter)
        .then((result) => {
          if (searchSeq.current !== seq) return
          setHits(result)
          setSearching(false)
        })
        .catch((reason: unknown) => {
          if (searchSeq.current !== seq) return
          const message = reason instanceof Error ? reason.message : String(reason)
          setHits([])
          setSearching(false)
          setError(message)
          onError(message)
        })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [activeWorkspace, needle, rangeFilter, ready, roleFilter, scope, workspaceFilter, onError])

  // Session level works on instruction→reply pairs instead of raw messages.
  useEffect(() => {
    if (scope !== 'session' || !sessionId) {
      setPairs([])
      setPairTotal(0)
      setPairsLoading(false)
      return
    }
    let cancelled = false
    setPairsLoading(true)
    const timer = window.setTimeout(() => {
      void window.pilot
        .knowledgePairs(sessionId, ready ? needle : '', PAIR_LIMIT)
        .then((result) => {
          if (cancelled) return
          setPairs(result.pairs)
          setPairTotal(result.total)
          setPairsLoading(false)
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          const message = reason instanceof Error ? reason.message : String(reason)
          setPairs([])
          setPairTotal(0)
          setPairsLoading(false)
          setError(message)
          onError(message)
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [needle, onError, ready, scope, sessionId])

  const groups = useMemo<HitGroup[]>(() => {
    const map = new Map<string, HitGroup>()
    for (const hit of hits) {
      let group = map.get(hit.sessionId)
      if (!group) {
        group = {
          sessionId: hit.sessionId,
          sessionTitle: hit.sessionTitle || t("未命名会话"),
          workspacePath: hit.workspacePath,
          hits: [],
        }
        map.set(hit.sessionId, group)
      }
      group.hits.push(hit)
    }
    return [...map.values()]
  }, [hits])

  const stats =
    scope === 'session'
      ? [
          { value: pairTotal, label: t("轮对话") },
          { value: selectedSession?.messageCount ?? 0, label: t("条消息") },
          { value: 1, label: t("个会话") },
        ]
      : [
          { value: scopedSessions.length, label: t("个会话") },
          { value: totalMessages, label: t("条消息") },
          { value: scope === 'project' ? 1 : workspaces.length, label: t("个工作区") },
        ]

  const selectable = plan.filter !== null
  const levelCount = (level: KnowledgeScope): string => {
    if (level === 'global') return t("{v1} 个会话", { v1: sessions.length })
    if (level === 'project') return t("{v1} 个会话", { v1: projectCount })
    return selectedSession ? t("{v1} 条消息", { v1: selectedSession.messageCount }) : t("未选择")
  }

  return (
    <div className="page panel-page knowledge-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <HistoryIcon width={13} height={13} />
            {t("三级知识库")}</div>
          <h1>{t("知识库")}</h1>
          <p>{scopeDescription(scope)}</p>
        </div>
        <div className="stat-strip">
          {stats.map((stat) => (
            <div className="stat" key={stat.label}>
              <strong>{formatNumber(stat.value)}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="knowledge-levels" role="tablist" aria-label={t("知识库层级")}>
        {(['global', 'project', 'session'] as KnowledgeScope[]).map((level) => (
          <button
            type="button"
            role="tab"
            aria-selected={scope === level}
            className={`knowledge-level${scope === level ? ' is-active' : ''}`}
            key={level}
            onClick={() => onScopeChange(level)}
          >
            <span>{knowledgeScopeLabel(level)}</span>
            <small>{levelCount(level)}</small>
          </button>
        ))}
      </div>

      <div className="knowledge-search">
        <SearchIcon width={16} height={16} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder(scope)}
          aria-label={t("搜索{v1}", { v1: knowledgeScopeLabel(scope) })}
          autoFocus
          disabled={!selectable}
        />
        {query ? (
          <button
            type="button"
            className="knowledge-clear"
            onClick={() => setQuery('')}
            aria-label={t("清空搜索")}
          >
            <XIcon width={14} height={14} />
          </button>
        ) : null}
      </div>

      <div className="knowledge-filters">
        {scope === 'global' ? (
          <div className="knowledge-filter">
            <span>{t("工作区")}</span>
            <SelectMenu
              className="knowledge-menu"
              value={workspaceFilter}
              onChange={setWorkspaceFilter}
              ariaLabel={t("按工作区筛选")}
              maxListWidth={280}
              options={[
                { value: '', label: t("全部工作区") },
                ...workspaces.map((workspace) => ({
                  value: workspace.path,
                  label: workspace.name,
                })),
              ]}
            />
          </div>
        ) : null}
        {scope === 'project' ? (
          <span className="knowledge-scope-note">
            {t("当前项目：")}{activeWorkspace ? workspaceName(activeWorkspace) : t("未选择工作区")}
          </span>
        ) : null}
        {scope === 'session' ? (
          <div className="knowledge-filter knowledge-filter-wide">
            <span>{t("会话")}</span>
            <SelectMenu
              className="knowledge-menu"
              value={sessionId ?? ''}
              onChange={(value) => onSessionChange(value || null)}
              ariaLabel={t("选择会话")}
              maxListWidth={360}
              options={[
                { value: '', label: t("选择会话") },
                ...orderedSessions.map((session) => ({
                  value: session.id,
                  label: `${session.title || t("未命名会话")} · ${workspaceName(session.workspacePath)}`,
                })),
              ]}
            />
          </div>
        ) : null}
        {scope !== 'session' ? (
          <>
            <div className="knowledge-filter">
              <span>{t("角色")}</span>
              <SelectMenu
                className="knowledge-menu"
                value={roleFilter}
                onChange={(value) => setRoleFilter(value as RoleFilter)}
                ariaLabel={t("按角色筛选")}
                maxListWidth={200}
                options={[
                  { value: 'all', label: t("全部") },
                  { value: 'user', label: t("我的提问") },
                  { value: 'assistant', label: t("Pilot 回复") },
                ]}
              />
            </div>
            <div className="knowledge-filter">
              <span>{t("时间")}</span>
              <SelectMenu
                className="knowledge-menu"
                value={rangeFilter}
                onChange={(value) => setRangeFilter(value as RangeFilter)}
                ariaLabel={t("按时间筛选")}
                maxListWidth={200}
                options={[
                  { value: 'all', label: t("全部时间") },
                  { value: '7d', label: t("最近 7 天") },
                  { value: '30d', label: t("最近 30 天") },
                ]}
              />
            </div>
            {scope === 'global' && activeWorkspace && workspaceFilter !== activeWorkspace ? (
              <button
                type="button"
                className="knowledge-scope"
                onClick={() => setWorkspaceFilter(activeWorkspace)}
              >
                {t("只看当前工作区")}</button>
            ) : null}
          </>
        ) : null}
      </div>

      {!selectable ? (
        <div className="empty-panel">
          <HistoryIcon width={22} height={22} />
          <strong>
            {scope === 'project' ? t("还没有选择工作区") : t("还没有选择会话")}
          </strong>
          <span>
            {scope === 'project'
              ? t("先在左上角选择一个工作区，再查看它的项目知识库。")
              : t("从上方选择一个会话，或打开一个会话后点击顶部的知识库按钮。")}
          </span>
          {scope === 'session' && activeSessionId ? (
            <button
              type="button"
              className="knowledge-scope"
              onClick={() => onSessionChange(activeSessionId)}
            >
              {t("查看当前会话")}</button>
          ) : null}
        </div>
      ) : scope === 'session' ? (
        <div className="knowledge-results">
          <div className="knowledge-results-head">
            <span>
              {pairsLoading
                ? t("正在载入…")
                : t("{v1} {v2} 轮{v3}", { v1: ready ? t("命中") : t("共"), v2: formatNumber(pairTotal), v3: pairs.length >= PAIR_LIMIT ? t(" · 显示最近 {v1} 轮", { v1: PAIR_LIMIT }) : '' })}
            </span>
            {error ? <span className="knowledge-error">{error}</span> : null}
          </div>
          {selectedSession ? (
            <div className="knowledge-session-current">
              <span className="knowledge-group-title">
                {selectedSession.title || t("未命名会话")}
              </span>
              <span className="knowledge-group-meta">
                {workspaceName(selectedSession.workspacePath)} · {selectedSession.messageCount} {t("条消息")}</span>
              <button
                type="button"
                className="knowledge-open"
                onClick={() => onOpenSession(selectedSession)}
              >
                {t("打开会话")}</button>
            </div>
          ) : null}
          {visiblePairs.map((pair) => (
            <article className="knowledge-pair" key={pair.key}>
              <header className="knowledge-pair-head">
                <span className="knowledge-pair-index">{t("第")}{pair.index} {t("轮")}</span>
                <span className="knowledge-time">{formatRelative(pair.instructionAt)}</span>
                <button
                  type="button"
                  className="knowledge-open"
                  onClick={() => {
                    if (sessionId) onOpenMessage(sessionId, pair.instructionId)
                  }}
                >
                  {t("跳到原始消息")}</button>
              </header>
              <div className="knowledge-pair-row">
                <span className="knowledge-role user">{t("我")}</span>
                <p className="knowledge-pair-text">
                  {highlight(pair.instruction, needle)}
                </p>
              </div>
              <div className="knowledge-pair-row">
                <span className="knowledge-role assistant">Pilot</span>
                <p className="knowledge-pair-text reply">
                  {pair.reply
                    ? highlight(pair.reply, needle)
                    : t("（这一轮还没有回复）")}
                </p>
              </div>
            </article>
          ))}
          {!pairsLoading && pairs.length === 0 ? (
            <div className="empty-panel compact">
              <SearchIcon width={20} height={20} />
              <strong>{ready ? t("没有找到相关对话") : t("这个会话还没有可检索的对话")}</strong>
              <span>
                {ready ? t("换一个关键词，或清空搜索查看全部轮次。") : t("先和 Pilot 完成一轮问答，再来查看。")}
              </span>
            </div>
          ) : null}
        </div>
      ) : ready ? (
        <div className="knowledge-results">
          <div className="knowledge-results-head">
            <span>
              {searching
                ? t("正在检索…")
                : t("命中 {v1} 条 · 来自 {v2} 个会话", { v1: hits.length, v2: groups.length })}
            </span>
            {error ? <span className="knowledge-error">{error}</span> : null}
          </div>

          {groups.map((group) => {
            const summary = sessionById.get(group.sessionId)
            return (
              <section className="knowledge-group" key={group.sessionId}>
                <header className="knowledge-group-head">
                  <div className="knowledge-group-main">
                    <span className="knowledge-group-title">{group.sessionTitle}</span>
                    <span className="knowledge-group-meta">
                      {workspaceName(group.workspacePath)} · {group.hits.length} {t("条命中")}</span>
                  </div>
                  {summary ? (
                    <button
                      type="button"
                      className="knowledge-open"
                      onClick={() => onOpenSession(summary)}
                    >
                      {t("打开会话")}</button>
                  ) : null}
                </header>
                {group.hits.map((hit) => (
                  <button
                    type="button"
                    className="knowledge-hit"
                    key={`${hit.sessionId}:${hit.messageId}`}
                    onClick={() => onOpenHit(hit)}
                    title={t("跳到原始消息")}
                  >
                    <span className={`knowledge-role ${hit.role}`}>
                      {hit.role === 'user' ? t("我") : 'Pilot'}
                    </span>
                    <span className="knowledge-snippet">
                      {highlight(hit.snippet, needle)}
                    </span>
                    <span className="knowledge-time">{formatRelative(hit.createdAt)}</span>
                  </button>
                ))}
              </section>
            )
          })}

          {!searching && !error && hits.length === 0 ? (
            <div className="empty-panel compact">
              <SearchIcon width={20} height={20} />
              <strong>{t("没有找到相关内容")}</strong>
              <span>{t("换一个关键词，或者放宽工作区、角色和时间筛选。")}</span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="knowledge-browse">
          <div className="knowledge-section-head">
            <span>{t("最近会话")}</span>
            <span>{formatNumber(scopedSessions.length)}</span>
          </div>
          {scopedSessions.length === 0 ? (
            <div className="empty-panel">
              <HistoryIcon width={22} height={22} />
              <strong>
                {scope === 'project' ? t("这个工作区还没有会话") : t("还没有可检索的会话")}
              </strong>
              <span>{t("新建任务并完成对话后，消息会自动进入知识库。")}</span>
            </div>
          ) : (
            <div className="knowledge-session-list">
              {recent.map((session) => (
                <button
                  type="button"
                  className="knowledge-session"
                  key={session.id}
                  onClick={() => onOpenSession(session)}
                >
                  <span className="knowledge-session-main">
                    <span className="knowledge-session-title">
                      {session.title || t("未命名会话")}
                    </span>
                    <span className="knowledge-session-meta">
                      {workspaceName(session.workspacePath)} · {session.messageCount} {t("条消息")}</span>
                  </span>
                  <span className="knowledge-session-side">
                    {session.running ? <span className="knowledge-live">{t("执行中")}</span> : null}
                    <span className="knowledge-time">{formatRelative(session.updatedAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
