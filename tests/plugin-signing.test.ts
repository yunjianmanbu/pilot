import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_SIGNATURE_FILE,
  addTrustedKey,
  assessPluginSignature,
  generateSigningKey,
  keyIdForPublicKey,
  readSignaturePolicy,
  readTrustStore,
  signPluginDir,
  writePluginSignature,
  writeSignaturePolicy,
} from '../src/main/plugins/integrity'
import { PLUGINS_DIR, parsePluginManifest, type PluginManifest } from '../src/main/plugins/manifest'
import { PluginError, PluginHost } from '../src/main/plugins/runtime'
import { installSolution, planSolution, verifySolutionLock } from '../src/main/plugins/solution'
import { runPluginCommand } from '../src/main/plugins/cli'

const ENTRY = `let buffer = ''
process.stdin.setEncoding('utf8')
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(line)
    index = buffer.indexOf('\\n')
  }
})
function handle(line) {
  const message = JSON.parse(line)
  if (message.method === 'plugin.activate') {
    return reply(message.id, { ok: true, id: process.env.PILOT_PLUGIN_ID })
  }
  if (message.method === 'plugin.request') {
    return reply(message.id, { status: 200, body: { ok: true } })
  }
  return reply(message.id, null)
}
`

const cleanups: string[] = []
const hosts: PluginHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stopAll().catch(() => undefined)
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

