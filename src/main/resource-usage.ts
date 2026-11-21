/**
 * Live machine load for the top-bar meters: CPU busy share, memory in use and
 * the workspace volume's fill level.
 *
 * Node gives no instantaneous CPU figure — `os.cpus()` returns cumulative tick
 * counts per core — so a reading is the difference between two samples taken
 * `CPU_SAMPLE_MS` apart. That is a real measurement of the whole machine
 * (unlike `process.cpuUsage()`, which only sees this process) and needs no
 * native module. Concurrent callers share one in-flight sample, and a reading
 * that makes no progress counts as unknown rather than 0%.
 */
import { cpus, freemem, totalmem } from 'node:os'
import type { ResourceUsage } from '../shared/types'
import { diskSpace } from './system-info'

/** Long enough for the tick counters to move, short enough to keep the UI live. */
const CPU_SAMPLE_MS = 120

interface CpuTicks {
  idle: number
  total: number
}

function readTicks(): CpuTicks {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const times = cpu.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function measureCpuPercent(): Promise<number | null> {
  const before = readTicks()
  await delay(CPU_SAMPLE_MS)
  const after = readTicks()
  const total = after.total - before.total
  const idle = after.idle - before.idle
  // A machine that reported nothing between the samples gives no percentage;
  // 0% would read as "perfectly idle", which is a different claim.
  if (total <= 0 || idle < 0) return null
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100))
}

let inFlight: Promise<number | null> | null = null

/** One shared CPU reading per moment: two mounted meters must not double-sample. */
function cpuPercent(): Promise<number | null> {
  if (inFlight) return inFlight
  const running = measureCpuPercent()
  inFlight = running
  const clear = (): void => {
    if (inFlight === running) inFlight = null
  }
  running.then(clear, clear)
  return running
}

/**
 * Current load snapshot. `diskRoot` selects the volume to report on; it is
 * measured by the existing `diskSpace`, so an exotic mount still degrades to
 * null numbers instead of throwing.
 */
export async function resourceUsage(diskRoot?: string): Promise<ResourceUsage> {
  const target = diskRoot?.trim() || process.cwd()
  const [cpu, disk] = await Promise.all([cpuPercent(), diskSpace(target)])
  const totalMemory = totalmem()
  const freeMemory = freemem()
  const knownMemory = Number.isFinite(totalMemory) && totalMemory > 0
  const diskKnown =
    disk.freeBytes !== null && disk.totalBytes !== null && disk.totalBytes > 0
  return {
    cpuPercent: cpu,
    memoryUsedBytes: knownMemory ? Math.max(0, totalMemory - freeMemory) : null,
    memoryTotalBytes: knownMemory ? totalMemory : null,
    diskUsedBytes: diskKnown ? Math.max(0, (disk.totalBytes as number) - (disk.freeBytes as number)) : null,
    diskTotalBytes: diskKnown ? disk.totalBytes : null,
    measuredAt: new Date().toISOString(),
  }
}