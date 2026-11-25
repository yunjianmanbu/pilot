/**
 * 持久化 schema 与入参清洗：把磁盘上读回来的未知 JSON 收敛成受信任的内部结构。
 *
 * 这里只有纯函数——不读文件、不碰 Electron，因此可以单独测、也可以被 IPC 层
 * 直接复用。真正的读写与索引维护留在 store.ts 的 Store 类里。
 *
 * 由 store.ts 拆分而来，改动请保持「只做数据定形，不做 IO」。
 */
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeCheckpointIgnore } from '../shared/checkpoint-ignore'
import { MODEL_TAG_MAX_LENGTH, modelTagLength, normalizeModelTag } from '../shared/model-label'
import { isLocaleSetting, LocaleSetting } from '../shared/i18n'
import { isFontSizePreference, isThemeMode } from '../shared/theme'
import type { ApprovalMode, EvolutionCycle, EvolutionPolicy, EvolutionPolicyVersion, EvolutionStage, JudgeProviderInput, MemoryCategory, MemoryEntry, ModelResourceInput, PermissionRules, Plan, ProfileEvidence, ProfileExplanation, ProfileReview, ProfileVersion, QualityPublishTarget, QualityState, QuickCommand, ReviewEvidenceRef, ReviewFinding, ReviewReport, ReviewScope, ReviewScores, ReviewSessionScope, RunRecord, SandboxMode, ScheduleKind, ScheduledRunEntry, ScheduledTask, SelfSourceMode, Session, SessionKind, ShellInterpreter, StoredMessage, TestCaptchaMode, ThemeMode, FontSizePreference } from '../shared/types'
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_OUTPUT_TOKENS, SETTING_CONTEXT_MAX, SETTING_CONTEXT_MIN, SETTING_OUTPUT_MAX, SETTING_OUTPUT_MIN } from '../shared/modelLimits'
import { normalizeRelayUrl } from '../shared/relay'
import {
  DEFAULT_NOTIFY_EMAIL_EVENTS,
  normalizeNotifyEmailEvents,
  type NotifyEventId,
} from '../shared/notify-events'
import { DEFAULT_SERVER_PORT, normalizeServerPort } from '../shared/server-mode'
import { normalizeConfiguredSteps } from '../shared/step-budget'
import { DEFAULT_EVOLUTION_POLICY, normalizeEvolutionPolicy } from '../shared/evolution'
import { emptyQualityState, normalizeQualityPublishTarget, sanitizeQualityState } from '../shared/quality'
import {
  DEFAULT_REFLECTION_TOPICS,
  MAX_REFLECTION_REPORTS,
  REFLECTION_DAILY_DEFAULT,
  REFLECTION_INTERVAL_DEFAULT_MINUTES,
  clampReflectionInterval,
  normalizeReflectionScheduleMode,
  normalizeReflectionTime,
  normalizeReflectionTopics,
  normalizeReflectionTriggers,
  sanitizeReflectionReport,
  type ReflectionReport,
  type ReflectionScheduleMode,
  type ReflectionTopicId,
  type ReflectionTriggers,
} from '../shared/reflect'
import { clampSmtpPort, normalizeSmtpSecurity } from './reflect/mail'
import { isMemoryCategory, MEMORY_STORE_LIMIT } from '../shared/memory'
import { normalizeSelfSourceSettings } from './self-source-git'
import { sanitizeProfileComparison } from './agent/profile-benchmark'
import { sanitizeJudgeUsage } from './agent/judge-runtime'
import { settlePlan } from './agent/plan'
import { PLAN_ITEM_LIMIT } from '../shared/plan-limits'
import { pruneProfiles } from '../core/profile-archive'
export interface JudgeTarget {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKey: string
}

export interface PersistedJudgeProvider {
  id: string
  label: string
  baseUrl: string
  model: string
  enabled: boolean
  keyCipher: string | null
  keyPlain: boolean
}

/**
 * One encrypted endpoint. Judge providers keep their own copies only as a
 * legacy mirror written for older builds; this list is the source of truth.
 */
export interface PersistedModelResource {
  id: string
  label: string
  baseUrl: string
  model: string
  /** 四字以内的短标签（「个人」「公司A」），只用于辨识模型，不参与路由。 */
  tag: string
  enabled: boolean
  keyCipher: string | null
  keyPlain: boolean
}

export interface PersistedSettings {
  baseUrl: string
  model: string
  maxSteps: number
  maxContextTokens: number
  /**
   * Hard cap on the tokens one run may consume in total. `0` disables it, which
   * is the default: a budget that is too low silently truncates a task that was
   * otherwise going to finish.
   */
  maxTokens: number
  maxOutputTokens: number
  temperature: number
  autoReflect: boolean
  autoEvolve: boolean
  autoContinue: boolean
  autoContinueLimit: number
  screenshotFeedback: boolean
  /** 允许动态工具访问的测试目标（http/https 源或前缀）。 */
  testTargets: string[]
  testCaptchaMode: TestCaptchaMode
  testCaptchaCipher: string | null
  testCaptchaPlain: boolean
  approvalTimeoutSec: number
  shellMode: boolean
  shellInterpreter: ShellInterpreter
  defaultApprovalMode: ApprovalMode
  permissionRules: PermissionRules
  /** Exact shell command lines the user approved with “always allow”. */
  trustedCommands: string[]
  classifierModel: string
  /** Legacy model-name override for review sessions; new stores use reviewModelId. */
  reviewModel: string
  /** Unified model endpoints; every role selects one of these. */
  modelResources: PersistedModelResource[]
  /** Resource used by ordinary sessions. */
  sessionModelId: string
  /** Ordered evaluation panel (first evaluator, second evaluator, …). */
  evaluationModelIds: string[]
  /** Resource used by review sessions; empty follows the session resource. */
  reviewModelId: string
  /** Legacy mirror of evaluation resources for older builds. */
  judgeProviders: PersistedJudgeProvider[]
  sandboxMode: SandboxMode
  sandboxNetwork: boolean
  sandboxAutoAllow: boolean
  /** 全部自动模式下允许无人值守构建个人实验版。 */
  allowUnattendedBuild: boolean
  /**
   * 完全自主档：放开网络、自身源码/配置、自身全部功能与资源/日志读取。
   * 只在全部自动模式且 token/步数上限满足下限时生效；隐私路径始终拒绝。
   */
  fullAutonomy: boolean
  /**
   * 自主探索学习：允许智能体从白名单公开站点只读搜集资料并自选任务。
   * 默认关；开启后仍只允许 GET/HEAD，产物只留在工作区。
   */
  learningMode: boolean
  /** 学习来源主机白名单（裸主机名，子域自动包含）；空表示用内置默认。 */
  learningHosts: string[]
  /**
   * 学习探索期间让 shell 沙箱断网。默认关：任务会话联网只由 `sandboxNetwork` 决定，
   * 学习模式的白名单只约束 learning_research。
   */
  learningShellIsolation: boolean
  /**
   * 服务器模式：让浏览器打开本机端口时得到与桌面客户端一致的网页界面，
   * 与 `pilot serve` 是同一套服务。默认关；关闭时浏览器拿到的仍是手机面板。
   */
  serverMode: boolean
  /** 服务器模式的监听端口；宿主解析为 1024–65535 之外的取值时回落到默认端口。 */
  serverPort: number
  /** 进化闭环的基线来源：`builtin` 取官方 git，`custom` 用用户自己的源码目录。 */
  selfSourceMode: SelfSourceMode
  selfSourceGitUrl: string
  selfSourceGitRef: string
  selfSourceGitPath: string
  selfSourceCustomPath: string
  /** 产出质量闸门：评估模型打分 + 指标动态调优 + 授权后发布；默认关。 */
  qualityGate: boolean
  /** 授权后执行的打包命令，只接受白名单值。 */
  qualityPublishTarget: QualityPublishTarget
  /** 每评估几次重调指标权重；0 关闭自动调优。 */
  qualityTuneEvery: number
  checkpointRetention: number
  /** Total disk budget for all checkpoint snapshots (blob store + legacy copies). */
  checkpointMaxBytes: number
  checkpointShell: boolean
  /** Paths a snapshot skips beyond the built-in list (snapshot-only). */
  checkpointIgnore: string[]
  notifyDesktop: boolean
  /**
   * 反思：让 Pilot 定期/在失败后对自身常规问题自问。
   * 触发方式、模型、问题域与邮件收件人都在这里持久化。
   */
  reflectEnabled: boolean
  /** 反思用的模型资源 id；空串表示跟随会话模型。 */
  reflectModelId: string
  reflectTriggers: ReflectionTriggers
  /** 自动触发粒度：版本变化 / 间隔 / 每天固定时刻。 */
  reflectScheduleMode: ReflectionScheduleMode
  /** 用户是否亲眼选过粒度；手选过后默认值迁移不再动它。 */
  reflectScheduleModePinned: boolean
  reflectIntervalMinutes: number
  reflectDailyTime: string
  reflectTopics: ReflectionTopicId[]
  /** 上一次成功反思完成的时间（ISO），用于定时判定。 */
  reflectLastRunAt: string
  /** 上一次成功反思对应的应用版本；`version` 模式据此判断是否到点。 */
  reflectLastVersion: string
  /** 邮件收件开关；等价于邮件通知里勾选了「反思报告」。 */
  reflectEmailEnabled: boolean
  /**
   * 邮件通知总开关：关掉后任何事件都不发信（邮箱连接配置保留）。
   * 与 `notifyEmailEvents` 一起是「通知配置」，SMTP 主机/端口/授权码是「邮箱配置」。
   */
  notifyEmailEnabled: boolean
  /** 打开邮件通知的事件清单，按推荐优先级排序。 */
  notifyEmailEvents: NotifyEventId[]
  /**
   * 反思邮件唯一的邮箱地址：既是收件人，也是 SMTP 登录名与发件人。
   * 逗号分隔多个地址时只有第一个参与登录与发信，其余只当收件人。
   * 空串表示用户还没配置，出厂不预置任何地址。
   */
  reflectEmailTo: string
  reflectSmtpHost: string
  reflectSmtpPort: number
  reflectSmtpSecurity: 'tls' | 'starttls' | 'none'
  reflectSmtpPasswordCipher: string | null
  reflectSmtpPasswordPlain: boolean
  /**
   * 邮箱救援只做一次：旧版把出厂预置地址当成「未配置」清空时，授权码还留着，
   * 于是「有授权码但邮箱与主机都空」就是被清掉的证据。还原一次后置为 true，
   * 之后即使两个字段再次为空也不再回填，避免把用户的主动清空反复填回来。
   */
  reflectMailboxRestored: boolean
  hooksEnabled: boolean
  mcpEnabled: boolean
  relayUrl: string
  /** 手机端可以在这些目录下新建工作区（已 realpath 的绝对路径）。 */
  phoneRoots: string[]
  /** Painted theme; only `dark` and `light` exist, so it is stored as-is. */
  theme: ThemeMode
  fontSize: FontSizePreference
  locale: LocaleSetting
  apiKeyCipher: string | null
  apiKeyPlain: boolean
}

