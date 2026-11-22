// 日志、审计与内视：崩溃记录、审批审计、基准对比与自检采样。
import { appState } from './app-state'
import type { ProfileBenchmarkRow, RunEvent } from '../shared/types'
import { loadMcpConfig } from './agent/mcp'
import type { BenchmarkRun } from './agent/profile-benchmark'
import { DynamicToolRegistry } from './agent/toolsmith'
import { approvalAuditEntry, crashEntry, toolAuditEntry, toolFailureEntry } from './app-audit'
import type { AppLogEntry } from './app-log'
import { onRunFinished, onRunSettled } from './checkpoint-maintenance'
import { pluginOverview } from './plugins/studio'
import { sandboxStatus } from './sandbox'
import { runSelfCheck } from './self-check'
import { systemInfo } from './system-info'
import { safeUrl } from './window-platform'
import { resolveExisting } from './workspace'
import { app, BrowserWindow, dialog } from 'electron'

const EARLY_LOG_LIMIT = 50

/** 审批事件本身不带风险等级：`tool.call` 时记一笔，审批落定时取出并删除。 */
const callRisks = new Map<string, 'read' | 'write' | 'exec' | 'control'>()

const CALL_RISK_LIMIT = 200

/** 写一条应用日志：日志就绪前排队，永不抛错。 */
export function log(entry: AppLogEntry): void {
  if (!appState.appLog) {
    if (appState.earlyLogs.length < EARLY_LOG_LIMIT) appState.earlyLogs.push(entry)
    return
  }
  appState.appLog.write(entry)
}

/**
 * 崩溃捕获：主进程未捕获异常、未处理的 Promise 拒绝、渲染进程与子进程消失。
 *
 * 主进程异常只记一条然后**保持运行**：它们多数来自单个 IPC 调用或某个工具，
 * 直接退出会丢掉用户未保存的状态；重复失败会在日志里累积，下次启动能查到。
 * 渲染进程正常退出（`clean-exit`）不记，否则每次关窗都是一条 error。
 */
export function installCrashLogging(): void {
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

export function broadcast(event: RunEvent): void {
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

/** 解析一个已存在的工作区目录，再建工具注册表；路径越界会被 `resolveExisting` 拒。 */
export async function toolRegistryFor(path: string): Promise<DynamicToolRegistry> {
  await resolveExisting(path, '.')
  const settings = appState.store.settings()
  return new DynamicToolRegistry({
    workspacePath: path,
    userDataDir: app.getPath('userData'),
    testTargets: settings.testTargets,
    testCaptchaMode: settings.testCaptchaMode,
    testCaptcha: appState.store.getTestCaptcha(),
  })
}

/**
 * 内视：只读 Pilot 自己的服务实例，不接受工作区路径参数。
 * 工作区相关模块（自写工具、MCP、插件）只读当前打开的那一个；
 * 没打开就报“未启用”，不去猜路径。
 *
 * 桌面 IPC 与手机（companion）都调这一份，避免两端采样出不同结果。
 */
export async function collectSelfCheck() {
  const workspace = appState.store.activeWorkspace()
  await appState.moduleCheck.load().catch(() => undefined)
  const report = await runSelfCheck({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    userDataPath: app.getPath('userData'),
    currentWorkspace: workspace,
    settings: () => appState.store.settingsView(),
    workspaces: () => appState.store.workspaces(),
    modelResources: () => appState.store.modelResources(),
    scheduled: () => appState.store.allScheduledTasks(),
    moduleCheck: () => appState.moduleCheck.snapshot(),
    sandbox: sandboxStatus,
    update: () => appState.updater.stateSnapshot(),
    systemInfo: () => systemInfo(app.getPath('userData')),
    feedback: appState.feedback,
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

  /** One row per task for the benchmark dialog; the raw samples stay internal. */
  export const benchmarkRows = (samples: BenchmarkRun['samples']): ProfileBenchmarkRow[] => {
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
