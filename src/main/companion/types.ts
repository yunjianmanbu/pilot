/**
 * Types shared by the companion service, its host adapters and the relay socket.
 *
 * `server.ts` keeps only the `CompanionServer` class; these declarations live
 * here so the wire state, the host adapter surface and the phone payloads can be
 * read without scrolling through three thousand lines of flow code.
 */
import type {
  Checkpoint,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  CompanionPairRequest,
  CompanionPhone,
  CompanionStatus,
  EvolutionSnapshot,
  ModelBillingReport,
  ModuleCheckReport,
  ModuleCheckSettings,
  ModuleCheckState,
  ModuleTarget,
  PersonalEvolutionState,
  ReflectionSmtpSecurity,
  RevertChangeResult,
  RunEvent,
  SessionChange,
  SettingsUpdate,
  UpdateState,
} from '../../shared/types'
import type { HostCapabilities } from '../../shared/capabilities'
import type { AccessLevel } from './access-level'
import type { NotifyEventDef, NotifyEventId } from '../../shared/notify-events'
import type {
  ReflectionEmailState,
  ReflectionFinding,
  ReflectionFindingStatus,
  ReflectionReport,
  ReflectionScheduleMode,
  ReflectionTrigger,
  ReflectionTriggers,
  ReflectionTopicId,
} from '../../shared/reflect'
import type { ModuleCheckSummary } from '../../shared/module-check'
import type { SelfCheckReport } from '../../shared/self-check'
import type { LearningEntry, LearningSummary } from '../agent/learning'
import type { AgentRunner } from '../agent/runner'
import type { Store } from '../store'
import type { KeyPair } from './crypto'
import type { RelayHostChannel } from './relay'
import type { RelaySocket } from './relay-socket'

export interface StoredPhone {
  phoneId: string
  name: string
  platform: string
  tokenHash: string
  /**
   * Sealed pairing token. New pairings seal it so the desktop can verify a
   * challenge-response proof without the relay ever seeing the token.
   */
  tokenSealed?: string
  pcToPhone: string
  phoneToPc: string
  outSeq: number
  inSeq: number
  /** 这对密钥与凭据是怎么来的，决定这台设备能否管理电脑本身。 */
  via?: 'qr' | 'browser'
  /**
   * 浏览器直连时的身份：`host` 与本机一致（同一份数据、全部权限），
   * `client` 是独立用户（独立数据、只有客户端权限）。旧记录无此字段，
   * 按 `client` 处理：宁可少给，不可误放行。
   */
  role?: 'host' | 'client'
  pairedAt: string
  lastSeen: string | null
  /**
   * 浏览器会话的来源地址。手机记录里 `phoneId` 就是设备身份，这里只给网页
   * 服务记录下来源 IP：设置页要能告诉用户「哪台机器什么时候拿到了权限」。
   */
  address?: string
  /** Cloud connector room. One room per phone keeps host framing simple. */
  relayRoom?: string
  relayKey?: string
  /**
   * Relay endpoint the phone paired against. Kept so the desktop can show a
   * warning and offer a one-click restore if the relay setting is ever lost;
   * it is never dialled without the user's action.
   */
  relayUrl?: string
}

export interface CompanionState {
  version: 1
  enabled: boolean
  deviceId: string
  port: number
  phones: Record<string, StoredPhone>
}

export interface PairingOffer {
  lookup: string
  secret: string
  keys: KeyPair
  expiresAt: number
  room: string
  roomKey: string
  /** 由已配对手机申请的换机二维码：扫码直接配对，不问电脑端。 */
  autoApprove: boolean
  /** 浏览器页面申请的一次性凭据（无二维码），存放在 accessOffers 里。 */
  viaAccess?: boolean
  /**
   * 这次接入的身份。回环地址刚签发就是 `host`（＝本机）；远端页面可以请求
   * `host`，但要等本机审批时确认，审批前不会生效。
   */
  role?: 'host' | 'client'
}

/**
 * 网页服务凭据申请：远端浏览器打开桌面界面后先要一张 ticket，本机审批通过
 * 才把 bridge token 发给它。放在内存里，进程重启即失效。
 */
export interface PageTicket {
  id: string
  /** 申请来源地址，只有同一来源能取走审批结果。 */
  address: string
  createdAt: number
  expiresAt: number
  state: 'pending' | 'approved' | 'denied' | 'expired'
  token?: string
  role?: 'host' | 'client'
  reason?: string
}

