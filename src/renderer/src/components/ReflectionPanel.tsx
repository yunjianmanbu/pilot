import { useEffect, useState } from 'react'
import type {
  ReflectionReport,
  ReflectionScheduleMode,
  ReflectionTopicId,
  SettingsUpdate,
  SettingsView,
} from '../../../shared/types'
import {
  REFLECTION_INTERVAL_MAX_MINUTES,
  REFLECTION_INTERVAL_MIN_MINUTES,
  REFLECTION_TOPICS,
  reflectionEvidenceLabel,
  reflectionRefLabel,
  reflectionTopicLabel,
  reflectionTriggerLabel,
  type ReflectionFindingStatus,
  type ReflectionSeverity,
} from '../../../shared/reflect'
import { modelOptionLabel } from '../../../shared/model-label'
import { getLocale, t } from '../i18n'
import { Field, Toggle } from './form-fields'
import { SelectMenu } from './SelectMenu'

/**
 * 反思工作区。
 *
 * 这一段原先长在设置弹窗里：设置弹窗承担「保存整份表单」的职责，反思却需要
 * 立即跑一轮、清空历史这些动作，两套节奏混在一个滚动区里。
 * 现在它作为进化页的一个页签独立存在，自己保存自己的字段。
 *
 * 邮箱与「哪些事发信」是通知能力，属于设置 → 通知，不跟着反思页走：
 * 用户找发信配置时不会想到去「进化」里翻。这里只留一条入口。
 */
