import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  ApprovalMode,
  FontSizePreference,
  ConnectionTestResult,
  JudgeProvider,
  ModelBalanceState,
  QualityPublishTarget,
  SandboxMode,
  SandboxStatus,
  SettingsUpdate,
  ShellInterpreter,
  SettingsView,
  SystemInfo,
  TestCaptchaMode,
  ThemeMode,
  ContrastPreference,
  SaturationPreference,
} from '../../../shared/types'
import { DISK_LOW_BYTES, formatBytes } from '../../../shared/system-info'
import { formatLogRecords } from '../../../shared/app-log-view'
import { modelLimits, SETTING_CONTEXT_MAX, SETTING_OUTPUT_MAX } from '../../../shared/modelLimits'
import { MODEL_TAG_MAX_LENGTH, modelOptionLabel, normalizeModelTag } from '../../../shared/model-label'
import type { LocaleSetting } from '../../../shared/i18n'
import { CheckIcon, InfoIcon, RefreshIcon, XIcon } from '../icons'
import { copyText } from '../clipboard'
import { applyLocaleSetting, t } from '../i18n'
import { BillingPanel, balanceSummary } from './BillingPanel'
import { SelectMenu } from './SelectMenu'
import { useEscapeClose } from './useEscapeClose'

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

const FONT_SIZE_OPTIONS: Array<{ value: FontSizePreference; label: string }> = [
  { value: 'standard', label: t("标准") },
  { value: 'large', label: t("大") },
  { value: 'xlarge', label: t("特大") },
]

const CONTRAST_OPTIONS: Array<{ value: ContrastPreference; label: string }> = [
  { value: 'low', label: t("低") },
  { value: 'standard', label: t("标准") },
  { value: 'high', label: t("高") },
]

const SATURATION_OPTIONS: Array<{ value: SaturationPreference; label: string }> = [
  { value: 'low', label: t("低") },
  { value: 'standard', label: t("标准") },
  { value: 'high', label: t("高") },
]

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

function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string
  hint?: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <label className={`settings-field${wide ? ' wide' : ''}`}>
      <span className="field-label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description: string
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="toggle-text">
        <span>{label}</span>
        <small>{description}</small>
      </span>
      <span className="toggle-switch">
        <i />
      </span>
    </button>
  )
}

const APPROVAL_OPTIONS: Array<{ value: ApprovalMode; label: string }> = [
  { value: 'auto', label: t("全部自动") },
  { value: 'manual', label: t("只读自动") },
  { value: 'ask', label: t("逐条审批") },
]

/**
 * A per-run ceiling on total tokens. Off by default: a budget that is too low
 * ends a task that would have finished, so it is an explicit choice.
 */
const TOKEN_BUDGET_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: t("不限制") },
  { value: '200000', label: t("20 万") },
  { value: '600000', label: t("60 万") },
  { value: '2000000', label: t("200 万") },
]

function linesOf(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200)
}

/** Which section the settings dialog should reveal on open. */
export type SettingsFocus = 'reviewers' | null

