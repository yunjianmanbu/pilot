import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  listAppTargets,
  normalizePort,
  pickTarget,
  runAppAction,
  type AppTarget,
} from '../src/main/agent/app-control'
import {
  APP_CONTROL,
  APP_TARGETS,
  executePilotTool,
  LIST_WINDOWS,
  pilotTools,
  START_PROCESS,
  type ToolHost,
} from '../src/main/agent/tools'

const targets: AppTarget[] = [
  {
    id: 'page-1',
    title: 'Pilot',
    url: 'file:///app/index.html',
    type: 'page',
    webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1',
  },
  {
    id: 'worker-1',
    title: 'worker',
    url: 'worker.js',
    type: 'worker',
    webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/worker/1',
  },
]

describe('normalizePort', () => {
  it('defaults and validates the debugging port', () => {
    expect(normalizePort(undefined)).toBe(9222)
    expect(normalizePort(9333)).toBe(9333)
    expect(() => normalizePort(0)).toThrow(/between 1 and 65535/)
    expect(() => normalizePort('abc')).toThrow(/between 1 and 65535/)
  })
})

describe('pickTarget', () => {
  it('prefers pages, matches ids and titles, and reports what exists', () => {
    expect(pickTarget(targets, {})).toMatchObject({ id: 'page-1' })
    expect(pickTarget(targets, { targetId: 'worker-1' })).toMatchObject({ id: 'worker-1' })
    expect(pickTarget(targets, { targetTitle: 'pil' })).toMatchObject({ id: 'page-1' })
    expect(pickTarget(targets, { targetUrl: 'index.html' })).toMatchObject({ id: 'page-1' })
    expect(() => pickTarget(targets, { targetTitle: 'missing' })).toThrow(/Available targets/)
    expect(() => pickTarget([], {})).toThrow(/no page targets/i)
  })
})

class FakeCdp {
  private server: Server | null = null
  private sockets = new Set<WebSocket>()
  port = 0
  received: Array<Record<string, unknown>> = []

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.url === '/json/list') {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify([
            {
              id: 'page-1',
              title: 'Fake App',
              url: 'http://localhost:3000/',
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
        this.received.push(message)
        const id = message['id'] as number
        const method = String(message['method'] ?? '')
        const params = (message['params'] ?? {}) as Record<string, unknown>
        const reply = (result: unknown): void => {
          socket.send(JSON.stringify({ id, result }))
        }
        if (method === 'Runtime.evaluate') {
          const expression = String(params['expression'] ?? '')
          if (expression.includes('.click()')) {
            reply({ result: { value: { ok: true, tag: 'BUTTON', text: 'Save' } } })
          } else if (expression.includes('el.focus()')) {
            reply({ result: { value: { ok: true, tag: 'INPUT', type: 'text' } } })
          } else if (expression.includes('el.value.slice')) {
            reply({ result: { value: { value: 'hello' } } })
          } else if (expression.includes('document.title')) {
            reply({ result: { value: 'Fake App' } })
          } else if (expression.startsWith('!!(')) {
            reply({ result: { value: true } })
          } else {
            reply({ result: { value: null } })
          }
          return
        }
        if (method === 'Runtime.enable') {
          reply({})
          socket.send(
            JSON.stringify({
              method: 'Runtime.consoleAPICalled',
              params: { type: 'log', args: [{ type: 'string', value: 'boot ok' }] },
            }),
          )
          return
        }
        if (method === 'Log.enable') {
          reply({})
          return
        }
        if (method === 'Page.captureScreenshot') {
          reply({ data: Buffer.from('fake-jpeg').toString('base64') })
          return
        }
        if (method === 'Page.getLayoutMetrics') {
          reply({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } })
          return
        }
        if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') {
          reply({})
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
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
  }
}

const fake = new FakeCdp()
const dirs: string[] = []

beforeAll(async () => {
  await fake.start()
})

afterAll(async () => {
  await fake.stop()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function saveDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-app-control-'))
  dirs.push(dir)
  return dir
}

describe('runAppAction against a fake DevTools endpoint', () => {
  it('lists targets over the HTTP endpoint', async () => {
    const found = await listAppTargets(fake.port)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 'page-1', title: 'Fake App', type: 'page' })
  })

  it('evaluates JavaScript and returns the value', async () => {
    const outcome = await runAppAction({
      action: 'evaluate',
      port: fake.port,
      expression: 'document.title',
      saveDir: await saveDir(),
    })
    expect(outcome.output).toBe('Fake App')
    expect(outcome.metadata['targetId']).toBe('page-1')
  })

  it('clicks a selector and reports the element', async () => {
    const outcome = await runAppAction({
      action: 'click',
      port: fake.port,
      selector: 'button.primary',
      saveDir: await saveDir(),
    })
    expect(outcome.output).toContain('BUTTON')
    const evaluate = fake.received.find(
      (message) =>
        message['method'] === 'Runtime.evaluate' &&
        String((message['params'] as Record<string, unknown>)['expression']).includes('.click()'),
    )
    expect(JSON.stringify(evaluate)).toContain('button.primary')
  })

  it('types into a selector through Input.insertText', async () => {
    const outcome = await runAppAction({
      action: 'type',
      port: fake.port,
      selector: 'input[name=title]',
      text: 'hello',
      clear: true,
      saveDir: await saveDir(),
    })
    expect(outcome.output).toContain('Typed 5 characters')
    expect(outcome.output).toContain('hello')
    expect(fake.received.some((message) => message['method'] === 'Input.insertText')).toBe(true)
  })

  it('presses a key', async () => {
    const outcome = await runAppAction({
      action: 'press',
      port: fake.port,
      selector: 'input',
      key: 'Enter',
      saveDir: await saveDir(),
    })
    expect(outcome.output).toContain('Pressed Enter')
    const dispatched = fake.received.filter(
      (message) => message['method'] === 'Input.dispatchKeyEvent',
    )
    expect(dispatched.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(dispatched.at(-1))).toContain('Enter')
  })

  it('waits for a selector', async () => {
    const outcome = await runAppAction({
      action: 'wait',
      port: fake.port,
      selector: 'main.ready',
      timeoutMs: 1_000,
      saveDir: await saveDir(),
    })
    expect(outcome.output).toContain('Condition met')
  })

  it('collects console output', async () => {
    const outcome = await runAppAction({
      action: 'console',
      port: fake.port,
      durationMs: 250,
      saveDir: await saveDir(),
    })
    expect(outcome.output).toContain('boot ok')
    expect(outcome.output).toContain('1 console/exception/log event')
  })

  it('captures a screenshot, attaches the data URL and saves the file', async () => {
    const dir = await saveDir()
    const outcome = await runAppAction({
      action: 'screenshot',
      port: fake.port,
      label: 'check',
      saveDir: dir,
    })
    expect(outcome.images?.[0]).toMatch(/^data:image\/jpeg;base64,/)
    const detail = outcome.metadata['screenshot'] as Record<string, unknown>
    const path = String(detail['path'])
    expect(path).toContain(dir)
    expect((await readFile(path)).toString()).toBe('fake-jpeg')
    expect(detail['width']).toBe(800)
    expect(detail['height']).toBe(600)
  })

  it('fails with a clear message when nothing listens on the port', async () => {
    await expect(
      runAppAction({
        action: 'evaluate',
        port: 1,
        expression: '1',
        saveDir: await saveDir(),
      }),
    ).rejects.toThrow(/No DevTools endpoint/)
  })
})

