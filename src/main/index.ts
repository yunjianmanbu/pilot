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
import { stopSharedPluginHosts } from './plugins/shared'
import { createStartupFallback } from './startup-fallback'
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
  TodoPriority,
  UpdateState,
} from '../shared/types'
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
import { changesBridge, checkpointBridge, createEngine, createGuestEngine } from '../core/engine'
import { createEvolutionControls } from '../core/evolution'
import { assertActivatable } from '../core/profile-gate'
import { DESKTOP_CAPABILITIES } from '../shared/capabilities'
import { CheckpointService } from './checkpoints'
import { FeedbackBox } from './feedback'
import { CompanionServer } from './companion/server'
import { bridgeEmit } from './companion/handlers/bridge'
import { createCompanionModeControl } from './companion/mode-control'
import { createReflectControls } from './companion/handlers/reflect'
import { invokeDesktopBridge } from './ipc-context'
import { setRendererSink } from './renderer-sink'
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
import { codeFactsFromModuleCheck } from './reflect/evidence'
import { SupervisorService } from './supervisor'
import { SuperPilot } from './super-pilot'
import { sendToSuperWindow, closeSuperWindow, openSuperWindow } from './super-window'
import { registerSuperIpc } from './ipc/super'
import type { SupervisorReflectionSample, SupervisorRunSample } from '../shared/supervisor'
import { REFLECTION_TOPICS } from '../shared/reflect'
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
import { registerAllIpc } from './ipc'
import { safeUrl, windowPalette, healWindowsShortcuts } from './window-platform'
import { pathKey, resolveReviewRoots, transcriptText, sessionPage, sessionPageAround } from './session-view'
import { encodeMessageImage, uploadBytes, importUploadBatch } from './media-upload'
import { appState } from './app-state'
import { BackgroundScheduler } from './background'
import { LagMonitor } from './runtime-health'
import { scheduleCheckpointMaintenance } from './checkpoint-maintenance'
import { personalService, contributionEvidence, selfSourceOptions, selfSourcePath, startPersonalChat } from './personal-branch'
import { log, installCrashLogging, broadcast, collectSelfCheck } from './diagnostics'
import { MailNotifier } from './notify/mail-notify'
import { instructionOf } from './notify/instruction-title'
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

/** 自主优化采样：每个工作区取最近多少条运行，合起来再截到上限。 */
const SUPERVISOR_RUN_SAMPLE_PER_WORKSPACE = 20
const SUPERVISOR_RUN_SAMPLE_LIMIT = 40
/** 最近几份反思报告进闭环；保鲜期由 shared 层按 createdAt 判定。 */
const SUPERVISOR_REFLECTION_REPORT_LIMIT = 5

/**
 * 自修改/自优化会话的唯一创建入口。
 *
 * 自检、自主优化、手机端都调它：与用户手写任务完全同一条路径——正常会话、
 * 正常沙箱、正常审批、正常检查点。只把「还没配模型」当成可恢复错误（入队），
 * 其它失败照常上抛，让调用方在面板上看到真实原因。
 */
async function startSelfModifySession(
  workspacePath: string,
  prompt: string,
): Promise<{ sessionId: string; queued: boolean }> {
  const created = await appState.store.createSession(workspacePath)
  try {
    await appState.runner.sendMessage(created.id, prompt, 'queue')
    return { sessionId: created.id, queued: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!/API key/i.test(message)) throw error
    const current = appState.store.session(created.id)
    await appState.store.setQueue(created.id, [
      ...(current?.queue ?? []),
      { id: `self_${Date.now()}`, content: prompt, createdAt: new Date().toISOString() },
    ])
    const queue = appState.store.session(created.id)?.queue ?? []
    broadcast({ type: 'queue.changed', sessionId: created.id, queue })
    return { sessionId: created.id, queued: true }
  }
}

function registerIpc(): void {
  registerAllIpc()
}

/**
 * 启动装配失败时的最后一道保险：主引擎起不来，应急通道必须还在。
 *
 * 走到这里说明 `whenReady` 的某一步抛了（主 store 损坏、回退点目录不可写、
 * 网关端口被占……）。此时既没有主窗口也没有托盘，重新抛只会得到一个静默退出的
 * 应用。具体动作在 `startup-fallback.ts` 里（可单测）：写日志、记到超级 Pilot 状态、
 * 补注册应急通道、建托盘、直接打开超级 Pilot 窗口。
 */