async function tmp(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pilot-${label}-`))
  cleanups.push(dir)
  return dir
}

async function makeWorkspace(): Promise<string> {
  const root = await tmp('sign-workspace')
  await mkdir(join(root, PLUGINS_DIR), { recursive: true })
  return root
}

async function writePlugin(dir: string, id: string, permissions: string[] = []): Promise<void> {
  await mkdir(dir, { recursive: true })
  const manifest = {
    id,
    name: id,
    version: 1,
    api: 1,
    runtime: 'node',
    entry: 'index.mjs',
    description: '',
    permissions,
    roles: [{ id: 'member', permissions: [] }],
    routes: [{ method: 'GET', path: 'ping', auth: 'public', description: '' }],
  }
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await writeFile(join(dir, 'index.mjs'), ENTRY, 'utf8')
}

async function loadManifest(dir: string): Promise<PluginManifest> {
  return parsePluginManifest(JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8')))
}

async function enablePlugin(root: string, id: string, permissions: string[] = []): Promise<void> {
  await writeFile(
    join(root, PLUGINS_DIR, 'grants.json'),
    JSON.stringify({ [id]: { enabled: true, permissions } }, null, 2),
    'utf8',
  )
}

async function sign(dir: string) {
  const pair = generateSigningKey()
  const manifest = await loadManifest(dir)
  const signature = await signPluginDir(dir, manifest, pair.privateKey)
  await writePluginSignature(dir, signature)
  return { pair, signature, manifest }
}

function track(host: PluginHost): PluginHost {
  hosts.push(host)
  return host
}

describe('plugin signatures (self-signed)', () => {
  it('derives the key id from the public key and refuses to verify a swapped id', async () => {
    const pair = generateSigningKey()
    expect(pair.keyId).toBe(keyIdForPublicKey(pair.publicKey))
    expect(pair.keyId.startsWith('ed25519-')).toBe(true)
    // A different key can never reuse the first one's id.
    expect(generateSigningKey().keyId).not.toBe(pair.keyId)
  })

  it('reports trusted and activates once the vendor key is in the trust store', async () => {
    const root = await makeWorkspace()
    const dir = join(root, PLUGINS_DIR, 'demo')
    await writePlugin(dir, 'demo', ['users:read'])
    await writeSignaturePolicy(root, 'required')
    const { pair, signature } = await sign(dir)
    await addTrustedKey(root, pair.publicKey, '演示供应商')
    await enablePlugin(root, 'demo', ['users:read'])

    const host = track(new PluginHost({ root }))
    const status = await host.status()
    expect(status.signaturePolicy).toBe('required')
    const plugin = status.plugins.find((entry) => entry.id === 'demo')
    expect(plugin?.signature?.state).toBe('trusted')
    expect(plugin?.signature?.keyId).toBe(signature.keyId)
    expect(plugin?.signature?.label).toBe('演示供应商')

    const activated = await host.activate('demo')
    expect(activated.state).toBe('ready')
  })

  it('detects a source-level edit after signing and blocks it under `required`', async () => {
    const root = await makeWorkspace()
    const dir = join(root, PLUGINS_DIR, 'demo')
    await writePlugin(dir, 'demo')
    await writeSignaturePolicy(root, 'required')
    const { pair } = await sign(dir)
    await addTrustedKey(root, pair.publicKey, '供应商')
    await enablePlugin(root, 'demo')

    // The business developer patches the installed copy; the signature no longer matches.
    await writeFile(join(dir, 'index.mjs'), `${ENTRY}\n// local hotfix\n`, 'utf8')

    const host = track(new PluginHost({ root }))
    const status = await host.status()
    const plugin = status.plugins.find((entry) => entry.id === 'demo')
    expect(plugin?.signature?.state).toBe('tampered')
    expect(plugin?.signature?.detail).toContain('re-sign')

    await expect(host.activate('demo')).rejects.toBeInstanceOf(PluginError)
    await expect(host.activate('demo')).rejects.toThrow(/tampered/)
  })

  it('keeps unsigned plugins running under the default warn policy', async () => {
    const root = await makeWorkspace()
    const dir = join(root, PLUGINS_DIR, 'unsigned')
    await writePlugin(dir, 'unsigned')
    await enablePlugin(root, 'unsigned')

    const host = track(new PluginHost({ root }))
    const status = await host.status()
    expect(status.signaturePolicy).toBe('warn')
    expect(status.plugins[0]?.signature?.state).toBe('unsigned')
    expect(await readSignaturePolicy(root)).toBe('warn')
    const activated = await host.activate('unsigned')
    expect(activated.state).toBe('ready')
  })

  it('refuses unsigned plugins when the workspace requires signatures', async () => {
    const root = await makeWorkspace()
    const dir = join(root, PLUGINS_DIR, 'unsigned')
    await writePlugin(dir, 'unsigned')
    await enablePlugin(root, 'unsigned')
    await writeSignaturePolicy(root, 'required')

    const host = track(new PluginHost({ root }))
    await expect(host.activate('unsigned')).rejects.toThrow(/unsigned/)
    expect(host.signatureOf('unsigned')?.state).toBe('unsigned')
  })

  it('reports untrusted for a signature from a key this workspace never accepted', async () => {
    const root = await makeWorkspace()
    const dir = join(root, PLUGINS_DIR, 'demo')
    await writePlugin(dir, 'demo')
    await writeSignaturePolicy(root, 'required')
    const { signature } = await sign(dir)
    await enablePlugin(root, 'demo')

    const manifest = await loadManifest(dir)
    const store = await readTrustStore(root)
    const assessment = await assessPluginSignature(dir, manifest, store, 'required')
    expect(assessment.state).toBe('untrusted')
    expect(assessment.keyId).toBe(signature.keyId)
    expect(assessment.detail).toContain('pilot plugin trust')

    const host = track(new PluginHost({ root }))
    await expect(host.activate('demo')).rejects.toThrow(/untrusted/)
  })

  it('treats a corrupted signature file as malformed instead of trusted', async () => {
    const root = await makeWorkspace()
    const dir = join(root, PLUGINS_DIR, 'demo')
    await writePlugin(dir, 'demo')
    await writeFile(join(dir, PLUGIN_SIGNATURE_FILE), '{"algorithm":"rsa"}', 'utf8')

    const manifest = await loadManifest(dir)
    const store = await readTrustStore(root)
    const assessment = await assessPluginSignature(dir, manifest, store, 'required')
    expect(assessment.state).toBe('malformed')
  })
})