export interface PersistedWorkspace {
  path: string
  name: string
  addedAt: string
  lastOpenedAt: string
  memory: MemoryEntry[]
  profiles: ProfileVersion[]
  runs: RunRecord[]
}

export interface PersistedState {
  version: number
  settings: PersistedSettings
  workspaces: PersistedWorkspace[]
  /** Cross-workspace evolution profiles, independent of any workspace. */
  globalProfiles: ProfileVersion[]
  /** Tunables of the self-evolution loop, evolved by the loop itself. */
  evolutionPolicy: EvolutionPolicy
  evolutionPolicyVersions: EvolutionPolicyVersion[]
  /** Bounded history of propose → review → apply runs. */
  evolutionCycles: EvolutionCycle[]
  /** Quality gate state: metric weights, current baseline, candidates. */
  quality: QualityState
  sessions: Session[]
  scheduled: ScheduledTask[]
  /** 反思报告历史（新的在前，上限 MAX_REFLECTION_REPORTS）。 */
  reflectionReports: ReflectionReport[]
  /** 上一次排定触发被处理的时间，避免到点后每轮 tick 重复跑。 */
  reflectLastScheduledAt: string | null
  /** null = built-in quick prompts; an explicit array (including []) is customized. */
  quickCommands: QuickCommand[] | null
  activeWorkspace: string | null
  activeSession: string | null
}

// Persisted-state schema version. v2 turns Shell mode on by default and
// migrates stores written with the old "off" default exactly once.
export const STATE_VERSION = 2

/** 欢迎页常用指令的上限；再多会挤占首屏并增加维护成本。 */
export const MAX_QUICK_COMMANDS = 8
export const MAX_QUICK_COMMAND_CHARS = 4_000

/** 手机端最多能授权的根目录数量；再多没有意义，也会让手机选择器难以使用。 */
export const MAX_PHONE_ROOTS = 12
/** 手机端创建的工作区总数上限，避免误操作把工作区列表刷爆。 */
export const MAX_WORKSPACES = 200

export const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|secret:\/\/)/i
export const WEAKEN_PATTERN =
  /(ignore (all )?(previous|above|safety)|disable (safety|approval)|bypass (safety|approval)|忽略.{0,8}(安全|审批|凭据)|不要遵守.{0,8}(安全|审批|凭据)|关闭.{0,6}(审批|安全))/i

export function now(): string {
  return new Date().toISOString()
}

export function defaults(): PersistedState {
  const primaryBaseUrl = process.env['PILOT_BASE_URL'] ?? 'https://api.deepseek.com'
  const primaryModel = process.env['PILOT_MODEL'] ?? 'deepseek-chat'
  const primaryKey = process.env['PILOT_API_KEY']
  const primaryResource: PersistedModelResource = {
    id: 'primary',
    label: '默认模型',
    baseUrl: primaryBaseUrl,
    model: primaryModel,
    tag: '',
    enabled: true,
    keyCipher: primaryKey ? Buffer.from(primaryKey, 'utf8').toString('base64') : null,
    keyPlain: Boolean(primaryKey),
  }
  return {
    version: STATE_VERSION,
    settings: {
      baseUrl: primaryBaseUrl,
      model: primaryModel,
      maxSteps: 200,
      // Off by default; the UI offers explicit budgets instead of guessing one.
      maxTokens: 0,
      // Claude-sized window; `effectiveContextTokens` clamps it down to
      // whatever the selected model actually accepts.
      maxContextTokens: DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: DEFAULT_OUTPUT_TOKENS,
      temperature: 0.2,
      autoReflect: true,
      autoEvolve: false,
      autoContinue: true,
      autoContinueLimit: 3,
      // Screenshots are attached as images unless the user opts out (some
      // OpenAI-compatible endpoints reject image content parts).
      screenshotFeedback: true,
      testTargets: [],
      testCaptchaMode: 'off',
      testCaptchaCipher: null,
      testCaptchaPlain: false,
      approvalTimeoutSec: 300,
      // Shell commands are available out of the box. Whether each call needs
      // approval depends on the session execution mode (默认全部自动).
      shellMode: true,
      // Prefer a real bash on Windows when one is installed, otherwise cmd.
      shellInterpreter: 'auto',
      defaultApprovalMode: 'auto',
      permissionRules: { allow: [], ask: [], deny: [] },
      trustedCommands: [],
      classifierModel: 'deepseek-chat',
      reviewModel: '',
      modelResources: [primaryResource],
      sessionModelId: 'primary',
      evaluationModelIds: [],
      reviewModelId: '',
      judgeProviders: [],
      sandboxMode: 'off',
      sandboxNetwork: false,
      sandboxAutoAllow: true,
      allowUnattendedBuild: false,
      fullAutonomy: false,
      learningMode: false,
      learningHosts: [],
      learningShellIsolation: false,
      serverMode: false,
      serverPort: DEFAULT_SERVER_PORT,
      selfSourceMode: 'builtin',
      selfSourceGitUrl: '',
      selfSourceGitRef: 'main',
      selfSourceGitPath: '',
      selfSourceCustomPath: '',
      qualityGate: false,
      qualityPublishTarget: 'none',
      qualityTuneEvery: 5,
      checkpointRetention: 20,
      checkpointMaxBytes: 2 * 1024 * 1024 * 1024,
      checkpointShell: true,
      checkpointIgnore: [],
      notifyDesktop: true,
      reflectEnabled: false,
      reflectModelId: '',
      reflectTriggers: { onError: true, onSchedule: true },
      reflectScheduleMode: 'version',
      reflectScheduleModePinned: false,
      reflectIntervalMinutes: REFLECTION_INTERVAL_DEFAULT_MINUTES,
      reflectDailyTime: REFLECTION_DAILY_DEFAULT,
      reflectTopics: [...DEFAULT_REFLECTION_TOPICS],
      reflectLastRunAt: '',
      reflectLastVersion: '',
      reflectEmailEnabled: true,
      // 新装不自动往邮箱发信：先把总开关关着，用户填完邮箱再自己打开。
      // 事件清单按推荐优先级预勾选，打开开关就能直接生效。
      notifyEmailEnabled: false,
      notifyEmailEvents: [...DEFAULT_NOTIFY_EMAIL_EVENTS],
      // 出厂不预置任何邮箱地址与服务器：邮箱是用户自己的，产品方不该在默认值里
      // 留下一个看得见、也可能被误发的地址。端口与加密方式保留通用默认。
      reflectEmailTo: '',
      reflectSmtpHost: '',
      reflectSmtpPort: 465,
      reflectSmtpSecurity: 'tls',
      reflectSmtpPasswordCipher: null,
      reflectSmtpPasswordPlain: false,
      reflectMailboxRestored: false,
      hooksEnabled: false,
      mcpEnabled: false,
      // 官方不提供公共中继；默认只走局域网，用户自行部署后填写地址。
      relayUrl:
        process.env['PILOT_RELAY_URL'] !== undefined
          ? (normalizeRelayUrl(process.env['PILOT_RELAY_URL']) ?? '')
          : '',
      phoneRoots: [],
      theme: 'dark',
      fontSize: 'standard',
      locale: 'auto',
      apiKeyCipher: primaryResource.keyCipher,
      apiKeyPlain: primaryResource.keyPlain,
    },
    workspaces: [],
    globalProfiles: [],
    evolutionPolicy: { ...DEFAULT_EVOLUTION_POLICY },
    evolutionPolicyVersions: [],
    evolutionCycles: [],
    quality: emptyQualityState(),
    sessions: [],
    scheduled: [],
    reflectionReports: [],
    reflectLastScheduledAt: null,
    quickCommands: null,
    activeWorkspace: null,
    activeSession: null,
  }
}

export function normalizeText(value: unknown, fallback: string, max = 500): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback
}

/** Optional model names use "" to mean "fall back to the default model". */
export function normalizeOptionalText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * 带产品默认值的文本字段：老 store 里还没有这个键（undefined/null）时回落到默认值，
 * 显式存下来的空串仍按「用户清空」处理，不能被默认值再填回去。
 */
function textOrDefault(value: unknown, max: number, fallbackValue: string): string {
  if (value === undefined || value === null) return fallbackValue
  return normalizeOptionalText(value, max)
}

/**
 * 合并前的邮箱键顺序。老存档可能只有 smtpUser（登录名）有值，而收件地址为空，
 * 单字段化之后只能取第一个非空值，否则用户升级后要重新填一遍邮箱。
 */
