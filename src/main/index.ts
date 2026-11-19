import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { hostname, release } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type {
  AccentPalette,
  ApprovalMode,
  CheckpointRestoreMode,
  ContributionEvidence,
  JudgeBalanceInput,
  ModelBalanceState,
  PersonalVersionInput,
  PluginCreateInput,
  PluginInstallInput,
  PluginSignaturePolicy,
  ProfileBenchmarkRow,
  MessageDelivery,
  MessageOptions,
  MessageSearchFilter,
  QuickCommandInput,
  ReviewRoot,
  ReviewSessionInput,
  ReviewSessionScope,
  RunEvent,
  ScheduledTaskInput,
  Session,
  SessionPage,
  SettingsUpdate,
  StoredMessage,
  ThemeMode,
  ThemePreference,
  ContrastPreference,
  SaturationPreference,
  UpdateState,
} from '../shared/types'
import { applyContrastColor, resolveThemePreference } from '../shared/theme'
import { normalizeEnvFields, type FeedbackDraft } from '../shared/feedback'
import type { ModuleCheckSettings } from '../shared/module-check'
import { AgentRunner } from './agent/runner'
import { MAX_IMAGE_DATA_URL_CHARS, sanitizeImages } from './agent/attachments'
import { DynamicToolRegistry } from './agent/toolsmith'
import { collectSessionArtifacts } from './agent/artifacts'
import { testDeepSeekConnection } from './agent/model'
import { loadMcpConfig } from './agent/mcp'
import { BillingService, fetchBalance } from './billing'
import {
  createPlugin,
  installMarketPlugin,
  installPlugin,
  pluginOverview,
  removePlugin,
  setPluginEnabled,
  setSignaturePolicy,
  signInstalledPlugin,
  trustPublicKey,
  untrustPublicKey,
} from './plugins/studio'
import type { BenchmarkRun } from './agent/profile-benchmark'
import { listSessionChanges, revertSessionFile } from './changes'
import { changesBridge, checkpointBridge, createEngine } from '../core/engine'
import { createEvolutionControls } from '../core/evolution'
import { assertActivatable } from '../core/profile-gate'
import { DESKTOP_CAPABILITIES } from '../shared/capabilities'
import { CheckpointService } from './checkpoints'
import { FeedbackBox } from './feedback'
import { CompanionServer } from './companion/server'
import { ensureGlobalInstructions, loadProjectInstructions } from './instructions'
import { sandboxStatus } from './sandbox'
import { runSelfCheck } from './self-check'
import { systemInfo, feedbackEnvironment } from './system-info'
import {
  configureFingerprintCache,
  forgetSourceFingerprint,
  prepareGitBase,
  PersonalEvolutionService,
} from './personal'
import {
  normalizeSelfSourceSettings,
  resolveSelfSource,
  syncSelfSource,
  type SelfSourceContext,
  type SelfSourceSettings,
} from './self-source-git'
import { prepareSelfSource } from './self-source'
import { localizeChanges, localizeMain, localizeUpdateState } from './localize'
import { knowledgePairsFor } from './search'
import { AgentScheduler } from './scheduler'
import { ModuleCheckService } from './module-check'
import { createAppLog, type AppLogEntry } from './app-log'
import { approvalAuditEntry, crashEntry, runSettledEntry, toolAuditEntry, toolFailureEntry } from './app-audit'
import { Store } from './store'
import { warmShellProfile } from './shell'
import { UpdaterService } from './updater'
import {
  importWorkspaceBytes,
  importWorkspaceFile,
  listDirectory,
  MAX_UPLOAD_BYTES,
  previewFile,
  resolveExisting,
  workspaceRoot,
} from './workspace'
import { installMediaProtocol, openLink, registerMediaScheme } from './preview'
import { isDocumentWindowContents, openDocumentWindow } from './document-window'
import { parseUploadBatch, UPLOAD_DIRECTORY, type UploadBatch } from '../shared/uploads'

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'

// Custom schemes must be declared before the app is ready.
registerMediaScheme()

for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', () => undefined)
}

const userDataOverride = process.env['PILOT_USER_DATA_DIR']
if (userDataOverride) {
  app.setPath('userData', isAbsolute(userDataOverride) ? userDataOverride : resolve(userDataOverride))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 只有真正退出（托盘菜单、更新重启、系统关机）才为 true；关窗只是藏到托盘。 */
let quitting = false
/** 本次运行是否已经提示过「已收到托盘」，避免每次关窗都弹一次。 */
let trayHintShown = false
let store: Store
let runner: AgentRunner
let checkpoints: CheckpointService
let feedback: FeedbackBox
let updater: UpdaterService
let companion: CompanionServer | null = null
let scheduler: AgentScheduler | null = null
let moduleCheck: ModuleCheckService
let appLog: ReturnType<typeof createAppLog>
/** `whenReady` 之前发生的异常（崩溃、自检失败）先排队，日志就绪后一次补写。 */
const earlyLogs: AppLogEntry[] = []
const EARLY_LOG_LIMIT = 50
/** 审批事件本身不带风险等级：`tool.call` 时记一笔，审批落定时取出并删除。 */
const callRisks = new Map<string, 'read' | 'write' | 'exec' | 'control'>()
const CALL_RISK_LIMIT = 200

/** 写一条应用日志：日志就绪前排队，永不抛错。 */
function log(entry: AppLogEntry): void {
  if (!appLog) {
    if (earlyLogs.length < EARLY_LOG_LIMIT) earlyLogs.push(entry)
    return
  }
  appLog.write(entry)
}

/** 日志里的 URL 去掉查询串与 hash：凭据常藏在 query 里，路径本身对排错有用。 */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

/**
 * 崩溃捕获：主进程未捕获异常、未处理的 Promise 拒绝、渲染进程与子进程消失。
 *
 * 主进程异常只记一条然后**保持运行**：它们多数来自单个 IPC 调用或某个工具，
 * 直接退出会丢掉用户未保存的状态；重复失败会在日志里累积，下次启动能查到。
 * 渲染进程正常退出（`clean-exit`）不记，否则每次关窗都是一条 error。
 */
function installCrashLogging(): void {
  process.on('uncaughtException', (error) => {
    log(crashEntry({ event: 'uncaught-exception', source: 'main', error }))
  })
  process.on('unhandledRejection', (reason) => {
    log(crashEntry({ event: 'unhandled-rejection', source: 'main', error: reason }))
  })
  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit') return
    log(
      crashEntry({
        event: 'render-process-gone',
        source: 'renderer',
        detail: {
          reason: details.reason,
          exitCode: details.exitCode,
          url: safeUrl(contents.getURL()),
        },
      }),
    )
  })
  app.on('child-process-gone', (_event, details) => {
    log(
      crashEntry({
        event: 'child-process-gone',
        source: 'child',
        detail: {
          type: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          service: details.serviceName,
        },
      }),
    )
  })
}

installCrashLogging()
let billing: BillingService
let checkpointMaintenanceTimer: NodeJS.Timeout | null = null
let pendingCheckpointMaintenance = false

/**
 * Channels a standalone document window may call: read one file, read the
 * palette it should paint with, close itself, and open a link. Everything else
 * stays reserved for the main window, so the preview bundle can never start a
 * run or change a setting. The check is the sender identity, not a filename.
 */
const DOCUMENT_CHANNELS = new Set([
  'pilot:file-preview',
  'pilot:doc-state',
  'pilot:doc-close',
  'pilot:open-link',
])

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) return
  if (DOCUMENT_CHANNELS.has(channel) && isDocumentWindowContents(event.sender.id)) return
  throw new Error('Rejected IPC call from an unknown page')
}

function handle<Args extends unknown[], Result>(
  channel: string,
  handler: (...args: Args) => Promise<Result> | Result,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel)
    try {
      return await handler(...(args as Args))
    } catch (error) {
      // Rejections cross straight into a renderer toast, so translate known
      // main-process copy here. Unknown technical errors pass through.
      const message = error instanceof Error ? error.message : String(error)
      const localized = localizeMain(message, store ? store.uiLocale() : 'zh-CN')
      if (localized !== message) throw new Error(localized)
      throw error
    }
  })
}

/**
 * 把一张图片压进一条消息能承受的体积：图片还会经 512 KB 的加密中继发到手机上，
 * 所以逐级降质量、降尺寸，直到塞进上限为止，而不是让整次选择失败。
 */
function encodeMessageImage(image: Electron.NativeImage): string {
  const size = image.getSize()
  // 下限钳到 320：小截图（比如 240×120 的粘贴图）本身已经比这个还小，
  // 如果不钳，while 一次都不会跑，dataUrl 为空直接报「图片太大」。
  let edge = Math.min(1600, Math.max(320, Math.max(size.width, size.height)))
  let dataUrl = ''
  while (edge >= 320) {
    for (const quality of [82, 72, 62, 52]) {
      const scale = Math.min(1, edge / Math.max(size.width, size.height))
      const resized =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: 'good',
            })
          : image
      dataUrl = `data:image/jpeg;base64,${resized.toJPEG(quality).toString('base64')}`
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) break
    }
    if (dataUrl && dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) break
    edge = Math.round(edge * 0.75)
  }
  if (!dataUrl || dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
    throw new Error('图片太大，请压缩后再添加')
  }
  return dataUrl
}

/**
 * 上传合流点：磁盘路径和内存字节在这里进入同一个工作区目录，
 * 走同一套校验，失败时整批拒绝而不是留下一半文件。
 */
function uploadBytes(data: ArrayBuffer | Uint8Array): Buffer {
  return ArrayBuffer.isView(data)
    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : Buffer.from(new Uint8Array(data))
}

