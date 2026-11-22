import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { hostname, release } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { appIconPath } from './app-icon'
import { appUserModelId, foreignShortcuts, type ShortcutIdentity } from './win-identity'
import { trayClickAction } from './window-action'
import type {
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
  SessionPageOptions,
  SettingsUpdate,
  StoredMessage,
  ThemeMode,
  ContrastPreference,
  SaturationPreference,
  TodoPriority,
  UpdateState,
} from '../shared/types'
import { applyContrastColor } from '../shared/theme'
import { normalizeEnvFields, type FeedbackDraft } from '../shared/feedback'
import type { ModuleCheckSettings } from '../shared/module-check'
import { AgentRunner } from './agent/runner'
import { dialoguePage, runMessages } from './session-page'
import { filterLearningTools, pilotTools, RUN_SHELL } from './agent/tools'
import { resolveLearningPolicy } from './agent/learning'
import { buildToolCatalog, countToolCalls } from '../shared/tools-catalog'
import { collectSessionLinks } from '../shared/session-links'
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
import { resourceUsage } from './resource-usage'
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
import { registerSessionIpc } from './ipc/session'
import { registerWorkIpc } from './ipc/work'
import { registerSettingsIpc } from './ipc/settings'
import { registerCompanionIpc } from './ipc/companion'
import { registerPersonalIpc } from './ipc/personal'
import { safeUrl, windowPalette, healWindowsShortcuts } from './window-platform'
import { pathKey, resolveReviewRoots, transcriptText, sessionPage, sessionPageAround } from './session-view'
import { encodeMessageImage, uploadBytes, importUploadBatch } from './media-upload'
import { appState } from './app-state'
import { createIpcContext } from './ipc-context'
import { scheduleCheckpointMaintenance } from './checkpoint-maintenance'
import { personalService, contributionEvidence, selfSourceOptions, selfSourcePath, startPersonalChat } from './personal-branch'
import { log, installCrashLogging, broadcast, collectSelfCheck } from './diagnostics'
import { focusMainWindow, notifyEvent, broadcastUpdate, createWindow, revealMainWindow, createTray } from './window-tray'

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

installCrashLogging()

function registerIpc(): void {
  const ctx = createIpcContext()
  registerSessionIpc(ctx)
  registerWorkIpc(ctx)
  registerSettingsIpc(ctx)
  registerCompanionIpc(ctx)
  registerPersonalIpc(ctx)
}