function legacyReflectionMailbox(raw: Record<string, unknown>): unknown {
  for (const key of ['reflectEmailTo', 'reflectSmtpUser', 'reflectEmailFrom']) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

export const MAX_TEST_TARGETS = 20

/**
 * 旧版出厂预置的反思发信邮箱。它曾经是 defaults() 的一部分，所以会被写进用户的
 * `pilot-core.json`；光把 defaults 改成空不够，老存档里那一份还得当成「没配置」
 * 请掉，否则界面上依旧显示产品方的地址、反思邮件也继续发到那里。
 */
const LEGACY_PRODUCT_MAILBOX = 'embeddedmeng@163.com'
/** 与那个邮箱一起预置的 163 主机（当时是 defaults 里的第三项）。 */
const LEGACY_PRODUCT_SMTP_HOST = 'smtp.163.com'

/** 该邮箱只作为历史预置值存在；用户自己的配置一定有授权码。 */
export function isLegacyProductMailbox(value: string): boolean {
  return value.trim().toLowerCase() === LEGACY_PRODUCT_MAILBOX
}

/**
 * 存档里是否已经存过 SMTP 授权码。
 *
 * 它是「这个邮箱是用户自己在用」的硬证据：真正发出过信的人必然填过授权码。
 * 清理旧版预置邮箱时必须带上这个条件——产品预置的地址恰好也是作者本人在用的
 * 地址，只按地址比对会把他自己的配置当成「没配置」清掉，于是任务完成通知一封
 * 都发不出去，而授权码还在，界面上看着像已经配置好了。
 */
function hasSavedSmtpPassword(settingsRaw: Record<string, unknown>): boolean {
  const cipher = settingsRaw['reflectSmtpPasswordCipher']
  return typeof cipher === 'string' && cipher.length > 0
}

/** 动态工具只能访问用户显式登记的 http/https 测试目标。 */
export function normalizeTestTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().slice(0, 500)
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function normalizeTestTargets(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const target = normalizeTestTarget(item)
    if (target && !out.includes(target)) out.push(target)
    if (out.length >= MAX_TEST_TARGETS) break
  }
  return out
}

/** True when `child` is `parent` or lives inside it (both already resolved). */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function normalizePhoneRoots(value: unknown): string[] {
  const roots = Array.isArray(value) ? value : []
  const out: string[] = []
  for (const entry of roots) {
    if (typeof entry !== 'string') continue
    const path = entry.trim().slice(0, 1_000)
    if (!path) continue
    if (out.some((root) => root === path)) continue
    out.push(path)
    if (out.length >= MAX_PHONE_ROOTS) break
  }
  return out
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

/** Upgrade a persisted value that still equals an outdated default. */
export function migrateLimit(value: number, oldDefault: number, nextDefault: number): number {
  return value === oldDefault ? nextDefault : value
}

/**
 * Collapse persisted execution modes onto the three canonical modes:
 * auto (全部自动), manual (只读自动) and ask (逐条审批).
 *
 * Legacy values are migrated instead of kept so the UI never shows a mode it
 * can no longer represent. acceptEdits accepted writes automatically, so it
 * maps to auto; plan/dontAsk only ever ran safe operations, so they map to
 * manual. Unknown values fall back to the default: auto.
 */
export function normalizeApprovalMode(value: unknown): ApprovalMode {
  if (value === 'auto' || value === 'acceptEdits') return 'auto'
  if (
    value === 'manual' ||
    value === 'plan' ||
    value === 'dontAsk' ||
    value === 'sensitive' ||
    value === 'all'
  ) {
    return 'manual'
  }
  if (value === 'ask') return 'ask'
  return 'auto'
}

/**
 * 反思自动触发的粒度。v1.2.4 起默认改为「版本变化触发」：高速迭代期一版一个行为，
 * 反思按版本切分才能看清这版改了什么。老存档里的 daily/interval 只是旧默认值，
 * 不是用户的选择，所以统一迁到新默认；用户亲手选过（`reflectScheduleModePinned`）后
 * 一律尊重原值，不再被迁移覆盖。
 */
function resolveReflectionScheduleMode(settingsRaw: Record<string, unknown>): ReflectionScheduleMode {
  if (settingsRaw['reflectScheduleModePinned'] === true) {
    return normalizeReflectionScheduleMode(settingsRaw['reflectScheduleMode'])
  }
  return 'version'
}

export function sanitizeRuleList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 300)
    .slice(0, 200)
}

export const SECRET_LIKE_COMMAND =
  /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?[^\s"']{12,})/i

/**
 * Trusted commands are compared exactly, so keep them verbatim except for
 * surrounding whitespace. Newlines and NUL bytes are rejected: a multi-line
 * entry is ambiguous at the approval prompt.
 */
export function sanitizeCommandList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const commands: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const command = item.trim()
    if (!command || command.length > 2_000 || /[\0\r\n]/.test(command)) continue
    if (seen.has(command)) continue
    seen.add(command)
    commands.push(command)
  }
  return commands.slice(-100)
}

export function sanitizePermissionRules(value: unknown): PermissionRules {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    allow: sanitizeRuleList(record['allow']),
    ask: sanitizeRuleList(record['ask']),
    deny: sanitizeRuleList(record['deny']),
  }
}

/**
 * A profile explanation is advisory text for the user; it never influences
 * which rules are active, so it is sanitized leniently and dropped when it is
 * unusable instead of failing the whole profile.
 */
export function sanitizeExplanation(value: unknown): ProfileExplanation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const headline = typeof record['headline'] === 'string' ? record['headline'].trim() : ''
  const impact = typeof record['impact'] === 'string' ? record['impact'].trim() : ''
  const reason = typeof record['reason'] === 'string' ? record['reason'].trim() : ''
  if (!headline || !impact) return undefined
  const list = (input: unknown, cap: number): string[] =>
    Array.isArray(input)
      ? input
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, cap)
      : []
  return {
    headline: headline.slice(0, 300),
    changes: list(record['changes'], 8).map((item) => item.slice(0, 400)),
    impact: impact.slice(0, 600),
    risks: list(record['risks'], 6).map((item) => item.slice(0, 400)),
    recommend: record['recommend'] === 'observe' ? 'observe' : 'enable',
    reason: reason.slice(0, 600),
    ...(typeof record['model'] === 'string' ? { model: record['model'].slice(0, 120) } : {}),
    at: typeof record['at'] === 'string' ? record['at'] : now(),
  }
}

export function sanitizeProfile(value: unknown): ProfileVersion | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['version'] !== 'number') return null
  const status =
    record['status'] === 'active' || record['status'] === 'retired' ? record['status'] : 'draft'
  const evidence = (record['evidence'] ?? {}) as Record<string, unknown>
  const strategy = (record['strategy'] ?? {}) as Record<string, unknown>
  const reviewRaw = record['review'] as Record<string, unknown> | undefined
  return {
    id: record['id'],
    version: Math.max(1, Math.round(record['version'])),
    status,
    promptAddendum:
      typeof record['promptAddendum'] === 'string' ? record['promptAddendum'].slice(0, 4_000) : '',
    strategy: {
      ...(typeof strategy['maxSteps'] === 'number'
        ? { maxSteps: clampNumber(strategy['maxSteps'], 200, 20, 500) }
        : {}),
      ...(typeof strategy['temperature'] === 'number'
        ? { temperature: clampNumber(strategy['temperature'], 0.2, 0, 1) }
        : {}),
    },
    rationale: typeof record['rationale'] === 'string' ? record['rationale'].slice(0, 4_000) : '',
    ...(() => {
      const explanation = sanitizeExplanation(record['explanation'])
      return explanation ? { explanation } : {}
    })(),
    source:
      record['source'] === 'user'
        ? 'user'
        : record['source'] === 'promoted'
          ? 'promoted'
          : 'self',
    scope: record['scope'] === 'global' ? 'global' : 'workspace',
    evidence: {
      runs: clampNumber(evidence['runs'], 0, 0, 10_000),
      failures: clampNumber(evidence['failures'], 0, 0, 10_000),
      avgSteps: clampNumber(evidence['avgSteps'], 0, 0, 1_000),
      avgTokens: clampNumber(evidence['avgTokens'], 0, 0, 10_000_000),
      positive: clampNumber(evidence['positive'], 0, 0, 10_000),
      negative: clampNumber(evidence['negative'], 0, 0, 10_000),
      ...(typeof evidence['verified'] === 'number'
        ? { verified: clampNumber(evidence['verified'], 0, 0, 10_000) }
        : {}),
    },
    ...(() => {
      const review = sanitizeProfileReview(reviewRaw)
      return review ? { review } : {}
    })(),
    ...(typeof record['basedOnVersion'] === 'number'
      ? { basedOnVersion: Math.max(0, Math.round(record['basedOnVersion'])) }
      : {}),
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : now(),
    ...(typeof record['activatedAt'] === 'string' ? { activatedAt: record['activatedAt'] } : {}),
    ...(typeof record['retiredAt'] === 'string' ? { retiredAt: record['retiredAt'] } : {}),
    ...(record['autoActivated'] === true ? { autoActivated: true } : {}),
  }
}

export function sanitizeProfileEvidence(value: unknown): ProfileEvidence {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    runs: clampNumber(record['runs'], 0, 0, 10_000),
    failures: clampNumber(record['failures'], 0, 0, 10_000),
    avgSteps: clampNumber(record['avgSteps'], 0, 0, 1_000),
    avgTokens: clampNumber(record['avgTokens'], 0, 0, 10_000_000),
    positive: clampNumber(record['positive'], 0, 0, 10_000),
    negative: clampNumber(record['negative'], 0, 0, 10_000),
    ...(typeof record['verified'] === 'number'
      ? { verified: clampNumber(record['verified'], 0, 0, 10_000) }
      : {}),
  }
}

/** Deletion verdicts are model-written, so every field is bounded and screened. */
export function sanitizeRemovalVerdicts(
  value: unknown,
  limit: number,
): Array<{ rule: string; justified: boolean; reason: string }> {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .slice(0, limit)
    .map((item) => ({
      rule: typeof item['rule'] === 'string' ? item['rule'].slice(0, 1_200) : '',
      justified: item['justified'] === true,
      reason: typeof item['reason'] === 'string' ? item['reason'].slice(0, 1_000) : '',
    }))
    .filter((item) => item.rule.trim().length > 0)
}