function reportStartupFailure(error: unknown): void {
  createStartupFallback({
    log: (entry) => log(entry),
    noteHostFailure: (message) => appState.superPilot?.noteHostFailure(message),
    registerSuperIpc,
    createTray,
    openSuperWindow: (options) => openSuperWindow(options),
    theme: () => appState.store?.settings?.().theme ?? 'dark',
  })(error)
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
  // 超级 Pilot 的通道先于主引擎装配：`createEngine` 自己抛错时（主 store 损坏、
  // 回退点目录不可写等），这条应急通道已经能打开窗口、看到原因、动手修。它读
  // 主 store 只为了复制模型通道，读不出来就用自己上次存下的那份。
  appState.superPilot = new SuperPilot({
    userDataDir: app.getPath('userData'),
    selfSource: async () => (await prepareSelfSource(selfSourceOptions())).path,
    sourceStore: () => appState.store,
    log: (entry) => log(entry),
    // 只给应急窗口，不广播：它的事件不该出现在主界面或手机上。
    emit: (event) => sendToSuperWindow('pilot:super-event', event),
    packageRoot: app.isPackaged
      ? join(app.getPath('userData'), 'self-src')
      : app.getAppPath(),
    // 主引擎上的「放开卡住的东西」只能由宿主提供：本模块刻意不 import 宿主状态。
    hostActions: () => [
      {
        label: '取消主引擎所有运行',
        run: async () => {
          const running = appState.store?.activeRuns() ?? []
          if (running.length === 0) return '没有正在运行的对话'
          for (const entry of running) {
            await appState.runner?.cancelRun(entry.sessionId).catch(() => undefined)
          }
          return `已取消 ${running.length} 个运行`
        },
      },
      {
        label: '放掉等待中的审批',
        run: async () => {
          const pending = appState.runner?.pendingApprovalList() ?? []
          if (pending.length === 0) return '没有待批请求'
          for (const request of pending) {
            await appState.runner
              ?.decideApproval(request.callId, false, '超级 Pilot 抢救')
              .catch(() => undefined)
          }
          return `已拒绝 ${pending.length} 个待批请求`
        },
      },
    ],
  })
  // 注册早于 `registerIpc()`：`createIpcContext().handle` 写的是与主 IPC 表同一份
  // `ipcMain` 处理器，先后顺序无关，但早注册能保证主引擎初始化失败时窗口仍可调。
  registerSuperIpc()
  // 主 store 放在应急通道之后：`load()` 抛错（core.json 损坏、目录不可写）时，
  // 上面的超级 Pilot 已经能打开窗口、看到原因、动手修，而不是整个应用静默退出。
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
      appState.mailNotifier?.handle(event)
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
  appState.reflect = engine.reflect
  // 邮件通知共用反思那份邮箱配置：收件人、SMTP 登录名与发件人都是同一个地址，
  // 「发给自己」。勾选哪些事件发信是独立的「通知配置」。
  appState.mailNotifier = new MailNotifier({
    settings: () => appState.store.settings(),
    // 反思服务持有 SMTP 配置的单一实现：主机为空返回 null，登录名取首个地址。
    smtp: () => appState.reflect?.smtpConfig() ?? null,
    hasPassword: () => Boolean(appState.store.getSmtpPassword()),
    sessionTitle: (sessionId) => appState.store.session(sessionId)?.title ?? '',
    // 标题取用户这一次的指令：会话名说明不了「做完了什么」。
    instruction: (sessionId, runId) =>
      instructionOf(appState.store.session(sessionId)?.messages ?? [], runId),
    english: () => appState.store.uiLocale() === 'en',
    log: (entry) => log(entry),
  })
  appState.feedback = new FeedbackBox(app.getPath('userData'))
  void sandboxStatus()
  appState.updater = new UpdaterService({
    currentVersion: app.getVersion(),
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    onState: broadcastUpdate,
  })
  // 副线队列与主进程健康监测：必须在第一次 `scheduleCheckpointMaintenance()` 之前
  // 装配好，否则维护会退回各自管定时器的旧路径，也看不到「当时谁在占主线程」。
  appState.background = new BackgroundScheduler({
    // 只要有一轮对话在跑，副线就让路：这正是「副线不得影响对话」的执行点。
    isBusy: () => Boolean(appState.store?.anyRunning()),
    log: (entry) => log(entry),
  })
  appState.lagMonitor = new LagMonitor({ log: (entry) => log(entry) })
  appState.lagMonitor.start()
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
      appState.mailNotifier?.handle(event)
      appState.companion?.publish(event)
    },
    startSession: (workspacePath, prompt) => startSelfModifySession(workspacePath, prompt),
  })
  await appState.moduleCheck.load()
  appState.moduleCheck.start()
  // 反思与自检共用同一份代码事实（报告 + 拆分决策）：行数不再单独成为拆分建议，
  // 已决策的文件也不会在反思里被重新提一遍。
  appState.reflect?.useCodeFacts(() =>
    appState.moduleCheck ? codeFactsFromModuleCheck(appState.moduleCheck.summary()) : null,
  )
  // 版本模式靠它判断「这一版反思过没」：没有注入时只能等兜底静默期，
  // 所以必须由宿主（而不是 reflect 自己去 import electron）提供。
  appState.reflect?.useAppVersion(() => app.getVersion())
  // 自主优化闭环：只读采样 + 护栏内开普通会话，与自检/反思共用同一条改动路径。
  appState.supervisor = new SupervisorService({
    userDataDir: app.getPath('userData'),
    // 跨工作区汇总最近运行：只看计数，不带提示词与文件内容。
    sampleRuns: () => {
      const samples: SupervisorRunSample[] = []
      for (const workspace of appState.store.workspaces()) {
        for (const run of appState.store
          .runs(workspace.path)
          .slice(0, SUPERVISOR_RUN_SAMPLE_PER_WORKSPACE)) {
          samples.push({
            id: run.id,
            status: run.status,
            steps: run.steps,
            toolCalls: run.toolCalls,
            toolErrors: run.toolErrors,
            totalTokens: run.totalTokens,
            startedAt: run.startedAt,
          })
        }
      }
      return samples
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, SUPERVISOR_RUN_SAMPLE_LIMIT)
    },
    // 内视：与桌面面板、手机端同一条采样路径。
    sampleHealth: async () => {
      const report = await collectSelfCheck()
      return report.items.map((item) => ({
        id: item.id,
        label: item.title,
        status: item.status,
        ...(item.detail ? { detail: item.detail } : {}),
      }))
    },
    // 源码风险：直接用最近一份自检报告，不重新扫描（扫描代价高且结果同源）。
    sampleModuleRisks: () => {
      const report = appState.moduleCheck.snapshot().lastReport
      return (report?.risks ?? []).map((risk) => ({
        id: risk.id,
        moduleName: risk.moduleName,
        severity: risk.severity,
        title: risk.title,
        recommendation: risk.recommendation,
        evidence: risk.evidence,
        // 依据不能丢：自主优化要靠它判断这条建议是不是凭行数猜的。
        ...(risk.basis ? { basis: risk.basis } : {}),
        manual: risk.manual,
      }))
    },
    // 反思：把最近几份报告拍平成一串发现。这里不触发新的反思——反思有自己的
    // 触发策略与模型开销，闭环只消费现成结论。
    sampleReflections: () => {
      const samples: SupervisorReflectionSample[] = []
      for (const report of appState.store
        .reflectionReports()
        .slice(0, SUPERVISOR_REFLECTION_REPORT_LIMIT)) {
        for (const item of report.findings) {
          samples.push({
            reportId: report.id,
            createdAt: report.createdAt,
            topic: item.topic,
            topicLabel:
              REFLECTION_TOPICS.find((entry) => entry.id === item.topic)?.zh ?? item.topic,
            severity: item.severity,
            observation: item.observation,
            suggestion: item.suggestion,
          })
        }
      }
      return samples
    },
    selfSourceRoot: async () => (await prepareSelfSource(selfSourceOptions())).path,
    startSession: (workspacePath, prompt) => startSelfModifySession(workspacePath, prompt),
    log: (entry) => log(entry),
    emit: (event) => {
      broadcast(event)
      notifyEvent(event)
      appState.mailNotifier?.handle(event)
      appState.companion?.publish(event)
    },
  })
  await appState.supervisor.load()
  appState.supervisor.start()
  const bundledCompanion = join(app.getAppPath(), 'companion')
  const companionDir = existsSync(bundledCompanion)
    ? bundledCompanion
    : join(process.cwd(), 'companion')
  // 「设置 → 网页服务」托管的桌面界面：`vite.web.config.mjs` 的产物，与窗口里
  // 同一份 renderer 源码。没构建过（`pnpm build` 不含这一步）就没有 index.html，
  // 那时不注入目录，`/` 继续是原来的手机面板。
  const desktopWebEntry = join(app.getAppPath(), 'out', 'web')
  const desktopWebDir = existsSync(join(desktopWebEntry, 'index.html'))
    ? desktopWebEntry
    : null
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
        appState.mailNotifier?.handle(event)
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
    // 反思：手机端与桌面共用同一份配置与报告库，SMTP 授权码只写不读。
    // 没配模型密钥时 run 会抛业务错误，请求层只负责把它变成一条通知。
    reflect: appState.reflect
      ? createReflectControls(appState.store, appState.reflect)
      : undefined,
    dataDir: app.getPath('userData'),
    assetsDir: companionDir,
    // 只有存在 `out/web` 才挂浏览器界面；`pilot serve` 用的是同一套路由。
    ...(desktopWebDir ? { desktopDir: desktopWebDir } : {}),
    // 桌面端两个开关共用一个监听：关掉「网页服务」而「手机连接」还开着时端口仍在
    // 服务，只有这道门能让浏览器真的进不来。`pilot serve` 没有这个开关，故不设。
    desktopRequiresServerMode: true,
    // 浏览器里的界面通过 `/bridge` 调与窗口完全相同的那份 IPC 表：
    // `ipc-context` 在注册时留了 handler 副本，这里只是交出调用入口。
    ipc: {
      invoke: (channel, args) => invokeDesktopBridge(channel, args),
    },
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
      appState.mailNotifier?.handle(event)
      broadcast(event)
    },
  })
  await appState.companion.init()
  // 「网页服务」与「手机连接」共用一个实例：任一个开关为真就监听，端口按网页
  // 服务的设置来。真正的 `init()` 在 IPC 注册之后（见 `registerIpc()` 后面），
  // 否则浏览器标签页可能先于处理器就绪接上来。
  appState.companionMode = createCompanionModeControl(appState.companion)
  setRendererSink((channel, payload) => {
    if (appState.companion) bridgeEmit(appState.companion, channel, payload)
  })
  // 客户机用户的数据面：第二套 Store + AgentRunner，写在自己的目录里，只继承本机
  // 的模型通道。它要读盘、建沙箱，不能挡在窗口之前，所以异步装配；装配完成前
  // 客户机请求会拿到「还没有独立空间」的明确拒绝，而不是读到本机会话。
  const clientRoot = join(app.getPath('userData'), 'users', 'client')
  void createGuestEngine({
    source: appState.store,
    dataDir: clientRoot,
    workspaceDir: join(clientRoot, 'workspace'),
    // 客户机用户的事件只能送到客户机用户自己的连接：桌面窗口与本机手机
    // 都不该看到另一个用户的任务内容。
    publish: (event) => appState.companion?.publish(event, 'client'),
    packageRoot: app.isPackaged
      ? join(app.getPath('userData'), 'self-src')
      : app.getAppPath(),
  })
    .then((guest) => {
      appState.guestEngine = guest
      appState.companion?.attachGuest({
        role: 'client',
        store: guest.store,
        runner: guest.runner,
        billing: guest.billing,
        checkpoints: checkpointBridge(guest),
        changes: changesBridge(guest),
      })
    })
    .catch((error: unknown) => {
      log({
        area: 'companion',
        event: 'guest-engine-failed',
        level: 'warn',
        // 字段名不用 `message`：日志层把这种名字当敏感正文写不进去。
        detail: { reason: error instanceof Error ? error.message : String(error) },
      })
    })
  appState.scheduler.start()
  appState.reflect?.start()
  // Capture Git Bash's login environment while the window loads so the first
  // shell command does not pay for /etc/profile and ~/.bashrc.
  warmShellProfile()
  // 进化页要等自身源码解析（若干 git 子进程，Windows 上约 3 s）才能渲染个人分支。
  // 窗口加载时先把它跑起来，用户点进来时通常已经就绪。
  void personalService()
    .then((service) => service.state())
    .catch(() => undefined)
  registerIpc()
  // 端口在这里才真正开启：`/bridge` 背后是上面刚注册的那份 IPC 表。
  await appState.companionMode?.init()
  createTray()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(reportStartupFailure)

/**
 * 真正的退出路径都会先经过这里：托盘菜单直接置位，更新器与系统关机走
 * `app.quit()`，而 `before-quit` 总在窗口 close 事件之前触发。
 */
app.on('before-quit', () => {
  appState.quitting = true
  // 超级 Pilot 自己的引擎与窗口也要收尾：它不在主引擎的夹具里。
  if (appState.superPilot) {
    void appState.superPilot.dispose().catch(() => undefined)
    appState.superPilot = null
  }
  closeSuperWindow()
  appState.lagMonitor?.stop()
  appState.background?.dispose()
  if (appState.checkpointMaintenanceTimer) clearTimeout(appState.checkpointMaintenanceTimer)
  appState.scheduler?.stop()
  appState.checkpoints?.dispose()
  if (appState.runner) void appState.runner.shutdown()
  if (appState.guestEngine) {
    appState.guestEngine.checkpoints.dispose()
    void appState.guestEngine.runner.shutdown()
    void appState.guestEngine.store.flush()
    appState.guestEngine = null
  }
  if (appState.companion) void appState.companion.stop()
  // 插件子进程自己不会随主进程退出（共享宿主一直持有它们）。
  void stopSharedPluginHosts()
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
