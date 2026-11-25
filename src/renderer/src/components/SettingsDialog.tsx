import { useEffect, useRef, useState } from 'react'
import type {
  ApprovalMode,
  CompanionStatus,
  QualityPublishTarget,
  SandboxMode,
  SandboxStatus,
  SettingsUpdate,
  ShellInterpreter,
  SettingsView,
  SystemInfo,
  TestCaptchaMode,
} from '../../../shared/types'
import { DISK_LOW_BYTES, formatBytes } from '../../../shared/system-info'
import { formatLogRecords } from '../../../shared/app-log-view'
import { autonomyBlockers as autonomyBlockersFor } from '../../../shared/autonomy'
import { modelLimits, SETTING_CONTEXT_MAX, SETTING_OUTPUT_MAX } from '../../../shared/modelLimits'
import {
  DEFAULT_SERVER_PORT,
  MAX_SERVER_PORT,
  MIN_SERVER_PORT,
  normalizeServerPort,
} from '../../../shared/server-mode'
import { InfoIcon, SparkIcon, XIcon } from '../icons'
import { copyText } from '../clipboard'
import { t } from '../i18n'
import { EvolutionHub, type EvolutionTab } from './EvolutionHub'
import { Field, Toggle } from './form-fields'
import { HookRulesPanel } from './HookRulesPanel'
import {
  MailNotifySettings,
  mailSettingsDraftFrom,
  notifyToggleForSave,
  type MailSettingsDraft,
} from './MailNotifySettings'
import { HARD_CEILING_MAX } from '../../../shared/step-budget'
import { RuntimeLogPanel } from './RuntimeLogPanel'
import { SuperPilotSettings } from './SuperPilotSettings'
import { SelectMenu } from './SelectMenu'
import { STEP_LIMIT_MIN, StepLimitField } from './step-limit-field'
import { useEscapeClose } from './useEscapeClose'

/** 授权记录要带日期：只给时分的话，跨天之后就分不清哪条是今天的。 */
function grantedAtLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Left-hand index of the settings sheet.
 *
 * The dialog had grown into one long column where model endpoints, sandbox rules
 * and appearance all looked alike; the index turns it into a few named groups
 * you can jump to, and the active group follows the scroll position.
 */
type SettingsSectionId =
  | 'runtime'
  | 'testing'
  | 'sandbox'
  | 'evolution'
  | 'server'
  | 'notify'
  | 'logs'
  | 'super'

/**
 * 进化是唯一入口：复盘评估、自动复盘、自动进化、探索学习与质量闸门
 * 都是它下面的页签，所以索引里不再单列「自我学习」。
 */
const SETTING_SECTIONS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: 'runtime', label: t("运行参数") },
  { id: 'testing', label: t("测试与工具") },
  { id: 'sandbox', label: t("权限与沙箱") },
  { id: 'evolution', label: t("进化") },
  { id: 'server', label: t("网页服务") },
  { id: 'notify', label: t("通知") },
  { id: 'logs', label: t("运行日志") },
  { id: 'super', label: t("超级 Pilot") },
]

/** 设置里的「进化」分节由 App 注入：它要拿运行状态和十几个回调，透传会撑大这个签名。 */
export interface SettingsEvolutionHelpers {
  /** 进化面板里跳到通知配置：这里不关弹窗，直接切分节。 */
  openNotify: () => void
}

