// 桌面端「设置 → 网页服务」与「手机连接」共用一个 CompanionServer：
// 期望的行为是「任一为真就监听，端口以网页服务的设置为准」，而不是两个开关各跑一套。
// 这里用真实的 CompanionServer（只在 store 上打桩）跑一遍 mode control 的四种路径。
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
import { createCompanionModeControl } from '../src/main/companion/mode-control'
import { DEFAULT_SERVER_PORT, normalizeServerPort } from '../src/shared/server-mode'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

/** 可供 mode control 读写的设置；`serverMode` / `serverPort` 是它真正关心的两项。 */
interface FakeSettings {
  serverMode: boolean
  serverPort: number
}

async function build(): Promise<{
  server: CompanionServer
  settings: FakeSettings
  control: ReturnType<typeof createCompanionModeControl>
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pilot-mode-control-'))
  const settings: FakeSettings = { serverMode: false, serverPort: DEFAULT_SERVER_PORT }
  const store = {
    settings: () => settings,
    settingsView: () => ({ model: 'deepseek-chat', theme: 'dark', relayUrl: '' }),
    workspaces: () => [],
    activeWorkspace: () => '',
  } as unknown as Store
  const server = new CompanionServer({
    store,
    runner: {} as never,
    dataDir,
    assetsDir: fileURLToPath(new URL('../companion', import.meta.url)),
    deviceName: 'Test Desktop',
    appVersion: '0.1.0-test',
    billing: { report: async () => ({}) as never },
    relayUrl: '',
    appUrl: '',
    host: '127.0.0.1',
    onStatus: () => undefined,
  })
  await server.init()
  cleanups.push(async () => {
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  })
  const control = createCompanionModeControl(server)
  return { server, settings, control }
}

/** 找一个当前空闲的端口：把监听器起在 0 上再关掉。 */
async function freePort(): Promise<number> {
  const probe = createServer(() => undefined)
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe('companion mode control', () => {
  it('listens on the port from settings once the web service is on', async () => {
    const { server, settings, control } = await build()
    const port = await freePort()
    settings.serverMode = true
    settings.serverPort = port

    const status = await control.syncFromSettings()

    expect(status.running).toBe(true)
    expect(status.port).toBe(port)
    expect(server.listeningPort()).toBe(port)
    expect(status.error).toBeNull()
  })

  it('stops listening when both the web service and the phone switch are off', async () => {
    const { server, settings, control } = await build()
    const port = await freePort()
    settings.serverMode = true
    settings.serverPort = port
    await control.syncFromSettings()
    expect(server.listeningPort()).toBe(port)

    settings.serverMode = false
    const status = await control.syncFromSettings()

    expect(status.running).toBe(false)
    expect(server.listeningPort()).toBeNull()
  })

  it('moves to the new port on save without leaving the old one bound', async () => {
    const { server, settings, control } = await build()
    const first = await freePort()
    const second = await freePort()
    settings.serverMode = true
    settings.serverPort = first
    await control.syncFromSettings()

    settings.serverPort = second
    const status = await control.syncFromSettings()

    expect(status.port).toBe(second)
    expect(server.listeningPort()).toBe(second)
    // 旧端口确实放掉了：同一端口能立刻被别的进程占用。
    const reuse = createServer(() => undefined)
    await new Promise<void>((resolve, reject) => {
      reuse.once('error', reject)
      reuse.listen(first, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => reuse.close(() => resolve()))
  })

  it('does not restart the listener when the port did not change', async () => {
    const { server, settings, control } = await build()
    const port = await freePort()
    settings.serverMode = true
    settings.serverPort = port
    await control.syncFromSettings()
    const before = (server as unknown as { server: unknown }).server

    await control.syncFromSettings()

    // 同一个 http.Server 实例：说明没 stop/start，浏览器里的页面不会断线。
    expect((server as unknown as { server: unknown }).server).toBe(before)
    expect(server.listeningPort()).toBe(port)
  })

  it('reports a taken port in the settings page wording instead of moving to another one', async () => {
    const { server, settings, control } = await build()
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
    settings.serverMode = true
    settings.serverPort = busyPort

    const status = await control.syncFromSettings()

    expect(status.running).toBe(false)
    expect(status.error).toContain(String(busyPort))
    // CLI 的提示语在桌面端会把用户指到不存在的参数上，必须换掉。
    expect(status.error).not.toContain('--port')
    expect(status.error).toContain('请在设置里换一个端口')
    expect(server.listeningPort()).toBeNull()
  })

  it('keeps the phone switch working without a fixed port', async () => {
    const { server, settings, control } = await build()
    settings.serverMode = false

    const status = await control.setPhoneEnabled(true)

    // 没有指定端口时允许回退到系统分配的端口——手机连接本来就不在意具体端口。
    expect(status.running).toBe(true)
    expect(server.listeningPort()).toBeGreaterThan(0)

    const off = await control.setPhoneEnabled(false)
    expect(off.running).toBe(false)
  })
})

describe('normalizeServerPort', () => {
  it('accepts the documented range and falls back for anything else', () => {
    expect(normalizeServerPort(46_831)).toBe(46_831)
    expect(normalizeServerPort('46831')).toBe(46_831)
    expect(normalizeServerPort(1_024)).toBe(1_024)
    expect(normalizeServerPort(65_535)).toBe(65_535)
    expect(normalizeServerPort(80)).toBe(DEFAULT_SERVER_PORT)
    expect(normalizeServerPort(70_000)).toBe(DEFAULT_SERVER_PORT)
    expect(normalizeServerPort('abc')).toBe(DEFAULT_SERVER_PORT)
    expect(normalizeServerPort(null)).toBe(DEFAULT_SERVER_PORT)
    expect(normalizeServerPort(12.5)).toBe(DEFAULT_SERVER_PORT)
  })
})
