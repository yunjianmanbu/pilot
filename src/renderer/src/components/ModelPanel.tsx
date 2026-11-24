import { useEffect, useRef, useState } from 'react'
import type {
  ConnectionTestResult,
  JudgeProvider,
  ModelBalanceState,
  SettingsUpdate,
  SettingsView,
} from '../../../shared/types'
import {
  MODEL_TAG_MAX_LENGTH,
  modelOptionLabel,
  normalizeModelTag,
} from '../../../shared/model-label'
import { CheckIcon, RefreshIcon, SparkIcon, XIcon } from '../icons'
import { t } from '../i18n'
import { BillingPanel, balanceSummary } from './BillingPanel'
import { Field } from './form-fields'
import { SelectMenu } from './SelectMenu'

const MAX_MODEL_RESOURCES = 12
const MAX_EVALUATION_MODELS = 6

/**
 * One editable model endpoint. Session, review and evaluation roles all point
 * at these rows; the stored key never reaches the renderer.
 */
interface ResourceDraft extends JudgeProvider {
  /** 四字以内的短标签，只用于辨识。 */
  tag: string
  apiKey: string
  clearKey: boolean
}

const EVALUATION_LABELS = [
  t("第一评估"),
  t("第二评估"),
  t("第三评估"),
  t("第四评估"),
  t("第五评估"),
  t("第六评估"),
]

function newResourceDraft(): ResourceDraft {
  return {
id: crypto.randomUUID(),
label: '',
baseUrl: '',
model: '',
tag: '',
enabled: true,
hasKey: false,
keyHint: '',
apiKey: '',
clearKey: false,
  }
}

function resourceTitle(resource: ResourceDraft): string {
  return resource.label.trim() || resource.model.trim() || t("未命名模型")
}

/**
 * 「模型」页：会话、复盘和评估引用的全部端点。
 *
 * 这块表单原先挂在设置弹窗的第一个分组里，改一次模型要先开设置、再翻到分组。
 * 模型是最常改的一项，所以自成页面挂在左下角；保存只提交模型字段，
 * 不会顺带把沙箱、学习、通知那些还没改的草稿一起落盘。
 */
export function ModelPanel({
  settings,
  onSaved,
  onNotice,
  onError,
}: {
  settings: SettingsView
  onSaved: (view: SettingsView) => void
  /** 保存成功后的轻提示：这个页面没有「关闭」动作，不给反馈会像没生效。 */
  onNotice?: (message: string) => void
  onError: (message: string) => void
}) {
  const [resources, setResources] = useState<ResourceDraft[]>(() =>
settings.modelResources.map((resource) => ({
  ...resource,
  apiKey: '',
  clearKey: false,
})),
  )
  const [sessionModelId, setSessionModelId] = useState(settings.sessionModelId)
  const [evaluationIds, setEvaluationIds] = useState<string[]>(() => {
const valid = settings.evaluationModelIds.filter((id) =>
  settings.modelResources.some((resource) => resource.id === id),
)
return valid.length >= 2 ? valid : [...valid, ...Array(2 - valid.length).fill('')]
  })
  const [reviewModelId, setReviewModelId] = useState(settings.reviewModelId)
  const [resourceTesting, setResourceTesting] = useState('')
  const [resourceResults, setResourceResults] = useState<
Record<string, ConnectionTestResult | null>
  >({})
  const [resourceBalanceTesting, setResourceBalanceTesting] = useState('')
  const [resourceBalances, setResourceBalances] = useState<
Record<string, ModelBalanceState | null>
  >({})
  const [autoReflect, setAutoReflect] = useState(settings.autoReflect)
  const [newResourceId, setNewResourceId] = useState('')
  const pendingResourceFocus = useRef('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
const id = pendingResourceFocus.current
if (!id) return
pendingResourceFocus.current = ''
const body = pageRef.current
const row = body?.querySelector<HTMLElement>(`[data-resource-id="${id}"]`)
if (!body || !row) return
body.scrollTo({ top: 0 })
row.querySelector('input')?.focus({ preventScroll: true })
  }, [resources])

  const sessionResource =
