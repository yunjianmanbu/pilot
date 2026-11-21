import { describe, expect, it } from 'vitest'
import {
  USAGE_ALERT_PERCENT,
  USAGE_WARN_PERCENT,
  usageLevel,
  usagePercent,
} from '../src/shared/system-info'
import { resourceUsage } from '../src/main/resource-usage'

describe('usagePercent', () => {
  it('returns the used share clamped to 0..100', () => {
    expect(usagePercent(50, 200)).toBe(25)
    expect(usagePercent(0, 100)).toBe(0)
    expect(usagePercent(100, 100)).toBe(100)
    // 统计口径异常（已用大于总量）时不能画出超过满格的条。
    expect(usagePercent(200, 100)).toBe(100)
  })

  it('reports unknown instead of a fake number', () => {
    expect(usagePercent(null, 100)).toBeNull()
    expect(usagePercent(50, null)).toBeNull()
    expect(usagePercent(50, 0)).toBeNull()
    expect(usagePercent(-1, 100)).toBeNull()
    expect(usagePercent(Number.NaN, 100)).toBeNull()
    expect(usagePercent(50, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('usageLevel', () => {
  it('bands usage at the two headroom thresholds', () => {
    expect(usageLevel(0)).toBe('ok')
    expect(usageLevel(USAGE_WARN_PERCENT - 0.5)).toBe('ok')
    expect(usageLevel(USAGE_WARN_PERCENT)).toBe('warn')
    expect(usageLevel(USAGE_ALERT_PERCENT - 0.5)).toBe('warn')
    expect(usageLevel(USAGE_ALERT_PERCENT)).toBe('alert')
    expect(usageLevel(100)).toBe('alert')
  })

  it('keeps an unreadable sample neutral so the bar does not turn red', () => {
    expect(usageLevel(null)).toBe('ok')
    expect(usageLevel(Number.NaN)).toBe('ok')
  })
})

describe('resourceUsage', () => {
  it('measures CPU, memory and the workspace volume', async () => {
    const usage = await resourceUsage(process.cwd())
    expect(usage.cpuPercent === null || (usage.cpuPercent >= 0 && usage.cpuPercent <= 100)).toBe(
      true,
    )
    expect(usage.memoryTotalBytes).toBeGreaterThan(0)
    expect(usage.memoryUsedBytes).toBeGreaterThanOrEqual(0)
    expect(usage.memoryUsedBytes).toBeLessThanOrEqual(usage.memoryTotalBytes as number)
    expect(usage.diskTotalBytes).toBeGreaterThan(0)
    expect(usage.diskUsedBytes).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(usage.measuredAt))).toBe(false)
  })

  it('shares one CPU sample between concurrent callers', async () => {
    const [first, second] = await Promise.all([resourceUsage(), resourceUsage()])
    // 并发调用复用同一次采样，所以 CPU 读数必然一致。
    expect(first.cpuPercent).toBe(second.cpuPercent)
  })

  it('degrades to null disk numbers on a missing volume', async () => {
    const usage = await resourceUsage('Z:\\pilot-no-such-volume\\nope')
    expect(usage.diskUsedBytes).toBeNull()
    expect(usage.diskTotalBytes).toBeNull()
  })
})