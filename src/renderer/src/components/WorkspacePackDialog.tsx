import { useState } from 'react'
import type {
  WorkspacePackExportResult,
  WorkspacePackImportResult,
  WorkspacePackScope,
} from '../../../shared/workspace-pack'
import { XIcon, InfoIcon, FolderIcon, FilesIcon } from '../icons'
import { t } from '../i18n'
import {
  PACK_SCOPE_KEYS,
  canStartPackExport,
  formatPackBytes,
  packImportSegments,
  packScopeNeedsSecretAck,
  togglePackScope,
  initialPackScope,
  type PackScopeKey,
} from '../workspace-pack-view'
import { useEscapeClose } from './useEscapeClose'

type PackMode = 'export' | 'import'

/** 每个复选框的标题与说明：文案只在渲染层出现，键是范围字段名。 */
function scopeCopy(key: PackScopeKey): { label: string; hint: string } {
  switch (key) {
    case 'sessions':
      return {
        label: t("会话与任务"),
        hint: t("全部会话、消息、待办、计划、评审报告与定时任务。"),
      }
    case 'files':
      return {
        label: t("工作区文件"),
        hint: t("按 .gitignore 与内置排除规则跳过 node_modules、.git 等目录。"),
      }
    case 'settings':
      return {
        label: t("设置"),
        hint: t("模型端点、审批模式、通知、反思、主题等；不含密钥本身。"),
      }
    case 'secrets':
      return {
        label: t("密钥"),
        hint: t("模型 API Key、SMTP 授权码与测试验证码。导出包里是明文。"),
      }
    default:
      return {
        label: t("检查点快照"),
        hint: t("可以让导入端回退到导出时的文件状态，体积较大。"),
      }
  }
}

function summaryCounts(result: WorkspacePackImportResult): string[] {
  const names: Record<string, string> = {
    sessions: t("个会话"),
    messages: t("条消息"),
    todos: t("条待办"),
    scheduled: t("个定时任务"),
    files: t("个文件"),
    checkpoints: t("个检查点文件"),
    secrets: t("条密钥"),
  }
  return packImportSegments(result)
    .filter((segment) => segment.count > 0)
    .map((segment) => `${segment.count} ${names[segment.key] ?? segment.key}`)
}

