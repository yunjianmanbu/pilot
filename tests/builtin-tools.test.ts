import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  builtinToolsRootCandidates,
  ensureBuiltinTools,
  readBuiltinIndex,
} from '../src/main/agent/builtin-tools'
import { DynamicToolRegistry } from '../src/main/agent/toolsmith'

const cleanups: string[] = []
/**
 * `pack-builtin-tools.mjs` 在两种布局里的位置不同：主仓库 pilot/pilot/tests/
 * 的共享脚本在 pilot/scripts/，而拆出去的独立仓库里它被带进仓库根的 scripts/。
 * 写死 `../../scripts` 只在主仓库成立，独立仓库会指到仓库根之外。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_DIR = [join(REPO_ROOT, '..', 'scripts'), join(REPO_ROOT, 'scripts')].find(
  (dir) => existsSync(join(dir, 'pack-builtin-tools.mjs')),
)
const packScript = join(SCRIPT_DIR ?? join(REPO_ROOT, '..', 'scripts'), 'pack-builtin-tools.mjs')

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/** A minimal but valid tool, mirroring what the toolsmith writes. */
async function writeTool(
  root: string,
  name: string,
  version: number,
  stdout = 'builtin-ok',
): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'tool.json'),
    `${JSON.stringify(
      {
        name,
        description: `Fixture tool ${name} for the builtin bundle test.`,
        version,
        runtime: 'node',
        entry: 'main.js',
        test: 'test.js',
        timeoutMs: 10_000,
        risk: 'read',
        inputSchema: { type: 'object', properties: {} },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'main.js'), `process.stdout.write(${JSON.stringify(stdout)})\n`, 'utf8')
  await writeFile(
    join(dir, 'test.js'),
    "if (process.env['PILOT_SELF_TEST'] !== '1') process.exit(1)\nprocess.stdout.write('ok')\n",
    'utf8',
  )
}

function pack(from: string, out: string): void {
  const result = spawnSync(process.execPath, [packScript, '--from', from, '--out', out], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.status !== 0) {
    throw new Error(`pack script failed: ${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
}

function registry(workspacePath: string, userDataDir: string): DynamicToolRegistry {
  return new DynamicToolRegistry({
    workspacePath,
    userDataDir,
    testTargets: [],
    testCaptchaMode: 'off',
    testCaptcha: null,
  })
}

