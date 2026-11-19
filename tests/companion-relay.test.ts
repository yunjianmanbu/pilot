import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

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
import { RelayHostChannel } from '../src/main/companion/relay'
import { CompanionServer } from '../src/main/companion/server'
import {
  createKeyPair,
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  tokenProof,
} from '../src/main/companion/crypto'

interface PairPayload {
  v: number
  r: string
  l?: string
  d: string
  k: string
  s: string
  p: string
  n: string
  x: string
  h: string
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.()
  }
})

function waitForFrame(
  socket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeout = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for WebSocket frame'))
    }, timeout)
    const onMessage = (data: WebSocket.RawData): void => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (!predicate(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

/**
 * Buffered frame reader. A host that reconnects gets relay.ready and the
 * flushed control frames back-to-back, so a listener attached after ready
 * would miss the second frame.
 */
function frameStream(socket: WebSocket): (
  predicate: (frame: Record<string, unknown>) => boolean,
  timeout?: number,
) => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean
    resolve: (frame: Record<string, unknown>) => void
    reject: (error: Error) => void
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
      waiters.push({ predicate, resolve, reject, timer })
    })
  }
}

async function waitUntil(predicate: () => boolean, timeout = 6_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('WebSocket connect timed out'))
    }, 8_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
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

async function startConnector(
  extraEnv: Record<string, string> = {},
): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort()
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../relay/server.mjs', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      WS_PATH: '/connector',
      ...extraEnv,
    },
    stdio: 'ignore',
  })
  cleanups.push(async () => {
    if (child.exitCode === null) {
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
    }
  })
  await waitForHealth(`http://127.0.0.1:${port}/healthz`)
  return { url: `ws://127.0.0.1:${port}/connector`, child }
}