async function importUploadBatch(workspacePath: string, batch: UploadBatch) {
  // Check every size before the first write so a rejected batch does not leave
  // a half-imported set behind.
  for (const file of batch.paths) {
    const info = await stat(file).catch(() => null)
    if (!info) throw new Error(`找不到要上传的文件：${basename(file)}`)
    if (!info.isFile()) throw new Error(`不能上传文件夹或特殊文件：${basename(file)}`)
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `「${basename(file)}」超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
      )
    }
  }
  const uploaded: Array<{ path: string; name: string; size: number }> = []
  for (const file of batch.paths) {
    uploaded.push(await importWorkspaceFile(workspacePath, UPLOAD_DIRECTORY, file))
  }
  for (const blob of batch.blobs) {
    uploaded.push(
      await importWorkspaceBytes(workspacePath, UPLOAD_DIRECTORY, blob.name, uploadBytes(blob.data)),
    )
  }
  return uploaded
}

function broadcast(event: RunEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pilot:event', event)
  }
  auditEvent(event)
  if (event.type === 'run.completed' || event.type === 'run.failed') onRunFinished()
  if (event.type === 'run.completed') onRunSettled(event.sessionId, event.status, event.runId)
  if (event.type === 'run.failed') onRunSettled(event.sessionId, 'failed', event.runId)
}

/**
 * 审计：高危工具调用（`write` / `exec`）与审批裁决都写进同一份应用日志，带上
 * `runId`，事后能按一次运行把「调了什么、谁批的」串起来。只写元数据，命令参数
 * 与工具输出仍然只在会话文件里。
 */
function auditEvent(event: RunEvent): void {
  if (event.type === 'tool.call') {
    if (event.risk !== 'read') {
      callRisks.set(event.call.id, event.risk)
      // 上限保护：拒绝/超时以外的调用不会发出 approval 事件，条目会一直留着。
      if (callRisks.size > CALL_RISK_LIMIT) {
        const oldest = callRisks.keys().next().value
        if (oldest) callRisks.delete(oldest)
      }
    }
    const entry = toolAuditEntry(event)
    if (entry) log(entry)
    return
  }
  if (event.type === 'tool.approval_resolved') {
    const risk = callRisks.get(event.callId)
    callRisks.delete(event.callId)
    log(approvalAuditEntry({ ...event, risk }))
    return
  }
  if (event.type === 'tool.result') {
    const entry = toolFailureEntry(event, callRisks.get(event.callId))
    if (entry) log(entry)
  }
}

/**
 * 会话跑完一轮后：
 * - 自改会话自动重跑一次自检，把提案刷新到最新（只读重扫，不触发新的改动）；
 * - 其它会话只落一条日志，绝不自动改代码。
 *
 * 用户主动取消的会话不做刷新：改动可能只写了一半，重扫出来的提案会误导人，
 * 让他们以为那些问题跟自己刚打断的任务无关。
 */
function onRunSettled(sessionId: string, status: string, runId?: string): void {
  // Store 里的运行记录比事件本身全：步数、用量、模型、工具失败数、耗时都在里面。
  const workspacePath = store ? store.session(sessionId)?.workspacePath : undefined
  const run =
    workspacePath && runId ? store.run(workspacePath, runId) : undefined
  log(runSettledEntry({ sessionId, status, run }))
  if (status === 'cancelled') return
  void moduleCheck?.noteRunSettled(sessionId).catch(() => undefined)
}

/**
 * 解析自身源码要起好几个 git 子进程（开发态实测约 2 s），而且 runGit 是
 * spawnSync —— 它会把整个主进程的事件循环堵住，期间连 `exists` 都要排队。
 * 结果只与设置、安装路径和官方 HEAD 有关，设置变化会换 key，准备/同步源码时
 * 显式失效，所以缓存可以放得比较长。
 */
const PERSONAL_RESOLVE_TTL_MS = 10 * 60_000
let personalResolve: {
  key: string
  at: number
  promise: Promise<PersonalEvolutionService>
} | null = null
let selfSourceResolve: {
  key: string
  at: number
  promise: ReturnType<typeof resolveSelfSource>
} | null = null

function personalServiceKey(): string {
  return JSON.stringify({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
    settings: currentSelfSourceSettings(),
  })
}

/**
 * 缓存的 `resolveSelfSource`。进化页会同时问个人状态和源码来源，两次都把
 * 同一串 git 子进程跑一遍就会白白阻塞主进程两次。
 */
function resolveSelfSourceCached(): ReturnType<typeof resolveSelfSource> {
  const key = personalServiceKey()
  if (
    selfSourceResolve &&
    selfSourceResolve.key === key &&
    Date.now() - selfSourceResolve.at < PERSONAL_RESOLVE_TTL_MS
  ) {
    return selfSourceResolve.promise
  }
  const promise = resolveSelfSource({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    settings: currentSelfSourceSettings(),
  })
  const entry = { key, at: Date.now(), promise }
  selfSourceResolve = entry
  promise.catch(() => {
    if (selfSourceResolve === entry) selfSourceResolve = null
  })
  return promise
}

/** 源码目录或官方基线刚刚变过，下一次必须重新解析。 */
function forgetPersonalService(): void {
  personalResolve = null
  selfSourceResolve = null
  // prepare/sync 会重写官方基线树，指纹也必须重算。
  const userData = app.getPath('userData')
  forgetSourceFingerprint(selfSourcePath())
  forgetSourceFingerprint(join(userData, 'self-src-base'))
  forgetSourceFingerprint(join(process.resourcesPath, 'source'))
}

/**
 * Build the personal-fork service for the current install. Installed builds
 * diff against the pristine `resources/source`; development runs use a cached
 * git-HEAD snapshot so unrelated working-tree edits are still visible.
 */
async function personalService(options: {
  ensureSource?: boolean
  ensureBase?: boolean
} = {}): Promise<PersonalEvolutionService> {
  const key = personalServiceKey()
  const force = Boolean(options.ensureSource || options.ensureBase)
  if (
    !force &&
    personalResolve &&
    personalResolve.key === key &&
    Date.now() - personalResolve.at < PERSONAL_RESOLVE_TTL_MS
  ) {
    return personalResolve.promise
  }
  const promise = createPersonalService(options)
  const entry = { key, at: Date.now(), promise }
  personalResolve = entry
  promise.catch(() => {
    // A failed resolution must not be replayed to the next caller.
    if (personalResolve === entry) personalResolve = null
  })
  return promise
}

async function createPersonalService(options: {
  ensureSource?: boolean
  ensureBase?: boolean
}): Promise<PersonalEvolutionService> {
  const userData = app.getPath('userData')
  configureFingerprintCache(join(userData, 'personal', 'fingerprints.json'))
  const sourceOptions = {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: userData,
  }
  if (options.ensureSource) await prepareSelfSource(sourceOptions)
  // Which copy is editable, and which tree is "official", depends on the
  // user's source settings: built-in (official git baseline) or a custom
  // checkout. Falls back to the installer snapshot when nothing is configured.
  const resolved = await resolveSelfSourceCached()
  let sourcePath = resolved.sourcePath
  let basePath = resolved.basePath
  if (!basePath) {
    // No traceable baseline: development runs still diff against git HEAD so a
    // fork can be upgraded after `git pull`; installed builds have none.
    sourcePath = app.isPackaged ? join(userData, 'self-src') : app.getAppPath()
    basePath = app.isPackaged
      ? join(process.resourcesPath, 'source')
      : await prepareGitBase(sourcePath, join(userData, 'self-src-base'))
  }
  const endpoint = process.env['PILOT_CONTRIBUTION_URL']?.trim()
  return new PersonalEvolutionService({
    sourcePath,
    basePath,
    baseReadOnly: resolved.baseReadOnly,
    dataDir: join(userData, 'personal'),
    appVersion: app.getVersion(),
    provenance: resolved.provenance,
    ...(endpoint ? { endpoint } : {}),
  })
}

/** Current source settings plus the paths the resolver needs. */
function selfSourceContext(): SelfSourceContext {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    settings: currentSelfSourceSettings(),
  }
}

function currentSelfSourceSettings(): SelfSourceSettings {
  const view = store.settingsView()
  return {
    mode: view.selfSourceMode,
    gitUrl: view.selfSourceGitUrl,
    gitRef: view.selfSourceGitRef,
    gitPath: view.selfSourceGitPath,
    customPath: view.selfSourceCustomPath,
  }
}

/** Evidence attached to a contribution so maintainers can judge the change. */
function contributionEvidence(): ContributionEvidence {
  const path = store.activeWorkspace()
  const detail = path ? store.workspaceDetail(path) : null
  const policyVersion = detail?.evolution.policyVersions.find(
    (version) => version.status === 'active',
  )
  return {
    policy: store.evolutionPolicy(),
    ...(policyVersion ? { policyVersion: policyVersion.version } : {}),
    ...(detail?.activeProfile ? { activeProfile: detail.activeProfile.promptAddendum } : {}),
    cycles: (detail?.evolution.cycles ?? []).slice(0, 5).map((cycle) => cycle.summary),
  }
}

function selfSourceOptions() {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  }
}

/**
 * 内置源码目录：安装版是 userData 里的可写副本，开发态就是当前 client 目录。
 * 自检与“打开自身源码”用的是同一份，不再看用户打开了哪个工作区。
 */
function selfSourcePath(): string {
  return app.isPackaged ? join(app.getPath('userData'), 'self-src') : app.getAppPath()
}

/** 解析一个已存在的工作区目录，再建工具注册表；路径越界会被 `resolveExisting` 拒。 */
async function toolRegistryFor(path: string): Promise<DynamicToolRegistry> {
  await resolveExisting(path, '.')
  const settings = store.settings()
  return new DynamicToolRegistry({
    workspacePath: path,
    userDataDir: app.getPath('userData'),
    testTargets: settings.testTargets,
    testCaptchaMode: settings.testCaptchaMode,
    testCaptcha: store.getTestCaptcha(),
  })
}

/**
 * 内视：只读 Pilot 自己的服务实例，不接受工作区路径参数。
 * 工作区相关模块（自写工具、MCP、插件）只读当前打开的那一个；
 * 没打开就报“未启用”，不去猜路径。
 *
 * 桌面 IPC 与手机（companion）都调这一份，避免两端采样出不同结果。
 */
async function collectSelfCheck() {
  const workspace = store.activeWorkspace()
  await moduleCheck.load().catch(() => undefined)
  const report = await runSelfCheck({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),
    currentWorkspace: workspace,
    settings: () => store.settingsView(),
    workspaces: () => store.workspaces(),
    modelResources: () => store.modelResources(),
    scheduled: () => store.allScheduledTasks(),
    moduleCheck: () => moduleCheck.snapshot(),
    sandbox: sandboxStatus,
    update: () => updater.stateSnapshot(),
    systemInfo: () => systemInfo(app.getPath('userData')),
    feedback,
    dynamicTools: async () => (workspace ? (await toolRegistryFor(workspace)).list() : []),
    plugins: (path: string) => pluginOverview(path),
    mcpServers: async (path: string) => loadMcpConfig(path),
  })
  // 内视只探查状态：这里记录结果摘要，但不建会话、不改任何文件。
  log({
    area: 'self-check',
    event: 'inspect.completed',
    detail: {
      durationMs: report.durationMs,
      items: report.items.length,
      broken: report.counts.broken,
      warn: report.counts.warn,
      off: report.counts.off,
      workspace,
    },
  })
  return report
}

/** Ensure the personal source exists, register it, and start a phone-driven chat. */
async function startPersonalChat(
  title: string,
  prompt: string,
): Promise<{ sessionId: string; workspacePath: string }> {
  const prepared = await prepareSelfSource(selfSourceOptions())
  await store.addWorkspace(prepared.path, { activate: false })
  const session = await store.createSession(prepared.path, { title })
  await runner.sendMessage(session.id, prompt, 'queue')
  const event: RunEvent = { type: 'workspace.changed', workspacePath: prepared.path }
  broadcast(event)
  companion?.publish(event)
  return { sessionId: session.id, workspacePath: prepared.path }
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Resolve every review root through realpath before it is persisted. The
 * primary workspace is always first and is the default root for file tools.
 */
async function resolveReviewRoots(
  primaryInput: string,
  requested: ReviewSessionInput['roots'],
): Promise<ReviewRoot[]> {
  const primary = await workspaceRoot(primaryInput)
  const candidates: Array<{ path: string; name?: string }> = []
  const requestedPrimary = Array.isArray(requested)
    ? requested.find(
        (entry) =>
          entry &&
          typeof entry.path === 'string' &&
          pathKey(resolve(entry.path)) === pathKey(primary),
      )
    : undefined
  candidates.push({
    path: primary,
    ...(requestedPrimary?.name ? { name: requestedPrimary.name } : {}),
  })
  if (Array.isArray(requested)) {
    for (const entry of requested.slice(0, 8)) {
      if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) continue
      candidates.push({
        path: entry.path.trim(),
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      })
    }
  }
  const seenPaths = new Set<string>()
  const seenNames = new Set<string>()
  const roots: ReviewRoot[] = []
  for (const candidate of candidates) {
    if (roots.length >= 8) break
    const resolved = await workspaceRoot(candidate.path)
    const key = pathKey(resolved)
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    const base =
      (candidate.name ?? '').trim().replace(/[\\/]+/g, '-').slice(0, 40) ||
      basename(resolved) ||
      'root'
    let name = base
    let suffix = 2
    while (seenNames.has(name.toLowerCase())) {
      name = `${base.slice(0, 36)}-${suffix}`
      suffix += 1
    }
    seenNames.add(name.toLowerCase())
    roots.push({ name, path: resolved })
  }
  if (roots.length === 0) throw new Error('复盘至少需要一个可读取的目录')
  return roots
}

function normalizeReviewSessions(input: unknown): ReviewSessionScope {
  if (input === 'all') return 'all'
  if (!Array.isArray(input)) return 'workspace'
  const ids = [
    ...new Set(
      input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    ),
  ].slice(0, 50)
  for (const id of ids) {
    if (!store.session(id)) throw new Error(`复盘范围内的会话不存在：${id}`)
  }
  return ids.length > 0 ? ids : 'workspace'
}

/** Full transcript used by "copy whole conversation" even when the UI only holds a page. */
function transcriptText(messages: StoredMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user' && !message.control) {
      if (message.content.trim()) parts.push(`## 我\n${message.content.trim()}`)
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.trim()) parts.push(`## Pilot\n${message.content.trim()}`)
      for (const call of message.toolCalls ?? []) {
        const args = JSON.stringify(call.arguments ?? {})
        parts.push(`> 调用 ${call.name} ${args.length > 400 ? `${args.slice(0, 400)}…` : args}`)
      }
      continue
    }
    if (message.role === 'tool' && message.content.trim()) {
      const body = message.content.trim()
      parts.push(
        `> ${message.name ?? 'tool'} ${message.isError ? '失败' : '完成'}\n${body.length > 4_000 ? `${body.slice(0, 4_000)}…` : body}`,
      )
    }
  }
  return parts.join('\n\n')
}

