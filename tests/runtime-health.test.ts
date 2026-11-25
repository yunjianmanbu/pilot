import { describe, expect, it } from 'vitest'
import { LagMonitor } from '../src/main/runtime-health'

describe('LagMonitor：区分「模型慢」与「主进程被堵住」', () => {
  it('正常抖动不计为阻塞', () => {
    const monitor = new LagMonitor({ intervalMs: 250, stallMs: 1_500, log: () => undefined })
    monitor.tick(250)
    monitor.tick(500)
    monitor.tick(1_010) // 漂移 260ms，仍在阈值内
    const snapshot = monitor.snapshot()
    expect(snapshot.stallCount).toBe(0)
    expect(snapshot.worstLagMs).toBe(260)
  })

  it('秒级漂移记为一次阻塞并写日志', () => {
    const entries: { event: string; level?: string }[] = []
    const monitor = new LagMonitor({
      intervalMs: 250,
      stallMs: 1_500,
      log: (entry) => entries.push(entry),
    })
    monitor.tick(250)
    monitor.tick(5_000) // 漂移 4500ms
    const snapshot = monitor.snapshot()
    expect(snapshot.stallCount).toBe(1)
    expect(snapshot.stalls[0]!.lagMs).toBe(4_500)
    expect(entries[0]).toMatchObject({ event: 'event-loop-stall', level: 'warn' })
  })

  it('超过四倍阈值升级为 error，方便在运行日志里一眼挑出来', () => {
    const entries: { event: string; level?: string }[] = []
    const monitor = new LagMonitor({
      intervalMs: 250,
      stallMs: 1_000,
      log: (entry) => entries.push(entry),
    })
    monitor.tick(250)
    monitor.tick(20_000)
    expect(entries[0]!.level).toBe('error')
  })

  it('阻塞采样只保留最近 N 条，长期运行不会无限增长', () => {
    const monitor = new LagMonitor({ intervalMs: 100, stallMs: 200, keepStalls: 3, log: () => undefined })
    let now = 0
    for (let i = 0; i < 10; i += 1) {
      now += 1_000
      monitor.tick(now)
    }
    expect(monitor.snapshot().stalls.length).toBe(3)
  })
})