async function createServer(relayUrl: string): Promise<{
  server: CompanionServer
  status: ReturnType<CompanionServer['status']>
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pilot-relay-'))
  const store = {
    settingsView: () => ({ model: 'deepseek-chat', theme: 'dark', relayUrl: '' }),
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
    deviceName: 'Relay Test Desktop',
    appVersion: '0.1.0-test',
    billing: { report: () => Promise.reject(new Error('billing is not stubbed in this test')) },
    relayUrl,
    appUrl: '',
    onStatus: () => undefined,
    // These tests are about transport, so the desktop approves instantly. The
    // approval flow itself is covered by companion-server.test.ts.
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
  return { server, status }
}

describe('cloud connector', () => {
  it('pairs and serves encrypted requests through the blind relay', async () => {
    const connector = await startConnector()
    const { server, status } = await createServer(connector.url)
    const pairing = await server.createPairing()
    expect(pairing.mode).toBe('cloud')
    expect(pairing.address).not.toContain('127.0.0.1')
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload
    expect(payload.r).toBe(connector.url)
    expect(payload.l).toContain('/ws')
    expect(payload.x).toBeTruthy()
    expect(payload.h).toBeTruthy()

    const phone = createKeyPair()
    const phoneId = 'relayphone012345'
    const pairSocket = await openSocket(connector.url)
    cleanups.push(() => pairSocket.close())
    pairSocket.send(
      JSON.stringify({ type: 'relay.hello', role: 'phone', room: payload.x, key: payload.h }),
    )
    await waitForFrame(pairSocket, (frame) => frame.type === 'relay.ready')
    const acceptedPromise = waitForFrame(pairSocket, (frame) => frame.type === 'pair.accepted')
    pairSocket.send(
      JSON.stringify({
        type: 'relay.frame',
        data: {
          type: 'pair.join',
          lookup: payload.k,
          phoneId,
          name: 'Relay Phone',
          phonePub: phone.publicBase64,
          platform: 'test',
          protocol: 2,
        },
      }),
    )
    const accepted = await acceptedPromise
    expect(accepted.token).toBeUndefined()
    const keys = derivePairKeys(phone.privateKey, payload.p, payload.s)
    const confirmation = decryptPayload(keys.pcToPhone, accepted.payload)
    const token = (confirmation.value as { token?: string }).token
    expect(typeof token).toBe('string')
    pairSocket.close()

    const sessionSocket = await openSocket(connector.url)
    cleanups.push(() => sessionSocket.close())
    sessionSocket.send(
      JSON.stringify({ type: 'relay.hello', role: 'phone', room: payload.x, key: payload.h }),
    )
    await waitForFrame(sessionSocket, (frame) => frame.type === 'relay.ready')
    const challengePromise = waitForFrame(
      sessionSocket,
      (frame) => frame.type === 'hello.challenge',
    )
    sessionSocket.send(
      JSON.stringify({
        type: 'relay.frame',
        data: {
          type: 'hello',
          role: 'phone',
          deviceId: status.deviceId,
          phoneId,
          protocol: 2,
        },
      }),
    )
    const challenge = await challengePromise
    const welcomePromise = waitForFrame(sessionSocket, (frame) => frame.type === 'welcome')
    sessionSocket.send(
      JSON.stringify({
        type: 'relay.frame',
        data: {
          type: 'hello.proof',
          deviceId: status.deviceId,
          phoneId,
          proof: tokenProof(token as string, challenge.challenge as string),
        },
      }),
    )
    const welcome = await welcomePromise
    expect(welcome.phoneId).toBe(phoneId)
    expect(welcome.protocolVersion).toBe(2)

    const responsePromise = waitForFrame(sessionSocket, (frame) => frame.type === 'message')
    sessionSocket.send(
      JSON.stringify({
        type: 'relay.frame',
        data: {
          type: 'message',
          payload: encryptPayload(
            keys.phoneToPc,
            { type: 'request', id: 'relay-req', method: 'device.info', params: {} },
            1,
          ),
        },
      }),
    )
    const responseFrame = await responsePromise
    const response = decryptPayload(keys.pcToPhone, responseFrame.payload)
    expect(response.value).toMatchObject({
      type: 'response',
      id: 'relay-req',
      ok: true,
      data: { deviceName: 'Relay Test Desktop' },
    })
  }, 30_000)
})

describe('host reconnect grace', () => {
  const room = 'roomgrace0123456789'
  const key = 'roomkeygrace0123456789'

  async function openHost(
    url: string,
    instance: string,
  ): Promise<{
    socket: WebSocket
    next: ReturnType<typeof frameStream>
  }> {
    const socket = await openSocket(url)
    const next = frameStream(socket)
    cleanups.push(() => socket.terminate())
    socket.send(
      JSON.stringify({
        type: 'relay.hello',
        role: 'host',
        room,
        key,
        protocol: 1,
        hostInstance: instance,
      }),
    )
    await next((frame) => frame.type === 'relay.ready')
    return { socket, next }
  }

  async function openPhone(url: string): Promise<WebSocket> {
    const socket = await openSocket(url)
    cleanups.push(() => socket.terminate())
    socket.send(JSON.stringify({ type: 'relay.hello', role: 'phone', room, key, protocol: 1 }))
    await waitForFrame(socket, (frame) => frame.type === 'relay.ready')
    return socket
  }

  function sendPhoneFrame(socket: WebSocket, data: Record<string, unknown>): void {
    socket.send(JSON.stringify({ type: 'relay.frame', data }))
  }

  it('同一电脑进程重连时手机不掉线，并能收到断线期间排队的控制帧', async () => {
    const connector = await startConnector({ HOST_GRACE_MS: '1500' })
    const { socket: host, next: hostFrames } = await openHost(connector.url, 'hostinstance0001')
    const phone = await openPhone(connector.url)

    const firstFrame = hostFrames((frame) => frame.type === 'relay.frame')
    sendPhoneFrame(phone, { type: 'hello', role: 'phone' })
    expect((await firstFrame).data).toMatchObject({ type: 'hello' })

    host.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(phone.readyState).toBe(WebSocket.OPEN)

    // 中继自己回应心跳，手机不会因为电脑端短暂消失而重连。
    const pong = waitForFrame(phone, (frame) => frame.type === 'pong', 3_000)
    sendPhoneFrame(phone, { type: 'ping', t: 1 })
    await pong
    expect(phone.readyState).toBe(WebSocket.OPEN)

    // 断线期间只缓冲控制帧；电脑端回来后会补齐 hello。
    sendPhoneFrame(phone, { type: 'hello', role: 'phone', buffered: true })
    sendPhoneFrame(phone, { type: 'message', payload: { secret: 'must-not-execute' } })
    const { next: host2Frames } = await openHost(connector.url, 'hostinstance0001')
    const buffered = await host2Frames((frame) => frame.type === 'relay.frame')
    expect(buffered.data).toMatchObject({ type: 'hello', buffered: true })

    // 同一进程恢复后，手机业务帧继续直达电脑端。
    const resumed = host2Frames((frame) => frame.type === 'relay.frame')
    sendPhoneFrame(phone, { type: 'ping', t: 2 })
    expect((await resumed).data).toMatchObject({ type: 'ping', t: 2 })
    expect(phone.readyState).toBe(WebSocket.OPEN)
  }, 20_000)

  it('电脑进程重启后会让手机重新握手，而不是留下假在线连接', async () => {
    const connector = await startConnector({ HOST_GRACE_MS: '2000' })
    const { socket: host } = await openHost(connector.url, 'hostinstance0001')
    const phone = await openPhone(connector.url)

    const errorFrame = waitForFrame(phone, (frame) => frame.type === 'relay.error', 3_000)
    const closed = new Promise<void>((resolve) => phone.once('close', () => resolve()))
    host.close()
    await openHost(connector.url, 'hostinstance0002')

    expect(String((await errorFrame).message)).toContain('重新连接')
    await closed
  }, 20_000)

  it('电脑端超过宽限期仍未回来时才关闭手机连接', async () => {
    const connector = await startConnector({ HOST_GRACE_MS: '300' })
    const { socket: host } = await openHost(connector.url, 'hostinstance0001')
    const phone = await openPhone(connector.url)

    // 宽限期内心跳仍由中继回应。
    const pong = waitForFrame(phone, (frame) => frame.type === 'pong', 2_000)
    host.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    sendPhoneFrame(phone, { type: 'ping', t: 1 })
    await pong
    expect(phone.readyState).toBe(WebSocket.OPEN)

    const offline = waitForFrame(phone, (frame) => frame.type === 'relay.error', 3_000)
    expect(String((await offline).message)).toContain('稍后会自动重连')
  }, 20_000)
})

describe('desktop host channel', () => {
  it('中继套接字短暂断开时保留手机虚拟连接，恢复后继续转发', async () => {
    const wss = new WebSocketServer({ port: 0, path: '/connector' })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    const port = (wss.address() as AddressInfo).port
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate()
          wss.close(() => resolve())
        }),
    )

    let hostSockets = 0
    const forwarded: Record<string, unknown>[] = []
    wss.on('connection', (socket) => {
      hostSockets += 1
      socket.on('message', (raw) => {
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>
        } catch {
          return
        }
        if (frame.type === 'relay.hello') {
          socket.send(JSON.stringify({ type: 'relay.ready', role: 'host', protocol: 1 }))
          socket.send(JSON.stringify({ type: 'relay.peer-open', cid: 'peer1' }))
          return
        }
        if (frame.type === 'relay.send') {
          forwarded.push(frame.data as Record<string, unknown>)
        }
      })
    })

    let peerOpens = 0
    let peerCloses = 0
    const channel = new RelayHostChannel(
      `ws://127.0.0.1:${port}/connector`,
      'roomgrace0123456789',
      'roomkeygrace0123456789',
      {
        onPeerOpen: () => {
          peerOpens += 1
        },
        onPeerClose: () => {
          peerCloses += 1
        },
      },
    )
    cleanups.push(() => channel.stop())
    channel.start()
    await waitUntil(() => peerOpens === 1 && channel.connected)

    channel.send('peer1', { type: 'ping', n: 1 })
    await waitUntil(() => forwarded.length === 1)

    // 中继主动掐断主机套接字；手机虚拟连接不应立刻被销毁。
    for (const client of wss.clients) client.terminate()
    await waitUntil(() => hostSockets === 2, 8_000)
    expect(peerCloses).toBe(0)

    await waitUntil(() => channel.connected)
    channel.send('peer1', { type: 'ping', n: 2 })
    await waitUntil(() => forwarded.length === 2)
    expect(forwarded[1]).toMatchObject({ type: 'ping', n: 2 })
    expect(peerCloses).toBe(0)
  }, 20_000)
})