function sessionPage(session: Session, before?: string, limit = 120): SessionPage {
  let end = session.messages.length
  if (before) {
    const index = session.messages.findIndex((message) => message.id === before)
    if (index >= 0) end = index
  }
  const safeLimit = Math.max(1, Math.min(300, Math.round(limit) || 120))
  const start = Math.max(0, end - safeLimit)
  return {
    session: {
      ...session,
      messages: session.messages.slice(start, end),
      messageCount: session.messages.length,
    },
    hasMore: start > 0,
  }
}

/** Center a page on a search hit so the target message is always present. */
function sessionPageAround(session: Session, messageId: string, limit = 120): SessionPage {
  const safeLimit = Math.max(1, Math.min(300, Math.round(limit) || 120))
  const index = session.messages.findIndex((message) => message.id === messageId)
  if (index < 0) return sessionPage(session, undefined, safeLimit)
  const half = Math.floor(safeLimit / 2)
  const start = Math.max(0, index - half)
  const end = Math.min(session.messages.length, start + safeLimit)
  return {
    session: {
      ...session,
      messages: session.messages.slice(start, end),
      messageCount: session.messages.length,
    },
    hasMore: start > 0,
    hasNewer: end < session.messages.length,
  }
}

function focusWindow(sessionId: string): void {
  if (!focusMainWindow()) return
  mainWindow?.webContents.send('pilot:focus-session', sessionId)
}

/** Bring Pilot to the front without navigating anywhere. */
function focusMainWindow(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
  return true
}

/**
 * Snapshot maintenance is a full scan of the checkpoint store only when the
 * persisted estimate is over budget or a periodic audit is due. It still waits
 * until the app is idle so a rare cleanup does not land in the middle of the
 * first model round trip, and retries after a run finishes.
 */
function scheduleCheckpointMaintenance(delayMs = 5_000): void {
  if (checkpointMaintenanceTimer) clearTimeout(checkpointMaintenanceTimer)
  checkpointMaintenanceTimer = setTimeout(() => {
    checkpointMaintenanceTimer = null
    const service = checkpoints
    if (!service) return
    if (store.anyRunning()) {      // A run is in flight; try again once it is done.
      pendingCheckpointMaintenance = true
      return
    }
    pendingCheckpointMaintenance = false
    void service
      .maintain({ maxBytes: store.settings().checkpointMaxBytes })
      .catch(() => undefined)
  }, delayMs)
  checkpointMaintenanceTimer.unref?.()
}

function onRunFinished(): void {
  if (pendingCheckpointMaintenance) scheduleCheckpointMaintenance(0)
}

/**
 * Desktop notifications are opt-out, only fire while Pilot is not focused,
 * and never carry message contents — just the session title and event.
 */
function notifyEvent(event: RunEvent): void {
  // 质量闸门只在需要人做决定时发系统通知（bell=true）；一次例行复测不弹窗。
  if (event.type === 'quality.changed') {
    if (!event.bell || !event.message) return
    if (!store.settings().notifyDesktop) return
    if (!Notification.isSupported()) return
    if (BrowserWindow.getFocusedWindow()) return
    const notification = new Notification({
      title: store.uiLocale() === 'en' ? 'Pilot · Better version found' : 'Pilot · 发现更优版本',
      body: event.message.slice(0, 240),
    })
    notification.on('click', () => {
      if (!focusMainWindow()) return
      mainWindow?.webContents.send('pilot:focus-quality', event.workspacePath)
    })
    notification.show()
    return
  }
  if (
    event.type !== 'tool.approval_required' &&
    event.type !== 'run.failed' &&
    event.type !== 'run.completed'
  ) {
    return
  }
  if (!store.settings().notifyDesktop) return
  if (!Notification.isSupported()) return
  if (BrowserWindow.getFocusedWindow()) return
  const english = store.uiLocale() === 'en'
  const currentTask = english ? 'Current task' : '当前任务'
  let sessionId = ''
  let title = 'Pilot'
  let body = ''
  if (event.type === 'tool.approval_required') {
    sessionId = event.sessionId
    title = english ? 'Pilot · Approval needed' : 'Pilot · 需要确认'
    const session = store.session(sessionId)
    body = english
      ? `${session?.title ?? currentTask}\nRequests to run ${event.call.name} and is waiting for your approval.`
      : `${session?.title ?? currentTask}\n请求执行 ${event.call.name}，等待你的批准。`
  } else if (event.type === 'run.failed') {
    sessionId = event.sessionId
    title = english ? 'Pilot · Run failed' : 'Pilot · 运行失败'
    const session = store.session(sessionId)
    body = `${session?.title ?? currentTask}\n${event.message.slice(0, 160)}`
  } else if (event.type === 'run.completed' && event.status === 'completed') {
    sessionId = event.sessionId
    title = english ? 'Pilot · Task complete' : 'Pilot · 任务完成'
    const session = store.session(sessionId)
    const seconds = Math.max(1, Math.round(event.durationMs / 1000))
    body = english
      ? `${session?.title ?? currentTask}\nFinished in ${seconds}s.`
      : `${session?.title ?? currentTask}\n已完成，用时 ${seconds} 秒。`
  } else {
    return
  }
  const notification = new Notification({ title, body })
  notification.on('click', () => focusWindow(sessionId))
  notification.show()
}

function broadcastUpdate(state: UpdateState): void {
  const localized = localizeUpdateState(state, store.uiLocale())
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pilot:update-state', localized)
  }
  // Paired phones show the same progress; they may also have started it.
  companion?.publish({ type: 'update.changed', state: localized })
}

/** Resolve the stored preference; `system` reads the OS at call time. */
function resolveTheme(preference: ThemePreference): ThemeMode {
  return resolveThemePreference(preference, nativeTheme.shouldUseDarkColors)
}

/** Window chrome colors; the Claude preset uses warm ivory instead of pure white. */
function windowPalette(
  theme: ThemeMode,
  accent: AccentPalette,
  contrast: ContrastPreference,
): { color: string; symbolColor: string } {
  const claude = accent === 'claude'
  if (theme === 'light') {
    return claude
      ? { color: applyContrastColor('#faf9f5', theme, contrast), symbolColor: '#1f1e1d' }
      : { color: applyContrastColor('#ffffff', theme, contrast), symbolColor: '#000000' }
  }
  return claude
    ? { color: applyContrastColor('#1f1e1d', theme, contrast), symbolColor: '#f5f4ef' }
    : { color: applyContrastColor('#000000', theme, contrast), symbolColor: '#ffffff' }
}

function applyTheme(
  preference: ThemePreference,
  accent: AccentPalette,
  contrast: ContrastPreference,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const palette = windowPalette(resolveTheme(preference), accent, contrast)
  mainWindow.setBackgroundColor(palette.color)
  if (process.platform === 'win32' || process.platform === 'linux') {
    try {
      mainWindow.setTitleBarOverlay({ ...palette, height: 38 })
    } catch {
      // Older window managers may not support the overlay.
    }
  }
}

/**
 * 窗口图标与托盘图标都从这里取。Windows 的任务栏与 Alt-Tab 读的是窗口的
 * `WM_GETICON`，主进程不显式给图标时窗口没有图标，任务栏只能退回类图标，
 * 部分主题下就渲染成一块空白——这正是「任务栏没有 logo」的成因。
 * 打包后图标由 electron-builder 的 extraResources 放在 resources/build 下。
 */
function appIconPath(): string {
  const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png', 'icon.ico']
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'build'), join(__dirname, '../../build')]
    : [join(__dirname, '../../build')]
  for (const root of roots) {
    for (const name of names) {
      const file = join(root, name)
      if (existsSync(file)) return file
    }
  }
  return ''
}

