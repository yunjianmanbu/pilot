// 主进程运行时状态：都是 whenReady 前后才赋值的单例引用，入口文件只做装配。
// 单独成模块后，窗口 / 托盘 / 个人分支等逻辑模块可以读写同一份状态，不再需要把
// 所有代码挤在 index.ts 里。类型与初值与原入口文件中的 let 声明保持一致。
import { createAppLog } from './app-log'
import type { AgentRunner } from './agent/runner'
import type { AppLogEntry } from './app-log'

const EARLY_LOG_LIMIT = 50
import type { BillingService } from './billing'
import type { CheckpointService } from './checkpoints'
import type { CompanionServer } from './companion/server'
import type { CompanionModeControl } from './companion/mode-control'
import type { CompanionStatus } from '../shared/types'
import type { Engine } from '../core/engine'
import type { FeedbackBox } from './feedback'
import type { ModuleCheckService } from './module-check'
import type { MailNotifier } from './notify/mail-notify'
import type { PersonalEvolutionService } from './personal'
import type { AgentScheduler } from './scheduler'
import type { ReflectService } from './reflect/service'
import type { resolveSelfSource } from './self-source-git'
import type { Store } from './store'
import type { SupervisorService } from './supervisor'
import type { UpdaterService } from './updater'
import type { BrowserWindow, Tray } from 'electron'

export const appState = {
  mainWindow: null as BrowserWindow | null,
  tray: null as Tray | null,
  quitting: false,
  trayHintShown: false,
  store: undefined as unknown as Store,
  runner: undefined as unknown as AgentRunner,
  checkpoints: undefined as unknown as CheckpointService,
  feedback: undefined as unknown as FeedbackBox,
  updater: undefined as unknown as UpdaterService,
  companion: null as CompanionServer | null,
  /**
   * 桌面端「网页服务」开关的协调器：手机连接的 `enabled` 与设置里的
   * `serverMode` 共用同一个 CompanionServer，由它统一决定启停与监听选项。
   * `pilot serve` 的 CLI 不装这个对象，仍走 `setEnabled()` 的老语义。
   */
  companionMode: null as CompanionModeControl | null,
  /** 客户机用户的数据面；装配完成前为 null，客户机请求会被明确拒绝。 */
  guestEngine: null as Engine | null,
  scheduler: null as AgentScheduler | null,
  reflect: null as ReflectService | null,
  /** 邮件通知：把运行事件翻成一封「发给自己」的信；设置里的邮箱与事件开关都读同一份 store。 */
  mailNotifier: null as MailNotifier | null,
  moduleCheck: undefined as unknown as ModuleCheckService,
  /** 自主优化闭环：定时分析自检/运行信号，在护栏内自己开一轮会话。 */
  supervisor: undefined as unknown as SupervisorService,
  appLog: undefined as unknown as ReturnType<typeof createAppLog>,
  earlyLogs: [] as AppLogEntry[],
  billing: undefined as unknown as BillingService,
  checkpointMaintenanceTimer: null as NodeJS.Timeout | null,
  pendingCheckpointMaintenance: false,
  personalResolve: null as {
  key: string
  at: number
  promise: Promise<PersonalEvolutionService>
} | null,
  selfSourceResolve: null as {
  key: string
  at: number
  promise: ReturnType<typeof resolveSelfSource>
} | null,
}

/**
 * 写一条应用日志：日志就绪前排队，永不抛错。
 *
 * 放在这里是因为它只依赖 `appState`，而 `diagnostics.ts` 会把 Electron、插件宿主、
 * 自检等一堆模块拖进导入图；运行器只需要写日志，不该为此依赖它们。
 */
export function writeAppLog(entry: AppLogEntry): void {
  if (!appState.appLog) {
    if (appState.earlyLogs.length < EARLY_LOG_LIMIT) appState.earlyLogs.push(entry)
    return
  }
  appState.appLog.write(entry)
}
