// 主进程健康监测：事件循环延迟 + 副线队列状态。
//
// 一次「所有会话都卡住」的事故里，最有价值的两个数字是：
// 1. 主进程事件循环到底堵了多久（堵住说明是同步 IO / 死循环，不是模型慢）；
// 2. 谁在占用主线程（副线队列里正在跑的任务名）。
// 这两项以前只存在于开发者脑子里的时间线里，现在落成可读采样，供
// 「设置 → 运行日志」与「会话 → 流程」两个入口直接展示。
import type { AppLogLevel } from './app-log'

export interface StallSample {
  at: string
  lagMs: number
}

export interface RuntimeHealthSnapshot {
  startedAt: string
  uptimeMs: number
  /** 最近一次采样的延迟。 */
  lagMs: number
  /** 本次运行里最长的一次延迟。 */
  worstLagMs: number
  /** 判定为主线程被阻塞（超过 stallMs）的次数。 */
  stallCount: number
  /** 最近若干次阻塞采样，新的在前。 */
  stalls: StallSample[]
}

export interface LagMonitorOptions {
  /** 采样间隔，默认 250ms；越小越灵敏，越大越省。 */
  intervalMs?: number
  /** 超过这个漂移才算「堵住」，默认 1500ms。 */
  stallMs?: number
  /** 保留多少条阻塞采样。 */
  keepStalls?: number
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void
  log?: (entry: {
    area: string
    event: string
    level?: AppLogLevel
    detail?: Record<string, unknown>
  }) => void
}

/**
 * 用「定时器应该什么时候触发」和「实际什么时候触发」的差值测量阻塞。
 *
 * 采样漂移 = 实际间隔 − 期望间隔。正常抖动是几毫秒，GC 峰值几十毫秒；
 * 一旦出现秒级，就说明主线程上有同步文件遍历、同步子进程或长循环在跑，
 * 这时对话的每一次 IPC/流式写回都被压在这个循环后面。
 */
export class LagMonitor {
  private readonly intervalMs: number
  private readonly stallMs: number
  private readonly keepStalls: number
  private readonly now: () => number
  private readonly setTimer: NonNullable<LagMonitorOptions['setTimer']>
  private readonly clearTimer: NonNullable<LagMonitorOptions['clearTimer']>
  private readonly log: NonNullable<LagMonitorOptions['log']>
  private readonly stalls: StallSample[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTick = 0
  private worstLagMs = 0
  private stallCount = 0
  private readonly startedAt = Date.now()

  constructor(options: LagMonitorOptions = {}) {
    this.intervalMs = Math.max(20, Math.round(options.intervalMs ?? 250))
    this.stallMs = Math.max(this.intervalMs, Math.round(options.stallMs ?? 1_500))
    this.keepStalls = Math.max(1, Math.round(options.keepStalls ?? 20))
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((callback, ms) => setInterval(callback, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer))
    this.log = options.log ?? (() => undefined)
  }

  start(): void {
    if (this.timer) return
    this.lastTick = this.now()
    this.timer = this.setTimer(() => this.tick(this.now()), this.intervalMs)
    const maybeUnref = this.timer as unknown as { unref?: () => void }
    maybeUnref.unref?.()
  }

  stop(): void {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
  }

  /** 采样一次。抽成方法是为了让测试能直接喂时间点，不用等真实定时器。 */
  tick(nowMs: number): number {
    const expected = this.lastTick + this.intervalMs
    const lag = Math.max(0, nowMs - expected)
    this.lastTick = nowMs
    if (lag > this.worstLagMs) this.worstLagMs = lag
    if (lag < this.stallMs) return lag
    this.stallCount += 1
    this.stalls.unshift({ at: new Date(nowMs).toISOString(), lagMs: lag })
    if (this.stalls.length > this.keepStalls) this.stalls.length = this.keepStalls
    this.log({
      area: 'runtime',
      event: 'event-loop-stall',
      level: lag >= this.stallMs * 4 ? 'error' : 'warn',
      detail: { lagMs: lag, intervalMs: this.intervalMs },
    })
    return lag
  }

  snapshot(): RuntimeHealthSnapshot {
    const nowMs = this.now()
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Math.max(0, nowMs - this.startedAt),
      lagMs: Math.max(0, nowMs - (this.lastTick + this.intervalMs)),
      worstLagMs: this.worstLagMs,
      stallCount: this.stallCount,
      stalls: [...this.stalls],
    }
  }
}
