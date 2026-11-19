import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { classifyFailure, runDrive } from '../src/main/agent/drive'
import { loadRecipe } from '../src/main/agent/drive/recipes'
import {
  DRIVE_PROBE,
  DRIVE_RECIPES,
  DRIVE_RUN,
  executePilotTool,
  pilotTools,
  type ToolHost,
} from '../src/main/agent/tools'

const dirs: string[] = []

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-drive-run-'))
  dirs.push(dir)
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { electron: '44.0.0' } }),
    'utf8',
  )
  return dir
}

const signal = new AbortController().signal

class FakeCdp {
  private server: Server | null = null
  private sockets = new Set<WebSocket>()
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
    const wss = new WebSocketServer({ server: this.server })
    wss.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>
        const id = message['id'] as number
        const method = String(message['method'] ?? '')
        const params = (message['params'] ?? {}) as Record<string, unknown>
        const reply = (result: unknown): void => {
          socket.send(JSON.stringify({ id, result }))
        }
        if (method === 'Runtime.evaluate') {
          const expression = String(params['expression'] ?? '')
          if (expression === 'document.title') reply({ result: { value: 'Fake App' } })
          else if (expression === 'true') reply({ result: { value: true } })
          else if (expression.includes('innerText.includes')) reply({ result: { value: true } })
          else reply({ result: { value: null } })
          return
        }
        reply({})
      })
    })
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', () => {
        const address = this.server?.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

class FakeHttp {
  private server: Server | null = null
  port = 0

  async start(): Promise<void> {
    this.server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/plain')
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

describe('classifyFailure', () => {
  it('names concrete signatures and blocks retrying approvals', () => {
    expect(classifyFailure('connect ECONNREFUSED 127.0.0.1:9222')).toMatchObject({
      signature: 'debug-port-unavailable',
      retryable: true,
    })
    expect(classifyFailure('wait timed out for http://x')).toMatchObject({
      signature: 'timeout',
    })
    expect(classifyFailure('selector matched no element')).toMatchObject({
      signature: 'element-not-found',
    })
    expect(classifyFailure('Tool denied by approval')).toMatchObject({
      signature: 'blocked',
      retryable: false,
    })
    expect(classifyFailure('Text not found: Ready')).toMatchObject({
      signature: 'assertion-failed',
      retryable: false,
    })
    expect(classifyFailure('Value mismatch. Expected "a", got "b"')).toMatchObject({
      signature: 'assertion-failed',
      retryable: false,
    })
    expect(classifyFailure('something odd')).toMatchObject({ signature: 'unknown' })
  })
})

describe('runDrive on cdp', () => {
  it('runs evaluate and assertText through the discovered port', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: { port: cdp.port },
      steps: [
        { do: 'evaluate', expression: 'document.title' },
        { do: 'assertText', text: 'Ready' },
      ],
      allowFallback: true,
      signal,
    })
    expect(result.ok).toBe(true)
    expect(result.usedSurfaces).toEqual(['cdp'])
    expect(result.steps[0]?.output).toBe('Fake App')
    expect(result.steps[1]?.ok).toBe(true)
    expect(result.output).toContain('Drive succeeded for electron')
  })

  it('records a fallback when a step times out on the current surface', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      // The fake DevTools server listens on an ephemeral port, so the cdp
      // surface is only reachable when that port is handed in: the probe scan
      // (9222-9232) can never find it.
      hints: { url: http.url, port: cdp.port },
      surfaceOrder: ['http', 'cdp'],
      steps: [
        { do: 'http', expectStatus: 200 },
        // http waits for a status that never comes, then cdp answers the same
        // wait condition. The router must report the switch, not hide it.
        { do: 'wait', expectStatus: 599, timeoutMs: 600, expression: 'true' },
      ],
      allowFallback: true,
      signal,
    })
    expect(result.ok).toBe(true)
    expect(result.usedSurfaces).toEqual(['http', 'cdp'])
    expect(result.fallbacks).toHaveLength(1)
    expect(result.fallbacks[0]).toMatchObject({
      stepIndex: 1,
      from: 'http',
      to: 'cdp',
      signature: 'timeout',
    })
  })

  it('does not switch surfaces when an assertion observes the wrong state', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: { url: http.url },
      surfaceOrder: ['http', 'cdp'],
      steps: [
        { do: 'http', expectStatus: 200 },
        { do: 'assertText', text: 'never-present' },
      ],
      allowFallback: true,
      signal,
    })
    expect(result.ok).toBe(false)
    expect(result.fallbacks).toHaveLength(0)
    expect(result.error).toContain('Text not found in HTTP response')
  })

  it('does not fall back when allowFallback is false', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: { url: http.url },
      surfaceOrder: ['http', 'cdp'],
      steps: [
        { do: 'http', expectStatus: 200 },
        { do: 'wait', expectStatus: 599, timeoutMs: 600, expression: 'true' },
      ],
      allowFallback: false,
      signal,
    })
    expect(result.ok).toBe(false)
    expect(result.fallbacks).toHaveLength(0)
    expect(result.error).toContain('wait timed out')
  })
})

