import type { WorkspaceSummary } from '../../../shared/types'
import { XIcon } from '../icons'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

/** Pick other project workspaces to reference in the next message.
 *
 * Only paths are returned; the runner verifies they are registered
 * workspaces and exposes them to the model as read-only roots.
 */
export function ReferencePicker({
  workspacePath,
  workspaces,
  selected,
  onClose,
  onToggle,
}: {
  workspacePath: string
  workspaces: WorkspaceSummary[]
  selected: string[]
  onClose: () => void
  onToggle: (path: string) => void
}) {
  useEscapeClose(onClose)

  const others = workspaces.filter((workspace) => !samePath(workspace.path, workspacePath))

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal reference-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("参照其他项目")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t("参照其他项目")}</h2>
            <p>{t("把其他项目空间作为只读参照加入下一条消息，模型需要时会读取其中的文件。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>
        <div className="reference-list">
          {others.length === 0 ? (
            <div className="schedule-empty">
              {t("还没有其他项目。先在侧栏打开另一个工作区，再回来添加参照。")}</div>
          ) : (
            others.map((workspace) => {
              const picked = selected.some((path) => samePath(path, workspace.path))
              return (
                <button
                  type="button"
                  className={`reference-item${picked ? ' is-picked' : ''}`}
                  key={workspace.path}
                  title={workspace.path}
                  onClick={() => onToggle(workspace.path)}
                >
                  <span>{workspace.name}</span>
                  <span className="reference-path">{workspace.path}</span>
                  <span className="reference-picked">{picked ? t("已参照") : t("参照")}</span>
                </button>
              )
            })
          )}
        </div>
        <div className="modal-footer">
          <span className="settings-note">
            {selected.length > 0 ? t("已选择 {v1} 个项目", { v1: selected.length }) : t("最多参照 8 个项目")}
          </span>
          <div className="modal-actions">
            <button type="button" className="button primary" onClick={onClose}>
              {t("完成")}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