function createWindow(): void {
  const theme = resolveTheme(store.settingsView().theme)
  const palette = windowPalette(
    theme,
    store.settingsView().accent,
    store.settingsView().contrast,
  )

  const iconPath = appIconPath()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: palette.color,
    title: 'Pilot',
    ...(iconPath ? { icon: iconPath } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { ...palette, height: 38 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })

  // ready-to-show 与 did-finish-load 都会调到这里，以 isVisible 为准做幂等和有限重试。
  let showAttempts = 0
  const showWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isVisible()) {
      refreshTrayMenu()
      return
    }
    mainWindow.show()
    if (mainWindow.isVisible()) {
      refreshTrayMenu()
      return
    }
    // Windows 上首帧之前调 show() 会被丢弃：窗口对象不报错、`show` 事件也发了，
    // 但 IsWindowVisible 仍是 false，结果进程在跑、窗口永远不出现。重试到真的可见为止。
    if (showAttempts >= 20) {
      console.error('[pilot] window never became visible')
      return
    }
    showAttempts += 1
    setTimeout(showWindow, 300)
  }
  mainWindow.once('ready-to-show', () => {
    showWindow()
  })
  mainWindow.on('hide', () => refreshTrayMenu())
  mainWindow.on('show', () => refreshTrayMenu())
  // 加载完成后也试一次：极少数情况下首帧被推迟，ready-to-show 不来。
  mainWindow.webContents.once('did-finish-load', () => setTimeout(showWindow, 200))

  // 关闭按钮收起窗口而不是退出：任务继续跑，托盘图标留着恢复。真退出走
  // 托盘菜单（或更新器的重启），它们会先置 `quitting`。托盘没建成时退回
  // 「关闭即退出」，否则窗口会藏起来而无处恢复。
  mainWindow.on('close', (event) => {
    if (quitting || !tray) return
    event.preventDefault()
    mainWindow?.hide()
    notifyTrayHint()
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // The renderer uses the Clipboard API for code blocks and fallbacks. A
    // blanket denial made every copy button fail; allow the write-only
    // permission and keep everything else denied.
    callback(permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'clipboard-sanitized-write'
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (current && url !== current) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    refreshTrayMenu()
  })
}

/** 首次收起窗口时告诉用户去哪儿找它，之后不再打扰。 */
function notifyTrayHint(): void {
  if (trayHintShown || !tray) return
  trayHintShown = true
  const english = store.uiLocale() === 'en'
  const title = english ? 'Pilot is still running' : 'Pilot 仍在后台运行'
  const body = english
    ? 'The window is hidden in the tray. Click the tray icon to reopen it, or quit from the tray menu.'
    : '窗口已隐藏到托盘。点击托盘图标重新打开，或从托盘菜单退出。'
  if (process.platform === 'win32') {
    try {
      tray.displayBalloon({ title, content: body })
      return
    } catch {
      // 部分外壳不支持气泡通知，托盘菜单本身就是入口。
    }
  }
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => focusMainWindow())
  notification.show()
}

/** 左键单击/双击与菜单项都要能把窗口叫回来，包括已被最小化的情形。 */
function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide()
    return
  }
  focusMainWindow()
}

