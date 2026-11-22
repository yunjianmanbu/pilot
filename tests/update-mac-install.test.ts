import { describe, expect, it } from 'vitest'
import {
  MAC_SWAP_SCRIPT,
  appBundleForExecutable,
  isMountedVolume,
  pickStagedApp,
  stagingDirFor,
} from '../src/main/update/mac-install'

describe('macOS bundle discovery', () => {
  it('walks up from the executable to the .app bundle', () => {
    expect(
      appBundleForExecutable('/Applications/Pilot.app/Contents/MacOS/Pilot'),
    ).toBe('/Applications/Pilot.app')
    expect(
      appBundleForExecutable('/Users/me/Applications/Pilot.app/Contents/MacOS/Pilot'),
    ).toBe('/Users/me/Applications/Pilot.app')
  })

  it('returns null for an executable that is not inside a bundle', () => {
    expect(appBundleForExecutable('/usr/local/bin/pilot')).toBeNull()
    expect(appBundleForExecutable('/Users/me/pilot/out/main/index.js')).toBeNull()
    // Contents/MacOS is required; a stray .app in the path is not enough.
    expect(appBundleForExecutable('/Applications/Pilot.app/Pilot')).toBeNull()
  })

  it('treats dmg volumes as read-only so the app asks for a real install', () => {
    expect(isMountedVolume('/Volumes/Pilot/Pilot.app')).toBe(true)
    expect(isMountedVolume('/Volumes')).toBe(true)
    expect(isMountedVolume('/Applications/Pilot.app')).toBe(false)
    expect(isMountedVolume('/VolumesX/Pilot.app')).toBe(false)
  })
})

describe('macOS staged swap', () => {
  it('stages beside the installed bundle so the swap is a rename', () => {
    // path.join uses the host separator; compare in POSIX form so the check
    // means the same thing when the suite runs on Windows.
    const stage = stagingDirFor('/Applications/Pilot.app', 'abc123').replace(/\\/g, '/')
    expect(stage).toBe('/Applications/.pilot-update-abc123')
  })

  it('picks the expected bundle first and otherwise the single .app', () => {
    expect(pickStagedApp(['Pilot.app', 'Other.app'], 'Pilot.app')).toBe('Pilot.app')
    expect(pickStagedApp(['__MACOSX', 'Pilot.app'], 'Renamed.app')).toBe('Pilot.app')
    expect(pickStagedApp(['a.app', 'b.app'], 'Pilot.app')).toBeNull()
    expect(pickStagedApp(['readme.txt'], 'Pilot.app')).toBeNull()
  })

  it('keeps the swap script conservative: verify, swap, roll back on failure', () => {
    expect(MAC_SWAP_SCRIPT.startsWith('#!/bin/sh')).toBe(true)
    expect(MAC_SWAP_SCRIPT).toContain('set -u')
    // A missing staged bundle must abort before the installed one is touched.
    expect(MAC_SWAP_SCRIPT.indexOf('staged bundle missing')).toBeLessThan(
      MAC_SWAP_SCRIPT.indexOf('mv "$TARGET" "$BACKUP"'),
    )
    // Failure path puts the old bundle back and never leaves both moved away.
    expect(MAC_SWAP_SCRIPT).toContain('mv "$BACKUP" "$TARGET"')
    // Relaunch happens only after a successful swap.
    expect(MAC_SWAP_SCRIPT.indexOf('open "$TARGET"')).toBeGreaterThan(
      MAC_SWAP_SCRIPT.indexOf('mv "$STAGED" "$TARGET"'),
    )
    // Unsigned builds carry no quarantine, but a downloaded update might.
    expect(MAC_SWAP_SCRIPT).toContain('xattr -dr com.apple.quarantine')
    expect(MAC_SWAP_SCRIPT).toContain('sleep 1')
  })
})
