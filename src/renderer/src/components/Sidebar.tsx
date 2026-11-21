import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MessageSearchHit,
  Plan,
  SessionSummary,
  SettingsView,
  UpdateState,
  WorkspaceSummary,
} from '../../../shared/types'
import {
  BrainIcon,
  ChevronDownIcon,
  ClockIcon,
  FeedbackIcon,
  FolderIcon,
  LayersIcon,
  ListCheckIcon,
  PauseIcon,
  PilotLogo,
  PlusIcon,
  InfoIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  TodoIcon,
  TrashIcon,
} from '../icons'
import { formatElapsedSince, formatRelative, type MainView } from '../ui'
import { modelResourceName } from '../../../shared/model-label'
import { SelectMenu } from './SelectMenu'
import { UpdatePanel } from './UpdatePanel'
import { t } from '../i18n'

const COLLAPSED_KEY = 'pilot.collapsed-projects.v1'
const SORT_KEY = 'pilot.session-sort.v1'

type SortMode = 'updated' | 'created'

interface SessionGroup {
  key: string
  path: string
  name: string
  sessions: SessionSummary[]
  latest: number
}

interface SidebarProps {
  workspaces: WorkspaceSummary[]
  activeWorkspace: string | null
  sessions: SessionSummary[]
  activeSession: string | null
  view: MainView
  settings: SettingsView | null
  settingsOpen: boolean
  feedbackOpen: boolean
  version: string
  update: UpdateState
  updateOpen: boolean
  onPickWorkspace: () => void
  onNewSession: (workspacePath?: string) => void
  onNewReview: () => void
  onSelectSession: (session: SessionSummary) => void
  onDeleteSession: (session: SessionSummary) => void
  onOpenSearchHit: (hit: MessageSearchHit) => void
  onView: (view: MainView) => void
  onOpenSettings: () => void
  onOpenFeedback: () => void
  onOpenUpdate: () => void
  onCloseUpdate: () => void
  onCheckUpdate: () => void
  onDownloadUpdate: () => void
  onInstallUpdate: () => void
  onRevealWorkspace: () => void
  onRefreshSessions: () => void
  draftProfileCount: number
  memoryCount: number
  /** 所有会话里还没发送的待办总数，显示在左下角「待办」按钮上。 */
  todoCount: number
  /** 所有会话里启用中的定时任务总数，显示在左下角「定时」按钮上。 */
  scheduledCount: number
}

function pathKey(path: string): string {
  return path.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function projectName(path: string): string {
  const parts = path.trim().replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function stamp(iso: string): number {
  const value = new Date(iso).getTime()
  return Number.isNaN(value) ? 0 : value
}

function readCollapsed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    if (!Array.isArray(raw)) return new Set()
    return new Set(raw.filter((value): value is string => typeof value === 'string'))
  } catch {
    return new Set()
  }
}

function readSort(): SortMode {
  return window.localStorage.getItem(SORT_KEY) === 'created' ? 'created' : 'updated'
}

function persistCollapsed(value: Set<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value]))
  } catch {
    // Persistence is best-effort; the current session still collapses.
  }
}

/**
 * Plan progress inside a session row: step numbers only, no item text, with the
 * digit's colour carrying the state (green done, amber running, grey untouched).
 * The full plan stays in the chat panel; this row only answers "is this task's
 * plan moving?" without repeating it.
 */
const PLAN_MARKS_LIMIT = 8
export function PlanMarks({ plan, running }: { plan: Plan; running: boolean }) {
  const total = plan.items.length
  if (total === 0) return null
  const done = plan.items.filter((item) => item.status === 'done').length
  const label = t("计划 {v1}/{v2} 完成", { v1: done, v2: total })
  // Long plans would overflow the row; the tail is summarised instead of clipped.
  const shown = plan.items.slice(0, PLAN_MARKS_LIMIT)
  const rest = total - shown.length
  // 执行完就不再报步骤序号（移动端也是这样）：只留完成数；
  // 还在跑时才把每一步画成彩色圆点，当前步呼吸。
  return (
    <span className="session-plan" role="img" aria-label={label} title={label}>
      {running
        ? shown.map((item, index) => {
            const state =
              item.status === 'done'
                ? 'done'
                : item.status === 'in_progress'
                  ? 'active'
                  : 'pending'
            return (
              <i key={item.id} className={`session-plan-dot is-${state}`}>
                {index + 1}
              </i>
            )
          })
        : null}
      {running && rest > 0 ? <i className="session-plan-more">+{rest}</i> : null}
      <b className="session-plan-count">
        {done}/{total}
      </b>
    </span>
  )
}