function refreshTrayMenu(): void {
  if (!tray) return
  const english = store.uiLocale() === 'en'
  const open = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: english
          ? open
            ? 'Hide Pilot'
            : 'Show Pilot'
          : open
            ? '隐藏 Pilot'
            : '显示 Pilot',
        click: () => toggleMainWindow(),
      },
      { type: 'separator' },
      {
        label: english ? 'Quit Pilot' : '退出 Pilot',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

/**
 * 托盘常驻：关窗后仍有入口，所以这里必须真的建成，否则「关闭 = 隐藏」就会让
 * 应用失去唯一的恢复路径。图标缺失时宁可不建托盘并退回关窗即退出。
 */
function createTray(): void {
  if (tray) return
  const iconPath = appIconPath()
  if (!iconPath) return
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return
  tray = new Tray(process.platform === 'win32' ? image : image.resize({ width: 22, height: 22 }))
  tray.setToolTip('Pilot')
  refreshTrayMenu()
  tray.on('click', () => toggleMainWindow())
  tray.on('double-click', () => focusMainWindow())
}

function registerIpc(): void {
  handle('pilot:bootstrap', () => {
    const workspaces = store.workspaces()
    const activeWorkspace =
      store.activeWorkspace() ??
      workspaces[0]?.path ??
      null
    if (activeWorkspace && activeWorkspace !== store.activeWorkspace()) {
      store.setActiveWorkspace(activeWorkspace)
    }
    const sessions = activeWorkspace ? store.sessions(activeWorkspace) : []
    const storedActive = store.activeSession()
    const activeSession =
      storedActive && sessions.some((entry) => entry.id === storedActive)
        ? storedActive
        : sessions[0]?.id ?? null
    store.setActiveSession(activeSession)
    return {
      settings: store.settingsView(),
      workspaces,
      sessions,
      activeWorkspace,
      activeSession,
      version: app.getVersion(),
      platform: process.platform,
    }
  })

  handle('pilot:settings-update', async (input: SettingsUpdate) => {
    const view = await store.updateSettings(input)
    if (input.theme || input.accent || input.contrast) {
      applyTheme(view.theme, view.accent, view.contrast)
    }
    // Any key, endpoint or role change can move the primary account, so the
    // cached provider balance must be fetched again.
    if (
      input.apiKey !== undefined ||
      input.baseUrl !== undefined ||
      input.model !== undefined ||
      input.modelResources !== undefined ||
      input.sessionModelId !== undefined ||
      input.evaluationModelIds !== undefined ||
      input.reviewModelId !== undefined ||
      input.judgeProviders !== undefined
    ) {
      billing.invalidate()
    }
    // Keep the companion's relay rooms in sync when the address is changed
    // through the generic settings channel as well.
    if (input.relayUrl !== undefined && companion) {
      await companion.setRelayUrl(input.relayUrl)
    }
    return view
  })

  handle('pilot:model-billing', async (refresh?: boolean) => billing.report(Boolean(refresh)))

  handle('pilot:judge-balance', async (input?: JudgeBalanceInput): Promise<ModelBalanceState> => {
    const target = input?.providerId ? store.judgeTarget(input.providerId) : null
    if (input?.providerId && !target) {
      return {
        ok: false,
        available: false,
        entries: [],
        source: '',
        fetchedAt: new Date().toISOString(),
        error: 'missing-key',
        errorDetail: '该模型资源还没有保存可用的密钥。',
      }
    }
    const baseUrl = input?.baseUrl?.trim() || target?.baseUrl || ''
    const model = input?.model?.trim() || target?.model || ''
    if (!baseUrl) {
      return {
        ok: false,
        available: false,
        entries: [],
        source: '',
        fetchedAt: new Date().toISOString(),
        error: 'unsupported',
        errorDetail: '请先填写 Base URL。',
      }
    }
    return fetchBalance({
      apiKey: input?.apiKey?.trim() || target?.apiKey || '',
      baseUrl,
      model,
    })
  })

  handle(
    'pilot:test-connection',
    async (input?: { apiKey?: string; baseUrl?: string; model?: string; providerId?: string }) => {
      const settings = store.settingsView()
      // A stored reviewer tests with its own saved key and endpoint.
      const target = input?.providerId ? store.judgeTarget(input.providerId) : null
      if (input?.providerId && !target) {
        return { ok: false, message: '该模型资源还没有保存可用的密钥。' }
      }
      const key = input?.apiKey?.trim() || target?.apiKey || store.getApiKey() || ''
      return testDeepSeekConnection({
        apiKey: key,
        baseUrl: input?.baseUrl?.trim() || target?.baseUrl || settings.baseUrl,
        model: input?.model?.trim() || target?.model || settings.model,
      })
    },
  )

  handle('pilot:set-theme', async (theme: ThemePreference) => {
    const view = await store.updateSettings({ theme })
    applyTheme(theme, view.accent, view.contrast)
  })

  // Settings previews an appearance before saving. Painting the window chrome
  // here keeps the title bar from disagreeing with the content while the user
  // hovers the options; `null` restores the saved values without persisting.
  handle(
    'pilot:preview-theme',
    (
      input: {
        theme: ThemePreference
        accent: AccentPalette
        contrast: ContrastPreference
        saturation: SaturationPreference
      } | null,
    ) => {
      const view = store.settingsView()
      applyTheme(
        input?.theme ?? view.theme,
        input?.accent ?? view.accent,
        input?.contrast ?? view.contrast,
      )
    },
  )

  handle('pilot:companion-status', () => {
    if (!companion) throw new Error('手机连接尚未初始化')
    return companion.status()
  })
  handle('pilot:companion-enabled', async (enabled: boolean) => {
    if (!companion) throw new Error('手机连接尚未初始化')
    return companion.setEnabled(enabled === true)
  })
  handle('pilot:companion-relay', async (url: unknown) => {
    if (!companion) throw new Error('手机连接尚未初始化')
    return companion.setRelayUrl(typeof url === 'string' ? url : '')
  })
  handle('pilot:companion-pairing', async () => {
    if (!companion) throw new Error('手机连接尚未初始化')
    return companion.createPairing()
  })
  handle('pilot:companion-pair-decision', (requestId: unknown, approved: unknown) => {
    if (!companion) throw new Error('手机连接尚未初始化')
    return companion.resolvePairing(String(requestId ?? ''), approved === true)
  })
  handle('pilot:companion-revoke', async (phoneId: string) => {
    if (!companion) throw new Error('手机连接尚未初始化')
    return companion.revoke(phoneId)
  })
  handle('pilot:companion-local-url', () => companion?.localUrl() ?? '')
  handle('pilot:companion-roots', () => store.phoneRoots())
  handle('pilot:companion-root-add', async (path: string) => {
    return store.addPhoneRoot(String(path || ''))
  })
  handle('pilot:companion-root-remove', async (path: string) => {
    return store.removePhoneRoot(String(path || ''))
  })
  handle('pilot:companion-app-qr', async () => {
    if (!companion) throw new Error('手机连接尚未初始化')
    return companion.appQr()
  })

  handle('pilot:pick-folder', async (title?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: typeof title === 'string' && title ? title : 'Choose a workspace',
      buttonLabel: 'Open workspace',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle('pilot:pick-images', async () => {
    if (!mainWindow) return []
    const english = store.uiLocale() === 'en'
    const result = await dialog.showOpenDialog(mainWindow, {
      title: english ? 'Select images' : '选择图片',
      buttonLabel: english ? 'Add' : '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: english ? 'Images' : '图片',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
        },
      ],
    })
    if (result.canceled) return []
    const images: string[] = []
    for (const file of result.filePaths.slice(0, 3)) {
      const image = nativeImage.createFromPath(file)
      if (image.isEmpty()) continue
      images.push(encodeMessageImage(image))
    }
    return sanitizeImages(images)
  })

  /**
   * Copy files the user picked on this computer into the session workspace.
   * The renderer sends the workspace path of its own session, so it is matched
   * against the store instead of being trusted.
   */
  handle('pilot:pick-files', async (workspacePath: unknown) => {
    if (!mainWindow) return []
    const requested = typeof workspacePath === 'string' ? workspacePath.trim() : ''
    if (!requested) throw new Error('当前会话没有工作区，无法上传文件')
    const known = store.workspaces().find((entry) => pathKey(entry.path) === pathKey(requested))
    if (!known) throw new Error('文件只能上传到已经打开的工作区')
    const english = store.uiLocale() === 'en'
    const result = await dialog.showOpenDialog(mainWindow, {
      title: english ? 'Upload files to the workspace' : '上传文件到工作区',
      buttonLabel: english ? 'Upload' : '上传',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    return importUploadBatch(known.path, { paths: result.filePaths.slice(0, 3), blobs: [] })
  })

  /**
   * 拖拽或粘贴来的文件。渲染进程能拿到磁盘路径的（拖拽、资源管理器复制）
   * 只传路径，主进程自己复制；拿不到路径的（剪贴板里的虚拟文件）才传字节。
   */
  handle('pilot:upload-files', async (workspacePath: unknown, input: unknown) => {
    const requested = typeof workspacePath === 'string' ? workspacePath.trim() : ''
    if (!requested) throw new Error('当前会话没有工作区，无法上传文件')
    const known = store.workspaces().find((entry) => pathKey(entry.path) === pathKey(requested))
    if (!known) throw new Error('文件只能上传到已经打开的工作区')
    return importUploadBatch(known.path, parseUploadBatch(input))
  })

  /**
   * 粘贴进来的图片没有磁盘文件：先解成位图，再走和「图片」按钮同一套压缩，
   * 这样两条链路的体积上限与失败文案不会分叉。
   */
  handle('pilot:paste-image', async (input: unknown) => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const data = record.data
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new Error('剪贴板里没有可用的图片')
    }
    const bytes = uploadBytes(data as ArrayBuffer | Uint8Array)
    if (bytes.length === 0) throw new Error('剪贴板里没有可用的图片')
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('图片太大，请压缩后再添加')
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) throw new Error('无法识别剪贴板里的图片')
    return encodeMessageImage(image)
  })

  handle('pilot:workspace-open', async (path: string) => {
    const workspace = await store.addWorkspace(path)
    store.setActiveWorkspace(workspace.path)
    const sessions = store.sessions(workspace.path)
    store.setActiveSession(sessions[0]?.id ?? null)
    await store.save()
    return { workspace, sessions }
  })

  handle('pilot:workspace-remove', async (path: string) => {
    for (const session of store.sessions(path)) {
      if (runner.isRunning(session.id)) await runner.cancelRun(session.id)
    }
    await store.removeWorkspace(path)
    if (store.activeWorkspace()) {
      store.setActiveSession(store.sessions(store.activeWorkspace()!)[0]?.id ?? null)
    } else {
      store.setActiveSession(null)
    }
    await store.save()
  })

  handle('pilot:workspace-reveal', async (path: string) => {
    const target = await resolveExisting(path, '.')
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  handle('pilot:session-model', async (sessionId: string, modelId: string) => {
    const updated = await store.setSessionModel(sessionId, modelId)
    // 只影响下一次请求；运行中的任务保持已经开始的这一轮。
    broadcast({ type: 'session.changed', sessionId })
    return updated
  })

  handle('pilot:self-source-prepare', async () => {
    const prepared = await prepareSelfSource({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
    })
    forgetPersonalService()
    return prepared
  })

  handle('pilot:personal-state', async () => (await personalService()).state())
  // Source provenance: which commit the evolution loop is measured against.
  handle('pilot:self-source-status', async () => (await resolveSelfSourceCached()).provenance)
  handle('pilot:self-source-configure', async (input: unknown) => {
    const settings = normalizeSelfSourceSettings(input)
    store.updateSettings({
      selfSourceMode: settings.mode,
      selfSourceGitUrl: settings.gitUrl,
      selfSourceGitRef: settings.gitRef,
      selfSourceGitPath: settings.gitPath,
      selfSourceCustomPath: settings.customPath,
    })
    // Re-resolve immediately so the panel shows the new baseline without a
    // second round trip; nothing is fetched here.
    forgetPersonalService()
    return (await resolveSelfSourceCached()).provenance
  })
  handle('pilot:self-source-sync', async () => {
    const result = await syncSelfSource(selfSourceContext())
    // The fetched baseline moved, so the resolved paths and provenance are stale.
    forgetPersonalService()
    return result
  })
  handle('pilot:self-source-pick', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const english = store.uiLocale() === 'en'
    const result = await dialog.showOpenDialog(mainWindow, {
      title: english ? 'Choose the Pilot source directory' : '选择 Pilot 源码目录',
      buttonLabel: english ? 'Use this tree' : '使用此目录',
      properties: ['openDirectory'],
    })
    const picked = result.canceled ? '' : (result.filePaths[0] ?? '')
    return picked || null
  })
  handle('pilot:personal-save-version', async (input: PersonalVersionInput) =>
    (await personalService({ ensureSource: true, ensureBase: true })).saveVersion(input),
  )
  handle('pilot:personal-restore-version', async (versionId: string) => {
    await (await personalService({ ensureSource: true })).restoreVersion(versionId)
  })
  handle(
    'pilot:personal-submit',
    async (versionId: string, note: string, evidence?: ContributionEvidence) =>
      (await personalService()).submitVersion(
        versionId,
        note,
        evidence ?? contributionEvidence(),
      ),
  )
  handle('pilot:personal-reveal-contribution', async (contributionId: string) => {
    const path = await (await personalService()).contributionPath(contributionId)
    shell.showItemInFolder(path)
  })
  handle('pilot:personal-upgrade-plan', async () => (await personalService()).prepareUpgrade())
  handle('pilot:personal-upgrade-apply', async () => (await personalService()).applyUpgrade())
  handle('pilot:personal-upgrade-validate', async () => (await personalService()).validateUpgrade())
  handle('pilot:personal-upgrade-rollback', async () => (await personalService()).rollbackUpgrade())

  handle('pilot:sessions-list', (workspacePath: string) => store.sessions(workspacePath))
  handle('pilot:session-get', (sessionId: string) => store.session(sessionId))
  handle(
    'pilot:session-page',
    (sessionId: string, before?: string, limit?: number): SessionPage | null => {
      const session = store.session(sessionId)
      return session ? sessionPage(session, before, limit) : null
    },
  )
  handle(
    'pilot:session-around',
    (sessionId: string, messageId: string, limit?: number): SessionPage | null => {
      const session = store.session(sessionId)
      return session ? sessionPageAround(session, messageId, limit) : null
    },
  )
  handle(
    'pilot:search',
    (query: string, limit?: number, filter?: MessageSearchFilter) =>
      store.searchSessions(query, limit, filter),
  )
  handle('pilot:knowledge-pairs', (sessionId: string, query?: string, limit?: number) => {
    const session = store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return knowledgePairsFor(session.messages, typeof query === 'string' ? query : '', limit)
  })
  handle('pilot:session-transcript', (sessionId: string): string => {
    const session = store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return transcriptText(session.messages)
  })
  // Writing through the main process avoids the renderer permission prompt
  // and any secure-context restrictions. The renderer still has a browser
  // fallback, but this path is the one that always works in the desktop app.
  handle('pilot:clipboard-write', (text: unknown): boolean => {
    if (typeof text !== 'string' || text.length === 0) return false
    if (text.length > 50_000_000) throw new Error('要复制的内容过大')
    clipboard.writeText(text)
    return true
  })
  handle('pilot:session-create', async (workspacePath: string) => {
    const created = await store.createSession(workspacePath)
    return created
  })
  handle('pilot:review-create', async (input: ReviewSessionInput) => {
    if (!input || typeof input.workspacePath !== 'string' || !input.workspacePath.trim()) {
      throw new Error('复盘需要一个主工作区')
    }
    const primary = await workspaceRoot(input.workspacePath)
    if (!store.workspaces().some((workspace) => pathKey(workspace.path) === pathKey(primary))) {
      throw new Error('请先打开主工作区，再创建复盘会话')
    }
    const roots = await resolveReviewRoots(primary, input.roots)
    const sessions = normalizeReviewSessions(input.sessions)
    const objective =
      typeof input.objective === 'string' ? input.objective.trim().slice(0, 4_000) : ''
    const workspace = store.workspaces().find((entry) => pathKey(entry.path) === pathKey(primary))
    const title = objective
      ? `复盘：${objective.replace(/\s+/g, ' ').slice(0, 40)}`
      : `复盘 · ${workspace?.name ?? basename(primary)}`
    return store.createSession(primary, {
      kind: 'review',
      title,
      review: {
        roots,
        sessions,
        ...(objective ? { objective } : {}),
      },
    })
  })
  handle('pilot:review-handoff', (sessionId: string) => runner.handoffReview(sessionId))
  handle('pilot:module-check-state', async () => {
    await moduleCheck.load()
    return moduleCheck.snapshot()
  })
  handle('pilot:module-check-discover', () => moduleCheck.discover())
  handle('pilot:module-check-run', (moduleIds?: string[]) => {
    if (moduleIds !== undefined && !Array.isArray(moduleIds)) {
      throw new Error('模块列表格式不正确')
    }
    return moduleCheck.run(
      Array.isArray(moduleIds) ? moduleIds.filter((id) => typeof id === 'string') : undefined,
      'manual',
    )
  })
  handle('pilot:module-check-settings', (input: Partial<ModuleCheckSettings>) =>
    moduleCheck.updateSettings(input ?? {}),
  )
  handle(
    'pilot:module-check-accept',
    async (input: { reportId: string; riskIds: string[]; selfModify?: boolean }) => {
      if (!input || typeof input.reportId !== 'string') throw new Error('缺少自检报告 id')
      // 默认只生成提案：只有渲染层显式传 true 才会真的改自身源码。
      return moduleCheck.accept(input.reportId, input.riskIds, { selfModify: input.selfModify === true })
    },
  )
  handle('pilot:session-delete', async (sessionId: string) => {
    if (runner.isRunning(sessionId)) await runner.cancelRun(sessionId)
    await store.deleteSession(sessionId)
    await checkpoints.removeSession(sessionId)
  })
  handle(
    'pilot:session-update',
    async (sessionId: string, input: { title?: string; approvalMode?: ApprovalMode }) => {
      const updated = await store.updateSession(sessionId, input)
      if (input.approvalMode) runner.setApprovalMode(sessionId, updated.approvalMode)
      return updated
    },
  )

  handle(
    'pilot:message-send',
    (sessionId: string, content: string, delivery: MessageDelivery, options?: MessageOptions) =>
      runner.sendMessage(sessionId, content, delivery, options),
  )
  handle('pilot:run-cancel', (sessionId: string) => runner.cancelRun(sessionId))
  handle('pilot:run-pause', (sessionId: string) => runner.pauseRun(sessionId))
  handle('pilot:run-continue', (sessionId: string) => runner.continueRun(sessionId))
  handle('pilot:message-edit', (sessionId: string, messageId: string, content: string) =>
    runner.editMessage(sessionId, messageId, content),
  )
  handle('pilot:message-delete', (sessionId: string, messageId: string) =>
    runner.deleteMessage(sessionId, messageId),
  )
  handle('pilot:run-regenerate', (sessionId: string) => runner.regenerate(sessionId))
  handle('pilot:run-retry', (sessionId: string) => runner.retryRun(sessionId))
  handle('pilot:project-instructions', (workspacePath: string) =>
    loadProjectInstructions(workspacePath).then((files) =>
      files.map(({ name, bytes, truncated }) => ({ name, bytes, truncated })),
    ),
  )
  handle('pilot:queue-remove', (sessionId: string, taskId: string) =>
    runner.removeQueueItem(sessionId, taskId),
  )
  handle('pilot:queue-insert', (sessionId: string, taskId: string) =>
    runner.insertQueueItem(sessionId, taskId),
  )
  handle('pilot:queue-update', (sessionId: string, taskId: string, content: string) =>
    runner.updateQueueItem(sessionId, taskId, content),
  )
  handle('pilot:queue-to-todo', (sessionId: string, taskId: string) =>
    runner.convertQueueItemToTodo(sessionId, taskId),
  )
  handle(
    'pilot:approval-decide',
    (callId: string, approved: boolean, reason?: string, remember?: boolean) =>
      runner.decideApproval(callId, approved, reason, remember === true),
  )

  handle('pilot:session-fork', async (sessionId: string) => {
    if (runner.isRunning(sessionId)) {
      throw new Error('请先等待当前任务结束（或暂停）再创建副本')
    }
    return store.forkSession(sessionId)
  })
  handle('pilot:feedback-submit', async (input: FeedbackDraft, workspacePath?: string) => {
    // Environment values are re-read here rather than trusted from the renderer:
    // the dialog only chooses which lines are attached.
    const [info, sandbox] = await Promise.all([systemInfo(workspacePath), sandboxStatus()])
    const context = {
      version: app.getVersion(),
      platform: `${process.platform} ${release()}`,
      locale: store.uiLocale(),
      environment: feedbackEnvironment(info, sandbox, normalizeEnvFields(input.environment)),
    }
    return feedback.submit(input, context)
  })
  handle('pilot:feedback-folder', async () => {
    await mkdir(feedback.dir, { recursive: true })
    const error = await shell.openPath(feedback.dir)
    if (error) throw new Error('无法打开反馈文件夹')
  })
  handle('pilot:session-artifacts', (sessionId: string) => {
    const session = store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return collectSessionArtifacts(session.messages)
  })
  handle('pilot:changes-list', async (sessionId: string) => {
    const session = store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return localizeChanges(await listSessionChanges(session, checkpoints), store.uiLocale())
  })
  handle('pilot:change-revert', async (sessionId: string, path: string) => {
    const session = store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (runner.isRunning(sessionId)) throw new Error('请先等待当前任务结束或暂停后再撤销')
    const result = await revertSessionFile(session, checkpoints, path)
    broadcast({ type: 'session.changed', sessionId })
    return result
  })

  handle('pilot:sandbox-status', async () => {
    const status = await sandboxStatus()
    return { ...status, detail: localizeMain(status.detail, store.uiLocale()) }
  })
  // The renderer passes the active workspace so the reported volume is the one
  // builds and installs will actually write to. Nothing identifying is read.
  handle('pilot:system-info', async (workspacePath?: string) => systemInfo(workspacePath))
  // 日志读取：诊断面板与 CLI 共用，只返回已脱敏的元数据记录。
  handle('pilot:logs-recent', async (limit?: number) => (appLog ? appLog.recent(limit) : []))
  handle('pilot:logs-dir', () => appLog?.dir ?? '')
  handle('pilot:logs-open', async () => {
    if (!appLog) return
    await mkdir(appLog.dir, { recursive: true })
    const error = await shell.openPath(appLog.dir)
    if (error) throw new Error('无法打开日志文件夹')
  })
  // 渲染进程未捕获异常：白屏类问题唯一的现场，转发到主进程落盘。
  handle(
    'pilot:renderer-error',
    async (input?: { summary?: string; stack?: string; source?: string }) => {
      log(
        crashEntry({
          event: 'renderer-error',
          source: 'renderer',
          detail: {
            summary: String(input?.summary ?? '').slice(0, 240),
            stack: String(input?.stack ?? '').slice(0, 400),
            origin: String(input?.source ?? '').slice(0, 200),
          },
        }),
      )
    },
  )
  handle('pilot:checkpoints-list', async (sessionId: string) => {
    const list = await checkpoints.list(sessionId)
    const locale = store.uiLocale()
    return list.map((checkpoint) => ({
      ...checkpoint,
      label: localizeMain(checkpoint.label, locale),
    }))
  })
  handle('pilot:checkpoint-create', async (sessionId: string, label?: string) => {
    const session = store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (runner.isRunning(sessionId)) throw new Error('请先等待当前任务结束或暂停后再创建回退点')
    const english = store.uiLocale() === 'en'
    return checkpoints.create({
      sessionId,
      workspacePath: session.workspacePath,
      label:
        label?.trim() ||
        (english
          ? `Manual snapshot ${new Date().toLocaleString('en-US')}`
          : `手动快照 ${new Date().toLocaleString('zh-CN')}`),
      messageCount: session.messages.length,
      trigger: 'manual',
      retention: store.settings().checkpointRetention,
      maxBytes: store.settings().checkpointMaxBytes,
      ignore: store.settings().checkpointIgnore,
    })
  })
  handle(
    'pilot:checkpoint-restore',
    async (sessionId: string, checkpointId: string, mode: CheckpointRestoreMode) => {
      if (runner.isRunning(sessionId)) {
        throw new Error('请先等待当前任务结束或暂停后再回退')
      }
      const result = await checkpoints.restore(sessionId, checkpointId, mode)
      broadcast({ type: 'session.changed', sessionId })
      return result
    },
  )

  const emitScheduled = (sessionId: string): void => {
    const event: RunEvent = { type: 'scheduled.changed', sessionId }
    broadcast(event)
    companion?.publish(event)
  }
  handle('pilot:quick-commands-list', () => store.quickCommands())
  handle('pilot:quick-commands-save', (items: QuickCommandInput[]) =>
    store.saveQuickCommands(items),
  )
  handle('pilot:scheduled-list', (sessionId: string) => store.scheduledTasks(sessionId))
  handle(
    'pilot:scheduled-add',
    async (sessionId: string, input: ScheduledTaskInput) => {
      const task = await store.addScheduledTask(sessionId, input)
      emitScheduled(sessionId)
      return task
    },
  )
  handle(
    'pilot:scheduled-update',
    async (
      sessionId: string,
      taskId: string,
      input: Partial<ScheduledTaskInput> & { enabled?: boolean },
    ) => {
      const task = await store.updateScheduledTask(sessionId, taskId, input)
      emitScheduled(sessionId)
      return task
    },
  )
  handle('pilot:scheduled-remove', async (sessionId: string, taskId: string) => {
    await store.removeScheduledTask(sessionId, taskId)
    emitScheduled(sessionId)
  })

  const emitTodos = (sessionId: string): void => {
    const todos = store.todos(sessionId)
    broadcast({ type: 'todos.changed', sessionId, todos })
    companion?.publish({ type: 'todos.changed', sessionId, todos })
    broadcast({ type: 'session.changed', sessionId })
  }
  handle('pilot:todos-list', (sessionId: string) => store.todos(sessionId))
  handle('pilot:todo-add', async (sessionId: string, text: string, clientId?: string) => {
    const todo = await store.addTodo(sessionId, text, 'user', clientId)
    emitTodos(sessionId)
    return todo
  })
  handle('pilot:todo-update', async (sessionId: string, todoId: string, text: string) => {
    const todo = await store.updateTodo(sessionId, todoId, text)
    emitTodos(sessionId)
    return todo
  })
  handle('pilot:todo-remove', async (sessionId: string, todoId: string) => {
    await store.removeTodo(sessionId, todoId)
    emitTodos(sessionId)
  })
  handle('pilot:todos-clear-sent', async (sessionId: string) => {
    await store.clearSentTodos(sessionId)
    emitTodos(sessionId)
  })
  handle('pilot:todo-send', async (sessionId: string, todoId: string) => {
    const todo = store.todo(sessionId, todoId)
    if (!todo) throw new Error('待办不存在')
    if (todo.status === 'sent') throw new Error('该待办已发送')
    const result = await runner.sendMessage(sessionId, todo.text, 'queue')
    const updated = await store.markTodoSent(
      sessionId,
      todoId,
      runner.activeRun(sessionId)?.runId,
    )
    emitTodos(sessionId)
    return { ...result, todo: updated ?? todo }
  })
  handle('pilot:todos-send-all', async (sessionId: string) => {
    const pending = store
      .todos(sessionId)
      .filter((todo) => todo.status === 'pending')
      .reverse()
    let sent = 0
    let failed = 0
    for (const todo of pending) {
      try {
        await runner.sendMessage(sessionId, todo.text, 'queue')
        await store.markTodoSent(sessionId, todo.id, runner.activeRun(sessionId)?.runId)
        sent += 1
      } catch {
        failed += 1
      }
    }
    emitTodos(sessionId)
    return { sent, failed }
  })

  handle(
    'pilot:todo-to-schedule',
    async (sessionId: string, todoId: string, input: ScheduledTaskInput) => {
      const task = await store.convertTodoToSchedule(sessionId, todoId, input)
      emitScheduled(sessionId)
      emitTodos(sessionId)
      return task
    },
  )
  handle('pilot:scheduled-to-todo', async (sessionId: string, taskId: string) => {
    const todo = await store.convertScheduledTaskToTodo(sessionId, taskId)
    emitScheduled(sessionId)
    emitTodos(sessionId)
    return todo
  })

  handle('pilot:workspace-detail', (path: string) => store.workspaceDetail(path))
  // 质量闸门：评估、裁决、发布、手动调优。全部经同一道 busy 门，避免并发评估
  // 把同一份基线写成两个值。
  handle('pilot:quality-evaluate', (path: string) => runner.quality.evaluate(path, 'manual'))
  handle(
    'pilot:quality-decide',
    (path: string, candidateId: string, decision: 'approve' | 'reject') =>
      runner.quality.decide(path, candidateId, decision),
  )
  handle('pilot:quality-publish', (path: string, candidateId: string) =>
    runner.quality.publish(path, candidateId),
  )
  handle('pilot:quality-tune', (path: string) => runner.quality.tune(path))
  handle('pilot:memory-add', async (path: string, content: string) => {
    const entry = await store.addMemory(path, content, 'user')
    broadcast({ type: 'memory.changed', workspacePath: path })
    return entry
  })
  handle('pilot:memory-delete', async (path: string, memoryId: string) => {
    await store.deleteMemory(path, memoryId)
    broadcast({ type: 'memory.changed', workspacePath: path })
  })
  handle(
    'pilot:feedback-set',
    async (sessionId: string, runId: string, rating: 'up' | 'down', note?: string) => {
      const session = store.session(sessionId)
      if (!session) throw new Error('Session not found')
      const run = await store.setFeedback(session.workspacePath, runId, {
        rating,
        ...(note ? { note } : {}),
        at: new Date().toISOString(),
      })
      if (!run) throw new Error('Run not found')
      broadcast({ type: 'session.changed', sessionId })
      if (store.settings().autoReflect && store.getApiKey()) {
        void runner.evolution
          .reflect(session.workspacePath, runId, false)
          .then((entries) => {
            if (entries.length > 0) {
              broadcast({ type: 'memory.changed', workspacePath: session.workspacePath })
            }
          })
          .catch(() => undefined)
      }
    },
  )
  handle('pilot:run-reflect', async (sessionId: string, runId: string) => {
    const session = store.session(sessionId)
    if (!session) throw new Error('Session not found')
    const entries = await runner.evolution.reflect(session.workspacePath, runId, true)
    if (entries.length > 0) {
      broadcast({ type: 'memory.changed', workspacePath: session.workspacePath })
    }
    return entries
  })

  handle('pilot:evolution-propose', async (path: string) => {
    const profile = await runner.evolution.propose(path)
    broadcast({ type: 'profile.changed', workspacePath: path })
    return profile
  })
  handle('pilot:evolution-run-cycle', async (path: string) => {
    const cycle = await runner.evolution.runCycle(path, 'manual')
    broadcast({ type: 'evolution.changed', workspacePath: path })
    if (cycle.activated) broadcast({ type: 'profile.changed', workspacePath: path })
    return cycle
  })
  handle('pilot:evolution-improve-policy', async () => {
    const path = store.activeWorkspace()
    if (!path) throw new Error('No workspace is open')
    const version = await runner.evolution.improvePolicy(path)
    broadcast({ type: 'evolution.changed', workspacePath: path })
    return version
  })
  handle('pilot:evolution-policy-rollback', async () => {
    const version = await store.rollbackEvolutionPolicy()
    broadcast({
      type: 'evolution.changed',
      workspacePath: store.activeWorkspace() ?? '',
    })
    return version
  })
  handle('pilot:profile-review', async (path: string, profileId: string) => {
    const result = await runner.evolution.review(path, profileId)
    broadcast({ type: 'profile.changed', workspacePath: path })
    return result
  })
  /** One row per task for the benchmark dialog; the raw samples stay internal. */
  const benchmarkRows = (samples: BenchmarkRun['samples']): ProfileBenchmarkRow[] => {
    const rows = new Map<string, ProfileBenchmarkRow>()
    for (const sample of samples) {
      const row: ProfileBenchmarkRow = rows.get(sample.taskId) ?? {
        taskId: sample.taskId,
        currentPassed: false,
        candidatePassed: false,
        currentSteps: 0,
        candidateSteps: 0,
      }
      if (sample.variant === 'current') {
        row.currentPassed = sample.ok
        row.currentSteps = sample.steps
        if (sample.judgeScore !== undefined) row.currentJudgeScore = sample.judgeScore
      } else {
        row.candidatePassed = sample.ok
        row.candidateSteps = sample.steps
        if (sample.judgeScore !== undefined) row.candidateJudgeScore = sample.judgeScore
      }
      rows.set(sample.taskId, row)
    }
    return [...rows.values()]
  }
  handle('pilot:profile-benchmark', async (path: string, profileId: string) => {
    const run = await runner.evolution.benchmark(path, profileId)
    // Persist the measured outcome and recompute the activation gate, so a
    // measured regression (or a tie that proves nothing) cannot be overridden
    // by an older rubric score. `recordBenchmark` also stores which two version
    // ids were compared, so a later rollback cannot reuse stale numbers.
    const comparison = await runner.evolution.recordBenchmark('workspace', path, profileId, run)
    broadcast({ type: 'profile.changed', workspacePath: path })
    return { comparison, rows: benchmarkRows(run.samples) }
  })
  handle(
    'pilot:profile-activate',
    async (path: string, profileId: string, force?: boolean) => {
      const detail = store.workspaceDetail(path)
      const profile = detail.profiles.find((entry) => entry.id === profileId)
      if (!profile) throw new Error('Profile not found')
      assertActivatable(
        store.activeProfile(path),
        profile,
        force === true,
        '独立评审尚未通过',
      )
      const active = await store.activateProfile(path, profileId)
      broadcast({ type: 'profile.changed', workspacePath: path })
      return active
    },
  )
  handle('pilot:profile-rollback', async (path: string) => {
    const profile = await store.rollbackProfile(path)
    broadcast({ type: 'profile.changed', workspacePath: path })
    return profile
  })
  handle('pilot:profile-delete', async (path: string, profileId: string) => {
    await store.deleteProfile(path, profileId)
    broadcast({ type: 'profile.changed', workspacePath: path })
  })

  const broadcastGlobalProfileChanged = () =>
    broadcast({ type: 'profile.changed', workspacePath: store.activeWorkspace() ?? '' })

  handle('pilot:evolution-promote-global', async (path: string, profileId: string) => {
    const profile = await runner.evolution.promote(path, profileId)
    broadcastGlobalProfileChanged()
    return profile
  })
  handle(
    'pilot:profile-localize',
    async (scope: 'workspace' | 'global', path: string, profileId: string) => {
      const profile = await runner.evolution.localize(scope, path, profileId)
      if (scope === 'global') broadcastGlobalProfileChanged()
      else broadcast({ type: 'profile.changed', workspacePath: path })
      return profile
    },
  )
  handle(
    'pilot:profile-explain',
    async (scope: 'workspace' | 'global', path: string, profileId: string) => {
      const profile = await runner.evolution.explain(scope, path, profileId)
      if (scope === 'global') broadcastGlobalProfileChanged()
      else broadcast({ type: 'profile.changed', workspacePath: path })
      return profile
    },
  )
  handle('pilot:global-profile-review', async (profileId: string) => {
    const result = await runner.evolution.reviewGlobal(profileId)
    broadcastGlobalProfileChanged()
    return result
  })
  handle('pilot:global-profile-benchmark', async (profileId: string) => {
    const run = await runner.evolution.benchmarkGlobal(profileId)
    const comparison = await runner.evolution.recordBenchmark('global', '', profileId, run)
    broadcastGlobalProfileChanged()
    return { comparison, rows: benchmarkRows(run.samples) }
  })
  handle(
    'pilot:global-profile-activate',
    async (profileId: string, force?: boolean) => {
      const profile = store.globalProfile(profileId)
      if (!profile) throw new Error('Global profile not found')
      assertActivatable(
        store.activeGlobalProfile(),
        profile,
        force === true,
        'The independent review did not pass. Use "Enable anyway" only if you accept the noted risks.',
      )
      const active = await store.activateGlobalProfile(profileId)
      broadcastGlobalProfileChanged()
      return active
    },
  )
  handle('pilot:global-profile-rollback', async () => {
    const profile = await store.rollbackGlobalProfile()
    broadcastGlobalProfileChanged()
    return profile
  })
  handle('pilot:global-profile-delete', async (profileId: string) => {
    await store.deleteGlobalProfile(profileId)
    broadcastGlobalProfileChanged()
  })
  handle('pilot:global-instructions-open', async () => {
    const file = await ensureGlobalInstructions(app.getPath('userData'), store.uiLocale())
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
    return file
  })

  handle('pilot:tools-list', async (path: string) => (await toolRegistryFor(path)).list())

  handle('pilot:self-check-run', () => collectSelfCheck())
  handle(
    'pilot:tool-enabled',
    async (path: string, source: 'workspace' | 'global', name: string, enabled: boolean) => {
      const tools = await (await toolRegistryFor(path)).setEnabled(source, name, enabled === true)
      broadcast({ type: 'tools.changed', workspacePath: path })
      return tools
    },
  )
  handle('pilot:tool-remove', async (path: string, source: 'workspace' | 'global', name: string) => {
    const tools = await (await toolRegistryFor(path)).remove(source, name)
    broadcast({ type: 'tools.changed', workspacePath: path })
    return tools
  })
  handle('pilot:tool-promote', async (path: string, name: string) => {
    // An explicit user action in the settings panel: the user is the one deciding
    // the tool is generic, so the "ran successfully once" gate does not apply.
    // The hardcoded-workspace-path check still does.
    const tools = await (await toolRegistryFor(path)).promote(name, { force: true })
    broadcast({ type: 'tools.changed', workspacePath: path })
    return tools
  })

  // ── Plugin market and plugin assistant ────────────────────────────────────
  // Every handler resolves the workspace first, so a stale renderer path cannot
  // make the main process write into an unrelated directory.
  handle('pilot:plugins-overview', async (path: string) => {
    await resolveExisting(path, '.')
    return pluginOverview(path)
  })
  handle('pilot:plugin-pick-dir', async (title?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: typeof title === 'string' && title ? title : '选择插件创建目录',
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('pilot:plugin-create', async (input: PluginCreateInput) => {
    if (!input || typeof input !== 'object') throw new Error('缺少创建参数')
    // The target directory is outside the workspace by design (the user picks
    // it), so it is validated by createPlugin itself: id pattern, empty target.
    const created = await createPlugin({
      targetDir: String(input.targetDir ?? ''),
      id: String(input.id ?? ''),
      name: String(input.name ?? ''),
      description: String(input.description ?? ''),
      template: input.template ?? 'http',
      sign: input.sign === true,
    })
    const workspace = store.activeWorkspace()
    if (workspace) broadcast({ type: 'plugins.changed', workspacePath: workspace })
    return created
  })
  handle('pilot:plugin-install', async (path: string, input: PluginInstallInput) => {
    await resolveExisting(path, '.')
    if (!input || typeof input !== 'object') throw new Error('缺少导入参数')
    const result = await installPlugin({
      workspace: path,
      sourceDir: String(input.sourceDir ?? ''),
      trust: input.trust === true,
      publicKey: input.publicKey ? String(input.publicKey) : undefined,
      force: input.force === true,
      label: input.label ? String(input.label) : undefined,
    })
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return result
  })
  handle('pilot:plugin-install-market', async (path: string, id: string) => {
    await resolveExisting(path, '.')
    const result = await installMarketPlugin(path, String(id ?? ''))
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return result
  })
  handle('pilot:plugin-remove', async (path: string, id: string) => {
    await resolveExisting(path, '.')
    await removePlugin(path, String(id ?? ''))
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })
  handle('pilot:plugin-enabled', async (path: string, id: string, enabled: boolean) => {
    await resolveExisting(path, '.')
    await setPluginEnabled(path, String(id ?? ''), enabled === true)
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })
  handle('pilot:plugin-sign', async (path: string, id: string) => {
    await resolveExisting(path, '.')
    const { signature } = await signInstalledPlugin(path, String(id ?? ''))
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return signature
  })
  handle('pilot:plugin-trust', async (path: string, publicKey: string, label?: string) => {
    await resolveExisting(path, '.')
    await trustPublicKey(path, String(publicKey ?? ''), label ? String(label) : undefined)
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })
  handle('pilot:plugin-untrust', async (path: string, keyId: string) => {
    await resolveExisting(path, '.')
    await untrustPublicKey(path, String(keyId ?? ''))
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })
  handle('pilot:plugin-policy', async (path: string, policy: PluginSignaturePolicy) => {
    await resolveExisting(path, '.')
    await setSignaturePolicy(path, policy)
    broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })
  handle('pilot:plugin-reveal', async (dir: string) => {
    const target = resolve(String(dir ?? ''))
    if (!existsSync(target)) throw new Error('目录不存在')
    shell.showItemInFolder(target)
  })

  handle('pilot:files-list', async (path: string, directory: string) => {
    await resolveExisting(path, '.')
    return listDirectory(path, directory || '.')
  })
  handle('pilot:file-preview', async (path: string, file: string) => {
    await resolveExisting(path, '.')
    return previewFile(path, file)
  })
  handle('pilot:file-reveal', async (path: string, file: string) => {
    const target = await resolveExisting(path, file)
    shell.showItemInFolder(target)
  })
  handle('pilot:open-link', async (url: string, external?: boolean) => {
    await openLink(url, { external, activeRoot: () => store.activeWorkspace() })
  })

  /**
   * Open one file in its own window. The workspace still has to be one the user
   * opened, and the path is resolved (and jail-checked) before a window exists.
   */
  handle('pilot:doc-open', async (workspace: string, file: string) => {
    const root = await resolveExisting(workspace, '.')
    await resolveExisting(root, file)
    openDocumentWindow({
      workspace: root,
      relativePath: file,
      preload: join(__dirname, '../preload/index.js'),
    })
  })
  /** What a standalone document window needs to paint itself like the app. */
  handle('pilot:doc-state', () => {
    const settings = store.settingsView()
    return {
      theme: settings.theme,
      accent: settings.accent,
      contrast: settings.contrast,
      saturation: settings.saturation,
      fontSize: settings.fontSize,
      locale: store.uiLocale(),
      version: app.getVersion(),
      platform: process.platform,
    }
  })
  handle('pilot:doc-close', () => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && isDocumentWindowContents(focused.webContents.id)) focused.close()
  })

  handle('pilot:update-state', () => localizeUpdateState(updater.stateSnapshot(), store.uiLocale()))
  handle('pilot:update-check', async () =>
    localizeUpdateState(await updater.check(), store.uiLocale()),
  )
  handle('pilot:update-download', async () =>
    localizeUpdateState(await updater.download(), store.uiLocale()),
  )
  handle('pilot:update-install', async () => {
    try {
      await updater.install()
    } catch (error) {
      throw new Error(localizeMain(error instanceof Error ? error.message : String(error), store.uiLocale()))
    }
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.pilot.agent')
  // The handler reads the active workspace lazily: the store loads below.
  installMediaProtocol(() => store?.activeWorkspace() ?? null)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  store = new Store()
  await store.load()
  // A pinned mode ignores the OS; `system` repaints the window chrome whenever
  // it flips. The renderer follows the same flip through `matchMedia`. Bound
  // after the store is loaded, because the handler reads settings.
  nativeTheme.on('updated', () => {
    const view = store.settingsView()
    if (view.theme !== 'system') return
    applyTheme(view.theme, view.accent, view.contrast)
  })
  // One assembly path for both hosts: `src/core/engine.ts`. What stays here is
  // Electron-only: the window, the in-app updater, the OS notifier and the
  // single-instance lock.
  const engine = createEngine({
    store,
    dataDir: app.getPath('userData'),
    publish: (event) => {
      broadcast(event)
      notifyEvent(event)
      companion?.publish(event)
    },
    getWindow: () => mainWindow,
    // 打包脚本只存在于 pilot/client，开发时就是 appPath；安装后的自带源码在 userData。
    packageRoot: app.isPackaged
      ? join(app.getPath('userData'), 'self-src')
      : app.getAppPath(),
  })
  billing = engine.billing
  checkpoints = engine.checkpoints
  runner = engine.runner
  scheduler = engine.scheduler
  feedback = new FeedbackBox(app.getPath('userData'))
  void sandboxStatus()
  updater = new UpdaterService({
    currentVersion: app.getVersion(),
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    onState: broadcastUpdate,
  })
  scheduleCheckpointMaintenance()
  appLog = createAppLog({ dir: join(app.getPath('userData'), 'logs') })
  // 启动早期排队的日志在这里补写：崩溃记录不能因为初始化顺序丢掉。
  for (const entry of earlyLogs.splice(0)) log(entry)
  moduleCheck = new ModuleCheckService({
    userDataDir: app.getPath('userData'),
    // 自检只看内置源码：安装版首次调用会把 resources/source 复制到 userData。
    sourceRoot: async () => (await prepareSelfSource(selfSourceOptions())).path,
    log: (entry) => log(entry),
    emit: (event) => {
      broadcast(event)
      notifyEvent(event)
      companion?.publish(event)
    },
    startSession: async (workspacePath, prompt) => {
      // 与用户手写任务完全同一条路径：正常会话、正常沙箱、正常审批。
      const created = await store.createSession(workspacePath)
      try {
        await runner.sendMessage(created.id, prompt, 'queue')
        return { sessionId: created.id }
      } catch (error) {
        // 只处理“还没配模型”这一类可恢复错误；其它失败（例如会话已失效）照常上抛。
        const message = error instanceof Error ? error.message : ''
        if (!/API key/i.test(message)) throw error
        const current = store.session(created.id)
        await store.setQueue(created.id, [
          ...(current?.queue ?? []),
          { id: `mc_${Date.now()}`, content: prompt, createdAt: new Date().toISOString() },
        ])
        const queue = store.session(created.id)?.queue ?? []
        broadcast({ type: 'queue.changed', sessionId: created.id, queue })
        return { sessionId: created.id, queued: true }
      }
    },
  })
  await moduleCheck.load()
  moduleCheck.start()
  const bundledCompanion = join(app.getAppPath(), 'companion')
  const companionDir = existsSync(bundledCompanion)
    ? bundledCompanion
    : join(process.cwd(), 'companion')
  companion = new CompanionServer({
    store,
    runner,
    billing,
    checkpoints: checkpointBridge(engine),
    changes: changesBridge(engine),
    // The phone can start a module self-check fix session; it runs on the same
    // store, sandbox and approval policy as a hand-written task.
    moduleCheck: {
      // 展示用的扫描根：与自检实际扫描的目录一致（内置源码）。
      source: () => selfSourcePath(),
      // 手机只消费摘要；返回 snapshot() 会白拷贝整份历史报告。
      state: async () => moduleCheck.summary(),
      discover: () => moduleCheck.discover(),
      run: (moduleIds) => moduleCheck.run(moduleIds, 'manual'),
      settings: (input) => moduleCheck.updateSettings(input),
      accept: async (reportId, riskIds, selfModify) => {
        const result = await moduleCheck.accept(reportId, riskIds, { selfModify: selfModify === true })
        return {
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          queued: result.queued === true,
          selfModify: result.selfModify,
          proposalId: result.proposalId,
        }
      },
    },
    capabilities: DESKTOP_CAPABILITIES,
    // 内视：手机端与桌面走同一条采样路径，只返回报告，不改任何文件。
    selfCheck: {
      run: () => collectSelfCheck(),
    },
    update: {
      state: () => localizeUpdateState(updater.stateSnapshot(), store.uiLocale()),
      check: async () => localizeUpdateState(await updater.check(), store.uiLocale()),
      download: async () => {
        // Download can take minutes; return immediately and let update.changed
        // push progress to the phone.
        void updater.download()
        return localizeUpdateState(updater.stateSnapshot(), store.uiLocale())
      },
      install: () => updater.install(),
    },
    evolution: createEvolutionControls({
      store,
      runner,
      // `broadcast` already reaches the panel; publishing again here would send
      // every evolution frame twice.
      publish: (event) => {
        broadcast(event)
        companion?.publish(event)
      },
      // Only the desktop install ships the pristine source tree these need.
      personal: {
        service: (options) => personalService(options),
        evidence: () => contributionEvidence(),
        startChat: (title, prompt) => startPersonalChat(title, prompt),
        openSource: async () => {
          const prepared = await prepareSelfSource(selfSourceOptions())
          await store.addWorkspace(prepared.path, { activate: false })
          const event: RunEvent = { type: 'workspace.changed', workspacePath: prepared.path }
          broadcast(event)
          companion?.publish(event)
          return { path: prepared.path, copied: prepared.copied }
        },
      },
    }),
    dataDir: app.getPath('userData'),
    assetsDir: companionDir,
    deviceName: hostname(),
    appVersion: app.getVersion(),
    relayUrl: process.env['PILOT_RELAY_URL'] ?? undefined,
    appUrl: process.env['PILOT_APP_URL'] ?? undefined,
    appDownloadUrl: process.env['PILOT_APP_DOWNLOAD_URL'] ?? undefined,
    onStatus: (status) => broadcast({ type: 'companion.changed', status }),
    onEvent: (event) => {
      // A phone that scanned the QR code needs an answer from a person, so
      // surface the window even when it is minimised or hidden in the tray.
      if (event.type === 'companion.pair_request') focusMainWindow()
      broadcast(event)
    },
  })
  await companion.init()
  await companion.startIfEnabled()
  scheduler.start()
  // Capture Git Bash's login environment while the window loads so the first
  // shell command does not pay for /etc/profile and ~/.bashrc.
  warmShellProfile()
  // 进化页要等自身源码解析（若干 git 子进程，Windows 上约 3 s）才能渲染个人分支。
  // 窗口加载时先把它跑起来，用户点进来时通常已经就绪。
  void personalService()
    .then((service) => service.state())
    .catch(() => undefined)
  registerIpc()
  createTray()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * 真正的退出路径都会先经过这里：托盘菜单直接置位，更新器与系统关机走
 * `app.quit()`，而 `before-quit` 总在窗口 close 事件之前触发。
 */
app.on('before-quit', () => {
  quitting = true
  if (checkpointMaintenanceTimer) clearTimeout(checkpointMaintenanceTimer)
  scheduler?.stop()
  checkpoints?.dispose()
  if (runner) void runner.shutdown()
  if (companion) void companion.stop()
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})

app.on('window-all-closed', () => {
  // 有托盘时常驻：窗口关掉只是藏起来，退出由托盘菜单或 before-quit 决定。
  if (process.platform === 'darwin' || tray) return
  app.quit()
})
