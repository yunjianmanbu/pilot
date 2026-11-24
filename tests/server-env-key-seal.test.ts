/**
 * The environment key must never reach the disk in clear text.
 *
 * `defaults()` seeds a fresh store from `PILOT_API_KEY` as base64, which is
 * exactly what a headless first boot does. These cases pin the guarantee that
 * by the time anything writes (`addWorkspace`, a settings edit, the run
 * command), the key in the snapshot is safeStorage ciphertext — and that the
 * key still reads back correctly afterwards.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV_KEY = 'sk-env-sealed-key-0123456789'
const MARK = 'enc:'

let encryptionAvailable = true

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getLocale: () => 'zh-CN',
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`${MARK}${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith(MARK)) throw new Error('not ciphertext')
      return text.slice(MARK.length)
    },
  },
}))

import { Store } from '../src/main/store'

const cleanups: string[] = []

beforeEach(() => {
  encryptionAvailable = true
  process.env['PILOT_API_KEY'] = ENV_KEY
})

afterEach(async () => {
  delete process.env['PILOT_API_KEY']
  encryptionAvailable = true
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function makeDirs(): Promise<{ dataDir: string; workspaceDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pilot-seal-data-'))
  const workspaceDir = await mkdtemp(join(tmpdir(), 'pilot-seal-ws-'))
  cleanups.push(dataDir, workspaceDir)
  return { dataDir, workspaceDir }
}

describe('environment model key at rest', () => {
  it('starts from a base64 copy of the key (what `load` has to seal)', async () => {
    // Pins the input side of the fix: `defaults()` copies `PILOT_API_KEY` into
    // `keyCipher` as base64 and flags it plain, so any save before `load`
    // finished sealing would write the key in a trivially decodable form.
    const { defaults } = await import('../src/main/store-schema')
    const primary = defaults().settings.modelResources.find((resource) => resource.id === 'primary')
    expect(primary?.keyPlain).toBe(true)
    expect(primary?.keyCipher).toBe(Buffer.from(ENV_KEY, 'utf8').toString('base64'))
  })

  it('seals the key before the first write, so the snapshot holds no plaintext', async () => {
    const { dataDir, workspaceDir } = await makeDirs()
    const store = new Store(dataDir)
    await store.load()

    // A fresh store seeded from the environment: the key is readable now...
    expect(store.getApiKey()).toBe(ENV_KEY)
    // ...but no longer flagged as plain text, because `load` re-sealed it.
    const primary = store.settings().modelResources.find((resource) => resource.id === 'primary')
    expect(primary?.keyPlain).toBe(false)

    // `addWorkspace` saves, which is the first disk write of the process.
    await store.addWorkspace(workspaceDir, { activate: true })

    const raw = await readFile(join(dataDir, 'pilot-core.json'), 'utf8')
    expect(raw).not.toContain(ENV_KEY)
    expect(raw).not.toContain(Buffer.from(ENV_KEY, 'utf8').toString('base64'))
    expect(raw).toContain(Buffer.from(`${MARK}${ENV_KEY}`, 'utf8').toString('base64'))

    // Reading it back still yields the original value, so sealing is lossless.
    const reloaded = new Store(dataDir)
    await reloaded.load()
    expect(reloaded.getApiKey()).toBe(ENV_KEY)
  })

  it('writes the encrypted form the settings page would write', async () => {
    const { dataDir, workspaceDir } = await makeDirs()
    const store = new Store(dataDir)
    await store.load()

    await store.updateSettings({ apiKey: ENV_KEY })
    await store.addWorkspace(workspaceDir, { activate: true })

    const core = JSON.parse(await readFile(join(dataDir, 'pilot-core.json'), 'utf8')) as {
      settings: {
        apiKeyPlain: boolean
        apiKeyCipher: string | null
        modelResources: Array<{ id: string; keyCipher: string | null; keyPlain: boolean }>
      }
    }
    expect(core.settings.apiKeyPlain).toBe(false)
    const primary = core.settings.modelResources.find((resource) => resource.id === 'primary')
    expect(primary?.keyPlain).toBe(false)
    expect(primary?.keyCipher).toBe(Buffer.from(`${MARK}${ENV_KEY}`, 'utf8').toString('base64'))
  })

  it('falls back to base64 only when the OS keychain is unavailable', async () => {
    // Documented limitation, not a regression: without safeStorage there is no
    // key to encrypt with, so the store marks the value plain instead of lying.
    encryptionAvailable = false
    const { dataDir, workspaceDir } = await makeDirs()
    const store = new Store(dataDir)
    await store.load()
    await store.addWorkspace(workspaceDir, { activate: true })

    const core = JSON.parse(await readFile(join(dataDir, 'pilot-core.json'), 'utf8')) as {
      settings: { apiKeyPlain: boolean }
    }
    expect(core.settings.apiKeyPlain).toBe(true)
    expect(store.getApiKey()).toBe(ENV_KEY)
  })
})
