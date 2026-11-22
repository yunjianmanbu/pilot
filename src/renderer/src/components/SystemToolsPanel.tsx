import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ToolCatalogEntry, ToolRisk, WorkspaceSummary } from '../../../shared/types'
import { RefreshIcon, WrenchIcon } from '../icons'
import { getLocale, t } from '../i18n'

type SourceFilter = 'all' | 'builtin' | 'control' | 'mcp' | 'dynamic'

const FILTERS: Array<{ key: SourceFilter; label: string }> = [
  { key: 'all', label: t('全部') },
  { key: 'builtin', label: t('内置') },
  { key: 'control', label: t('控制') },
  { key: 'mcp', label: 'MCP' },
  { key: 'dynamic', label: t('自写') },
]

function sourceLabel(tool: ToolCatalogEntry): string {
  if (tool.source === 'builtin') return t('内置')
  if (tool.source === 'control') return t('控制')
  if (tool.source === 'mcp') return tool.server ? `MCP · ${tool.server}` : 'MCP'
  return t('自写')
}

function riskLabel(risk: ToolRisk): string {
  if (risk === 'write') return t('写文件')
  if (risk === 'exec') return t('运行命令')
  if (risk === 'control') return t('控制设备')
  return t('只读')
}

/** 中文界面用清单里的中文说明；英文界面与没有中文的条目回落到原文。 */
function descriptionOf(tool: ToolCatalogEntry): string {
  if (getLocale() === 'en') return tool.description
  return tool.descriptionZh || tool.description
}

/** 未启用的条目（MCP 关闭、自写工具被停用）照样列出，但要说清为什么不能用。 */
function availability(tool: ToolCatalogEntry): { label: string; state: 'ok' | 'warn' } | null {
  if (tool.source !== 'dynamic' && tool.source !== 'mcp') return null
  if (tool.enabled === false) return { label: t('未启用'), state: 'warn' }
  if (tool.source === 'dynamic' && tool.approved === false) {
    return { label: t('需要重新登记'), state: 'warn' }
  }
  return { label: t('可用'), state: 'ok' }
}

/**
 * 左下角「工具」：这个工作区里一次运行可能拿到的全部工具，跨会话累计调用次数。
 *
 * 与「会话资源 → 可用工具」的区别是范围：那边只看当前会话用过的次数，
 * 这里回答「我这套工具到底有哪些、哪些真的在用、哪些装了没用过」。
 */