export function sanitizeProfileReview(value: unknown): ProfileReview | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record['score'] !== 'number') return undefined
  const judgeUsage = sanitizeJudgeUsage(record['judgeUsage'])
  const judges = Array.isArray(record['judges'])
    ? (record['judges'] as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 8)
        .map((item) => {
          const removals = sanitizeRemovalVerdicts(item['removals'], 40)
          return {
            id: typeof item['id'] === 'string' ? item['id'] : '',
            label: typeof item['label'] === 'string' ? item['label'] : '',
            model: typeof item['model'] === 'string' ? item['model'] : '',
            external: item['external'] === true,
            score: clampNumber(item['score'], 0, 0, 100),
            pass: item['pass'] === true,
            notes: typeof item['notes'] === 'string' ? item['notes'].slice(0, 2_000) : '',
            risks: Array.isArray(item['risks'])
              ? (item['risks'] as unknown[])
                  .filter((risk): risk is string => typeof risk === 'string')
                  .slice(0, 8)
              : [],
            ...(removals.length > 0 ? { removals } : {}),
          }
        })
    : []
  const removals = Array.isArray(record['removals'])
    ? (record['removals'] as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .slice(0, 40)
        .map((item) => ({
          rule: typeof item['rule'] === 'string' ? item['rule'].slice(0, 1_200) : '',
          justified: item['justified'] === true,
          reason: typeof item['reason'] === 'string' ? item['reason'].slice(0, 1_000) : '',
          judges: Array.isArray(item['judges'])
            ? (item['judges'] as unknown[])
                .filter((judge): judge is string => typeof judge === 'string')
                .slice(0, 8)
            : [],
        }))
        .filter((item) => item.rule.trim().length > 0)
    : []
  const activationRaw = record['activation'] as Record<string, unknown> | undefined
  const activation =
    activationRaw && typeof activationRaw === 'object'
      ? {
          ready: activationRaw['ready'] === true,
          reasons: Array.isArray(activationRaw['reasons'])
            ? (activationRaw['reasons'] as unknown[])
                .filter((reason): reason is string => typeof reason === 'string')
                .slice(0, 8)
            : [],
        }
      : undefined
  const comparison = sanitizeProfileComparison(record['comparison'])
  return {
    score: clampNumber(record['score'], 0, 0, 100),
    pass: record['pass'] === true,
    notes: typeof record['notes'] === 'string' ? record['notes'].slice(0, 2_000) : '',
    risks: Array.isArray(record['risks'])
      ? record['risks'].filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [],
    at: typeof record['at'] === 'string' ? record['at'] : now(),
    model: typeof record['model'] === 'string' ? record['model'] : '',
    ...(record['independent'] === true ? { independent: true } : {}),
    ...(judges.length > 0 ? { judges } : {}),
    ...(Array.isArray(record['judgeErrors'])
      ? {
          judgeErrors: (record['judgeErrors'] as unknown[])
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 8),
        }
      : {}),
    ...(judgeUsage ? { judgeUsage } : {}),
    ...(typeof record['baselineVersion'] === 'number'
      ? { baselineVersion: Math.max(0, Math.round(record['baselineVersion'])) }
      : {}),
    ...(removals.length > 0 ? { removals } : {}),
    ...(comparison ? { comparison } : {}),
    ...(activation ? { activation } : {}),
  }
}

/** Focus text is model-written, so it gets the same secret/weakening screen. */
export function sanitizeEvolutionPolicy(value: unknown, base?: EvolutionPolicy): EvolutionPolicy {
  const policy = normalizeEvolutionPolicy(value, base)
  if (SECRET_PATTERN.test(policy.focus) || WEAKEN_PATTERN.test(policy.focus)) {
    policy.focus = ''
  }
  return policy
}

export function sanitizeEvolutionPolicyVersion(value: unknown): EvolutionPolicyVersion | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['version'] !== 'number') return null
  const review = sanitizeProfileReview(record['review'])
  return {
    id: record['id'],
    version: Math.max(1, Math.round(record['version'])),
    status:
      record['status'] === 'active'
        ? 'active'
        : record['status'] === 'retired'
          ? 'retired'
          : 'draft',
    policy: sanitizeEvolutionPolicy(record['policy']),
    rationale: typeof record['rationale'] === 'string' ? record['rationale'].slice(0, 4_000) : '',
    evidence: sanitizeProfileEvidence(record['evidence']),
    ...(review ? { review } : {}),
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : now(),
    ...(typeof record['activatedAt'] === 'string' ? { activatedAt: record['activatedAt'] } : {}),
    ...(typeof record['retiredAt'] === 'string' ? { retiredAt: record['retiredAt'] } : {}),
  }
}

export function sanitizeEvolutionStage(value: unknown): EvolutionStage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const keys = ['evidence', 'propose', 'review', 'apply', 'watch']
  if (typeof record['key'] !== 'string' || !keys.includes(record['key'])) return null
  return {
    key: record['key'] as EvolutionStage['key'],
    status:
      record['status'] === 'failed' || record['status'] === 'skipped'
        ? record['status']
        : 'done',
    detail: typeof record['detail'] === 'string' ? record['detail'].slice(0, 800) : '',
    at: typeof record['at'] === 'string' ? record['at'] : now(),
  }
}

export function sanitizeEvolutionCycle(value: unknown): EvolutionCycle | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['workspacePath'] !== 'string') return null
  const triggers = ['manual', 'auto', 'meta', 'watch']
  const trigger = typeof record['trigger'] === 'string' && triggers.includes(record['trigger'])
    ? (record['trigger'] as EvolutionCycle['trigger'])
    : 'manual'
  return {
    id: record['id'],
    workspacePath: record['workspacePath'],
    trigger,
    status:
      record['status'] === 'rejected' || record['status'] === 'failed'
        ? record['status']
        : 'completed',
    startedAt: typeof record['startedAt'] === 'string' ? record['startedAt'] : now(),
    finishedAt: typeof record['finishedAt'] === 'string' ? record['finishedAt'] : now(),
    stages: Array.isArray(record['stages'])
      ? record['stages']
          .map(sanitizeEvolutionStage)
          .filter((stage): stage is EvolutionStage => Boolean(stage))
          .slice(0, 8)
      : [],
    ...(typeof record['profileId'] === 'string' ? { profileId: record['profileId'] } : {}),
    ...(typeof record['profileVersion'] === 'number'
      ? { profileVersion: Math.round(record['profileVersion']) }
      : {}),
    ...(typeof record['score'] === 'number'
      ? { score: clampNumber(record['score'], 0, 0, 100) }
      : {}),
    activated: record['activated'] === true,
    summary: typeof record['summary'] === 'string' ? record['summary'].slice(0, 1_000) : '',
  }
}

type MemoryCounter = 'reinforced' | 'injected'

function memoryCategory(value: unknown): MemoryCategory | null {
  return isMemoryCategory(value) ? value : null
}

function counterField(
  field: MemoryCounter,
  value: unknown,
): Partial<Pick<MemoryEntry, MemoryCounter>> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return {}
  return { [field]: Math.floor(value) } as Partial<Pick<MemoryEntry, MemoryCounter>>
}

export function sanitizeWorkspace(value: unknown): PersistedWorkspace | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record['path'] !== 'string') return null
  const rawMemory = Array.isArray(record['memory']) ? record['memory'] : []
  const rawProfiles = Array.isArray(record['profiles']) ? record['profiles'] : []
  const rawRuns = Array.isArray(record['runs']) ? record['runs'] : []
  return {
    path: record['path'],
    name: typeof record['name'] === 'string' ? record['name'] : basename(record['path']),
    addedAt: typeof record['addedAt'] === 'string' ? record['addedAt'] : now(),
    lastOpenedAt: typeof record['lastOpenedAt'] === 'string' ? record['lastOpenedAt'] : now(),
    memory: rawMemory
      .filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object',
      )
      .map((entry): MemoryEntry => {
        const category = memoryCategory(entry.category)
        return {
          id: typeof entry.id === 'string' ? entry.id : randomUUID(),
          content: typeof entry.content === 'string' ? entry.content.slice(0, 1_000) : '',
          source:
            entry.source === 'user' || entry.source === 'agent' ? entry.source : 'reflection',
          ...(category ? { category } : {}),
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now(),
          ...counterField('reinforced', entry.reinforced),
          ...counterField('injected', entry.injected),
          ...(typeof entry.lastUsedAt === 'string' ? { lastUsedAt: entry.lastUsedAt } : {}),
          ...(typeof entry.runId === 'string' ? { runId: entry.runId } : {}),
          ...(typeof entry.sessionId === 'string' && entry.sessionId
            ? { sessionId: entry.sessionId }
            : {}),
        }
      })
      .filter((entry) => entry.content)
      .slice(0, MEMORY_STORE_LIMIT),
    // Same survival rule as the store's own cap: a plain slice keeps the newest
    // 40 and would cut the active profile, which sits at the oldest end.
    profiles: pruneProfiles(
      rawProfiles
        .map(sanitizeProfile)
        .filter((profile): profile is ProfileVersion => Boolean(profile)),
    ),
    runs: rawRuns
      .filter((run): run is RunRecord => Boolean(run) && typeof run === 'object' && typeof (run as RunRecord).id === 'string')
      .map((run) => ({ ...run, status: run.status === 'running' ? 'interrupted' : run.status }))
      .slice(0, 200),
  }
}

export function clip(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

export function sanitizeReviewSessions(value: unknown): ReviewSessionScope {
  if (value === 'all' || value === 'workspace') return value
  if (!Array.isArray(value)) return 'workspace'
  const ids = [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    .slice(0, 50)
  return ids.length > 0 ? ids : 'workspace'
}

export function sanitizeReviewScope(value: unknown): ReviewScope | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const rawRoots = Array.isArray(record['roots']) ? record['roots'] : []
  const seen = new Set<string>()
  const roots: ReviewScope['roots'] = []
  for (const item of rawRoots.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const path = typeof entry['path'] === 'string' ? entry['path'].trim() : ''
    if (!path || !isAbsolute(path)) continue
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) continue
    seen.add(key)
    const name = clip(entry['name'], 40) || basename(path) || 'root'
    roots.push({ name, path })
  }
  if (roots.length === 0) return null
  const objective = clip(record['objective'], 4_000)
  return {
    roots,
    sessions: sanitizeReviewSessions(record['sessions']),
    ...(objective ? { objective } : {}),
  }
}

export function sanitizeScore(value: unknown): number {
  return Math.max(0, Math.min(100, Math.round(typeof value === 'number' && Number.isFinite(value) ? value : 0)))
}

export function sanitizeEvidence(value: unknown): ReviewEvidenceRef[] {
  if (!Array.isArray(value)) return []
  const result: ReviewEvidenceRef[] = []
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const kind =
      record['kind'] === 'file' || record['kind'] === 'session' || record['kind'] === 'run'
        ? record['kind']
        : null
    const ref = clip(record['ref'], 500)
    if (!kind || !ref) continue
    const note = clip(record['note'], 300)
    result.push({ kind, ref, ...(note ? { note } : {}) })
  }
  return result
}

