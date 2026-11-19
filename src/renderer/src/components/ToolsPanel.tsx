import { useEffect, useState } from 'react'
import type { DynamicToolInfo, WorkspaceSummary } from '../../../shared/types'
import { WrenchIcon } from '../icons'
import { t } from '../i18n'
import { formatRelative } from '../ui'

function stateLabel(tool: DynamicToolInfo): string {
  if (!tool.enabled) return t("已停用")
  if (!tool.approved) return t("需要重新登记")
  return t("已批准")
}

export function ToolsPanel({ workspace }: { workspace: WorkspaceSummary | null }) {
  const [tools, setTools] = useState<DynamicToolInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!workspace) {
      setTools([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    void window.pilot
      .listTools(workspace.path)
      .then((list) => {
        if (!cancelled) setTools(list)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspace])

  useEffect(() => {
    if (!workspace) return undefined
    return window.pilot.onEvent((event) => {
      if (event.type !== 'tools.changed' || event.workspacePath !== workspace.path) return
      void window.pilot
        .listTools(workspace.path)
        .then(setTools)
        .catch(() => undefined)
    })
  }, [workspace])

  const act = async (key: string, action: () => Promise<DynamicToolInfo[]>): Promise<void> => {
    if (busy) return
    setBusy(key)
    setError('')
    try {
      setTools(await action())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const toggle = (tool: DynamicToolInfo): void => {
    if (!workspace) return
    void act(`${tool.source}:${tool.name}`, () =>
      window.pilot.setToolEnabled(workspace.path, tool.source, tool.name, !tool.enabled),
    )
  }

  const remove = (tool: DynamicToolInfo): void => {
    if (!workspace) return
    if (
      !window.confirm(
        t("删除工具「{v1}」及其代码？这个操作不可撤销。", { v1: tool.name }),
      )
    ) {
      return
    }
    void act(`${tool.source}:${tool.name}`, () =>
      window.pilot.removeTool(workspace.path, tool.source, tool.name),
    )
  }

  const promote = (tool: DynamicToolInfo): void => {
    if (!workspace) return
    if (
      !window.confirm(
        t("把「{v1}」复制到全局工具目录？之后每个工作区都能使用它。", { v1: tool.name }),
      )
    ) {
      return
    }
    void act(`${tool.source}:${tool.name}`, () => window.pilot.promoteTool(workspace.path, tool.name))
  }

  const approved = tools.filter((tool) => tool.approved && tool.enabled).length
  const runs = tools.reduce((total, tool) => total + tool.successCount + tool.failureCount, 0)

  return (
    <div className="page panel-page tools-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <WrenchIcon width={13} height={13} />
            {t("能力扩展")}</div>
          <h1>{t("工具")}</h1>
          <p>
            {workspace
              ? t("这些工具由 Pilot 在「{v1}」中自己编写：代码放在 .pilot/tools/<name>/，登记时必须先跑通自带测试。修改任何文件都会撤销批准，需要重新登记。", { v1: workspace.name })
              : t("选择一个工作区后，可以查看 Pilot 为它编写和登记的工具。")}
          </p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{tools.length}</strong>
            <span>{t("个工具")}</span>
          </div>
          <div className="stat">
            <strong>{approved}</strong>
            <span>{t("可用")}</span>
          </div>
          <div className="stat">
            <strong>{runs}</strong>
            <span>{t("次运行")}</span>
          </div>
        </div>
      </div>

      {error ? <div className="tools-error">{error}</div> : null}

      {!workspace ? (
        <div className="empty-panel">
          <WrenchIcon width={30} height={30} />
          <strong>{t("还没有选择工作区")}</strong>
          <span>{t("工具按工作区隔离；全局工具需要从某个工作区提升后才能使用。")}</span>
        </div>
      ) : loading && tools.length === 0 ? (
        <div className="session-loading-view">
          <i className="spinner" />
          <span>{t("载入工具…")}</span>
        </div>
      ) : tools.length === 0 ? (
        <div className="empty-panel">
          <WrenchIcon width={30} height={30} />
          <strong>{t("还没有工具")}</strong>
          <span>
            {t("当一个能力需要反复使用、而内置工具覆盖不了时，Pilot 会在 .pilot/tools/<name>/ 写一个工具，先自测再由你批准。")}</span>
        </div>
      ) : (
        <div className="tools-list">
          {tools.map((tool) => {
            const key = `${tool.source}:${tool.name}`
            const working = busy === key
            return (
              <article className="tools-card" key={key}>
                <div className="tools-card-head">
                  <div>
                    <h3>{tool.name}</h3>
                    <div className="tools-meta">
                      <span className={`tools-chip source-${tool.source}`}>
                        {tool.source === 'global' ? t("全局") : t("工作区")}
                      </span>
                      <span className="tools-chip">{tool.runtime}</span>
                      <span className="tools-chip">{tool.risk}</span>
                      <span className={`tools-chip ${tool.approved && tool.enabled ? 'ok' : 'warn'}`}>
                        {stateLabel(tool)}
                      </span>
                      {tool.verification ? (
                        <span className="tools-chip">{t("自测通过")}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="tools-actions">
                    {tool.source === 'workspace' && tool.approved ? (
                      <button
                        type="button"
                        className="button"
                        disabled={working}
                        onClick={() => promote(tool)}
                      >
                        {t("提升为全局")}
                      </button>
                    ) : null}
                    <button type="button" className="button" disabled={working} onClick={() => toggle(tool)}>
                      {tool.enabled ? t("停用") : t("启用")}
                    </button>
                    <button
                      type="button"
                      className="button danger"
                      disabled={working}
                      onClick={() => remove(tool)}
                    >
                      {working ? <i className="spinner small" /> : t("删除")}
                    </button>
                  </div>
                </div>
                <p className="tools-description">{tool.description}</p>
                <div className="tools-facts">
                  <span>
                    {t("成功 {v1} · 失败 {v2}", {
                      v1: tool.successCount,
                      v2: tool.failureCount,
                    })}
                  </span>
                  <span>{tool.lastRunAt ? t("上次运行 {v1}", { v1: formatRelative(tool.lastRunAt) }) : t("尚未运行")}</span>
                  <span title={tool.sha256}>SHA-256 {tool.sha256.slice(0, 12)}</span>
                  <span>{t("超时 {v1}s", { v1: Math.round(tool.timeoutMs / 1000) })}</span>
                </div>
                {tool.targets.length > 0 ? (
                  <div className="tools-targets">
                    {t("测试目标")}：
                    {tool.targets.map((target) => (
                      <code key={target}>{target}</code>
                    ))}
                  </div>
                ) : null}
                {!tool.approved ? (
                  <div className="tools-warning">
                    {t("代码在登记后发生了变化或自测未通过。Pilot 不能运行它，需重新调用 register_tool 登记。")}
                  </div>
                ) : null}
                {tool.lastError ? <div className="tools-warning">{tool.lastError}</div> : null}
              </article>
            )
          })}
        </div>
      )}

      <div className="tools-note">
        {t("边界：工具只能访问 localhost 或「设置 → 测试目标」中登记的地址；运行时不会获得 API Key 等凭据。它们仍是可执行代码，请在批准前确认代码来源和用途。")}
      </div>
    </div>
  )
}
