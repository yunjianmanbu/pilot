import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { dirname, join, normalize, resolve } from 'node:path'
import { safeStorage } from 'electron'
import QRCode from 'qrcode'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  ApprovalMode,
  Checkpoint,
  CheckpointRestoreMode,
  CheckpointRestoreResult,
  CompanionPairRequest,
  CompanionPairing,
  CompanionPhone,
  CompanionStatus,
  EvolutionSnapshot,
  FileNode,
  FilePreview,
  KnowledgePair,
  MemoryEntry,
  MessageSearchFilter,
  MessageSearchHit,
  ModelBillingReport,
  ModuleCheckReport,
  ModuleCheckSettings,
  ModuleCheckState,
  ModuleTarget,
  PersonalEvolutionState,
  QuickCommand,
  QuickCommandInput,
  RevertChangeResult,
  RunEvent,
  ScheduledTaskInput,
  Session,
  SessionChange,
  SessionLink,
  SessionSummary,
  StoredMessage,
  SystemInfo,
  ToolCatalogEntry,
  UpdateState,
  WorkspaceSummary,
} from '../../shared/types'
import { DESKTOP_CAPABILITIES, type HostCapabilities } from '../../shared/capabilities'
import { sortRisks, type ModuleCheckSummary } from '../../shared/module-check'
import type { SelfCheckReport } from '../../shared/self-check'
import { normalizeRelayUrl, splitRelayUrl } from '../../shared/relay'
import { handlePluginHttp } from '../plugins/bridge'
import { PLUGIN_HTTP_PREFIX } from '../plugins/manifest'
import { PluginHost } from '../plugins/runtime'
import { collectSessionArtifacts } from '../agent/artifacts'
import {
  DEFAULT_LEARNING_HOSTS,
  normalizeLearningHostsInput,
  readLearningLedger,
  resolveLearningPolicy,
  summarizeLearning,
  type LearningEntry,
  type LearningSummary,
} from '../agent/learning'
import { DynamicToolRegistry } from '../agent/toolsmith'
import { filterLearningTools, pilotTools, RUN_SHELL } from '../agent/tools'
import { loadMcpConfig } from '../agent/mcp'
import { buildToolCatalog } from '../../shared/tools-catalog'
import { collectSessionLinks } from '../../shared/session-links'
import { sanitizeImages, sanitizeReferences } from '../agent/attachments'
import type { AgentRunner } from '../agent/runner'
import { buildKnowledgePairs, clipKnowledgePair } from '../search'
import { sandboxStatus } from '../sandbox'
import { systemInfo } from '../system-info'
import type { Store } from '../store'
import {
  abortWorkspaceUpload,
  appendWorkspaceUpload,
  assertInside,
  beginWorkspaceUpload,
  finishWorkspaceUpload,
  listDirectory,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
  previewFile,
  readFileChunk,
} from '../workspace'
import {
  createKeyPair,
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  fromBase64url,
  hashToken,
  randomId,
  randomLookup,
  randomSecret,
  randomToken,
  safeEqualHex,
  safeEqualText,
  tokenProof,
  type KeyPair,
} from './crypto'
import { RelayHostChannel, type RelayChannelState } from './relay'

const PROTOCOL_VERSION = 2
const STATE_VERSION = 1
const DEFAULT_PORT = 46_831
const DEFAULT_APP_URL = 'https://pilot.medpilot.cc/app/'
// 独立安卓 App 的固定下载入口；配对二维码仍然指向网页版，避免把 #p 载荷
// 拼到 APK 链接上。App 内的「扫一扫」直接读取配对二维码。
const APP_DOWNLOAD_URL = 'https://download.medpilot.cc/pilot/android/Pilot-latest.apk'
const PAIRING_TTL_MS = 5 * 60_000
/**
 * 换机二维码由已配对的手机经 E2E 通道申请，扫码即视为持有一次性凭证，
 * 不再等待电脑端点击确认；有效期因此缩短，并且只能使用一次。
 */
const TRANSFER_PAIRING_TTL_MS = 2 * 60_000
const PAIRING_MAX_ATTEMPTS = 6
/** How long a scanned QR code waits for the desktop user to click 允许. */
const PAIR_APPROVAL_TTL_MS = 60_000
/** Shown to a phone that scanned while another request is still unanswered. */
const PAIR_BUSY_REASON = '电脑端正在确认另一个配对请求，请稍后重新扫码'
const PAIR_EXPIRY_MS = 7 * 24 * 60 * 60_000
const HEARTBEAT_MS = 25_000
const SILENCE_MS = 75_000
// Mobile networks drop individual pongs; only a few misses in a row mean the
// socket is really gone. One missed pong used to kill healthy phone links.
const HEARTBEAT_MISS_LIMIT = 3
const CHALLENGE_TTL_MS = 15_000
const MAX_PAYLOAD = 1024 * 1024
const MAX_MESSAGE_CHARS = 32_000
/**
 * A full report can contain 60 modules × 8 rules, and the encrypted relay
 * envelope is much smaller than a local socket frame. Keep the highest-ranked
 * risks and summarize the rest with counts; the desktop still holds the full
 * report for the fix session.
 */
const PHONE_MODULE_RISK_LIMIT = 160
/**
 * 学习账本会随使用一直增长；手机只需要最近一段用于复盘，完整账本仍留在
 * 工作区。单条记录里的 URL、备注等也截断，避免一帧被长文本撑爆。
 */
const PHONE_LEARNING_ENTRY_LIMIT = 60
const PHONE_LEARNING_NOTE_LIMIT = 1_200
const PHONE_LEARNING_URL_LIMIT = 600
const PHONE_LEARNING_PATH_LIMIT = 300
const PHONE_LEARNING_TITLE_LIMIT = 500
// Phone uploads are chunked over the encrypted relay. The phone sends 128 KB
// source chunks (about 175 KB as base64); the server accepts up to 256 KB
// decoded so a future client can grow chunks without a protocol bump.
const UPLOAD_TTL_MS = 10 * 60_000
const MAX_PENDING_UPLOADS = 4
const MAX_UPLOAD_CHUNK_BASE64 = Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) * 4 + 4
// 知识库一次最多回传的字符总量（含指令与回复），保证加密后仍远低于中继帧上限。
const KNOWLEDGE_PAYLOAD_CHARS = 80_000
// 手机端「会话资源」预览同样按条数与字符预算裁剪：链接只回最近若干条，
// 工具描述截断且不回传 inputSchema，避免一帧被长文本撑爆。
const PHONE_LINK_LIMIT = 60
const PHONE_LINK_URL_CHARS = 2_000
const PHONE_TOOL_LIMIT = 120
const PHONE_TOOL_DESCRIPTION_CHARS = 320
// 手机端新建工作区：只接受单层目录名，由电脑端拼接到授权根目录里。
const WORKSPACE_NAME_MAX = 64
const WORKSPACE_NAME_INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f]/
const RESERVED_WORKSPACE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const LOOKUP_RE = /^[A-Za-z0-9_-]{22,128}$/
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{86}$/

interface StoredPhone {
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

interface CompanionState {
  version: 1
  enabled: boolean
  deviceId: string
  port: number
  phones: Record<string, StoredPhone>
}

interface PairingOffer {
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
interface PendingPairing {
  request: CompanionPairRequest
  /** Socket that asked, so a disconnect withdraws the request. */
  connection: ClientConnection
  /** Resolve with the user's answer; `reason` explains a rejection. */
  resolve: (decision: { approved: boolean; reason?: string }) => void
}

interface ConnectionSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

interface ClientConnection {
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

interface RelayRoom {
  channel: RelayHostChannel
  sockets: Map<string, RelaySocket>
}

interface PendingUpload {
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

interface PhoneModuleCheckReport extends ModuleCheckReport {
  /** Full number of risks before the phone payload is trimmed. */
  riskTotal: number
  riskCounts: { high: number; medium: number; low: number }
}

/**
 * The phone only needs the latest report and the settings. History can hold 20
 * reports and would make a single encrypted frame too large.
 */
/** 手机只需要提案的概要与预览片段，不需要整段指令原文。 */
interface PhoneModuleProposal {
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

interface PhoneModuleCheckState {
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
interface PhoneLearningState {
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

function nowIso(): string {
  return new Date().toISOString()
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Read a request body up to `limit` bytes. Reading stops as soon as the limit is
 * exceeded so a large upload cannot be buffered into memory.
 */
function readRequestBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > limit) {
        request.off('data', onData)
        request.resume()
        resolve(Buffer.concat(chunks).toString('utf8'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => finish()
    const onError = (error: Error): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      reject(error)
    }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

function cleanText(value: unknown, fallback: string, max: number): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max)
  return text || fallback
}

function clipOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 账本条目也来自工作区文件；手机端只拿截断后的安全副本。 */
function phoneLearningEntry(entry: LearningEntry): LearningEntry {
  const quality = Number(entry.quality)
  const bytes = Number(entry.bytes)
  return {
    at: String(entry.at || '').slice(0, 40),
    kind: entry.kind,
    id: String(entry.id || '').slice(0, 120),
    url: clipOptional(entry.url, PHONE_LEARNING_URL_LIMIT),
    path: clipOptional(entry.path, PHONE_LEARNING_PATH_LIMIT),
    host: clipOptional(entry.host, 253),
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined,
    title: clipOptional(entry.title, PHONE_LEARNING_TITLE_LIMIT),
    goal: clipOptional(entry.goal, PHONE_LEARNING_TITLE_LIMIT),
    sourceId: clipOptional(entry.sourceId, 120),
    taskId: clipOptional(entry.taskId, 120),
    verdict: entry.verdict,
    quality: Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : undefined,
    note: clipOptional(entry.note, PHONE_LEARNING_NOTE_LIMIT),
  }
}

function requireString(value: unknown, label: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  return value.trim().slice(0, max)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function seal(value: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `s1:${safeStorage.encryptString(value).toString('base64')}`
    }
  } catch {
    // Fall back to an unsealed base64 value.
  }
  return `p1:${Buffer.from(value, 'utf8').toString('base64')}`
}

function unseal(value: string): string {
  if (value.startsWith('s1:')) {
    return safeStorage.decryptString(Buffer.from(value.slice(3), 'base64'))
  }
  if (value.startsWith('p1:')) {
    return Buffer.from(value.slice(3), 'base64').toString('utf8')
  }
  throw new Error('Unknown sealed value')
}

function publicPhone(phone: StoredPhone, online: boolean): CompanionPhone {
  return {
    phoneId: phone.phoneId,
    name: phone.name,
    platform: phone.platform,
    online,
    pairedAt: phone.pairedAt,
    lastSeen: phone.lastSeen,
  }
}

/**
 * All usable IPv4 addresses, best first. Home LAN ranges outrank VPN/virtual
 * adapter ranges so pairing and welcome frames advertise the address a phone
 * on the same Wi-Fi can actually reach.
 */
function lanAddresses(): string[] {
  const candidates: Array<{ address: string; virtual: boolean }> = []
  const interfaces = networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    const virtual =
      /(vmware|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|tailscale|zerotier|loopback|\btap\b|\btun\b)/i.test(
        name,
      )
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      candidates.push({ address: entry.address, virtual })
    }
  }
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    return 3
  }
  candidates.sort((left, right) => {
    // A virtual adapter is a fallback, not a peer: even a 192.168.x address on
    // a VM host-only network is usually useless to the phone.
    return (
      rank(left.address) +
      (left.virtual ? 4 : 0) -
      (rank(right.address) + (right.virtual ? 4 : 0))
    )
  })
  const out: string[] = []
  for (const item of candidates) {
    if (!out.includes(item.address)) out.push(item.address)
  }
  return out
}

function preferredLanAddress(): string {
  return lanAddresses()[0] ?? '127.0.0.1'
}

/** Same host as `base`, but on the companion WebSocket path. */
function wsEndpoint(base: string): string {
  try {
    const url = new URL(base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/ws'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return base
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Mark the panel as the server-mode console and load the desktop shell styles.
 *
 * The CLI shares one asset directory with the phone PWA, so the switch has to
 * be per response instead of per file: `data-surface="desktop"` scopes every
 * rule in `desktop.css`, and the PWA (served by the desktop app) never sees
 * either the attribute or the extra stylesheet.
 */
function withDesktopSurface(html: string): string {
  const linked = html.includes('desktop.css')
    ? html
    : html.replace(
        /<\/head>/i,
        '  <link rel="stylesheet" href="./desktop.css" />\n  </head>',
      )
  // Pure black chrome matches the desktop window frame; the PWA keeps its own
  // tinted browser color.
  const themed = linked.replace(
    /<meta name="theme-color" content="[^"]*" \/>/i,
    '<meta name="theme-color" content="#000000" />',
  )
  return themed.replace(/<html\b([^>]*)>/i, (_match, attrs: string) => {
    if (/data-surface=/i.test(attrs)) return `<html${attrs}>`
    return `<html${attrs} data-surface="desktop">`
  })
}

const STATIC_ROUTES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/crypto.js': 'crypto.js',
  '/style.css': 'style.css',
  '/desktop.css': 'desktop.css',
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/icons/icon.svg': 'icons/icon.svg',
  '/icons/icon.png': 'icons/icon.png',
  '/icons/maskable.svg': 'icons/maskable.svg',
}

/**
 * A desktop-side virtual WebSocket backed by one phone socket on the cloud
 * connector. It implements just enough of the ws surface for handleConnection,
 * so LAN and cloud clients share exactly the same protocol path.
 */
class RelaySocket implements ConnectionSocket {
  readyState: number = WebSocket.OPEN
  private closed = false
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  constructor(
    private readonly channel: RelayHostChannel,
    private readonly cid: string,
  ) {}

  on(event: string, listener: (...args: unknown[]) => void): this {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener)
    return this
  }

  send(data: string): void {
    if (this.closed) return
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    this.channel.send(this.cid, frame)
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.channel.closePeer(this.cid, code, reason)
    this.closeFromPeer()
  }

  terminate(): void {
    this.close(1001, 'terminated')
  }

  ping(): void {
    // The cloud connector handles transport heartbeats. Keep the desktop
    // heartbeat loop happy without generating extra relay traffic.
    if (this.closed) return
    setImmediate(() => this.emit('pong'))
  }

  deliver(frame: unknown): void {
    if (this.closed) return
    this.emit('message', Buffer.from(JSON.stringify(frame), 'utf8'))
  }

  closeFromPeer(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  private emit(event: string, ...args: unknown[]): void {
    const listeners = this.listeners.get(event)
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener(...args)
      } catch {
        // Connection handlers are already defensive; one bad listener must not
        // stop the rest.
      }
    }
  }
}

export class CompanionServer {
  private readonly stateFile: string
  private state: CompanionState
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private offerTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private offer: PairingOffer | null = null
  private pendingPair: PendingPairing | null = null
  private pairApprovalTimer: NodeJS.Timeout | null = null
  private connections = new Set<ClientConnection>()
  private byPhone = new Map<string, ClientConnection>()
  private readonly phoneSockets = new Set<string>()
  private readonly relayRooms = new Map<string, RelayRoom>()
  private readonly pendingUploads = new Map<string, PendingUpload>()
  private relayError: string | null = null
  private appQrCache: { url: string; qrDataUrl: string } | null = null
  private lastError: string | null = null

