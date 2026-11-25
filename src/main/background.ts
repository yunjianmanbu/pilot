// 副线任务调度：把维护、扫描、索引、同步这类「不直接服务当前这一轮对话」的工作
// 收进一个单并发队列，并在会话进行中让路。
//
// 为什么需要它：智能体对话的关键路径上，用户等的是「模型开始回答」。任何一次
// 副线工作（回退点维护、模块自检重扫、索引重建）只要和它抢磁盘、抢串行门或
// 抢主线程，用户感受到的就是「卡住」。所以副线必须满足三条硬约束：
// 1. 同一时刻只跑一个副线任务（maxConcurrent 默认 1），不和对话抢 IO；
// 2. 有会话在跑（`isBusy()` 为真）时排队让路，等空闲窗口再跑；
// 3. 任何失败、超时都不许抛给调用方，只写日志——副线坏掉不能反过来影响对话。
//
// 这里的队列是「尽力而为」的：任务本身不可抢占（JS 没有线程可剥夺），所以
// 真正长任务仍应把「可中断点」做在任务内部（例如回退点维护的 givesWay）。
// 本模块保证的是调度层面的隔离与可观测性。
import { appState, writeAppLog } from './app-state'
import type { AppLogLevel } from './app-log'

export type BackgroundJobState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'deferred'
  | 'skipped'

export interface BackgroundJobSnapshot {
  name: string
  state: BackgroundJobState
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  /** 因为会话在跑而让路的次数。 */
  deferrals: number
  error?: string
}

export interface BackgroundOptions {
  /** 需要对话空闲才跑；默认 true。 */
  whenIdle?: boolean
  /** 排进队列后等多久再跑，默认 0（立刻）。等待期间同样受 whenIdle 约束。 */
  delayMs?: number
  /** 任务最长执行时间。超时只记日志并释放队列，不打断已成事实的任务，默认 5 分钟。 */
  timeoutMs?: number
  /** 让路后重试的间隔，默认 20 秒。 */
  retryDelayMs?: number
  /** 最多让路多少次，超过就放弃这次调度（下次触发再排），默认 30。 */
  maxDeferrals?: number
  /** 同名任务已在排队或执行时跳过，默认 true。 */
  dedupe?: boolean
}

export interface BackgroundSchedulerOptions {
  /** 是否有一轮对话正在进行。默认永远空闲，便于测试与 CLI 场景。 */
  isBusy?: () => boolean
  now?: () => number
  log?: (entry: {
    area: string
    event: string
    level?: AppLogLevel
    detail?: Record<string, unknown>
  }) => void
  /** 同时最多跑几个副线任务，默认 1。 */
  maxConcurrent?: number
  /** 定时器注入，测试里可换成立即触发。 */
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_RETRY_MS = 20_000
const DEFAULT_MAX_DEFERRALS = 30
const KEEP_RECORDS = 20

export interface QueuedJob {
  name: string
  task: () => Promise<unknown> | unknown
  options: Required<BackgroundOptions>
  queuedAt: number
  deferrals: number
  /** 任务落定时兑现，永不会 reject：调用方可以链 `finally`，但不必处理错误。 */
  settle: (state: BackgroundJobState) => void
}

export class BackgroundScheduler {
  private readonly queue: QueuedJob[] = []
  private readonly records = new Map<string, BackgroundJobSnapshot>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private running = 0
  private disposed = false
  private readonly log: NonNullable<BackgroundSchedulerOptions['log']>
  private readonly now: () => number
  private readonly isBusy: () => boolean
  private readonly maxConcurrent: number
  private readonly setTimer: NonNullable<BackgroundSchedulerOptions['setTimer']>
  private readonly clearTimer: NonNullable<BackgroundSchedulerOptions['clearTimer']>

  constructor(options: BackgroundSchedulerOptions = {}) {
    this.log = options.log ?? ((entry) => writeAppLog(entry))
    this.now = options.now ?? (() => Date.now())
    this.isBusy = options.isBusy ?? (() => false)
    this.maxConcurrent = Math.max(1, Math.round(options.maxConcurrent ?? 1))
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /**
   * 排一个副线任务。返回的 promise 永不会 reject，只在任务落定时兑现；
   * 需要在任务结束后接着做什么（例如重设定时器）就链 `finally`。
   */
  schedule(
    name: string,
    task: () => Promise<unknown> | unknown,
    options: BackgroundOptions = {},
  ): Promise<BackgroundJobState> {
    if (this.disposed) return Promise.resolve('skipped')
    const opts = {
      whenIdle: options.whenIdle ?? true,
      delayMs: Math.max(0, options.delayMs ?? 0),
      timeoutMs: Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      retryDelayMs: Math.max(500, options.retryDelayMs ?? DEFAULT_RETRY_MS),
      maxDeferrals: Math.max(0, options.maxDeferrals ?? DEFAULT_MAX_DEFERRALS),
      dedupe: options.dedupe ?? true,
    }
    const pending = this.record(name)?.state
    if (
      opts.dedupe &&
      (this.queue.some((job) => job.name === name) ||
        pending === 'running' ||
        pending === 'queued' ||
        pending === 'deferred')
    ) {
      return Promise.resolve('skipped')
    }
    let settle!: (state: BackgroundJobState) => void
    const settled = new Promise<BackgroundJobState>((resolve) => {
      settle = resolve
    })
    this.putRecord(name, {
      name,
      state: 'queued',
      queuedAt: new Date(this.now()).toISOString(),
      deferrals: 0,
    })
    const enqueue = (): void => {
      if (this.disposed) {
        settle('skipped')
        return
      }
      this.queue.push({ name, task, options: opts, queuedAt: this.now(), deferrals: 0, settle })
      this.pump()
    }
    if (opts.delayMs > 0) this.armTimer(opts.delayMs, enqueue)
    else enqueue()
    return settled
  }

  /** 只读快照：面板与日志用它说明「副线现在在干什么」。 */
  snapshot(): BackgroundJobSnapshot[] {
    return [...this.records.values()]
  }

  /** 是否有副线任务在排队或执行。 */
  busy(): boolean {
    return this.running > 0 || this.queue.length > 0
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.queue) job.settle('skipped')
    this.queue.length = 0
    for (const timer of this.timers) this.clearTimer(timer)
    this.timers.clear()
  }