/** A `pair.join` frame parked until the desktop user answers it. */
export interface PendingPairing {
  request: CompanionPairRequest
  /**
   * Socket that asked, so a disconnect withdraws the request. Absent for a
   * request made over plain HTTP (the web console asks for a bridge ticket and
   * has no socket yet), which is withdrawn by its own timer instead.
   */
  connection?: ClientConnection
  /** Resolve with the user's answer; `reason` explains a rejection. */
  resolve: (decision: { approved: boolean; reason?: string; role?: 'host' | 'client' }) => void
}

export interface ConnectionSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface ClientConnection {
  socket: ConnectionSocket
  authed: boolean
  phoneId: string | null
  alive: boolean
  missedPongs?: number
  pairAttempts: number
  openedAt: number
  /** How this socket reached the desktop, shown in the approval prompt. */
  via: 'lan' | 'relay'
  /** Socket address for a LAN connection; null through the relay. */
  address: string | null
  pendingPhoneId?: string
  challenge?: string
  challengeAt?: number
  /**
   * `/bridge` 连接：浏览器里的桌面界面，走 IPC 直通而不是手机配对协议。
   * 不填表示普通手机/PWA 连接。
   */
  surface?: 'phone' | 'bridge'
  /** bridge 连接的访问级别；`client` 不接桌面界面。 */
  bridgeLevel?: AccessLevel
  /** bridge 连接同时在飞的 IPC 请求数，超过上限直接拒绝。 */
  bridgeInflight?: { count: number }
  protocol?: number
}

export interface RelayRoom {
  channel: RelayHostChannel
  sockets: Map<string, RelaySocket>
}

export interface PendingUpload {
  uploadId: string
  workspacePath: string
  tempPath: string
  name: string
  size: number
  received: number
  createdAt: number
}

/** 远端访问者的两种身份；本机访问不走这里。 */
export type CompanionRole = 'host' | 'client'

/** 一条请求能用到的数据面。 */
export interface CompanionScope {
  role: CompanionRole
  store: Store
  runner: AgentRunner
  billing: CompanionOptions['billing']
  checkpoints?: NonNullable<CompanionOptions['checkpoints']>
  changes?: NonNullable<CompanionOptions['changes']>
}