export function ReflectionPanel({
  settings,
  onSaved,
  onError,
  onOpenNotifySettings,
}: {
  settings: SettingsView
  onSaved: (view: SettingsView) => void
  onError: (message: string) => void
  /** 打开「设置 → 通知」，邮箱与通知配置都在那里。 */
  onOpenNotifySettings: () => void
}) {
  const [reflectEnabled, setReflectEnabled] = useState(settings.reflectEnabled)
  const [reflectModelId, setReflectModelId] = useState(settings.reflectModelId)
  const [reflectOnError, setReflectOnError] = useState(settings.reflectTriggers.onError)
  const [reflectOnSchedule, setReflectOnSchedule] = useState(settings.reflectTriggers.onSchedule)
  const [reflectScheduleMode, setReflectScheduleMode] = useState<ReflectionScheduleMode>(
    settings.reflectScheduleMode,
  )
  const [reflectIntervalMinutes, setReflectIntervalMinutes] = useState(
    String(settings.reflectIntervalMinutes),
  )
  const [reflectDailyTime, setReflectDailyTime] = useState(settings.reflectDailyTime)
  const [reflectTopics, setReflectTopics] = useState<ReflectionTopicId[]>(settings.reflectTopics)
  const [reports, setReports] = useState<ReflectionReport[]>([])
  const [busy, setBusy] = useState<'save' | 'reflect' | ''>('')
  const [notice, setNotice] = useState('')
  // 动作的反馈就地显示在按钮下方：用户点完「立即反思」不能只看到顶部提示。
  const [error, setError] = useState('')

  useEffect(() => {
    void window.pilot
      .reflectionReports()
      .then(setReports)
      .catch(() => setReports([]))
  }, [])

  const modelOptions = settings.modelResources.map((resource) => ({
    value: resource.id,
    label: modelOptionLabel(
      `${resource.label.trim() || resource.model.trim() || t("未命名模型")} · ${resource.model || t("未配置")}`,
      resource.tag,
    ),
    disabled: !resource.enabled,
  }))

  /** 问题域勾选：保持目录顺序，写入的也总是有序数组。 */
  const toggleTopic = (id: ReflectionTopicId) => {
    setReflectTopics((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : REFLECTION_TOPICS.filter((topic) => topic.id === id || current.includes(topic.id)).map(
            (topic) => topic.id,
          ),
    )
  }

  const save = async () => {
    setError('')
    setNotice('')
    const interval = Number(reflectIntervalMinutes)
    if (
      reflectScheduleMode === 'interval' &&
      (!Number.isFinite(interval) ||
        interval < REFLECTION_INTERVAL_MIN_MINUTES ||
        interval > REFLECTION_INTERVAL_MAX_MINUTES)
    ) {
      setError(
        t("反思间隔需要在 {v1} 到 {v2} 分钟之间。", {
          v1: REFLECTION_INTERVAL_MIN_MINUTES.toLocaleString(),
          v2: REFLECTION_INTERVAL_MAX_MINUTES.toLocaleString(),
        }),
      )
      return
    }
    if (
      reflectScheduleMode === 'daily' &&
      !/^([01]\d|2[0-3]):([0-5]\d)$/.test(reflectDailyTime.trim())
    ) {
      setError(t("每天触发时刻需要是 24 小时制的 HH:mm。"))
      return
    }
    if (reflectTopics.length === 0) {
      setError(t("至少选择一个反思问题域。"))
      return
    }
    const input: SettingsUpdate = {
      reflectEnabled,
      reflectModelId,
      reflectTriggers: { onError: reflectOnError, onSchedule: reflectOnSchedule },
      reflectScheduleMode,
      reflectIntervalMinutes: Math.round(interval),
      reflectDailyTime: reflectDailyTime.trim(),
      reflectTopics,
    }
    setBusy('save')
    try {
      const view = await window.pilot.updateSettings(input)
      onSaved(view)
      setNotice(t("反思设置已保存。"))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy('')
    }
  }

  const runNow = async () => {
    setNotice('')
    setError('')
    setBusy('reflect')
    try {
      const report = await window.pilot.reflectNow()
      setReports((current) => [report, ...current].slice(0, 30))
      if (report.email && !report.email.sent) {
        // 报告存下来了但邮箱里什么都没有：原因写在按钮下面，
        // 否则用户只看到「反思完成」却收不到邮件，会以为发信功能根本没做。
        setError(
          t("报告已记录，但邮件未发送：{v1}", {
            v1: report.email.error?.trim() || t("未知原因"),
          }),
        )
      }
      setNotice(t("反思完成：{v1} 条发现。", { v1: report.findings.length }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy('')
    }
  }

  const clearHistory = async () => {
    setNotice('')
    setError('')
    try {
      await window.pilot.clearReflectionReports()
      setReports([])
      setNotice(t("记录已清空。"))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  /**
   * 结论的处理状态：代码改完标「已处理」，决定不做标「不打算做」。
   * 两者都会进下一轮的历史证据，同一条结论不会被反复重提。
   */
  const setFindingStatus = async (
    reportId: string,
    findingId: string,
    status: ReflectionFindingStatus,
  ) => {
    setError('')
    try {
      const updated = await window.pilot.setReflectionFindingStatus(reportId, findingId, status)
      if (updated) {
        setReports((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry)),
        )
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const severityLabel = (severity: ReflectionSeverity): string =>
    getLocale() === 'en' ? severity : severity === 'high' ? '高' : severity === 'low' ? '低' : '中'

  const findingStatusLabel = (status: ReflectionFindingStatus): string =>
    status === 'done' ? t("已处理") : status === 'dismissed' ? t("不打算做") : t("待处理")

  return (
    <div className="page panel-page reflection-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">{t("反思")}</div>
          <h1>{t("反思")}</h1>
          <p>
            {t(
              "Pilot 按报错或固定时间对自己提问：会话压缩、存储、页面设计、项目结构、代码、执行效率、输出质量和交互体验哪里还能更好。",
            )}
          </p>
        </div>
        <div className="section-actions">
          <button
            type="button"
            className="button primary small"
            onClick={() => void runNow()}
            disabled={busy !== ''}
          >
            {busy === 'reflect' ? <i className="spinner" /> : null}
            {t("立即反思")}
          </button>
        </div>
      </div>

      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("触发与问题域")}</h2>
            <p>{t("两种触发方式可以同时开启；每次反思按选中的问题逐个自问。")}</p>
          </div>
        </div>

        <div className="toggle-list">
          <Toggle
            checked={reflectEnabled}
            onChange={setReflectEnabled}
            label={t("启用反思")}
            description={t("关闭后不再自动反思；仍可在这里点「立即反思」。")}
          />
          <Toggle
            checked={reflectOnError}
            onChange={setReflectOnError}
            label={t("报错触发")}
            description={t("一次运行失败后自动反思；10 分钟内的连续失败只跑一次，避免烧额度。")}
          />
          <Toggle
            checked={reflectOnSchedule}
            onChange={setReflectOnSchedule}
            label={t("固定时间触发")}
            description={t("按间隔或每天固定时刻自动反思；到点后一分钟内开始。")}
          />
        </div>

        <div className="field-grid">
          <Field
            label={t("反思模型")}
            hint={t("默认跟随会话模型；换成独立模型可以让反思不受当前任务上下文影响。")}
          >
            <SelectMenu
              value={reflectModelId}
              options={[{ value: '', label: t("跟随会话模型") }, ...modelOptions]}
              onChange={setReflectModelId}
              ariaLabel={t("反思模型")}
              maxListWidth={360}
            />
          </Field>
          <Field label={t("定时方式")}>
            <SelectMenu
              value={reflectScheduleMode}
              options={[
                { value: 'interval', label: t("按间隔") },
                { value: 'daily', label: t("每天固定时刻") },
              ]}
              onChange={(value) =>
                setReflectScheduleMode(value === 'interval' ? 'interval' : 'daily')
              }
              ariaLabel={t("定时方式")}
            />
          </Field>
          {reflectScheduleMode === 'interval' ? (
            <Field label={t("间隔分钟")} hint={t("30 到 10,080 分钟")}>
              <input
                className="text-input"
                inputMode="numeric"
                value={reflectIntervalMinutes}
                onChange={(event) => setReflectIntervalMinutes(event.target.value)}
              />
            </Field>
          ) : (
            <Field label={t("每天时刻")} hint={t("24 小时制，例如 09:00")}>
              <input
                className="text-input"
                value={reflectDailyTime}
                onChange={(event) => setReflectDailyTime(event.target.value)}
                placeholder="09:00"
                spellCheck={false}
              />
            </Field>
          )}
        </div>

        <div className="reflect-topics" role="group" aria-label={t("问题域")}>
          {REFLECTION_TOPICS.map((topic) => {
            const on = reflectTopics.includes(topic.id)
            return (
              <button
                key={topic.id}
                type="button"
                className={`reflect-topic${on ? ' is-on' : ''}`}
                onClick={() => toggleTopic(topic.id)}
                aria-pressed={on}
                title={getLocale() === 'en' ? topic.question.en : topic.question.zh}
              >
                {reflectionTopicLabel(topic.id, getLocale() === 'en')}
              </button>
            )
          })}
        </div>

        <div className="reflect-actions">
          <button
            type="button"
            className="button primary small"
            onClick={() => void save()}
            disabled={busy !== ''}
          >
            {busy === 'save' ? <i className="spinner" /> : null}
            {t("保存设置")}
          </button>
          <span className="settings-note">{t("只保存反思自己的字段。")}</span>
        </div>
        {error ? (
          <p className="reflect-notice is-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="reflect-notice">{notice}</p> : null}
      </section>

      {/*
        邮箱与「哪些事发信」是通知能力，已经搬到设置 → 通知。这里只留一条入口：
        在「进化」里找发信配置本来就不符合直觉。
      */}
      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("邮件通知")}</h2>
            <p>
              {t("邮箱地址、SMTP 授权码以及哪些事件发信，都已经移到「设置 → 通知」。")}
            </p>
          </div>
          <div className="section-actions">
            <button type="button" className="button ghost small" onClick={onOpenNotifySettings}>
              {t("打开通知设置")}
            </button>
          </div>
        </div>
      </section>

      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("最近反思")}</h2>
            <p>{t("最多保留 30 条；自主优化会读取这些结论作为信号。")}</p>
          </div>
          {reports.length > 0 ? (
            <button
              type="button"
              className="button ghost small"
              onClick={() => void clearHistory()}
            >
              {t("清空记录")}
            </button>
          ) : null}
        </div>

        {reports.length === 0 ? (
          <p className="settings-note">{t("还没有反思记录。")}</p>
        ) : (
          <ul className="reflect-reports">
            {reports.slice(0, 30).map((report) => (
              <li className="reflect-report" key={report.id}>
                <div className="reflect-report-head">
                  <span className={`reflect-badge ${report.trigger}`}>
                    {reflectionTriggerLabel(report.trigger, getLocale() === 'en')}
                  </span>
                  <span className="reflect-report-time">
                    {new Date(report.createdAt).toLocaleString()}
                  </span>
                  <span className="reflect-report-meta">
                    {t("{v1} 条发现", { v1: report.findings.length })}
                  </span>
                </div>
                <p className="reflect-report-summary">{report.summary || t("（没有摘要）")}</p>
                {report.skipped.length > 0 ? (
                  <p className="reflect-report-skipped">
                    {t("本轮未提问：{v1}", {
                      v1: report.skipped
                        .map(
                          (entry) =>
                            `${reflectionTopicLabel(entry.topic, getLocale() === 'en')}（${entry.missing
                              .map((kind) => reflectionEvidenceLabel(kind, getLocale() === 'en'))
                              .join(getLocale() === 'en' ? ', ' : '、')}）`,
                        )
                        .join(getLocale() === 'en' ? '; ' : '；'),
                    })}
                  </p>
                ) : null}
                {report.findings.length > 0 ? (
                  <ul className="reflect-findings">
                    {report.findings.map((finding) => {
                      const status = finding.status ?? 'open'
                      const refs = finding.refs ?? []
                      return (
                        <li className={`reflect-finding is-${status}`} key={finding.id}>
                          <div className="reflect-finding-head">
                            <span className={`reflect-severity is-${finding.severity}`}>
                              {severityLabel(finding.severity)}
                            </span>
                            <span className="reflect-finding-topic">
                              {reflectionTopicLabel(finding.topic, getLocale() === 'en')}
                            </span>
                            <div
                              className="reflect-finding-status"
                              role="group"
                              aria-label={t("处理状态")}
                            >
                              {(['open', 'done', 'dismissed'] as const).map((option) => (
                                <button
                                  key={option}
                                  type="button"
                                  className={`reflect-status-button${status === option ? ' is-on' : ''}`}
                                  aria-pressed={status === option}
                                  onClick={() => void setFindingStatus(report.id, finding.id, option)}
                                >
                                  {findingStatusLabel(option)}
                                </button>
                              ))}
                            </div>
                          </div>
                          <p className="reflect-finding-text">{finding.observation}</p>
                          {finding.suggestion ? (
                            <p className="reflect-finding-advice">{finding.suggestion}</p>
                          ) : null}
                          {refs.length > 0 ? (
                            <p className="reflect-finding-refs">
                              {refs.map((ref) => (
                                <code key={reflectionRefLabel(ref)}>{reflectionRefLabel(ref)}</code>
                              ))}
                            </p>
                          ) : (
                            <p className="reflect-finding-refs is-empty">
                              {t("这条结论没有指出代码位置，只能当作观察看。")}
                            </p>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
                {report.evidence ? (
                  <details className="reflect-evidence">
                    <summary>
                      {report.evidenceChars && report.evidenceChars > report.evidence.length
                        ? t("本轮证据（摘要 {v1} / 全文 {v2} 字符）", {
                            v1: report.evidence.length.toLocaleString(),
                            v2: report.evidenceChars.toLocaleString(),
                          })
                        : t("本轮证据（{v1} 字符）", {
                            v1: report.evidence.length.toLocaleString(),
                          })}
                    </summary>
                    <pre className="reflect-evidence-body">{report.evidence}</pre>
                  </details>
                ) : null}
                {report.email ? (
                  <p className="reflect-report-mail">
                    {report.email.sent
                      ? t("邮件已发送到 {v1}", { v1: report.email.to })
                      : t("邮件未发送：{v1}", { v1: report.email.error || t("未知原因") })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