export function SystemToolsPanel({
  workspace,
  onError,
}: {
  workspace: WorkspaceSummary | null
  onError: (message: string) => void
}) {
  const [tools, setTools] = useState<ToolCatalogEntry[] | null>(null)
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    if (!workspace) {
      setTools([])
      return
    }
    setLoading(true)
    window.pilot
      .toolsCatalogForWorkspace(workspace.path)
      .then((list) => setTools(list))
      .catch((reason: unknown) => {
        onError(reason instanceof Error ? reason.message : String(reason))
        setTools([])
      })
      .finally(() => setLoading(false))
  }, [workspace, onError])

  useEffect(() => {
    load()
  }, [load])

  // 工具被登记、删除或批准状态变化后自动重新取一次，省掉手点刷新。
  useEffect(() => {
    if (!workspace) return undefined
    return window.pilot.onEvent((event) => {
      if (event.type === 'tools.changed' && event.workspacePath === workspace.path) load()
    })
  }, [workspace, load])

  const sorted = useMemo(() => {
    const list = [...(tools ?? [])]
    // 用得多的排前面：清单本身是「哪些工具在干活」的答案，按名字排会把它藏起来。
    list.sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0) || a.name.localeCompare(b.name))
    return list
  }, [tools])

  const counts = useMemo(() => {
    const list = tools ?? []
    return {
      total: list.length,
      available: list.filter((tool) => tool.enabled !== false && tool.approved !== false).length,
      used: list.filter((tool) => (tool.calls ?? 0) > 0).length,
      calls: list.reduce((sum, tool) => sum + (tool.calls ?? 0), 0),
    }
  }, [tools])

  const visible = useMemo(() => {
    if (filter === 'all') return sorted
    if (filter === 'dynamic') return sorted.filter((tool) => tool.source === 'dynamic')
    return sorted.filter((tool) => tool.source === filter)
  }, [sorted, filter])

  if (!workspace) {
    return (
      <div className="page panel-page tools-page">
        <div className="page-head">
          <div>
            <div className="page-eyebrow">
              <WrenchIcon width={13} height={13} />
              {t('系统工具')}
            </div>
            <h1>{t('系统工具')}</h1>
            <p>{t('工具按工作区装载，因此先选一个工作区才能看到这套工具。')}</p>
          </div>
        </div>
        <div className="empty-panel">
          <WrenchIcon width={30} height={30} />
          <strong>{t('还没有选择工作区')}</strong>
          <span>{t('选择一个工作区后，这里会列出内置、控制、MCP 与自写工具。')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="page panel-page tools-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <WrenchIcon width={13} height={13} />
            {t('系统工具')}
          </div>
          <h1>{t('系统工具')}</h1>
          <p>
            {t('这里是 {v1} 里一次运行可能拿到的全部工具，调用次数是这个工作区所有会话的累计。', {
              v1: workspace.name,
            })}
          </p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{counts.total}</strong>
            <span>{t('个工具')}</span>
          </div>
          <div className="stat">
            <strong>{counts.available}</strong>
            <span>{t('个可用')}</span>
          </div>
          <div className="stat">
            <strong>{counts.used}</strong>
            <span>{t('个用过')}</span>
          </div>
        </div>
      </div>

      <div className="page-tabs" role="tablist" aria-label={t('工具来源')}>
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={filter === entry.key}
            className={`page-tab${filter === entry.key ? ' is-active' : ''}`}
            onClick={() => setFilter(entry.key)}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          className="page-tabs-refresh"
          title={t('重新读取工具清单')}
          aria-label={t('刷新')}
          onClick={load}
          disabled={loading}
        >
          {loading ? <i className="spinner tiny" /> : <RefreshIcon width={14} height={14} />}
        </button>
      </div>

      {tools === null ? (
        <div className="all-todos-empty">
          <i className="spinner" />
          {t('正在读取工具清单…')}
        </div>
      ) : visible.length === 0 ? (
        <div className="all-todos-empty">
          <WrenchIcon width={26} height={26} />
          <strong>{t('这一栏没有工具')}</strong>
          <span>{t('换个来源看看，或者让 Pilot 写一个自写工具。')}</span>
        </div>
      ) : (
        <div className="tools-list tools-grid">
          {visible.map((tool) => {
            const state = availability(tool)
            return (
              <article className="tools-card" key={`${tool.source}:${tool.server ?? ''}:${tool.name}`}>
                <div className="tools-card-head">
                  <div>
                    <h3>{tool.name}</h3>
                    <div className="tools-meta">
                      <span className={`tools-chip source-${tool.source}`}>{sourceLabel(tool)}</span>
                      <span className="tools-chip">{riskLabel(tool.risk)}</span>
                      <span className={`tools-chip${(tool.calls ?? 0) > 0 ? ' ok' : ''}`}>
                        {t('调用 {v1} 次', { v1: tool.calls ?? 0 })}
                      </span>
                      {state ? (
                        <span className={`tools-chip ${state.state}`}>{state.label}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <p className="tools-description">{descriptionOf(tool)}</p>
              </article>
            )
          })}
        </div>
      )}

      <div className="tools-note">
        {t('累计调用 {v1} 次；这里的次数只统计已经执行过的调用，失败与拒绝的同样计入。', {
          v1: counts.calls,
        })}
      </div>
    </div>
  )
}