export interface CompanionOptions {
  store: Store
  runner: AgentRunner
  /**
   * 客户机用户（`role: 'client'`）专用的第二套数据面。不提供时，客户机请求
   * 退回主机数据面——但那会让远端看到本机会话，所以宿主应当总是提供：
   * 建第二份 Store + AgentRunner，数据目录分开。
   */
  guest?: Partial<CompanionScope>
  dataDir: string
  assetsDir: string
  deviceName: string
  appVersion: string
  /** Cloud connector URL. Empty string disables the cloud path (LAN only). */
  relayUrl?: string
  /** Public phone-app URL used by the pairing QR code. */
  appUrl?: string
  /**
   * Fixed listening port. Server mode passes the CLI value instead of the
   * persisted `companion.json` port.
   */
  port?: number
  /** Fail loudly on EADDRINUSE instead of silently using a random port. */
  strictPort?: boolean
  /**
   * Which surface the panel is painted for. Server mode (`pilot serve`) passes
   * `desktop` so the browser console matches the PC client; the desktop app
   * leaves it unset and keeps the phone PWA look for `companion` access.
   */
  surface?: 'desktop' | 'phone'
  /** Listen address. Defaults to 0.0.0.0; server mode passes --host through. */
  host?: string
  /**
   * `pilot serve` 的浏览器桌面界面产物目录（构建后的 `out/web`）。
   * 只有它存在、且 `surface==='desktop'` 时，不带配对参数的 `/` 才返回桌面
   * 客户端界面；手机扫码（`?p=`）依旧拿 PWA。
   */
  desktopDir?: string
  /**
   * 桌面客户端自己托管网页服务时要「关掉开关就真的关掉」。
   *
   * 关掉网页服务但手机连接还开着时，服务实例仍在监听同一端口（两个开关共用一个
   * 监听）。没有这道门，浏览器刷新照旧能拿到桌面界面——用户以为关了，其实没关。
   * 置为 true 后，桌面界面与 `/bridge/ticket` 都要求 `settings.serverMode` 为真，
   * 手机面板（`/pwa/`）与 `/media/` 不受影响。`pilot serve` 不设，因为它没有这
   * 个开关。
   */
  desktopRequiresServerMode?: boolean
  /**
   * 服务器模式把主进程的 IPC 表暴露给浏览器桌面界面。桌面应用不提供，
   * 因此那里始终只有 preload 的 `ipcRenderer` 这一条入口。
   */
  ipc?: {
    invoke(channel: string, args: unknown[]): Promise<unknown>
    channels?(): string[]
  }
  /**
   * Externally reachable base URL (for example `https://pilot.example.com/`).
   * Headless deployments build pairing links and WebSocket addresses from it
   * instead of the machine's LAN address.
   */
  publicBaseUrl?: string
  /** Android APK download page used by the app-download QR code. */
  appDownloadUrl?: string
  /**
   * Workspace whose `.pilot/plugins` are served. Server mode passes the
   * `--workspace` path; the desktop app falls back to the active workspace.
   */
  pluginRoot?: string
  /** Balance and local cost estimate for the configured model. */
  billing: {
    report(refresh?: boolean): Promise<ModelBillingReport>
    /** Drop cached balances after the phone changes model roles. */
    invalidate?(): void
  }
  /**
   * Desktop in-app updater. The paired phone may check, download and install,
   * because it can already drive the agent; installation is still blocked
   * while any agent run is active.
   */
  update?: {
    state(): UpdateState
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
  }
  /**
   * Snapshot access for the paired phone. Optional so a host without the
   * checkpoint service still accepts `sessions.delete`.
   */
  checkpoints?: {
    removeSession(sessionId: string): Promise<void>
    list(sessionId: string): Promise<Checkpoint[]>
    create(sessionId: string, label?: string): Promise<Checkpoint>
    restore(
      sessionId: string,
      checkpointId: string,
      mode: CheckpointRestoreMode,
    ): Promise<CheckpointRestoreResult>
  }
  /**
   * Per-file change review. Optional for hosts that only run the companion
   * server without the desktop checkout services.
   */
  changes?: {
    list(sessionId: string): Promise<SessionChange[]>
    revert(sessionId: string, path: string): Promise<RevertChangeResult>
  }
  /**
   * Module self-check. Optional so older hosts answer with a clear message
   * instead of failing the whole protocol. Scans are read-only; `accept`
   * creates a normal coding session, so it keeps the same sandbox/approval
   * path as a user-written task.
   */
  moduleCheck?: {
    /** 扫描根（内置源码目录），只用于展示；旧宿主仍可返回 `workspace`。 */
    source?(): string | null
    /**
     * 手机只需要摘要；宿主应优先返回 `ModuleCheckSummary`，避免每次都把
     * 最多 20 份历史报告深拷贝一遍。完整状态仍然接受，兼容旧宿主。
     */
    state(): Promise<ModuleCheckSummary | ModuleCheckState>
    discover(): Promise<ModuleTarget[]>
    run(moduleIds?: string[]): Promise<ModuleCheckReport>
    settings(input: Partial<ModuleCheckSettings>): Promise<ModuleCheckState>
    /**
     * `selfModify` 必须由用户显式勾选；不传时只生成提案，不建会话、不改源码。
     */
    accept(
      reportId: string,
      riskIds: string[],
      selfModify: boolean,
    ): Promise<{ sessionId?: string; queued: boolean; selfModify: boolean; proposalId: string }>
  }
  /**
   * 内视：只读采样宿主正在运行的各项服务，不接收任何路径参数。
   * 旧宿主不支持时手机端会收到明确提示，而不是报“无响应”。
   */
  selfCheck?: {
    run(): Promise<SelfCheckReport>
  }
  /**
   * What this host can do. The panel hides or greys what it cannot, instead of
   * offering a control that fails with a version-too-old message. Defaults to
   * the desktop set, which is what every host did before this flag existed.
   */
  capabilities?: HostCapabilities
  /**
   * Self-evolution controls. The adapter keeps long-running work off the
   * request path: cycle/policy actions return immediately and report through
   * `evolution.changed`, mirroring the desktop panel. A host that cannot run
   * them (no bundled source tree, no model key) leaves this out and declares
   * `capabilities.evolution = false` instead.
   */
  evolution?: {
    snapshot(workspacePath: string): Promise<EvolutionSnapshot>
    personal(): Promise<{
      state: PersonalEvolutionState
      busy: string | null
      hasKey: boolean
    }>
    action(action: string, params: Record<string, unknown>): Promise<unknown>
  }
  /**
   * Reflection (self-questioning). The phone shares the desktop store, so it can
   * read the settings, trigger one reflection, send a test mail and clear the
   * reports. The SMTP password never leaves the main process: the view carries
   * `hasPassword` only, and an empty string on write keeps the stored code.
   * A host without a reflection service leaves this out and the panel answers
   * with a version-too-old message instead.
   */
  reflect?: {
    state(): PhoneReflectState
    /** Writes through `store.updateSettings` and returns the fresh view. */
    update(input: SettingsUpdate): Promise<PhoneReflectState>
    /** One manual reflection; the caller does not wait for it. */
    run(): Promise<unknown>
    testMail(to: string): Promise<{ ok: boolean; error?: string }>
    clearReports(): Promise<PhoneReflectState>
    /**
     * 标记一条结论的处理状态，返回更新后的报告详情。
     * 手机上看完结论就能标「已处理 / 不打算做」，下一轮反思据此不重复提同一条。
     */
    setFindingStatus(
      reportId: string,
      findingId: string,
      status: ReflectionFindingStatus,
    ): Promise<PhoneReflectReport>
  }
  onStatus: (status: CompanionStatus) => void
  /** Mirror phone-initiated changes to the desktop window. */
  onEvent?: (event: RunEvent) => void
  /** How long a phone waits for the desktop answer. Defaults to 60 seconds. */
  pairApprovalTtlMs?: number
}

