/**
 * Host environment facts used by the diagnostics panel, feedback reports and
 * the disk-space pre-check that runs before shell commands.
 *
 * Everything comes from Node's own `os` / `fs` APIs: no native module, no WMI
 * query, no extra dependency. Only fields that change how a command behaves are
 * collected — deliberately no host name, user name, MAC address, IP or serial
 * number, because those identify the machine without helping to diagnose it.
 */
import { statfs } from 'node:fs/promises'
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os'
import type { DiskSpace, SystemInfo } from '../shared/types'
import type { FeedbackEnvField, FeedbackEnvLine } from '../shared/feedback'
import { DISK_LOW_BYTES, formatBytes } from '../shared/system-info'

/** Static facts are read once per process: they cannot change while it runs. */
const staticFacts: Pick<
  SystemInfo,
  'platform' | 'osRelease' | 'arch' | 'cpuCount' | 'cpuModel' | 'memoryTotalBytes' | 'electron' | 'node' | 'chrome'
> = {
  platform: platform(),
  osRelease: release(),
  arch: arch(),
  cpuCount: Math.max(1, cpus().length),
  cpuModel: (cpus()[0]?.model ?? 'unknown').trim().slice(0, 80),
  memoryTotalBytes: totalmem(),
  electron: process.versions.electron ?? 'unknown',
  node: process.versions.node ?? 'unknown',
  chrome: process.versions.chrome ?? 'unknown',
}

/**
 * Free and total space on the volume holding `path`.
 *
 * `fs.statfs` is unavailable on a few exotic mounts, so every failure degrades
 * to `null` numbers instead of throwing: a missing reading must never break the
 * caller (the settings panel, a feedback report or a shell command).
 */
export async function diskSpace(path: string): Promise<DiskSpace> {
  try {
    const stats = await statfs(path)
    const blockSize = Number(stats.bsize)
    const freeBytes = Number(stats.bavail) * blockSize
    const totalBytes = Number(stats.blocks) * blockSize
    const known = Number.isFinite(freeBytes) && freeBytes >= 0
    return {
      path,
      freeBytes: known ? freeBytes : null,
      totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
      low: known ? freeBytes < DISK_LOW_BYTES : false,
    }
  } catch {
    return { path, freeBytes: null, totalBytes: null, low: false }
  }
}

/** Whole environment snapshot; `diskRoot` is the volume to report on. */
export async function systemInfo(diskRoot?: string): Promise<SystemInfo> {
  const target = diskRoot?.trim() || process.cwd()
  return {
    ...staticFacts,
    memoryFreeBytes: freemem(),
    disk: await diskSpace(target),
  }
}

/**
 * One-line warning appended to a shell command's output when the workspace
 * volume is nearly full, so a later `ENOSPC` is explained before it happens.
 */
export function diskWarning(disk: DiskSpace | null): string | null {
  if (!disk?.low || disk.freeBytes === null) return null
  return (
    `[pilot] only ${formatBytes(disk.freeBytes)} free on the volume holding the workspace. ` +
    'Commands that write a lot (dependency installs, builds, bundling) may fail with ENOSPC.'
  )
}

/**
 * Render the environment lines a report asked for.
 *
 * Only keys the reporter ticked are returned, so a stored report never carries
 * a field the dialog did not show them.
 */
export function feedbackEnvironment(
  info: SystemInfo,
  sandbox: { backend: string; available: boolean } | null,
  fields: readonly FeedbackEnvField[],
): FeedbackEnvLine[] {
  const disk = info.disk
  const all: Record<FeedbackEnvField, FeedbackEnvLine> = {
    os: {
      key: 'os',
      label: '系统',
      value: `${info.platform} ${info.osRelease} (${info.arch})`,
    },
    cpu: {
      key: 'cpu',
      label: 'CPU',
      value: `${info.cpuModel || 'unknown'} · ${info.cpuCount} 核`,
    },
    memory: {
      key: 'memory',
      label: '内存',
      value: `${formatBytes(info.memoryFreeBytes)} 可用 / ${formatBytes(info.memoryTotalBytes)}`,
    },
    disk: {
      key: 'disk',
      label: '磁盘',
      value:
        disk?.freeBytes === null || disk === null
          ? '未知'
          : `剩余 ${formatBytes(disk.freeBytes)} / ${formatBytes(disk.totalBytes)}`,
    },
    runtime: {
      key: 'runtime',
      label: '运行时',
      value: `Electron ${info.electron} · Node ${info.node} · Chromium ${info.chrome}`,
    },
    sandbox: {
      key: 'sandbox',
      label: '沙箱',
      value: sandbox ? (sandbox.available ? sandbox.backend : '不可用') : '未知',
    },
  }
  return fields.map((field) => all[field])
}
