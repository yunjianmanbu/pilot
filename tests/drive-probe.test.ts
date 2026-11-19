import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { detectFingerprint, probeTarget } from '../src/main/agent/drive'
import { buildRecipe, saveRecipe } from '../src/main/agent/drive/recipes'
import type { DriveSurfaceReport } from '../src/main/agent/drive'

const dirs: string[] = []

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-drive-probe-'))
  dirs.push(root)
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return root
}

const signal = new AbortController().signal
const ctx = { canScreenshot: true, canCustom: true, canTool: true }

class FakeCdp {
  private server: Server | null = null
  port = 0

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.url === '/json/list') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([
            {
              id: 'page-1',
              title: 'Fake App',
              url: 'file:///app/index.html',
              type: 'page',
              webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/1`,
            },
          ]),
        )
        return
      }
      response.statusCode = 404
      response.end()
    })
    new WebSocketServer({ server: this.server })
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

class FakeHttp {
  private server: Server | null = null
  port = 0

  async start(): Promise<void> {
    this.server = createServer((_request, response) => {
      response.end('hello from drive')
    })
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

const cdp = new FakeCdp()
const http = new FakeHttp()

beforeAll(async () => {
  await cdp.start()
  await http.start()
})

afterAll(async () => {
  await cdp.stop()
  await http.stop()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function surface(reports: DriveSurfaceReport[], name: string): DriveSurfaceReport {
  const found = reports.find((report) => report.surface === name)
  if (!found) throw new Error(`missing surface ${name}`)
  return found
}

describe('detectFingerprint', () => {
  it('recognizes Electron, Tauri, Android, web and HTTP targets', async () => {
    const electron = await fixture({
      'package.json': JSON.stringify({ devDependencies: { electron: '44.0.0', 'electron-vite': '5.0.0' } }),
    })
    const tauri = await fixture({
      'package.json': JSON.stringify({ dependencies: { '@tauri-apps/api': '2.0.0' } }),
      'src-tauri/tauri.conf.json': '{}',
    })
    const android = await fixture({
      'package.json': JSON.stringify({ dependencies: { 'react-native': '0.76.0' } }),
      'android/build.gradle': '',
    })
    const web = await fixture({ 'index.html': '<div id="root"></div>' })

    expect((await detectFingerprint(electron, {})).kind).toBe('electron')
    expect((await detectFingerprint(tauri, {})).kind).toBe('tauri')
    expect((await detectFingerprint(android, {})).kind).toBe('android')
    expect((await detectFingerprint(web, {})).kind).toBe('web')
    expect((await detectFingerprint(web, { url: 'http://127.0.0.1:1/' })).kind).toBe('web')
    expect((await detectFingerprint(await fixture({}), { url: 'http://127.0.0.1:1/' })).kind).toBe('http')
  })

  it('lets an explicit kind override project markers for an external app', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { electron: '44.0.0' } }),
    })
    const inferred = await detectFingerprint(root, {})
    const native = await detectFingerprint(root, { processName: 'notepad', kind: 'native' })
    expect(inferred.kind).toBe('electron')
    expect(native.kind).toBe('native')
    expect(native.markers).toContain('override:native')
    expect(native.key).not.toBe(inferred.key)
  })

  it('gives the same key to the same markers and a different key across kinds', async () => {
    const a = await fixture({ 'package.json': JSON.stringify({ dependencies: { electron: '1.0.0' } }) })
    const b = await fixture({ 'package.json': JSON.stringify({ devDependencies: { electron: '2.0.0' } }) })
    const web = await fixture({ 'index.html': '' })
    const fpA = await detectFingerprint(a, {})
    const fpB = await detectFingerprint(b, {})
    expect(fpA.key).toBe(fpB.key)
    expect(fpA.key).not.toBe((await detectFingerprint(web, {})).key)
    expect(fpA.markers).toContain('package.json:electron')
  })
})

describe('probeTarget', () => {
  it('finds a running DevTools endpoint and recommends cdp for Electron', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { electron: '44.0.0' } }),
    })
    const probed = await probeTarget({ root, port: cdp.port }, ctx, signal)
    const report = surface(probed.surfaces, 'cdp')
    expect(report.available).toBe(true)
    expect(report.evidence).toContain(`127.0.0.1:${cdp.port}`)
    expect(probed.discoveredPort).toBe(cdp.port)
    expect(probed.recommendation.primary).toBe('cdp')
    expect(probed.recommendation.fallbackOrder[0]).toBe('cdp')
  })

  it('never reports a closed requested port as the source of found targets', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { electron: '44.0.0' } }),
    })
    const probed = await probeTarget({ root, port: 1 }, ctx, signal)
    const report = surface(probed.surfaces, 'cdp')
    if (report.available) {
      // The scan may find a real browser elsewhere on this machine; it must
      // not pretend port 1 answered.
      expect(probed.discoveredPort).toBeDefined()
      expect(probed.discoveredPort).not.toBe(1)
      expect(report.evidence).not.toContain('127.0.0.1:1:')
    } else {
      expect(report.enableHint).toContain('--remote-debugging-port=9222')
    }
  })

  it('checks HTTP with a real request and keeps CLI available', async () => {
    const root = await fixture({})
    const probed = await probeTarget({ root, url: http.url }, ctx, signal)
    expect(surface(probed.surfaces, 'http').available).toBe(true)
    expect(surface(probed.surfaces, 'http').evidence).toContain('HTTP 200')
    expect(surface(probed.surfaces, 'cli').available).toBe(true)
    expect(probed.recommendation.fallbackOrder).toContain('http')
  })

  it('matches a saved recipe by exact fingerprint first', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { electron: '44.0.0' } }),
    })
    const probed = await probeTarget({ root, port: cdp.port }, ctx, signal)
    await saveRecipe(
      root,
      buildRecipe({
        name: 'open-window',
        note: 'proves the window opens',
        fingerprint: probed.fingerprint,
        surfaceOrder: ['cdp', 'screenshot'],
        steps: [{ do: 'evaluate', expression: 'document.title' }],
      }),
    )
    const again = await probeTarget({ root, port: cdp.port }, ctx, signal)
    expect(again.recipes).toHaveLength(1)
    expect(again.recipes[0]).toMatchObject({
      name: 'open-window',
      match: 'exact',
      kind: 'electron',
      stepCount: 1,
      successCount: 1,
    })
  })

  it('marks platform surfaces as not checked in a shallow probe', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ devDependencies: { electron: '44.0.0' } }),
    })
    const probed = await probeTarget({ root, port: cdp.port }, ctx, signal)
    expect(surface(probed.surfaces, 'adb').evidence).toContain('Not checked')
  })
})
