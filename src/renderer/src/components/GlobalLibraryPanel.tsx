import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  OfficeDocumentKind,
  SessionDocument,
  SessionDocumentGroup,
  SessionLink,
  SessionLinkGroup,
  WorkspaceSummary,
} from '../../../shared/types'
import {
  BookOpenIcon,
  FilesIcon,
  GlobeIcon,
  LinkIcon,
  PencilIcon,
  RefreshIcon,
  SearchIcon,
  SlidesIcon,
  TableIcon,
  XIcon,
} from '../icons'
import { SelectMenu } from './SelectMenu'
import { formatNumber, formatRelative } from '../ui'
import { t } from '../i18n'

type LibraryMode = 'links' | 'documents'

/** 一条链接或一份文档；两种模式共用同一套页面骨架与筛选。 */
type LibraryEntry =
  | { kind: 'link'; link: SessionLink }
  | { kind: 'document'; document: SessionDocument }

interface LibraryGroup {
  sessionId: string
  sessionTitle: string
  workspacePath: string
  sessionUpdatedAt: string
  entries: LibraryEntry[]
}

interface GlobalLibraryPanelProps {
  mode: LibraryMode
  workspaces: WorkspaceSummary[]
  onOpenSession: (sessionId: string) => void
  onError: (message: string) => void
}

