import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import QRCode from 'qrcode'
import { WebSocket, WebSocketServer } from 'ws'
import type {
  CompanionPairRequest,
  CompanionPairing,
  CompanionStatus,
  KnowledgePair,
  MessageSearchHit,
  ModuleCheckReport,
  ModuleCheckState,
  RunEvent,
  ScheduledTaskInput,
  Session,
  SessionLink,
  SessionSummary,
  StoredMessage,
  ToolCatalogEntry,
  WorkspaceSummary,
} from '../../shared/types'
import type { HostCapabilities } from '../../shared/capabilities'
import type { ModuleCheckSummary } from '../../shared/module-check'
import { normalizeRelayUrl, splitRelayUrl } from '../../shared/relay'
import { PluginHost } from '../plugins/runtime'
import { DynamicToolRegistry } from '../agent/toolsmith'
import type { AgentRunner } from '../agent/runner'
import { abortWorkspaceUpload } from '../workspace'
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
} from './crypto'
import { RelayHostChannel, type RelayChannelState } from './relay'
import {
  APP_DOWNLOAD_URL,
  CHALLENGE_TTL_MS,
  DEFAULT_APP_URL,
  DEFAULT_PORT,
  HEARTBEAT_MS,
  HEARTBEAT_MISS_LIMIT,
  ID_RE,
  LOOKUP_RE,
  MAX_PAYLOAD,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  PAIR_APPROVAL_TTL_MS,
  PAIR_BUSY_REASON,
  PAIR_EXPIRY_MS,
  PROTOCOL_VERSION,
  PUBLIC_KEY_RE,
  SILENCE_MS,
  STATE_VERSION,
  TRANSFER_PAIRING_TTL_MS,
} from './constants'
import {
  asRecord,
  cleanText,
  clampInt,
  CONTENT_TYPES,
  lanAddresses,
  nowIso,
  preferredLanAddress,
  publicPhone,
  readRequestBody,
  seal,
  STATIC_ROUTES,
  unseal,
  withDesktopSurface,
  wsEndpoint,
} from './helpers'
import { RelaySocket } from './relay-socket'
import { routePhoneRequest } from './handlers'
import { accessLevelOf, roleOfAccess, type AccessLevel } from './access-level'
import { bridgeIdentity } from './handlers/bridge'
import {
  bindScopedOptions,
  guestScopeOf,
  withCompanionScope,
  type CompanionRole,
  type CompanionScope,
} from './scope'
import {
  blankState,
  blankSave,
  saveNow,
  emitStatus,
  status,
  setEnabled,
  setRelayUrl,
  notify,
  publish,
  emitTodos,
  emitScheduled,
} from './handlers/runtime'
import {
  pluginHost,
  listenHost,
  addressHost,
  appBaseUrl,
  publicBaseUrl,
  lanUrls,
  listeningPort,
} from './handlers/address'
import {
  createPairing,
  createTransferPairing,
  buildPairingOffer,
  resolvePairing,
  pendingPairing,
  requestPairApproval,
  settlePairing,
  appQr,
  roomInUse,
  ensureRelayRoom,
  startRelay,
  closeRelayRoom,
  stopRelay,
  activeOffer,
  clearOffer,
  relayEndpoint,
  relayUrl,
  relayAccess,
  relaySource,
  localUrl,
} from './handlers/pairing'
import {
  handleHttp,
  handlePluginHttp as runHandlePluginHttp,
  handleConnection,
  checkHeartbeat,
  sendRaw,
  sendError,
  handleFrame,
} from './handlers/connection'
import {
  handlePairJoin,
  handleHello,
  handleHelloProof,
  completeHello,
  phoneKey,
  handleEncrypted,
  sendEncrypted,
} from './handlers/handshake'
import {
  consumeOffer,
  offerAlive,
  takeAccessOffer,
} from './handlers/access'
import {
  listSessions,
  getSession,
  phoneSafeMessages,
  searchSessions,
  sessionKnowledge,
  sessionLinks,
  sessionTools,
  toolRegistry,
  phoneDirectory,
  matchPhoneRoot,
  createWorkspace,
  browseWorkspace,
  openWorkspace,
  removeWorkspace,
  deleteSession,
  createSession,
  renameSession,
  setSessionModel,
  setApprovalMode,
} from './handlers/views'
import {
  capabilities,
  requireUpdate,
  requireEvolution,
  requireReflect,
  scheduleInput,
  pruneUploads,
  assertUploadFresh,
  assertWorkspace,
  phoneModuleCheckReport,
  phoneModuleCheckState,
  phoneLearningState,
} from './handlers/host-support'
import type {
  ClientConnection,
  CompanionOptions,
  CompanionState,
  ConnectionSocket,
  PairingOffer,
  PageTicket,
  PendingPairing,
  PendingUpload,
  PhoneLearningState,
  PhoneModuleCheckReport,
  PhoneModuleCheckState,
  RelayRoom,
  StoredPhone,
} from './types'