describe('tool registration', () => {
  it('exposes the app tools and start_process env in the model tool list', () => {
    const names = pilotTools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining([APP_TARGETS, APP_CONTROL, LIST_WINDOWS]))
    const start = pilotTools.find((tool) => tool.name === START_PROCESS)
    const properties = start?.inputSchema['properties'] as Record<string, unknown>
    expect(Object.keys(properties)).toContain('env')
    const control = pilotTools.find((tool) => tool.name === APP_CONTROL)
    expect(control?.risk).toBe('exec')
  })
})

describe('executePilotTool wiring', () => {
  const host = async (): Promise<ToolHost> => ({
    root: process.cwd(),
    screenshotDir: await saveDir(),
    remember: async () => ({ id: 'memory-1' }),
    updatePlan: () => undefined,
    proposeSelfUpdate: async () => ({ version: 1 }),
  })

  it('routes app_targets through the tool layer', async () => {
    const result = await executePilotTool(
      APP_TARGETS,
      { port: fake.port },
      await host(),
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('Fake App')
    expect(result.metadata?.['count']).toBe(1)
  })

  it('routes app_control through the tool layer and keeps image metadata', async () => {
    const evaluate = await executePilotTool(
      APP_CONTROL,
      { action: 'evaluate', port: fake.port, expression: 'document.title' },
      await host(),
      new AbortController().signal,
    )
    expect(evaluate.ok).toBe(true)
    expect(evaluate.output).toBe('Fake App')

    const shot = await executePilotTool(
      APP_CONTROL,
      { action: 'screenshot', port: fake.port, label: 'wired' },
      await host(),
      new AbortController().signal,
    )
    expect(shot.ok).toBe(true)
    expect(Array.isArray(shot.metadata?.['images'])).toBe(true)
    expect(shot.metadata?.['screenshot']).toBeTruthy()
  })

  it('rejects an unknown action with a clear message', async () => {
    await expect(
      executePilotTool(
        APP_CONTROL,
        { action: 'teleport', port: fake.port },
        await host(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/action must be one of/)
  })
})