export function SettingsDialog({
  settings,
  workspacePath,
  onClose,
  onSaved,
  onError,
  focusSection = null,
}: {
  settings: SettingsView
  /** Active workspace; only decides which volume the environment panel measures. */
  workspacePath?: string | null
  onClose: () => void
  onSaved: (view: SettingsView) => void
  onError: (message: string) => void
  focusSection?: SettingsFocus
}) {
  const [maxSteps, setMaxSteps] = useState(String(settings.maxSteps))
  const [maxTokens, setMaxTokens] = useState(String(settings.maxTokens))
  const [maxContextTokens, setMaxContextTokens] = useState(String(settings.maxContextTokens))
  useEscapeClose(onClose)
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(settings.maxOutputTokens))
  const [temperature, setTemperature] = useState(String(settings.temperature))
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
  const [autoEvolve, setAutoEvolve] = useState(settings.autoEvolve)
  const [autoContinue, setAutoContinue] = useState(settings.autoContinue)
  const [autoContinueLimit, setAutoContinueLimit] = useState(String(settings.autoContinueLimit))
  const [screenshotFeedback, setScreenshotFeedback] = useState(settings.screenshotFeedback)
  const [testTargets, setTestTargets] = useState(settings.testTargets.join('\n'))
  const [testCaptchaMode, setTestCaptchaMode] = useState<TestCaptchaMode>(settings.testCaptchaMode)
  const [testCaptcha, setTestCaptcha] = useState('')
  const [clearTestCaptcha, setClearTestCaptcha] = useState(false)
  const [approvalTimeoutSec, setApprovalTimeoutSec] = useState(String(settings.approvalTimeoutSec))
  const [shellMode, setShellMode] = useState(settings.shellMode)
  const [shellInterpreter, setShellInterpreter] = useState<ShellInterpreter>(
    settings.shellInterpreter,
  )
  const [defaultApprovalMode, setDefaultApprovalMode] = useState<ApprovalMode>(
    settings.defaultApprovalMode,
  )
  const [allowRules, setAllowRules] = useState(settings.permissionRules.allow.join('\n'))
  const [askRules, setAskRules] = useState(settings.permissionRules.ask.join('\n'))
  const [denyRules, setDenyRules] = useState(settings.permissionRules.deny.join('\n'))
  const [trustedCommands, setTrustedCommands] = useState(settings.trustedCommands)
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>(settings.sandboxMode)
  const [sandboxNetwork, setSandboxNetwork] = useState(settings.sandboxNetwork)
  const [sandboxAutoAllow, setSandboxAutoAllow] = useState(settings.sandboxAutoAllow)
  const [allowUnattendedBuild, setAllowUnattendedBuild] = useState(
    settings.allowUnattendedBuild,
  )
  const [learningMode, setLearningMode] = useState(settings.learningMode)
  const [learningHosts, setLearningHosts] = useState(settings.learningHosts.join('\n'))
  const [learningShellIsolation, setLearningShellIsolation] = useState(
    settings.learningShellIsolation,
  )
  const [qualityGate, setQualityGate] = useState(settings.qualityGate)
  const [qualityPublishTarget, setQualityPublishTarget] = useState<QualityPublishTarget>(
    settings.qualityPublishTarget,
  )
  const [qualityTuneEvery, setQualityTuneEvery] = useState(String(settings.qualityTuneEvery))
  const [checkpointRetention, setCheckpointRetention] = useState(
    String(settings.checkpointRetention),
  )
  const [checkpointMaxMb, setCheckpointMaxMb] = useState(
    String(Math.round(settings.checkpointMaxBytes / (1024 * 1024))),
  )
  const [checkpointShell, setCheckpointShell] = useState(settings.checkpointShell)
  // One pattern per line keeps the control honest: spaces and globs are legal
  // inside a pattern, so a comma-separated field would be ambiguous.
  const [checkpointIgnore, setCheckpointIgnore] = useState(
    settings.checkpointIgnore.join('\n'),
  )
  const [hooksEnabled, setHooksEnabled] = useState(settings.hooksEnabled)
  const [mcpEnabled, setMcpEnabled] = useState(settings.mcpEnabled)
  const [openingGlobal, setOpeningGlobal] = useState(false)
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [envInfo, setEnvInfo] = useState<SystemInfo | null>(null)
  const [envCopied, setEnvCopied] = useState(false)
  const [logDir, setLogDir] = useState('')
  const [logCopied, setLogCopied] = useState(false)
  const [notifyDesktop, setNotifyDesktop] = useState(settings.notifyDesktop)
  const [theme, setTheme] = useState<ThemeMode>(settings.theme)
  const [fontSize, setFontSize] = useState<FontSizePreference>(settings.fontSize)
  const [contrast, setContrast] = useState<ContrastPreference>(settings.contrast)
  const [saturation, setSaturation] = useState<SaturationPreference>(settings.saturation)
  const [locale, setLocale] = useState<LocaleSetting>(settings.locale)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const reviewersRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focusSection !== 'reviewers') return
    reviewersRef.current?.scrollIntoView({ block: 'start' })
  }, [focusSection])

  // Preview the appearance while the dialog is open. Cancel restores the saved
  // values; saving updates `settings` and the parent effect takes over.
  useEffect(() => {
    const root = document.documentElement
    root.dataset['theme'] = theme
    root.dataset['fontSize'] = fontSize
    root.dataset['contrast'] = contrast
    root.dataset['saturation'] = saturation
    void window.pilot
      .previewTheme({ theme, contrast, saturation })
      .catch(() => undefined)
    return () => {
      root.dataset['theme'] = settings.theme
      root.dataset['fontSize'] = settings.fontSize
      root.dataset['contrast'] = settings.contrast
      root.dataset['saturation'] = settings.saturation
      void window.pilot.previewTheme(null).catch(() => undefined)
    }
  }, [
    theme,
    fontSize,
    contrast,
    saturation,
    settings.theme,
    settings.fontSize,
    settings.contrast,
    settings.saturation,
  ])

  useEffect(() => {
    void window.pilot
      .sandboxStatus()
      .then(setSandbox)
      .catch(() => setSandbox(null))
  }, [])

  // Read once per open: CPU and memory totals cannot change while it is up, and
  // the free-space figure only needs to be good enough to spot a near-full disk.
  useEffect(() => {
    void window.pilot
      .systemInfo(workspacePath ?? undefined)
      .then(setEnvInfo)
      .catch(() => setEnvInfo(null))
  }, [workspacePath])

  // 日志目录只在需要时读一次：定位不到也不影响面板其它内容。
  useEffect(() => {
    void window.pilot
      .logDir()
      .then(setLogDir)
      .catch(() => setLogDir(''))
  }, [])

  const envLines: Array<[string, string]> = envInfo
    ? [
        [t("系统"), `${envInfo.platform} ${envInfo.osRelease} (${envInfo.arch})`],
        [t("CPU"), `${envInfo.cpuModel || 'unknown'} · ${envInfo.cpuCount} 核`],
        [
          t("内存"),
          `${formatBytes(envInfo.memoryFreeBytes)} 可用 / ${formatBytes(envInfo.memoryTotalBytes)}`,
        ],
        [
          t("磁盘"),
          envInfo.disk?.freeBytes === null || !envInfo.disk
            ? t("未知")
            : `${formatBytes(envInfo.disk.freeBytes)} 可用 / ${formatBytes(envInfo.disk.totalBytes)}`,
        ],
        [t("运行时"), `Electron ${envInfo.electron} · Node ${envInfo.node}`],
      ]
    : []

  const copyEnv = async (): Promise<void> => {
    const text = envLines.map(([label, value]) => `${label}：${value}`).join('\n')
    const ok = await copyText(text)
    setEnvCopied(ok)
    if (!ok) setError(t("剪贴板不可用"))
  }

  /**
   * 复制最近的运行/崩溃/审计日志：用户报问题时把这段贴给维护者，比让他去
   * `%APPDATA%` 里找文件夹现实得多。记录本身已在写盘时脱敏并截断。
   */
  const copyLogs = async (): Promise<void> => {
    const records = await window.pilot.recentLogs(60).catch(() => [])
    if (records.length === 0) {
      setError(t("还没有日志记录"))
      return
    }
    const text = formatLogRecords(records)
    const ok = await copyText(text)
    setLogCopied(ok)
    if (!ok) setError(t("剪贴板不可用"))
  }

  const sessionResource =
    resources.find((resource) => resource.id === sessionModelId) ?? resources[0]
  const sessionModel = sessionResource?.model.trim() || ''
  const effectiveHasKey = sessionResource
    ? sessionResource.hasKey || Boolean(sessionResource.apiKey.trim())
    : settings.hasKey

  const patchResource = (id: string, patch: Partial<ResourceDraft>) => {
    setResources((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
    if (patch.clearKey || patch.apiKey !== undefined) {
      setResourceResults((current) => ({ ...current, [id]: null }))
    }
  }

  const addResource = () => {
    setResources((list) => (list.length >= MAX_MODEL_RESOURCES ? list : [...list, newResourceDraft()]))
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

  const openGlobalInstructions = async () => {
    setError('')
    setOpeningGlobal(true)
    try {
      await window.pilot.openGlobalInstructions()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setOpeningGlobal(false)
    }
  }

  const save = async () => {
    setError('')
    const steps = Number(maxSteps)
    const budget = Number(maxTokens)
    const context = Number(maxContextTokens)
    const output = Number(maxOutputTokens)
    const temp = Number(temperature)
    const continueLimit = Number(autoContinueLimit)
    const approvalTimeout = Number(approvalTimeoutSec)
    const retention = Number(checkpointRetention)
    const maxMb = Number(checkpointMaxMb)

    if (!Number.isFinite(steps) || steps < 1 || steps > 1_000) {
      setError(t("最大步数需要在 1 到 1,000 之间。"))
      return
    }
    if (!Number.isFinite(budget) || budget < 0) {
      setError(t("token 总量上限需要是 0 或正整数（0 = 不限制）。"))
      return
    }
    if (!Number.isFinite(context) || context < 8_000 || context > SETTING_CONTEXT_MAX) {
      setError(t("上下文预算需要在 8,000 到 {v1} 之间。", { v1: SETTING_CONTEXT_MAX.toLocaleString() }))
      return
    }
    if (!Number.isFinite(output) || output < 512 || output > SETTING_OUTPUT_MAX) {
      setError(t("单次输出上限需要在 512 到 {v1} 之间。", { v1: SETTING_OUTPUT_MAX.toLocaleString() }))
      return
    }
    if (!Number.isFinite(temp) || temp < 0 || temp > 1) {
      setError(t("温度需要在 0 到 1 之间。"))
      return
    }
    if (!Number.isFinite(continueLimit) || continueLimit < 1 || continueLimit > 10) {
      setError(t("自动继续次数需要在 1 到 10 之间。"))
      return
    }
    if (!Number.isFinite(approvalTimeout) || approvalTimeout < 0 || approvalTimeout > 3_600) {
      setError(t("审批超时需要在 0 到 3,600 秒之间。"))
      return
    }
    if (!Number.isFinite(retention) || retention < 5 || retention > 100) {
      setError(t("回退点保留数量需要在 5 到 100 之间。"))
      return
    }
    if (!Number.isFinite(maxMb) || maxMb < 512 || maxMb > 20_480) {
      setError(t("回退点总空间上限需要在 512 MB 到 20,480 MB 之间。"))
      return
    }
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
    const enabledResources = resources.filter((resource) => resource.enabled)
    if (enabledResources.length === 0) {
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
    const targetLines = testTargets
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (targetLines.length > 20) {
      setError(t("测试目标最多 20 个。"))
      return
    }
    for (const line of targetLines) {
      try {
        const url = new URL(line)
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
          throw new Error('invalid')
        }
      } catch {
        setError(t("测试目标必须是 http:// 或 https:// 地址，且不能包含用户名或密码：{v1}", { v1: line }))
        return
      }
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
      maxSteps: Math.round(steps),
      maxTokens: Math.round(budget),
      maxContextTokens: Math.round(context),
      maxOutputTokens: Math.round(output),
      temperature: temp,
      autoReflect,
      autoEvolve,
      autoContinue,
      autoContinueLimit: Math.round(continueLimit),
      screenshotFeedback,
      testTargets: targetLines,
      testCaptchaMode,
      ...(clearTestCaptcha
        ? { testCaptcha: null }
        : testCaptcha.trim()
          ? { testCaptcha: testCaptcha.trim() }
          : {}),
      approvalTimeoutSec: Math.round(approvalTimeout),
      shellMode,
      shellInterpreter,
      defaultApprovalMode,
      permissionRules: {
        allow: linesOf(allowRules),
        ask: linesOf(askRules),
        deny: linesOf(denyRules),
      },
      classifierModel: sessionModel,
      sandboxMode,
      sandboxNetwork,
      sandboxAutoAllow,
      allowUnattendedBuild,
      learningMode,
      learningHosts: linesOf(learningHosts),
      learningShellIsolation,
      qualityGate,
      qualityPublishTarget,
      qualityTuneEvery: Math.min(50, Math.max(0, Math.round(Number(qualityTuneEvery) || 0))),
      checkpointRetention: Math.round(retention),
      checkpointMaxBytes: Math.round(maxMb * 1024 * 1024),
      checkpointShell,
      checkpointIgnore: checkpointIgnore
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      hooksEnabled,
      mcpEnabled,
      notifyDesktop,
      theme,
      fontSize,
      contrast,
      saturation,
      locale,
    }

    setSaving(true)
    try {
      const view = await window.pilot.updateSettings(input)
      onSaved(view)
      onClose()
      if (applyLocaleSetting(view.locale, [view.systemLocale])) window.location.reload()
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
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("设置")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t("设置")}</h2>
            <p>{t("所有数据保存在本机，不需要账号或登录。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body settings-body" ref={bodyRef}>
          <section
            className={`settings-section${focusSection === 'reviewers' ? ' settings-section-focus' : ''}`}
            ref={reviewersRef}
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
                <div className="judge-row" key={resource.id}>
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

            <div className="model-eval-head">
              <span>{t("评估模型")}</span>
              <span className="model-eval-note">{t("推荐两个独立模型")}</span>
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

          <BillingPanel hasKey={effectiveHasKey} model={sessionModel || settings.model} />

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>{t("运行参数")}</h3>
                <p>
                  {t("默认值适合大多数任务；增大上下文会消耗更多 tokens。当前模型")}{' '}
                  <code>{sessionModel || t("未知")}</code> {t("的窗口为")}{' '}
                  {modelLimits(sessionModel).contextTokens.toLocaleString()}{' '}
                  {t("tokens，超出部分会被自动收敛。")}</p>
              </div>
            </div>

            <div className="field-grid three">
              <Field label={t("最大步数")}>
                <input
                  className="text-input mono"
                  type="number"
                  min={1}
                  max={1000}
                  value={maxSteps}
                  onChange={(event) => setMaxSteps(event.target.value)}
                />
              </Field>
              <Field label={t("上下文预算")} hint="tokens">
                <input
                  className="text-input mono"
                  type="number"
                  min={8000}
                  max={SETTING_CONTEXT_MAX}
                  step={1000}
                  value={maxContextTokens}
                  onChange={(event) => setMaxContextTokens(event.target.value)}
                />
              </Field>
              <Field label={t("单次输出上限")} hint="tokens">
                <input
                  className="text-input mono"
                  type="number"
                  min={512}
                  max={SETTING_OUTPUT_MAX}
                  step={256}
                  value={maxOutputTokens}
                  onChange={(event) => setMaxOutputTokens(event.target.value)}
                />
              </Field>
            </div>

            <div className="field-grid">
              <Field label={t("温度")} hint={t("0 = 稳定，2 = 发散")}>
                <input
                  className="text-input mono"
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                />
              </Field>
              <Field label={t("新会话默认执行模式")}>
                <SelectMenu
                  value={defaultApprovalMode}
                  options={APPROVAL_OPTIONS}
                  onChange={(value) => setDefaultApprovalMode(value as ApprovalMode)}
                  ariaLabel={t("新会话默认执行模式")}
                />
              </Field>
              <Field label={t("token 总量上限")} hint={t("单次任务累计；不限制则跑满步数为止")}>
                <SelectMenu
                  value={maxTokens}
                  options={TOKEN_BUDGET_OPTIONS}
                  onChange={setMaxTokens}
                  ariaLabel={t("token 总量上限")}
                />
              </Field>
            </div>

            <div className="field-grid">
              <Field label={t("审批超时")} hint={t("超时后自动拒绝；0 表示一直等待")}>
                <SelectMenu
                  value={approvalTimeoutSec}
                  options={[
                    { value: '0', label: t("不自动拒绝") },
                    { value: '60', label: t("1 分钟") },
                    { value: '180', label: t("3 分钟") },
                    { value: '300', label: t("5 分钟") },
                    { value: '600', label: t("10 分钟") },
                    { value: '1800', label: t("30 分钟") },
                  ]}
                  onChange={setApprovalTimeoutSec}
                  ariaLabel={t("审批超时")}
                />
              </Field>
              <Field label={t("自动继续次数上限")} hint={t("仅在中途失败、达到步数上限或计划未完成时触发")}>
                <input
                  className="text-input mono"
                  type="number"
                  min={1}
                  max={10}
                  value={autoContinueLimit}
                  disabled={!autoContinue}
                  onChange={(event) => setAutoContinueLimit(event.target.value)}
                />
              </Field>
            </div>

            <div className="toggle-list">
              <Toggle
                checked={autoContinue}
                onChange={setAutoContinue}
                label={t("长任务自动继续")}
                description={t("任务未完成时，自动从中断处继续，直到完成或达到上面的次数上限。手动暂停的会话不会自动继续。")}
              />
              <Toggle
                checked={allowUnattendedBuild}
                onChange={setAllowUnattendedBuild}
                label={t("允许无人值守的个人构建")}
                description={t("开启后，全部自动模式的会话在构建个人实验版（self-build、package:*、electron-builder）时不再逐次确认。构建会把可修改的源码变成可执行文件，只在你确实会离开电脑时开启；只读自动和逐条审批模式仍然需要确认。")}
              />
              <Toggle
                checked={learningMode}
                onChange={setLearningMode}
                label={t("自主探索学习")}
                description={t("允许智能体从白名单公开站点只读搜集资料、自己决定做什么任务，并把来源、任务与阶段成果记在工作区的 .pilot/learning 账本里。开启后请求仍只允许 GET/HEAD：抓到的内容只落在工作区，任何上传、提交、发布、推送类命令都会被拒绝；每个阶段成果都要你点头才算完成。")}
              />
              {learningMode ? (
                <Toggle
                  checked={learningShellIsolation}
                  onChange={setLearningShellIsolation}
                  label={t("学习探索期间让 shell 断网")}
                  description={t("默认关闭：学习的白名单只约束 learning_research，任务会话照你用下面的「沙箱网络」设置联网，安装依赖、访问接口都不受影响。开启后，学习探索开启期间 shell 沙箱拿不到网络，作为文本匹配之外的兜底。")}
                />
              ) : null}
              {learningMode ? (
                <Field
                  label={t("学习来源白名单")}
                  hint={t("一行一个主机名，子域自动包含（写 example.com 也涵盖 docs.example.com）。留空使用内置默认的公开文档站点。本机、内网与云元数据地址永远不在允许范围内。")}
                >
                  <textarea
                    className="input textarea"
                    rows={4}
                    value={learningHosts}
                    onChange={(event) => setLearningHosts(event.target.value)}
                    placeholder={"developer.mozilla.org\nnodejs.org"}
                  />
                </Field>
              ) : null}
              <Toggle
                checked={qualityGate}
                onChange={setQualityGate}
                label={t("产出质量闸门")}
                description={t("让探索任务围绕可度量的产出质量展开：由你在下面配置的评估模型按可自动调优的指标给当前产出打分，分数高于现行基线时，在 App 顶部小铃铛和桌面通知里提醒你。它不会自己上线：只有你在铃铛里批准某个候选版本后，才会用固定脚本打包。评估模型不可用时仍记录客观指标，只是缺少评审分。")}
              />
              {qualityGate ? (
                <div className="field-grid">
                  <Field
                    label={t("授权后执行的打包命令")}
                    hint={t("只提供白名单脚本，批准候选版本后原样运行、不接受附加参数。选“不自动打包”时，批准只更新质量基线。")}
                  >
                    <SelectMenu
                      value={qualityPublishTarget}
                      options={[
                        { value: 'none', label: t("不自动打包（只更新基线）") },
                        { value: 'package:dir', label: t("打包到目录（package:dir）") },
                        { value: 'package:win', label: 'package:win' },
                        { value: 'package:mac', label: 'package:mac' },
                        { value: 'package:linux', label: 'package:linux' },
                      ]}
                      onChange={(value) =>
                        setQualityPublishTarget(value as QualityPublishTarget)
                      }
                      ariaLabel={t("授权后执行的打包命令")}
                    />
                  </Field>
                  <Field
                    label={t("指标重调频次")}
                    hint={t("每评估多少次重新计算一次指标权重（低分与无样本维度会被重新分配比重）。填 0 关闭自动调优，改为在铃铛里手动重调。")}
                  >
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={50}
                      value={qualityTuneEvery}
                      onChange={(event) => setQualityTuneEvery(event.target.value)}
                    />
                  </Field>
                </div>
              ) : null}
              <Toggle
                checked={screenshotFeedback}
                onChange={setScreenshotFeedback}
                label={t("截图视觉反馈")}
                description={t("智能体截图后，把压缩图片作为观察结果发给模型检查界面。若模型端点拒绝图片输入会自动退回文字；关闭后只保存截图，不发送图片。")}
              />
              <Toggle
                checked={shellMode}
                onChange={setShellMode}
                label={t("Shell 运行模式")}
                description={t("允许智能体执行带管道、重定向和变量的完整 shell 命令。每次调用都必须由你单独批准，即使会话已设为自动允许；shell 可以访问工作区之外的内容，请只对可信命令授权。关闭后，子智能体也不能自己跑白名单校验（run_check），改动会交回主智能体验证。")}
              />
            </div>

            <div className="field-grid">
              <Field
                label={t("Shell 解释器")}
                hint={settings.shellInterpreterDetail || t("Windows 下 run_shell 使用的解释器")}
              >
                <SelectMenu
                  value={shellInterpreter}
                  disabled={!shellMode}
                  options={[
                    { value: 'auto', label: t("自动（优先 Git Bash，其次 WSL，最后 cmd）") },
                    { value: 'bash', label: 'Git Bash' },
                    { value: 'wsl', label: t("WSL 中的 bash") },
                    { value: 'cmd', label: 'cmd.exe' },
                  ]}
                  onChange={(value) => setShellInterpreter(value as ShellInterpreter)}
                  ariaLabel={t("Shell 解释器")}
                  maxListWidth={360}
                />
              </Field>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>{t("测试环境与动态工具")}</h3>
                <p>
                  {t("Pilot 可以为自己编写工具，但只能访问 localhost 或下面登记的测试目标。测试验证码只用于你自己的测试环境：值保存在系统安全存储中，运行时通过环境变量注入，不写进代码或日志。Pilot 不会训练或绕过未授权的验证码。")}</p>
              </div>
            </div>

            <div className="field-grid">
              <Field
                label={t("授权测试目标")}
                hint={t("每行一个 http/https 地址，最多 20 个；localhost 始终允许")}
                wide
              >
                <textarea
                  className="text-input mono settings-textarea"
                  value={testTargets}
                  rows={3}
                  placeholder={'https://test.example.com\nhttp://localhost:3000'}
                  spellCheck={false}
                  onChange={(event) => setTestTargets(event.target.value)}
                />
              </Field>
            </div>

            <div className="field-grid">
              <Field
                label={t("测试验证码方式")}
                hint={t("fixture 注入固定测试码；header 额外给出建议的请求头名")}
              >
                <SelectMenu
                  value={testCaptchaMode}
                  options={[
                    { value: 'off', label: t("关闭") },
                    { value: 'fixture', label: t("固定测试码（fixture）") },
                    { value: 'header', label: t("测试请求头（header）") },
                  ]}
                  onChange={(value) => setTestCaptchaMode(value as TestCaptchaMode)}
                  ariaLabel={t("测试验证码方式")}
                />
              </Field>
              {testCaptchaMode !== 'off' ? (
                <Field
                  label={t("测试验证码固定值")}
                  hint={
                    settings.hasTestCaptcha
                      ? t("已保存；留空保持原值")
                      : t("只填写测试环境接受的固定值")
                  }
                >
                  <div className="settings-inline">
                    <input
                      className="text-input mono"
                      type="password"
                      value={testCaptcha}
                      placeholder={settings.hasTestCaptcha ? '••••••••' : ''}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => {
                        setTestCaptcha(event.target.value)
                        setClearTestCaptcha(false)
                      }}
                    />
                    {settings.hasTestCaptcha || testCaptcha ? (
                      <button
                        type="button"
                        className="button ghost"
                        onClick={() => {
                          setTestCaptcha('')
                          setClearTestCaptcha(true)
                        }}
                      >
                        {t("清除")}
                      </button>
                    ) : null}
                  </div>
                </Field>
              ) : null}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>{t("权限与沙箱")}</h3>
                <p>
                  {t("执行模式 + 显式规则 + OS 沙箱。规则由程序强制执行，按“拒绝 → 询问 → 允许”匹配，拒绝规则和受保护路径在任何模式下都不能被覆盖。")}</p>
              </div>
            </div>

            <div className="permission-rules">
              <Field label={t("允许规则")} hint={t("每行一条，例如 Bash(npm test:*) 或 Edit(src/**)")}>
                <textarea
                  className="text-input mono settings-textarea"
                  value={allowRules}
                  onChange={(event) => setAllowRules(event.target.value)}
                  spellCheck={false}
                  placeholder={'Bash(git status)\nEdit(src/**)'}
                />
              </Field>
              <Field label={t("询问规则")} hint={t("命中后总是人工确认")}>
                <textarea
                  className="text-input mono settings-textarea"
                  value={askRules}
                  onChange={(event) => setAskRules(event.target.value)}
                  spellCheck={false}
                  placeholder={'Bash(git push*)'}
                />
              </Field>
              <Field label={t("拒绝规则")} hint={t("优先级最高，不能被允许规则覆盖")}>
                <textarea
                  className="text-input mono settings-textarea"
                  value={denyRules}
                  onChange={(event) => setDenyRules(event.target.value)}
                  spellCheck={false}
                  placeholder={'Bash(curl * | sh)'}
                />
              </Field>
            </div>

            <Field
              label={t("已记住的命令")}
              hint={t("在审批中选择「始终允许」后，只有完全匹配的命令会自动放行。")}
            >
              {trustedCommands.length === 0 ? (
                <p className="settings-hint">{t("还没有已记住的命令。")}</p>
              ) : (
                <div className="trusted-commands">
                  <pre className="mono trusted-command-list">{trustedCommands.join('\n')}</pre>
                  <button
                    type="button"
                    className="button ghost"
                    disabled={saving}
                    onClick={() => {
                      setSaving(true)
                      setError('')
                      window.pilot
                        .updateSettings({ trustedCommands: [] })
                        .then((view) => {
                          setTrustedCommands(view.trustedCommands)
                          onSaved(view)
                        })
                        .catch((caught: unknown) => {
                          const message =
                            caught instanceof Error ? caught.message : String(caught)
                          setError(message)
                          onError(message)
                        })
                        .finally(() => setSaving(false))
                    }}
                  >
                    {t("全部清除")}
                  </button>
                </div>
              )}
            </Field>

            <div className="field-grid">
              <Field label={t("OS 沙箱")} hint={sandbox?.detail ?? t("正在检测运行环境…")}>
                <SelectMenu
                  value={sandboxMode}
                  options={[
                    { value: 'off', label: t("关闭") },
                    { value: 'auto', label: t("自动（可用时启用）") },
                  ]}
                  onChange={(value) => setSandboxMode(value as SandboxMode)}
                  ariaLabel={t("OS 沙箱")}
                />
              </Field>
              <Field label={t("回退点保留数量")} hint={t("每个会话最多保留多少个文件快照")}>
                <input
                  className="text-input mono"
                  type="number"
                  min={5}
                  max={100}
                  value={checkpointRetention}
                  onChange={(event) => setCheckpointRetention(event.target.value)}
                />
              </Field>
              <Field
                label={t("回退点总空间上限")}
                hint={t("所有会话的快照合计上限（MB）；超过后按时间淘汰最旧的回退点，每个会话至少保留一个")}
              >
                <input
                  className="text-input mono"
                  type="number"
                  min={512}
                  max={20480}
                  step={256}
                  value={checkpointMaxMb}
                  onChange={(event) => setCheckpointMaxMb(event.target.value)}
                />
              </Field>
              <Field
                label={t("快照跳过的路径")}
                hint={t(
                  "每行一条，只影响回退点：这些路径不会被扫描或保存，但仍可在文件树里查看和修改。构建缓存、临时目录、日志等生成物应写在这里。支持 * 通配（如 build-*），带 / 的路径从工作区根算起。tmp、.build、unpackage、logs、checkpoints 等常见生成目录已默认跳过；助手新建的目录若看起来是生成物，也会自动加进来。",
                )}
              >
                <textarea
                  className="text-input mono"
                  rows={4}
                  spellCheck={false}
                  placeholder={'tmp\n.build\ndist-*'}
                  value={checkpointIgnore}
                  onChange={(event) => setCheckpointIgnore(event.target.value)}
                />
              </Field>
            </div>

            <div className={`sandbox-state${sandbox?.available ? ' ok' : ''}`}>
              <i className="key-dot" />
              {sandbox?.available
                ? t("沙箱可用：{v1}", { v1: sandbox.backend })
                : t("沙箱不可用：命令以普通权限运行，未沙箱化的 shell 始终逐次确认")}
            </div>

            <div className={`env-panel${envInfo?.disk?.low ? ' warn' : ''}`}>
              <div className="env-panel-head">
                <strong>{t("运行环境")}</strong>
                <div className="env-panel-actions">
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void copyEnv()}
                    disabled={!envInfo}
                  >
                    {envCopied ? t("已复制") : t("复制环境")}</button>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void copyLogs()}
                    disabled={!logDir}
                    title={logDir}
                  >
                    {logCopied ? t("已复制") : t("复制日志")}</button>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void window.pilot.openLogs().catch(() => undefined)}
                    disabled={!logDir}
                  >
                    {t("打开日志")}</button>
                </div>
              </div>
              {envInfo ? (
                <>
                  <dl className="env-list">
                    {envLines.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {envInfo.disk?.low ? (
                    <p className="env-warn">
                      {t("工作区所在卷剩余空间不足 {v1}，安装依赖或构建可能因 ENOSPC 失败。", {
                        v1: formatBytes(DISK_LOW_BYTES),
                      })}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="env-warn">{t("无法读取运行环境")}</p>
              )}
            </div>

            <div className="toggle-list">
              <Toggle
                checked={sandboxAutoAllow}
                onChange={setSandboxAutoAllow}
                label={t("沙箱内命令自动放行")}
                description={t("命令已经被 OS 沙箱限制时，不再逐次询问。显式询问/拒绝规则仍然优先。")}
              />
              <Toggle
                checked={sandboxNetwork}
                onChange={setSandboxNetwork}
                label={t("允许沙箱内网络")}
                description={t("关闭时使用网络命名空间隔离。打开后无法阻止沙箱内程序外联，安全性会降低；需要联网安装依赖时再打开。")}
              />
              <Toggle
                checked={checkpointShell}
                onChange={setCheckpointShell}
                label={t("Shell 执行前创建回退点")}
                description={t("在每次 run_shell 执行前快照工作区文件，便于回退脚本造成的修改。快照排除 .git、node_modules 等大型目录。")}
              />
              <Toggle
                checked={hooksEnabled}
                onChange={setHooksEnabled}
                label={t("工作区 Hooks")}
                description={t("启用后运行 .pilot/hooks.json 中定义的 pre_tool / post_edit / stop 命令。Hook 使用参数数组执行、不经过 shell，但仍会以你的用户权限运行；只在你信任该工作区时开启。")}
              />
              <Toggle
                checked={mcpEnabled}
                onChange={setMcpEnabled}
                label={t("MCP 服务器")}
                description={t("启用后从 .pilot/mcp.json 启动 stdio MCP 服务器，并把它们的工具提供给智能体。每个 MCP 工具调用仍然逐次审批；只在你信任该配置时开启。")}
              />
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>{t("自我学习")}</h3>
                <p>{t("让 Pilot 从真实运行中提炼经验，并在通过独立评审后更新运行画像。")}</p>
              </div>
            </div>

            <div className="toggle-list">
              <Toggle
                checked={autoReflect}
                onChange={setAutoReflect}
                label={t("自动复盘")}
                description={t("失败、工具报错和负反馈后，结合具体报错自动复盘，把可复用经验写入项目记忆。")}
              />
              <Toggle
                checked={autoEvolve}
                onChange={setAutoEvolve}
                label={t("自动运行系统进化")}
                description={t("按进化机制的节奏自动完成提案、独立评审和启用；失败率明显上升时自动回滚。")}
              />
            </div>

            <div className="field-grid">
              <Field
                label={t("全局指令文件")}
                hint={t("所有工作区都会读取；编辑后新运行生效。项目专属规则仍写在各工作区的 PILOT.md / AGENTS.md。")}
                wide
              >
                <div className="path-row">
                  <input
                    className="text-input mono"
                    value={settings.globalInstructionsPath}
                    readOnly
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void openGlobalInstructions()}
                    disabled={openingGlobal}
                  >
                    {openingGlobal ? <i className="spinner" /> : null}
                    {t("打开")}</button>
                </div>
              </Field>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>{t("外观")}</h3>
                <p>{t("暗色与浅色两套主题，只有一处主题色标记选中、焦点和进度，长时间使用也不刺眼。")}</p>
              </div>
            </div>
            <div className="appearance-block">
              <span className="field-label">{t("主题模式")}</span>
              <div className="appearance-modes" role="group" aria-label={t("主题模式")}>
                <button
                  type="button"
                  className={`appearance-mode${theme === 'dark' ? ' is-on' : ''}`}
                  onClick={() => setTheme('dark')}
                  aria-pressed={theme === 'dark'}
                >
                  {t("深色")}
                </button>
                <button
                  type="button"
                  className={`appearance-mode${theme === 'light' ? ' is-on' : ''}`}
                  onClick={() => setTheme('light')}
                  aria-pressed={theme === 'light'}
                >
                  {t("浅色")}
                </button>
              </div>
            </div>
            <div className="appearance-block">
              <span className="field-label">{t("对比度")}</span>
              <div className="appearance-modes" role="group" aria-label={t("对比度")}>
                {CONTRAST_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`appearance-mode${contrast === option.value ? ' is-on' : ''}`}
                    onClick={() => setContrast(option.value)}
                    aria-pressed={contrast === option.value}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="settings-hint">
                {t("调整文字与页面底色的分离程度；低档更柔和，高档更鲜明，主题色保持不变。")}
              </p>
            </div>
            <div className="appearance-block">
              <span className="field-label">{t("饱和度")}</span>
              <div className="appearance-modes" role="group" aria-label={t("饱和度")}>
                {SATURATION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`appearance-mode${saturation === option.value ? ' is-on' : ''}`}
                    onClick={() => setSaturation(option.value)}
                    aria-pressed={saturation === option.value}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="settings-hint">
                {t("调整主题色与功能色的鲜艳程度；两套主题都按灰阶推算，高档更鲜明。")}
              </p>
            </div>
            <div className="appearance-block">
              <span className="field-label">{t("字号")}</span>
              <div className="appearance-modes" role="group" aria-label={t("字号")}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`appearance-mode${fontSize === option.value ? ' is-on' : ''}`}
                    onClick={() => setFontSize(option.value)}
                    aria-pressed={fontSize === option.value}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="settings-hint">
                {t("只放大文字，按钮和间距保持不变；标准就是原来的字号。")}
              </p>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>{t("语言")}</h3>
                <p>{t("界面语言。默认跟随系统；智能体始终使用你提问的语言回复。")}</p>
              </div>
            </div>
            <div className="field-grid">
              <Field
                label={t("界面语言")}
                hint={t("系统语言：{locale}", { locale: settings.systemLocale || '—' })}
              >
                <SelectMenu
                  value={locale}
                  options={[
                    {
                      value: 'auto',
                      label: `${t("跟随系统")} · ${settings.systemLocale || 'Auto'}`,
                    },
                    { value: 'zh-CN', label: t("简体中文") },
                    { value: 'en', label: 'English' },
                  ]}
                  onChange={(value) => setLocale(value as LocaleSetting)}
                  ariaLabel={t("界面语言")}
                />
              </Field>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <div>
                <h3>{t("通知")}</h3>
                <p>{t("任务完成、运行失败或等待审批时提醒你；版本与更新入口在左下角。")}</p>
              </div>
            </div>
            <div className="toggle-list">
              <Toggle
                checked={notifyDesktop}
                onChange={setNotifyDesktop}
                label={t("桌面通知")}
                description={t("Pilot 不在前台时，任务完成、运行失败或等待审批会发一条系统通知。点击通知可回到对应会话。")}
              />
            </div>
          </section>

          {error ? (
            <div className="settings-error">
              <InfoIcon width={14} height={14} />
              {error}
            </div>
          ) : null}
        </div>

        <div className="modal-footer">
          <span className="settings-note">{t("Key 由 Electron safeStorage 加密后保存在 userData。")}</span>
          <div className="modal-actions">
            <button type="button" className="button ghost" onClick={onClose}>
              {t("取消")}</button>
            <button
              type="button"
              className="button primary"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? <i className="spinner" /> : null}
              {t("保存设置")}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
