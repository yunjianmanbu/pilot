import { useState } from 'react'
import type { MemoryCategory, WorkspaceDetail, WorkspaceSummary } from '../../../shared/types'
import {
  MEMORY_CATEGORIES,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_INJECT_LIMIT,
  MEMORY_STORE_LIMIT,
  memoryCategoryOf,
} from '../../../shared/memory'
import { BrainIcon, PlusIcon, SparkIcon, TrashIcon } from '../icons'
import { formatRelative } from '../ui'
import { t } from '../i18n'

const SOURCE_LABELS = {
  user: t("你写入"),
  agent: t("Pilot 记录"),
  reflection: t("运行复盘"),
} as const

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  invariant: t("不变量"),
  verification: t("验证路径"),
  negative: t("走不通的路"),
  fact: t("代码事实"),
  environment: t("环境约束"),
  preference: t("用户偏好"),
  decision: t("废弃方案"),
}

export function MemoryPanel({
  workspace,
  detail,
  onAdd,
  onDelete,
}: {
  workspace: WorkspaceSummary | null
  detail: WorkspaceDetail | null
  onAdd: (content: string) => Promise<void>
  onDelete: (memoryId: string) => Promise<void>
}) {
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [filter, setFilter] = useState<MemoryCategory | 'all'>('all')

  const memory = detail?.memory ?? []
  const runs = detail?.runs ?? []
  const completed = runs.filter((run) => run.status === 'completed').length
  const counts = memory.reduce<Record<string, number>>((acc, entry) => {
    const category = memoryCategoryOf(entry)
    acc[category] = (acc[category] ?? 0) + 1
    return acc
  }, {})
  const visible = filter === 'all' ? memory : memory.filter((entry) => memoryCategoryOf(entry) === filter)
  const injected = memory.filter((entry) => (entry.injected ?? 0) > 0).length

  const add = async () => {
    const text = content.trim()
    if (!text || saving) return
    setSaving(true)
    try {
      await onAdd(text)
      setContent('')
    } catch {
      // The app surfaces the error as a toast.
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm(t("删除这条项目记忆？Pilot 之后不会再使用它。"))) return
    setDeleting(id)
    try {
      await onDelete(id)
    } catch {
      // The app surfaces the error as a toast.
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="page panel-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <BrainIcon width={13} height={13} />
            {t("长期上下文")}</div>
          <h1>{t("项目记忆")}</h1>
          <p>
            {workspace
              ? t("这些内容会在每次运行「{v1}」时注入系统提示，帮助 Pilot 记住你的偏好和踩过的坑。", { v1: workspace.name })
              : t("选择一个工作区后，Pilot 会为它维护独立的项目记忆。")}
          </p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{memory.length}</strong>
            <span>{t("条记忆")}</span>
          </div>
          <div className="stat">
            <strong>{completed}</strong>
            <span>{t("次完成")}</span>
          </div>
          <div className="stat">
            <strong>
              {detail?.activeProfile ? `v${detail.activeProfile.version}` : '—'}
            </strong>
            <span>{t("运行画像")}</span>
          </div>
        </div>
      </div>

      <div className="memory-layout">
        <div className="memory-main">
          <div className="memory-add">
            <textarea
              className="memory-input"
              value={content}
              rows={3}
              placeholder={t("写入一条长期记忆，例如：这个项目使用 pnpm，不要用 npm；提交前必须运行 pnpm typecheck。")}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void add()
                }
              }}
            />
            <div className="memory-add-footer">
              <span>{t("Ctrl+Enter 保存 · 敏感信息（Key、Token）不会被保存")}</span>
              <button
                type="button"
                className="button primary"
                onClick={() => void add()}
                disabled={!content.trim() || saving}
              >
                {saving ? <i className="spinner" /> : <PlusIcon width={15} height={15} />}
                {t("写入记忆")}</button>
            </div>
          </div>

          {memory.length === 0 ? (
            <div className="empty-panel">
              <BrainIcon width={30} height={30} />
              <strong>{t("还没有项目记忆")}</strong>
              <span>
                {t("Pilot 会在失败运行、工具报错、负反馈或长时间探查后自动复盘，也可以在上面的输入框里直接写入长期偏好。")}</span>
            </div>
          ) : (
            <>
              <div className="memory-filters">
                <button
                  type="button"
                  className={`chip-button${filter === 'all' ? ' active' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  {t("全部")} {memory.length}</button>
                {MEMORY_CATEGORIES.filter((category) => counts[category]).map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={`chip-button${filter === category ? ' active' : ''}`}
                    onClick={() => setFilter(category)}
                  >
                    {MEMORY_CATEGORY_LABELS[category]} {counts[category]}
                  </button>
                ))}
              </div>
              <p className="memory-budget-hint">
                {t("每次运行按类别配额注入最多 {v1} 条（{v2} 条真的被用过），单条超过 {v3} 字符会被截断，磁盘上限 {v4} 条。", {
                  v1: MEMORY_INJECT_LIMIT,
                  v2: injected,
                  v3: MEMORY_ENTRY_MAX_CHARS,
                  v4: MEMORY_STORE_LIMIT,
                })}
              </p>
              <div className="memory-list">
                {visible.map((entry) => (
                  <article className="memory-card" key={entry.id}>
                    <div className="memory-card-head">
                      <span className={`source-chip source-${entry.source}`}>
                        {entry.source === 'reflection' ? (
                          <SparkIcon width={11} height={11} />
                        ) : null}
                        {SOURCE_LABELS[entry.source]}
                      </span>
                      <span className="source-chip memory-category-chip">
                        {MEMORY_CATEGORY_LABELS[memoryCategoryOf(entry)]}
                      </span>
                      {(entry.reinforced ?? 0) > 0 ? (
                        <span className="memory-strength">
                          {t("复现 {v1} 次", { v1: entry.reinforced ?? 0 })}
                        </span>
                      ) : null}
                      <span className="memory-time">{formatRelative(entry.createdAt)}</span>
                      <button
                        type="button"
                        className="icon-button danger memory-delete"
                        title={t("删除记忆")}
                        disabled={deleting === entry.id}
                        onClick={() => void remove(entry.id)}
                      >
                        {deleting === entry.id ? (
                          <i className="spinner small" />
                        ) : (
                          <TrashIcon width={13} height={13} />
                        )}
                      </button>
                    </div>
                    <p>{entry.content}</p>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>

        <aside className="memory-aside">
          <div className="aside-card">
            <h3>{t("记忆如何工作")}</h3>
            <ol className="aside-steps">
              <li>
                <span>01</span>
                {t("每次运行前，项目记忆被放入系统提示。")}</li>
              <li>
                <span>02</span>
                {t("运行中遇到工具报错会先即时反思并调整方案；失败、工具报错或负反馈后还会结合报错细节自动复盘。")}</li>
              <li>
                <span>03</span>
                {t("反思结果按内容去重；同一条被反复推导出来时会累加复现次数，排名靠前。")}</li>
              <li>
                <span>04</span>
                {t("每次运行按类别配额挑选最有价值的记忆，而不是简单取最新几条。")}</li>
            </ol>
          </div>

          <div className="aside-card subtle">
            <h3>{t("当前运行画像")}</h3>
            {detail?.activeProfile ? (
              <>
                <div className="profile-mini">
                  <span className="profile-version">v{detail.activeProfile.version}</span>
                  <span>{detail.activeProfile.source === 'self' ? t("Pilot 提出") : t("用户创建")}</span>
                </div>
                <p className="profile-mini-text">{detail.activeProfile.rationale}</p>
              </>
            ) : (
              <p className="aside-muted">
                {t("还没有启用的运行画像。Pilot 会在累计运行后提出候选版本，经独立评审后再启用。")}</p>
            )}
          </div>

          <div className="aside-tip">
            {t("提示：记忆不是聊天记录。它应当简短、可复用，并且只描述跨任务仍然成立的偏好或约束。")}</div>
        </aside>
      </div>
    </div>
  )
}