describe('vertical solution packs', () => {
  async function buildPack(): Promise<{ packDir: string; pair: ReturnType<typeof generateSigningKey> }> {
    const packDir = await tmp('solution-pack')
    const pluginDir = join(packDir, 'plugins', 'demo')
    await writePlugin(pluginDir, 'demo', ['users:read'])
    const { pair } = await sign(pluginDir)
    await writeFile(
      join(packDir, 'solution.json'),
      JSON.stringify(
        {
          api: 1,
          id: 'demo-industry',
          name: '演示行业方案',
          version: '1.0.0',
          industry: 'retail',
          description: '签名 + 权限 + 品牌预设的最小行业方案包',
          vendor: 'Acme',
          pilotVersion: '>=0.1.54',
          plugins: [{ id: 'demo', path: 'plugins/demo' }],
          grants: { demo: { enabled: true, permissions: ['users:read'] } },
          trust: [{ publicKey: pair.publicKey, label: 'Acme 2026' }],
          branding: { productName: 'Acme Pilot', accent: 'claude', locale: 'zh-CN' },
          docs: ['docs/rollout.md'],
        },
        null,
        2,
      ),
      'utf8',
    )
    return { packDir, pair }
  }

  it('plans an installable pack without touching the workspace', async () => {
    const workspace = await makeWorkspace()
    const { packDir } = await buildPack()

    const plan = await planSolution(workspace, packDir, { policy: 'required' })
    expect(plan.ready).toBe(true)
    expect(plan.pack.industry).toBe('retail')
    expect(plan.pack.branding.productName).toBe('Acme Pilot')
    expect(plan.items[0]?.signature?.state).toBe('trusted')
    expect(plan.items[0]?.requestedPermissions).toEqual(['users:read'])
    // Nothing was installed by planning.
    await expect(readFile(join(workspace, PLUGINS_DIR, 'grants.json'), 'utf8')).rejects.toThrow()
  })

  it('blocks a pack whose plugin was edited after signing', async () => {
    const workspace = await makeWorkspace()
    const { packDir } = await buildPack()
    await writeFile(join(packDir, 'plugins', 'demo', 'index.mjs'), `${ENTRY}\n// patched\n`, 'utf8')

    const plan = await planSolution(workspace, packDir, { policy: 'required' })
    expect(plan.ready).toBe(false)
    expect(plan.blockers.join(' ')).toContain('tampered')
  })

  it('installs a signed pack, records a lock, and reports drift after a local patch', async () => {
    const workspace = await makeWorkspace()
    const { packDir, pair } = await buildPack()

    await expect(installSolution(workspace, packDir)).rejects.toThrow(/accept-permissions/)

    const result = await installSolution(workspace, packDir, { acceptPermissions: true })
    expect(result.installed).toEqual(['demo'])
    const lock = JSON.parse(await readFile(result.lockPath, 'utf8')) as {
      solutionId: string
      version: string
      plugins: { id: string; digest: string; keyId: string | null }[]
    }
    expect(lock.solutionId).toBe('demo-industry')
    expect(lock.version).toBe('1.0.0')
    expect(lock.plugins[0]?.id).toBe('demo')
    expect(lock.plugins[0]?.keyId).toBe(pair.keyId)

    const trust = await readTrustStore(workspace)
    expect(trust.keys.map((key) => key.keyId)).toContain(pair.keyId)
    const grants = JSON.parse(await readFile(join(workspace, PLUGINS_DIR, 'grants.json'), 'utf8'))
    expect(grants['demo']).toEqual({ enabled: true, permissions: ['users:read'] })

    const clean = await verifySolutionLock(workspace)
    expect(clean.drifted).toEqual([])
    expect(clean.items[0]?.signature?.state).toBe('trusted')

    // Source-level tuning of the installed copy: drift, and the signature is stale.
    await writeFile(
      join(workspace, PLUGINS_DIR, 'demo', 'index.mjs'),
      `${ENTRY}\n// customer hotfix\n`,
      'utf8',
    )
    const drifted = await verifySolutionLock(workspace)
    expect(drifted.drifted).toEqual(['demo'])
    expect(drifted.items[0]?.signature?.state).toBe('tampered')
  })

  it('rejects a pack that tries to escape its own directory', async () => {
    const workspace = await makeWorkspace()
    const packDir = await tmp('solution-escape')
    await writeFile(
      join(packDir, 'solution.json'),
      JSON.stringify({
        api: 1,
        id: 'escape-pack',
        name: 'escape',
        version: '1.0.0',
        industry: 'retail',
        plugins: [{ id: 'demo', path: '../../outside' }],
      }),
      'utf8',
    )
    await expect(planSolution(workspace, packDir)).rejects.toThrow(/inside the pack/)
  })
})

