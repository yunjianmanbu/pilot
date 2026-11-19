import { describe, expect, it } from 'vitest'
import {
  assertReleaseUrl,
  compareVersions,
  isNewerVersion,
  parseRelease,
} from '../src/main/update/manifest'

const HOSTS = new Set(['download.medpilot.cc'])

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Pilot',
    version: '0.2.0',
    channel: 'stable',
    platform: 'Windows 10 / 11 · x64',
    date: '2026-11-11',
    url: 'https://download.medpilot.cc/pilot/Pilot-0.2.0-x64-setup.exe',
    size: 123_000_000,
    sha256: 'a'.repeat(64),
    notes: '修复若干问题。',
    ...overrides,
  }
}

describe('update version comparison', () => {
  it('orders stable versions numerically', () => {
    expect(compareVersions('0.1.1', '0.1.0')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('v1.10.0', '1.9.9')).toBe(1)
  })

  it('treats a final release as newer than its pre-releases', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0-alpha.9')).toBe(1)
    expect(compareVersions('1.0.0+build.2', '1.0.0')).toBe(0)
  })

  it('only reports valid newer versions', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false)
  })
})

describe('update manifest validation', () => {
  it('parses a valid stable manifest', () => {
    const parsed = parseRelease(release(), HOSTS)
    expect(parsed.version).toBe('0.2.0')
    expect(parsed.sha256).toBe('a'.repeat(64))
    expect(parsed.url).toContain('download.medpilot.cc')
  })

  it('rejects plain HTTP downloads outside loopback', () => {
    expect(() =>
      parseRelease(
        release({ url: 'http://download.medpilot.cc/pilot/Pilot.exe' }),
        HOSTS,
      ),
    ).toThrow(/HTTPS/)
  })

  it('rejects hosts that are not on the allowlist', () => {
    expect(() =>
      parseRelease(
        release({ url: 'https://evil.example.com/Pilot.exe' }),
        HOSTS,
      ),
    ).toThrow(/不允许/)
  })

  it('allows loopback HTTP for local update testing', () => {
    const parsed = parseRelease(
      release({ url: 'http://127.0.0.1:8765/Pilot-test.exe' }),
      HOSTS,
    )
    expect(parsed.url).toBe('http://127.0.0.1:8765/Pilot-test.exe')
  })

  it('rejects manifests for another app', () => {
    expect(() => parseRelease(release({ name: 'Other' }), HOSTS)).toThrow(/不属于 Pilot/)
  })

  it('rejects invalid versions, hashes, sizes and channels', () => {
    expect(() => parseRelease(release({ version: 'latest' }), HOSTS)).toThrow(/版本号/)
    expect(() => parseRelease(release({ sha256: 'abc' }), HOSTS)).toThrow(/SHA-256/)
    expect(() => parseRelease(release({ size: 0 }), HOSTS)).toThrow(/大小/)
    expect(() => parseRelease(release({ size: 2_000_000_000 }), HOSTS)).toThrow(/大小/)
    expect(() => parseRelease(release({ channel: 'beta' }), HOSTS)).toThrow(/stable/)
  })

  it('rejects credentials embedded in download URLs', () => {
    expect(() =>
      assertReleaseUrl('https://user:pass@download.medpilot.cc/Pilot.exe', HOSTS),
    ).toThrow(/凭据/)
  })
})
