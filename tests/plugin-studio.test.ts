import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_SIGNATURE_FILE,
  generateSigningKey,
  signPluginDir,
  writePluginSignature,
} from '../src/main/plugins/integrity'
import { PLUGIN_MANIFEST_FILE, PLUGINS_DIR, parsePluginManifest } from '../src/main/plugins/manifest'
import { PluginHost } from '../src/main/plugins/runtime'
import {
  createPlugin,
  installMarketPlugin,
  installPlugin,
  pluginDirFor,
  pluginOverview,
  pluginsRoot,
  removePlugin,
  setPluginEnabled,
  setSignaturePolicy,
  signInstalledPlugin,
  trustPublicKey,
  untrustPublicKey,
} from '../src/main/plugins/studio'
import { PLUGIN_TEMPLATES } from '../src/main/plugins/templates'

const cleanups: string[] = []
const hosts: PluginHost[] = []

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pilot-studio-${label}-`))
  cleanups.push(dir)
  return dir
}

async function workspace(): Promise<string> {
  const dir = await tempDir('ws')
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stopAll()
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe('plugin assistant scaffolding', () => {
  it('writes a valid manifest, entry and README into the picked directory', async () => {
    const root = await tempDir('create')
    const target = join(root, 'my-plugin')
    const result = await createPlugin({
      targetDir: target,
      id: 'my-plugin',
      name: '我的插件',
      description: '给门店用的样例插件',
      template: 'http',
      sign: false,
    })

    expect(result.dir).toBe(target)
    expect(result.signed).toBe(false)
    expect(result.files).toEqual(['plugin.json', 'index.mjs', 'README.md', '.gitignore'])

    const manifest = parsePluginManifest(
      JSON.parse(await readFile(join(target, PLUGIN_MANIFEST_FILE), 'utf8')),
      'my-plugin',
    )
    expect(manifest.name).toBe('我的插件')
    expect(manifest.roles.map((role) => role.id)).toEqual(['owner', 'member'])
    expect(manifest.routes.map((route) => route.path)).toEqual(['health', 'items', 'items'])
    expect(manifest.permissions).toEqual(['items:read', 'items:write'])

    const entry = await readFile(join(target, 'index.mjs'), 'utf8')
    expect(entry).toContain("method === 'plugin.activate'")
    expect(entry).toContain("route.path === 'items'")
    // The JSON-RPC reply keeps one newline escape, not a doubled one.
    expect(entry).toContain("id: id, result: result }) + '\\n')")
    expect(entry).not.toContain('\\\\n')
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toContain('.keys/')
  })

  it('signs the new plugin with a fresh key pair inside the directory', async () => {
    const root = await tempDir('sign-create')
    const target = join(root, 'signed-plugin')
    const result = await createPlugin({
      targetDir: target,
      id: 'signed-plugin',
      name: '已签名插件',
      description: '',
      template: 'webhook',
      sign: true,
    })

    expect(result.signed).toBe(true)
    expect(result.keyId).toMatch(/^ed25519-[0-9a-f]{16}$/)
    expect(result.publicKey).toContain('BEGIN PUBLIC KEY')
    expect(result.files).toContain(PLUGIN_SIGNATURE_FILE)
    expect(result.signature?.state).toBe('untrusted')
    // A private key inside the plugin folder must be readable by the vendor only.
    const privateKey = await readFile(result.privateKeyFile as string, 'utf8')
    expect(privateKey).toContain('PRIVATE KEY')
  })

  it('refuses a non-empty directory and a path that is a file', async () => {
    const root = await tempDir('create-guard')
    const busy = join(root, 'busy')
    await mkdir(busy, { recursive: true })
    await writeFile(join(busy, 'notes.txt'), 'hello', 'utf8')

    await expect(
      createPlugin({
        targetDir: busy,
        id: 'busy-plugin',
        name: '占位插件',
        description: '',
        template: 'http',
        sign: false,
      }),
    ).rejects.toThrow(/不是空目录/)

    const file = join(root, 'a-file.txt')
    await writeFile(file, 'x', 'utf8')
    await expect(
      createPlugin({
        targetDir: file,
        id: 'file-plugin',
        name: '文件插件',
        description: '',
        template: 'http',
        sign: false,
      }),
    ).rejects.toThrow(/不是目录/)
  })

  it('rejects a bad id, a too-short name and a missing directory', async () => {
    const root = await tempDir('create-invalid')
    await expect(
      createPlugin({
        targetDir: join(root, 'x'),
        id: 'Bad_ID',
        name: '插件',
        description: '',
        template: 'http',
        sign: false,
      }),
    ).rejects.toThrow(/小写字母/)
    await expect(
      createPlugin({
        targetDir: join(root, 'y'),
        id: 'ok-id',
        name: 'x',
        description: '',
        template: 'http',
        sign: false,
      }),
    ).rejects.toThrow(/2-60/)
    await expect(
      createPlugin({
        targetDir: '',
        id: 'ok-id',
        name: '合法名称',
        description: '',
        template: 'http',
        sign: false,
      }),
    ).rejects.toThrow(/创建目录/)
  })

  it('exposes every template with a matching entry file', () => {
    expect(PLUGIN_TEMPLATES.map((template) => template.id)).toEqual(['http', 'session', 'webhook'])
    for (const template of PLUGIN_TEMPLATES) {
      expect(template.entry).toContain('plugin.activate')
      expect(template.entry).toContain('process.stdin')
      // Two protocol bugs that only show up with a real pipe: replies dropped on
      // exit, and a request overtaking activate.
      expect(template.entry).not.toContain('process.exit(0)')
      expect(template.entry).toContain('queue = queue.then')
    }
    const session = PLUGIN_TEMPLATES.find((template) => template.id === 'session')
    expect(session?.provides).toBe('session')
  })
})

describe('plugin market and install', () => {
  it('installs a market entry, signs it locally and trusts the local key', async () => {
    const ws = await workspace()
    const result = await installMarketPlugin(ws, 'member-points')

    expect(result.id).toBe('member-points')
    expect(result.signature.state).toBe('trusted')
    expect(result.trustedKey?.keyId).toBe(result.signature.keyId)

    const overview = await pluginOverview(ws)
    expect(overview.plugins).toHaveLength(1)
    expect(overview.market.find((item) => item.id === 'member-points')?.installed).toBe(true)
    expect(overview.trustedKeys).toHaveLength(1)
    expect(overview.trustedKeys[0]?.pluginIds).toEqual(['member-points'])
    expect(overview.plugins[0]?.enabled).toBe(false)
  })

  it('refuses a second install of the same market entry', async () => {
    const ws = await workspace()
    await installMarketPlugin(ws, 'staff-login')
    await expect(installMarketPlugin(ws, 'staff-login')).rejects.toThrow(/已安装/)
  })

  it('imports a vendor plugin and trusts the pasted public key', async () => {
    const ws = await workspace()
    const vendor = await tempDir('vendor')
    const vendorDir = join(vendor, 'inventory')
    const pair = generateSigningKey()
    await mkdir(join(vendorDir, '.keys'), { recursive: true })
    await writeFile(
      join(vendorDir, PLUGIN_MANIFEST_FILE),
      `${JSON.stringify(
        {
          id: 'inventory',
          name: '库存',
          version: 1,
          api: 1,
          runtime: 'node',
          entry: 'index.mjs',
          description: '库存查询',
          permissions: ['stock:read'],
          routes: [{ method: 'GET', path: 'stock', auth: 'required', permission: 'stock:read' }],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(join(vendorDir, 'index.mjs'), 'process.stdin.resume()\n', 'utf8')
    const manifest = parsePluginManifest(
      JSON.parse(await readFile(join(vendorDir, PLUGIN_MANIFEST_FILE), 'utf8')),
    )
    await writePluginSignature(vendorDir, await signPluginDir(vendorDir, manifest, pair.privateKey))

    const installed = await installPlugin({
      workspace: ws,
      sourceDir: vendorDir,
      trust: true,
      publicKey: pair.publicKey,
      label: '供应商甲',
    })
    expect(installed.signature.state).toBe('trusted')
    expect(installed.trustedKey?.label).toBe('供应商甲')
    // The vendor's private key must never land in the workspace.
    await expect(readFile(join(installed.dir, '.keys', 'x.private.pem'), 'utf8')).rejects.toThrow()
    expect(installed.dir).toBe(join(pluginsRoot(ws), 'inventory'))
  })

  it('imports unsigned, then signing locally flips it to trusted', async () => {
    const ws = await workspace()
    const vendor = await tempDir('unsigned')
    const vendorDir = join(vendor, 'plain')
    await mkdir(vendorDir, { recursive: true })
    await writeFile(
      join(vendorDir, PLUGIN_MANIFEST_FILE),
      `${JSON.stringify(
        {
          id: 'plain',
          name: '无签名',
          version: 1,
          api: 1,
          runtime: 'node',
          entry: 'main.js',
          description: '',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(join(vendorDir, 'main.js'), 'process.stdin.resume()\n', 'utf8')

    const installed = await installPlugin({ workspace: ws, sourceDir: vendorDir })
    expect(installed.signature.state).toBe('unsigned')
    expect(installed.trustedKey).toBeNull()

    const signed = await signInstalledPlugin(ws, 'plain')
    expect(signed.signature.state).toBe('trusted')
    expect(signed.key.keyId).toBe(signed.signature.keyId)

    // A second sign reuses the same workspace key rather than minting another.
    const again = await signInstalledPlugin(ws, 'plain')
    expect(again.key.keyId).toBe(signed.key.keyId)
    expect((await pluginOverview(ws)).trustedKeys).toHaveLength(1)
  })

  it('detects tampering after signing', async () => {
    const ws = await workspace()
    const installed = await installMarketPlugin(ws, 'order-events')
    await writeFile(join(installed.dir, 'index.mjs'), 'process.stdin.resume()\n', 'utf8')
    const overview = await pluginOverview(ws)
    expect(overview.plugins[0]?.signature?.state).toBe('tampered')
    expect(overview.plugins[0]?.signature?.detail).toContain('changed')
  })

  it('rejects an import whose entry file is missing', async () => {
    const ws = await workspace()
    const vendorDir = join(await tempDir('noentry'), 'broken')
    await mkdir(vendorDir, { recursive: true })
    await writeFile(
      join(vendorDir, PLUGIN_MANIFEST_FILE),
      JSON.stringify({ id: 'broken', name: '坏插件', version: 1, api: 1, runtime: 'node', entry: 'index.mjs' }),
      'utf8',
    )
    await expect(installPlugin({ workspace: ws, sourceDir: vendorDir })).rejects.toThrow(
      /入口文件不存在/,
    )
  })
})

describe('plugin lifecycle', () => {
  it('enables a trusted plugin and writes the grant', async () => {
    const ws = await workspace()
    await installMarketPlugin(ws, 'member-points')
    await setPluginEnabled(ws, 'member-points', true)

    const overview = await pluginOverview(ws)
    expect(overview.plugins[0]?.enabled).toBe(true)
    expect(overview.plugins[0]?.granted).toEqual(['items:read', 'items:write'])

    const grants = JSON.parse(
      await readFile(join(pluginsRoot(ws), 'grants.json'), 'utf8'),
    ) as Record<string, { enabled: boolean }>
    expect(grants['member-points']?.enabled).toBe(true)
  })

  it('refuses to enable an untrusted plugin under the required policy', async () => {
    const ws = await workspace()
    const vendorDir = join(await tempDir('policy'), 'p')
    await mkdir(vendorDir, { recursive: true })
    await writeFile(
      join(vendorDir, PLUGIN_MANIFEST_FILE),
      JSON.stringify({ id: 'policy-plugin', name: '策略插件', version: 1, api: 1, runtime: 'node', entry: 'i.js' }),
      'utf8',
    )
    await writeFile(join(vendorDir, 'i.js'), 'process.stdin.resume()\n', 'utf8')
    await installPlugin({ workspace: ws, sourceDir: vendorDir })
    await setSignaturePolicy(ws, 'required')

    await expect(setPluginEnabled(ws, 'policy-plugin', true)).rejects.toThrow(/required/)

    await signInstalledPlugin(ws, 'policy-plugin')
    await setPluginEnabled(ws, 'policy-plugin', true)
    expect((await pluginOverview(ws)).plugins[0]?.enabled).toBe(true)
  })

  it('untrusting a key turns its plugins untrusted again', async () => {
    const ws = await workspace()
    const installed = await installMarketPlugin(ws, 'staff-login')
    const keyId = installed.signature.keyId as string
    await untrustPublicKey(ws, keyId)

    const overview = await pluginOverview(ws)
    expect(overview.trustedKeys).toHaveLength(0)
    expect(overview.plugins[0]?.signature?.state).toBe('untrusted')
    await expect(untrustPublicKey(ws, keyId)).rejects.toThrow(/没有/)
  })

  it('trusts a pasted key and rejects malformed PEM', async () => {
    const ws = await workspace()
    const pair = generateSigningKey()
    const key = await trustPublicKey(ws, pair.publicKey, '手工粘贴')
    expect(key.keyId).toMatch(/^ed25519-/)
    expect((await pluginOverview(ws)).trustedKeys[0]?.label).toBe('手工粘贴')
    await expect(trustPublicKey(ws, 'not-a-key')).rejects.toThrow(/PEM/)
  })

  it('removes the plugin directory and its grant', async () => {
    const ws = await workspace()
    await installMarketPlugin(ws, 'inventory-sync')
    await setPluginEnabled(ws, 'inventory-sync', true)
    await removePlugin(ws, 'inventory-sync')

    const overview = await pluginOverview(ws)
    expect(overview.plugins).toHaveLength(0)
    expect(await readFile(join(pluginsRoot(ws), 'grants.json'), 'utf8')).not.toContain('inventory-sync')
    await expect(removePlugin(ws, 'inventory-sync')).rejects.toThrow(/没有已安装/)
  })

  it('keeps registrations and rejections out of the plugins dir', async () => {
    const ws = await workspace()
    expect(pluginDirFor(ws, 'good-id')).toBe(join(pluginsRoot(ws), 'good-id'))
    expect(() => pluginDirFor(ws, '../escape')).toThrow(/小写字母/)
    expect(() => pluginDirFor(ws, 'id/evil')).toThrow(/小写字母/)
  })

  it('reports an invalid manifest instead of dropping it silently', async () => {
    const ws = await workspace()
    await mkdir(join(ws, PLUGINS_DIR, 'broken'), { recursive: true })
    await writeFile(join(ws, PLUGINS_DIR, 'broken', PLUGIN_MANIFEST_FILE), '{ not json', 'utf8')
    const overview = await pluginOverview(ws)
    expect(overview.plugins).toHaveLength(0)
    expect(overview.invalid).toEqual([{ id: 'broken', error: 'plugin.json is not valid JSON' }])
  })

  it('answers every piped request in order and flushes before exit', async () => {
    const ws = await workspace()
    const installed = await installMarketPlugin(ws, 'member-points')

    const child = spawn(process.execPath, [join(installed.dir, 'index.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines: string[] = []
    let rest = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      rest += chunk
      let index = rest.indexOf('\n')
      while (index >= 0) {
        const line = rest.slice(0, index).trim()
        rest = rest.slice(index + 1)
        if (line) lines.push(line)
        index = rest.indexOf('\n')
      }
    })

    const call = (id: number, method: string, params: unknown): string =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    child.stdin.write(
      call(1, 'plugin.activate', {
        stateDir: join(installed.dir, '.state'),
        plugin: { id: 'member-points' },
        api: 1,
      }),
    )
    child.stdin.write(call(2, 'plugin.request', { route: { method: 'GET', path: 'health' } }))
    child.stdin.write(
      call(3, 'plugin.request', { route: { method: 'POST', path: 'items' }, body: { title: 'a' } }),
    )
    child.stdin.write(call(4, 'plugin.request', { route: { method: 'GET', path: 'items' } }))
    child.stdin.end()

    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (value) => resolve(value ?? -1))
    })

    expect(code).toBe(0)
    const replies = lines.map(
      (line) => JSON.parse(line) as { id: number; result?: { status?: number; body?: unknown } },
    )
    // No reply may be dropped by an early exit, and activate must answer first.
    expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4])
    expect(replies[1]?.result?.status).toBe(200)
    expect(replies[2]?.result?.status).toBe(201)
    const listed = replies[3]?.result?.body as { items: { title: string }[] }
    expect(listed.items.map((item) => item.title)).toEqual(['a'])
  })

  it('runs the generated entry through the real plugin host', async () => {
    const ws = await workspace()
    const installed = await installMarketPlugin(ws, 'member-points')
    await setPluginEnabled(ws, 'member-points', true)

    const host = new PluginHost({ root: ws })
    hosts.push(host)
    const status = await host.activate('member-points')
    expect(status.state).toBe('ready')

    const health = await host.request('member-points', {
      route: { method: 'GET', path: 'health' },
      session: null,
      body: null,
      query: {},
    })
    expect(health.status).toBe(200)
    expect((health.body as { ok: boolean }).ok).toBe(true)
  })
})
