import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginToolBridge } from '../src/main/agent/plugin-tools'
import { installBuiltinPlugin } from '../src/main/plugins/studio'
import { resetSharedPluginHosts, sharedPluginHost } from '../src/main/plugins/shared'

/**
 * The bridge is what turns `plugin.json` `tools` into model-callable tools. The
 * unit tests below drive it against the real bundled plugins, so a manifest
 * that stops matching its routes, a renamed tool or a broken grant check fails
 * here instead of at the end of a user's run.
 */

const bundleRoot = join(__dirname, '..', 'builtin-plugins')
const cleanups: string[] = []

afterEach(async () => {
  // The host is process-wide on purpose (one child per plugin per workspace),
  // so every test has to release it before the temp directory is removed.
  await resetSharedPluginHosts()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-plugin-bridge-'))
  cleanups.push(dir)
  return dir
}

async function enable(workspace: string, id: string, permissions: string[]): Promise<void> {
  await sharedPluginHost({ root: workspace }).setGrant(id, { enabled: true, permissions })
}

describe('plugin tools join the run', () => {
  it('offers an enabled plugin tool with the risk its manifest declared', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'worklog', { roots: [bundleRoot] })
    await enable(workspace, 'worklog', ['entries:read', 'entries:write', 'host:notify'])

    const bridge = await PluginToolBridge.create({ workspacePath: workspace })
    try {
      const tools = bridge.tools()
      const log = tools.find((tool) => tool.name === 'plugin__worklog__log')
      expect(log).toBeTruthy()
      // A write tool has to stay marked as such: plan mode filters on `risk`.
      expect(log?.risk).toBe('write')
      expect(log?.source).toBe('plugin')
      expect(log?.description).toContain('工作日志')
      expect(log?.inputSchema).toBeTruthy()
      expect(bridge.has('plugin__worklog__log')).toBe(true)
      expect(bridge.has('plugin__worklog__nope')).toBe(false)
    } finally {
      await bridge.dispose()
    }
  })

  it('runs a tool through the host and returns its body', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'worklog', { roots: [bundleRoot] })
    await enable(workspace, 'worklog', ['entries:read', 'entries:write', 'host:notify'])

    const bridge = await PluginToolBridge.create({ workspacePath: workspace })
    try {
      const written = await bridge.call('plugin__worklog__log', { text: '把插件工具接进这一轮' })
      expect(written.ok).toBe(true)
      expect(written.output).toContain('todayCount')
      expect(written.metadata).toMatchObject({ pluginId: 'worklog', status: 201 })

      const recent = await bridge.call('plugin__worklog__recent', { limit: 5 })
      expect(recent.ok).toBe(true)
      expect(recent.output).toContain('把插件工具接进这一轮')
    } finally {
      await bridge.dispose()
    }

    const unknown = await bridge.call('plugin__worklog__missing', {})
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('Unknown plugin tool')
  })

  it('drops the tools as soon as the user disables the plugin', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'snippet', { roots: [bundleRoot] })
    await enable(workspace, 'snippet', ['snippets:read', 'snippets:write', 'host:notify'])
    const enabled = await PluginToolBridge.create({ workspacePath: workspace })
    expect(enabled.has('plugin__snippet__save')).toBe(true)
    await enabled.dispose()

    await sharedPluginHost({ root: workspace }).setGrant('snippet', { enabled: false, permissions: [] })
    const disabled = await PluginToolBridge.create({ workspacePath: workspace })
    try {
      expect(disabled.tools()).toEqual([])
      expect(disabled.has('plugin__snippet__save')).toBe(false)
    } finally {
      await disabled.dispose()
    }
  })

  it(
    'routes plugin notices into the run while attached and stops after dispose',
    async () => {
      const workspace = await tempWorkspace()
      await installBuiltinPlugin(workspace, 'worklog', { roots: [bundleRoot] })
      await enable(workspace, 'worklog', ['entries:read', 'entries:write', 'host:notify'])

      const notes: string[] = []
      const bridge = await PluginToolBridge.create({
        workspacePath: workspace,
        notify: (message) => notes.push(message),
      })
      const host = sharedPluginHost({ root: workspace })
      // Start the process once so the timing below measures the host.call round
      // trip, not a cold Node start.
      await host.runSchedule('worklog')
      notes.length = 0

      const started = Date.now()
      await host.runSchedule('worklog')
      const elapsed = Date.now() - started
      expect(notes.join('\n')).toContain('今天还没有工作日志')
      // A plugin whose host.call replies are queued behind the call that waits
      // for them still "works" (the host runs the notify itself) but every
      // round trip burns the plugin's own 4 s timeout. This asserts the fix.
      expect(elapsed).toBeLessThan(2000)

      await bridge.dispose()
      notes.length = 0
      await host.runSchedule('worklog')
      // The plugin keeps running (its timer must survive a finished run) but
      // this run no longer owns the notice sink.
      expect(notes).toEqual([])
    },
    30_000,
  )

  it('delivers run.completed only to plugins that declared the trigger', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'worklog', { roots: [bundleRoot] })
    await enable(workspace, 'worklog', ['entries:read', 'entries:write', 'host:notify'])
    const probe = await writeEventProbe(workspace)
    await enable(workspace, 'eventprobe', ['events:write'])

    const bridge = await PluginToolBridge.create({ workspacePath: workspace })
    try {
      // `emit` never starts a stopped plugin, so the probe has to be running.
      await sharedPluginHost({ root: workspace }).activate('eventprobe')
      await bridge.emit('run.completed', { sessionId: 's1', status: 'completed', steps: 2 })
    } finally {
      await bridge.dispose()
    }

    const file = join(probe.stateDir, 'events.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'run.completed', sessionId: 's1' })
  })
})

/**
 * A minimal plugin that records `plugin.event` payloads. The bundled plugins
 * only listen to `schedule`, so proving the `run.completed` path needs a
 * subscriber that writes what it received.
 */
async function writeEventProbe(workspace: string): Promise<{ stateDir: string }> {
  const dir = join(workspace, '.pilot', 'plugins', 'eventprobe')
  await mkdir(dir, { recursive: true })
  const manifest = {
    id: 'eventprobe',
    name: '事件探针',
    version: 1,
    api: 1,
    runtime: 'node',
    entry: 'index.mjs',
    description: '记录宿主事件',
    permissions: ['events:write'],
    provides: null,
    roles: [],
    routes: [],
    tools: [],
    settings: [],
    triggers: [{ event: 'run.completed' }],
    limits: { timeoutMs: 20000, rateLimitPerMinute: 60 },
  }
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(
    join(dir, 'index.mjs'),
    `import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

let stateDir = '.'

async function handle(message) {
  const params = message.params && typeof message.params === 'object' ? message.params : {}
  if (message.method === 'plugin.activate') {
    if (typeof params.stateDir === 'string' && params.stateDir) stateDir = params.stateDir
    await mkdir(stateDir, { recursive: true })
    return { ok: true }
  }
  if (message.method === 'plugin.event') {
    const data = params.data && typeof params.data === 'object' ? params.data : {}
    await appendFile(join(stateDir, 'events.jsonl'), JSON.stringify({ event: params.event, ...data }) + '\\n', 'utf8')
    return { ok: true }
  }
  return { ok: true }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      const message = JSON.parse(line)
      handle(message).then((result) => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
      })
    }
    index = buffer.indexOf('\\n')
  }
})
`,
    'utf8',
  )
  return { stateDir: join(workspace, '.pilot', 'plugins', '.state', 'eventprobe') }
}
