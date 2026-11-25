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
  // 自检重扫是副线：它要遍历整个工作区，绝不能占住刚刚结束这一轮所需的收尾工作。
  // 交给副线队列后，会话空闲时才跑；同一会话连续结束两次只排一次。
  const moduleCheck = appState.moduleCheck
  const background = appState.background
  if (!moduleCheck) return
  if (background) {
    background.schedule(
      `module-check:${sessionId}`,
      () => moduleCheck.noteRunSettled(sessionId),
      { whenIdle: true, delayMs: 1_000, timeoutMs: 5 * 60_000 },
    )
    return
  }
  void moduleCheck.noteRunSettled(sessionId).catch(() => undefined)
}

/**
 * Snapshot maintenance is a full scan of the checkpoint store only when the
 * persisted estimate is over budget or a periodic audit is due. It still waits
 * until the app is idle so a rare cleanup does not land in the middle of the
 * first model round trip, and retries after a run finishes.
 *
 * 走副线队列（单并发 + 会话让路）而不是自己管定时器：调度、重试、超时与
 * 「谁在占主线程」的记录都收在一处，设置里的运行日志才能答出「当时在跑什么」。
 */
export function scheduleCheckpointMaintenance(delayMs = 5_000): void {
  const service = appState.checkpoints
  const scheduler = appState.background
  if (!service || !scheduler) return
  // 已有同名任务在队列里或正在跑：不动标记，交给它自己收尾（背景队列本身会去重）。
  const current = scheduler
    .snapshot()
    .find((job) => job.name === 'checkpoint-maintenance')?.state
  if (current === 'queued' || current === 'deferred' || current === 'running') return
  appState.pendingCheckpointMaintenance = false
  void scheduler
    .schedule(
      'checkpoint-maintenance',
      () => service.maintain({ maxBytes: appState.store.settings().checkpointMaxBytes }),
      { whenIdle: true, delayMs, timeoutMs: 10 * 60_000, retryDelayMs: 30_000 },
    )
    .then((result) => {
      // 让路次数用完、超时或失败都意味着这一次维护「没做成」：把标记留给下一次
      // 运行结束补排（掉线式维护比抢主线程更安全），否则磁盘只会在下次重启前一直涨。
      if (result === 'skipped' || result === 'timeout' || result === 'failed') {
        appState.pendingCheckpointMaintenance = true
      }
    })
    .catch(() => undefined)
}

export function onRunFinished(): void {
  // 有事的那一轮刚结束：把让路期间没做成的维护补上（队列自己再判一次空闲）。
  // 不用 0 延迟：用户点「继续」时下一轮几乎立刻开始，立刻起跑就会和它抢主线程。
  if (appState.pendingCheckpointMaintenance) scheduleCheckpointMaintenance(2_000)
}
