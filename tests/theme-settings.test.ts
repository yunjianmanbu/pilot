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
  it('defaults to the dark graphite palette', async () => {
    const { store } = await setup()
    expect(store.settingsView().theme).toBe('dark')
    expect(store.settingsView().accent).toBe('graphite')
    expect(store.settingsView().contrast).toBe('standard')
    expect(store.settingsView().saturation).toBe('standard')
  })

  it('persists a chosen theme and accent across a restart', async () => {
    const { store } = await setup()
    await store.updateSettings({ theme: 'light', accent: 'clay' })
    expect(store.settingsView().accent).toBe('clay')

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().theme).toBe('light')
    expect(reloaded.settingsView().accent).toBe('clay')
  })

  it('accepts every bundled palette, including the new presets', async () => {
    const { store } = await setup()
    for (const accent of ['ocean', 'moss', 'plum', 'rose', 'sand', 'orange'] as const) {
      await store.updateSettings({ accent })
      expect(store.settingsView().accent).toBe(accent)
    }
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().accent).toBe('orange')
  })

  it('persists the Claude warm palette', async () => {
    const { store } = await setup()
    await store.updateSettings({ theme: 'light', accent: 'claude' })
    expect(store.settingsView().accent).toBe('claude')

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().theme).toBe('light')
    expect(reloaded.settingsView().accent).toBe('claude')
  })

  it('ignores an unknown accent instead of persisting it', async () => {
    const { store } = await setup()
    await store.updateSettings({ accent: 'clay' })
    await store.updateSettings({ accent: 'neon' as never })
    expect(store.settingsView().accent).toBe('clay')
  })

  it('persists contrast and saturation across a restart', async () => {
    const { store } = await setup()
    await store.updateSettings({ contrast: 'high', saturation: 'low' })
    expect(store.settingsView().contrast).toBe('high')
    expect(store.settingsView().saturation).toBe('low')

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().contrast).toBe('high')
    expect(reloaded.settingsView().saturation).toBe('low')

    await reloaded.updateSettings({ contrast: 'low', saturation: 'high' })
    const second = new Store()
    await second.load()
    expect(second.settingsView().contrast).toBe('low')
    expect(second.settingsView().saturation).toBe('high')
  })

  it('ignores unknown contrast and saturation levels', async () => {
    const { store } = await setup()
    await store.updateSettings({ contrast: 'high', saturation: 'low' })
    await store.updateSettings({ contrast: 'ultra' as never, saturation: 'dim' as never })
    expect(store.settingsView().contrast).toBe('high')
    expect(store.settingsView().saturation).toBe('low')
  })

  it('falls back to standard for hand-edited appearance values', async () => {
    const { root } = await setup()
    await writeFile(
      join(root, 'user-data', 'pilot-core.json'),
      JSON.stringify({ settings: { contrast: 'ultra', saturation: 'auto' } }),
      'utf8',
    )
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().contrast).toBe('standard')
    expect(reloaded.settingsView().saturation).toBe('standard')
  })

  it('falls back to graphite for a hand-edited palette name', async () => {
    const { root } = await setup()
    await writeFile(
      join(root, 'user-data', 'pilot-core.json'),
      JSON.stringify({ settings: { theme: 'light', accent: 'neon' } }),
      'utf8',
    )
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settingsView().theme).toBe('light')
    expect(reloaded.settingsView().accent).toBe('graphite')
  })
})
