// 检查点维护：空闲时的清理排程与运行结束回调。
import { appState } from './app-state'
import { runSettledEntry } from './app-audit'
import { log } from './diagnostics'
import { Store } from './store'
import { app, session } from 'electron'

/**
 * 会话跑完一轮后：
 * - 自改会话自动重跑一次自检，把提案刷新到最新（只读重扫，不触发新的改动）；
 * - 其它会话只落一条日志，绝不自动改代码。
 *
 * 用户主动取消的会话不做刷新：改动可能只写了一半，重扫出来的提案会误导人，
 * 让他们以为那些问题跟自己刚打断的任务无关。
 */
export function onRunSettled(sessionId: string, status: string, runId?: string): void {
  // Store 里的运行记录比事件本身全：步数、用量、模型、工具失败数、耗时都在里面。
  const workspacePath = appState.store ? appState.store.session(sessionId)?.workspacePath : undefined
  const run =
    workspacePath && runId ? appState.store.run(workspacePath, runId) : undefined
  log(runSettledEntry({ sessionId, status, run }))
  if (status === 'cancelled') return
  void appState.moduleCheck?.noteRunSettled(sessionId).catch(() => undefined)
}

/**
 * Snapshot maintenance is a full scan of the checkpoint store only when the
 * persisted estimate is over budget or a periodic audit is due. It still waits
 * until the app is idle so a rare cleanup does not land in the middle of the
 * first model round trip, and retries after a run finishes.
 */
export function scheduleCheckpointMaintenance(delayMs = 5_000): void {
  if (appState.checkpointMaintenanceTimer) clearTimeout(appState.checkpointMaintenanceTimer)
  appState.checkpointMaintenanceTimer = setTimeout(() => {
    appState.checkpointMaintenanceTimer = null
    const service = appState.checkpoints
    if (!service) return
    if (appState.store.anyRunning()) {      // A run is in flight; try again once it is done.
      appState.pendingCheckpointMaintenance = true
      return
    }
    appState.pendingCheckpointMaintenance = false
    void service
      .maintain({ maxBytes: appState.store.settings().checkpointMaxBytes })
      .catch(() => undefined)
  }, delayMs)
  appState.checkpointMaintenanceTimer.unref?.()
}

export function onRunFinished(): void {
  if (appState.pendingCheckpointMaintenance) scheduleCheckpointMaintenance(0)
}