export function sanitizeScores(value: unknown): ReviewScores {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    correctness: sanitizeScore(record['correctness']),
    evidence: sanitizeScore(record['evidence']),
    safety: sanitizeScore(record['safety']),
    efficiency: sanitizeScore(record['efficiency']),
  }
}

export function sanitizeFinding(value: unknown): ReviewFinding | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const title = clip(record['title'], 200)
  const recommendation = clip(record['recommendation'], 1_500)
  if (!title || !recommendation) return null
  const severity =
    record['severity'] === 'high' || record['severity'] === 'medium' ? record['severity'] : 'low'
  const facts = Array.isArray(record['facts'])
    ? record['facts']
        .map((item) => clip(item, 1_000))
        .filter(Boolean)
        .slice(0, 8)
    : []
  const rootCause = clip(record['rootCause'], 1_000)
  const confidence =
    typeof record['confidence'] === 'number' && Number.isFinite(record['confidence'])
      ? Math.max(0, Math.min(1, Math.round(record['confidence'] * 100) / 100))
      : 0.5
  return {
    title,
    severity,
    facts,
    evidence: sanitizeEvidence(record['evidence']),
    ...(rootCause ? { rootCause } : {}),
    recommendation,
    confidence,
  }
}

export function sanitizeReviewReport(value: unknown): ReviewReport | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const summary = clip(record['summary'], 4_000)
  if (!summary) return null
  const verdict =
    record['verdict'] === 'needs_work' || record['verdict'] === 'blocked'
      ? record['verdict']
      : 'pass'
  const findings = Array.isArray(record['findings'])
    ? record['findings']
        .map(sanitizeFinding)
        .filter((item): item is ReviewFinding => Boolean(item))
        .slice(0, 20)
    : []
  const list = (value: unknown, limit: number, max: number): string[] =>
    Array.isArray(value)
      ? value
          .map((item) => clip(item, limit))
          .filter(Boolean)
          .slice(0, max)
      : []
  const profileAddendum = clip(record['profileAddendum'], 4_000)
  const profileRationale = clip(record['profileRationale'], 2_000)
  return {
    objective: clip(record['objective'], 4_000),
    verdict,
    summary,
    scores: sanitizeScores(record['scores']),
    findings,
    unknowns: list(record['unknowns'], 500, 20),
    memoryLessons: list(record['memoryLessons'], 500, 8),
    ...(profileAddendum ? { profileAddendum } : {}),
    ...(profileRationale ? { profileRationale } : {}),
    createdAt:
      typeof record['createdAt'] === 'string' ? record['createdAt'] : now(),
    model: clip(record['model'], 200),
  }
}

/** Validate an inline plan snapshot (session-level or attached to a message). */
export function sanitizePlan(value: unknown): Plan | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record['items'])) return null
  const items = (record['items'] as unknown[])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => typeof item['text'] === 'string' && item['text'].trim())
    .slice(0, PLAN_ITEM_LIMIT)
    .map((item, index) => ({
      id: typeof item['id'] === 'string' ? item['id'] : `plan-${index + 1}`,
      text: String(item['text']).slice(0, 2_000),
      status:
        item['status'] === 'done' || item['status'] === 'in_progress'
          ? (item['status'] as 'done' | 'in_progress')
          : ('pending' as const),
    }))
  if (items.length === 0) return null
  return {
    goal: typeof record['goal'] === 'string' ? record['goal'].slice(0, 2_000) : '',
    items,
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : now(),
  }
}

/** Counts recorded by the index, used when a record carries no transcript. */
export function storedCount(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback
}

export function sanitizeSession(value: unknown): Session | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['workspacePath'] !== 'string') return null
  const rawMessages = Array.isArray(record['messages']) ? record['messages'] : []
  const messages: StoredMessage[] = rawMessages
    .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === 'object')
    .map((message) => ({
      id: typeof message['id'] === 'string' ? message['id'] : randomUUID(),
      role:
        message['role'] === 'assistant' || message['role'] === 'tool' || message['role'] === 'system'
          ? message['role']
          : 'user',
      content: typeof message['content'] === 'string' ? message['content'] : '',
      createdAt: typeof message['createdAt'] === 'string' ? message['createdAt'] : now(),
      ...(Array.isArray(message['toolCalls']) ? { toolCalls: message['toolCalls'] as StoredMessage['toolCalls'] } : {}),
      ...(typeof message['toolCallId'] === 'string' ? { toolCallId: message['toolCallId'] } : {}),
      ...(typeof message['name'] === 'string' ? { name: message['name'] } : {}),
      ...(message['isError'] === true ? { isError: true } : {}),
      ...(typeof message['reasoning'] === 'string' ? { reasoning: message['reasoning'] } : {}),
      ...(typeof message['runId'] === 'string' ? { runId: message['runId'] } : {}),
      ...(message['control'] === true ? { control: true } : {}),
      ...(sanitizePlan(message['plan'])
        ? { plan: sanitizePlan(message['plan']) as Plan }
        : {}),
      ...(Array.isArray(message['images'])
        ? {
            images: message['images']
              .filter(
                (entry): entry is string =>
                  typeof entry === 'string' && /^data:image\//i.test(entry),
              )
              .slice(0, 3),
          }
        : {}),
      ...(Array.isArray(message['references'])
        ? {
            references: message['references']
              .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
              .slice(0, 8),
          }
        : {}),
    }))
  const rawQueue = Array.isArray(record['queue']) ? record['queue'] : []
  const rawTodos = Array.isArray(record['todos']) ? record['todos'] : []
  const bodyAbsent =
    !Array.isArray(record['messages']) &&
    !Array.isArray(record['queue']) &&
    !Array.isArray(record['todos'])
  const planRaw = record['plan'] as Record<string, unknown> | null | undefined
  const storedReview = sanitizeReviewScope(record['review'])
  const kind: SessionKind = record['kind'] === 'review' && storedReview ? 'review' : 'coding'
  const review = kind === 'review' ? storedReview : null
  const reviewReport = kind === 'review' ? sanitizeReviewReport(record['reviewReport']) : null
  return {
    id: record['id'],
    title: typeof record['title'] === 'string' && record['title'].trim() ? record['title'] : '新任务',
    workspacePath: record['workspacePath'],
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : now(),
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : now(),
    running: false,
    paused: record['paused'] === true,
    ...(typeof record['pausedAt'] === 'string' ? { pausedAt: record['pausedAt'] } : {}),
    ...(typeof record['pauseInstruction'] === 'string'
      ? { pauseInstruction: record['pauseInstruction'].slice(0, 4_000) }
      : {}),
    canContinue: false,
    // Index entries carry the counts and no body, so prefer the stored numbers
    // there; a shard (or a legacy record) recomputes them from the transcript.
    messageCount: bodyAbsent ? storedCount(record['messageCount'], messages.length) : messages.length,
    ...(bodyAbsent
      ? typeof record['instructionCount'] === 'number' &&
        Number.isFinite(record['instructionCount'])
        ? { instructionCount: Math.max(0, Math.round(record['instructionCount'])) }
        : {}
      : {
          instructionCount: messages.filter(
            (message) => message.role === 'user' && !message.control,
          ).length,
        }),
    queueCount: bodyAbsent ? storedCount(record['queueCount'], rawQueue.length) : rawQueue.length,
    todoCount: bodyAbsent
      ? storedCount(
          record['todoCount'],
          rawTodos.filter(
            (item) =>
              item && typeof item === 'object' && (item as Record<string, unknown>)['status'] !== 'sent',
          ).length,
        )
      : rawTodos.filter(
          (item) =>
            item && typeof item === 'object' && (item as Record<string, unknown>)['status'] !== 'sent',
        ).length,
    approvalMode: normalizeApprovalMode(record['approvalMode']),
    sessionModelId:
      typeof record['sessionModelId'] === 'string' ? record['sessionModelId'].slice(0, 80) : '',
    kind,
    review,
    reviewReport,
    messages,
    queue: rawQueue
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: typeof item['id'] === 'string' ? item['id'] : randomUUID(),
        content: typeof item['content'] === 'string' ? item['content'] : '',
        createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : now(),
      }))
      .filter((item) => item.content)
      .slice(0, 20),
    todos: rawTodos
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        id: typeof item['id'] === 'string' ? item['id'] : randomUUID(),
        sessionId: typeof record['id'] === 'string' ? record['id'] : '',
        text: typeof item['text'] === 'string' ? item['text'].slice(0, 4_000) : '',
        status: item['status'] === 'sent' ? ('sent' as const) : ('pending' as const),
        source:
          item['source'] === 'phone'
            ? ('phone' as const)
            : item['source'] === 'agent'
              ? ('agent' as const)
              : ('user' as const),
        ...(typeof item['clientId'] === 'string' ? { clientId: item['clientId'] } : {}),
        createdAt: typeof item['createdAt'] === 'string' ? item['createdAt'] : now(),
        ...(typeof item['sentAt'] === 'string' ? { sentAt: item['sentAt'] } : {}),
        ...(typeof item['sentRunId'] === 'string' ? { sentRunId: item['sentRunId'] } : {}),
      }))
      .filter((item) => item.text)
      .slice(0, 200),
    plan: sanitizePlan(planRaw),
    ...(Array.isArray(record['memoryIds'])
      ? {
          memoryIds: record['memoryIds']
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
            .slice(0, 200),
        }
      : {}),
    ...(typeof record['summary'] === 'string' && record['summary'].trim()
      ? { summary: record['summary'].trim().slice(0, CONTEXT_SUMMARY_MAX_CHARS) }
      : {}),
  }
}

export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export function cleanTimeOfDay(value: unknown): string | null {
  return typeof value === 'string' && TIME_OF_DAY_PATTERN.test(value) ? value : null
}

