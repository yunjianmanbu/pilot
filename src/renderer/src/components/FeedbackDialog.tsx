import { useState } from 'react'
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_ENV_FIELDS,
  FEEDBACK_KINDS,
  FEEDBACK_TITLE_MAX,
  FeedbackInputError,
  formatFeedback,
  normalizeFeedback,
  type FeedbackDraft,
  type FeedbackEnvField,
  type FeedbackKind,
  type FeedbackProblem,
  type FeedbackRecord,
} from '../../../shared/feedback'
import { copyText } from '../clipboard'
import { useEscapeClose } from './useEscapeClose'
import { CheckIcon, FeedbackIcon, FolderIcon, XIcon } from '../icons'
import { t } from '../i18n'

const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: t("反馈问题"),
  feature: t("提需求"),
  suggestion: t("提建议"),
}

const KIND_HINTS: Record<FeedbackKind, string> = {
  bug: t("哪里报错、卡住或者和预期不一样"),
  feature: t("希望 Pilot 增加什么能力"),
  suggestion: t("对已有功能的使用体验有想法"),
}

/** Localized copy for each input problem the shared validator can report. */
const PROBLEM_COPY: Record<FeedbackProblem, string> = {
  kind: t("请选择反馈类型"),
  title: t("请填写一句话概括"),
  titleTooLong: t("概括请控制在 {v1} 个字符以内", { v1: FEEDBACK_TITLE_MAX }),
  body: t("请填写具体内容"),
  bodyTooLong: t("内容请控制在 {v1} 个字符以内", { v1: FEEDBACK_BODY_MAX }),
  contactTooLong: t("联系方式请控制在 {v1} 个字符以内", { v1: FEEDBACK_CONTACT_MAX }),
}

/** What each optional environment line contains, shown next to its switch. */
const ENV_LABELS: Record<FeedbackEnvField, string> = {
  os: t("系统与架构"),
  cpu: t("CPU 型号与核数"),
  memory: t("内存占用"),
  disk: t("工作区磁盘剩余"),
  runtime: t("Electron / Node / Chromium 版本"),
  sandbox: t("沙箱后端"),
}

/**
 * Problem report / feature request / suggestion.
 *
 * Nothing is sent over the network: a report is saved as one JSON file under
 * `userData/feedback` and can be copied as plain text, so the content is never
 * lost even when the machine is offline.
 */
