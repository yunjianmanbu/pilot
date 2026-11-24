import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installBuiltinPlugin,
  pluginOverview,
} from '../src/main/plugins/studio'
import { listBuiltinPlugins } from '../src/main/plugins/builtin'
import { loadPluginManifests } from '../src/main/plugins/manifest'
import { PluginHost } from '../src/main/plugins/runtime'

/**
 * The bundled plugins are shipped directories, not templates: these tests
 * assert the manifests parse, the files copy, tools actually run, settings
 * reach `grants.json` and a `schedule` trigger fires. A scaffold-only check
 * would pass on a bundle that cannot do any of that.
 */

/**
 * `<repo>/pilot/pilot/builtin-plugins`: the bundle directory itself, the same
 * shape the packaged app gets at `resources/builtin-plugins`.
 */
const bundleRoot = join(__dirname, '..', 'builtin-plugins')
const roots = [bundleRoot]

const cleanups: string[] = []
const hosts: PluginHost[] = []

afterEach(async () => {
  while (hosts.length) await hosts.pop()?.stopAll()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-builtin-plugins-'))
  cleanups.push(dir)
  return dir
}

function makeHost(options: ConstructorParameters<typeof PluginHost>[0]): PluginHost {
  const host = new PluginHost(options)
  hosts.push(host)
  return host
}

describe('bundled plugin catalog', () => {
  it('lists the three shipped plugins with their tools, settings and triggers', async () => {
    const items = await listBuiltinPlugins({ roots })
    const byId = new Map(items.map((item) => [item.id, item]))
    expect([...byId.keys()].sort()).toEqual(['healthcheck', 'snippet', 'worklog'])
    for (const item of items) {
      expect(item.error).toBeNull()
      expect(item.version).toBeGreaterThan(0)
      expect(item.tools.length).toBeGreaterThan(0)
      expect(item.settings.length).toBeGreaterThan(0)
      expect(item.installed).toBe(false)
    }

    const worklog = byId.get('worklog')
    expect(worklog?.tools).toEqual(['log', 'recent'])
    // Triggers travel as structured data so the renderer can localise them.
    expect(worklog?.triggers).toEqual([{ event: 'schedule', everyMinutes: null, timeOfDay: '18:00' }])
    expect(worklog?.permissions).toContain('entries:write')

    expect(byId.get('healthcheck')?.triggers).toEqual([
      { event: 'schedule', everyMinutes: 30, timeOfDay: null },
    ])
  })

  it('marks a plugin installed once it is in the workspace', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'snippet', { roots })
    const items = await listBuiltinPlugins({
      roots,
      installedIds: (await loadPluginManifests(workspace)).map((entry) => entry.id),
    })
    expect(items.find((item) => item.id === 'snippet')?.installed).toBe(true)
    expect(items.find((item) => item.id === 'worklog')?.installed).toBe(false)
  })
})

describe('installing a bundled plugin', () => {
  it('copies, signs and trusts worklog so the workspace can load it', async () => {
    const workspace = await tempWorkspace()
    const result = await installBuiltinPlugin(workspace, 'worklog', { roots })

    expect(result.id).toBe('worklog')
    expect(result.dir).toBe(join(workspace, '.pilot', 'plugins', 'worklog'))
    for (const file of ['plugin.json', 'index.mjs']) {
      expect(existsSync(join(result.dir, file))).toBe(true)
    }
    expect(result.signature?.state).toBe('trusted')
    expect(result.trustedKey?.pluginIds).toEqual(['worklog'])

    const installed = await loadPluginManifests(workspace)
    expect(installed.map((entry) => entry.id)).toEqual(['worklog'])
    expect(installed[0]?.manifest?.tools.map((tool) => tool.name)).toEqual(['log', 'recent'])

    // The overview is what the plugins page renders, so it has to see both the
    // installed card and the now-flagged bundled entry.
    const overview = await pluginOverview(workspace, { builtinRoots: roots })
    expect(overview.plugins.map((entry) => entry.id)).toEqual(['worklog'])
    expect(overview.plugins[0]?.settings.map((setting) => setting.key)).toEqual([
      'tag',
      'digestSize',
      'quiet',
    ])
    expect(overview.plugins[0]?.triggers.map((trigger) => trigger.timeOfDay)).toEqual(['18:00'])
    expect(overview.builtin.find((item) => item.id === 'worklog')?.installed).toBe(true)
  })

  it('refuses a second install of the same plugin', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'worklog', { roots })
    await expect(installBuiltinPlugin(workspace, 'worklog', { roots })).rejects.toThrow(
      /已安装/,
    )
  })

  it('refuses an id that is not in the bundle', async () => {
    const workspace = await tempWorkspace()
    await expect(installBuiltinPlugin(workspace, 'nope', { roots })).rejects.toThrow(
      /没有内置插件/,
    )
  })
})