/** 复盘页签里的历史列表：只带列表要显示的两项，不引整个 SessionSummary。 */
export interface ReviewSessionEntry {
  id: string
  title: string
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

/**
 * Which section the settings dialog should reveal on open.
 *
 * 'notify' 是反思页把邮箱与通知搬到设置后留在原地的入口：点过去要直接落在「通知」分组上。
 */
export type SettingsFocus = 'notify' | null

export function SettingsDialog({
  settings,
  workspacePath,
  onClose,
  onSaved,
  onError,
  onWarn,
  focusSection = null,
  evolutionTabs,
  onOpenReview,
  reviewSessions,
  onOpenReviewSession,
  onOpenSession,
}: {
  settings: SettingsView
  /** Active workspace; only decides which volume the environment panel measures. */
  workspacePath?: string | null
  onClose: () => void
  onSaved: (view: SettingsView) => void
  onError: (message: string) => void
  /** 不阻断保存、但需要让用户知道的降级（目前只有「邮件通知本次未启用」）。 */
  onWarn?: (message: string) => void
  focusSection?: SettingsFocus
  /**
   * 「进化」的核心页签（自我进化 / 自主优化 / 模块自检 / 内视 / 反思）。
   *
   * 进化需要当前工作区、会话回调与一大批运行函数，把它们全部加成这个弹窗的 props 只会
   * 让签名跟着 App 一起膨胀；改成由 App 传一个页签工厂，弹窗负责拼上自己的两个页签
   * （复盘评估、自动与学习）并统一渲染。
   */
  evolutionTabs?: (helpers: SettingsEvolutionHelpers) => EvolutionTab[]
  /** 复盘页签的「新建」：先关掉设置弹窗，再开复盘对话框。 */
  onOpenReview: () => void
  /** 复盘页签的历史列表。 */
  reviewSessions: ReviewSessionEntry[]
  onOpenReviewSession: (sessionId: string) => void
  /** 运行日志里点「查看卡点」：先关设置，再切到那个会话。 */
  onOpenSession?: (sessionId: string) => void
}) {
  const [maxSteps, setMaxSteps] = useState(String(settings.maxSteps))
  const [maxTokens, setMaxTokens] = useState(String(settings.maxTokens))
  const [maxContextTokens, setMaxContextTokens] = useState(String(settings.maxContextTokens))
  useEscapeClose(onClose)
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(settings.maxOutputTokens))
  const [temperature, setTemperature] = useState(String(settings.temperature))
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
  const [fullAutonomy, setFullAutonomy] = useState(settings.fullAutonomy)
  // 设置页只能看到默认审批模式：会话级模式由用户随时切换，所以这里只能给出
  // 「按当前设置会/不会生效」的预判，真正生效仍由运行时的 autonomyPolicy 判定。
  const autonomyBlockers = fullAutonomy
    ? autonomyBlockersFor({
        fullAutonomy,
        approvalMode: defaultApprovalMode,
        maxTokens: Number(maxTokens) || 0,
        maxSteps: Number(maxSteps) || 0,
      })
    : []
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
  // 邮箱与通知配置的草稿：和整张设置表一起提交，所以放在这里而不是子组件里。
  const [mail, setMail] = useState<MailSettingsDraft>(() => mailSettingsDraftFrom(settings))
  const [serverMode, setServerMode] = useState(settings.serverMode)
  /** 端口用字符串保存：输入框会经过「空」「80」这些中间态，保存时再收敛。 */
  const [serverPort, setServerPort] = useState(String(settings.serverPort))
  /** 当前监听状态：开完关后地址与报错只能从主进程拿。 */
  const [companion, setCompanion] = useState<CompanionStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('runtime')
  /** One ref per group; a deep link can scroll to the group it names. */
  const sectionRefs = useRef<Partial<Record<SettingsSectionId, HTMLElement | null>>>({})

  // The reflection page links here for the mailbox and notification block.
  useEffect(() => {
    if (focusSection === 'notify') setActiveSection('notify')
  }, [focusSection])

  // Switching a group shows only that group, so the panel is never a long
  // column of unrelated cards; the new group starts at its own top.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [activeSection])