export function nextDailyRun(timeOfDay: string, from: Date, startDate?: string): string {
  const [hours, minutes] = timeOfDay.split(':').map((part) => Number(part))
  const next = new Date(from)
  next.setHours(hours ?? 0, minutes ?? 0, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  // 起始日还没到时不能提前触发：「从明天开始每天 20:00」在今晚 20:00 之前创建，
  // 下一次必须是明天，而不是今天。起始日已过（或就是今天且时间点未到）时按常规推算。
  const first = startDateFirstRun(timeOfDay, startDate)
  if (first && first.getTime() > next.getTime()) return first.toISOString()
  return next.toISOString()
}

export const START_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 本地日期 "YYYY-MM-DD"；2 月 31 日这类不存在的日期返回 null。 */
export function cleanStartDate(value: unknown): string | null {
  if (typeof value !== 'string' || !START_DATE_PATTERN.test(value)) return null
  const [year, month, day] = value.split('-').map((part) => Number(part))
  if (!year || !month || !day) return null
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return value
}

/** 起始日当天的那个时间点（本地时间）；没给起始日或格式不对时返回 null。 */
function startDateFirstRun(timeOfDay: string, startDate: string | undefined): Date | null {
  const clean = cleanStartDate(startDate)
  if (!clean) return null
  const [year, month, day] = clean.split('-').map((part) => Number(part))
  const [hours, minutes] = timeOfDay.split(':').map((part) => Number(part))
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, hours ?? 0, minutes ?? 0, 0, 0)
}

export function sanitizeQuickCommand(value: unknown): QuickCommand | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const content = typeof record['content'] === 'string' ? record['content'].trim() : ''
  if (!content) return null
  const id =
    typeof record['id'] === 'string' && record['id'].trim()
      ? record['id'].trim().slice(0, 80)
      : randomUUID()
  return { id, content: content.slice(0, MAX_QUICK_COMMAND_CHARS) }
}

function sanitizeScheduledRuns(value: unknown): ScheduledRunEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const runs: ScheduledRunEntry[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (record['status'] !== 'queued' && record['status'] !== 'failed') continue
    const at =
      typeof record['at'] === 'string' && Number.isFinite(Date.parse(record['at']))
        ? record['at']
        : null
    if (!at) continue
    const detail =
      typeof record['detail'] === 'string' ? record['detail'].slice(0, 400) : undefined
    runs.push({
      at,
      status: record['status'],
      ...(detail ? { detail } : {}),
    })
    if (runs.length >= MAX_SCHEDULED_RUNS) break
  }
  return runs.length > 0 ? runs : undefined
}

export function sanitizeScheduledTask(value: unknown): ScheduledTask | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['sessionId'] !== 'string') return null
  const content =
    typeof record['content'] === 'string' ? record['content'].trim().slice(0, 4_000) : ''
  if (!content) return null
  const kind: ScheduleKind =
    record['kind'] === 'interval' || record['kind'] === 'daily' ? record['kind'] : 'once'
  const nextRunAt =
    typeof record['nextRunAt'] === 'string' && Number.isFinite(Date.parse(record['nextRunAt']))
      ? record['nextRunAt']
      : null
  if (!nextRunAt) return null
  const intervalMinutes =
    kind === 'interval'
      ? Math.round(clampNumber(record['intervalMinutes'], 60, 1, 10_080))
      : undefined
  const timeOfDay = kind === 'daily' ? cleanTimeOfDay(record['timeOfDay']) : null
  if (kind === 'daily' && !timeOfDay) return null
  const startDate = kind === 'daily' ? cleanStartDate(record['startDate']) : null
  const runs = sanitizeScheduledRuns(record['runs'])
  return {
    id: record['id'],
    sessionId: record['sessionId'],
    content,
    kind,
    ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
    ...(timeOfDay ? { timeOfDay } : {}),
    ...(startDate ? { startDate } : {}),
    nextRunAt,
    enabled: record['enabled'] !== false,
    createdAt:
      typeof record['createdAt'] === 'string' && Number.isFinite(Date.parse(record['createdAt']))
        ? record['createdAt']
        : now(),
    ...(typeof record['lastRunAt'] === 'string' ? { lastRunAt: record['lastRunAt'] } : {}),
    ...(record['lastStatus'] === 'queued' || record['lastStatus'] === 'failed'
      ? { lastStatus: record['lastStatus'] }
      : {}),
    ...(typeof record['lastError'] === 'string'
      ? { lastError: record['lastError'].slice(0, 1_000) }
      : {}),
    ...(runs ? { runs } : {}),
  }
}

/** Older sessions may have ended while the last plan item was still active. */
export function settleStalePlans(workspaces: PersistedWorkspace[], sessions: Session[]): void {
  const latestRun = new Map<string, RunRecord>()
  for (const workspace of workspaces) {
    for (const run of workspace.runs) {
      const current = latestRun.get(run.sessionId)
      if (!current || run.startedAt > current.startedAt) latestRun.set(run.sessionId, run)
    }
  }
  for (const session of sessions) {
    if (!session.plan) continue
    const next = settlePlan(session.plan, latestRun.get(session.id)?.status ?? 'interrupted', now())
    if (next) session.plan = next
  }
}

export const MAX_JUDGE_PROVIDERS = 6

/** 每条定时任务保留的触发次数：够看出「是不是每次都挂」，又不会让状态文件无界增长。 */
export const MAX_SCHEDULED_RUNS = 10
/** Model resources are cheap to list; evaluation slots are the expensive part. */
export const MAX_MODEL_RESOURCES = 12
export const MAX_EVALUATION_MODELS = 6

export function validateJudgeProviders(input: JudgeProviderInput[]): void {
  if (!Array.isArray(input)) return
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    if (!normalizeProviderBaseUrl(entry.baseUrl) || !normalizeOptionalText(entry.model, 200)) {
      throw new Error('评审模型的接口地址必须以 http:// 或 https:// 开头，并填写模型名。')
    }
  }
}

export function validateModelResources(input: ModelResourceInput[]): void {
  if (!Array.isArray(input)) throw new Error('模型资源格式不正确。')
  if (input.length === 0) throw new Error('至少保留一个模型资源。')
  if (input.length > MAX_MODEL_RESOURCES) {
    throw new Error(`模型资源最多 ${MAX_MODEL_RESOURCES} 个。`)
  }
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    if (modelTagLength(entry.tag) > MODEL_TAG_MAX_LENGTH) {
      throw new Error(`模型标签最多 ${MODEL_TAG_MAX_LENGTH} 个字。`)
    }
    if (!normalizeProviderBaseUrl(entry.baseUrl) || !normalizeOptionalText(entry.model, 200)) {
      throw new Error('每个模型资源都要填写 http:// 或 https:// 接口地址和模型名。')
    }
  }
}

export function resourceId(raw: unknown, seen: Set<string>): string {
  const candidate = typeof raw === 'string' ? raw.trim() : ''
  if (/^[\w-]{6,40}$/.test(candidate) && !seen.has(candidate)) return candidate
  return randomUUID()
}

export function sanitizeModelResources(raw: unknown): PersistedModelResource[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: PersistedModelResource[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const baseUrl = normalizeProviderBaseUrl(record['baseUrl'])
    const model = normalizeOptionalText(record['model'], 200)
    if (!baseUrl || !model) continue
    const id = resourceId(record['id'], seen)
    seen.add(id)
    result.push({
      id,
      label: normalizeOptionalText(record['label'], 40) || model,
      baseUrl,
      model,
      tag: normalizeModelTag(record['tag']),
      enabled: record['enabled'] !== false,
      keyCipher: typeof record['keyCipher'] === 'string' ? record['keyCipher'] : null,
      keyPlain: record['keyPlain'] === true,
    })
    if (result.length >= MAX_MODEL_RESOURCES) break
  }
  return result
}

export function normalizeProviderBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return ''
  return value.slice(0, 500)
}

/**
 * Reviewer endpoints persist their own encrypted key, so the stored shape never
 * carries a plaintext secret. Entries without a usable endpoint and model are
 * dropped instead of failing the whole settings load.
 */
export function sanitizeJudgeProviders(raw: unknown): PersistedJudgeProvider[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: PersistedJudgeProvider[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const baseUrl = normalizeProviderBaseUrl(record['baseUrl'])
    const model = normalizeOptionalText(record['model'], 200)
    if (!baseUrl || !model) continue
    const candidate = typeof record['id'] === 'string' ? record['id'].trim() : ''
    const id = /^[\w-]{6,40}$/.test(candidate) && !seen.has(candidate) ? candidate : randomUUID()
    seen.add(id)
    result.push({
      id,
      label: normalizeOptionalText(record['label'], 40) || model,
      baseUrl,
      model,
      enabled: record['enabled'] !== false,
      keyCipher: typeof record['keyCipher'] === 'string' ? record['keyCipher'] : null,
      keyPlain: record['keyPlain'] === true,
    })
    if (result.length >= MAX_JUDGE_PROVIDERS) break
  }
  return result
}