describe('a bundled plugin runs as an agent tool', () => {
  it('logs an entry through toolCall and reads it back', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'worklog', { roots })
    const host = makeHost({ root: workspace })
    await host.setGrant('worklog', {
      enabled: true,
      permissions: ['entries:read', 'entries:write', 'host:notify'],
    })

    const tools = await host.toolDescriptors()
    const log = tools.find((tool) => tool.name === 'log')
    expect(log?.pluginId).toBe('worklog')
    expect(log?.fullName).toBe('plugin__worklog__log')
    expect(log?.inputSchema).toBeTruthy()

    const written = await host.toolCall('worklog', 'log', {
      text: '把插件工具接到 agent',
      tag: 'release',
    })
    expect(written.status).toBe(201)
    expect(written.body).toMatchObject({ todayCount: 1 })

    const recent = await host.toolCall('worklog', 'recent', { limit: 5 })
    expect(recent.status).toBe(200)
    expect(JSON.stringify(recent.body)).toContain('把插件工具接到 agent')

    // Calls land in the plugin's own state dir, not the workspace root.
    const stateFile = join(workspace, '.pilot', 'plugins', '.state', 'worklog', 'entries.jsonl')
    expect(existsSync(stateFile)).toBe(true)
    expect(await readFile(stateFile, 'utf8')).toContain('release')
  })

  it('hides the tools while the plugin is not enabled', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'snippet', { roots })
    const host = makeHost({ root: workspace })
    expect(await host.toolDescriptors()).toEqual([])
    await expect(host.toolCall('snippet', 'search', { query: 'x' })).rejects.toThrow(/enabled/)
  })

  it('stores settings in grants.json and restarts the plugin with them', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'worklog', { roots })
    const host = makeHost({ root: workspace })
    await host.setGrant('worklog', {
      enabled: true,
      permissions: ['entries:read', 'entries:write', 'host:notify'],
    })
    await host.activate('worklog')

    const grant = await host.setConfig('worklog', { tag: 'week-46', digestSize: '3', quiet: 'true' })
    expect(grant.config).toEqual({ tag: 'week-46', digestSize: 3, quiet: true })

    const raw = JSON.parse(
      await readFile(join(workspace, '.pilot', 'plugins', 'grants.json'), 'utf8'),
    ) as Record<string, { config?: Record<string, unknown> }>
    expect(raw.worklog?.config).toEqual({ tag: 'week-46', digestSize: 3, quiet: true })

    // Restarted, not stale: the running process now reports the new tag.
    const written = await host.toolCall('worklog', 'log', { text: '配置生效检查' })
    expect(written.status).toBe(201)
    const recent = await host.toolCall('worklog', 'recent', { limit: 1 })
    expect(JSON.stringify(recent.body)).toContain('week-46')
  })
})

describe('schedule triggers', () => {
  it('registers a timer only while the plugin is enabled', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'healthcheck', { roots })
    const host = makeHost({ root: workspace })
    expect(host.scheduledIds()).toEqual([])

    // Installed but disabled: the manifest has a trigger, the grant says no.
    await host.setGrant('healthcheck', {
      enabled: false,
      permissions: ['checks:read', 'checks:write', 'host:notify'],
    })
    expect(host.scheduledIds()).toEqual([])

    await host.setGrant('healthcheck', {
      enabled: true,
      permissions: ['checks:read', 'checks:write', 'host:notify'],
    })
    expect(host.scheduledIds()).toEqual(['healthcheck'])

    await host.setGrant('healthcheck', { enabled: false, permissions: [] })
    expect(host.scheduledIds()).toEqual([])
  })

  it(
    'runs the daily digest on demand and delivers the notification',
    async () => {
      const workspace = await tempWorkspace()
      await installBuiltinPlugin(workspace, 'worklog', { roots })
      const notes: string[] = []
      const host = makeHost({ root: workspace, notify: (message) => notes.push(message) })
      await host.setGrant('worklog', {
        enabled: true,
        permissions: ['entries:read', 'entries:write', 'host:notify'],
      })

      expect(await host.runSchedule('worklog')).toBe(1)
      expect(notes.join('\n')).toContain('今天还没有工作日志')

      await host.toolCall('worklog', 'log', { text: '补一条今天的日志' })
      notes.length = 0
      await host.runSchedule('worklog')
      expect(notes.join('\n')).toContain('今天记了 1 条')
      expect(notes.join('\n')).toContain('补一条今天的日志')
    },
    20_000,
  )
})