describe('builtin tool bundle', () => {
  it('resolves the packaged location before the source checkout', () => {
    const roots = builtinToolsRootCandidates({
      packaged: true,
      resourcesPath: join('opt', 'Pilot', 'resources'),
      appPath: join('opt', 'Pilot', 'resources', 'app.asar'),
      packageRoot: 'C:/npm/pilot-agent',
    })
    expect(roots[0]).toContain(join('resources', 'builtin-tools'))
    expect(roots.some((root) => root.includes('pilot-agent'))).toBe(true)
  })

  it('adopts every packed tool as an approved global tool on first run', async () => {
    const workspacePath = await tempDir('pilot-builtin-ws-')
    const userDataDir = await tempDir('pilot-builtin-data-')
    const source = await tempDir('pilot-builtin-src-')
    const bundle = await tempDir('pilot-builtin-out-')
    await writeTool(source, 'echo-probe', 1)

    pack(source, bundle)
    const index = await readBuiltinIndex(bundle)
    expect(index?.tools.map((tool) => tool.name)).toEqual(['echo-probe'])
    expect(index?.tools[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)

    const tools = registry(workspacePath, userDataDir)
    const summary = await ensureBuiltinTools(tools, { roots: [bundle] })
    expect(summary?.installed).toEqual(['echo-probe'])

    const listed = await tools.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      name: 'echo-probe',
      source: 'global',
      approved: true,
      enabled: true,
      version: 1,
    })
    // The approval is the bundled hash, so the tool runs without any manual step.
    const run = await tools.run('echo-probe', {})
    expect(run.ok).toBe(true)
    expect(run.output).toBe('builtin-ok')
  })

  it('is idempotent: a second launch changes nothing', async () => {
    const workspacePath = await tempDir('pilot-builtin-ws-')
    const userDataDir = await tempDir('pilot-builtin-data-')
    const source = await tempDir('pilot-builtin-src-')
    const bundle = await tempDir('pilot-builtin-out-')
    await writeTool(source, 'echo-probe', 1)
    pack(source, bundle)

    const tools = registry(workspacePath, userDataDir)
    await ensureBuiltinTools(tools, { roots: [bundle] })
    const second = await ensureBuiltinTools(tools, { roots: [bundle] })
    expect(second?.installed).toEqual([])
    expect(second?.updated).toEqual([])
    expect(second?.kept.map((entry) => entry.name)).toEqual(['echo-probe'])
    expect((await tools.list())[0]?.successCount).toBe(0)
  })

  it('refuses a bundle whose bytes no longer match the recorded hash', async () => {
    const workspacePath = await tempDir('pilot-builtin-ws-')
    const userDataDir = await tempDir('pilot-builtin-data-')
    const source = await tempDir('pilot-builtin-src-')
    const bundle = await tempDir('pilot-builtin-out-')
    await writeTool(source, 'echo-probe', 1)
    pack(source, bundle)

    await writeFile(join(bundle, 'echo-probe', 'main.js'), "process.exit(0)\n", 'utf8')

    const tools = registry(workspacePath, userDataDir)
    const summary = await ensureBuiltinTools(tools, { roots: [bundle] })
    expect(summary?.skipped.map((entry) => entry.name)).toEqual(['echo-probe'])
    expect(summary?.skipped[0]?.reason).toContain('SHA-256')
    expect(await tools.list()).toHaveLength(0)
  })

  it('upgrades an untouched older bundle without touching the user data', async () => {
    const workspacePath = await tempDir('pilot-builtin-ws-')
    const userDataDir = await tempDir('pilot-builtin-data-')
    const source = await tempDir('pilot-builtin-src-')
    const bundle = await tempDir('pilot-builtin-out-')
    await writeTool(source, 'echo-probe', 1)
    pack(source, bundle)

    const tools = registry(workspacePath, userDataDir)
    await ensureBuiltinTools(tools, { roots: [bundle] })

    await writeTool(source, 'echo-probe', 2, 'builtin-v2')
    pack(source, bundle)
    const upgraded = await ensureBuiltinTools(tools, { roots: [bundle] })
    expect(upgraded?.updated).toEqual(['echo-probe'])
    const listed = (await tools.list())[0]
    expect(listed?.version).toBe(2)
    expect(listed?.approved).toBe(true)
    expect((await tools.run('echo-probe', {})).output).toBe('builtin-v2')
  })

  it('never overwrites a global tool the user edited', async () => {
    const workspacePath = await tempDir('pilot-builtin-ws-')
    const userDataDir = await tempDir('pilot-builtin-data-')
    const source = await tempDir('pilot-builtin-src-')
    const bundle = await tempDir('pilot-builtin-out-')
    await writeTool(source, 'echo-probe', 1)
    pack(source, bundle)

    const tools = registry(workspacePath, userDataDir)
    await ensureBuiltinTools(tools, { roots: [bundle] })

    const edited = join(userDataDir, 'tools', 'global', 'echo-probe', 'main.js')
    await writeFile(edited, "process.stdout.write('mine')\n", 'utf8')

    await writeTool(source, 'echo-probe', 2, 'builtin-v2')
    pack(source, bundle)
    const summary = await ensureBuiltinTools(tools, { roots: [bundle] })
    expect(summary?.kept[0]?.reason).toContain('未覆盖')
    expect(await readFile(edited, 'utf8')).toContain('mine')
  })

  it('re-approves unchanged bundled bytes after the registry entry is lost', async () => {
    const workspacePath = await tempDir('pilot-builtin-ws-')
    const userDataDir = await tempDir('pilot-builtin-data-')
    const source = await tempDir('pilot-builtin-src-')
    const bundle = await tempDir('pilot-builtin-out-')
    await writeTool(source, 'echo-probe', 1)
    pack(source, bundle)

    const tools = registry(workspacePath, userDataDir)
    await ensureBuiltinTools(tools, { roots: [bundle] })
    await rm(join(userDataDir, 'tool-registry.json'), { force: true })
    expect((await tools.list())[0]?.approved).toBe(false)

    await ensureBuiltinTools(tools, { roots: [bundle] })
    expect((await tools.list())[0]?.approved).toBe(true)
    expect((await tools.run('echo-probe', {})).ok).toBe(true)
  })

  it('ignores a directory without an index and survives a broken one', async () => {
    const workspacePath = await tempDir('pilot-builtin-ws-')
    const userDataDir = await tempDir('pilot-builtin-data-')
    const empty = await tempDir('pilot-builtin-empty-')
    const broken = await tempDir('pilot-builtin-broken-')
    await writeFile(join(broken, 'index.json'), '{ not json', 'utf8')

    const tools = registry(workspacePath, userDataDir)
    expect(await ensureBuiltinTools(tools, { roots: [empty] })).toBeNull()
    expect(await ensureBuiltinTools(tools, { roots: [broken] })).toBeNull()
    expect(await tools.list()).toHaveLength(0)
  })
})