export type { CompanionOptions }

export class CompanionServer {
  readonly stateFile: string
  state: CompanionState
  server: Server | null = null
  private wss: WebSocketServer | null = null
  private heartbeat: NodeJS.Timeout | null = null
  offerTimer: NodeJS.Timeout | null = null
  saveTimer: NodeJS.Timeout | null = null
  offer: PairingOffer | null = null
  /** 浏览器页面申请的一次性凭据，按 lookup 存放；二维码仍占 `offer` 单槽。 */
  readonly accessOffers = new Map<string, PairingOffer>()
  /** 网页服务的访问凭据申请（`POST /bridge/ticket`），按 ticket id 存放。 */
  readonly pageTickets = new Map<string, PageTicket>()
  pendingPair: PendingPairing | null = null
  pairApprovalTimer: NodeJS.Timeout | null = null
  connections = new Set<ClientConnection>()
  byPhone = new Map<string, ClientConnection>()
  readonly phoneSockets = new Set<string>()
  readonly relayRooms = new Map<string, RelayRoom>()
  readonly pendingUploads = new Map<string, PendingUpload>()
  relayError: string | null = null
  appQrCache: { url: string; qrDataUrl: string } | null = null
  lastError: string | null = null

  constructor(readonly rawOptions: CompanionOptions) {
    this.stateFile = join(rawOptions.dataDir, 'companion.json')
    this.state = this.blankState()
    // 两套数据面：本机（以及等同本机的 host 用户）用 primary，客户机用户用
    // guest（宿主装配的第二套 Store + AgentRunner）。绑定后的 `options` 让所有
    // 现有的 `host.options.store` 读取自动跟随当前请求链，不必改上百处调用点。
    this.primaryScope = {
      role: 'host',
      store: rawOptions.store,
      runner: rawOptions.runner,
      billing: rawOptions.billing,
      ...(rawOptions.checkpoints ? { checkpoints: rawOptions.checkpoints } : {}),
      ...(rawOptions.changes ? { changes: rawOptions.changes } : {}),
    }
    this.guestData = guestScopeOf(rawOptions)
    this.options = bindScopedOptions(rawOptions, this.primaryScope)
  }

  /** 绑定作用域后的选项：只有数据面五项会随请求变，其余身份无关。 */
  readonly options: CompanionOptions
  /** 本机数据面：本机与 host 身份的远端共用。 */
  readonly primaryScope: CompanionScope
  /** 客户机用户的数据面；null 表示宿主还没装配（或装配失败）。 */
  private guestData: CompanionScope | null

  get guestScope(): CompanionScope | null {
    return this.guestData
  }

  /**
   * 启动后再装配客户机数据面。
   *
   * 第二套 Store + AgentRunner 建得慢（要读盘、建沙箱），而它的 publish 又
   * 要指向这个 companion 实例；先构造再装配避开了循环依赖。没有装配时
   * 客户机用户的请求一律被拒绝（见 handlers/index.ts），不会静默回退到主机数据。
   */
  attachGuest(data: Partial<CompanionScope> | null): void {
    this.guestData = data ? guestScopeOf({ ...this.rawOptions, guest: data }) : null
  }

  /**
   * External plugins live next to the workspace they extend. The host is built
   * on first use so a workspace-less server does not create stray directories.
   */
  pluginHostInstance: PluginHost | null = null
  /** 本服务挂在共享宿主上的通知出口，停服时只摘自己这一份。 */
  pluginHostDetach: (() => void) | null = null

  pluginHost(): PluginHost | null {
    return pluginHost(this)
  }