export interface PhoneModuleCheckReport extends ModuleCheckReport {
  /** Full number of risks before the phone payload is trimmed. */
  riskTotal: number
  riskCounts: { high: number; medium: number; low: number }
}

/**
 * The phone only needs the latest report and the settings. History can hold 20
 * reports and would make a single encrypted frame too large.
 */
/** 手机只需要提案的概要与预览片段，不需要整段指令原文。 */
export interface PhoneModuleProposal {
  id: string
  reportId: string
  createdAt: string
  riskIds: string[]
  prompt: string
  promptTruncated: boolean
  selfModify: boolean
  sessionId?: string
  refreshedAt?: string
}

export interface PhoneModuleCheckState {
  settings: ModuleCheckState['settings']
  lastRunAt?: string
  nextRunAt?: string
  lastReport?: PhoneModuleCheckReport
  historyCount: number
  decisions: ModuleCheckState['decisions']
  proposals: PhoneModuleProposal[]
}

/**
 * 手机端的自主探索学习状态：开关与白名单是电脑端全局设置，账本按工作区读取。
 * 只回传最近的记录和截断后的字段，完整账本仍留在 `.pilot/learning/ledger.jsonl`。
 */
export interface PhoneLearningState {
  enabled: boolean
  /** 用户显式配置的白名单；空数组表示使用内置默认站点。 */
  hosts: string[]
  /** 真正参与出域守门的主机（空配置时即默认站点）。 */
  effectiveHosts: string[]
  defaultHosts: string[]
  ledger: string
  entryTotal: number
  summary: LearningSummary
  entries: LearningEntry[]
}

export type { CompanionPhone }

/** 手机侧的反思配置；密码只以 `hasPassword` 出现。 */
export interface PhoneReflectSettings {
  enabled: boolean
  /** 空串表示跟随会话模型。 */
  modelId: string
  triggers: ReflectionTriggers
  scheduleMode: ReflectionScheduleMode
  intervalMinutes: number
  /** `HH:mm`，手机本地时区。 */
  dailyTime: string
  topics: ReflectionTopicId[]
  lastRunAt: string
  /** 上一次成功反思时的应用版本；`version` 模式下按它判断是否升级过。 */
  lastVersion: string
  /** 旧字段：只代表「反思报告」这一类通知，仅为旧版手机端保留。 */
  emailEnabled: boolean
  /** 唯一邮箱：收件人、SMTP 登录名与发件人。 */
  emailTo: string
  smtpHost: string
  smtpPort: number
  smtpSecurity: ReflectionSmtpSecurity
  hasPassword: boolean
  /** 邮件通知总开关：关掉则一条都不发。 */
  notifyEmailEnabled: boolean
  /** 已勾选的通知事件，按推荐优先级排列。 */
  notifyEmailEvents: NotifyEventId[]
  /** 通知项目录（与桌面共用同一份定义），顺序即推荐优先级。 */
  notifyCatalog: NotifyEventDef[]
}

/** 历史列表里的一份概要：不含发现正文，点开再用 `reflect.report` 取详情。 */
export interface PhoneReflectSummary {
  id: string
  createdAt: string
  trigger: ReflectionTrigger
  model: string
  topics: ReflectionTopicId[]
  summary: string
  findings: number
  severity: { high: number; medium: number; low: number }
  email: ReflectionEmailState | null
}

/** 单份报告详情（发现与依据按手机长度截断）。 */
export interface PhoneReflectReport {
  id: string
  createdAt: string
  trigger: ReflectionTrigger
  model: string
  topics: ReflectionTopicId[]
  /** 本轮因证据不足而没有交给模型的问题域；手机端也要能说明「为什么没问这个域」。 */
  skipped: ReflectionReport['skipped']
  summary: string
  findings: ReflectionFinding[]
  evidence: string
  durationMs: number
  email: ReflectionEmailState | null
}

export interface PhoneReflectState {
  settings: PhoneReflectSettings
  /** 一次反思正在跑：手机端据此显示进度并禁止重复触发。 */
  running: boolean
  reportTotal: number
  reports: PhoneReflectSummary[]
}