export function sanitize(raw: unknown, presetSessions?: Session[]): PersistedState {
  const fallback = defaults()
  if (!raw || typeof raw !== 'object') return fallback
  const record = raw as Record<string, unknown>
  const settingsRaw = (record['settings'] ?? {}) as Record<string, unknown>

  // Model resources are the source of truth. Older stores kept one primary
  // endpoint plus separate reviewer rows; fold both into resources once.
  const legacyBaseUrl = normalizeText(settingsRaw['baseUrl'], fallback.settings.baseUrl, 500)
  const legacyModel = normalizeText(settingsRaw['model'], fallback.settings.model, 200)
  const legacyKeyCipher =
    typeof settingsRaw['apiKeyCipher'] === 'string' && settingsRaw['apiKeyCipher']
      ? settingsRaw['apiKeyCipher']
      : null
  const legacyKeyPlain = settingsRaw['apiKeyPlain'] === true
  const legacyJudges = sanitizeJudgeProviders(settingsRaw['judgeProviders'])
  // 反思发信：三个老邮箱键先合并成一个，再把旧版出厂预置的那份当成「没配置」。
  const mergedMailbox = textOrDefault(
    legacyReflectionMailbox(settingsRaw),
    200,
    fallback.settings.reflectEmailTo,
  )
  const mergedSmtpHost = textOrDefault(
    settingsRaw['reflectSmtpHost'],
    200,
    fallback.settings.reflectSmtpHost,
  )
  const savedSmtpPassword = hasSavedSmtpPassword(settingsRaw)
  const legacyProductMail = isLegacyProductMailbox(mergedMailbox) && !savedSmtpPassword
  // 一次性救援：旧版把预置邮箱（连同它的 163 主机）当「未配置」清掉，却保留了授权码。
  // 于是「授权码在 + 邮箱与主机都空」只可能来自那次清理，按历史预置值还原，
  // 用户升级后不用再重填一遍。`reflectMailboxRestored` 落盘后不再重试。
  const rescueMailbox =
    savedSmtpPassword &&
    settingsRaw['reflectMailboxRestored'] !== true &&
    mergedMailbox === '' &&
    mergedSmtpHost === ''
  const modelResources = sanitizeModelResources(settingsRaw['modelResources'])
  if (modelResources.length === 0) {
    modelResources.push({
      id: 'primary',
      label: '默认模型',
      baseUrl: legacyBaseUrl,
      model: legacyModel,
      tag: '',
      enabled: true,
      keyCipher: legacyKeyCipher,
      keyPlain: legacyKeyPlain,
    })
    for (const judge of legacyJudges) {
      modelResources.push({
        id: judge.id,
        label: judge.label,
        baseUrl: judge.baseUrl,
        model: judge.model,
        tag: '',
        enabled: judge.enabled,
        keyCipher: judge.keyCipher,
        keyPlain: judge.keyPlain,
      })
    }
  }
  const resourceIds = new Set(modelResources.map((resource) => resource.id))
  const storedSessionId =
    typeof settingsRaw['sessionModelId'] === 'string' ? settingsRaw['sessionModelId'] : ''
  const storedSession = modelResources.find((resource) => resource.id === storedSessionId)
  const sessionModelId =
    storedSession && storedSession.enabled
      ? storedSession.id
      : (modelResources.find((resource) => resource.enabled)?.id ?? modelResources[0]!.id)
  const evaluationSource = Array.isArray(settingsRaw['evaluationModelIds'])
    ? settingsRaw['evaluationModelIds']
    : legacyJudges.filter((judge) => judge.enabled).map((judge) => judge.id)
  const evaluationModelIds: string[] = []
  for (const id of evaluationSource) {
    if (typeof id !== 'string' || !resourceIds.has(id) || evaluationModelIds.includes(id)) continue
    evaluationModelIds.push(id)
    if (evaluationModelIds.length >= MAX_EVALUATION_MODELS) break
  }
  const storedReviewId =
    typeof settingsRaw['reviewModelId'] === 'string' ? settingsRaw['reviewModelId'] : ''
  const storedReview = modelResources.find(
    (resource) => resource.id === storedReviewId && resource.enabled,
  )
  const legacyReviewModel = normalizeOptionalText(settingsRaw['reviewModel'], 200)
  const reviewModelId = storedReview
    ? storedReview.id
    : legacyReviewModel
      ? (modelResources.find(
          (resource) => resource.model === legacyReviewModel && resource.enabled,
        )?.id ?? '')
      : ''
  const sessionResource =
    modelResources.find((resource) => resource.id === sessionModelId) ?? modelResources[0]!
  const evaluationResources = evaluationModelIds
    .map((id) => modelResources.find((resource) => resource.id === id))
    .filter((resource): resource is PersistedModelResource => Boolean(resource))

  const settings: PersistedSettings = {
    baseUrl: sessionResource.baseUrl,
    model: sessionResource.model,
    // Migrate the old 30-step / 200K-token defaults once. Anything else was a
    // deliberate choice and is preserved.
    maxSteps: migrateLimit(
      // 0 = 不限，上限跟循环里的硬天花板一致。
      normalizeConfiguredSteps(settingsRaw['maxSteps'], fallback.settings.maxSteps),
      30,
      fallback.settings.maxSteps,
    ),
    maxContextTokens: migrateLimit(
      clampNumber(
        settingsRaw['maxContextTokens'],
        fallback.settings.maxContextTokens,
        SETTING_CONTEXT_MIN,
        SETTING_CONTEXT_MAX,
      ),
      200_000,
      fallback.settings.maxContextTokens,
    ),
    maxTokens: Math.round(clampNumber(settingsRaw['maxTokens'], 0, 0, 20_000_000)),
    maxOutputTokens: clampNumber(
      settingsRaw['maxOutputTokens'],
      fallback.settings.maxOutputTokens,
      SETTING_OUTPUT_MIN,
      SETTING_OUTPUT_MAX,
    ),
    temperature: clampNumber(settingsRaw['temperature'], fallback.settings.temperature, 0, 1),
    autoReflect: settingsRaw['autoReflect'] !== false,
    autoEvolve: settingsRaw['autoEvolve'] === true,
    // Missing means a legacy state written before this setting existed; keep
    // the product default (on). An explicit false still wins.
    autoContinue: settingsRaw['autoContinue'] !== false,
    autoContinueLimit: Math.round(
      clampNumber(settingsRaw['autoContinueLimit'], fallback.settings.autoContinueLimit, 1, 10),
    ),
    screenshotFeedback: settingsRaw['screenshotFeedback'] !== false,
    testTargets: normalizeTestTargets(settingsRaw['testTargets']),
    testCaptchaMode:
      settingsRaw['testCaptchaMode'] === 'fixture' || settingsRaw['testCaptchaMode'] === 'header'
        ? settingsRaw['testCaptchaMode']
        : 'off',
    testCaptchaCipher:
      typeof settingsRaw['testCaptchaCipher'] === 'string' && settingsRaw['testCaptchaCipher']
        ? settingsRaw['testCaptchaCipher']
        : null,
    testCaptchaPlain: settingsRaw['testCaptchaPlain'] === true,
    reflectEnabled: settingsRaw['reflectEnabled'] === true,
    reflectModelId: normalizeOptionalText(settingsRaw['reflectModelId'], 120),
    reflectTriggers: normalizeReflectionTriggers(settingsRaw['reflectTriggers']),
    reflectScheduleMode: resolveReflectionScheduleMode(settingsRaw),
    reflectScheduleModePinned: settingsRaw['reflectScheduleModePinned'] === true,
    reflectIntervalMinutes: clampReflectionInterval(settingsRaw['reflectIntervalMinutes']),
    reflectDailyTime: normalizeReflectionTime(settingsRaw['reflectDailyTime']),
    reflectTopics: normalizeReflectionTopics(settingsRaw['reflectTopics']),
    reflectLastRunAt: normalizeOptionalText(settingsRaw['reflectLastRunAt'], 40),
    reflectLastVersion: normalizeOptionalText(settingsRaw['reflectLastVersion'], 40),
    // 反思发信字段是「用户自己填」的：出厂既没有邮箱地址也没有 SMTP 主机。
    // 老存档把邮箱拆在 reflectEmailTo / reflectSmtpUser / reflectEmailFrom 三个键里，
    // 合并成一个字段时按这个顺序取第一个非空值；否则升级后用户的邮箱会凭空消失。
    // 旧版写进存档的产品方预置邮箱（连同它的 163 主机）在这里清掉，视为没配置。
    reflectEmailEnabled:
      typeof settingsRaw['reflectEmailEnabled'] === 'boolean'
        ? settingsRaw['reflectEmailEnabled']
        : fallback.settings.reflectEmailEnabled,
    // 邮件通知是后来才有的：老存档只有 reflectEmailEnabled，升级时只继承
    // 「反思报告」这一项，否则用户邮箱会突然被任务完成之类的邮件撬开。
    notifyEmailEnabled:
      typeof settingsRaw['notifyEmailEnabled'] === 'boolean'
        ? settingsRaw['notifyEmailEnabled']
        : 'reflectEmailEnabled' in settingsRaw
          ? settingsRaw['reflectEmailEnabled'] === true
          : fallback.settings.notifyEmailEnabled,
    notifyEmailEvents:
      'notifyEmailEvents' in settingsRaw
        ? normalizeNotifyEmailEvents(settingsRaw['notifyEmailEvents'])
        : 'reflectEmailEnabled' in settingsRaw
          ? settingsRaw['reflectEmailEnabled'] === true
            ? ['reflect.report']
            : []
          : fallback.settings.notifyEmailEvents,
    reflectEmailTo: rescueMailbox
      ? LEGACY_PRODUCT_MAILBOX
      : legacyProductMail
        ? ''
        : mergedMailbox,
    reflectSmtpHost: rescueMailbox
      ? LEGACY_PRODUCT_SMTP_HOST
      : legacyProductMail && mergedSmtpHost.toLowerCase() === LEGACY_PRODUCT_SMTP_HOST
        ? ''
        : mergedSmtpHost,
    reflectMailboxRestored: rescueMailbox || settingsRaw['reflectMailboxRestored'] === true,
    reflectSmtpPort: clampSmtpPort(settingsRaw['reflectSmtpPort'] ?? fallback.settings.reflectSmtpPort),
    reflectSmtpSecurity:
      settingsRaw['reflectSmtpSecurity'] === undefined || settingsRaw['reflectSmtpSecurity'] === null
        ? fallback.settings.reflectSmtpSecurity
        : normalizeSmtpSecurity(settingsRaw['reflectSmtpSecurity']),
    reflectSmtpPasswordCipher:
      typeof settingsRaw['reflectSmtpPasswordCipher'] === 'string' &&
      settingsRaw['reflectSmtpPasswordCipher']
        ? settingsRaw['reflectSmtpPasswordCipher']
        : null,
    reflectSmtpPasswordPlain: settingsRaw['reflectSmtpPasswordPlain'] === true,
    approvalTimeoutSec: Math.round(
      clampNumber(settingsRaw['approvalTimeoutSec'], fallback.settings.approvalTimeoutSec, 0, 3_600),
    ),
    // Missing means a fresh store: start with Shell mode enabled. An explicit
    // false written by the user is preserved.
    shellMode: settingsRaw['shellMode'] !== false,
    shellInterpreter: validShellInterpreter(settingsRaw['shellInterpreter']) ?? 'auto',
    defaultApprovalMode: normalizeApprovalMode(settingsRaw['defaultApprovalMode']),
    permissionRules: sanitizePermissionRules(settingsRaw['permissionRules']),
    trustedCommands: sanitizeCommandList(settingsRaw['trustedCommands']),
    // Classification runs on the session endpoint, so its model follows that
    // resource instead of preserving a name from the single-endpoint era.
    classifierModel: sessionResource.model,
    reviewModel: reviewModelId
      ? (modelResources.find((resource) => resource.id === reviewModelId)?.model ?? '')
      : '',
    modelResources,
    sessionModelId,
    evaluationModelIds,
    reviewModelId,
    judgeProviders: evaluationResources.map((resource) => ({
      id: resource.id,
      label: resource.label,
      baseUrl: resource.baseUrl,
      model: resource.model,
      enabled: resource.enabled,
      keyCipher: resource.keyCipher,
      keyPlain: resource.keyPlain,
    })),
    sandboxMode: settingsRaw['sandboxMode'] === 'auto' ? 'auto' : 'off',
    sandboxNetwork: settingsRaw['sandboxNetwork'] === true,
    sandboxAutoAllow: settingsRaw['sandboxAutoAllow'] !== false,
    allowUnattendedBuild: settingsRaw['allowUnattendedBuild'] === true,
    // 缺省即关：这是一个把多条限制一起放开的档位，必须由用户显式打开。
    fullAutonomy: settingsRaw['fullAutonomy'] === true,
    learningMode: settingsRaw['learningMode'] === true,
    // 缺省即关：联网是任务会话的常规能力，学习模式不接管它。
    learningShellIsolation: settingsRaw['learningShellIsolation'] === true,
    // 缺省即关：打开它等于把一个可被浏览器驱动的入口挂到端口上。
    serverMode: settingsRaw['serverMode'] === true,
    serverPort: normalizeServerPort(settingsRaw['serverPort']),
    learningHosts: Array.isArray(settingsRaw['learningHosts'])
      ? (settingsRaw['learningHosts'] as unknown[])
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .slice(0, 64)
      : [],
    ...(() => {
      const selfSource = normalizeSelfSourceSettings({
        mode: settingsRaw['selfSourceMode'],
        gitUrl: settingsRaw['selfSourceGitUrl'],
        gitRef: settingsRaw['selfSourceGitRef'],
        gitPath: settingsRaw['selfSourceGitPath'],
        customPath: settingsRaw['selfSourceCustomPath'],
      })
      return {
        selfSourceMode: selfSource.mode,
        selfSourceGitUrl: selfSource.gitUrl,
        selfSourceGitRef: selfSource.gitRef,
        selfSourceGitPath: selfSource.gitPath,
        selfSourceCustomPath: selfSource.customPath,
      }
    })(),
    qualityGate: settingsRaw['qualityGate'] === true,
    qualityPublishTarget: normalizeQualityPublishTarget(settingsRaw['qualityPublishTarget']),
    qualityTuneEvery: clampNumber(settingsRaw['qualityTuneEvery'], 5, 0, 50),
    checkpointRetention: Math.round(
      clampNumber(settingsRaw['checkpointRetention'], fallback.settings.checkpointRetention, 5, 100),
    ),
    checkpointMaxBytes: Math.round(
      clampNumber(
        settingsRaw['checkpointMaxBytes'],
        fallback.settings.checkpointMaxBytes,
        512 * 1024 * 1024,
        20 * 1024 * 1024 * 1024,
      ),
    ),
    checkpointShell: settingsRaw['checkpointShell'] !== false,
    checkpointIgnore: normalizeCheckpointIgnore(settingsRaw['checkpointIgnore']),
    notifyDesktop: settingsRaw['notifyDesktop'] !== false,
    hooksEnabled: settingsRaw['hooksEnabled'] === true,
    mcpEnabled: settingsRaw['mcpEnabled'] === true,
    relayUrl: normalizeRelayUrl(settingsRaw['relayUrl']) ?? '',
    phoneRoots: normalizePhoneRoots(settingsRaw['phoneRoots']),
    /** Only `dark` and `light` are stored; anything else falls back to `dark`. */
    theme: isThemeMode(settingsRaw['theme']) ? settingsRaw['theme'] : 'dark',
    fontSize: isFontSizePreference(settingsRaw['fontSize']) ? settingsRaw['fontSize'] : 'standard',
    locale: isLocaleSetting(settingsRaw['locale']) ? settingsRaw['locale'] : 'auto',
    apiKeyCipher: sessionResource.keyCipher,
    apiKeyPlain: sessionResource.keyPlain,
  }
  const workspaces = (Array.isArray(record['workspaces']) ? record['workspaces'] : [])
    .map(sanitizeWorkspace)
    .filter((workspace): workspace is PersistedWorkspace => Boolean(workspace))
  const sessions =
    presetSessions ??
    (Array.isArray(record['sessions']) ? record['sessions'] : [])
      .map(sanitizeSession)
      .filter((session): session is Session => Boolean(session))
  const sessionIds = new Set(sessions.map((session) => session.id))
  const scheduled = (Array.isArray(record['scheduled']) ? record['scheduled'] : [])
    .map(sanitizeScheduledTask)
    .filter(
      (task): task is ScheduledTask =>
        task !== null && sessionIds.has(task.sessionId),
    )
    .slice(0, 500)
  settleStalePlans(workspaces, sessions)
  const activeWorkspaceRaw =
    typeof record['activeWorkspace'] === 'string' ? record['activeWorkspace'] : null
  const activeWorkspace =
    activeWorkspaceRaw && workspaces.some((workspace) => workspace.path === activeWorkspaceRaw)
      ? activeWorkspaceRaw
      : null
  const activeSessionRaw =
    typeof record['activeSession'] === 'string' ? record['activeSession'] : null
  const activeSession =
    activeSessionRaw &&
    sessions.some(
      (session) =>
        session.id === activeSessionRaw &&
        (!activeWorkspace || session.workspacePath === activeWorkspace),
    )
      ? activeSessionRaw
      : null
  const globalProfiles = (Array.isArray(record['globalProfiles']) ? record['globalProfiles'] : [])
    .map(sanitizeProfile)
    .filter((profile): profile is ProfileVersion => Boolean(profile))
    .slice(0, 40)
  const evolutionPolicy = sanitizeEvolutionPolicy(record['evolutionPolicy'])
  // 进化记录不再按条数裁剪：用户要求「保留全部，除非主动清理」，所以这里
  // 只做字段净化，条数由用户自己决定。
  const evolutionPolicyVersions = (
    Array.isArray(record['evolutionPolicyVersions']) ? record['evolutionPolicyVersions'] : []
  )
    .map(sanitizeEvolutionPolicyVersion)
    .filter((version): version is EvolutionPolicyVersion => Boolean(version))
  const evolutionCycles = (Array.isArray(record['evolutionCycles']) ? record['evolutionCycles'] : [])
    .map(sanitizeEvolutionCycle)
    .filter((cycle): cycle is EvolutionCycle => Boolean(cycle))
  const quality = sanitizeQualityState(record['quality'])
  // 反思报告只留最近的若干份：它是“快照”而非账本，旧报告留太多只会胀大状态文件。
  const reflectionReports = (Array.isArray(record['reflectionReports']) ? record['reflectionReports'] : [])
    .map(sanitizeReflectionReport)
    .filter((report): report is ReflectionReport => Boolean(report))
    .slice(0, MAX_REFLECTION_REPORTS)
  // A missing field means "never customized" (null), while an empty array is
  // an explicit choice to show no quick prompts.
  const quickSeen = new Set<string>()
  const quickIds = new Set<string>()
  const quickCommands = Array.isArray(record['quickCommands'])
    ? (record['quickCommands'] as unknown[])
        .map(sanitizeQuickCommand)
        .filter((command): command is QuickCommand => {
          if (!command || quickSeen.has(command.content)) return false
          quickSeen.add(command.content)
          if (quickIds.has(command.id)) command.id = randomUUID()
          quickIds.add(command.id)
          return true
        })
        .slice(0, MAX_QUICK_COMMANDS)
    : null

  return {
    version: STATE_VERSION,
    settings,
    workspaces,
    globalProfiles,
    evolutionPolicy,
    evolutionPolicyVersions,
    evolutionCycles,
    quality,
    reflectionReports,
    reflectLastScheduledAt:
      typeof record['reflectLastScheduledAt'] === 'string' && record['reflectLastScheduledAt']
        ? record['reflectLastScheduledAt']
        : null,
    sessions,
    scheduled,
    quickCommands,
    activeWorkspace,
    activeSession,
  }
}