  constructor(private readonly options: CompanionOptions) {
    this.stateFile = join(options.dataDir, 'companion.json')
    this.state = this.blankState()
  }

  /**
   * External plugins live next to the workspace they extend. The host is built
   * on first use so a workspace-less server does not create stray directories.
   */
  private pluginHostInstance: PluginHost | null = null

  private pluginHost(): PluginHost | null {
    if (this.pluginHostInstance) return this.pluginHostInstance
    const root = this.options.pluginRoot ?? this.options.store.activeWorkspace()
    if (!root) return null
    this.pluginHostInstance = new PluginHost({ root })
    return this.pluginHostInstance
  }

  private blankState(): CompanionState {
    return {
      version: STATE_VERSION,
      enabled: false,
      deviceId: randomUUID(),
      port: DEFAULT_PORT,
      phones: {},
    }
  }

  async init(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, 'utf8')
      const parsed = JSON.parse(raw) as Partial<CompanionState>
      if (parsed?.version === STATE_VERSION && parsed.phones && typeof parsed.phones === 'object') {
        this.state = {
          version: STATE_VERSION,
          enabled: parsed.enabled === true,
          deviceId:
            typeof parsed.deviceId === 'string' && parsed.deviceId
              ? parsed.deviceId
              : randomUUID(),
          port: clampInt(parsed.port, DEFAULT_PORT, 1024, 65_535),
          phones: parsed.phones,
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  async startIfEnabled(): Promise<void> {
    if (!this.state.enabled) return
    try {
      await this.start()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitStatus()
    }
  }

  private relayEndpoint(): { url: string; access: string } {
    const override = (this.options.relayUrl ?? '').trim()
    const raw = override || this.options.store.settingsView().relayUrl
    return splitRelayUrl(raw)
  }

  /** Relay endpoint without the admission code: safe to show and to log. */
  private relayUrl(): string {
    return this.relayEndpoint().url
  }

  /**
   * L1 admission code (`id:secret`) from the connection string's `#k=`.
   * Empty when the connector runs open, which is the 0.2.2 behaviour.
   */
  private relayAccess(): string {
    return this.relayEndpoint().access
  }

  private relaySource(): 'env' | 'settings' | 'none' {
    if ((this.options.relayUrl ?? '').trim()) return 'env'
    return this.options.store.settingsView().relayUrl.trim() ? 'settings' : 'none'
  }

  private appBaseUrl(): string {
    return (this.options.appUrl ?? DEFAULT_APP_URL).trim()
  }

  /** Normalized externally reachable base URL, or '' when not configured. */
  private publicBaseUrl(): string {
    const raw = (this.options.publicBaseUrl ?? '').trim()
    if (!raw) return ''
    try {
      const url = new URL(raw)
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
      return url.toString()
    } catch {
      return ''
    }
  }

  /** Bind address for the control panel; invalid values fall back to 0.0.0.0. */
  private listenHost(): string {
    const host = (this.options.host ?? '').trim()
    return host || '0.0.0.0'
  }

  /**
   * Host a paired device should dial. A wildcard bind uses the preferred LAN
   * address; an explicit bind address is used as is, because a server bound to
   * 127.0.0.1 is not reachable over the LAN.
   */
  private addressHost(): string {
    const bound = this.listenHost()
    if (bound === '0.0.0.0' || bound === '::' || bound === '::0') return preferredLanAddress()
    return bound
  }

  status(): CompanionStatus {
    const phones = Object.values(this.state.phones)
      .map((phone) => publicPhone(phone, this.phoneSockets.has(phone.phoneId)))
      .sort((left, right) => right.pairedAt.localeCompare(left.pairedAt))
    const active = this.activeOffer()
    const port = this.listeningPort()
    const relayConnected = [...this.relayRooms.values()].some((room) => room.channel.connected)
    const cloudRecords = Object.values(this.state.phones).filter((phone) =>
      Boolean(phone.relayRoom),
    )
    const lastRelayUrl =
      cloudRecords
        .slice()
        .sort((left, right) => right.pairedAt.localeCompare(left.pairedAt))
        .map((phone) => normalizeRelayUrl(phone.relayUrl) ?? '')
        .find(Boolean) ?? null
    return {
      enabled: this.state.enabled,
      running: Boolean(this.server && port),
      address: this.server && port ? `http://${this.addressHost()}:${port}` : null,
      port,
      deviceId: this.state.deviceId,
      deviceName: this.options.deviceName,
      phones,
      pairingActive: Boolean(active),
      pairingExpiresAt: active ? new Date(active.expiresAt).toISOString() : null,
      pairingRequest: this.pendingPair?.request ?? null,
      appUrl: this.appBaseUrl() || null,
      relayUrl: this.relayUrl() || null,
      relayAccess: Boolean(this.relayAccess()),
      relaySource: this.relaySource(),
      cloudPhones: cloudRecords.length,
      lastRelayUrl,
      relayConnected,
      relayError: this.relayError,
      error: this.lastError,
    }
  }

  async setEnabled(enabled: boolean): Promise<CompanionStatus> {
    this.state.enabled = enabled
    await this.saveNow()
    if (enabled) {
      try {
        await this.start()
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    } else {
      await this.stop()
    }
    this.emitStatus()
    return this.status()
  }

  /**
   * Apply a self-hosted relay address. Existing rooms are closed because they
   * were opened against the previous endpoint; the next pairing or phone
   * reconnect uses the new one.
   */
  async setRelayUrl(value: string): Promise<CompanionStatus> {
    const normalized = normalizeRelayUrl(value)
    if (normalized === null) {
      throw new Error(
        '中继地址必须是 wss:// 或 ws:// 地址，可带 #k=准入码，且不能包含用户名或密码。',
      )
    }
    // The dialog shows and resubmits the endpoint without the code, so a save
    // that only re-sends the same host/path must not wipe the stored code.
    const endpoint = splitRelayUrl(normalized)
    const previous = splitRelayUrl(this.options.store.settingsView().relayUrl)
    const next =
      !endpoint.access && endpoint.url && previous.access && previous.url === endpoint.url
        ? `${endpoint.url}#k=${previous.access}`
        : normalized
    await this.options.store.updateSettings({ relayUrl: next })
    if (this.offer) this.clearOffer()
    this.stopRelay()
    // Only reconnect when the companion service is actually running; start()
    // opens relay rooms on the new endpoint otherwise.
    if (this.server) this.startRelay()
    this.emitStatus()
    return this.status()
  }

  async createPairing(): Promise<CompanionPairing> {
    return this.buildPairingOffer(false)
  }

  /**
   * 已配对的手机为另一台手机生成换机二维码。
   *
   * 调用必须经过当前手机的 E2E 认证通道；生成的二维码短时有效、只能扫一次，
   * 扫码方持有一次性密钥即可完成配对，不需要电脑前的人再点确认。这样人在
   * 外面、只带得动另一台手机时也能接管连接；代价是拿到二维码的人就能配对，
   * 所以手机端必须提醒用户不要截图或转发。
   */
  async createTransferPairing(): Promise<CompanionPairing> {
    return this.buildPairingOffer(true)
  }

  private async buildPairingOffer(autoApprove: boolean): Promise<CompanionPairing> {
    if (!this.state.enabled) {
      this.state.enabled = true
      await this.saveNow()
    }
    await this.start()
    const port = this.listeningPort()
    if (!port) throw new Error('手机连接服务启动失败')
    this.clearOffer()
    const ttl = autoApprove ? TRANSFER_PAIRING_TTL_MS : PAIRING_TTL_MS
    const keyPair = createKeyPair()
    const offer: PairingOffer = {
      lookup: randomLookup(),
      secret: randomSecret(16),
      keys: keyPair,
      expiresAt: Date.now() + ttl,
      room: randomId(24),
      roomKey: randomSecret(24),
      autoApprove,
    }
    this.offer = offer
    this.offerTimer = setTimeout(() => {
      if (this.offer === offer) {
        this.offer = null
        if (!this.roomInUse(offer.room)) this.closeRelayRoom(offer.room)
        if (this.pendingPair) {
          this.settlePairing(
            this.pendingPair.request.requestId,
            false,
            '配对二维码已失效，请在电脑上重新生成',
          )
        }
        this.emitStatus()
      }
    }, ttl)
    this.offerTimer.unref?.()
    const host = this.addressHost()
    const publicBase = this.publicBaseUrl()
    const localAddress = publicBase || `http://${host}:${port}/`
    const lanRelay = publicBase ? wsEndpoint(publicBase) : `ws://${host}:${port}/ws`
    const relayUrl = this.relayUrl()
    const baseUrl = this.appBaseUrl() || localAddress
    if (relayUrl) this.ensureRelayRoom(offer.room, offer.roomKey)
    const payload: Record<string, unknown> = {
      v: 1,
      r: relayUrl || lanRelay,
      d: this.state.deviceId,
      k: offer.lookup,
      s: offer.secret,
      p: keyPair.publicBase64,
      n: this.options.deviceName,
    }
    if (relayUrl) {
      // The phone prefers the direct LAN address when both devices share a
      // network and falls back to the cloud connector otherwise.
      payload['l'] = lanRelay
      payload['x'] = offer.room
      payload['h'] = offer.roomKey
      // L1 admission code. The relay checks it before it will put the phone
      // in a room, so the pairing payload is how it reaches the phone without
      // the user typing anything. It is no more sensitive than `h`.
      const access = this.relayAccess()
      if (access) payload['a'] = access
    }
    const url = new URL(baseUrl)
    url.hash = `p=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
    const qrDataUrl = await QRCode.toDataURL(url.toString(), {
      errorCorrectionLevel: 'M',
      // Four modules of quiet zone are required for reliable scanning. The
      // pairing payload is large (v15, 77 modules), so a 1-module margin left
      // the finder patterns flush against the edge.
      margin: 4,
      // The transfer QR is shown on a high-DPI phone and scanned by another
      // phone's camera, so keep more source pixels than the desktop dialog.
      width: autoApprove ? 720 : 480,
      color: { dark: '#0b1118', light: '#ffffff' },
    })
    this.emitStatus()
    return {
      url: url.toString(),
      qrDataUrl,
      address: baseUrl,
      expiresAt: new Date(offer.expiresAt).toISOString(),
      mode: relayUrl ? 'cloud' : 'lan',
    }
  }

  /**
   * Answer the phone request raised by the last `pair.join`. Returns false when
   * it is no longer pending (already answered, timed out or withdrawn).
   */
  resolvePairing(requestId: string, approved: boolean): boolean {
    return this.settlePairing(
      requestId,
      approved,
      approved ? undefined : '电脑端拒绝了本次配对',
    )
  }

  /** The phone currently waiting for an answer, if any. */
  pendingPairing(): CompanionPairRequest | null {
    return this.pendingPair?.request ?? null
  }

  /**
   * Park a `pair.join` frame until the desktop user answers. Only one request is
   * pending at a time so a burst of phones cannot bury the real one.
   */
  private requestPairApproval(
    connection: ClientConnection,
    input: { phoneId: string; name: string; platform: string },
  ): Promise<{ approved: boolean; reason?: string }> {
    if (this.pendingPair) {
      // Checked before `pair.pending` so the phone never sees "waiting" and then
      // an immediate rejection for the same attempt.
      return Promise.resolve({ approved: false, reason: PAIR_BUSY_REASON })
    }
    const ttl = this.options.pairApprovalTtlMs ?? PAIR_APPROVAL_TTL_MS
    const request: CompanionPairRequest = {
      requestId: randomId(12),
      phoneId: input.phoneId,
      name: input.name,
      platform: input.platform,
      address: connection.address,
      via: connection.via,
      requestedAt: nowIso(),
      expiresAt: new Date(Date.now() + ttl).toISOString(),
    }
    return new Promise((resolvePromise) => {
      this.pendingPair = { request, connection, resolve: resolvePromise }
      this.pairApprovalTimer = setTimeout(() => {
        this.settlePairing(
          request.requestId,
          false,
          '电脑端没有在限定时间内确认，请在电脑上重新生成二维码',
        )
      }, ttl)
      this.pairApprovalTimer.unref?.()
      this.emitStatus()
      try {
        // Every host shows the request the same way: one run event. A host that
        // offers no prompt (headless without a console) leaves it pending, so
        // an unwired deployment fails closed instead of pairing silently.
        this.options.onEvent?.({ type: 'companion.pair_request', request })
      } catch {
        // A broken prompt must not strand the phone without an answer.
        this.settlePairing(request.requestId, false, '电脑端无法显示配对确认')
      }
    })
  }

  /** Clear the pending request and hand the decision back to `pair.join`. */
  private settlePairing(requestId: string, approved: boolean, reason?: string): boolean {
    const pending = this.pendingPair
    if (!pending || pending.request.requestId !== requestId) return false
    this.pendingPair = null
    if (this.pairApprovalTimer) {
      clearTimeout(this.pairApprovalTimer)
      this.pairApprovalTimer = null
    }
    pending.resolve({ approved, reason })
    try {
      this.options.onEvent?.({ type: 'companion.pair_resolved', requestId, approved, reason })
    } catch {
      // The desktop mirror is best-effort.
    }
    this.emitStatus()
    return true
  }

  async appQr(): Promise<{ url: string; qrDataUrl: string }> {
    const configured = (this.options.appDownloadUrl ?? APP_DOWNLOAD_URL).trim()
    const url = configured || this.appBaseUrl() || this.status().address || this.localUrl()
    if (!url) throw new Error('手机 App 地址尚未配置')
    if (this.appQrCache?.url === url) return this.appQrCache
    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
      color: { dark: '#0b1118', light: '#ffffff' },
    })
    this.appQrCache = { url, qrDataUrl }
    return this.appQrCache
  }

  async revoke(phoneId: string): Promise<CompanionStatus> {
    const phone = this.state.phones[phoneId]
    if (phone) {
      delete this.state.phones[phoneId]
      this.phoneSockets.delete(phoneId)
      const connection = this.byPhone.get(phoneId)
      if (connection) {
        this.byPhone.delete(phoneId)
        this.sendRaw(connection.socket, {
          type: 'pair.revoked',
          reason: '电脑已解除这台手机的配对',
        })
        connection.socket.close(4003, 'revoked')
      }
      if (phone.relayRoom) this.closeRelayRoom(phone.relayRoom)
      await this.saveNow()
    }
    this.emitStatus()
    return this.status()
  }

  localUrl(): string {
    const port = this.listeningPort()
    return port ? `http://127.0.0.1:${port}/` : ''
  }

  private roomInUse(room: string): boolean {
    return Object.values(this.state.phones).some((phone) => phone.relayRoom === room)
  }

  private ensureRelayRoom(room: string, key: string): void {
    const url = this.relayUrl()
    if (!url || !room || !key || this.relayRooms.has(room)) return
    const sockets = new Map<string, RelaySocket>()
    let channel: RelayHostChannel
    channel = new RelayHostChannel(
      url,
      room,
      key,
      {
        onPeerOpen: (cid) => {
          const socket = new RelaySocket(channel, cid)
          sockets.set(cid, socket)
          this.handleConnection(socket, { via: 'relay' })
        },
        onPeerClose: (cid) => {
          const socket = sockets.get(cid)
          sockets.delete(cid)
          socket?.closeFromPeer()
        },
        onFrame: (cid, frame) => {
          sockets.get(cid)?.deliver(frame)
        },
        onState: (state: RelayChannelState) => {
          this.relayError = state.error
          this.emitStatus()
        },
      },
      this.relayAccess(),
    )
    this.relayRooms.set(room, { channel, sockets })
    channel.start()
  }

  private startRelay(): void {
    if (!this.relayUrl()) return
    for (const phone of Object.values(this.state.phones)) {
      if (phone.relayRoom && phone.relayKey) this.ensureRelayRoom(phone.relayRoom, phone.relayKey)
    }
    if (this.offer) this.ensureRelayRoom(this.offer.room, this.offer.roomKey)
  }

  private closeRelayRoom(room: string): void {
    const state = this.relayRooms.get(room)
    if (!state) return
    this.relayRooms.delete(room)
    // This is an explicit room shutdown (companion disabled or relay address
    // changed), so tell phones immediately instead of waiting for the relay's
    // host grace period.
    for (const socket of state.sockets.values()) socket.close(1000, 'room closed')
    state.sockets.clear()
    state.channel.stop()
    this.emitStatus()
  }

  private stopRelay(): void {
    for (const room of [...this.relayRooms.keys()]) this.closeRelayRoom(room)
    this.relayRooms.clear()
    this.relayError = null
  }

  async start(): Promise<void> {
    if (this.server) return
    this.lastError = null
    const requestedPort = this.options.port
    if (requestedPort && Number.isInteger(requestedPort) && requestedPort > 0) {
      this.state.port = requestedPort
    }
    const server = createServer((request, response) => {
      void this.handleHttp(request, response)
    })
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.state.port, this.listenHost())
      })
    } catch (error) {
      this.server = null
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') throw error
      if (this.options.strictPort) {
        throw new Error(
          `端口 ${this.state.port} 已被占用，请用 --port 指定其它端口，或先停止占用该端口的进程。`,
        )
      }
      // Another local service owns the preferred port; fall back to a free one.
      const retry = createServer((request, response) => {
        void this.handleHttp(request, response)
      })
      this.server = retry
      await new Promise<void>((resolve, reject) => {
        retry.once('error', reject)
        retry.once('listening', () => resolve())
        retry.listen(0, this.listenHost())
      })
    }
    const port = this.listeningPort()
    if (port) {
      this.state.port = port
      await this.saveNow()
    }

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD,
      perMessageDeflate: false,
    })
    this.wss = wss
    this.server.on('upgrade', (request, socket, head) => {
      let path = '/'
      try {
        path = new URL(request.url ?? '/', 'http://pilot.local').pathname
      } catch {
        socket.destroy()
        return
      }
      if (path !== '/ws') {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    })
    wss.on('connection', (socket, request) =>
      this.handleConnection(socket as unknown as ConnectionSocket, {
        via: 'lan',
        address: request.socket.remoteAddress ?? undefined,
      }),
    )
    this.heartbeat = setInterval(() => this.checkHeartbeat(), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    this.startRelay()
    this.lastError = null
    this.emitStatus()
  }

  async stop(): Promise<void> {
    this.clearOffer()
    this.stopRelay()
    await this.pluginHostInstance?.stopAll()
    this.pluginHostInstance = null
    const uploads = [...this.pendingUploads.values()]
    this.pendingUploads.clear()
    await Promise.all(
      uploads.map((upload) => abortWorkspaceUpload(upload.tempPath).catch(() => undefined)),
    )
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const connection of this.connections) {
      try {
        connection.socket.close(1001, 'server stopping')
      } catch {
        // ignore
      }
    }
    this.connections.clear()
    this.byPhone.clear()
    this.phoneSockets.clear()
    this.wss?.close()
    this.wss = null
    const server = this.server
    this.server = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.emitStatus()
  }

