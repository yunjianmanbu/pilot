import { memo, useEffect, useState } from 'react'
import type { RunRecord, SessionArtifact } from '../../../../shared/types'
import { copyText } from '../../clipboard'
import {
  CheckIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  InfoIcon,
  PilotMark,
  PlayIcon,
  RefreshIcon,
  SparkIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  XIcon,
} from '../../icons'
import { formatNumber, formatTime, type UIMessage } from '../../ui'
import { t } from '../../i18n'
import { Markdown } from '../Markdown'
import { FileChangeBar } from '../FileChangeBar'
import { ReasoningBlock } from '../ReasoningBlock'
import { TurnPlan } from './plan'

function RunBadge({ run }: { run?: RunRecord }) {
  if (!run || run.status === 'completed' || run.status === 'running') return null
  const label =
    run.status === 'failed'
      ? t("运行失败")
      : run.status === 'paused'
        ? t("已暂停")
        : run.status === 'cancelled'
          ? t("已取消")
          : run.status === 'max_steps'
            ? t("达到步数上限")
            : t("已中断")
  return <span className={`run-badge run-${run.status}`}>{label}</span>
}

function AssistantMessage({
  message,
  run,
  focused,
  canRegenerate,
  files,
  onOpenFile,
  onOpenAll,
  onFeedback,
  onReflect,
  onRegenerate,
}: {
  message: Extract<UIMessage, { kind: 'assistant' }>
  run?: RunRecord
  focused?: boolean
  canRegenerate?: boolean
  /** Files this turn wrote or edited; empty hides the change bar entirely. */
  files: SessionArtifact[]
  onOpenFile: (artifact: SessionArtifact) => void
  onOpenAll: () => void
  onFeedback: (runId: string, rating: 'up' | 'down') => void
  onReflect: (runId: string) => Promise<number>
  onRegenerate: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [reflecting, setReflecting] = useState(false)

  const copy = () => {
    void copyText(message.content).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed')
      window.setTimeout(() => setCopyState('idle'), 1400)
    })
  }

  const reflect = async () => {
    if (!message.runId || reflecting) return
    setReflecting(true)
    try {
      await onReflect(message.runId)
    } finally {
      setReflecting(false)
    }
  }

  return (
    <div
      className={`message assistant-message${focused ? ' is-focused' : ''}`}
      data-message-id={message.id}
    >
      <div className="assistant-avatar">
        <PilotMark width={18} height={18} />
      </div>
      <div className="assistant-content">
        <div className="message-head">
          <span className="message-author">Pilot</span>
          <span className="message-time">{formatTime(message.createdAt)}</span>
          <RunBadge run={run} />
        </div>

        {message.reasoning?.trim() ? (
          <ReasoningBlock text={message.reasoning} className="answer-reasoning" />
        ) : null}

        {message.content.trim() ? (
          <Markdown content={message.content} />
        ) : (
          <p className="empty-answer">{t("模型没有返回可见内容。")}</p>
        )}

        {message.plan ? <TurnPlan plan={message.plan} /> : null}

        <FileChangeBar files={files} onOpenFile={onOpenFile} onOpenAll={onOpenAll} />

        {run?.error ? (
          <div className="run-inline-error">
            <InfoIcon width={13} height={13} />
            {run.error}
          </div>
        ) : null}

        <div className="message-actions">
          <button type="button" className="icon-text-button" onClick={copy}>
            {copyState === 'copied' ? (
              <CheckIcon width={13} height={13} />
            ) : (
              <CopyIcon width={13} height={13} />
            )}
            {copyState === 'copied' ? t("已复制") : copyState === 'failed' ? t("复制失败") : t("复制")}
          </button>

          {canRegenerate ? (
            <>
              <span className="action-sep" />
              <button
                type="button"
                className="icon-text-button"
                onClick={onRegenerate}
                title={t("让 Pilot 重新生成这条回答")}
              >
                <RefreshIcon width={13} height={13} />
                {t("重新生成")}</button>
            </>
          ) : null}

          {message.runId ? (
            <>
              <span className="action-sep" />
              <button
                type="button"
                className={`icon-button${run?.feedback?.rating === 'up' ? ' is-selected' : ''}`}
                title={t("这次回答有帮助")}
                onClick={() => onFeedback(message.runId!, 'up')}
              >
                <ThumbUpIcon width={14} height={14} />
              </button>
              <button
                type="button"
                className={`icon-button${run?.feedback?.rating === 'down' ? ' is-selected' : ''}`}
                title={t("这次回答不够好")}
                onClick={() => onFeedback(message.runId!, 'down')}
              >
                <ThumbDownIcon width={14} height={14} />
              </button>
              <button
                type="button"
                className="icon-text-button reflect-button"
                onClick={() => void reflect()}
                disabled={reflecting}
                title={t("让 Pilot 复盘这次运行，提炼可复用的经验")}
              >
                {reflecting ? <i className="spinner small" /> : <SparkIcon width={13} height={13} />}
                {reflecting ? t("复盘中") : t("复盘")}
              </button>
              {run ? (
                <span className="run-meta">
                  {run.steps} {t("步 ·")}{formatNumber(run.totalTokens)} tokens
                  {run.delegations
                    ? ` · ${t("委派 {v1} 次 / {v2} 步", {
                        v1: run.delegations,
                        v2: run.delegatedSteps ?? 0,
                      })}`
                    : null}
                  {run.modelMs !== undefined
                    ? ` · ${t("模型 {v1}s / 工具 {v2}s / 快照 {v3}s", {
                        v1: (run.modelMs / 1000).toFixed(1),
                        v2: ((run.toolMs ?? 0) / 1000).toFixed(1),
                        v3: ((run.checkpointMs ?? 0) / 1000).toFixed(1),
                      })}`
                    : null}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * What the edit box's primary button does.
 *
 * The button doubles as the rerun entry, so unchanged text must still be
 * submitted: comparing the draft against the stored content here used to close
 * the box and do nothing, which reads as "保存并重新生成没有生效".
 */
export function editSubmission(
  draft: string,
  saving: boolean,
): { submit: false } | { submit: true; text: string } {
  const text = draft.trim()
  if (!text || saving) return { submit: false }
  return { submit: true, text }
}

function UserMessage({
  message,
  focused,
  busy,
  canDelete,
  onEdit,
  onDelete,
}: {
  message: Extract<UIMessage, { kind: 'user' }>
  focused?: boolean
  busy: boolean
  canDelete?: boolean
  onEdit: (messageId: string, content: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!editing) setDraft(message.content)
  }, [message.content, editing])

  if (message.control) {
    return (
      <div className="control-message">
        <PlayIcon width={12} height={12} />
        <span>{t("从中断处继续任务")}</span>
        <span className="control-time">{formatTime(message.createdAt)}</span>
      </div>
    )
  }

  const copy = () => {
    void copyText(message.content).then((ok) => {
      setCopyState(ok ? 'copied' : 'failed')
      window.setTimeout(() => setCopyState('idle'), 1400)
    })
  }

  const save = async () => {
    const submission = editSubmission(draft, saving)
    if (!submission.submit) return
    setSaving(true)
    try {
      await onEdit(message.id, submission.text)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`message user-message${focused ? ' is-focused' : ''}`}
      data-message-id={message.id}
    >
      <div className="user-bubble">
        {editing ? (
          <div className="user-edit">
            <textarea
              className="user-edit-input"
              value={draft}
              autoFocus
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void save()
                }
              }}
            />
            <div className="user-edit-actions">
              <span>{t("保存后会从这条消息重新生成，之后的回复会被丢弃。")}</span>
              <button
                type="button"
                className="button ghost small"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                {t("取消")}</button>
              <button
                type="button"
                className="button primary small"
                onClick={() => void save()}
                disabled={saving || !draft.trim()}
              >
                {saving ? <i className="spinner small" /> : <RefreshIcon width={12} height={12} />}
                {draft.trim() === message.content ? t("重新生成") : t("保存并重新生成")}</button>
            </div>
          </div>
        ) : (
          <>
            {message.content.trim() ? <div className="user-text">{message.content}</div> : null}
            {message.references && message.references.length > 0 ? (
              <div className="user-references">
                {message.references.map((path) => {
                  const project = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path
                  return (
                    <span className="user-reference" key={path} title={path}>
                      {/^(?:[a-z]:\/|\/)/i.test(path) ? (
                        <FolderIcon width={11} height={11} />
                      ) : (
                        <FileIcon width={11} height={11} />
                      )}
                      {project}
                    </span>
                  )
                })}
              </div>
            ) : null}
            {message.images && message.images.length > 0 ? (
              <div className="user-images">
                {message.images.map((url, index) => (
                  <img
                    key={`${message.id}-image-${index}`}
                    src={url}
                    alt={t("用户发送的图片")}
                    className="user-image"
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
        <div className="user-foot">
          <span className="user-time">{formatTime(message.createdAt)}</span>
          {!editing ? (
            <>
              <button
                type="button"
                className="user-copy user-edit-start"
                onClick={() => setEditing(true)}
                disabled={busy}
                title={busy ? t("任务执行中，结束后可编辑") : t("编辑并重新生成")}
                aria-label={t("编辑这条消息")}
              >
                {t("编辑")}</button>
              <button
                type="button"
                className="user-copy"
                onClick={copy}
                title={copyState === 'failed' ? t("复制失败") : t("复制这条消息")}
                aria-label={copyState === 'failed' ? t("复制失败") : t("复制这条消息")}
              >
                {copyState === 'copied' ? (
                  <CheckIcon width={12} height={12} />
                ) : (
                  <CopyIcon width={12} height={12} />
                )}
              </button>
              {canDelete ? (
                <button
                  type="button"
                  className="user-copy danger"
                  onClick={() => {
                    if (!window.confirm(t("删除这条还没有回复的指令？"))) return
                    void onDelete(message.id)
                  }}
                  title={t("删除这条还没有回复的指令？")}
                  aria-label={t("删除这条还没有回复的指令？")}
                >
                  <XIcon width={12} height={12} />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// Transcript rows keep the same message object while a later answer streams.
// Memoizing them stops every token from re-rendering the whole history.
export const AssistantMessageRow = memo(AssistantMessage)
export const UserMessageRow = memo(UserMessage)