  private record(name: string): BackgroundJobSnapshot | undefined {
    return this.records.get(name)
  }

  private putRecord(name: string, next: BackgroundJobSnapshot): void {
    // 只保留最近若干条，避免长期运行时无限增长。
    if (!this.records.has(name) && this.records.size >= KEEP_RECORDS) {
      const oldest = [...this.records.entries()].sort((a, b) =>
        a[1].queuedAt.localeCompare(b[1].queuedAt),
      )[0]
      if (oldest) this.records.delete(oldest[0])
    }
    this.records.set(name, next)
  }

  private patchRecord(name: string, patch: Partial<BackgroundJobSnapshot>): void {
    const current = this.records.get(name)
    if (!current) return
    this.records.set(name, { ...current, ...patch })
  }

  private pump(): void {
    if (this.disposed) return
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!
      // 会话在跑：把它放回去并约一个重试窗口，让对话先走。
      if (job.options.whenIdle && this.isBusy()) {
        job.deferrals += 1
        if (job.deferrals > job.options.maxDeferrals) {
          this.patchRecord(job.name, {
            state: 'skipped',
            finishedAt: new Date(this.now()).toISOString(),
            deferrals: job.deferrals,
          })
          this.log({
            area: 'background',
            event: 'job.skipped',
            level: 'warn',
            detail: { name: job.name, deferrals: job.deferrals },
          })
          job.settle('skipped')
          continue
        }
        this.queue.push(job)
        this.patchRecord(job.name, { state: 'deferred', deferrals: job.deferrals })
        this.armTimer(job.options.retryDelayMs, () => this.pump())
        return
      }
      this.start(job)
    }
  }

  private start(job: QueuedJob): void {
    this.running += 1
    const startedAt = this.now()
    this.patchRecord(job.name, {
      state: 'running',
      startedAt: new Date(startedAt).toISOString(),
      deferrals: job.deferrals,
    })
    let settled = false
    const timeout = this.armTimer(job.options.timeoutMs, () => {
      if (settled) return
      settled = true
      // 任务不可抢占：超时只是「不再等它」，队列继续服务后面的副线任务。
      this.running = Math.max(0, this.running - 1)
      this.patchRecord(job.name, {
        state: 'timeout',
        finishedAt: new Date(this.now()).toISOString(),
        durationMs: job.options.timeoutMs,
      })
      this.log({
        area: 'background',
        event: 'job.timeout',
        level: 'warn',
        detail: { name: job.name, timeoutMs: job.options.timeoutMs },
      })
      job.settle('timeout')
      this.pump()
    })
    const finish = (state: 'done' | 'failed', error?: unknown): void => {
      if (settled) return
      settled = true
      this.clearTimer(timeout)
      this.running = Math.max(0, this.running - 1)
      const finishedAt = this.now()
      const durationMs = finishedAt - startedAt
      this.patchRecord(job.name, {
        state,
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs,
        ...(error === undefined
          ? {}
          : { error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }),
      })
      this.log({
        area: 'background',
        event: state === 'done' ? 'job.done' : 'job.failed',
        ...(state === 'done' ? {} : { level: 'warn' as const }),
        detail: { name: job.name, durationMs },
      })
      job.settle(state)
      this.pump()
    }
    void Promise.resolve()
      .then(() => job.task())
      .then(
        () => finish('done'),
        (error: unknown) => finish('failed', error),
      )
  }

  private armTimer(ms: number, callback: () => void): ReturnType<typeof setTimeout> {
    const timer = this.setTimer(() => {
      this.timers.delete(timer)
      if (this.disposed) return
      callback()
    }, ms)
    // 定时器不该单独维持进程存活（Electron 主进程退出时才不会拖尾）。
    const maybeUnref = timer as unknown as { unref?: () => void }
    maybeUnref.unref?.()
    this.timers.add(timer)
    return timer
  }
}

/**
 * 便捷入口：把任务交给进程内副线队列；没有队列（CLI / 测试）时直接就地跑。
 * 返回值永不会 reject，失败只进日志。
 */
export function runInBackground(
  name: string,
  task: () => Promise<unknown> | unknown,
  options: BackgroundOptions = {},
): Promise<BackgroundJobState> {
  const scheduler = appState.background
  if (!scheduler) {
    void Promise.resolve()
      .then(() => task())
      .catch((error: unknown) =>
        writeAppLog({
          area: 'background',
          event: 'job.failed',
          level: 'warn',
          detail: {
            name,
            message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          },
        }),
      )
    return Promise.resolve('done')
  }
  return scheduler.schedule(name, task, options)
}
