import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProcessEnv, ProcessManager } from '../src/main/agent/processes'

const roots: string[] = []
const managers: ProcessManager[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-proc-'))
  roots.push(root)
  return root
}

function manager(): ProcessManager {
  const created = new ProcessManager()
  managers.push(created)
  return created
}

const stayAlive = "console.log('ready at http://127.0.0.1:65535'); setInterval(() => {}, 1000)"

afterEach(async () => {
  await Promise.all(managers.splice(0).map((item) => item.stopAll()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProcessManager', () => {
  it('starts a long-lived process, reports readiness and reads its output', async () => {
    const root = await makeRoot()
    const processes = manager()
    const started = await processes.start(root, {
      command: 'node',
      args: ['-e', stayAlive],
      label: 'fake server',
      readyPattern: 'ready at',
      waitMs: 4_000,
    })
    expect(started.ok).toBe(true)
    expect(started.metadata?.['processId']).toBe('proc-1')
    expect(started.metadata?.['running']).toBe(true)
    expect(started.metadata?.['ready']).toBe(true)
    expect(started.output).toContain('ready at')

    const read = processes.read({ id: 'proc-1', tailLines: 10 })
    expect(read.ok).toBe(true)
    expect(read.output).toContain('ready at')
    expect(read.output).toContain('running')

    const stopped = await processes.stop({ id: 'proc-1' })
    expect(stopped.ok).toBe(true)
    expect(stopped.metadata?.['running']).toBe(false)
    expect(stopped.output).toContain('Stopped proc-1')
  }, 15_000)

  it('reports a one-shot command that exits immediately instead of pretending it is a server', async () => {
    const root = await makeRoot()
    const processes = manager()
    const started = await processes.start(root, {
      command: 'node',
      args: ['-e', "console.log('boom'); process.exit(1)"],
      waitMs: 3_000,
    })
    expect(started.ok).toBe(false)
    expect(started.error).toContain('exited immediately')
    expect(started.output).toContain('boom')
  })

  // Four real Node processes plus tree-kill cleanup can exceed the default
  // 5s per-test timeout on Windows.
  it('caps concurrent processes and stops the whole set', async () => {
    const root = await makeRoot()
    const processes = manager()
    for (let index = 0; index < 4; index += 1) {
      const started = await processes.start(root, {
        command: 'node',
        args: ['-e', stayAlive],
        readyPattern: 'ready at',
        waitMs: 4_000,
      })
      expect(started.ok).toBe(true)
    }
    await expect(
      processes.start(root, {
        command: 'node',
        args: ['-e', stayAlive],
        waitMs: 200,
      }),
    ).rejects.toThrow(/max 4/)
    await processes.stopAll()
    expect(processes.list().output).toContain('No processes')
  }, 15_000)

  it('rejects a working directory outside the workspace', async () => {
    const root = await makeRoot()
    const processes = manager()
    await expect(
      processes.start(root, { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], cwd: '..' }),
    ).rejects.toThrow()
  })

  it('rejects a non-localhost readiness URL', async () => {
    const root = await makeRoot()
    const processes = manager()
    await expect(
      processes.start(root, {
        command: 'node',
        args: ['-e', stayAlive],
        readyUrl: 'https://example.com/health',
      }),
    ).rejects.toThrow(/localhost/)
  })

  it('passes extra environment variables and never forwards PILOT_API_KEY', async () => {
    const root = await makeRoot()
    const processes = manager()
    const previous = process.env['PILOT_API_KEY']
    process.env['PILOT_API_KEY'] = 'should-not-leak'
    try {
      const started = await processes.start(root, {
        command: 'node',
        args: [
          '-e',
          "console.log('FLAG=' + (process.env.PILOT_TEST_FLAG ?? 'missing')); console.log('KEY=' + (process.env.PILOT_API_KEY ?? 'missing')); setInterval(() => {}, 1000)",
        ],
        env: { PILOT_TEST_FLAG: 'on', PILOT_API_KEY: 'explicit-leak' },
        readyPattern: 'FLAG=on',
        waitMs: 4_000,
      })
      expect(started.ok).toBe(true)
      expect(started.output).toContain('FLAG=on')
      expect(started.output).toContain('KEY=missing')
      await processes.stopAll()
    } finally {
      if (previous === undefined) delete process.env['PILOT_API_KEY']
      else process.env['PILOT_API_KEY'] = previous
    }
  }, 15_000)

  it('validates environment variable names and values', () => {
    expect(parseProcessEnv({ A: '1', B: 2 })).toEqual({ A: '1', B: '2' })
    expect(() => parseProcessEnv({ 'bad-name': 'x' })).toThrow(/Invalid environment variable name/)
    expect(() => parseProcessEnv({ A: 'line\nbreak' })).toThrow(/control characters/)
    expect(() => parseProcessEnv(['A'])).toThrow(/object of string values/)
    const tooMany: Record<string, string> = {}
    for (let index = 0; index < 65; index += 1) tooMany[`K${index}`] = 'x'
    expect(() => parseProcessEnv(tooMany)).toThrow(/at most 64/)
  })
})
