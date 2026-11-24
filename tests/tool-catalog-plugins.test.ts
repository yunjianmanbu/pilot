import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildToolCatalog } from '../src/shared/tools-catalog'
import { installBuiltinPlugin } from '../src/main/plugins/studio'
import { pluginCatalogTools, resetSharedPluginHosts, sharedPluginHost } from '../src/main/plugins/shared'

/**
 * 「工具」面板要能回答「这个插件装了什么工具、用过几次」。插件工具在运行时叫
 * `plugin__<id>__<tool>`，清单里也必须用这个名字出现，否则调用次数永远对不上。
 * 这里钉住清单形状与「读清单不启动插件」这条边界。
 */

const bundleRoot = join(__dirname, '..', 'builtin-plugins')
const cleanups: string[] = []

afterEach(async () => {
  await resetSharedPluginHosts()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-tool-catalog-plugin-'))
  cleanups.push(dir)
  return dir
}

describe('buildToolCatalog 的插件行', () => {
  it('lists a plugin tool under its runtime name and says whose it is', () => {
    const catalog = buildToolCatalog({
      builtin: [],
      dynamic: [],
      mcpServers: [],
      mcpEnabled: false,
      plugins: [
        {
          id: 'worklog',
          name: '工作日志',
          tool: 'log',
          fullName: 'plugin__worklog__log',
          description: 'Append one work log entry.',
          risk: 'write',
        },
      ],
    })
    expect(catalog).toHaveLength(1)
    const entry = catalog[0]
    expect(entry?.source).toBe('plugin')
    // 名字必须是运行时的全名：调用次数按这个名字统计。
    expect(entry?.name).toBe('plugin__worklog__log')
    expect(entry?.plugin).toBe('worklog')
    expect(entry?.pluginName).toBe('工作日志')
    expect(entry?.risk).toBe('write')
    expect(entry?.enabled).toBe(true)
    // 两个插件都有 status 工具时，靠这行中文把来源说清楚。
    expect(entry?.descriptionZh).toContain('插件「工作日志」')
    expect(entry?.description).toContain('[plugin worklog]')
  })

  it('counts plugin calls by full name, without prefix tricks', () => {
    const catalog = buildToolCatalog({
      builtin: [],
      dynamic: [],
      mcpServers: [],
      mcpEnabled: false,
      plugins: [
        {
          id: 'healthcheck',
          name: '接口巡检',
          tool: 'check',
          fullName: 'plugin__healthcheck__check',
          description: 'Check one URL.',
          risk: 'exec',
        },
      ],
      calls: { plugin__healthcheck__check: 3 },
    })
    expect(catalog[0]?.calls).toBe(3)
  })
})

describe('pluginCatalogTools', () => {
  it('returns nothing for a workspace without enabled plugins', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'snippet', { roots: [bundleRoot] })
    expect(await pluginCatalogTools(workspace)).toEqual([])
  })

  it('reads manifests and grants without starting the plugin', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'worklog', { roots: [bundleRoot] })
    await sharedPluginHost({ root: workspace }).setGrant('worklog', {
      enabled: true,
      permissions: ['entries:read', 'entries:write', 'host:notify'],
    })

    const tools = await pluginCatalogTools(workspace)
    const log = tools.find((tool) => tool.tool === 'log')
    expect(log).toBeTruthy()
    expect(log?.fullName).toBe('plugin__worklog__log')
    expect(log?.name).toBe('工作日志')
    expect(log?.description.length).toBeGreaterThan(0)
    expect(log?.risk).toBe('write')
    expect(tools.map((tool) => tool.tool).sort()).toEqual(['log', 'recent'])

    // 面板只是画一行字，不该为了它起一个 Node 子进程：状态目录里不能有 entries。
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(workspace, '.pilot', 'plugins', '.state', 'worklog'))).toBe(false)
  })

  it('drops every row once the plugin is disabled', async () => {
    const workspace = await tempWorkspace()
    await installBuiltinPlugin(workspace, 'healthcheck', { roots: [bundleRoot] })
    const host = sharedPluginHost({ root: workspace })
    await host.setGrant('healthcheck', { enabled: true, permissions: ['checks:read'] })
    expect((await pluginCatalogTools(workspace)).length).toBeGreaterThan(0)

    await host.setGrant('healthcheck', { enabled: false, permissions: [] })
    expect(await pluginCatalogTools(workspace)).toEqual([])
  })
})
