import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateRelease, UpdateState } from '../src/shared/types'

const spawnMock = vi.fn()
const quitMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.37', isPackaged: true, quit: () => quitMock() },
  net: {
    fetch: async () => {
      throw new Error('the updater must not reach the network during this test')
    },
  },
}))

const { UpdaterService, installedForAllUsers } = await import('../src/main/updater')

function fakeChild(): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void }
  child.unref = () => undefined
  process.nextTick(() => child.emit('spawn'))
  return child
}

describe('updater install', () => {
  let root = ''

  beforeEach(() => {
    root = ''
    spawnMock.mockReset()
    quitMock.mockReset()
    spawnMock.mockImplementation(() => fakeChild())
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  async function readyService(relocating: boolean): Promise<{
    service: InstanceType<typeof UpdaterService>
    installer: string
    release: UpdateRelease
  }> {
    root = await mkdtemp(join(tmpdir(), 'pilot-updater-install-'))
    const installer = join(root, 'Pilot-0.1.38-x64-setup.exe')
    const payload = 'installer payload'
    await writeFile(installer, payload)
    const release: UpdateRelease = {
      version: '0.1.38',
      channel: 'stable',
      platform: 'Windows 10 / 11 · x64',
      date: '2026-11-15',
      size: Buffer.byteLength(payload),
      sha256: createHash('sha256').update(payload).digest('hex'),
      notes: '',
      url: 'https://download.medpilot.cc/pilot/Pilot-0.1.38-x64-setup.exe',
    }
    const service = new UpdaterService({
      currentVersion: '0.1.37',
      userDataDir: root,
      isPackaged: true,
      onState: () => undefined,
      // The install path is Windows-only in production; the test drives it on
      // every platform so the spawn contract stays covered on Linux CI.
      supported: true,
    })
    const state: UpdateState = {
      ...service.stateSnapshot(),
      status: 'ready',
      release,
      progress: 1,
      transferred: release.size,
      total: release.size,
      elevationRequired: true,
      relocatingToUserDir: relocating,
    }
    ;(service as unknown as { state: UpdateState }).state = state
    ;(service as unknown as { installerPath: string }).installerPath = installer
    return { service, installer, release }
  }

  it('installs into the per-user folder without waiting for elevation', async () => {
    const { service, installer } = await readyService(true)

    await service.install()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [executable, args, options] = spawnMock.mock.calls[0]!
    expect(executable).toBe(installer)
    expect(args).toEqual(['/S', '--updated', '--force-run', '/currentuser'])
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' })

    // A per-user silent install needs no UAC, so Pilot quits on its own.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(quitMock).toHaveBeenCalled()
  })

  it('treats Program Files as a machine-wide install even when writable', () => {
    if (process.platform !== 'win32') return
    const env = {
      ProgramFiles: 'C:\\Program Files',
      ProgramW6432: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    }
    expect(installedForAllUsers('C:\\Program Files\\Pilot\\Pilot.exe', env)).toBe(true)
    expect(installedForAllUsers('c:/program files/pilot/pilot.exe', env)).toBe(true)
    expect(installedForAllUsers('C:\\Program Files (x86)\\Pilot\\Pilot.exe', env)).toBe(true)
    expect(installedForAllUsers('D:\\Apps\\Pilot\\Pilot.exe', env)).toBe(false)
  })

  it('keeps the elevation wait when no relocation is planned', async () => {
    const { service } = await readyService(false)

    await service.install()

    const [, args] = spawnMock.mock.calls[0]!
    expect(args).toEqual(['/S', '--updated', '--force-run'])
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(quitMock).not.toHaveBeenCalled()
  })
})
