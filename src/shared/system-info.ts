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

/** Usage bands the top bar paints differently: normal, tight, nearly out. */
export type UsageLevel = 'ok' | 'warn' | 'alert'

/** Warn from 80%, flag from 92%: both are about headroom, not about beauty. */
export const USAGE_WARN_PERCENT = 80
export const USAGE_ALERT_PERCENT = 92

/**
 * Share of a total that is in use, clamped to 0..100.
 *
 * Returns `null` when the reading is unusable (unknown total, negative or
 * non-finite numbers), so the UI can show "—" instead of a full bar that looks
 * like a real 100% reading.
 */
export function usagePercent(used: number | null, total: number | null): number | null {
  if (used === null || total === null) return null
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0 || used < 0) return null
  return Math.min(100, Math.max(0, (used / total) * 100))
}

/**
 * Band a percentage falls into. Unknown readings are `ok`: a missing sample
 * must not paint the window red.
 */
export function usageLevel(percent: number | null): UsageLevel {
  if (percent === null || !Number.isFinite(percent)) return 'ok'
  if (percent >= USAGE_ALERT_PERCENT) return 'alert'
  if (percent >= USAGE_WARN_PERCENT) return 'warn'
  return 'ok'
}