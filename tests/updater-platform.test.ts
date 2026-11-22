import { describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../src/shared/types'

vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('these tests never spawn a process')
  },
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.88', isPackaged: true, quit: () => undefined },
  net: {
    fetch: async () => {
      throw new Error('these tests never reach the network')
    },
  },
}))

const { UpdaterService, sameInstallerKind } = await import('../src/main/updater')

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return run()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

describe('installer kind matching for delta bases', () => {
  it('keeps deltas inside one artifact format', () => {
    expect(sameInstallerKind('Pilot-0.1.88-x64-setup.exe', 'Pilot-0.1.89-x64-setup.exe')).toBe(true)
    expect(sameInstallerKind('Pilot-0.1.88-mac-arm64.zip', 'Pilot-0.1.89-mac-arm64.zip')).toBe(true)
    // A dmg is a compressed disk image: its blocks never line up with the zip
    // the updater downloads, so it must not be offered as a base.
    expect(sameInstallerKind('Pilot-0.1.88-mac-arm64.dmg', 'Pilot-0.1.89-mac-arm64.zip')).toBe(false)
    expect(sameInstallerKind('Pilot-0.1.88-x64-setup.exe', 'Pilot-0.1.89-mac-arm64.zip')).toBe(false)
  })

  it('separates the two mac architectures', () => {
    expect(sameInstallerKind('Pilot-0.1.88-mac-arm64.zip', 'Pilot-0.1.89-mac-x64.zip')).toBe(false)
    expect(sameInstallerKind('Pilot-0.1.88-mac-x64.zip', 'Pilot-0.1.89-mac-x64.zip')).toBe(true)
  })
})

describe('platform gate', () => {
  function statusFor(platform: NodeJS.Platform): UpdateState['status'] {
    return withPlatform(platform, () => {
      const service = new UpdaterService({
        currentVersion: '0.1.88',
        userDataDir: 'C:\\tmp\\pilot-update-test',
        isPackaged: true,
        onState: () => undefined,
      })
      return service.stateSnapshot().status
    })
  }

  it('enables the updater where it can apply an update', () => {
    // Windows drives the NSIS installer, macOS stages the zip and swaps the
    // bundle; Linux has no path yet and stays disabled.
    expect(statusFor('win32')).toBe('idle')
    expect(statusFor('darwin')).toBe('idle')
    expect(statusFor('linux')).toBe('disabled')
  })
})
