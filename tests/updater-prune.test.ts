import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.33', isPackaged: false },
  net: {
    fetch: async () => {
      throw new Error('the updater must not reach the network during this test')
    },
  },
}))

const { UpdaterService } = await import('../src/main/updater')

describe('updater download retention', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pilot-updater-prune-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  it('keeps the newest previous installer as the delta base', async () => {
    const dir = join(root, 'updates')
    await mkdir(dir, { recursive: true })

    // Oldest first: the 0.1.32 pair must end up newer than the 0.1.10 leftovers.
    await writeFile(join(dir, 'Pilot-0.1.10-x64-setup.exe'), 'stale')
    await writeFile(join(dir, 'Pilot-0.1.10-x64-setup.exe.blockmap'), 'stale-map')
    await writeFile(join(dir, 'Pilot-0.1.32-x64-setup.exe'), 'base')
    await writeFile(join(dir, 'Pilot-0.1.32-x64-setup.exe.blockmap'), 'base-map')
    await writeFile(join(dir, 'Pilot-0.1.33-x64-setup.exe'), 'next')
    await writeFile(join(dir, 'Pilot-0.1.33-x64-setup.exe.blockmap'), 'next-map')
    await writeFile(join(dir, 'Pilot-0.1.33-x64-setup.exe.part'), 'partial')

    const service = new UpdaterService({
      currentVersion: '0.1.33',
      userDataDir: root,
      isPackaged: false,
      onState: () => undefined,
    })

    await (
      service as unknown as { pruneDownloads(keep: string): Promise<void> }
    ).pruneDownloads(join(dir, 'Pilot-0.1.33-x64-setup.exe'))

    expect((await readdir(dir)).sort()).toEqual([
      'Pilot-0.1.32-x64-setup.exe',
      'Pilot-0.1.32-x64-setup.exe.blockmap',
      'Pilot-0.1.33-x64-setup.exe',
      'Pilot-0.1.33-x64-setup.exe.blockmap',
    ])
  })
})