describe('runDrive on http, cli and screenshot', () => {
  it('checks an HTTP status and body', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: { url: http.url },
      surfaceOrder: ['http'],
      steps: [
        { do: 'http', method: 'GET', expectStatus: 200, expectBody: 'hello from drive' },
        { do: 'assertText', text: 'hello from drive' },
      ],
      allowFallback: true,
      signal,
    })
    expect(result.ok).toBe(true)
    expect(result.steps[0]?.output).toContain('HTTP 200')
    expect(result.steps[1]?.output).toContain('Found text')
  })

  it('fails an HTTP assertion without retrying another surface', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: { url: http.url },
      surfaceOrder: ['http', 'cli'],
      steps: [{ do: 'http', expectStatus: 500 }],
      allowFallback: true,
      signal,
    })
    expect(result.ok).toBe(false)
    expect(result.fallbacks).toHaveLength(0)
    expect(result.error).toContain('HTTP 200')
  })

  it('runs a CLI command and asserts its output', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: {},
      surfaceOrder: ['cli'],
      steps: [
        { do: 'cli', command: 'node', args: ['-e', "console.log('drive-ok')"], expectOutput: 'drive-ok' },
        { do: 'assertText', text: 'drive-ok' },
      ],
      allowFallback: true,
      signal,
    })
    expect(result.ok).toBe(true)
    expect(result.steps[0]?.output).toContain('drive-ok')
  })

  it('collects a window screenshot as an image observation', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: {},
      surfaceOrder: ['screenshot'],
      steps: [{ do: 'screenshot', windowTitle: 'Fake App', label: 'check' }],
      allowFallback: true,
      signal,
      captureScreenshot: async () => ({
        ok: true,
        output: 'Captured Fake App (800x600)',
        metadata: { images: ['data:image/jpeg;base64,ZmFrZQ=='] },
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.images).toEqual(['data:image/jpeg;base64,ZmFrZQ=='])
    expect(result.steps[0]?.surface).toBe('screenshot')
  })
})

describe('recipes', () => {
  it('substitutes templates, saves only a passing run, and reuses the recipe', async () => {
    const root = await workspace()
    const options = {
      root,
      hints: { url: http.url },
      steps: [
        { do: 'http' as const, url: '${url}', expectStatus: 200, expectBody: 'hello from drive' },
        { do: 'assertText' as const, text: 'hello from drive' },
      ],
      allowFallback: true,
      signal,
    }
    const first = await runDrive({ ...options, saveAs: 'local-http', note: 'local server check' })
    expect(first.ok).toBe(true)
    expect(first.recipe).toContain('local-http.json')

    const saved = await loadRecipe(root, 'local-http')
    expect(saved.steps[0]?.url).toBe('${url}')
    expect(saved.note).toBe('local server check')
    expect(saved.successCount).toBe(1)

    const second = await runDrive({ root, hints: { url: http.url }, recipe: 'local-http', allowFallback: true, signal })
    expect(second.ok).toBe(true)
    expect(second.output).toContain('Recipe: local-http')
    expect((await loadRecipe(root, 'local-http')).successCount).toBe(2)
  })

  it('does not save a failing run', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: { url: http.url },
      surfaceOrder: ['http'],
      steps: [{ do: 'http', expectStatus: 503 }],
      allowFallback: true,
      signal,
      saveAs: 'broken-flow',
    })
    expect(result.ok).toBe(false)
    expect(result.recipe).toBeUndefined()
    await expect(loadRecipe(root, 'broken-flow')).rejects.toThrow(/not found/)
  })

  it('rejects a step that no selected surface can perform', async () => {
    const root = await workspace()
    const result = await runDrive({
      root,
      hints: {},
      surfaceOrder: ['http'],
      steps: [{ do: 'evaluate', expression: '1 + 1' }],
      allowFallback: true,
      signal,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No surface in [http] can perform step 1')
  })
})

describe('tool integration', () => {
  it('registers probe, recipe and run tools with the right risk', () => {
    const probe = pilotTools.find((tool) => tool.name === DRIVE_PROBE)
    const recipes = pilotTools.find((tool) => tool.name === DRIVE_RECIPES)
    const run = pilotTools.find((tool) => tool.name === DRIVE_RUN)
    expect(probe?.risk).toBe('read')
    expect(recipes?.risk).toBe('read')
    expect(run?.risk).toBe('exec')
    expect(JSON.stringify(run?.inputSchema)).toContain('"cdp"')
  })

  it('runs a dynamic-tool step through executePilotTool', async () => {
    const root = await workspace()
    const host: ToolHost = {
      root,
      screenshotDir: root,
      toolRegistry: {
        list: async () => [],
        register: async () => {
          throw new Error('not used')
        },
        rollback: async () => {
          throw new Error('not used')
        },
        promote: async () => {
          throw new Error('not used')
        },
        run: async (name, args) => {
          expect(name).toBe('probe-tool')
          expect(args).toEqual({ target: 'app' })
          return { ok: true, output: 'tool-ready' }
        },
      },
      remember: async () => ({ id: 'memory-1' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
    }
    const result = await executePilotTool(
      DRIVE_RUN,
      {
        surfaceOrder: ['custom'],
        steps: [{ do: 'tool', tool: 'probe-tool', toolArgs: { target: 'app' }, expectText: 'tool-ready' }],
      },
      host,
      signal,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('tool-ready')
    expect(result.metadata?.['usedSurfaces']).toEqual(['custom'])
  })

  it('probes through executePilotTool and reports surfaces', async () => {
    const root = await workspace()
    const host: ToolHost = {
      root,
      remember: async () => ({ id: 'memory-1' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
    }
    const result = await executePilotTool(DRIVE_PROBE, { url: http.url, deep: false }, host, signal)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('Surfaces:')
    expect(result.output).toContain('[available] http')
    expect(result.metadata?.['fingerprint']).toBeTruthy()
  })
})
