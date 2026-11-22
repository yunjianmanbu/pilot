// 主进程运行时状态：都是 whenReady 前后才赋值的单例引用，入口文件只做装配。
// 单独成模块后，窗口 / 托盘 / 个人分支等逻辑模块可以读写同一份状态，不再需要把
// 所有代码挤在 index.ts 里。类型与初值与原入口文件中的 let 声明保持一致。
import { createAppLog } from './app-log'
import type { AgentRunner } from './agent/runner'
import type { AppLogEntry } from './app-log'
import type { BillingService } from './billing'
import type { CheckpointService } from './checkpoints'
import type { CompanionServer } from './companion/server'
import type { FeedbackBox } from './feedback'
import type { ModuleCheckService } from './module-check'
import type { PersonalEvolutionService } from './personal'
import type { AgentScheduler } from './scheduler'
import type { resolveSelfSource } from './self-source-git'
import type { Store } from './store'
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
  scheduler: null as AgentScheduler | null,
  moduleCheck: undefined as unknown as ModuleCheckService,
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