export function WorkspacePackDialog({
  initialMode = 'export',
  workspacePath,
  workspaceName,
  onClose,
  onImported,
  onError,
}: {
  initialMode?: PackMode
  workspacePath: string | null
  workspaceName: string | null
  onClose: () => void
  onImported: (path: string) => Promise<void>
  onError: (message: string) => void
}) {
  const [mode, setMode] = useState<PackMode>(initialMode)
  const [scope, setScope] = useState<WorkspacePackScope>(initialPackScope)
  const [secretAck, setSecretAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exported, setExported] = useState<WorkspacePackExportResult | null>(null)
  const [imported, setImported] = useState<WorkspacePackImportResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEscapeClose(() => {
    if (!busy) onClose()
  })

  const needsAck = packScopeNeedsSecretAck(scope)
  const canExport = Boolean(workspacePath) && canStartPackExport(scope, secretAck, busy)

  const runExport = async () => {
    if (!workspacePath) return
    setBusy(true)
    setFailure(null)
    setExported(null)
    try {
      const result = await window.pilot.exportWorkspacePack(workspacePath, scope)
      // 用户在保存对话框里点了取消：什么都不提示，保持当前勾选。
      if (!result.path) return
      setExported(result)
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : String(caught))
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    setBusy(true)
    setFailure(null)
    setImported(null)
    try {
      const result = await window.pilot.importWorkspacePack()
      if (result.cancelled) return
      if (!result.ok) {
        const message = result.error ?? t("导入失败")
        setFailure(message)
        onError(message)
        return
      }
      setImported(result)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setFailure(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => (busy ? undefined : onClose())}>
      <div
        className="modal workspace-pack-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("工作区导出与导入")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t("工作区导出与导入")}</h2>
            <p>{t("把整个工作区打成一个 .zip 包，在另一台机器的 Pilot 里完整恢复。")}</p>
          </div>
          <div className="modal-head-actions">
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              disabled={busy}
              aria-label={t("关闭")}
            >
              <XIcon width={17} height={17} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div className="pack-mode-tabs" role="tablist">
            {(['export', 'import'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                className={`pack-mode-tab${mode === value ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => {
                  setMode(value)
                  setFailure(null)
                }}
              >
                {value === 'export' ? t("导出") : t("导入")}
              </button>
            ))}
          </div>

          {mode === 'export' ? (
            <>
              <div className="pack-target">
                <FolderIcon width={15} height={15} />
                {workspacePath ? (
                  <span>
                    <strong>{workspaceName ?? workspacePath}</strong>
                    <code>{workspacePath}</code>
                  </span>
                ) : (
                  <span>{t("还没有打开工作区：先在工作区列表里选一个再导出。")}</span>
                )}
              </div>

              <div className="pack-scopes">
                {PACK_SCOPE_KEYS.map((key) => {
                  const copy = scopeCopy(key)
                  // 密钥依附于设置：设置没勾时这一项直接禁用，避免假勾选。
                  const disabled = busy || (key === 'secrets' && !scope.settings)
                  return (
                    <label
                      key={key}
                      className={`pack-scope-row${disabled ? ' is-disabled' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={key === 'secrets' ? scope.secrets && scope.settings : scope[key]}
                        disabled={disabled}
                        onChange={(event) => {
                          const next = togglePackScope(scope, key, event.target.checked)
                          setScope(next)
                          if (!packScopeNeedsSecretAck(next)) setSecretAck(false)
                        }}
                      />
                      <span className="pack-scope-text">
                        <strong>{copy.label}</strong>
                        <small>{copy.hint}</small>
                      </span>
                    </label>
                  )
                })}
              </div>

              {needsAck ? (
                <div className="pack-secret-warning">
                  <InfoIcon width={14} height={14} />
                  <div>
                    <strong>{t("这个包会以明文包含密钥")}</strong>
                    <p>
                      {t("模型 API Key、SMTP 授权码与测试验证码会以可读文本写进 .zip。任何拿到这个文件的人都能读到它们；导入后会用本机 safeStorage 重新加密。")}
                    </p>
                    <label className="pack-secret-ack">
                      <input
                        type="checkbox"
                        checked={secretAck}
                        disabled={busy}
                        onChange={(event) => setSecretAck(event.target.checked)}
                      />
                      {t("我了解此包含明文密钥，会妥善保管")}
                    </label>
                  </div>
                </div>
              ) : null}

              {exported ? (
                <div className="pack-result">
                  <FilesIcon width={15} height={15} />
                  <div>
                    <strong>{t("已导出")}</strong>
                    <code>{exported.path}</code>
                    <small>
                      {exported.manifest
                        ? t("包含 {v1} 个会话、{v2} 个文件、{v3}", {
                            v1: exported.manifest.counts.sessions,
                            v2: exported.manifest.counts.files,
                            v3: formatPackBytes(exported.manifest.counts.fileBytes),
                          })
                        : t("已写出导出包")}
                      {exported.secretCount > 0
                        ? t("；其中 {v1} 条密钥为明文", { v1: exported.secretCount })
                        : ''}
                    </small>
                  </div>
                </div>
              ) : null}

              <div className="modal-actions">
                <button type="button" className="button ghost" onClick={onClose} disabled={busy}>
                  {t("关闭")}
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={!canExport}
                  onClick={() => void runExport()}
                >
                  {busy ? t("正在打包…") : t("导出为 .zip")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="pack-import-intro">
                <p>
                  {t("导入会先选一个导出包，再选目标文件夹；包里的文件、会话、待办、定时任务与设置会合并进本机，同名会话按 id 去重，不会覆盖已有内容。")}
                </p>
                <p className="pack-import-tip">
                  {t("如果包里带了密钥，导入时会用它重新加密写回本机，包文件本身可以直接删除。")}
                </p>
              </div>

              {busy ? (
                <div className="pack-result">
                  <i className="spinner small" />
                  <div>
                    <strong>{t("正在读取导出包…")}</strong>
                    <small>{t("包较大时可能需要几分钟，请不要关闭窗口。")}</small>
                  </div>
                </div>
              ) : null}

              {imported ? (
                <div className="pack-result">
                  <FilesIcon width={15} height={15} />
                  <div>
                    <strong>{t("已导入「{v1}」", { v1: imported.workspaceName ?? '' })}</strong>
                    <code>{imported.workspacePath}</code>
                    <small>{summaryCounts(imported).join(' · ') || t("包里没有可导入的内容")}</small>
                    {imported.warnings.length > 0 ? (
                      <ul className="pack-warnings">
                        {imported.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {failure ? (
                <div className="pack-failure" role="alert">
                  {failure}
                </div>
              ) : null}

              <div className="modal-actions">
                <button type="button" className="button ghost" onClick={onClose} disabled={busy}>
                  {t("关闭")}
                </button>
                {imported?.workspacePath ? (
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => {
                      const path = imported.workspacePath
                      if (!path) return
                      void onImported(path).then(onClose)
                    }}
                  >
                    {t("打开这个工作区")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() => void runImport()}
                  >
                    {busy ? t("正在导入…") : t("选择导出包并导入")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
