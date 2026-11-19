/**
 * System facts that the renderer, the main process and stored reports all need
 * to describe the same way. Kept free of Node APIs so the renderer can import
 * it; the actual probing lives in `main/system-info.ts`.
 */

/** Below this much free space, installs and builds tend to fail with ENOSPC. */
export const DISK_LOW_BYTES = 2 * 1024 * 1024 * 1024

/** Human-readable sizes for the UI and for report text ("1.8 GB"). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