export function validApprovalMode(value: unknown): ApprovalMode | null {
  if (
    value === 'auto' ||
    value === 'manual' ||
    value === 'ask' ||
    value === 'acceptEdits' ||
    value === 'plan' ||
    value === 'dontAsk'
  ) {
    return normalizeApprovalMode(value)
  }
  return null
}

export function validTheme(value: unknown): ThemeMode | null {
  return isThemeMode(value) ? value : null
}

export function validFontSize(value: unknown): FontSizePreference | null {
  return value === 'standard' || value === 'large' || value === 'xlarge' ? value : null
}

export function validShellInterpreter(value: unknown): ShellInterpreter | null {
  return value === 'auto' || value === 'cmd' || value === 'bash' || value === 'wsl'
    ? value
    : null
}

/**
 * Cap on the stored compaction summary. It rides in the session index so a
 * lazily loaded session can answer "what did we already fold away?" without
 * reading its shard, which means it is paid for by every session listing; 4k
 * characters matches the digest cap and is far below the 8k a summarizer may
 * return.
 */
export const CONTEXT_SUMMARY_MAX_CHARS = 4_000

/** Fields kept in the per-session shard and hydrated on demand (never in the index). */
export const BODY_KEYS = ['messages', 'queue', 'todos', 'memoryIds'] as const
export const SEARCH_INDEX_MIN_INTERVAL_MS = 5_000

export interface SessionBodyRef {
  loaded: boolean
  /** True when the shard could not be read: never overwrite it with an empty body. */
  broken?: boolean
  /** How many messages the append-only transcript already contains. */
  messagesOnDisk?: number
  /** Set when the shard still embeds messages (version-1 layout). */
  legacyMessages?: boolean
  /** Set when history was edited or truncated; the transcript must be rewritten. */
  rewriteMessages?: boolean
}