export function Sidebar({
  workspaces,
  activeWorkspace,
  sessions,
  activeSession,
  view,
  settings,
  settingsOpen,
  feedbackOpen,
  version,
  update,
  updateOpen,
  onPickWorkspace,
  onNewSession,
  onNewReview,
  onSelectSession,
  onDeleteSession,
  onOpenSearchHit,
  onView,
  onOpenSettings,
  onOpenFeedback,
  onOpenUpdate,
  onCloseUpdate,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onRevealWorkspace,
  onRefreshSessions,
  draftProfileCount,
  memoryCount,
  todoCount,
  scheduledCount,
}: SidebarProps) {
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [sort, setSort] = useState<SortMode>(readSort)
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)
  const [runningOnly, setRunningOnly] = useState(false)
  const [hits, setHits] = useState<MessageSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => {
    const needle = query.trim()
    if (needle.length < 2) {
      searchSeq.current += 1
      setHits([])
      setSearching(false)
      return
    }
    const seq = ++searchSeq.current
    setSearching(true)
    const timer = window.setTimeout(() => {
      void window.pilot
        .searchMessages(needle, 24)
        .then((result) => {
          if (searchSeq.current !== seq) return
          setHits(result)
          setSearching(false)
        })
        .catch(() => {
          if (searchSeq.current !== seq) return
          setHits([])
          setSearching(false)
        })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [query])

  const current = workspaces.find((workspace) => workspace.path === activeWorkspace) ?? null
  /**
   * 底部状态行显示当前会话模型资源的名字。以前回退到写死的 `deepseek-chat`，
   * 让未配置的用户以为已经连上了某个真实模型；现在没有真名就只说未选择。
   */
  const modelName = useMemo(() => {
    const resources = settings?.modelResources ?? []
    const active =
      resources.find((item) => item.id === settings?.sessionModelId) ?? resources[0]
    return modelResourceName(active)
  }, [settings])
  const activeKey = activeWorkspace ? pathKey(activeWorkspace) : ''
  const running = sessions.filter((session) => session.running).length
  const workspaceByKey = useMemo(
    () => new Map(workspaces.map((workspace) => [pathKey(workspace.path), workspace])),
    [workspaces],
  )

  const projectOptions = useMemo(() => {
    const map = new Map<string, { path: string; name: string; count: number }>()
    for (const session of sessions) {
      const key = pathKey(session.workspacePath)
      const existing = map.get(key)
      if (existing) {
        existing.count += 1
        continue
      }
      map.set(key, {
        path: session.workspacePath,
        name: workspaceByKey.get(key)?.name ?? projectName(session.workspacePath),
        count: 1,
      })
    }
    for (const workspace of workspaces) {
      if (!map.has(pathKey(workspace.path))) {
        map.set(pathKey(workspace.path), {
          path: workspace.path,
          name: workspace.name,
          count: 0,
        })
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [sessions, workspaceByKey, workspaces])

  const activeProject = projectOptions.some((option) => pathKey(option.path) === pathKey(project))
    ? project
    : ''
  const forceExpanded = Boolean(query.trim() || activeProject)

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const projectKey = activeProject ? pathKey(activeProject) : ''
    const filtered = sessions.filter((session) => {
      if (projectKey && pathKey(session.workspacePath) !== projectKey) return false
      if (runningOnly && !session.running) return false
      if (!needle) return true
      const workspace = workspaceByKey.get(pathKey(session.workspacePath))
      return [session.title, workspace?.name, workspace?.path, session.workspacePath]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
        .includes(needle)
    })
    const sorted = [...filtered].sort((a, b) =>
      sort === 'created'
        ? stamp(b.createdAt) - stamp(a.createdAt)
        : stamp(b.updatedAt) - stamp(a.updatedAt),
    )
    const map = new Map<string, SessionGroup>()
    for (const session of sorted) {
      const key = pathKey(session.workspacePath)
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          path: session.workspacePath,
          name: workspaceByKey.get(key)?.name ?? projectName(session.workspacePath),
          sessions: [],
          latest: 0,
        }
        map.set(key, group)
      }
      group.sessions.push(session)
      group.latest = Math.max(
        group.latest,
        stamp(sort === 'created' ? session.createdAt : session.updatedAt),
      )
    }
    return [...map.values()].sort(
      (a, b) => b.latest - a.latest || a.name.localeCompare(b.name, 'zh-CN'),
    )
  }, [activeProject, query, runningOnly, sessions, sort, workspaceByKey])

  const toggleGroup = (key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      persistCollapsed(next)
      return next
    })
  }

  const changeSort = (value: SortMode) => {
    setSort(value)
    try {
      window.localStorage.setItem(SORT_KEY, value)
    } catch {
      // Keep the in-memory sort even when storage is unavailable.
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark">
            <PilotLogo width={40} height={40} />
          </span>
          <div className="brand-text">
            <h1>Pilot</h1>
            <p title={current?.path ?? ''}>
              {current ? t("{v1} · 本地智能体", { v1: current.name }) : t("本地优先 · 自我进化")}
            </p>
          </div>
        </div>

        <div className="sidebar-actions">
          <button
            type="button"
            className="sidebar-primary"
            onClick={() => onNewSession(activeProject || undefined)}
          >
            <PlusIcon width={15} height={15} />
            {t("新建任务")}</button>
          <button
            type="button"
            className="sidebar-icon-btn"
            title={t("新建复盘评估（只读）")}
            aria-label={t("新建复盘评估")}
            onClick={onNewReview}
          >
            <SparkIcon width={16} height={16} />
          </button>
          <button
            type="button"
            className="sidebar-icon-btn"
            title={t("打开本地工作区")}
            aria-label={t("打开本地工作区")}
            onClick={onPickWorkspace}
          >
            <FolderIcon width={16} height={16} />
          </button>
          <button
            type="button"
            className="sidebar-icon-btn"
            title={t("刷新会话列表")}
            aria-label={t("刷新会话列表")}
            onClick={onRefreshSessions}
          >
            <RefreshIcon width={16} height={16} />
          </button>
        </div>

        <label className="search-wrap">
          <SearchIcon width={15} height={15} className="search-icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("搜索会话、工作区或消息")}
            aria-label={t("搜索会话、工作区或消息")}
          />
        </label>

        <div className="filter-row">
          <SelectMenu
            className="filter-menu"
            value={activeProject}
            onChange={setProject}
            ariaLabel={t("按工作区筛选")}
            title={t("按工作区筛选")}
            options={[
              { value: '', label: t("全部工作区") },
              ...projectOptions.map((option) => ({
                value: option.path,
                label: `${option.name}${option.count > 0 ? ` (${option.count})` : ''}`,
              })),
            ]}
          />
          <SelectMenu
            className="filter-menu filter-menu-sort"
            value={sort}
            onChange={(value) => changeSort(value === 'created' ? 'created' : 'updated')}
            ariaLabel={t("会话排序")}
            title={t("会话排序")}
            align="end"
            options={[
              { value: 'updated', label: t("最近活动") },
              { value: 'created', label: t("创建时间") },
            ]}
          />
          <button
            type="button"
            className={`filter-running${runningOnly ? ' is-active' : ''}`}
            onClick={() => setRunningOnly((value) => !value)}
            title={runningOnly ? t("显示全部会话") : t("只看执行中的会话")}
            aria-pressed={runningOnly}
          >
            <i className={`filter-running-dot${running > 0 ? ' live' : ''}`} />
            {running > 0 ? running : t("执行中")}
          </button>
        </div>
      </div>

      <div className="session-list">
        {query.trim().length >= 2 && (hits.length > 0 || searching) ? (
          <div className="search-hits">
            <div className="search-hits-head">
              <span>{t("消息命中")}</span>
              {searching ? <i className="spinner tiny" /> : <span>{hits.length}</span>}
            </div>
            {hits.map((hit) => (
              <button
                type="button"
                className="search-hit"
                key={`${hit.sessionId}:${hit.messageId}`}
                title={`${hit.sessionTitle}\n${hit.workspacePath}`}
                onClick={() => onOpenSearchHit(hit)}
              >
                <span className="search-hit-title">
                  {hit.role === 'user' ? t("我") : 'Pilot'} · {hit.sessionTitle}
                </span>
                <span className="search-hit-snippet">{hit.snippet}</span>
              </button>
            ))}
          </div>
        ) : null}
        {sessions.length === 0 ? (
          <div className="session-empty">
            {workspaces.length === 0
              ? t("还没有工作区。点击上方的文件夹按钮打开一个本地项目。")
              : t("还没有会话。点击「新建任务」开始。")}
          </div>
        ) : groups.length === 0 ? (
          <div className="session-empty">{t("没有匹配的会话。")}</div>
        ) : (
          groups.map((group) => {
            const isCollapsed = !forceExpanded && collapsed.has(group.key)
            const isCurrent = activeKey === group.key
            return (
              <div
                key={group.key}
                className={`session-group${isCollapsed ? ' collapsed' : ''}${isCurrent ? ' is-current' : ''}`}
              >
                <div className="session-group-header">
                  <button
                    type="button"
                    className="session-group-head"
                    disabled={forceExpanded}
                    aria-expanded={!isCollapsed}
                    title={group.path}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <ChevronDownIcon width={12} height={12} className="session-group-chevron" />
                    <span className="session-group-name">{group.name}</span>
                    {isCurrent ? <i className="session-group-active" title={t("当前工作区")} /> : null}
                    <span className="session-group-count">{group.sessions.length}</span>
                  </button>
                  <button
                    type="button"
                    className="session-group-add"
                    title={t("在「{v1}」新建任务", { v1: group.name })}
                    aria-label={t("在「{v1}」新建任务", { v1: group.name })}
                    onClick={() => onNewSession(group.path)}
                  >
                    ＋
                  </button>
                </div>
                <div className="session-group-items">
                  {group.sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`session-item${
                        session.id === activeSession && view === 'chat' ? ' is-active' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="session-main"
                        title={`${session.title}\n${session.workspacePath}`}
                        onClick={() => {
                          onSelectSession(session)
                          onView('chat')
                        }}
                      >
                        <span className="session-title">
                          <span className="session-title-text">
                            {session.title || t("未命名会话")}
                          </span>
                          {session.kind === 'review' ? (
                            <span className="session-badge review" title={t("只读复盘评估")}>
                              {t("复盘")}</span>
                          ) : null}
                          {session.running ? <i className="run-dot" title={t("正在执行")} /> : null}
                          {session.paused ? (
                            <span className="session-badge paused" title={t("任务已暂停，可继续")}>
                              <PauseIcon width={9} height={9} />
                              {t("暂停")}</span>
                          ) : null}
                        </span>
                        {session.running && session.runInstruction ? (
                          <span className="session-instruction" title={session.runInstruction}>
                            {session.runInstruction}
                          </span>
                        ) : null}
                        <span className="session-meta">
                          <span className="session-time">
                            {session.running && session.runStartedAt
                              ? t("已运行 {v1}", { v1: formatElapsedSince(session.runStartedAt) })
                              : formatRelative(session.updatedAt)}
                          </span>
                          {session.plan && session.plan.items.length > 0 ? (
                            <>
                              <span className="session-sep">·</span>
                              <PlanMarks plan={session.plan} running={session.running} />
                            </>
                          ) : null}
                          {session.todoCount > 0 || session.queueCount > 0 ? (
                            <span className="session-meta-tail">
                              {session.todoCount > 0 ? (
                                <span className="session-todo">
                                  <ListCheckIcon width={10} height={10} />
                                  {session.todoCount}
                                </span>
                              ) : null}
                              {session.queueCount > 0 ? (
                                <span className="session-queue">
                                  {t("排队")}{session.queueCount}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="session-delete"
                        title={t("删除会话")}
                        aria-label={t("删除会话「{v1}」", { v1: session.title })}
                        onClick={() => onDeleteSession(session)}
                      >
                        <TrashIcon width={13} height={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="status-line"
          onClick={onOpenSettings}
          title={settings?.hasKey ? t("模型服务已连接，点击查看设置") : t("尚未配置 API Key")}
        >
          <i className={`dot ${settings?.hasKey ? 'ok' : 'warn'}`} />
          <span>
            {modelName || t("未选择模型")}
            {settings?.hasKey ? t(" · 已连接") : t(" · 未配置 API Key")}
          </span>
        </button>
        <div className="status-line">
          <i className={`dot ${running > 0 ? 'warn' : 'ok'}`} />
          <span>{running > 0 ? t("{v1} 个任务执行中", { v1: running }) : t("本地运行 · 无云同步")}</span>
        </div>

        <nav className="footer-nav" aria-label={t("Pilot 资源")}>
          <button
            type="button"
            className={`footer-nav-item${view === 'todos' ? ' is-active' : ''}`}
            title={t("全部待办：所有会话汇总")}
            onClick={() => onView('todos')}
          >
            <TodoIcon width={16} height={16} />
            <span className="footer-nav-label">
              {t("待办")}
              {todoCount > 0 ? <span className="footer-badge">{todoCount}</span> : null}
            </span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${view === 'memory' ? ' is-active' : ''}`}
            title={t("项目记忆")}
            onClick={() => onView('memory')}
          >
            <BrainIcon width={16} height={16} />
            <span className="footer-nav-label">
              {t("记忆")}{memoryCount > 0 ? <span className="footer-badge">{memoryCount}</span> : null}
            </span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${view === 'scheduled' ? ' is-active' : ''}`}
            title={t("全部定时任务：所有会话汇总")}
            onClick={() => onView('scheduled')}
          >
            <ClockIcon width={16} height={16} />
            <span className="footer-nav-label">
              {t("定时")}
              {scheduledCount > 0 ? <span className="footer-badge">{scheduledCount}</span> : null}
            </span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${view === 'module-check' ? ' is-active' : ''}`}
            title={t("模块自检")}
            onClick={() => onView('module-check')}
          >
            <ListCheckIcon width={16} height={16} />
            <span className="footer-nav-label">{t("自检")}</span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${view === 'self-check' ? ' is-active' : ''}`}
            title={t("内视 Pilot 自身功能模块")}
            onClick={() => onView('self-check')}
          >
            <InfoIcon width={16} height={16} />
            <span className="footer-nav-label">{t("内视")}</span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${view === 'plugins' ? ' is-active' : ''}`}
            title={t("插件市场与插件助手")}
            onClick={() => onView('plugins')}
          >
            <LayersIcon width={16} height={16} />
            <span className="footer-nav-label">{t("插件")}</span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${view === 'evolution' ? ' is-active' : ''}`}
            title={t("自我进化")}
            onClick={() => onView('evolution')}
          >
            <SparkIcon width={16} height={16} />
            <span className="footer-nav-label">
              {t("进化")}{draftProfileCount > 0 ? (
                <span className="footer-badge">{draftProfileCount}</span>
              ) : null}
            </span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${settingsOpen ? ' is-active' : ''}`}
            title={t("设置")}
            onClick={onOpenSettings}
          >
            <SettingsIcon width={16} height={16} />
            <span className="footer-nav-label">{t("设置")}</span>
          </button>
          <button
            type="button"
            className={`footer-nav-item${feedbackOpen ? ' is-active' : ''}`}
            title={t("问题反馈")}
            onClick={onOpenFeedback}
          >
            <FeedbackIcon width={16} height={16} />
            <span className="footer-nav-label">{t("反馈")}</span>
          </button>
        </nav>

        <div className="footer-links">
          <span className="footer-version" title={`Pilot ${version ? `v${version}` : ''}`.trim()}>
            {version ? `v${version}` : t("版本未知")}
          </span>
          <button
            type="button"
            className={`link-btn update-trigger${updateOpen ? ' is-active' : ''}`}
            onClick={onOpenUpdate}
            aria-expanded={updateOpen}
            title={t("检查更新")}
          >
            {t("检查更新")}{update.status === 'available' || update.status === 'ready' ? (
              <i className="footer-update-dot" />
            ) : null}
          </button>
          {current ? (
            <button type="button" className="link-btn" onClick={onRevealWorkspace}>
              {t("打开目录")}</button>
          ) : null}
        </div>

        {updateOpen ? (
          <UpdatePanel
            update={update}
            running={running}
            onClose={onCloseUpdate}
            onCheckUpdate={onCheckUpdate}
            onDownloadUpdate={onDownloadUpdate}
            onInstallUpdate={onInstallUpdate}
          />
        ) : null}
      </div>
    </aside>
  )
}