  blankState(): CompanionState {
    return blankState(this)
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

  relayEndpoint(): { url: string; access: string } {
    return relayEndpoint(this)
  }

  relayUrl(): string {
    return relayUrl(this)
  }

  relayAccess(): string {
    return relayAccess(this)
  }

  relaySource(): 'env' | 'settings' | 'none' {
    return relaySource(this)
  }

  appBaseUrl(): string {
    return appBaseUrl(this)
  }

  publicBaseUrl(): string {
    return publicBaseUrl(this)
  }

  listenHost(): string {
    return listenHost(this)
  }

  addressHost(): string {
    return addressHost(this)
  }

  status(): CompanionStatus {
    return status(this)
  }

  async setEnabled(enabled: boolean): Promise<CompanionStatus> {
    return setEnabled(this, enabled)
  }

  async setRelayUrl(value: string): Promise<CompanionStatus> {
    return setRelayUrl(this, value)
  }

  async createPairing(): Promise<CompanionPairing> {
    return createPairing(this)
  }

  async createTransferPairing(): Promise<CompanionPairing> {
    return createTransferPairing(this)
  }

  async buildPairingOffer(autoApprove: boolean): Promise<CompanionPairing> {
    return buildPairingOffer(this, autoApprove)
  }

  resolvePairing(requestId: string, approved: boolean, role?: 'host' | 'client'): boolean {
    return resolvePairing(this, requestId, approved, role)
  }

  pendingPairing(): CompanionPairRequest | null {
    return pendingPairing(this)
  }

  requestPairApproval(
    connection: ClientConnection,
    input: {
      phoneId: string
      name: string
      platform: string
      mode?: 'qr' | 'browser'
      role?: 'host' | 'client'
    },
  ): Promise<{ approved: boolean; reason?: string; role?: 'host' | 'client' }> {
    return requestPairApproval(this, connection, input)
  }

  takeAccessOffer(lookup: string): PairingOffer | null {
    return takeAccessOffer(this, lookup)
  }

  offerAlive(offer: PairingOffer): boolean {
    return offerAlive(this, offer)
  }

  consumeOffer(offer: PairingOffer): void {
    consumeOffer(this, offer)
  }

  settlePairing(
    requestId: string,
    approved: boolean,
    reason?: string,
    role?: 'host' | 'client',
  ): boolean {
    return settlePairing(this, requestId, approved, reason, role)
  }

  async appQr(): Promise<{ url: string; qrDataUrl: string }> {
    return appQr(this)
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
    return localUrl(this)
  }

  roomInUse(room: string): boolean {
    return roomInUse(this, room)
  }

  ensureRelayRoom(room: string, key: string): void {
    return ensureRelayRoom(this, room, key)
  }

  startRelay(): void {
    return startRelay(this)
  }

  closeRelayRoom(room: string): void {
    return closeRelayRoom(this, room)
  }

  stopRelay(): void {
    return stopRelay(this)
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
      let url: URL
      try {
        url = new URL(request.url ?? '/', 'http://pilot.local')
      } catch {
        socket.destroy()
        return
      }
      // `/bridge` 是浏览器里的桌面界面：先定级，认不出是谁就直接断开——
      // 这条通道背后是整份主进程 IPC 表，不能给匿名连接。桌面应用没有注入
      // IPC 表，因此那里永远不接这条通道。
      let bridgeLevel: AccessLevel | null = null
      let bridgePhoneId: string | null = null
      if (url.pathname === '/bridge') {
        if (!this.options.ipc) {
          socket.destroy()
          return
        }
        const identity = bridgeIdentity(this, request, url)
        if (!identity) {
          socket.destroy()
          return
        }
        bridgeLevel = identity.level
        bridgePhoneId = identity.phoneId
      } else if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, bridgeLevel ?? undefined, bridgePhoneId ?? undefined)
      })
    })
    wss.on('connection', (
      socket,
      request,
      bridgeLevel?: AccessLevel,
      bridgePhoneId?: string,
    ) =>
      this.handleConnection(socket as unknown as ConnectionSocket, {
        via: 'lan',
        address: request.socket.remoteAddress ?? undefined,
        ...(bridgeLevel ? { bridgeLevel } : {}),
        ...(bridgePhoneId ? { bridgePhoneId } : {}),
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
    // 插件进程是共享的（智能体的工具调用也要用），停服只摘自己的监听。
    this.pluginHostDetach?.()
    this.pluginHostDetach = null
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
    // 停服前把挂起的保存落盘：`blankSave()` 是 300ms 防抖，停服时不清掉它，
    // 它会在调用方（含测试）删完状态目录之后才写 state.json，留下写不进去的
    // 临时文件；桌面端关掉网页服务后也不该再动磁盘。
    await this.saveNow()
    this.emitStatus()
  }

  publish(event: RunEvent, role?: CompanionRole): void {
    return publish(this, event, role)
  }

  notify(event: RunEvent): void {
    return notify(this, event)
  }

  emitTodos(sessionId: string): void {
    return emitTodos(this, sessionId)
  }

  emitScheduled(sessionId: string): void {
    return emitScheduled(this, sessionId)
  }

  listeningPort(): number | null {
    return listeningPort(this)
  }

  lanUrls(): string[] {
    return lanUrls(this)
  }

  activeOffer(): PairingOffer | null {
    return activeOffer(this)
  }

  clearOffer(): void {
    return clearOffer(this)
  }

  emitStatus(): void {
    return emitStatus(this)
  }

  blankSave(): void {
    return blankSave(this)
  }

  async saveNow(): Promise<void> {
    return saveNow(this)
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    return handleHttp(this, request, response)
  }

  async handlePluginHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    return runHandlePluginHttp(this, request, response)
  }

  handleConnection(
    socket: ConnectionSocket,
    origin: { via: 'lan' | 'relay'; address?: string | undefined },
  ): void {
    return handleConnection(this, socket, origin)
  }

  checkHeartbeat(): void {
    return checkHeartbeat(this)
  }

  sendRaw(socket: ConnectionSocket, frame: unknown): void {
    return sendRaw(this, socket, frame)
  }

  sendError(connection: ClientConnection, code: string, message: string): void {
    return sendError(this, connection, code, message)
  }

  async handleFrame(connection: ClientConnection, raw: unknown): Promise<void> {
    return handleFrame(this, connection, raw)
  }

  async handlePairJoin(
    connection: ClientConnection,
    frame: Record<string, unknown>,
  ): Promise<void> {
    return handlePairJoin(this, connection, frame)
  }

  async handleHello(
    connection: ClientConnection,
    frame: Record<string, unknown>,
  ): Promise<void> {
    return handleHello(this, connection, frame)
  }

  async handleHelloProof(
    connection: ClientConnection,
    frame: Record<string, unknown>,
  ): Promise<void> {
    return handleHelloProof(this, connection, frame)
  }

  async completeHello(
    connection: ClientConnection,
    phone: StoredPhone,
    phoneId: string,
  ): Promise<void> {
    return completeHello(this, connection, phone, phoneId)
  }

  phoneKey(phone: StoredPhone, direction: 'pcToPhone' | 'phoneToPc'): Buffer {
    return phoneKey(this, phone, direction)
  }

  async handleEncrypted(phoneId: string, payload: unknown): Promise<void> {
    return handleEncrypted(this, phoneId, payload)
  }

  async sendEncrypted(phoneId: string, value: unknown): Promise<void> {
    return sendEncrypted(this, phoneId, value)
  }

  /**
   * 手机请求分发：具体 case 按域放在 handlers/ 下，这里只做转交。
   * 错误文案仍由各域的 default 分支给出，和拆分前一致。
   */
  async handleRequest(
    method: string,
    params: Record<string, unknown>,
    phone: StoredPhone,
    access: AccessLevel = 'paired',
  ): Promise<unknown> {
    // 请求链上绑定作用域：handler 里成百处 `host.options.store/runner` 因此
    // 自动解析到这条请求该用的那一套，离开请求链（定时任务、runner 回调）
    // 自然回到主机数据面。
    return withCompanionScope(this.scopeFor(access), () =>
      routePhoneRequest(this, method, params, phone, access),
    )
  }

  /** 这条连接该用哪一套数据面。 */
  scopeFor(access: AccessLevel): CompanionScope {
    return roleOfAccess(access) === 'client' && this.guestScope ? this.guestScope : this.primaryScope
  }

  /** 某条已连接设备所属的作用域角色：事件只投递给同一套数据面。 */
  scopeRoleOfPhone(phoneId: string): CompanionRole {
    const phone = this.state.phones[phoneId]
    if (!phone) return 'host'
    const connection = this.byPhone.get(phoneId)
    return roleOfAccess(
      accessLevelOf({
        via: connection?.via ?? 'relay',
        address: connection?.address ?? null,
        credential: phone.via,
        role: phone.role,
      }),
    )
  }requireUpdate(): NonNullable<CompanionOptions['update']> {
    return requireUpdate(this)
  }capabilities(): HostCapabilities {
    return capabilities(this)
  }requireEvolution(): NonNullable<CompanionOptions['evolution']> {
    return requireEvolution(this)
  }requireReflect(): NonNullable<CompanionOptions['reflect']> {
    return requireReflect(this)
  }scheduleInput(
    params: Record<string, unknown>,
    requireContent: boolean,
  ): Partial<ScheduledTaskInput> & { enabled?: boolean } {
    return scheduleInput(this, params, requireContent)
  }pruneUploads(): void {
    return pruneUploads(this)
  }assertUploadFresh(upload: PendingUpload): void {
    return assertUploadFresh(this, upload)
  }assertWorkspace(path: string): void {
    return assertWorkspace(this, path)
  }phoneModuleCheckReport(report: ModuleCheckReport): PhoneModuleCheckReport {
    return phoneModuleCheckReport(this, report)
  }async phoneLearningState(workspacePath: string): Promise<PhoneLearningState> {
    return phoneLearningState(this, workspacePath)
  }phoneModuleCheckState(
    state: ModuleCheckSummary | ModuleCheckState,
  ): PhoneModuleCheckState {
    return phoneModuleCheckState(this, state)
  }listSessions(): {
    sessions: Array<SessionSummary & { workspaceName: string }>
    workspaces: WorkspaceSummary[]
    roots: string[]
  } {
    return listSessions(this)
  }getSession(params: Record<string, unknown>): {
    session: Session
    hasMore: boolean
    hasNewer: boolean
    pendingApprovals: ReturnType<AgentRunner['pendingApprovalList']>
    activeRun: ReturnType<AgentRunner['activeRun']>
    workspaceName: string
  } {
    return getSession(this, params)
  }searchSessions(params: Record<string, unknown>): { hits: MessageSearchHit[] } {
    return searchSessions(this, params)
  }sessionKnowledge(params: Record<string, unknown>): {
    pairs: KnowledgePair[]
    total: number
    hasMore: boolean
  } {
    return sessionKnowledge(this, params)
  }sessionLinks(params: Record<string, unknown>): {
    links: SessionLink[]
    total: number
    hasMore: boolean
  } {
    return sessionLinks(this, params)
  }async sessionTools(params: Record<string, unknown>): Promise<{
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
    return sessionTools(this, params)
  }phoneSafeMessages(messages: StoredMessage[]): StoredMessage[] {
    return phoneSafeMessages(this, messages)
  }async createWorkspace(params: Record<string, unknown>): Promise<WorkspaceSummary> {
    return createWorkspace(this, params)
  }async browseWorkspace(params: Record<string, unknown>): Promise<{
    root: string
    directory: string
    parent: string
    entries: Array<{ name: string; path: string }>
    truncated: boolean
  }> {
    return browseWorkspace(this, params)
  }async openWorkspace(params: Record<string, unknown>): Promise<WorkspaceSummary> {
    return openWorkspace(this, params)
  }async removeWorkspace(params: Record<string, unknown>): Promise<{ ok: true }> {
    return removeWorkspace(this, params)
  }async deleteSession(params: Record<string, unknown>): Promise<{ ok: true }> {
    return deleteSession(this, params)
  }async toolRegistry(workspacePath: string): Promise<DynamicToolRegistry> {
    return toolRegistry(this, workspacePath)
  }async phoneDirectory(
    root: string,
    input: unknown,
  ): Promise<{ relative: string; path: string; resolved: string }> {
    return phoneDirectory(this, root, input)
  }async matchPhoneRoot(requested: string, roots: string[]): Promise<string> {
    return matchPhoneRoot(this, requested, roots)
  }async createSession(params: Record<string, unknown>): Promise<Session> {
    return createSession(this, params)
  }async renameSession(params: Record<string, unknown>): Promise<SessionSummary> {
    return renameSession(this, params)
  }async setSessionModel(params: Record<string, unknown>): Promise<SessionSummary> {
    return setSessionModel(this, params)
  }async setApprovalMode(params: Record<string, unknown>): Promise<SessionSummary> {
    return setApprovalMode(this, params)
  }
}