export function FeedbackDialog({
  version,
  workspacePath,
  onClose,
  onError,
}: {
  version: string
  /** Only used to pick the volume reported in the disk line. */
  workspacePath?: string | null
  onClose: () => void
  onError: (message: string) => void
}) {
  const [kind, setKind] = useState<FeedbackKind>('bug')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [contact, setContact] = useState('')
  // Every field defaults to on, and every one can be switched off: nothing
  // identifying is collected, so there is no all-or-nothing choice to make.
  const [environment, setEnvironment] = useState<FeedbackEnvField[]>([...FEEDBACK_ENV_FIELDS])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<FeedbackRecord | null>(null)
  const [copied, setCopied] = useState(false)

  // 提交中不关算：写盘和复制环境信息都在进行，半途关掉会留下不完整的反馈。
  useEscapeClose(onClose, !saving)

  const submit = async (): Promise<void> => {
    setError('')
    let draft: FeedbackDraft
    try {
      draft = normalizeFeedback({ kind, title, body, contact, environment })
    } catch (caught) {
      setError(
        caught instanceof FeedbackInputError
          ? PROBLEM_COPY[caught.problem]
          : caught instanceof Error
            ? caught.message
            : String(caught),
      )
      return
    }
    setSaving(true)
    try {
      setSaved(await window.pilot.submitFeedback(draft, workspacePath ?? undefined))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!saved) return
    const ok = await copyText(formatFeedback(saved))
    setCopied(ok)
    if (!ok) setError(t("剪贴板不可用"))
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("问题反馈")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>
              <FeedbackIcon width={18} height={18} />
              {t("问题反馈")}</h2>
            <p>{t("反馈使用中遇到的问题，也可以提需求或提建议。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body feedback-body">
          {saved ? (
            <div className="feedback-sent">
              <div className="feedback-sent-head">
                <CheckIcon width={16} height={16} />
                <strong>{t("已保存这条反馈")}</strong>
              </div>
              <p className="feedback-sent-note">
                {t("反馈保存在本机 feedback 文件夹里，可以复制成文字发给开发者。")}
              </p>
              <textarea
                className="text-input feedback-copy"
                readOnly
                rows={10}
                value={formatFeedback(saved)}
              />
            </div>
          ) : (
            <>
              <div className="feedback-kinds" role="radiogroup" aria-label={t("反馈类型")}>
                {FEEDBACK_KINDS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={kind === item}
                    className={`feedback-kind${kind === item ? ' is-active' : ''}`}
                    onClick={() => setKind(item)}
                  >
                    <strong>{KIND_LABELS[item]}</strong>
                    <span>{KIND_HINTS[item]}</span>
                  </button>
                ))}
              </div>

              <label className="feedback-field">
                <span className="feedback-label">{t("一句话概括")}</span>
                <input
                  className="text-input"
                  value={title}
                  maxLength={FEEDBACK_TITLE_MAX}
                  placeholder={t("例如：手机端排队任务换个会话就消失了")}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>

              <label className="feedback-field">
                <span className="feedback-label">{t("具体内容")}</span>
                <textarea
                  className="text-input feedback-textarea"
                  rows={8}
                  value={body}
                  maxLength={FEEDBACK_BODY_MAX}
                  placeholder={t("做了什么、看到什么、期望是什么。附上报错文字会更好定位。")}
                  onChange={(event) => setBody(event.target.value)}
                />
                <span className="feedback-count">
                  {t("{v1}/{v2}", { v1: body.trim().length, v2: FEEDBACK_BODY_MAX })}
                </span>
              </label>

              <label className="feedback-field">
                <span className="feedback-label">{t("联系方式（可选）")}</span>
                <input
                  className="text-input"
                  value={contact}
                  maxLength={FEEDBACK_CONTACT_MAX}
                  placeholder={t("邮箱或微信号，方便回复你")}
                  onChange={(event) => setContact(event.target.value)}
                />
              </label>

              <div className="feedback-context">
                <p>{t("会附带以下环境信息：Pilot v{v1}，逐项可取消。", { v1: version || t("未知") })}</p>
                <div className="feedback-env">
                  {FEEDBACK_ENV_FIELDS.map((field) => (
                    <label key={field} className="feedback-env-item">
                      <input
                        type="checkbox"
                        checked={environment.includes(field)}
                        onChange={() =>
                          setEnvironment((current) =>
                            current.includes(field)
                              ? current.filter((item) => item !== field)
                              : FEEDBACK_ENV_FIELDS.filter(
                                  (item) => item === field || current.includes(item),
                                ),
                          )
                        }
                      />
                      <span>{ENV_LABELS[field]}</span>
                    </label>
                  ))}
                </div>
                <p className="feedback-env-note">
                  {t("不含主机名、用户名、网卡、IP 或设备序列号。")}
                </p>
              </div>
              {error ? <div className="settings-error">{error}</div> : null}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="feedback-folder"
            onClick={() => void window.pilot.openFeedbackFolder().catch(() => {})}
          >
            <FolderIcon width={13} height={13} />
            {t("打开反馈文件夹")}</button>
          <div className="modal-actions">
            {saved ? (
              <>
                <button type="button" className="button ghost" onClick={() => void copy()}>
                  {copied ? t("已复制") : t("复制反馈内容")}</button>
                <button type="button" className="button primary" onClick={onClose}>
                  {t("完成")}</button>
              </>
            ) : (
              <>
                <button type="button" className="button ghost" onClick={onClose} disabled={saving}>
                  {t("取消")}</button>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void submit()}
                  disabled={saving}
                >
                  {saving ? t("提交中…") : t("提交反馈")}</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