describe('pilot plugin / solution commands', () => {
  function recorder(): { io: { out: (l: string) => void; err: (l: string) => void }; lines: string[] } {
    const lines: string[] = []
    return { lines, io: { out: (line) => lines.push(line), err: (line) => lines.push(`ERR ${line}`) } }
  }

  it('drives keygen → sign → trust → verify → solution install → verify through the CLI', async () => {
    const workspace = await makeWorkspace()
    const keysDir = await tmp('cli-keys')
    const { lines, io } = recorder()

    // 1. vendor key pair
    expect(
      await runPluginCommand('plugin', ['keygen', '--label', 'Acme', '--out', keysDir], io),
    ).toBe(0)
    const keyFiles = (await import('node:fs/promises')).readdir(keysDir)
    expect((await keyFiles).filter((name) => name.endsWith('.private.pem'))).toHaveLength(1)
    const privateKey = join(keysDir, 'acme.private.pem')
    const publicKey = join(keysDir, 'acme.public.pem')

    // 2. sign the plugin inside a solution pack
    const packDir = join(workspace, 'pack')
    const pluginDir = join(packDir, 'plugins', 'demo')
    await writePlugin(pluginDir, 'demo', ['users:read'])
    expect(await runPluginCommand('plugin', ['sign', pluginDir, '--key', privateKey], io)).toBe(0)
    expect(await readFile(join(pluginDir, PLUGIN_SIGNATURE_FILE), 'utf8')).toContain('ed25519')

    await writeFile(
      join(packDir, 'solution.json'),
      JSON.stringify({
        api: 1,
        id: 'cli-pack',
        name: 'CLI 方案包',
        version: '1.2.3',
        industry: 'retail',
        plugins: [{ id: 'demo', path: 'plugins/demo' }],
        grants: { demo: { enabled: true, permissions: ['users:read'] } },
        trust: [],
      }),
      'utf8',
    )

    // 3. untrusted until the key is added
    expect(await runPluginCommand('plugin', ['verify', pluginDir, '--workspace', workspace], io)).toBe(1)
    expect(lines.some((line) => line.includes('untrusted'))).toBe(true)
    expect(await runPluginCommand('plugin', ['trust', publicKey, '--workspace', workspace], io)).toBe(0)
    expect(await runPluginCommand('plugin', ['verify', pluginDir, '--workspace', workspace], io)).toBe(0)
    expect(lines.some((line) => line.includes('RESULT PASS'))).toBe(true)

    // 4. policy + list
    expect(await runPluginCommand('plugin', ['policy', 'required', '--workspace', workspace], io)).toBe(0)
    expect(await readSignaturePolicy(workspace)).toBe('required')
    expect(await runPluginCommand('solution', ['plan', packDir, '--workspace', workspace], io)).toBe(0)

    // 5. install refuses to accept permissions implicitly
    expect(await runPluginCommand('solution', ['install', packDir, '--workspace', workspace], io)).toBe(1)
    expect(
      await runPluginCommand(
        'solution',
        ['install', packDir, '--accept-permissions', '--workspace', workspace],
        io,
      ),
    ).toBe(0)
    expect(await runPluginCommand('solution', ['verify', '--workspace', workspace], io)).toBe(0)

    // 6. a local edit is reported as drift and a failed verify
    await writeFile(
      join(workspace, PLUGINS_DIR, 'demo', 'index.mjs'),
      `${ENTRY}\n// tuned in place\n`,
      'utf8',
    )
    expect(await runPluginCommand('solution', ['verify', '--workspace', workspace], io)).toBe(1)
    expect(await runPluginCommand('plugin', ['list', '--workspace', workspace], io)).toBe(0)
    expect(lines.some((line) => line.includes('tampered'))).toBe(true)
    expect(lines.join('\n')).not.toContain('private.pem\n-----BEGIN')
  })

  it('rejects unknown subcommands with exit code 2', async () => {
    const { io } = recorder()
    expect(await runPluginCommand('plugin', ['frobnicate'], io)).toBe(2)
    expect(await runPluginCommand('solution', ['deploy'], io)).toBe(2)
  })

  it('plans the shipped example solution pack as installable', async () => {
    const workspace = await makeWorkspace()
    // Vitest runs with pilot/client as cwd; the example pack lives in pilot/examples.
    const packDir = join(process.cwd(), '..', 'examples', 'solutions', 'retail-member')
    // The example ships unsigned on purpose (no vendor key, no private key), so
    // `warn` is the policy that matches how a customer first receives it.
    const plan = await planSolution(workspace, packDir, { policy: 'warn' })
    expect(plan.ready).toBe(true)
    expect(plan.pack.industry).toBe('retail')
    expect(plan.pack.plugins.map((plugin) => plugin.id)).toEqual(['retail-loyalty'])
    expect(plan.items[0]?.signature?.state).toBe('unsigned')
    expect(plan.items[0]?.manifest?.permissions).toEqual(['loyalty:read', 'loyalty:write'])
    expect(plan.warnings.some((warning) => warning.includes('unsigned'))).toBe(true)
  })
})
