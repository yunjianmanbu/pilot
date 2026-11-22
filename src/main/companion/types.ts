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
  RevertChangeResult,
  RunEvent,
  SessionChange,
  UpdateState,
} from '../../shared/types'
import type { HostCapabilities } from '../../shared/capabilities'
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
  pairedAt: string
  lastSeen: string | null
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
}

/** A `pair.join` frame parked until the desktop user answers it. */
export interface PendingPairing {
  request: CompanionPairRequest
  /** Socket that asked, so a disconnect withdraws the request. */
  connection: ClientConnection
  /** Resolve with the user's answer; `reason` explains a rejection. */
  resolve: (decision: { approved: boolean; reason?: string }) => void
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

export interface CompanionOptions {
  store: Store
  runner: AgentRunner
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
