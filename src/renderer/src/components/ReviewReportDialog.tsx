import { useState } from 'react'

import type { ReviewFinding, ReviewReport, ReviewSeverity, Session } from '../../../shared/types'
import { CheckIcon, PlusIcon, SparkIcon, XIcon } from '../icons'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

const VERDICT_LABEL: Record<ReviewReport['verdict'], string> = {
  pass: t("通过"),
  needs_work: t("需要处理"),
  blocked: t("证据受阻"),
}

const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  high: t("高"),
  medium: t("中"),
  low: t("低"),
}

function average(report: ReviewReport): number {
  const scores = report.scores
  return Math.round((scores.correctness + scores.evidence + scores.safety + scores.efficiency) / 4)
}

export function ReviewReportDialog({
  session,
  report,
  handingOff,
  onClose,
  onHandoff,
  onAddTodo,
}: {
  session: Session
  report: ReviewReport
  handingOff: boolean
  onClose: () => void
  onHandoff: () => void
  onAddTodo: (text: string) => Promise<void>
}) {
  // Recommendations already added in this dialog; the promise only resolves
  // after the main process persisted the todo.
  const [added, setAdded] = useState<Record<string, true>>({})
  const [adding, setAdding] = useState<string | null>(null)

  // 交接/待办进行中不响应 Escape，避免关掉正在等返回的弹框。
  useEscapeClose(onClose, !handingOff)

  const addTodo = async (finding: ReviewFinding, key: string) => {
    setAdding(key)
    try {
      await onAddTodo(finding.recommendation)
      setAdded((previous) => ({ ...previous, [key]: true }))
    } catch {
      // The app already surfaced the failure as a toast.
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal review-report-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("复盘报告")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>
              <SparkIcon width={18} height={18} /> {t("复盘报告")}</h2>
            <p>
              {session.title} · {report.model || t("未知模型")} · {new Date(report.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body review-report-body">
          <div className={`review-verdict-card verdict-${report.verdict}`}>
            <div>
              <span className="review-verdict-label">{VERDICT_LABEL[report.verdict]}</span>
              <strong>{average(report)}</strong>
              <small>{t("综合分")}</small>
            </div>
            <p>{report.summary}</p>
          </div>

          <div className="review-score-grid">
            <Score label={t("正确性")} value={report.scores.correctness} />
            <Score label={t("证据")} value={report.scores.evidence} />
            <Score label={t("安全")} value={report.scores.safety} />
            <Score label={t("效率")} value={report.scores.efficiency} />
          </div>

          <section className="review-report-section">
            <h3>{t("评估目标")}</h3>
            <p>{report.objective || t("（未指定）")}</p>
          </section>

          <section className="review-report-section">
            <h3>{t("问题与建议 ·")}{report.findings.length}</h3>
            {report.findings.length === 0 ? (
              <p className="muted">{t("没有发现需要处理的问题。")}</p>
            ) : (
              <div className="review-findings">
                {report.findings.map((finding, index) => {
                  const key = `${finding.title}-${index}`
                  const isAdded = Boolean(added[key])
                  return (
                    <article className="review-finding" key={key}>
                      <header>
                        <span className={`review-severity ${finding.severity}`}>
                          {SEVERITY_LABEL[finding.severity]}
                        </span>
                        <strong>{finding.title}</strong>
                        <span className="review-confidence">
                          {t("置信度")}{Math.round(finding.confidence * 100)}%
                        </span>
                      </header>
                      {finding.facts.length > 0 ? (
                        <div className="review-finding-block">
                          <span>{t("事实")}</span>
                          <ul>
                            {finding.facts.map((fact, factIndex) => (
                              <li key={`${fact}-${factIndex}`}>{fact}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <div className="review-finding-block">
                        <span>{t("证据")}</span>
                        <ul>
                          {finding.evidence.map((evidence) => (
                            <li key={`${evidence.kind}:${evidence.ref}`}>
                              <code>
                                {evidence.kind}:{evidence.ref}
                              </code>
                              {evidence.note ? ` — ${evidence.note}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {finding.rootCause ? (
                        <p>
                          <strong>{t("根因：")}</strong>
                          {finding.rootCause}
                        </p>
                      ) : null}
                      <div className="review-finding-advice">
                        <p>
                          <strong>{t("建议：")}</strong>
                          {finding.recommendation}
                        </p>
                        <button
                          type="button"
                          className={`review-todo-btn${isAdded ? ' added' : ''}`}
                          disabled={isAdded || adding !== null}
                          title={isAdded ? t("已加待办") : t("添加待办")}
                          onClick={() => void addTodo(finding, key)}
                        >
                          {isAdded ? (
                            <CheckIcon width={12} height={12} />
                          ) : (
                            <PlusIcon width={12} height={12} />
                          )}
                          {isAdded ? t("已加待办") : t("添加待办")}
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </section>

          {report.unknowns.length > 0 ? (
            <section className="review-report-section">
              <h3>{t("尚未确认")}</h3>
              <ul>
                {report.unknowns.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {report.memoryLessons.length > 0 || report.profileAddendum ? (
            <section className="review-report-section">
              <h3>{t("已沉淀的草稿")}</h3>
              <p className="muted">
                {t("以下内容不会自动改变行为。记忆仅作参考；进化草稿需要在“进化”面板中审核并启用。")}</p>
              {report.memoryLessons.map((lesson, index) => (
                <div className="review-draft" key={`${lesson}-${index}`}>
                  <span>{t("记忆")}</span>
                  {lesson}
                </div>
              ))}
              {report.profileAddendum ? (
                <div className="review-draft">
                  <span>{t("进化草稿")}</span>
                  {report.profileAddendum}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <div className="modal-footer">
          <button type="button" className="button ghost" onClick={onClose}>
            {t("关闭")}</button>
          <button
            type="button"
            className="button primary"
            onClick={onHandoff}
            disabled={handingOff}
          >
            {handingOff ? <i className="spinner" /> : <SparkIcon width={15} height={15} />}
            {handingOff ? t("创建中…") : t("交接修复")}
          </button>
        </div>
      </div>
    </div>
  )
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div className="review-score">
      <span>{label}</span>
      <strong>{Math.round(value)}</strong>
      <i>
        <b style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </i>
    </div>
  )
}