resources.find((resource) => resource.id === sessionModelId) ?? resources[0]
  const sessionModel = sessionResource?.model.trim() || ''
  const effectiveHasKey = sessionResource
? sessionResource.hasKey || Boolean(sessionResource.apiKey.trim())
: settings.hasKey

  const patchResource = (id: string, patch: Partial<ResourceDraft>) => {
setResources((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
if (id === newResourceId) setNewResourceId('')
if (patch.clearKey || patch.apiKey !== undefined) {
  setResourceResults((current) => ({ ...current, [id]: null }))
}
  }

  const addResource = () => {
if (resources.length >= MAX_MODEL_RESOURCES) return
const draft = newResourceDraft()
pendingResourceFocus.current = draft.id
setNewResourceId(draft.id)
setResources((list) => (list.length >= MAX_MODEL_RESOURCES ? list : [draft, ...list]))
  }

  const removeResource = (id: string) => {
if (resources.length <= 1) return
setResources((list) => {
  const next = list.filter((resource) => resource.id !== id)
  const fallback = next[0]?.id ?? ''
  setSessionModelId((current) => (current === id ? fallback : current))
  setReviewModelId((current) => (current === id ? '' : current))
  setEvaluationIds((current) => current.map((value) => (value === id ? '' : value)))
  return next
})
setResourceResults((current) => {
  const next = { ...current }
  delete next[id]
  return next
})
setResourceBalances((current) => {
  const next = { ...current }
  delete next[id]
  return next
})
  }

  const testResource = async (resource: ResourceDraft) => {
setResourceTesting(resource.id)
setResourceResults((current) => ({ ...current, [resource.id]: null }))
try {
  const result = await window.pilot.testConnection({
    ...(resource.apiKey.trim() ? { apiKey: resource.apiKey.trim() } : {}),
    ...(resource.baseUrl.trim() ? { baseUrl: resource.baseUrl.trim() } : {}),
    ...(resource.model.trim() ? { model: resource.model.trim() } : {}),
    ...(resource.hasKey ? { providerId: resource.id } : {}),
  })
  setResourceResults((current) => ({ ...current, [resource.id]: result }))
} catch (caught) {
  const message = caught instanceof Error ? caught.message : String(caught)
  setResourceResults((current) => ({
    ...current,
    [resource.id]: { ok: false, message },
  }))
} finally {
  setResourceTesting('')
}
  }

  const checkResourceBalance = async (resource: ResourceDraft) => {
setResourceBalanceTesting(resource.id)
setResourceBalances((current) => ({ ...current, [resource.id]: null }))
try {
  const result = await window.pilot.judgeBalance({
    ...(resource.apiKey.trim() ? { apiKey: resource.apiKey.trim() } : {}),
    ...(resource.baseUrl.trim() ? { baseUrl: resource.baseUrl.trim() } : {}),
    ...(resource.model.trim() ? { model: resource.model.trim() } : {}),
    ...(resource.hasKey ? { providerId: resource.id } : {}),
  })
  setResourceBalances((current) => ({ ...current, [resource.id]: result }))
} catch (caught) {
  setResourceBalances((current) => ({
    ...current,
    [resource.id]: {
      ok: false,
      available: false,
      entries: [],
      source: '',
      fetchedAt: new Date().toISOString(),
      error: 'error',
      errorDetail: caught instanceof Error ? caught.message : String(caught),
    },
  }))
} finally {
  setResourceBalanceTesting('')
}
  }

  const setEvaluationAt = (index: number, id: string) => {
setEvaluationIds((list) => list.map((value, at) => (at === index ? id : value)))
  }

  const addEvaluation = () => {
setEvaluationIds((list) => (list.length >= MAX_EVALUATION_MODELS ? list : [...list, '']))
  }

  const removeEvaluation = (index: number) => {
setEvaluationIds((list) => (list.length <= 1 ? list : list.filter((_, at) => at !== index)))
  }

  const modelSelectOptions = resources.map((resource) => ({
value: resource.id,
// 名称 · 标签：标签是给人看的，没填就只显示名称。
label: modelOptionLabel(
  `${resourceTitle(resource)} · ${resource.model || t("未配置")}`,
  resource.tag,
),
disabled: !resource.enabled,
  }))

  const save = async () => {
    setError('')
    if (resources.length === 0) {
      setError(t("至少保留一个模型资源。"))
      return
    }
    for (const resource of resources) {
      const address = resource.baseUrl.trim()
      if (!address || !resource.model.trim()) {
        setError(t("每个模型资源都要填写接口地址和模型名。"))
        return
      }
      try {
        const url = new URL(address)
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
          throw new Error('invalid')
        }
      } catch {
        setError(t("模型资源的接口地址必须是 http:// 或 https:// 地址：{v1}", { v1: address }))
        return
      }
    }
    if (resources.filter((resource) => resource.enabled).length === 0) {
      setError(t("至少启用一个模型资源。"))
      return
    }
    if (!sessionResource?.enabled) {
      setError(t("会话模型不能使用已停用的模型资源。"))
      return
    }
    const selectedEvaluation = evaluationIds.map((id) => id.trim()).filter(Boolean)
    if (new Set(selectedEvaluation).size !== selectedEvaluation.length) {
      setError(t("同一个模型资源不能重复作为评估模型。"))
      return
    }
    const input: SettingsUpdate = {
      modelResources: resources.map((resource) => ({
        id: resource.id,
        label: resource.label.trim(),
        baseUrl: resource.baseUrl.trim(),
        model: resource.model.trim(),
        tag: resource.tag.trim(),
        enabled: resource.enabled,
        ...(resource.clearKey
          ? { apiKey: null }
          : resource.apiKey.trim()
            ? { apiKey: resource.apiKey.trim() }
            : {}),
      })),
      sessionModelId,
      evaluationModelIds: selectedEvaluation,
      reviewModelId,
      ...(sessionModel ? { classifierModel: sessionModel } : {}),
    }
    setSaving(true)
    try {
      const view = await window.pilot.updateSettings(input)
      onSaved(view)
      setResources(
        view.modelResources.map((resource) => ({ ...resource, apiKey: '', clearKey: false })),
      )
      setSessionModelId(view.sessionModelId)
      setReviewModelId(view.reviewModelId)
      setEvaluationIds(() => {
        const valid = view.evaluationModelIds.filter((id) =>
          view.modelResources.some((resource) => resource.id === id),
        )
        return valid.length >= 2 ? valid : [...valid, ...Array(2 - valid.length).fill('')]
      })
      setResourceResults({})
      setResourceBalances({})
      onNotice?.(t("模型设置已保存。"))
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page panel-page model-page" ref={pageRef}>
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <SparkIcon width={13} height={13} />
            {t("会话 · 复盘 · 评估")}
          </div>
          <h1>{t("模型")}</h1>
          <p>
            {t("所有模型都从这里配置。会话、复盘和评估只引用资源；密钥仅保存在本机并加密。")}
          </p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="button primary" onClick={() => void save()} disabled={saving}>
            {saving ? <i className="spinner" /> : null}
            {t("保存")}
          </button>
        </div>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}

      <section
        className="settings-section"
      >
        <div className="settings-section-head">
          <div>
            <h3>{t("模型资源")}</h3>
            <p>{t("所有模型都从这里统一配置。会话、复盘和评估只引用资源；密钥仅保存在本机并加密。")}</p>
          </div>
          <button
            type="button"
            className="button ghost small"
            onClick={addResource}
            disabled={resources.length >= MAX_MODEL_RESOURCES}
          >
            {t("添加模型资源")}
          </button>
        </div>

        <div className="judge-list">
          {resources.map((resource) => (
            <div
              className={`judge-row${resource.id === newResourceId ? ' is-new' : ''}`}
              key={resource.id}
              data-resource-id={resource.id}
            >
              <div className="model-resource-head">
                <strong>{resourceTitle(resource)}</strong>
                <span className={`key-state${resource.hasKey || resource.apiKey ? ' ok' : ''}`}>
                  <i className="key-dot" />
                  {resource.hasKey || resource.apiKey ? t("已配置密钥") : t("缺少密钥")}
                </span>
              </div>
              <div className="field-grid three">
                <Field label={t("名称")} hint={t("只在本机显示")}>
                  <input
                    className="text-input"
                    value={resource.label}
                    placeholder={t("例如 通义千问")}
                    onChange={(event) =>
                      patchResource(resource.id, { label: event.target.value })
                    }
                  />
                </Field>
                <Field label={t("模型")}>
                  <input
                    className="text-input mono"
                    value={resource.model}
                    placeholder="qwen-plus"
                    onChange={(event) =>
                      patchResource(resource.id, { model: event.target.value })
                    }
                    spellCheck={false}
                  />
                </Field>
                <Field label={t("标签")} hint={t("最多四个字，如“个人”“公司A”")}>
                  <input
                    className="text-input"
                    value={resource.tag}
                    maxLength={MODEL_TAG_MAX_LENGTH}
                    placeholder={t("不超过四字")}
                    onChange={(event) =>
                      patchResource(resource.id, {
                        tag: normalizeModelTag(event.target.value),
                      })
                    }
                    spellCheck={false}
                  />
                </Field>
              </div>
              <Field label="Base URL" hint={t("OpenAI 兼容接口地址")}>
                <input
                  className="text-input mono"
                  value={resource.baseUrl}
                  placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                  onChange={(event) =>
                    patchResource(resource.id, { baseUrl: event.target.value })
                  }
                  spellCheck={false}
                />
              </Field>
              <Field
                label="API Key"
                hint={resource.hasKey ? resource.keyHint : t("仅保存在本机并加密")}
              >
                <div className="key-input-row">
                  <input
                    className="text-input mono"
                    type="password"
                    value={resource.apiKey}
                    placeholder={
                      resource.clearKey
                        ? t("保存后将清除 Key")
                        : resource.hasKey
                          ? t("{v1}（留空保持不变）", { v1: resource.keyHint })
                          : 'sk-...'
                    }
                    onChange={(event) =>
                      patchResource(resource.id, {
                        apiKey: event.target.value,
                        clearKey: false,
                      })
                    }
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {resource.hasKey || resource.apiKey ? (
                    <button
                      type="button"
                      className="button ghost small"
                      onClick={() =>
                        patchResource(resource.id, {
                          apiKey: '',
                          clearKey: !resource.clearKey,
                        })
                      }
                    >
                      {resource.clearKey ? t("撤销清除") : t("清除")}
                    </button>
                  ) : null}
                </div>
              </Field>
              <div className="test-row">
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => void testResource(resource)}
                  disabled={
                    resourceTesting === resource.id ||
                    (!resource.hasKey && !resource.apiKey.trim())
                  }
                >
                  {resourceTesting === resource.id ? (
                    <i className="spinner" />
                  ) : (
                    <RefreshIcon width={15} height={15} />
                  )}
                  {resourceTesting === resource.id ? t("测试中…") : t("测试连接")}
                </button>
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => void checkResourceBalance(resource)}
                  disabled={
                    resourceBalanceTesting === resource.id ||
                    !resource.baseUrl.trim() ||
                    (!resource.hasKey && !resource.apiKey.trim())
                  }
                >
                  {resourceBalanceTesting === resource.id ? (
                    <i className="spinner" />
                  ) : (
                    <RefreshIcon width={15} height={15} />
                  )}
                  {resourceBalanceTesting === resource.id ? t("查询中…") : t("查询余额")}
                </button>
                <label className="judge-toggle">
                  <input
                    type="checkbox"
                    checked={resource.enabled}
                    onChange={(event) => {
                      const enabled = event.target.checked
                      patchResource(resource.id, { enabled })
                      if (!enabled) {
                        if (sessionModelId === resource.id) {
                          const fallback = resources.find(
                            (item) => item.id !== resource.id && item.enabled,
                          )
                          if (fallback) setSessionModelId(fallback.id)
                        }
                        if (reviewModelId === resource.id) setReviewModelId('')
                        setEvaluationIds((list) =>
                          list.map((value) => (value === resource.id ? '' : value)),
                        )
                      }
                    }}
                  />
                  {t("启用")}
                </label>
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => removeResource(resource.id)}
                  disabled={resources.length <= 1}
                >
                  {t("删除")}
                </button>
                {resourceResults[resource.id] ? (
                  <span
                    className={`test-result${resourceResults[resource.id]!.ok ? ' ok' : ' failed'}`}
                  >
                    {resourceResults[resource.id]!.ok ? (
                      <CheckIcon width={14} height={14} />
                    ) : (
                      <XIcon width={14} height={14} />
                    )}
                    {resourceResults[resource.id]!.message}
                  </span>
                ) : null}
                {resourceBalances[resource.id] ? (
                  <span
                    className={`test-result${resourceBalances[resource.id]!.ok ? ' ok' : ' failed'}`}
                    title={
                      resourceBalances[resource.id]!.errorDetail ??
                      resourceBalances[resource.id]!.source
                    }
                  >
                    {resourceBalances[resource.id]!.ok ? (
                      <CheckIcon width={14} height={14} />
                    ) : (
                      <XIcon width={14} height={14} />
                    )}
                    {resourceBalances[resource.id]!.ok
                      ? t("余额：{v1}", {
                          v1: balanceSummary(resourceBalances[resource.id]!),
                        })
                      : balanceSummary(resourceBalances[resource.id]!)}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="settings-subhead">
          <strong>{t("会话与复盘")}</strong>
          <span>{t("会话模型用于普通对话与工具调用；复盘模型只在评审会话里使用。")}</span>
        </div>
        <div className="field-grid">
          <Field label={t("会话模型")} hint={t("普通会话、分析和工具调用使用这个资源。")}>
            <SelectMenu
              value={sessionModelId}
              options={modelSelectOptions}
              onChange={setSessionModelId}
              ariaLabel={t("会话模型")}
              maxListWidth={360}
            />
          </Field>
          <Field label={t("复盘模型")} hint={t("复盘会话使用；跟随会话模型时不需要单独配置。")}>
            <SelectMenu
              value={reviewModelId}
              options={[
                { value: '', label: t("跟随会话模型") },
                ...modelSelectOptions,
              ]}
              onChange={setReviewModelId}
              ariaLabel={t("复盘模型")}
              maxListWidth={360}
            />
          </Field>
        </div>

        <div className="settings-subhead">
          <strong>{t("评估模型")}</strong>
          <span>{t("推荐两个独立模型")}</span>
        </div>
        <p className="settings-note">
          {t("默认第一评估和第二评估；可增加更多，也可减少到一个。未选择时由会话模型自评，不算独立评审。")}
        </p>
        <div className="model-eval-list">
          {evaluationIds.map((id, index) => (
            <div className="model-eval-row" key={`eval-${index}`}>
              <span className="model-eval-label">
                {EVALUATION_LABELS[index] ?? t("评估模型")}
              </span>
              <SelectMenu
                className="model-eval-menu"
                value={id}
                options={[
                  { value: '', label: t("选择模型资源") },
                  ...modelSelectOptions.map((option) => ({
                    ...option,
                    disabled: option.disabled || evaluationIds.includes(option.value),
                  })),
                ]}
                onChange={(value) => setEvaluationAt(index, value)}
                ariaLabel={EVALUATION_LABELS[index] ?? t("评估模型")}
                maxListWidth={360}
              />
              <button
                type="button"
                className="button ghost small"
                onClick={() => removeEvaluation(index)}
                disabled={evaluationIds.length <= 1}
              >
                {t("移除")}
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="button ghost small"
          onClick={addEvaluation}
          disabled={evaluationIds.length >= MAX_EVALUATION_MODELS}
        >
          {t("添加评估模型")}
        </button>
      </section>

      <BillingPanel
        hasKey={effectiveHasKey}
        model={sessionModel || settings.model}
      />
    </div>
  )
}