function workspaceName(path: string): string {
  const parts = path.trim().replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

const DOCUMENT_KIND_LABEL: Record<OfficeDocumentKind, string> = {
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  pdf: 'PDF',
  markdown: 'Markdown',
}

/** 多种文档各用一个形状：预览列表里不靠文字也能分清类型。 */
function documentIcon(kind: OfficeDocumentKind, size = 15): ReactNode {
  if (kind === 'pdf') return <FilesIcon width={size} height={size} />
  if (kind === 'excel') return <TableIcon width={size} height={size} />
  if (kind === 'powerpoint') return <SlidesIcon width={size} height={size} />
  if (kind === 'markdown') return <PencilIcon width={size} height={size} />
  return <BookOpenIcon width={size} height={size} />
}

/**
 * 左下角「全局链接」与「全局文档」共用的页面。
 *
 * 一次取全量再在本地过滤：这两类东西的数量是「每会话几十条 × 会话数」，比按
 * 搜索词反复往返主进程划算，筛选也能在输入时立刻生效。数据来自会话 transcript，
 * 所以条目天然带会话与项目两个维度，正是用户要的两级筛选。
 */
export function GlobalLibraryPanel({
  mode,
  workspaces,
  onOpenSession,
  onError,
}: GlobalLibraryPanelProps) {
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [linkGroups, setLinkGroups] = useState<SessionLinkGroup[]>([])
  const [documentGroups, setDocumentGroups] = useState<SessionDocumentGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyKey, setBusyKey] = useState('')

  const load = useCallback(
    (signal: { cancelled: boolean }) => {
      setLoading(true)
      setError('')
      const request =
        mode === 'links' ? window.pilot.allSessionLinks() : window.pilot.allSessionDocuments()
      request
        .then((result) => {
          if (signal.cancelled) return
          if (mode === 'links') setLinkGroups(result as SessionLinkGroup[])
          else setDocumentGroups(result as SessionDocumentGroup[])
          setLoading(false)
        })
        .catch((reason: unknown) => {
          if (signal.cancelled) return
          const message = reason instanceof Error ? reason.message : String(reason)
          setError(message)
          setLinkGroups([])
          setDocumentGroups([])
          setLoading(false)
          onError(message)
        })
    },
    [mode, onError],
  )

  useEffect(() => {
    const signal = { cancelled: false }
    load(signal)
    return () => {
      signal.cancelled = true
    }
  }, [load])

  // 切换模式时旧筛选会指向另一份数据，清掉比留着更不容易误解。
  useEffect(() => {
    setQuery('')
    setWorkspaceFilter('')
    setSessionFilter('')
  }, [mode])

  const groups = useMemo<LibraryGroup[]>(() => {
    if (mode === 'links') {
      return linkGroups.map((group) => ({
        sessionId: group.sessionId,
        sessionTitle: group.sessionTitle,
        workspacePath: group.workspacePath,
        sessionUpdatedAt: group.sessionUpdatedAt,
        entries: group.links.map((link) => ({ kind: 'link' as const, link })),
      }))
    }
    return documentGroups.map((group) => ({
      sessionId: group.sessionId,
      sessionTitle: group.sessionTitle,
      workspacePath: group.workspacePath,
      sessionUpdatedAt: group.sessionUpdatedAt,
      entries: group.documents.map((document) => ({ kind: 'document' as const, document })),
    }))
  }, [documentGroups, linkGroups, mode])

  const workspaceOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const group of groups) {
      if (seen.has(group.workspacePath)) continue
      const known = workspaces.find((workspace) => workspace.path === group.workspacePath)
      seen.set(group.workspacePath, known?.name || workspaceName(group.workspacePath))
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [groups, workspaces])

  const projectGroups = useMemo(
    () =>
      workspaceFilter ? groups.filter((group) => group.workspacePath === workspaceFilter) : groups,
    [groups, workspaceFilter],
  )

  const sessionOptions = useMemo(
    () =>
      [...projectGroups]
        .sort((a, b) => b.sessionUpdatedAt.localeCompare(a.sessionUpdatedAt))
        .map((group) => ({
          value: group.sessionId,
          label: group.sessionTitle || t('未命名会话'),
          detail: workspaceName(group.workspacePath),
        })),
    [projectGroups],
  )

  // 选中的会话被项目筛选排除时回落到「全部会话」，否则下拉会停在一个已不在
  // 选项里的值上。
  useEffect(() => {
    if (sessionFilter && !sessionOptions.some((option) => option.value === sessionFilter)) {
      setSessionFilter('')
    }
  }, [sessionFilter, sessionOptions])

  const needle = query.trim().toLowerCase()

  const visible = useMemo(() => {
    return projectGroups
      .filter((group) => !sessionFilter || group.sessionId === sessionFilter)
      .map((group) => ({
        group,
        entries: group.entries.filter((entry) => {
          if (!needle) return true
          if (entry.kind === 'link') {
            const { url, host, context } = entry.link
            return `${url}\n${host}\n${context}`.toLowerCase().includes(needle)
          }
          const { name, path, kind } = entry.document
          return `${name}\n${path}\n${kind}\n${DOCUMENT_KIND_LABEL[kind]}`
            .toLowerCase()
            .includes(needle)
        }),
      }))
      .filter((item) => item.entries.length > 0)
  }, [needle, projectGroups, sessionFilter])

  const total = visible.reduce((sum, item) => sum + item.entries.length, 0)
  // 项目/会话筛选之后、搜索之前的条目数：计数行的分母。用全量总数会让「选了
  // project-b 后列表只剩 1 条，右上角却写共 2 条」这种自相矛盾的读数出现。
  const scopedTotal = useMemo(
    () =>
      projectGroups
        .filter((group) => !sessionFilter || group.sessionId === sessionFilter)
        .reduce((sum, group) => sum + group.entries.length, 0),
    [projectGroups, sessionFilter],
  )

  const openPath = (workspacePath: string, path: string, useSystemApp: boolean) => {
    const key = `${useSystemApp ? 'app' : 'preview'}:${workspacePath}:${path}`
    setBusyKey(key)
    const request = useSystemApp
      ? window.pilot.openFile(workspacePath, path)
      : window.pilot.openDocument(workspacePath, path)
    void request
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        setError(message)
        onError(message)
      })
      .finally(() => setBusyKey(''))
  }

  const title = mode === 'links' ? t('全局链接') : t('全局文档')
  const subtitle =
    mode === 'links'
      ? t('所有会话里出现过的网址，按项目与会话筛选后可直接打开。')
      : t('所有会话产出的办公文档与 Markdown 报告，不含代码与脚本。')

  return (
    <div className="page panel-page knowledge-page library-page">
      <div className="page-head">
        <div>
          <span className="page-eyebrow">{t('全局资源')}</span>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className="icon-text-button"
          disabled={loading}
          onClick={() => load({ cancelled: false })}
        >
          <RefreshIcon width={13} height={13} />
          {t('刷新')}
        </button>
      </div>

      <div className="knowledge-search">
        <SearchIcon width={15} height={15} />
        <input
          type="search"
          value={query}
          autoFocus
          placeholder={
            mode === 'links' ? t('搜索网址、域名或上下文') : t('搜索文件名、路径或类型')
          }
          aria-label={mode === 'links' ? t('搜索链接') : t('搜索文档')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="knowledge-clear"
            aria-label={t('清空搜索')}
            onClick={() => setQuery('')}
          >
            <XIcon width={12} height={12} />
          </button>
        ) : null}
      </div>

      <div className="knowledge-filters">
        <div className="knowledge-filter">
          <span>{t('项目')}</span>
          <SelectMenu
            className="knowledge-menu"
            value={workspaceFilter}
            onChange={(value) => setWorkspaceFilter(value)}
            ariaLabel={t('按项目筛选')}
            options={[
              { value: '', label: t('全部项目') },
              ...workspaceOptions.map(([path, name]) => ({ value: path, label: name })),
            ]}
          />
        </div>
        <div className="knowledge-filter">
          <span>{t('会话')}</span>
          <SelectMenu
            className="knowledge-menu"
            value={sessionFilter}
            onChange={(value) => setSessionFilter(value)}
            ariaLabel={t('按会话筛选')}
            maxListWidth={360}
            options={[{ value: '', label: t('全部会话') }, ...sessionOptions]}
          />
        </div>
        <span className="knowledge-results-count">
          {needle
            ? t('匹配 {v1} / 共 {v2} 条', { v1: total, v2: scopedTotal })
            : t('共 {v1} 条', { v1: scopedTotal })}
        </span>
        {error ? <span className="knowledge-error">{error}</span> : null}
      </div>

      {loading ? (
        <div className="library-empty">{t('正在汇总…')}</div>
      ) : visible.length === 0 ? (
        <div className="library-empty">
          {mode === 'links' ? <LinkIcon width={22} height={22} /> : <FilesIcon width={22} height={22} />}
          <strong>{needle ? t('没有匹配的条目') : title}</strong>
          <span>
            {needle
              ? t('换一个关键词，或把项目与会话筛选放宽。')
              : mode === 'links'
                ? t('会话里出现过的网址会汇总到这里。')
                : t('会话写出过的 Word、Excel、PowerPoint、PDF 与 Markdown 会汇总到这里。')}
          </span>
        </div>
      ) : (
        <div className="library-groups">
          {visible.map(({ group, entries }) => (
            <article className="knowledge-group" key={group.sessionId}>
              <header className="knowledge-group-head">
                <div className="knowledge-group-main">
                  <span className="knowledge-group-title">
                    {group.sessionTitle || t('未命名会话')}
                  </span>
                  <span className="knowledge-group-meta">
                    {workspaceName(group.workspacePath)} · {formatNumber(entries.length)}{' '}
                    {mode === 'links' ? t('条链接') : t('份文档')} ·{' '}
                    {formatRelative(group.sessionUpdatedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className="knowledge-open"
                  onClick={() => onOpenSession(group.sessionId)}
                >
                  {t('打开会话')}
                </button>
              </header>
              <div className="library-rows">
                {entries.map((entry) =>
                  entry.kind === 'link' ? (
                    <div className="library-row" key={entry.link.url}>
                      <span className="library-icon kind-link">
                        <GlobeIcon width={15} height={15} />
                      </span>
                      <span className="library-main">
                        <span className="library-title">{entry.link.host || entry.link.url}</span>
                        <span className="library-sub" title={entry.link.url}>
                          {entry.link.context || entry.link.url}
                        </span>
                      </span>
                      <span className="library-actions">
                        {entry.link.count > 1 ? (
                          <span className="resource-row-badge">×{entry.link.count}</span>
                        ) : null}
                        <button
                          type="button"
                          className="knowledge-open"
                          onClick={() => {
                            void window.pilot.openLink(entry.link.url, true).catch((reason: unknown) => {
                              const message =
                                reason instanceof Error ? reason.message : String(reason)
                              setError(message)
                              onError(message)
                            })
                          }}
                        >
                          {t('在浏览器打开')}
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div className="library-row" key={entry.document.path}>
                      <span className={`library-icon kind-${entry.document.kind}`}>
                        {documentIcon(entry.document.kind)}
                      </span>
                      <span className="library-main">
                        <span className="library-title">{entry.document.name}</span>
                        <span className="library-sub" title={entry.document.path}>
                          {DOCUMENT_KIND_LABEL[entry.document.kind]} · {entry.document.path}
                        </span>
                      </span>
                      <span className="library-actions">
                        <button
                          type="button"
                          className="knowledge-open"
                          disabled={busyKey === `preview:${group.workspacePath}:${entry.document.path}`}
                          onClick={() =>
                            openPath(group.workspacePath, entry.document.path, false)
                          }
                        >
                          {t('预览')}
                        </button>
                        <button
                          type="button"
                          className="knowledge-open"
                          disabled={busyKey === `app:${group.workspacePath}:${entry.document.path}`}
                          title={t('用本机办公软件打开；预览排版不对时用它兜底')}
                          onClick={() => openPath(group.workspacePath, entry.document.path, true)}
                        >
                          {t('本机应用')}
                        </button>
                      </span>
                    </div>
                  ),
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <footer className="all-todos-foot">
        {mode === 'links'
          ? t('链接来自会话正文，同一个会话里重复提到的网址只列一次。')
          : t('文档来自会话里成功的 write/edit 调用，按扩展名收录；代码、脚本与数据文件不在其中。')}
      </footer>
    </div>
  )
}
