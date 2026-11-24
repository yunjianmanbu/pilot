import type { RunEvent } from '../shared/types'
import type { AgentRunner } from './agent/runner'
import { localizeMain } from './localize'
import type { Store } from './store'

const TICK_MS = 15_000

/**
 * Polls persisted scheduled tasks and feeds due ones through the normal agent
 * runner. Scheduled work gets exactly the same workspace jail, approval policy
 * and tool limits as a task the user typed by hand.
 */
export class AgentScheduler {
  private timer: NodeJS.Timeout | null = null
  private ticking = false

  constructor(
    private readonly store: Store,
    private readonly runner: AgentRunner,
    private readonly emit: (event: RunEvent) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const due = this.store.dueScheduledTasks()
      for (const task of due) {
        const session = this.store.session(task.sessionId)
        if (!session) {
          await this.store.removeScheduledTask(task.sessionId, task.id)
          continue
        }
        try {
          const result = await this.runner.sendMessage(task.sessionId, task.content, 'queue')
          await this.store.completeScheduledRun(task.id, 'queued')
          this.emit({ type: 'scheduled.changed', sessionId: task.sessionId })
          const english = this.store.uiLocale() === 'en'
          const preview = task.content.slice(0, 60)
          this.emit({
            type: 'notice',
            level: 'info',
            topic: 'schedule',
            message: result.queued
              ? english
                ? `Scheduled task queued: ${preview}`
                : `定时任务已加入队列：${preview}`
              : english
                ? `Scheduled task started: ${preview}`
                : `定时任务已开始执行：${preview}`,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.completeScheduledRun(task.id, 'failed', message)
          this.emit({ type: 'scheduled.changed', sessionId: task.sessionId })
          const english = this.store.uiLocale() === 'en'
          this.emit({
            type: 'notice',
            level: 'warn',
            topic: 'schedule',
            message: english
              ? `Scheduled task failed: ${localizeMain(message, 'en')}`
              : `定时任务执行失败：${message}`,
          })
        }
      }
    } finally {
      this.ticking = false
    }
  }
}