  // 网页服务段需要「现在真的在哪个端口上」：设置里的数字是意图，监听端口是事实，
  // 两者不一致（端口被占、还没启动）时只展示设置里的值会误导人。
  useEffect(() => {
    if (activeSection !== 'server') return
    let cancelled = false
    void window.pilot
      .companionStatus()
      .then((status) => {
        if (!cancelled) setCompanion(status)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeSection])

  const jumpTo = (id: SettingsSectionId) => setActiveSection(id)

  /**
   * 网页服务分节要回答「谁拿到了这台电脑的访问权」：来源地址、授权时间、角色。
   * 只列浏览器记录，手机（`via: 'phone'`）由手机连接那套面板管理。
   */
  const webSessions = (companion?.phones ?? []).filter(
    (phone) => phone.via === 'browser' || phone.platform === 'browser',
  )
  const revokeWeb = (phoneId: string) => {
    void window.pilot
      .revokeCompanion(phoneId)
      .then((status) => setCompanion(status))
      .catch(() => undefined)
  }

  // 新加的资源卡片插在列表最上面：把它滚到视野内并把光标放进名称输入框，
  // 用户不用再滑到列表末尾去找那张空白卡片。

  // Preview the appearance while the dialog is open. Cancel restores the saved
  // values; saving updates `settings` and the parent effect takes over.

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



  /**
   * 反思表单已搬到「进化 → 反思」页签（ReflectionPanel），这里不再持有它的状态：
   * 反思需要“立即跑一轮 / 发测试邮件 / 清空历史”这些即时动作，和弹窗“整份表单一起保存”的节奏不同。
   */
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
    // 端口不合法时不静默回退：用户填了端口就期望是那个端口，默默换一个
    // 会让他在浏览器里打开一个空页。
    //
    // 只在网页服务打开时校验：开关关着时端口那一栏是禁用的，用户可能是先填了
    // 一个值再关掉开关；这时为一个不生效的字段挡住整张设置表，改语言也保存不了。
    const port = Number(serverPort)
    if (
      serverMode &&
      (!Number.isInteger(port) || port < MIN_SERVER_PORT || port > MAX_SERVER_PORT)
    ) {
      setError(
        t("端口需要是 {v1} 到 {v2} 之间的整数。", {
          v1: MIN_SERVER_PORT.toLocaleString(),
          v2: MAX_SERVER_PORT.toLocaleString(),
        }),
      )
      return
    }

    // 0 是「不限」，上限与循环里真正的硬天花板同源：以前这里卡 1,000，而
    // `shared/step-budget.ts` 实际允许延展到 4,000，两边数字不一致时用户填的值
    // 会被静默改掉。
    if (!Number.isFinite(steps) || steps < STEP_LIMIT_MIN || steps > HARD_CEILING_MAX) {
      setError(
        t("最大步数需要在 {v1} 到 {v2} 之间（0 = 不限）。", {
          v1: STEP_LIMIT_MIN.toLocaleString(),
          v2: HARD_CEILING_MAX.toLocaleString(),
        }),
      )
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
    // 邮件缺项只影响「发信」这一件事，不能把整张设置表一起挡下：以前这里直接
    // return，于是「邮件通知开着但收件地址没填」会让 serverMode 根本没提交，
    // 表现成「没绑邮箱就开不了网页服务」。现在降级为本次不启用邮件通知，其余
    // 字段照常保存，保存后再把原因提示出来。
    const mailPlan = notifyToggleForSave(mail)
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
      sandboxMode,
      sandboxNetwork,
      sandboxAutoAllow,
      fullAutonomy,
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
      notifyEmailEnabled: mailPlan.enabled,
      notifyEmailEvents: mail.notifyEmailEvents,
      // 输入框被删空 = 用户要清掉这个邮箱：发 null 才算清除。发空串会被后端
      // 当成「保持原值」，那次改动就静默丢了。
      reflectEmailTo: mail.reflectEmailTo.trim() || null,
      reflectSmtpHost: mail.reflectSmtpHost.trim() || null,
      reflectSmtpPort: Number.isFinite(Number(mail.reflectSmtpPort))
        ? Math.round(Number(mail.reflectSmtpPort))
        : settings.reflectSmtpPort,
      reflectSmtpSecurity: mail.reflectSmtpSecurity,
      ...(mail.clearReflectPassword
        ? { reflectSmtpPassword: null }
        : mail.reflectSmtpPassword.trim()
          ? { reflectSmtpPassword: mail.reflectSmtpPassword.trim() }
          : {}),
      serverMode,
      serverPort: normalizeServerPort(port, DEFAULT_SERVER_PORT),
    }

    setSaving(true)
    try {
      const view = await window.pilot.updateSettings(input)
      onSaved(view)
      if (mailPlan.warning) onWarn?.(mailPlan.warning)
      onClose()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setSaving(false)
    }
  }

  /**
   * 复盘评估页签：入口从左侧栏搬到这里，历史会话点开即进入对应会话。
   * 复盘只注册读取工具，所以这里只提供「新建」和「打开」两件事。
   */
  const reviewTab = (
    <div className="evolution-tab-body">
      <p className="settings-hint">
        {t("复盘会话只注册读取工具：它读你选定范围内的会话记录、运行记录和代码，给出一份带分值的报告。结论只保存为记忆参考和未激活的进化草稿，不会自行改动行为；需要改代码时，再用“交接修复”新建普通会话。")}
      </p>
      <div className="evolution-tab-actions">
        <button type="button" className="button primary" onClick={onOpenReview}>
          <SparkIcon width={15} height={15} />
          {t("新建复盘评估")}</button>
      </div>

      <h4 className="evolution-tab-title">{t("最近的复盘会话")}</h4>
      {reviewSessions.length > 0 ? (
        <ul className="evolution-review-list">
          {reviewSessions.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="evolution-review-item"
                onClick={() => onOpenReviewSession(entry.id)}
              >
                {entry.title || t("未命名复盘")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-hint">{t("还没有复盘会话。新建一次后会出现在这里。")}</p>
      )}
    </div>
  )

  /**
   * 自动与学习页签：开关本身和整张设置表一起提交，所以内容仍写在这里，
   * 只是从「运行参数」和「自我学习」两处搬到同一个页签里。
   */
  const learningTab = (
    <div className="evolution-tab-body">
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
            description={t("让探索任务围绕可度量的产出质量展开：由你在下面配置的评估模型按可自动调优的指标给当前产出打分，分数高于现行基线时，顶栏三个点菜单里的产出质量项会亮角标，并发一条桌面通知。它不会自己上线：只有你在产出质量面板里批准某个候选版本后，才会用固定脚本打包。评估模型不可用时仍记录客观指标，只是缺少评审分。")}
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
                hint={t("每评估多少次重新计算一次指标权重（低分与无样本维度会被重新分配比重）。填 0 关闭自动调优，改为在产出质量面板里手动重调。")}
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
      </div>
    </div>
  )

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

        <div className="modal-body settings-body">
          <nav className="settings-nav" aria-label={t("设置分组")}>
            {SETTING_SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`settings-nav-item${activeSection === entry.id ? ' is-active' : ''}`}
                onClick={() => jumpTo(entry.id)}
                aria-current={activeSection === entry.id}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <div className="settings-main" ref={bodyRef}>
          <section
            className="settings-section"
            hidden={activeSection !== 'runtime'}
            ref={(element) => {
              sectionRefs.current.runtime = element
            }}
          >
            <div className="settings-section-head">
              <div>
                <h3>{t("运行参数")}</h3>
                <p>
                  {t("默认值适合大多数任务；增大上下文会消耗更多 tokens。当前模型")}{' '}
                  <code>{settings.model || t("未知")}</code> {t("的窗口为")}{' '}
                  {modelLimits(settings.model).contextTokens.toLocaleString()}{' '}
                  {t("tokens，超出部分会被自动收敛。")}</p>
              </div>
            </div>

            <div className="field-grid three">
              <StepLimitField value={maxSteps} onChange={setMaxSteps} />
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

          <section
            className="settings-section"
            hidden={activeSection !== 'testing'}
            ref={(element) => {
              sectionRefs.current.testing = element
            }}
          >
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

            <HookRulesPanel workspacePath={workspacePath ?? ''} />
          </section>

          <section
            className="settings-section"
            hidden={activeSection !== 'sandbox'}
            ref={(element) => {
              sectionRefs.current.sandbox = element
            }}
          >
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
                checked={fullAutonomy}
                onChange={setFullAutonomy}
                label={t("完全自主（放开全部限制）")}
                description={t(
                  "开启后不再逐次询问：可访问任意网络，可在工作区外读取任意资源、数据与日志，并可在工作区外的目录执行命令与长驻进程，可修改 Pilot 自身源码与 .pilot 配置（写入仍限于工作区和自身源码目录），可在无人值守时构建，并自动获得内视与自检权限。只在本会话为「全部自动」且 token 与步数上限都达标时生效；凭据、密钥、浏览器会话等隐私路径仍永远拒绝，每次越界都会写审计日志。",
                )}
              />
              {fullAutonomy && autonomyBlockers.length > 0 ? (
                <p className="settings-hint">
                  {t("完全自主暂未生效：{v1}。补齐后自动生效，无需重新开启。", {
                    v1: autonomyBlockers
                      .map((blocker) =>
                        blocker === 'manual-mode'
                          ? t("默认审批模式不是「全部自动」")
                          : blocker === 'token-budget'
                            ? t("token 总量上限低于 100000")
                            : t("步数上限低于 20 且不是「不限」"),
                      )
                      .join(t("；")),
                  })}
                </p>
              ) : null}
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


          <section
            className="settings-section settings-section-evolution"
            hidden={activeSection !== 'evolution'}
            ref={(element) => {
              sectionRefs.current.evolution = element
            }}
          >
            {/*
              进化面板自带页签与打分卡，外层不再包一层 settings-section-head：
              它自己的标题比这里的 h3 更具体。

              复盘评估与自动/学习开关也在这里：进化是全产品唯一入口，
              侧栏不再单独放复盘按钮，运行参数里也不再散落探索学习与质量闸门。
            */}
            {evolutionTabs ? (
              <EvolutionHub
                tabs={[
                  ...evolutionTabs({ openNotify: () => setActiveSection('notify') }),
                  {
                    id: 'review',
                    label: t("复盘评估"),
                    hint: t("只读审查会话与代码，产出带分值的报告"),
                    content: reviewTab,
                  },
                  {
                    id: 'learning',
                    label: t("自动与学习"),
                    hint: t("自动复盘、自动进化、探索学习与质量闸门"),
                    content: learningTab,
                  },
                ]}
              />
            ) : null}
          </section>

          <section
            className="settings-section"
            hidden={activeSection !== 'server'}
            ref={(element) => {
              sectionRefs.current.server = element
            }}
          >
            <div className="settings-section-head">
              <div>
                <h3>{t("网页服务")}</h3>
                <p>
                  {t("打开后，浏览器访问下面这个端口看到的就是当前窗口这套界面（会话、知识库、设置都一样），操作与 `pilot serve` 启动的网页服务完全相同。服务只在本机与局域网内监听；关掉开关即停止。")}
                </p>
              </div>
            </div>
            <div className="toggle-list">
              <Toggle
                checked={serverMode}
                onChange={setServerMode}
                label={t("开启网页服务")}
                description={t("任一应用内的电脑都能用浏览器打开。若不打开这个开关，浏览器访问只能看到手机配对面板。")}
              />
            </div>
            <div className="field-grid">
              <Field
                label={t("端口")}
                hint={t("{v1} – {v2}，默认 {v3}", {
                  v1: MIN_SERVER_PORT.toLocaleString(),
                  v2: MAX_SERVER_PORT.toLocaleString(),
                  v3: DEFAULT_SERVER_PORT.toLocaleString(),
                })}
              >
                <input
                  className="text-input mono"
                  value={serverPort}
                  inputMode="numeric"
                  disabled={!serverMode}
                  onChange={(event) => setServerPort(event.target.value.replace(/[^0-9]/g, ''))}
                  placeholder={String(DEFAULT_SERVER_PORT)}
                  spellCheck={false}
                />
              </Field>
              <Field
                label={t("访问地址")}
                hint={
                  companion?.running
                    ? t("保存后如果端口变了，旧地址会失效。")
                    : t("保存设置后开始监听。")
                }
              >
                <div className="path-row">
                  <input
                    className="text-input mono"
                    value={companion?.address ?? `http://127.0.0.1:${serverPort}`}
                    readOnly
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="button ghost small"
                    disabled={!companion?.address}
                    onClick={() => {
                      if (companion?.address) void copyText(companion.address)
                    }}
                  >
                    {t("复制")}</button>
                </div>
              </Field>
            </div>
            {companion?.error ? (
              <div className="settings-error">
                <InfoIcon width={14} height={14} />
                {companion.error}
              </div>
            ) : null}
            <div className="settings-subhead">
              <strong>{t("已授权的网页")}</strong>
              <span>
                {t("浏览器每次申请并被允许访问都会留一条记录；关掉上面的开关会全部撤销，刷新页面需要重新申请。")}
              </span>
            </div>
            {webSessions.length ? (
              <div className="web-grant-list">
                {webSessions.map((session) => (
                  <div className="web-grant" key={session.phoneId}>
                    <div className="web-grant-main">
                      <strong className="mono">{session.address ?? t("未知地址")}</strong>
                      <span>
                        {session.role === 'client' ? t("客户机") : t("主机")}
                        {' · '}
                        {t("授权时间 {v1}", { v1: grantedAtLabel(session.pairedAt) })}
                        {session.lastSeen
                          ? ` · ${t("最后活动 {v1}", { v1: grantedAtLabel(session.lastSeen) })}`
                          : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button ghost small"
                      onClick={() => revokeWeb(session.phoneId)}
                    >
                      {t("撤销")}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="settings-hint">{t("还没有网页授权记录。")}</p>
            )}
          </section>

          <section
            className={`settings-section${focusSection === 'notify' ? ' settings-section-focus' : ''}`}
            hidden={activeSection !== 'notify'}
            ref={(element) => {
              sectionRefs.current.notify = element
            }}
          >
            <div className="settings-section-head">
              <div>
                <h3>{t("通知")}</h3>
                <p>{t("任务完成、运行失败或等待审批时提醒你；桌面通知与邮件通知都在这里。")}</p>
              </div>
            </div>

            <div className="settings-subhead">
              <strong>{t("桌面通知")}</strong>
              <span>{t("Pilot 在前台时也会显示；点击通知可回到对应会话。")}</span>
            </div>
            <div className="toggle-list">
              <Toggle
                checked={notifyDesktop}
                onChange={setNotifyDesktop}
                label={t("桌面通知")}
                description={t("Pilot 不在前台时，任务完成、运行失败或等待审批会发一条系统通知。点击通知可回到对应会话。")}
              />
            </div>

            <MailNotifySettings
              draft={mail}
              onChange={(patch) => setMail((current) => ({ ...current, ...patch }))}
              hasSmtpPassword={settings.hasSmtpPassword}
            />
          </section>

          <section
            className="settings-section"
            hidden={activeSection !== 'logs'}
            ref={(element) => {
              sectionRefs.current.logs = element
            }}
          >
            <RuntimeLogPanel
              onOpenSession={(sessionId) => {
                onClose()
                onOpenSession?.(sessionId)
              }}
            />
          </section>

          <section
            className="settings-section"
            hidden={activeSection !== 'super'}
            ref={(element) => {
              sectionRefs.current.super = element
            }}
          >
            <SuperPilotSettings />
          </section>

          {error ? (
            <div className="settings-error">
              <InfoIcon width={14} height={14} />
              {error}
            </div>
          ) : null}
          </div>
        </div>

        <div className="modal-footer">
          <span className="settings-note">{t("模型密钥与偏好见左下角「模型」「偏好」。")}</span>
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
