import { describe, expect, it } from 'vitest'
import { BackgroundScheduler } from '../src/main/background'

/** 收集日志，确认副线失败只进日志而不是抛给调用方。 */
function collector() {
  const entries: { event: string; level?: string; detail?: Record<string, unknown> }[] = []
  return {
    entries,
    log: (entry: { event: string; level?: string; detail?: Record<string, unknown> }) => {
      entries.push(entry)
    },
  }
}

/** 让已排入的微任务跑完（start() 用 Promise.resolve().then 起跑）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

describe('BackgroundScheduler：副线不得影响对话', () => {
  it('会话进行中让路，空闲后补跑，并记录让路次数', async () => {
    let busy = true
    const timers: (() => void)[] = []
    const { entries, log } = collector()
    const scheduler = new BackgroundScheduler({
      isBusy: () => busy,
      log,
      setTimer: (callback) => {
        timers.push(callback)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
    })
    let ran = 0
    void scheduler.schedule('checkpoint-maintenance', () => {
      ran += 1
    })

    await flush()
    expect(ran).toBe(0)
    expect(scheduler.snapshot()[0]).toMatchObject({ state: 'deferred', deferrals: 1 })

    // 会话结束：下一次重试窗口触发时任务才真正跑。
    busy = false
    expect(timers.length).toBe(1)
    timers.shift()!()
    await flush()
    expect(ran).toBe(1)
    expect(scheduler.snapshot()[0]).toMatchObject({ state: 'done' })
    expect(entries.some((entry) => entry.event === 'job.done')).toBe(true)
  })

  it('同一时刻只跑一个副线任务，第二个排在后面', async () => {
    const order: string[] = []
    let release: (() => void) | null = null
    const scheduler = new BackgroundScheduler({ isBusy: () => false, log: () => undefined })

    void scheduler.schedule('first', async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      order.push('first:end')
    })
    void scheduler.schedule('second', () => {
      order.push('second')
    })

    await flush()
    expect(order).toEqual(['first:start'])
    release!()
    await flush()
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('任务抛错不会传播给调用方，只记 failed', async () => {
    const { entries, log } = collector()
    const scheduler = new BackgroundScheduler({ isBusy: () => false, log })
    const state = await scheduler.schedule('boom', () => {
      throw new Error('maintenance exploded')
    })
    expect(state).toBe('failed')
    const failed = entries.find((entry) => entry.event === 'job.failed')
    expect(failed?.detail?.name).toBe('boom')
    expect(scheduler.snapshot()[0]!.error).toContain('maintenance exploded')
  })

  it('超时释放队列，后面的任务仍能跑', async () => {
    let fire: (() => void) | null = null
    const { entries, log } = collector()
    const scheduler = new BackgroundScheduler({
      isBusy: () => false,
      log,
      setTimer: (callback) => {
        fire = callback
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
    })
    let secondRan = false
    void scheduler.schedule('slow', () => new Promise<void>(() => undefined), { timeoutMs: 1_000 })
    void scheduler.schedule('after', () => {
      secondRan = true
    })
    await flush()
    expect(secondRan).toBe(false)
    fire!()
    await flush()
    expect(entries.some((entry) => entry.event === 'job.timeout')).toBe(true)
    expect(secondRan).toBe(true)
  })

  it('同名任务在排队或执行期间不重复入队', async () => {
    const scheduler = new BackgroundScheduler({ isBusy: () => false, log: () => undefined })
    let runs = 0
    void scheduler.schedule('dup', () => {
      runs += 1
    })
    const second = await scheduler.schedule('dup', () => {
      runs += 1
    })
    await flush()
    expect(second).toBe('skipped')
    expect(runs).toBe(1)
  })

  it('让路超过上限后放弃本次调度，避免长期占着队列', async () => {
    const timers: (() => void)[] = []
    const { entries, log } = collector()
    const scheduler = new BackgroundScheduler({
      isBusy: () => true,
      log,
      setTimer: (callback) => {
        timers.push(callback)
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => undefined,
    })
    const settled = scheduler.schedule('never', () => undefined, { maxDeferrals: 2 })
    await flush()
    timers.shift()!()
    await flush()
    timers.shift()!()
    await flush()
    expect(await settled).toBe('skipped')
    expect(entries.some((entry) => entry.event === 'job.skipped')).toBe(true)
  })
})
