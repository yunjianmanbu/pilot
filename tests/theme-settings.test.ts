import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getLocale: () => 'zh-CN',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<{ store: Store; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-theme-settings-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  await mkdir(userDataDir, { recursive: true })
  const store = new Store()
  await store.load()
  return { store, root }
}

describe('appearance settings', () => {
  it('defaults to the dark theme', async () => {
    const { store } = await setup()
    expect(store.settingsView().theme).toBe('dark')
  })

  it('exposes no accent palette any more', async () => {
    const { store } = await setup()
    expect('accent' in store.settingsView()).toBe(false)
  })

  it('persists a chosen theme across a restart', async () => {
    const { store } = await setup()
    await store.updateSettings({ theme: 'light' })
    expect(store.settingsView().theme).toBe('light')

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().theme).toBe('light')
  })

  it('drops a stale accent value written by an older build', async () => {
    const { root } = await setup()
    await writeFile(
      join(root, 'user-data', 'pilot-core.json'),
      JSON.stringify({ settings: { theme: 'light', accent: 'clay' } }),
      'utf8',
    )
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().theme).toBe('light')
    expect('accent' in reloaded.settingsView()).toBe(false)
  })

  it('falls back to dark for a hand-edited theme value', async () => {
    const { root } = await setup()
    await writeFile(
      join(root, 'user-data', 'pilot-core.json'),
      JSON.stringify({ settings: { theme: 'sepia', contrast: 'ultra', saturation: 'auto' } }),
      'utf8',
    )
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().theme).toBe('dark')
  })
})
