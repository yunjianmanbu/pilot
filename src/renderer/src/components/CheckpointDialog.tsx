import { useCallback, useEffect, useState } from 'react'
import type {
  Checkpoint,
  CheckpointRestoreMode,
  Session,
  SettingsView,
} from '../../../shared/types'
import { CheckIcon, RefreshIcon, XIcon } from '../icons'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

const TRIGGER_LABELS: Record<Checkpoint['trigger'], string> = {
  prompt: t("发送前"),
  shell: t("Shell 前"),
  manual: t("手动"),
  prerestore: t("回退前"),
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const MODE_LABELS: Record<CheckpointRestoreMode, string> = {
  code: t("仅文件"),
  conversation: t("仅对话"),
  both: t("文件 + 对话"),
}

/**
 * The snapshot list without the modal chrome around it. It is exported so a
 * static render can prove what the panel tells the user: which scope a snapshot
 * used, and which directories the size budget left out.
 */
export function CheckpointList({
  items,
  ignored,
  settings,
  working,
  onRestore,
  onSkip,
}: {
  items: Checkpoint[]
  ignored: string[]
  settings: SettingsView
  working: string
  onRestore: (item: Checkpoint, mode: CheckpointRestoreMode) => void
  onSkip: (dir: string) => void
}) {
  return (
    <div className="checkpoint-list">
      {items.map((item) => (
        <div className="checkpoint-row" key={item.id}>
          <div className="checkpoint-main">
            <div className="checkpoint-title">
              <span className={`checkpoint-trigger ${item.trigger}`}>
                {TRIGGER_LABELS[item.trigger]}
              </span>
              <strong>{item.label}</strong>
              {item.baseline ? (
                <span className="checkpoint-baseline" title={t("对比修改与单文件回退都以这个点为基准")}>
                  {t("基线")}
                </span>
              ) : null}
            </div>
            <div className="checkpoint-meta">
              <span>{formatDate(item.createdAt)}</span>
              <span>{item.files} {t("个文件")}</span>
              <span>{formatBytes(item.bytes)}</span>
              <span>{item.messageCount} {t("条消息前")}</span>
              <span className="checkpoint-scope" title={t("回退时只覆盖这个范围里的文件")}>
                {item.scope === 'code' ? t("仅源码") : t("全部文件")}
              </span>
              {!item.complete ? (
                <span className="checkpoint-warning">
                  {t("不完整：跳过")}{item.skipped} {t("个过大或超出预算的文件")}</span>
              ) : null}
            </div>
            {item.omittedDirs && item.omittedDirs.length > 0 ? (
              <div className="checkpoint-omitted">
                <span className="checkpoint-omitted-note">
                  {t("这次快照放不下以下目录（超出单次快照的大小预算），回退时不会恢复它们：")}</span>
                {item.omittedDirs.map((dir) => {
                  const skipped =
                    ignored.includes(dir.path) || settings.checkpointIgnore.includes(dir.path)
                  return (
                    <div className="checkpoint-omitted-row" key={dir.path}>
                      <code>{dir.path}</code>
                      <span>{dir.files} {t("个文件")} · {formatBytes(dir.bytes)}</span>
                      <button
                        type="button"
                        className="button ghost small"
                        disabled={skipped || Boolean(working)}
                        onClick={() => onSkip(dir.path)}
                      >
                        {working === `skip:${dir.path}` ? <i className="spinner" /> : null}
                        {skipped ? t("已跳过") : t("跳过此目录")}
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
          <div className="checkpoint-actions">
            {(['code', 'conversation', 'both'] as const).map((mode) => (
              <button
                type="button"
                className={`button ghost small${mode === 'both' ? ' checkpoint-both' : ''}`}
                key={mode}
                disabled={Boolean(working) || (mode !== 'conversation' && !item.complete)}
                title={
                  mode !== 'conversation' && !item.complete
                    ? t("不完整快照不能安全地回退文件")
                    : undefined
                }
                onClick={() => onRestore(item, mode)}
              >
                {working === `${item.id}:${mode}` ? <i className="spinner" /> : null}
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function CheckpointDialog({
  session,
  settings,
  onClose,
  onRestored,
  onError,
  onSettingsSaved,
}: {
  session: Session
  settings: SettingsView
  onClose: () => void
  onRestored: (session: Session, safetyCheckpointId?: string) => void
  onError: (message: string) => void
  onSettingsSaved: (next: SettingsView) => void
}) {
  const [items, setItems] = useState<Checkpoint[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [ignored, setIgnored] = useState<string[]>([])
  useEscapeClose(onClose)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setItems(await window.pilot.listCheckpoints(session.id))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setLoading(false)
    }
  }, [session.id, onError])

  useEffect(() => {
    void load()
  }, [load])

  const snapshot = async () => {
    setWorking('create')
    setError('')
    try {
      await window.pilot.createCheckpoint(session.id, label.trim() || undefined)
      setLabel('')
      await load()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setWorking('')
    }
  }

  const restore = async (checkpoint: Checkpoint, mode: CheckpointRestoreMode) => {
    if (
      !window.confirm(
        t("确定要回退到「{v1}」吗？\n\n{v2}。这不会撤销已经在工作区外发生的外部副作用。", { v1: checkpoint.label, v2: MODE_LABELS[mode] }),
      )
    ) {
      return
    }
    setWorking(`${checkpoint.id}:${mode}`)
    setError('')
    try {
      const result = await window.pilot.restoreCheckpoint(session.id, checkpoint.id, mode)
      onRestored(result.session, result.safetyCheckpointId)
      onClose()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setWorking('')
    }
  }

  /**
   * A directory the snapshot could not hold keeps being reported on every
   * snapshot until it is excluded. Offering the exclusion here is what turns
   * "your rollback does not cover this" into a one-click decision, instead of
   * asking the user to copy the path into Settings → 回退点.
   */
  const skipDir = async (dir: string) => {
    if (settings.checkpointIgnore.includes(dir) || ignored.includes(dir)) return
    setWorking(`skip:${dir}`)
    setError('')
    try {
      const next = await window.pilot.updateSettings({
        checkpointIgnore: [...settings.checkpointIgnore, dir],
      })
      onSettingsSaved(next)
      setIgnored((previous) => (previous.includes(dir) ? previous : [...previous, dir]))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setWorking('')
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal checkpoint-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("回退点")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t("回退点")}</h2>
            <p>{t("文件快照保存在工作区之外；对话和文件可以分别回退。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body checkpoint-body">
          <div className="checkpoint-create">
            <input
              className="text-input"
              value={label}
              placeholder={t("可选：给这次快照起个名字")}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void snapshot()
                }
              }}
            />
            <button
              type="button"
              className="button primary"
              onClick={() => void snapshot()}
              disabled={Boolean(working)}
            >
              {working === 'create' ? <i className="spinner" /> : <CheckIcon width={15} height={15} />}
              {t("保存当前快照")}</button>
            <button
              type="button"
              className="button ghost"
              onClick={() => void load()}
              disabled={loading || Boolean(working)}
              title={t("刷新")}
            >
              <RefreshIcon width={15} height={15} />
            </button>
          </div>

          <p className="checkpoint-note">
            {t("自动快照在每次发送任务前创建；开启后也会在")}<code>run_shell</code> {t("执行前创建。 快照排除")}<code>.git</code>、<code>node_modules</code> {t("等大型目录，也不追踪工作区外的副作用。")}</p>

          {loading ? (
            <div className="checkpoint-empty">
              <i className="spinner" /> {t("正在读取回退点…")}</div>
          ) : items.length === 0 ? (
            <div className="checkpoint-empty">{t("还没有回退点。发送一次任务或手动保存一个快照。")}</div>
          ) : (
            <CheckpointList
              items={items}
              ignored={ignored}
              settings={settings}
              working={working}
              onRestore={(item, mode) => void restore(item, mode)}
              onSkip={(dir) => void skipDir(dir)}
            />
          )}

          {error ? <div className="settings-error">{error}</div> : null}
        </div>

        <div className="modal-footer">
          <span className="settings-note">
            {t("回退会覆盖工作区文件；未在快照中的文件会移到回退点目录，不会直接删除。")}</span>
          <div className="modal-actions">
            <button type="button" className="button ghost" onClick={onClose}>
              {t("关闭")}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
