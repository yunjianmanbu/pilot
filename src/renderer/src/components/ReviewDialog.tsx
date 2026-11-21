import { useState } from 'react'
import type { ReviewSessionScope, Session } from '../../../shared/types'
import { FolderIcon, SparkIcon, TrashIcon, XIcon } from '../icons'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

interface RootRow {
  name: string
  path: string
  primary?: boolean
}

export function ReviewDialog({
  workspace,
  workspaceName,
  onClose,
  onCreated,
  onError,
}: {
  workspace: string
  workspaceName: string
  onClose: () => void
  onCreated: (session: Session) => void
  onError: (message: string) => void
}) {
  const [roots, setRoots] = useState<RootRow[]>([
    { name: workspaceName || t("主项目"), path: workspace, primary: true },
  ])
  const [scope, setScope] = useState<ReviewSessionScope>('workspace')
  const [objective, setObjective] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEscapeClose(onClose, !saving)

  const addFolder = async () => {
    if (roots.length >= 8) {
      setError(t("一次复盘最多读取 8 个目录。"))
      return
    }
    try {
      const picked = await window.pilot.pickFolder()
      if (!picked) return
      if (roots.some((root) => root.path.toLowerCase() === picked.toLowerCase())) return
      const name = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || t("项目")
      setRoots((previous) => [...previous, { name, path: picked }])
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const renameRoot = (path: string, name: string) => {
    setRoots((previous) =>
      previous.map((root) => (root.path === path ? { ...root, name } : root)),
    )
  }

  const removeRoot = (path: string) => {
    setRoots((previous) => previous.filter((root) => root.path !== path || root.primary))
  }

  const create = async () => {
    setError('')
    if (roots.length === 0) {
      setError(t("至少保留一个可读取的目录。"))
      return
    }
    const names = roots.map((root) => root.name.trim())
    if (names.some((name) => !name)) {
      setError(t("每个目录都需要一个别名。"))
      return
    }
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      setError(t("目录别名不能重复，工具靠它区分根目录。"))
      return
    }
    setSaving(true)
    try {
      const created = await window.pilot.createReviewSession({
        workspacePath: workspace,
        roots: roots.map((root) => ({ name: root.name.trim(), path: root.path })),
        sessions: scope,
        ...(objective.trim() ? { objective: objective.trim() } : {}),
      })
      onCreated(created)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal review-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("新建复盘评估")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>
              <SparkIcon width={18} height={18} /> {t("新建复盘评估")}</h2>
            <p>{t("独立只读评估：读取源码和会话记录，不改文件、不运行命令、不联网。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body review-modal-body">
          <section className="review-section">
            <div className="review-section-head">
              <div>
                <h3>{t("允许读取的目录")}</h3>
                <p>
                  {t("复盘工具只能在这些目录内读取；第一个是主项目，也是文件工具的默认根目录。")}</p>
              </div>
              <button
                type="button"
                className="button ghost small"
                onClick={() => void addFolder()}
                disabled={roots.length >= 8}
              >
                <FolderIcon width={14} height={14} />
                {t("添加目录")}</button>
            </div>
            <div className="review-roots">
              {roots.map((root) => (
                <div className="review-root-row" key={root.path}>
                  <input
                    className="text-input review-root-name"
                    value={root.name}
                    onChange={(event) => renameRoot(root.path, event.target.value)}
                    placeholder={t("别名")}
                    maxLength={40}
                    aria-label={t("目录别名")}
                  />
                  <span className="review-root-path mono" title={root.path}>
                    {root.path}
                  </span>
                  {root.primary ? (
                    <span className="review-root-primary">{t("主项目")}</span>
                  ) : (
                    <button
                      type="button"
                      className="review-root-remove"
                      title={t("移除这个目录")}
                      aria-label={t("移除这个目录")}
                      onClick={() => removeRoot(root.path)}
                    >
                      <TrashIcon width={13} height={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="review-section">
            <div className="review-section-head">
              <div>
                <h3>{t("可检索的会话")}</h3>
                <p>{t("复盘只能读取这里选择范围内的会话记录和运行记录。")}</p>
              </div>
            </div>
            <div className="review-scope-options">
              <label className={`review-scope-option${scope === 'workspace' ? ' is-active' : ''}`}>
                <input
                  type="radio"
                  name="review-scope"
                  checked={scope === 'workspace'}
                  onChange={() => setScope('workspace')}
                />
                <span>
                  <strong>{t("当前工作区")}</strong>
                  <small>{t("只读当前项目下的会话，范围最窄。")}</small>
                </span>
              </label>
              <label className={`review-scope-option${scope === 'all' ? ' is-active' : ''}`}>
                <input
                  type="radio"
                  name="review-scope"
                  checked={scope === 'all'}
                  onChange={() => setScope('all')}
                />
                <span>
                  <strong>{t("所有工作区")}</strong>
                  <small>{t("跨项目对比同类问题的历史会话。只读取，不修改。")}</small>
                </span>
              </label>
            </div>
          </section>

          <section className="review-section">
            <label className="settings-field wide">
              <span className="field-label">
                {t("评估目标")}<small>{t("可选。写清要评估的任务、时间范围或关注点，复盘会更聚焦。")}</small>
              </span>
              <textarea
                className="text-input settings-textarea"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                rows={4}
                maxLength={4000}
                placeholder={t("例如：评估 2026-11-10 的发布流程，重点检查版本号、签名和下载清单是否一致。")}
              />
            </label>
          </section>

          <div className="review-boundary-note">
            <strong>{t("边界：")}</strong>
            {t("复盘会话不注册写入、命令、MCP 或记忆工具。结论只保存为记忆参考和未激活的进化草稿； 需要修改代码时，再用“交接修复”新建普通编码会话，按常规审批执行。")}</div>

          {error ? <div className="review-error">{error}</div> : null}
        </div>

        <div className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose} disabled={saving}>
            {t("取消")}</button>
          <button type="button" className="button primary" onClick={() => void create()} disabled={saving}>
            {saving ? <i className="spinner" /> : <SparkIcon width={15} height={15} />}
            {saving ? t("创建中…") : t("开始复盘")}
          </button>
        </div>
      </div>
    </div>
  )
}