  /** Forward local agent events to every authenticated phone. */
  publish(event: RunEvent): void {
    if (event.type === 'companion.changed') return
    for (const phoneId of this.phoneSockets) {
      this.sendEncrypted(phoneId, { type: 'event', data: event }).catch(() => {
        // A phone that dropped mid-event will reconnect; the session can be reloaded.
      })
    }
  }

  /** Phone-originated changes must also update the desktop window. */
  private notify(event: RunEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // The desktop mirror is best-effort.
    }
    this.publish(event)
  }

  private emitTodos(sessionId: string): void {
    this.notify({
      type: 'todos.changed',
      sessionId,
      todos: this.options.store.todos(sessionId),
    })
  }

  private emitScheduled(sessionId: string): void {
    this.notify({ type: 'scheduled.changed', sessionId })
  }

  private listeningPort(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  /**
   * Direct endpoints advertised to paired phones. A phone that paired through
   * the relay can switch to these without re-pairing when it joins the same
   * network (DHCP changes included).
   */
  private lanUrls(): string[] {
    const port = this.listeningPort()
    if (!port) return []
    return lanAddresses()
      .slice(0, 4)
      .map((address) => `ws://${address}:${port}/ws`)
  }

  private activeOffer(): PairingOffer | null {
    if (!this.offer) return null
    if (this.offer.expiresAt <= Date.now()) {
      this.clearOffer()
      return null
    }
    return this.offer
  }

  private clearOffer(): void {
    const room = this.offer?.room
    this.offer = null
    if (this.offerTimer) {
      clearTimeout(this.offerTimer)
      this.offerTimer = null
    }
    if (room && !this.roomInUse(room)) this.closeRelayRoom(room)
    // A new QR code invalidates any phone still waiting on the old one.
    if (this.pendingPair) {
      this.settlePairing(
        this.pendingPair.request.requestId,
        false,
        '配对二维码已更换，请重新扫码',
      )
    }
  }

  private emitStatus(): void {
    try {
      this.options.onStatus(this.status())
    } catch {
      // Status rendering must not break the relay.
    }
  }

  private blankSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveNow()
    }, 300)
    this.saveTimer.unref?.()
  }

  private async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      await mkdir(dirname(this.stateFile), { recursive: true })
      const temp = `${this.stateFile}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      await rename(temp, this.stateFile)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://pilot.local')
      if (
        url.pathname === PLUGIN_HTTP_PREFIX ||
        url.pathname.startsWith(`${PLUGIN_HTTP_PREFIX}/`)
      ) {
        await this.handlePluginHttp(request, response)
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' })
        response.end()
        return
      }
      if (url.pathname === '/healthz') {
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        response.end(JSON.stringify({ ok: true, app: 'pilot-link' }))
        return
      }
      let relative = STATIC_ROUTES[url.pathname]
      if (!relative && url.pathname.startsWith('/vendor/')) {
        relative = url.pathname.slice(1)
      }
      if (!relative) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const safeRelative = normalize(relative).replace(/^([.][.][/\\])+/, '')
      const path = join(this.options.assetsDir, safeRelative)
      if (!path.startsWith(this.options.assetsDir)) {
        response.writeHead(403)
        response.end()
        return
      }
      const raw = await readFile(path)
      const ext = safeRelative.slice(safeRelative.lastIndexOf('.'))
      // Server mode paints the console like the desktop client; the phone PWA
      // served by the desktop app keeps the untouched stylesheet. The switch
      // lives in the HTML so one asset directory can serve both surfaces.
      const body =
        ext === '.html' && this.options.surface === 'desktop'
          ? Buffer.from(withDesktopSurface(raw.toString('utf8')))
          : raw
      const headers: Record<string, string | number> = {
        'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      }
      if (ext === '.html') {
        headers['Content-Security-Policy'] =
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      }
      response.writeHead(200, headers)
      if (request.method === 'HEAD') response.end()
      else response.end(body)
    } catch {
      if (!response.headersSent) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      response.end('Not found')
    }
  }

  /**
   * `/api/plugins/*` is the only non-GET surface of this server besides the
   * WebSocket. Authentication happens inside the bridge, per manifest route.
   */
  private async handlePluginHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const host = this.pluginHost()
    const write = (status: number, headers: Record<string, string>, body: string): void => {
      if (response.headersSent) return
      response.writeHead(status, headers)
      response.end(body)
    }
    if (!host) {
      write(
        503,
        { 'Content-Type': 'application/json; charset=utf-8' },
        JSON.stringify({ ok: false, error: 'unavailable', message: 'no workspace is open' }),
      )
      return
    }
    const result = await handlePluginHttp(host, {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      readBody: (limit) => readRequestBody(request, limit),
    })
    if (!result) {
      write(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found')
      return
    }
    write(result.status, result.headers, result.body)
  }

  private handleConnection(
    socket: ConnectionSocket,
    origin: { via: 'lan' | 'relay'; address?: string | undefined },
  ): void {
    const connection: ClientConnection = {
      socket,
      authed: false,
      phoneId: null,
      alive: true,
      pairAttempts: 0,
      openedAt: Date.now(),
      via: origin.via,
      address: origin.address?.replace(/^::ffff:/, '') ?? null,
    }
    this.connections.add(connection)
    socket.on('pong', () => {
      connection.alive = true
    })
    socket.on('message', (data) => {
      connection.alive = true
      void this.handleFrame(connection, data).catch(() => {
        // Individual malformed frames are answered by handleFrame.
      })
    })
    socket.on('close', () => {
      this.connections.delete(connection)
      if (this.pendingPair?.connection === connection) {
        this.settlePairing(
          this.pendingPair.request.requestId,
          false,
          '手机已断开连接，请在电脑上重新生成二维码',
        )
      }
      if (connection.phoneId && this.byPhone.get(connection.phoneId) === connection) {
        this.byPhone.delete(connection.phoneId)
        this.phoneSockets.delete(connection.phoneId)
        const phone = this.state.phones[connection.phoneId]
        if (phone) {
          phone.lastSeen = nowIso()
          this.blankSave()
        }
        this.emitStatus()
      }
    })
    socket.on('error', () => {
      // Close follows.
    })
  }

  private checkHeartbeat(): void {
    const now = Date.now()
    for (const connection of this.connections) {
      if (!connection.authed && now - connection.openedAt > SILENCE_MS) {
        try {
          connection.socket.terminate()
        } catch {
          // ignore
        }
        continue
      }
      if (connection.alive) {
        connection.missedPongs = 0
      } else {
        connection.missedPongs = (connection.missedPongs ?? 0) + 1
      }
      if ((connection.missedPongs ?? 0) >= HEARTBEAT_MISS_LIMIT) {
        try {
          connection.socket.terminate()
        } catch {
          // ignore
        }
        continue
      }
      connection.alive = false
      try {
        connection.socket.ping()
      } catch {
        // ignore
      }
    }
  }

  private sendRaw(socket: ConnectionSocket, frame: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(frame))
    } catch {
      // ignore
    }
  }

  private sendError(connection: ClientConnection, code: string, message: string): void {
    this.sendRaw(connection.socket, { type: 'error', code, message: message.slice(0, 400) })
  }

  private async handleFrame(connection: ClientConnection, raw: unknown): Promise<void> {
    let frame: Record<string, unknown>
    try {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : String(raw)
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object') throw new Error('bad frame')
      frame = parsed as Record<string, unknown>
    } catch {
      this.sendError(connection, 'bad_frame', '消息格式不正确')
      return
    }
    const type = typeof frame['type'] === 'string' ? frame['type'] : ''
    if (type === 'pair.join') {
      await this.handlePairJoin(connection, frame)
      return
    }
    if (type === 'hello') {
      await this.handleHello(connection, frame)
      return
    }
    if (type === 'hello.proof') {
      await this.handleHelloProof(connection, frame)
      return
    }
    if (type === 'message') {
      if (!connection.authed || !connection.phoneId) {
        this.sendError(connection, 'auth_required', '请先完成配对')
        return
      }
      await this.handleEncrypted(connection.phoneId, frame['payload'])
      return
    }
    if (type === 'ping') {
      this.sendRaw(connection.socket, { type: 'pong', t: Date.now() })
      return
    }
    this.sendError(connection, 'unknown_frame', '未知的消息类型')
  }

  private async handlePairJoin(
    connection: ClientConnection,
    frame: Record<string, unknown>,
  ): Promise<void> {
    connection.pairAttempts += 1
    if (connection.pairAttempts > PAIRING_MAX_ATTEMPTS) {
      connection.socket.close(4008, 'too many attempts')
      return
    }
    const lookup = frame['lookup']
    const phoneId = frame['phoneId']
    const name = cleanText(frame['name'], '手机', 80)
    const phonePub = frame['phonePub']
    if (typeof lookup !== 'string' || !LOOKUP_RE.test(lookup)) {
      this.sendRaw(connection.socket, { type: 'pair.rejected', reason: '配对二维码已失效' })
      return
    }
    if (typeof phoneId !== 'string' || !ID_RE.test(phoneId)) {
      this.sendRaw(connection.socket, { type: 'pair.rejected', reason: '手机标识不正确' })
      return
    }
    if (typeof phonePub !== 'string' || !PUBLIC_KEY_RE.test(phonePub)) {
      this.sendRaw(connection.socket, { type: 'pair.rejected', reason: '手机公钥不正确' })
      return
    }
    const offer = this.activeOffer()
    if (!offer || offer.lookup !== lookup) {
      this.sendRaw(connection.socket, {
        type: 'pair.rejected',
        reason: '配对二维码已失效，请在电脑上重新生成',
      })
      return
    }
    const platform = cleanText(frame['platform'], 'mobile', 40)
    let keys
    try {
      keys = derivePairKeys(offer.keys.privateKey, phonePub, offer.secret)
    } catch {
      this.sendRaw(connection.socket, { type: 'pair.rejected', reason: '配对密钥不正确' })
      return
    }
    // 普通配对二维码只发起请求，必须等电脑前的人确认；换机二维码由已配对
    // 手机经认证通道申请，扫码本身已经证明持有一次性密钥，直接放行。
    // 两条路径都受 TTL 和「一次使用后清空 offer」约束。
    if (!offer.autoApprove) {
      const busy = Boolean(this.pendingPair)
      if (!busy) this.sendRaw(connection.socket, { type: 'pair.pending' })
      const decision = await this.requestPairApproval(connection, { phoneId, name, platform })
      if (!decision.approved) {
        this.sendRaw(connection.socket, {
          type: 'pair.rejected',
          reason: decision.reason ?? '电脑端拒绝了本次配对',
        })
        return
      }
    }
    // The answer can arrive after the QR code was replaced or the socket died.
    if (this.activeOffer() !== offer) {
      this.sendRaw(connection.socket, {
        type: 'pair.rejected',
        reason: '配对二维码已失效，请在电脑上重新生成',
      })
      return
    }
    if (connection.socket.readyState !== WebSocket.OPEN) return
    const token = randomToken()
    const pairedAt = nowIso()
    const protocol = frame['protocol'] === 2 ? 2 : 1
    const relayUrl = this.relayUrl()
    const relayEnabled = Boolean(relayUrl)
    this.state.phones[phoneId] = {
      phoneId,
      name,
      platform,
      tokenHash: hashToken(token),
      tokenSealed: seal(token),
      pcToPhone: seal(keys.pcToPhone.toString('base64url')),
      phoneToPc: seal(keys.phoneToPc.toString('base64url')),
      outSeq: 1,
      inSeq: 0,
      pairedAt,
      lastSeen: pairedAt,
      ...(relayEnabled
        ? { relayRoom: offer.room, relayKey: offer.roomKey, relayUrl }
        : {}),
    }
    this.clearOffer()
    await this.saveNow()
    const confirmationValue: Record<string, unknown> = {
      type: 'pair.accept',
      deviceId: this.state.deviceId,
      deviceName: this.options.deviceName,
    }
    // New clients receive the pairing token inside the E2E-encrypted payload,
    // so the cloud connector never sees the credential. Legacy clients still
    // need it in the clear and are supported during migration.
    if (protocol >= 2) confirmationValue['token'] = token
    const confirmation = encryptPayload(keys.pcToPhone, confirmationValue, 1)
    const accepted: Record<string, unknown> = {
      type: 'pair.accepted',
      payload: confirmation,
      protocol,
    }
    if (protocol < 2) accepted['token'] = token
    this.sendRaw(connection.socket, accepted)
    this.emitStatus()
  }

  private async handleHello(
    connection: ClientConnection,
    frame: Record<string, unknown>,
  ): Promise<void> {
    if (connection.authed) return
    if (frame['role'] !== 'phone') {
      this.sendError(connection, 'auth_failed', '配对身份不正确')
      return
    }
    if (frame['deviceId'] !== this.state.deviceId) {
      this.sendError(connection, 'auth_failed', '电脑身份不一致，请重新扫码配对')
      return
    }
    const phoneId = frame['phoneId']
    if (typeof phoneId !== 'string' || !ID_RE.test(phoneId)) {
      this.sendError(connection, 'auth_failed', '配对信息不完整')
      return
    }
    const phone = this.state.phones[phoneId]
    if (!phone) {
      this.sendError(connection, 'auth_failed', '配对已失效，请在电脑上重新生成二维码')
      return
    }
    const protocol = frame['protocol'] === 2 ? 2 : 1
    if (protocol >= 2) {
      // A challenge keeps the token out of the cloud relay entirely.
      if (!phone.tokenSealed) {
        this.sendRaw(connection.socket, { type: 'hello.legacy' })
        return
      }
      const challenge = randomSecret(24)
      connection.pendingPhoneId = phoneId
      connection.challenge = challenge
      connection.challengeAt = Date.now()
      connection.protocol = 2
      this.sendRaw(connection.socket, { type: 'hello.challenge', challenge, protocol: 2 })
      return
    }

    // Legacy path for phones paired before protocol 2. The token is accepted
    // once, then sealed so subsequent reconnects can use the challenge flow.
    const token = frame['token']
    if (typeof token !== 'string' || !safeEqualHex(phone.tokenHash, hashToken(token))) {
      this.sendError(connection, 'auth_failed', '配对已失效，请在电脑上重新生成二维码')
      return
    }
    if (!phone.tokenSealed) phone.tokenSealed = seal(token)
    await this.completeHello(connection, phone, phoneId)
  }

  private async handleHelloProof(
    connection: ClientConnection,
    frame: Record<string, unknown>,
  ): Promise<void> {
    if (connection.authed) return
    if (
      connection.protocol !== 2 ||
      !connection.challenge ||
      !connection.challengeAt ||
      Date.now() - connection.challengeAt > CHALLENGE_TTL_MS
    ) {
      connection.challenge = undefined
      connection.challengeAt = undefined
      this.sendError(connection, 'auth_failed', '配对验证已过期，请重新连接')
      return
    }
    const phoneId = frame['phoneId']
    const proof = frame['proof']
    if (
      typeof phoneId !== 'string' ||
      phoneId !== connection.pendingPhoneId ||
      typeof proof !== 'string'
    ) {
      connection.challenge = undefined
      connection.challengeAt = undefined
      this.sendError(connection, 'auth_failed', '配对验证不完整')
      return
    }
    const phone = this.state.phones[phoneId]
    if (!phone?.tokenSealed) {
      connection.challenge = undefined
      connection.challengeAt = undefined
      this.sendError(connection, 'auth_failed', '配对已失效，请在电脑上重新生成二维码')
      return
    }
    let token: string
    try {
      token = unseal(phone.tokenSealed)
    } catch {
      connection.challenge = undefined
      connection.challengeAt = undefined
      this.sendError(connection, 'auth_failed', '配对凭证无法读取，请重新扫码')
      return
    }
    const expected = tokenProof(token, connection.challenge)
    connection.challenge = undefined
    connection.challengeAt = undefined
    if (!safeEqualText(proof, expected)) {
      this.sendError(connection, 'auth_failed', '配对验证失败，请重新扫码')
      return
    }
    await this.completeHello(connection, phone, phoneId)
  }

  private async completeHello(
    connection: ClientConnection,
    phone: StoredPhone,
    phoneId: string,
  ): Promise<void> {
    const lastActive = phone.lastSeen ?? phone.pairedAt
    if (Date.now() - new Date(lastActive).getTime() > PAIR_EXPIRY_MS) {
      delete this.state.phones[phoneId]
      await this.saveNow()
      this.sendRaw(connection.socket, {
        type: 'error',
        code: 'pair_expired',
        message: '已超过 7 天未使用，请在电脑上重新生成配对二维码',
      })
      connection.socket.close(4003, 'expired')
      return
    }
    const previous = this.byPhone.get(phoneId)
    if (previous && previous !== connection) {
      this.sendError(previous, 'replaced', '这个配对正在另一处使用')
      try {
        previous.socket.close(4001, 'replaced')
      } catch {
        // ignore
      }
    }
    connection.authed = true
    connection.phoneId = phoneId
    connection.pendingPhoneId = undefined
    connection.challenge = undefined
    connection.challengeAt = undefined
    this.byPhone.set(phoneId, connection)
    this.phoneSockets.add(phoneId)
    phone.lastSeen = nowIso()
    this.blankSave()
    this.sendRaw(connection.socket, {
      type: 'welcome',
      deviceId: this.state.deviceId,
      phoneId,
      deviceName: this.options.deviceName,
      protocolVersion: PROTOCOL_VERSION,
      // Current direct endpoints, so a phone connected through the relay can
      // upgrade to LAN when it is on the same network (and refresh stale IPs).
      lan: this.lanUrls(),
    })
    this.emitStatus()
  }

  private phoneKey(phone: StoredPhone, direction: 'pcToPhone' | 'phoneToPc'): Buffer {
    const sealed = direction === 'pcToPhone' ? phone.pcToPhone : phone.phoneToPc
    const value = unseal(sealed)
    const key = fromBase64url(value, '加密密钥')
    if (key.length !== 32) throw new Error('加密密钥长度不正确')
    return key
  }

  private async handleEncrypted(phoneId: string, payload: unknown): Promise<void> {
    const phone = this.state.phones[phoneId]
    if (!phone) return
    let decoded: { seq: number; value: unknown }
    try {
      decoded = decryptPayload(this.phoneKey(phone, 'phoneToPc'), payload)
    } catch {
      return
    }
    if (decoded.seq <= phone.inSeq) return
    phone.inSeq = decoded.seq
    phone.lastSeen = nowIso()
    this.blankSave()
    const value = asRecord(decoded.value)
    if (value['type'] === 'ping') {
      await this.sendEncrypted(phoneId, { type: 'pong', t: Date.now() })
      return
    }
    if (value['type'] !== 'request') return
    const id = typeof value['id'] === 'string' ? value['id'].slice(0, 80) : ''
    if (!id) return
    const method = typeof value['method'] === 'string' ? value['method'] : ''
    const params = asRecord(value['params'])
    try {
      const data = await this.handleRequest(method, params, phone)
      await this.sendEncrypted(phoneId, { type: 'response', id, ok: true, data })
    } catch (error) {
      await this.sendEncrypted(phoneId, {
        type: 'response',
        id,
        ok: false,
        error: String(error instanceof Error ? error.message : error).slice(0, 4_000),
      })
    }
  }

  private async sendEncrypted(phoneId: string, value: unknown): Promise<void> {
    const phone = this.state.phones[phoneId]
    const connection = this.byPhone.get(phoneId)
    if (!phone || !connection || connection.socket.readyState !== WebSocket.OPEN) return
    let envelope
    try {
      const next = phone.outSeq + 1
      envelope = encryptPayload(this.phoneKey(phone, 'pcToPhone'), value, next)
      phone.outSeq = next
      this.blankSave()
    } catch {
      return
    }
    this.sendRaw(connection.socket, { type: 'message', payload: envelope })
  }

  private async handleRequest(
    method: string,
    params: Record<string, unknown>,
    phone: StoredPhone,
  ): Promise<unknown> {
    if (!method) throw new Error('缺少操作名称')
    switch (method) {
      case 'pairing.transfer': {
        // 只回传二维码图片和过期时间；二维码载荷本身就是凭证，不再额外
        // 下发可复制的链接文本。生成入口只对已认证的手机开放。
        const pairing = await this.createTransferPairing()
        return {
          qrDataUrl: pairing.qrDataUrl,
          expiresAt: pairing.expiresAt,
          mode: pairing.mode,
        }
      }
      case 'device.info':
        return {
          deviceName: this.options.deviceName,
          platform: process.platform,
          appVersion: this.options.appVersion,
          model: this.options.store.settingsView().model,
          theme: this.options.store.settingsView().theme,
          phoneName: phone.name,
          capabilities: this.capabilities(),
        }
      case 'workspaces.list':
        return {
          workspaces: this.options.store.workspaces(),
          // 手机端只能在这些电脑端授权的目录里新建工作区。
          roots: this.options.store.phoneRoots(),
        }
      case 'workspaces.create':
        return this.createWorkspace(params)
      case 'workspaces.browse':
        return this.browseWorkspace(params)
      case 'workspaces.open':
        return this.openWorkspace(params)
      case 'workspaces.remove':
        return this.removeWorkspace(params)
      case 'sessions.list':
        return this.listSessions()
      case 'sessions.search':
        return this.searchSessions(params)
      case 'sessions.knowledge':
        return this.sessionKnowledge(params)
      case 'sessions.links':
        return this.sessionLinks(params)
      case 'sessions.tools':
        return this.sessionTools(params)
      case 'sessions.get':
      case 'sessions.history':
        return this.getSession(params)
      case 'sessions.create':
        return this.createSession(params)
      case 'sessions.rename':
        return this.renameSession(params)
      case 'sessions.approvalMode':
        return this.setApprovalMode(params)
      case 'sessions.model':
        return this.setSessionModel(params)
      case 'chat.send': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const content = typeof params['content'] === 'string' ? params['content'] : ''
        if (content.length > MAX_MESSAGE_CHARS) {
          throw new Error(`消息长度不能超过 ${MAX_MESSAGE_CHARS} 个字符`)
        }
        const images = sanitizeImages(params['images'])
        const references = sanitizeReferences(params['references'])
        if (!content.trim() && images.length === 0) throw new Error('消息不能为空')
        const delivery = params['delivery'] === 'insert' ? 'insert' : 'queue'
        const result = await this.options.runner.sendMessage(sessionId, content, delivery, {
          images,
          references,
        })
        return result
      }
      case 'chat.stop': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        await this.options.runner.cancelRun(sessionId)
        return { ok: true }
      }
      case 'chat.pause': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        await this.options.runner.pauseRun(sessionId)
        return { ok: true }
      }
      case 'chat.resume': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        return this.options.runner.continueRun(sessionId)
      }
      case 'sessions.fork': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        if (this.options.runner.isRunning(sessionId)) {
          throw new Error('请先等待当前任务结束再创建副本')
        }
        return this.options.store.forkSession(sessionId)
      }
      case 'sessions.delete':
        return this.deleteSession(params)
      case 'run.retry': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        await this.options.runner.retryRun(sessionId)
        return { ok: true }
      }
      case 'chat.edit': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const messageId = requireString(params['messageId'], '消息', 80)
        const content = typeof params['content'] === 'string' ? params['content'] : ''
        if (!content.trim()) throw new Error('消息不能为空')
        if (content.length > MAX_MESSAGE_CHARS) {
          throw new Error(`消息长度不能超过 ${MAX_MESSAGE_CHARS} 个字符`)
        }
        await this.options.runner.editMessage(sessionId, messageId, content)
        return { ok: true }
      }
      case 'chat.deleteMessage': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const messageId = requireString(params['messageId'], '消息', 80)
        await this.options.runner.deleteMessage(sessionId, messageId)
        return { ok: true }
      }
      case 'chat.regenerate': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        await this.options.runner.regenerate(sessionId)
        return { ok: true }
      }
      case 'checkpoints.list': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        if (!this.options.checkpoints?.list) {
          throw new Error('当前电脑端版本不支持手机查看回退点')
        }
        return { checkpoints: await this.options.checkpoints.list(sessionId) }
      }
      case 'checkpoints.create': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        if (!this.options.checkpoints?.create) {
          throw new Error('当前电脑端版本不支持手机创建回退点')
        }
        if (this.options.runner.isRunning(sessionId)) {
          throw new Error('请先等待当前任务结束再创建回退点')
        }
        const label =
          typeof params['label'] === 'string' ? params['label'].trim().slice(0, 120) : ''
        return {
          checkpoint: await this.options.checkpoints.create(sessionId, label || undefined),
        }
      }
      case 'checkpoints.restore': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const checkpointId = requireString(params['checkpointId'], '回退点', 120)
        const mode = params['mode']
        if (mode !== 'code' && mode !== 'conversation' && mode !== 'both') {
          throw new Error('回退方式无效')
        }
        if (!this.options.checkpoints?.restore) {
          throw new Error('当前电脑端版本不支持手机恢复回退点')
        }
        if (this.options.runner.isRunning(sessionId)) {
          throw new Error('请先等待当前任务结束再回退')
        }
        const result = await this.options.checkpoints.restore(sessionId, checkpointId, mode)
        this.notify({ type: 'session.changed', sessionId })
        return { result }
      }
      case 'changes.list': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        if (!this.options.changes?.list) {
          throw new Error('当前电脑端版本不支持手机查看变更')
        }
        return { changes: await this.options.changes.list(sessionId) }
      }
      case 'changes.revert': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const file = requireString(params['path'], '文件', 2_000)
        if (!this.options.changes?.revert) {
          throw new Error('当前电脑端版本不支持手机撤销变更')
        }
        if (this.options.runner.isRunning(sessionId)) {
          throw new Error('请先等待当前任务结束再撤销变更')
        }
        const result = await this.options.changes.revert(sessionId, file)
        this.notify({ type: 'session.changed', sessionId })
        return { result }
      }
      case 'moduleCheck.state': {
        if (!this.options.moduleCheck?.state) {
          throw new Error('当前电脑端版本不支持手机模块自检')
        }
        return { state: this.phoneModuleCheckState(await this.options.moduleCheck.state()) }
      }
      case 'moduleCheck.discover': {
        if (!this.options.moduleCheck?.discover) {
          throw new Error('当前电脑端版本不支持手机模块自检')
        }
        const source = this.options.moduleCheck.source?.() ?? null
        return {
          // 自检已经只扫内置源码：`source` 是新字段，`workspace` 保留给旧手机端。
          source,
          workspace: source,
          modules: await this.options.moduleCheck.discover(),
        }
      }
      case 'moduleCheck.run': {
        if (!this.options.moduleCheck?.run) {
          throw new Error('当前电脑端版本不支持手机模块自检')
        }
        const raw = params['moduleIds']
        if (raw !== undefined && !Array.isArray(raw)) {
          throw new Error('模块列表格式不正确')
        }
        const moduleIds = Array.isArray(raw)
          ? raw
              .filter((id): id is string => typeof id === 'string')
              .map((id) => id.trim().slice(0, 120))
              .filter(Boolean)
              .slice(0, 200)
          : undefined
        const report = await this.options.moduleCheck.run(
          moduleIds && moduleIds.length > 0 ? moduleIds : undefined,
        )
        return { report: this.phoneModuleCheckReport(report) }
      }
      case 'moduleCheck.settings': {
        if (!this.options.moduleCheck?.settings) {
          throw new Error('当前电脑端版本不支持手机模块自检')
        }
        const raw = params['settings']
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('自检设置格式不正确')
        }
        const record = raw as Record<string, unknown>
        const input: Partial<ModuleCheckSettings> = {}
        if (typeof record['enabled'] === 'boolean') input.enabled = record['enabled']
        if (typeof record['intervalHours'] === 'number' && Number.isFinite(record['intervalHours'])) {
          input.intervalHours = Math.max(1, Math.min(24 * 30, Math.round(record['intervalHours'])))
        }
        if (Array.isArray(record['modules'])) {
          input.modules = record['modules']
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 200)
        }
        return {
          state: this.phoneModuleCheckState(await this.options.moduleCheck.settings(input)),
        }
      }
      case 'moduleCheck.accept': {
        if (!this.options.moduleCheck?.accept) {
          throw new Error('当前电脑端版本不支持手机模块自检')
        }
        const reportId = requireString(params['reportId'], '自检报告', 120)
        const raw = params['riskIds']
        if (!Array.isArray(raw)) throw new Error('请先勾选要优化的风险点')
        const riskIds = raw
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 200)
        if (riskIds.length === 0) throw new Error('请先勾选要优化的风险点')
        // 默认只生成提案：手机端必须显式传 selfModify=true 才会真的改源码。
        const selfModify = params['selfModify'] === true
        const result = await this.options.moduleCheck.accept(reportId, riskIds, selfModify)
        return {
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          queued: result.queued === true,
          selfModify: result.selfModify,
          proposalId: result.proposalId,
        }
      }
      case 'selfCheck.run': {
        if (!this.options.selfCheck?.run) {
          throw new Error('当前电脑端版本不支持手机内视')
        }
        // 只读：不传路径、不建会话，也不改任何文件。
        return { report: await this.options.selfCheck.run() }
      }
      case 'learning.state': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        return { state: await this.phoneLearningState(workspacePath) }
      }
      case 'learning.settings': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const raw = params['settings']
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('学习设置格式不正确')
        }
        const record = raw as Record<string, unknown>
        const input: { learningMode?: boolean; learningHosts?: string[] } = {}
        if (typeof record['enabled'] === 'boolean') input.learningMode = record['enabled']
        if (record['hosts'] !== undefined) {
          if (!Array.isArray(record['hosts'])) throw new Error('学习来源白名单格式不正确')
          // 白名单会进入模型提示词；只接受裸主机名，本机/内网地址直接拒绝。
          input.learningHosts = normalizeLearningHostsInput(record['hosts'])
        }
        if (Object.keys(input).length === 0) throw new Error('没有需要保存的学习设置')
        await this.options.store.updateSettings(input)
        // Keep an open desktop settings window in step with the phone.
        this.options.onEvent?.({
          type: 'settings.changed',
          settings: this.options.store.settingsView(),
        })
        return { state: await this.phoneLearningState(workspacePath) }
      }
      case 'memory.list': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const detail = await this.options.store.workspaceDetail(workspacePath)
        return { memory: detail.memory }
      }
      case 'memory.add': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const content = typeof params['content'] === 'string' ? params['content'].trim() : ''
        if (!content) throw new Error('记忆内容不能为空')
        if (content.length > 2_000) throw new Error('记忆内容不能超过 2000 个字符')
        const entry: MemoryEntry = await this.options.store.addMemory(
          workspacePath,
          content,
          'user',
        )
        this.notify({ type: 'memory.changed', workspacePath })
        return { entry }
      }
      case 'memory.remove': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const memoryId = requireString(params['memoryId'], '记忆', 80)
        await this.options.store.deleteMemory(workspacePath, memoryId)
        this.notify({ type: 'memory.changed', workspacePath })
        return { ok: true }
      }
      case 'quickCommands.get': {
        const commands: QuickCommand[] | null = this.options.store.quickCommands()
        return { commands }
      }
      case 'quickCommands.save': {
        const raw = Array.isArray(params['commands']) ? params['commands'] : []
        const commands: QuickCommandInput[] = raw
          .map((item) => {
            if (!item || typeof item !== 'object') return null
            const record = item as Record<string, unknown>
            const content =
              typeof record['content'] === 'string' ? record['content'].trim().slice(0, 500) : ''
            if (!content) return null
            const id =
              typeof record['id'] === 'string' && record['id'].trim()
                ? record['id'].trim().slice(0, 80)
                : undefined
            return { content, ...(id ? { id } : {}) }
          })
          .filter((item): item is QuickCommandInput => item !== null)
          .slice(0, 8)
        return { commands: await this.options.store.saveQuickCommands(commands) }
      }
      case 'sandbox.status':
        return { status: await sandboxStatus() }
      case 'system.info': {
        // 手机不接受路径参数：只测量当前工作区所在卷，避免把已配对手机
        // 变成任意磁盘的探测器。没有工作区时退回进程目录。
        const workspace = this.options.store.activeWorkspace() || undefined
        const info: SystemInfo = await systemInfo(workspace)
        return { info }
      }
      case 'tools.list': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const registry = await this.toolRegistry(workspacePath)
        return { tools: await registry.list() }
      }
      case 'schedules.list': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        return { tasks: this.options.store.scheduledTasks(sessionId) }
      }
      case 'schedules.add': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const input = this.scheduleInput(params, true)
        if (!input.content || !input.kind) throw new Error('定时任务参数不完整')
        const task = await this.options.store.addScheduledTask(sessionId, {
          content: input.content,
          kind: input.kind,
          ...(input.delayMinutes !== undefined ? { delayMinutes: input.delayMinutes } : {}),
          ...(input.intervalMinutes !== undefined
            ? { intervalMinutes: input.intervalMinutes }
            : {}),
          ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
        })
        this.emitScheduled(sessionId)
        return { task }
      }
      case 'schedules.update': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '定时任务', 80)
        const input = this.scheduleInput(params, false)
        const task = await this.options.store.updateScheduledTask(sessionId, taskId, input)
        this.emitScheduled(sessionId)
        return { task }
      }
      case 'schedules.remove': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '定时任务', 80)
        await this.options.store.removeScheduledTask(sessionId, taskId)
        this.emitScheduled(sessionId)
        return { ok: true }
      }
      case 'todos.list': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        return { todos: this.options.store.todos(sessionId) }
      }
      case 'todos.add': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const text = requireString(params['text'], '待办', 4_000)
        const clientId =
          typeof params['clientId'] === 'string' ? params['clientId'].slice(0, 120) : undefined
        const todo = await this.options.store.addTodo(sessionId, text, 'phone', clientId)
        this.emitTodos(sessionId)
        return { todo }
      }
      case 'todos.update': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const todoId = requireString(params['todoId'], '待办', 80)
        const text = requireString(params['text'], '待办', 4_000)
        const todo = await this.options.store.updateTodo(sessionId, todoId, text)
        this.emitTodos(sessionId)
        return { todo }
      }
      case 'todos.remove': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const todoId = requireString(params['todoId'], '待办', 80)
        await this.options.store.removeTodo(sessionId, todoId)
        this.emitTodos(sessionId)
        return { ok: true }
      }
      case 'todos.clearSent': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        await this.options.store.clearSentTodos(sessionId)
        this.emitTodos(sessionId)
        return { ok: true }
      }
      case 'todos.send': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const todoId = requireString(params['todoId'], '待办', 80)
        const todo = this.options.store.todo(sessionId, todoId)
        if (!todo) throw new Error('待办不存在')
        if (todo.status === 'sent') throw new Error('该待办已发送')
        const result = await this.options.runner.sendMessage(sessionId, todo.text, 'queue')
        const updated = await this.options.store.markTodoSent(
          sessionId,
          todoId,
          this.options.runner.activeRun(sessionId)?.runId,
        )
        this.emitTodos(sessionId)
        return { ...result, todo: updated ?? todo }
      }
      case 'todos.sendAll': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const pending = this.options.store
          .todos(sessionId)
          .filter((todo) => todo.status === 'pending')
          .reverse()
        let sent = 0
        let failed = 0
        for (const todo of pending) {
          try {
            await this.options.runner.sendMessage(sessionId, todo.text, 'queue')
            await this.options.store.markTodoSent(
              sessionId,
              todo.id,
              this.options.runner.activeRun(sessionId)?.runId,
            )
            sent += 1
          } catch {
            failed += 1
          }
        }
        this.emitTodos(sessionId)
        return { sent, failed }
      }
      case 'queue.remove': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '排队消息', 80)
        await this.options.runner.removeQueueItem(sessionId, taskId)
        return { ok: true }
      }
      case 'queue.update': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '排队消息', 80)
        const content = requireString(params['content'], '排队消息', 4_000)
        await this.options.runner.updateQueueItem(sessionId, taskId, content)
        return { ok: true }
      }
      case 'queue.move': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '排队消息', 80)
        const direction = requireString(params['direction'], '方向', 8)
        if (direction !== 'up' && direction !== 'down') throw new Error('不支持的方向')
        await this.options.runner.moveQueueItem(sessionId, taskId, direction)
        return { ok: true }
      }
      case 'queue.toTodo': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '排队消息', 80)
        const todo = await this.options.runner.convertQueueItemToTodo(sessionId, taskId)
        if (!todo) throw new Error('排队消息不存在')
        this.emitTodos(sessionId)
        return { todo }
      }
      case 'todos.toSchedule': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const todoId = requireString(params['todoId'], '待办', 80)
        const input = this.scheduleInput(params, false)
        const task = await this.options.store.convertTodoToSchedule(sessionId, todoId, {
          content: input.content ?? '',
          kind: input.kind ?? 'once',
          ...(input.delayMinutes !== undefined ? { delayMinutes: input.delayMinutes } : {}),
          ...(input.intervalMinutes !== undefined
            ? { intervalMinutes: input.intervalMinutes }
            : {}),
          ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
        })
        this.emitTodos(sessionId)
        this.emitScheduled(sessionId)
        return { task }
      }
      case 'schedules.toTodo': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '定时任务', 80)
        const todo = await this.options.store.convertScheduledTaskToTodo(sessionId, taskId)
        this.emitTodos(sessionId)
        this.emitScheduled(sessionId)
        return { todo }
      }
      case 'queue.insert': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const taskId = requireString(params['taskId'], '排队消息', 80)
        await this.options.runner.insertQueueItem(sessionId, taskId)
        return { ok: true }
      }
      case 'approval.decide': {
        const callId = requireString(params['callId'], '审批请求', 120)
        const approved = params['approved'] === true
        const reason =
          typeof params['reason'] === 'string' ? params['reason'].slice(0, 500) : undefined
        await this.options.runner.decideApproval(callId, approved, reason)
        return { ok: true }
      }
      case 'approval.allowSession': {
        const callId = requireString(params['callId'], '审批请求', 120)
        const sessionId = requireString(params['sessionId'], '会话', 80)
        await this.options.store.updateSession(sessionId, { approvalMode: 'auto' })
        this.options.runner.setApprovalMode(sessionId, 'auto')
        await this.options.runner.decideApproval(callId, true)
        return { ok: true }
      }
      case 'approvals.list': {
        const sessionId =
          typeof params['sessionId'] === 'string' ? params['sessionId'].slice(0, 80) : undefined
        return { approvals: this.options.runner.pendingApprovalList(sessionId) }
      }
      case 'files.list': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const directory =
          typeof params['directory'] === 'string' && params['directory']
            ? params['directory'].slice(0, 2_000)
            : '.'
        const nodes: FileNode[] = await listDirectory(workspacePath, directory)
        return { path: workspacePath, directory, nodes }
      }
      case 'files.read': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const file = requireString(params['file'], '文件', 2_000)
        // A phone preview of a binary file (image/PDF/Office) asks for numbered
        // chunks; a plain read keeps returning the text preview shape.
        if (params['offset'] !== undefined || params['length'] !== undefined) {
          const offset =
            typeof params['offset'] === 'number' && Number.isFinite(params['offset'])
              ? params['offset']
              : 0
          const length =
            typeof params['length'] === 'number' && Number.isFinite(params['length'])
              ? params['length']
              : undefined
          return readFileChunk(workspacePath, file, offset, length)
        }
        const preview: FilePreview = await previewFile(workspacePath, file)
        return preview
      }
      case 'files.upload.begin': {
        this.pruneUploads()
        if (this.pendingUploads.size >= MAX_PENDING_UPLOADS) {
          throw new Error('同时上传的文件太多，请稍后再试')
        }
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        const directory =
          typeof params['directory'] === 'string' && params['directory'].trim()
            ? params['directory']
            : 'uploads'
        const name = requireString(params['name'], '文件名', 180)
        const sizeValue = params['size']
        if (typeof sizeValue !== 'number' || !Number.isFinite(sizeValue) || sizeValue < 0) {
          throw new Error('文件大小不正确')
        }
        const size = Math.floor(sizeValue)
        if (size > MAX_UPLOAD_BYTES) {
          throw new Error(
            `单个文件不能超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
          )
        }
        const uploadId = randomUUID().replace(/-/g, '')
        const plan = await beginWorkspaceUpload(workspacePath, directory, name, size, uploadId)
        this.pendingUploads.set(uploadId, {
          uploadId,
          workspacePath,
          tempPath: plan.tempPath,
          name,
          size,
          received: 0,
          createdAt: Date.now(),
        })
        return { uploadId, path: plan.path, name: plan.name, size }
      }
      case 'files.upload.chunk': {
        const uploadId = requireString(params['uploadId'], '上传编号', 80)
        const upload = this.pendingUploads.get(uploadId)
        if (!upload) throw new Error('上传已过期，请重新选择文件')
        this.assertUploadFresh(upload)
        const offsetValue = params['offset']
        if (
          typeof offsetValue !== 'number' ||
          !Number.isInteger(offsetValue) ||
          offsetValue < 0
        ) {
          throw new Error('上传分块位置不正确')
        }
        if (offsetValue !== upload.received) {
          throw new Error('上传分块顺序不正确，请重新上传')
        }
        const data = params['data']
        if (typeof data !== 'string' || !data.trim()) throw new Error('上传分块为空')
        const clean = data.replace(/\s+/g, '')
        if (clean.length > MAX_UPLOAD_CHUNK_BASE64) throw new Error('上传分块太大')
        if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
          throw new Error('上传分块格式不正确')
        }
        const buffer = Buffer.from(clean, 'base64')
        if (!buffer.length) throw new Error('上传分块为空')
        if (buffer.length > MAX_UPLOAD_CHUNK_BYTES) throw new Error('上传分块太大')
        if (upload.received + buffer.length > upload.size) {
          throw new Error('上传数据超过了文件大小')
        }
        await appendWorkspaceUpload(upload.tempPath, buffer)
        upload.received += buffer.length
        return { received: upload.received, size: upload.size }
      }
      case 'files.upload.finish': {
        const uploadId = requireString(params['uploadId'], '上传编号', 80)
        const upload = this.pendingUploads.get(uploadId)
        if (!upload) throw new Error('上传已过期，请重新选择文件')
        this.assertUploadFresh(upload)
        if (upload.received !== upload.size) {
          throw new Error('文件还没有上传完整，请继续上传')
        }
        const finished = await finishWorkspaceUpload(
          upload.workspacePath,
          upload.tempPath,
          upload.name,
          upload.size,
        )
        this.pendingUploads.delete(uploadId)
        return finished
      }
      case 'files.upload.cancel': {
        const uploadId = requireString(params['uploadId'], '上传编号', 80)
        const upload = this.pendingUploads.get(uploadId)
        if (upload) {
          this.pendingUploads.delete(uploadId)
          await abortWorkspaceUpload(upload.tempPath).catch(() => undefined)
        }
        return { ok: true }
      }
      case 'files.session': {
        const sessionId = requireString(params['sessionId'], '会话', 80)
        const session = this.options.store.session(sessionId)
        if (!session) throw new Error('会话不存在')
        // Only paths the agent actually wrote are listed; reading any of them
        // still goes through files.read and its workspace jail.
        return { artifacts: collectSessionArtifacts(session.messages) }
      }
      case 'update.state': {
        return { state: this.requireUpdate().state() }
      }
      case 'update.check': {
        return { state: await this.requireUpdate().check() }
      }
      case 'update.download': {
        const update = this.requireUpdate()
        const current = update.state()
        // 下载可能持续几分钟，手机请求不能一直挂着；开始后立即返回，
        // 后续进度通过 update.changed 事件推送。
        if (current.status === 'available') {
          void update.download().catch(() => undefined)
        }
        return { state: update.state() }
      }
      case 'update.install': {
        const update = this.requireUpdate()
        const running =
          typeof this.options.runner.activeRunCount === 'function'
            ? this.options.runner.activeRunCount()
            : 0
        if (running > 0) {
          throw new Error('电脑上还有任务正在执行，请等任务结束后再安装更新。')
        }
        await update.install()
        return { ok: true }
      }
      case 'evolution.state': {
        const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
        this.assertWorkspace(workspacePath)
        return this.requireEvolution().snapshot(workspacePath)
      }
      case 'evolution.personal':
        return this.requireEvolution().personal()
      case 'evolution.action': {
        const action = requireString(params['action'], '操作', 40)
        return this.requireEvolution().action(action, params)
      }
      case 'models.get': {
        // Public resource list and role selections; keys never leave the desktop.
        return this.options.store.modelSettingsView()
      }
      case 'models.update': {
        const input: {
          sessionModelId?: string
          evaluationModelIds?: string[]
          reviewModelId?: string
        } = {}
        if (params['sessionModelId'] !== undefined) {
          input.sessionModelId = requireString(params['sessionModelId'], '会话模型', 80)
        }
        if (params['reviewModelId'] !== undefined) {
          input.reviewModelId =
            typeof params['reviewModelId'] === 'string'
              ? params['reviewModelId'].slice(0, 80)
              : ''
        }
        if (params['evaluationModelIds'] !== undefined) {
          if (!Array.isArray(params['evaluationModelIds'])) {
            throw new Error('评估模型格式不正确')
          }
          input.evaluationModelIds = params['evaluationModelIds']
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 6)
        }
        await this.options.store.updateSettings(input)
        this.options.billing.invalidate?.()
        // Keep an open desktop settings window in step with the phone.
        this.options.onEvent?.({
          type: 'settings.changed',
          settings: this.options.store.settingsView(),
        })
        return this.options.store.modelSettingsView()
      }
      case 'billing.get':
        // Balance and local usage only; the API key never leaves the main process.
        return this.options.billing.report(params['refresh'] === true)
      case 'ping':
        return { ok: true, t: Date.now() }
      default:
        throw new Error(`手机端不支持该操作：${method}`)
    }
  }

  /** The updater is optional so an older/newer pairing still works both ways. */
  private requireUpdate(): NonNullable<CompanionOptions['update']> {
    const update = this.options.update
    if (!update) {
      throw new Error('当前电脑端版本不支持手机控制更新，请先在电脑上更新 Pilot。')
    }
    return update
  }

  /** Capabilities the host did not declare, i.e. every build before this flag. */
  private capabilities(): HostCapabilities {
    return this.options.capabilities ?? DESKTOP_CAPABILITIES
  }

  /**
   * Same compatibility rule for the self-evolution controls, but the message
   * has to tell the two reasons apart: an old host, or a headless host that
   * declares the capability missing and will never get it from an update.
   */
  private requireEvolution(): NonNullable<CompanionOptions['evolution']> {
    const evolution = this.options.evolution
    if (!evolution) {
      throw new Error(
        this.capabilities().evolution
          ? '当前电脑端版本不支持手机控制自进化，请先在电脑上更新 Pilot。'
          : '服务器模式不支持手机控制自进化与个人版本，请在电脑端操作。',
      )
    }
    return evolution
  }

  private scheduleInput(
    params: Record<string, unknown>,
    requireContent: boolean,
  ): Partial<ScheduledTaskInput> & { enabled?: boolean } {
    const input: Partial<ScheduledTaskInput> & { enabled?: boolean } = {}
    if (typeof params['content'] === 'string' && params['content'].trim()) {
      input.content = params['content'].slice(0, 4_000)
    } else if (requireContent) {
      throw new Error('定时任务内容不能为空')
    }
    if (
      params['kind'] === 'once' ||
      params['kind'] === 'interval' ||
      params['kind'] === 'daily'
    ) {
      input.kind = params['kind']
    } else if (requireContent) {
      throw new Error('请选择执行方式')
    }
    const delayMinutes = params['delayMinutes']
    if (typeof delayMinutes === 'number' && Number.isFinite(delayMinutes)) {
      input.delayMinutes = delayMinutes
    }
    const intervalMinutes = params['intervalMinutes']
    if (typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes)) {
      input.intervalMinutes = intervalMinutes
    }
    if (typeof params['timeOfDay'] === 'string') {
      input.timeOfDay = params['timeOfDay'].slice(0, 5)
    }
    if (typeof params['enabled'] === 'boolean') input.enabled = params['enabled']
    return input
  }

  /** Expired uploads never keep a hidden temporary file around. */
  private pruneUploads(): void {
    const now = Date.now()
    for (const upload of this.pendingUploads.values()) {
      if (now - upload.createdAt <= UPLOAD_TTL_MS) continue
      this.pendingUploads.delete(upload.uploadId)
      void abortWorkspaceUpload(upload.tempPath).catch(() => undefined)
    }
  }

  private assertUploadFresh(upload: PendingUpload): void {
    if (Date.now() - upload.createdAt <= UPLOAD_TTL_MS) return
    this.pendingUploads.delete(upload.uploadId)
    void abortWorkspaceUpload(upload.tempPath).catch(() => undefined)
    throw new Error('上传已过期，请重新选择文件')
  }

  private assertWorkspace(path: string): void {
    if (!this.options.store.workspaces().some((workspace) => workspace.path === path)) {
      throw new Error('工作区未打开')
    }
  }

  /** Trim the report so even a heavily populated scan fits one relay frame. */
  private phoneModuleCheckReport(report: ModuleCheckReport): PhoneModuleCheckReport {
    const counts = { high: 0, medium: 0, low: 0 }
    for (const risk of report.risks) {
      if (risk.severity === 'high') counts.high += 1
      else if (risk.severity === 'medium') counts.medium += 1
      else counts.low += 1
    }
    // Trimming the tail of a module-ordered list could drop every high risk
    // found in later modules. Apply the same canonical ordering the desktop
    // report uses so a capped phone payload still shows the items that matter
    // most; the desktop keeps the full report either way.
    const ranked = sortRisks(report.risks)
    return {
      ...report,
      risks: ranked.slice(0, PHONE_MODULE_RISK_LIMIT),
      riskTotal: report.risks.length,
      riskCounts: counts,
    }
  }

  private async phoneLearningState(workspacePath: string): Promise<PhoneLearningState> {
    const settings = this.options.store.settingsView()
    const policy = resolveLearningPolicy(settings)
    const entries = await readLearningLedger(workspacePath)
    return {
      enabled: settings.learningMode === true,
      hosts: [...settings.learningHosts],
      effectiveHosts: [...policy.hosts],
      defaultHosts: [...DEFAULT_LEARNING_HOSTS],
      ledger: '.pilot/learning/ledger.jsonl',
      entryTotal: entries.length,
      summary: summarizeLearning(entries),
      // 最新记录在前，手机端不需要滚动到最底部才能看到刚发生的事。
      entries: entries.slice(-PHONE_LEARNING_ENTRY_LIMIT).reverse().map(phoneLearningEntry),
    }
  }

  private phoneModuleCheckState(
    state: ModuleCheckSummary | ModuleCheckState,
  ): PhoneModuleCheckState {
    const historyCount = 'historyCount' in state ? state.historyCount : state.history.length
    return {
      settings: state.settings,
      ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
      ...(state.nextRunAt ? { nextRunAt: state.nextRunAt } : {}),
      ...(state.lastReport ? { lastReport: this.phoneModuleCheckReport(state.lastReport) } : {}),
      historyCount,
      decisions: state.decisions.slice(0, 5),
      proposals: state.proposals.slice(0, 3).map((proposal) => {
        // 手机上只看构造思路，预览截断到 1500 字，避免状态帧过大。
        const limit = 1_500
        const promptTruncated = proposal.prompt.length > limit
        return {
          id: proposal.id,
          reportId: proposal.reportId,
          createdAt: proposal.createdAt,
          riskIds: proposal.riskIds.slice(0, 200),
          prompt: promptTruncated ? `${proposal.prompt.slice(0, limit)}…` : proposal.prompt,
          promptTruncated,
          selfModify: proposal.selfModify === true,
          ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}),
          ...(proposal.refreshedAt ? { refreshedAt: proposal.refreshedAt } : {}),
        }
      }),
    }
  }

  private listSessions(): {
    sessions: Array<SessionSummary & { workspaceName: string }>
    workspaces: WorkspaceSummary[]
    roots: string[]
  } {
    const workspaces = this.options.store.workspaces()
    const names = new Map(workspaces.map((workspace) => [workspace.path, workspace.name]))
    const sessions: Array<SessionSummary & { workspaceName: string }> = []
    for (const workspace of workspaces) {
      for (const session of this.options.store.sessions(workspace.path)) {
        sessions.push({
          ...session,
          workspaceName: names.get(session.workspacePath) ?? workspace.name,
        })
      }
    }
    sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { sessions, workspaces, roots: this.options.store.phoneRoots() }
  }

  private getSession(params: Record<string, unknown>): {
    session: Session
    hasMore: boolean
    hasNewer: boolean
    pendingApprovals: ReturnType<AgentRunner['pendingApprovalList']>
    activeRun: ReturnType<AgentRunner['activeRun']>
    workspaceName: string
  } {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    const session = this.options.store.session(sessionId)
    if (!session) throw new Error('会话不存在')
    const limit = clampInt(params['limit'], 120, 1, 300)
    let start = Math.max(0, session.messages.length - limit)
    let end = session.messages.length
    let hasNewer = false
    const around = typeof params['around'] === 'string' ? params['around'] : ''
    const before = typeof params['before'] === 'string' ? params['before'] : ''
    if (around) {
      // 知识库检索命中较旧的消息时，返回以命中项为中心的窗口。
      const index = session.messages.findIndex((message) => message.id === around)
      if (index >= 0) {
        start = Math.max(0, Math.min(index - Math.floor(limit / 2), session.messages.length - limit))
        end = Math.min(session.messages.length, start + limit)
        hasNewer = end < session.messages.length
      }
    } else if (before) {
      const index = session.messages.findIndex((message) => message.id === before)
      if (index >= 0) end = index
      start = Math.max(0, end - limit)
    }
    const messages = this.phoneSafeMessages(session.messages.slice(start, end))
    const workspace = this.options.store
      .workspaces()
      .find((entry) => entry.path === session.workspacePath)
    return {
      session: {
        ...session,
        messages,
        running: this.options.runner.isRunning(session.id),
        messageCount: session.messages.length,
        queueCount: session.queue.length,
      },
      hasMore: start > 0,
      hasNewer,
      pendingApprovals: this.options.runner.pendingApprovalList(session.id),
      activeRun: this.options.runner.activeRun(session.id),
      workspaceName: workspace?.name ?? session.workspacePath,
    }
  }

  /** 会话知识库检索：全量搜索用户与 Pilot 的消息正文。 */
  private searchSessions(params: Record<string, unknown>): { hits: MessageSearchHit[] } {
    const query = requireString(params['query'], '搜索内容', 200)
    const limit = clampInt(params['limit'], 40, 1, 200)
    const filter: MessageSearchFilter = {}
    if (typeof params['workspacePath'] === 'string' && params['workspacePath'].trim()) {
      filter.workspacePath = params['workspacePath'].trim()
    }
    if (typeof params['sessionId'] === 'string' && params['sessionId'].trim()) {
      filter.sessionId = params['sessionId'].trim().slice(0, 80)
    }
    if (params['role'] === 'user' || params['role'] === 'assistant') {
      filter.role = params['role']
    }
    if (typeof params['since'] === 'string' && params['since']) {
      filter.since = params['since']
    }
    return { hits: this.options.store.searchSessions(query, limit, filter) }
  }

  /**
   * 会话知识库：把「我的指令」和紧随其后的 Pilot 回复成对返回。
   * 查询命中时仍在整段会话上匹配，只把最新的若干对带回手机，
   * 长回复按固定上限截断，避免超过中继单帧大小。
   */
  private sessionKnowledge(params: Record<string, unknown>): {
    pairs: KnowledgePair[]
    total: number
    hasMore: boolean
  } {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    const session = this.options.store.session(sessionId)
    if (!session) throw new Error('会话不存在')
    const query = typeof params['query'] === 'string' ? params['query'].trim().slice(0, 200) : ''
    const limit = clampInt(params['limit'], 60, 1, 200)
    const all = buildKnowledgePairs(session.messages)
    const needle = query.toLowerCase().replace(/\s+/g, ' ')
    const matched = needle
      ? all.filter((pair) =>
          `${pair.instruction}\n${pair.reply}`
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .includes(needle),
        )
      : all
    // 中继单帧有大小上限，按字符总量从最新往回挑，宁少勿撑爆一帧。
    const selected: KnowledgePair[] = []
    let used = 0
    for (let index = matched.length - 1; index >= 0 && selected.length < limit; index -= 1) {
      const pair = clipKnowledgePair(matched[index]!)
      const size = pair.instruction.length + pair.reply.length
      if (selected.length > 0 && used + size > KNOWLEDGE_PAYLOAD_CHARS) break
      selected.push(pair)
      used += size
    }
    selected.reverse()
    return {
      pairs: selected,
      total: matched.length,
      hasMore: matched.length > selected.length,
    }
  }

  /**
   * 手机端任务卡片上的「链接」预览。
   *
   * 只回传会话正文里出现过的 http(s) 链接，不访问网络：手机看到的是「这个
   * 任务里提过哪些链接」，不是「链接背后的内容」。与桌面端 `pilot:session-links`
   * 用同一个收集器，两端口径一致。
   */
  private sessionLinks(params: Record<string, unknown>): {
    links: SessionLink[]
    total: number
    hasMore: boolean
  } {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    const session = this.options.store.session(sessionId)
    if (!session) throw new Error('会话不存在')
    const limit = clampInt(params['limit'], PHONE_LINK_LIMIT, 1, 200)
    const all = collectSessionLinks(session.messages)
    return {
      links: all.slice(0, limit).map((link) => ({
        ...link,
        // 极少见的超长 URL 截断到 2000 字符，避免一帧被单条链接撑爆。
        url: link.url.slice(0, PHONE_LINK_URL_CHARS),
      })),
      total: all.length,
      hasMore: all.length > limit,
    }
  }

  /**
   * 手机端任务卡片上的「工具」预览：这个任务的工作区在一次运行里会拿到哪些
   * 工具。过滤条件与运行器一致（shell 模式、学习策略、MCP 开关），所以手机上
   * 看到的就是真实可用清单，而不是代码里定义过的全部工具。
   *
   * 不回传 `inputSchema`：手机只用它显示名称、来源、风险和一句说明。
   */
  private async sessionTools(params: Record<string, unknown>): Promise<{
    tools: Array<{
      name: string
      description: string
      risk: ToolCatalogEntry['risk']
      source: ToolCatalogEntry['source']
      enabled: boolean
      approved?: boolean
      version?: number
    }>
    total: number
    hasMore: boolean
    mcpEnabled: boolean
  }> {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    const session = this.options.store.session(sessionId)
    if (!session) throw new Error('会话不存在')
    const settings = this.options.store.settings()
    const builtin = filterLearningTools(
      settings.shellMode
        ? pilotTools
        : pilotTools.filter((tool) => tool.name !== RUN_SHELL),
      resolveLearningPolicy(settings).enabled,
    )
    const servers = await loadMcpConfig(session.workspacePath).catch(() => ({}))
    const registry = await this.toolRegistry(session.workspacePath)
    const catalog = buildToolCatalog({
      builtin,
      dynamic: await registry.list().catch(() => []),
      mcpServers: Object.keys(servers),
      mcpEnabled: settings.mcpEnabled === true,
    })
    const tools = catalog.slice(0, PHONE_TOOL_LIMIT).map((tool) => ({
      name: tool.name,
      description:
        tool.description.length > PHONE_TOOL_DESCRIPTION_CHARS
          ? `${tool.description.slice(0, PHONE_TOOL_DESCRIPTION_CHARS)}…`
          : tool.description,
      risk: tool.risk,
      source: tool.source,
      // 内置工具没有 enabled 字段，出现即代表可用。
      enabled: tool.enabled !== false,
      ...(tool.approved === undefined ? {} : { approved: tool.approved }),
      ...(tool.version === undefined ? {} : { version: tool.version }),
    }))
    return {
      tools,
      total: catalog.length,
      hasMore: catalog.length > tools.length,
      mcpEnabled: settings.mcpEnabled === true,
    }
  }

  /**
   * The encrypted relay envelope is capped at 512 KB. Keep the newest image
   * attachments inside a small budget and drop older ones from the phone view
   * so a long session page still fits; the desktop keeps the originals.
   */
  private phoneSafeMessages(messages: StoredMessage[]): StoredMessage[] {
    const budget = 300_000
    let used = 0
    const out = [...messages]
    for (let index = out.length - 1; index >= 0; index -= 1) {
      const message = out[index]
      if (!message) continue
      const images = message.images
      if (!images || images.length === 0) continue
      const size = images.reduce((total, url) => total + url.length, 0)
      if (used + size <= budget) {
        used += size
        continue
      }
      out[index] = { ...message, images: [] }
    }
    return out
  }

  /**
   * Create a workspace from the phone. The phone names a single folder inside
   * the authorized root (or inside any of its subdirectories); the desktop
   * resolves the real paths and re-checks containment after creating the
   * directory.
   */
  private async createWorkspace(params: Record<string, unknown>): Promise<WorkspaceSummary> {
    const roots = this.options.store.phoneRoots()
    if (roots.length === 0) {
      throw new Error('电脑端还没有配置「手机可创建的工作区」目录')
    }
    const requestedRoot = requireString(params['root'], '授权目录', 1_000)
    const root = await this.matchPhoneRoot(requestedRoot, roots)
    if (!root) throw new Error('只能在自己电脑授权过的目录里新建工作区')
    const name = requireString(params['name'], '工作区名称', WORKSPACE_NAME_MAX)
    if (name === '.' || name === '..' || WORKSPACE_NAME_INVALID.test(name)) {
      throw new Error('工作区名称不能包含 / \\ : * ? " < > | 等字符')
    }
    if (name.endsWith('.') || name.endsWith(' ')) {
      throw new Error('工作区名称不能以点或空格结尾')
    }
    if (RESERVED_WORKSPACE_NAMES.test(name)) {
      throw new Error('这个名称是系统保留名，请换一个')
    }

    // The phone may create the folder at the root or inside the subdirectory
    // it is currently browsing.
    const parent = await this.phoneDirectory(root, params['path'])
    const target = join(parent.resolved, name)
    try {
      assertInside(parent.resolved, target)
    } catch {
      throw new Error('只能在自己电脑授权过的目录里新建工作区')
    }
    const existing = await stat(target).catch(() => null)
    if (existing) {
      if (!existing.isDirectory()) throw new Error('同名文件已存在，请换一个名称')
    } else {
      try {
        await mkdir(target, { recursive: false })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    let resolved = ''
    try {
      resolved = await realpath(target)
      assertInside(parent.resolved, resolved)
    } catch {
      throw new Error('新建的目录不在授权范围内')
    }
    const workspace = await this.options.store.addWorkspace(resolved, { activate: false })
    this.notify({ type: 'workspace.changed', workspacePath: workspace.path })
    return workspace
  }

  /** List subdirectories under an authorized root, at any depth. */
  private async browseWorkspace(params: Record<string, unknown>): Promise<{
    root: string
    directory: string
    parent: string
    entries: Array<{ name: string; path: string }>
    truncated: boolean
  }> {
    const roots = this.options.store.phoneRoots()
    if (roots.length === 0) {
      throw new Error('电脑端还没有配置「手机可创建的工作区」目录')
    }
    const requestedRoot = requireString(params['root'], '授权目录', 1_000)
    const root = await this.matchPhoneRoot(requestedRoot, roots)
    if (!root) throw new Error('只能浏览自己电脑授权过的目录')
    const directory = await this.phoneDirectory(root, params['path'])
    const dirents = await readdir(directory.path, { withFileTypes: true })
    const entries: Array<{ name: string; path: string }> = []
    let truncated = false
    const sorted = dirents
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of sorted) {
      if (entries.length >= 300) {
        truncated = true
        break
      }
      const child = join(directory.path, entry.name)
      let info
      try {
        info = await stat(child)
      } catch {
        continue
      }
      if (!info.isDirectory()) continue
      // Resolve every directory so junctions/symlinks pointing outside the
      // authorized root never show up in the list.
      try {
        assertInside(root, await realpath(child))
      } catch {
        continue
      }
      entries.push({
        name: entry.name,
        path: directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
      })
    }
    return {
      root,
      directory: directory.relative,
      parent: directory.relative ? directory.relative.split('/').slice(0, -1).join('/') : '',
      entries,
      truncated,
    }
  }

  /** Register an existing subdirectory under an authorized root as a workspace. */
  private async openWorkspace(params: Record<string, unknown>): Promise<WorkspaceSummary> {
    const roots = this.options.store.phoneRoots()
    if (roots.length === 0) {
      throw new Error('电脑端还没有配置「手机可创建的工作区」目录')
    }
    const requestedRoot = requireString(params['root'], '授权目录', 1_000)
    const root = await this.matchPhoneRoot(requestedRoot, roots)
    if (!root) throw new Error('只能把自己电脑授权过的目录作为工作区')
    const directory = await this.phoneDirectory(root, params['path'])
    const workspace = await this.options.store.addWorkspace(directory.resolved, {
      activate: false,
    })
    this.notify({ type: 'workspace.changed', workspacePath: workspace.path })
    return workspace
  }

  /**
   * Forget a workspace from the console. Files and session shards stay on disk,
   * exactly like the desktop's remove, so nothing is destroyed by one tap.
   */
  private async removeWorkspace(params: Record<string, unknown>): Promise<{ ok: true }> {
    const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
    this.assertWorkspace(workspacePath)
    if (this.options.store.workspaces().length <= 1) {
      throw new Error('至少要保留一个工作区')
    }
    await this.options.store.removeWorkspace(workspacePath)
    this.notify({ type: 'workspace.changed', workspacePath })
    return { ok: true }
  }

  /** Delete one session and its checkpoints, from the console or a browser. */
  private async deleteSession(params: Record<string, unknown>): Promise<{ ok: true }> {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    if (!this.options.store.session(sessionId)) throw new Error('会话不存在')
    if (this.options.runner.isRunning(sessionId)) {
      throw new Error('请先停止正在运行的任务再删除会话')
    }
    await this.options.store.deleteSession(sessionId)
    await this.options.checkpoints?.removeSession(sessionId)
    this.notify({ type: 'session.changed', sessionId, plan: null })
    return { ok: true }
  }

  /** Registry of agent-written tools for one workspace (list only). */
  private async toolRegistry(workspacePath: string): Promise<DynamicToolRegistry> {
    const settings = this.options.store.settings()
    return new DynamicToolRegistry({
      workspacePath,
      userDataDir: this.options.dataDir,
      testTargets: settings.testTargets,
      testCaptchaMode: settings.testCaptchaMode,
      testCaptcha: this.options.store.getTestCaptcha(),
    })
  }

  /**
   * Resolve a phone-supplied path relative to an authorized root and prove it
   * stays inside. The phone never sends an absolute path for browsing or
   * opening; only single-segment names and relative subpaths are accepted.
   */
  private async phoneDirectory(
    root: string,
    input: unknown,
  ): Promise<{ relative: string; path: string; resolved: string }> {
    const display = typeof input === 'string' ? input.trim().replace(/\\/g, '/') : ''
    const relative = display === '.' ? '' : display.replace(/^\/+|\/+$/g, '')
    if (!relative) {
      const resolved = await realpath(root)
      assertInside(root, resolved)
      return { relative: '', path: root, resolved }
    }
    const segments = relative.split('/')
    if (
      segments.some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          segment.includes(':') ||
          segment.includes('\0'),
      )
    ) {
      throw new Error('目录不在授权范围内')
    }
    const target = join(root, ...segments)
    try {
      assertInside(root, target)
    } catch {
      throw new Error('目录不在授权范围内')
    }
    let resolved = ''
    try {
      resolved = await realpath(target)
      assertInside(root, resolved)
    } catch {
      throw new Error('目录不在授权范围内')
    }
    const info = await stat(resolved)
    if (!info.isDirectory()) throw new Error('选择的不是文件夹')
    return { relative: segments.join('/'), path: target, resolved }
  }

  private async matchPhoneRoot(requested: string, roots: string[]): Promise<string> {
    const key = (value: string): string => {
      const path = normalize(resolve(value))
      return process.platform === 'win32' ? path.toLowerCase() : path
    }
    const wanted = key(requested)
    for (const root of roots) {
      if (key(root) === wanted) {
        try {
          return await realpath(root)
        } catch {
          return ''
        }
      }
    }
    return ''
  }

  private async createSession(params: Record<string, unknown>): Promise<Session> {
    const workspaces = this.options.store.workspaces()
    if (workspaces.length === 0) throw new Error('电脑上还没有打开工作区')
    const requested =
      typeof params['workspacePath'] === 'string' ? params['workspacePath'] : ''
    const workspace =
      workspaces.find((entry) => entry.path === requested) ??
      workspaces.find((entry) => entry.path === this.options.store.activeWorkspace()) ??
      workspaces[0]
    if (!workspace) throw new Error('电脑上还没有打开工作区')
    return this.options.store.createSession(workspace.path)
  }

  private async renameSession(params: Record<string, unknown>): Promise<SessionSummary> {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    const title = requireString(params['title'], '标题', 120)
    return this.options.store.updateSession(sessionId, { title })
  }

  /** 任务级会话模型：空串清除，回到项目/全局；只影响下一次请求。 */
  private async setSessionModel(params: Record<string, unknown>): Promise<SessionSummary> {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    if (typeof params['modelId'] !== 'string') {
      // 缺参不能当成“清除”，否则用户会以为设置成功却悄悄改回继承模型。
      throw new Error('模型参数格式不正确')
    }
    return this.options.store.setSessionModel(sessionId, params['modelId'].slice(0, 80))
  }

  private async setApprovalMode(params: Record<string, unknown>): Promise<SessionSummary> {
    const sessionId = requireString(params['sessionId'], '会话', 80)
    const mode = params['approvalMode']
    if (
      mode !== 'manual' &&
      mode !== 'ask' &&
      mode !== 'auto' &&
      // Legacy names from older app builds are migrated by the store.
      mode !== 'acceptEdits' &&
      mode !== 'plan' &&
      mode !== 'dontAsk'
    ) {
      throw new Error('执行模式不正确')
    }
    const updated = await this.options.store.updateSession(sessionId, {
      approvalMode: mode as ApprovalMode,
    })
    this.options.runner.setApprovalMode(sessionId, updated.approvalMode)
    return updated
  }
}