app.on('second-instance', () => {
  // 从开始菜单/快捷方式再启动一次时，窗口可能只是藏到托盘里：`focus()` 不会把
  // 隐藏窗口显示出来，用户会以为没反应，所以走同一条「显示并置前」路径。
  // 主窗口还没建（启动早期）时什么都别做：`whenReady` 紧接着就会建它，而那时
  // `createWindow()` 需要的 store 还没加载完。
  if (!appState.mainWindow || appState.mainWindow.isDestroyed()) return
  revealMainWindow()
})

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    // Dev must not claim the product AUMID: Electron's shell integration would
    // write `Electron.lnk` under it and the installed app would then show
    // Electron's name and icon on the taskbar.
    app.setAppUserModelId(appUserModelId(app.isPackaged))
    healWindowsShortcuts()
  }
  // The handler reads the active workspace lazily: the store loads below.
  installMediaProtocol(() => appState.store?.activeWorkspace() ?? null)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  appState.store = new Store()
  await appState.store.load()
  // One assembly path for both hosts: `src/core/engine.ts`. What stays here is
  // Electron-only: the window, the in-app updater, the OS notifier and the
  // single-instance lock.
  const engine = createEngine({
    store: appState.store,
    dataDir: app.getPath('userData'),
    publish: (event) => {
      broadcast(event)
      notifyEvent(event)
      appState.companion?.publish(event)
    },
    getWindow: () => appState.mainWindow,
    // 打包脚本只存在于 pilot/pilot，开发时就是 appPath；安装后的自带源码在 userData。
    packageRoot: app.isPackaged
      ? join(app.getPath('userData'), 'self-src')
      : app.getAppPath(),
  })
  appState.billing = engine.billing
  appState.checkpoints = engine.checkpoints
  appState.runner = engine.runner
  appState.scheduler = engine.scheduler
  appState.feedback = new FeedbackBox(app.getPath('userData'))
  void sandboxStatus()
  appState.updater = new UpdaterService({
    currentVersion: app.getVersion(),
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    onState: broadcastUpdate,
  })
  scheduleCheckpointMaintenance()
  appState.appLog = createAppLog({ dir: join(app.getPath('userData'), 'logs') })
  // 启动早期排队的日志在这里补写：崩溃记录不能因为初始化顺序丢掉。
  for (const entry of appState.earlyLogs.splice(0)) log(entry)
  appState.moduleCheck = new ModuleCheckService({
    userDataDir: app.getPath('userData'),
    // 自检只看内置源码：安装版首次调用会把 resources/source 复制到 userData。
    sourceRoot: async () => (await prepareSelfSource(selfSourceOptions())).path,
    log: (entry) => log(entry),
    emit: (event) => {
      broadcast(event)
      notifyEvent(event)
      appState.companion?.publish(event)
    },
    startSession: async (workspacePath, prompt) => {
      // 与用户手写任务完全同一条路径：正常会话、正常沙箱、正常审批。
      const created = await appState.store.createSession(workspacePath)
      try {
        await appState.runner.sendMessage(created.id, prompt, 'queue')
        return { sessionId: created.id }
      } catch (error) {
        // 只处理“还没配模型”这一类可恢复错误；其它失败（例如会话已失效）照常上抛。
        const message = error instanceof Error ? error.message : ''
        if (!/API key/i.test(message)) throw error
        const current = appState.store.session(created.id)
        await appState.store.setQueue(created.id, [
          ...(current?.queue ?? []),
          { id: `mc_${Date.now()}`, content: prompt, createdAt: new Date().toISOString() },
        ])
        const queue = appState.store.session(created.id)?.queue ?? []
        broadcast({ type: 'queue.changed', sessionId: created.id, queue })
        return { sessionId: created.id, queued: true }
      }
    },
  })
  await appState.moduleCheck.load()
  appState.moduleCheck.start()
  const bundledCompanion = join(app.getAppPath(), 'companion')
  const companionDir = existsSync(bundledCompanion)
    ? bundledCompanion
    : join(process.cwd(), 'companion')
  appState.companion = new CompanionServer({
    store: appState.store,
    runner: appState.runner,
    billing: appState.billing,
    checkpoints: checkpointBridge(engine),
    changes: changesBridge(engine),
    // The phone can start a module self-check fix session; it runs on the same
    // store, sandbox and approval policy as a hand-written task.
    moduleCheck: {
      // 展示用的扫描根：与自检实际扫描的目录一致（内置源码）。
      source: () => selfSourcePath(),
      // 手机只消费摘要；返回 snapshot() 会白拷贝整份历史报告。
      state: async () => appState.moduleCheck.summary(),
      discover: () => appState.moduleCheck.discover(),
      run: (moduleIds) => appState.moduleCheck.run(moduleIds, 'manual'),
      settings: (input) => appState.moduleCheck.updateSettings(input),
      accept: async (reportId, riskIds, selfModify) => {
        const result = await appState.moduleCheck.accept(reportId, riskIds, { selfModify: selfModify === true })
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
      state: () => localizeUpdateState(appState.updater.stateSnapshot(), appState.store.uiLocale()),
      check: async () => localizeUpdateState(await appState.updater.check(), appState.store.uiLocale()),
      download: async () => {
        // Download can take minutes; return immediately and let update.changed
        // push progress to the phone.
        void appState.updater.download()
        return localizeUpdateState(appState.updater.stateSnapshot(), appState.store.uiLocale())
      },
      install: () => appState.updater.install(),
    },
    evolution: createEvolutionControls({
      store: appState.store,
      runner: appState.runner,
      // `broadcast` already reaches the panel; publishing again here would send
      // every evolution frame twice.
      publish: (event) => {
        broadcast(event)
        appState.companion?.publish(event)
      },
      // Only the desktop install ships the pristine source tree these need.
      personal: {
        service: (options) => personalService(options),
        evidence: () => contributionEvidence(),
        startChat: (title, prompt) => startPersonalChat(title, prompt),
        openSource: async () => {
          const prepared = await prepareSelfSource(selfSourceOptions())
          await appState.store.addWorkspace(prepared.path, { activate: false })
          const event: RunEvent = { type: 'workspace.changed', workspacePath: prepared.path }
          broadcast(event)
          appState.companion?.publish(event)
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
  await appState.companion.init()
  await appState.companion.startIfEnabled()
  appState.scheduler.start()
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
  appState.quitting = true
  if (appState.checkpointMaintenanceTimer) clearTimeout(appState.checkpointMaintenanceTimer)
  appState.scheduler?.stop()
  appState.checkpoints?.dispose()
  if (appState.runner) void appState.runner.shutdown()
  if (appState.companion) void appState.companion.stop()
})

app.on('will-quit', () => {
  appState.tray?.destroy()
  appState.tray = null
})

app.on('window-all-closed', () => {
  // 有托盘时常驻：窗口关掉只是藏起来，退出由托盘菜单或 before-quit 决定。
  if (process.platform === 'darwin' || appState.tray) return
  app.quit()
})
