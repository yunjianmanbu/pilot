import type { UpdateRelease } from '../../shared/types'

/** Largest installer we are willing to download (1.5 GB). */
export const MAX_INSTALLER_BYTES = 1_500_000_000

const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '').split('+')[0] ?? ''
}

function splitVersion(version: string): { core: number[]; pre: string[] } {
  const clean = normalizeVersion(version)
  const [coreRaw = '', preRaw = ''] = clean.split('-', 2)
  const core = coreRaw
    .split('.')
    .slice(0, 3)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0))
  while (core.length < 3) core.push(0)
  return { core, pre: preRaw ? preRaw.split('.') : [] }
}

function comparePreRelease(left: string[], right: string[]): number {
  // A release without a pre-release suffix is newer than any pre-release.
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? ''
    const b = right[index] ?? ''
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference > 0 ? 1 : -1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a > b ? 1 : -1
  }
  return left.length === right.length ? 0 : left.length > right.length ? 1 : -1
}

/** Compares two semantic versions; returns 1, 0 or -1. */
export function compareVersions(left: string, right: string): number {
  const a = splitVersion(left)
  const b = splitVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return comparePreRelease(a.pre, b.pre)
}

export function isNewerVersion(candidate: string, current: string): boolean {
  if (!VERSION_PATTERN.test(normalizeVersion(candidate))) return false
  if (!VERSION_PATTERN.test(normalizeVersion(current))) return false
  return compareVersions(candidate, current) > 0
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

/**
 * Only HTTPS downloads are accepted. Loopback HTTP is allowed for local
 * update testing; any other plain HTTP URL is rejected.
 */
export function assertReleaseUrl(raw: string, allowedHosts: ReadonlySet<string>): URL {
  const value = raw.trim()
  if (value.length === 0 || value.length > 2048) throw new Error('更新下载地址无效。')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('更新下载地址无效。')
  }
  if (url.username || url.password) throw new Error('更新下载地址不能包含凭据。')
  const loopback = isLoopbackHost(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('更新下载地址必须使用 HTTPS。')
  }
  if (!loopback && !allowedHosts.has(url.hostname)) {
    throw new Error(`不允许从 ${url.hostname} 下载更新。`)
  }
  return url
}

function readString(
  record: Record<string, unknown>,
  field: string,
  label: string,
  maxLength: number,
  required = true,
): string {
  const value = record[field]
  if (value === undefined || value === null) {
    if (!required) return ''
    throw new Error(`更新清单缺少${label}。`)
  }
  if (typeof value !== 'string') throw new Error(`更新清单的${label}格式不正确。`)
  const text = value.trim()
  if (required && text.length === 0) throw new Error(`更新清单缺少${label}。`)
  if (text.length > maxLength) throw new Error(`更新清单的${label}过长。`)
  return text
}

function readSize(record: Record<string, unknown>): number {
  const value = record['size']
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('更新清单缺少安装包大小。')
  }
  if (value <= 0 || value > MAX_INSTALLER_BYTES) {
    throw new Error('更新清单的安装包大小超出允许范围。')
  }
  return value
}

function readSha256(record: Record<string, unknown>): string {
  const sha256 = readString(record, 'sha256', '校验值', 64).toLowerCase()
  if (!SHA256_PATTERN.test(sha256)) throw new Error('更新清单的 SHA-256 校验值无效。')
  return sha256
}

/**
 * The manifest keeps one top-level installer (Windows) and a `platforms` block
 * for everything else. A platform entry carries the file the site links to
 * (usually a dmg) plus an optional `update` block with the artifact the in-app
 * updater downloads instead — on macOS that is the zip, because a dmg cannot be
 * mounted and applied by a running app.
 *
 * A platform entry may carry its own `version`: the platforms do not ship in
 * lockstep (macOS can be a release ahead of Windows, Linux behind), so the
 * top-level version cannot stand in for them. Without the override a client
 * would compare against the Windows version and never see its own update.
 */
function readPlatformEntry(
  record: Record<string, unknown>,
  platformKey: string,
  topVersion: string,
  allowedHosts: ReadonlySet<string>,
): { url: string; size: number; sha256: string; platform: string; version: string; notes: string } {
  const platforms = record['platforms']
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new Error('更新清单没有分平台安装包。')
  }
  const entry = (platforms as Record<string, unknown>)[platformKey]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`更新清单没有 ${platformKey} 的安装包。`)
  }
  const item = entry as Record<string, unknown>
  const update = item['update']
  const source =
    update && typeof update === 'object' && !Array.isArray(update)
      ? (update as Record<string, unknown>)
      : item
  const own = readString(item, 'version', '版本号', 48, false)
  const version = own ? normalizeVersion(own) : normalizeVersion(topVersion)
  if (!VERSION_PATTERN.test(version)) throw new Error('更新清单的版本号无效。')
  return {
    url: assertReleaseUrl(readString(source, 'url', '下载地址', 2048), allowedHosts).toString(),
    size: readSize(source),
    sha256: readSha256(source),
    platform: readString(item, 'label', '平台', 80, false),
    version,
    // Platforms release on their own schedule, so an entry may carry its own
    // notes; without one the shared top-level notes still apply.
    notes: readString(item, 'notes', '更新说明', 2000, false),
  }
}

/**
 * Validates an untrusted latest.json payload.
 *
 * `platformKey` (for example `mac-arm64`) switches the download target to that
 * platform's entry; without it the top-level Windows installer is used, which
 * is what every pre-0.1.89 client does.
 */
export function parseRelease(
  raw: unknown,
  allowedHosts: ReadonlySet<string>,
  platformKey?: string,
): UpdateRelease {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('更新清单格式不正确。')
  }
  const record = raw as Record<string, unknown>

  const name = readString(record, 'name', '应用名称', 60, false)
  if (name && name.toLowerCase() !== 'pilot') throw new Error('更新清单不属于 Pilot。')

  const version = readString(record, 'version', '版本号', 48)
  if (!VERSION_PATTERN.test(normalizeVersion(version))) {
    throw new Error('更新清单的版本号无效。')
  }

  const channel = readString(record, 'channel', '更新通道', 24, false) || 'stable'
  if (channel !== 'stable') throw new Error('当前仅支持 stable 更新通道。')

  if (platformKey) {
    const entry = readPlatformEntry(record, platformKey, version, allowedHosts)
    return {
      version: entry.version,
      channel,
      platform:
        entry.platform ||
        readString(record, 'platform', '平台', 80, false) ||
        'Windows 10 / 11 · x64',
      date: readString(record, 'date', '发布日期', 40, false),
      url: entry.url,
      size: entry.size,
      sha256: entry.sha256,
      notes: entry.notes || readString(record, 'notes', '更新说明', 2000, false),
    }
  }

  const url = assertReleaseUrl(readString(record, 'url', '下载地址', 2048), allowedHosts)

  const sizeValue = readSize(record)
  const sha256 = readSha256(record)

  return {
    version: normalizeVersion(version),
    channel,
    platform: readString(record, 'platform', '平台', 80, false) || 'Windows 10 / 11 · x64',
    date: readString(record, 'date', '发布日期', 40, false),
    url: url.toString(),
    size: sizeValue,
    sha256,
    notes: readString(record, 'notes', '更新说明', 2000, false),
  }
}
