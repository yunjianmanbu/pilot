import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

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
import { createKeyPair, decryptPayload, derivePairKeys } from '../src/main/companion/crypto'

/**
 * L1 admission code, end to end: a strict connector plus the real desktop
 * server. The unit tests in `pilot-connector/test/access.test.mjs` prove the relay
 * rejects an anonymous handshake; this proves the connection string the
 * install script prints actually reaches the relay from every desktop path
 * (host channel + pairing payload) and that nothing leaks back to the UI.
 */

const CODE = 'home:0123456789abcdef0123456789abcdef'
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    const task = cleanups.pop()
    if (task) await task()
  }
})

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('connector did not become healthy')
}

async function startStrictConnector(): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../pilot-connector/server.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        PORT: String(port),
        BIND: '127.0.0.1',
        WS_PATH: '/c/testpath',
        RELAY_ACCESS_KEYS: CODE,
        RELAY_ACCESS_STRICT: '1',
      },
      stdio: 'ignore',
    },
  )
  cleanups.push(async () => {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  })
  await waitForHealth(`http://127.0.0.1:${port}/healthz`)
  return { url: `ws://127.0.0.1:${port}/c/testpath`, child }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function frameStream(socket: WebSocket): (
  predicate: (frame: Record<string, unknown>) => boolean,
  timeout?: number,
) => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean
    resolve: (frame: Record<string, unknown>) => void
    timer: NodeJS.Timeout
  }> = []
  socket.on('message', (data: WebSocket.RawData) => {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index]
      if (!waiter?.predicate(frame)) continue
      waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
      return
    }
    queue.push(frame)
  })
  return (predicate, timeout = 10_000) => {
    const index = queue.findIndex(predicate)
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0] as Record<string, unknown>)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = waiters.findIndex((item) => item.timer === timer)
        if (at >= 0) waiters.splice(at, 1)
        reject(new Error('timed out waiting for WebSocket frame'))
      }, timeout)
      waiters.push({ predicate, resolve, timer })
    })
  }
}

async function createServer(relayUrl: string): Promise<{
  server: CompanionServer
  status: ReturnType<CompanionServer['status']>
  stored: () => string
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pilot-access-'))
  // The dialog goes through the store, so the code lives in the settings the
  // same way it does in production; `relayUrl` is not passed as a server option.
  const settings = { model: 'deepseek-chat', theme: 'dark', relayUrl }
  const store = {
    settingsView: () => settings,
    updateSettings: async (patch: { relayUrl?: string }) => {
      if (patch.relayUrl !== undefined) settings.relayUrl = patch.relayUrl
      return settings
    },
    workspaces: () => [],
    phoneRoots: () => [],
    sessions: () => [],
    activeWorkspace: () => '',
  } as unknown as Store
  const server = new CompanionServer({
    store,
    runner: {} as never,
    dataDir,
    assetsDir: fileURLToPath(new URL('../companion', import.meta.url)),
    deviceName: 'Access Test Desktop',
    appVersion: '0.1.0-test',
    billing: { report: () => Promise.reject(new Error('billing is not stubbed in this test')) },
    appUrl: '',
    onStatus: () => undefined,
    onEvent: (event) => {
      if (event.type !== 'companion.pair_request') return
      server.resolvePairing(event.request.requestId, true)
    },
  })
  await server.init()
  cleanups.push(async () => {
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  })
  const status = await server.setEnabled(true)
  return { server, status, stored: () => settings.relayUrl }
}

describe('L1 admission code', () => {
  it('carries the code from the connection string through pairing to the relay', async () => {
    const connector = await startStrictConnector()
    // Exactly what install.sh prints, pasted as-is into the dialog.
    const { server, status } = await createServer(`${connector.url}#k=${CODE}`)

    // The code is stored but never handed to the renderer.
    expect(status.relayUrl).toBe(connector.url)
    expect(status.relayAccess).toBe(true)
    expect(JSON.stringify(status)).not.toContain(CODE)

    const pairing = await server.createPairing()
    expect(pairing.mode).toBe('cloud')
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as Record<string, string>
    expect(payload['a']).toBe(CODE)
    // The other endpoints in the payload stay code-free: a LAN fallback never
    // goes through the relay and must not leak the code into the QR code.
    expect(payload['l']).not.toContain('#k=')

    const phone = createKeyPair()
    const phoneId = 'accessphone01234'
    const socket = await openSocket(connector.url)
    cleanups.push(() => socket.close())
    const next = frameStream(socket)
    // A phone that replays the payload does exactly this.
    socket.send(
      JSON.stringify({
        type: 'relay.hello',
        role: 'phone',
        room: payload['x'],
        key: payload['h'],
        protocol: 1,
        access: payload['a'],
      }),
    )
    expect((await next((frame) => frame.type === 'relay.ready')).type).toBe('relay.ready')

    const acceptedPromise = next((frame) => frame.type === 'pair.accepted')
    socket.send(
      JSON.stringify({
        type: 'relay.frame',
        data: {
          type: 'pair.join',
          lookup: payload['k'],
          phoneId,
          name: 'Access Phone',
          phonePub: phone.publicBase64,
          platform: 'test',
          protocol: 2,
        },
      }),
    )
    const accepted = await acceptedPromise
    const keys = derivePairKeys(phone.privateKey, payload['p'] as string, payload['s'] as string)
    const confirmation = decryptPayload(keys.pcToPhone, accepted.payload)
    expect((confirmation.value as { type?: string }).type).toBe('pair.accept')
  }, 30_000)

  it('rejects a phone that has no code, which is what the 4009 hint means', async () => {
    const connector = await startStrictConnector()
    const { server } = await createServer(`${connector.url}#k=${CODE}`)
    const pairing = await server.createPairing()
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as Record<string, string>

    const socket = await openSocket(connector.url)
    cleanups.push(() => socket.close())
    const next = frameStream(socket)
    socket.send(
      JSON.stringify({
        type: 'relay.hello',
        role: 'phone',
        room: payload['x'],
        key: payload['h'],
        protocol: 1,
      }),
    )
    const error = await next((frame) => frame.type === 'relay.error')
    expect(error.message).toBe('连接器要求准入码')
  }, 30_000)

  it('keeps the stored code when the dialog resubmits the bare endpoint', async () => {
    const connector = await startStrictConnector()
    const { server, status, stored } = await createServer(`${connector.url}#k=${CODE}`)
    expect(status.relayAccess).toBe(true)

    // The dialog only shows the endpoint, so saving it again must not wipe the
    // code and silently break every paired phone.
    const saved = await server.setRelayUrl(connector.url)
    expect(saved.relayUrl).toBe(connector.url)
    expect(saved.relayAccess).toBe(true)
    expect(stored()).toBe(`${connector.url}#k=${CODE}`)

    // An explicitly different endpoint does replace both parts.
    const replaced = await server.setRelayUrl('ws://127.0.0.1:1/other')
    expect(replaced.relayUrl).toBe('ws://127.0.0.1:1/other')
    expect(replaced.relayAccess).toBe(false)
    expect(stored()).toBe('ws://127.0.0.1:1/other')
  }, 30_000)
})
