import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
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

import type { Store } from '../src/main/store'
import { CompanionServer } from '../src/main/companion/server'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

function build(options: {
  dataDir: string
  port?: number
  strictPort?: boolean
  host?: string
  publicBaseUrl?: string
}): CompanionServer {
  const store = {
    settingsView: () => ({ model: 'deepseek-chat', theme: 'dark', relayUrl: '' }),
    workspaces: () => [],
    activeWorkspace: () => '',
  } as unknown as Store
  const server = new CompanionServer({
    store,
    runner: {} as never,
    dataDir: options.dataDir,
    assetsDir: fileURLToPath(new URL('../companion', import.meta.url)),
    deviceName: 'Test Server',
    appVersion: '0.1.0-test',
    billing: { report: async () => ({}) as never },
    relayUrl: '',
    appUrl: '',
    port: options.port,
    strictPort: options.strictPort,
    host: options.host,
    publicBaseUrl: options.publicBaseUrl,
    onStatus: () => undefined,
  })
  cleanups.push(async () => {
    await server.stop()
    await rm(options.dataDir, { recursive: true, force: true })
  })
  return server
}

describe('CompanionServer server-mode options', () => {
  it('listens on the CLI port instead of the persisted one', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pilot-server-mode-'))
    const server = build({ dataDir, port: 45_123, host: '127.0.0.1' })
    await server.init()
    await server.start()
    const status = server.status()
    expect(status.running).toBe(true)
    expect(status.port).toBe(45_123)
  })

  it('fails instead of silently moving to another port when strictPort is set', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pilot-server-mode-'))
    const blocker = createServer(() => undefined)
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    const busyPort = typeof address === 'object' && address ? address.port : 0
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          blocker.close(() => resolve())
        }),
    )
    const strict = build({ dataDir, port: busyPort, strictPort: true, host: '127.0.0.1' })
    await strict.init()
    await expect(strict.start()).rejects.toThrow(String(busyPort))
  })

  it('builds the pairing link from the configured public URL', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pilot-server-mode-'))
    const server = build({
      dataDir,
      port: 45_124,
      host: '127.0.0.1',
      publicBaseUrl: 'https://pilot.example.com/',
    })
    await server.init()
    const pairing = await server.createPairing()
    expect(pairing.url.startsWith('https://pilot.example.com/#p=')).toBe(true)
    expect(pairing.address).toBe('https://pilot.example.com/')
  })

  it('points the pairing link at the bind address when it is not a wildcard', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pilot-server-mode-'))
    const server = build({ dataDir, port: 45_125, host: '127.0.0.1' })
    await server.init()
    const pairing = await server.createPairing()
    // 127.0.0.1 bound to 127.0.0.1 is unreachable over the LAN, so the link must
    // not advertise the machine's LAN address.
    expect(pairing.url.startsWith('http://127.0.0.1:45125/#p=')).toBe(true)
  })
})
