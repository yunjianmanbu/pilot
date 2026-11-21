import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DynamicToolRegistry, isAllowedTestTarget } from '../src/main/agent/toolsmith'
import {
  executePilotTool,
  LIST_TOOLS,
  PROMOTE_TOOL,
  ROLLBACK_TOOL,
  type ToolHost,
} from '../src/main/agent/tools'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-toolsmith-ws-'))
  cleanups.push(dir)
  return dir
}

async function userData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-toolsmith-data-'))
  cleanups.push(dir)
  return dir
}

const ENTRY = `let raw = ''
process.stdin.on('data', (chunk) => { raw += chunk })
process.stdin.on('end', () => {
  const args = JSON.parse(raw || '{}')
  process.stdout.write('echo:' + String(args.name))
})
`

const PASSING_TEST = `process.exit(process.env.PILOT_SELF_TEST === '1' ? 0 : 1)
`

async function createTool(
  root: string,
  name: string,
  overrides: Record<string, unknown> = {},
  testBody = PASSING_TEST,
): Promise<void> {
  const dir = join(root, '.pilot', 'tools', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'tool.json'),
    `${JSON.stringify(
      {
        name,
        description: 'Echo a name back from stdin.',
        version: 1,
        runtime: 'node',
        entry: 'main.js',
        test: 'test.js',
        timeoutMs: 10_000,
        risk: 'exec',
        targets: [],
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        verification: true,
        ...overrides,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'main.js'), ENTRY, 'utf8')
  await writeFile(join(dir, 'test.js'), testBody, 'utf8')
}

function registry(root: string, data: string, targets: string[] = []): DynamicToolRegistry {
  return new DynamicToolRegistry({
    workspacePath: root,
    userDataDir: data,
    testTargets: targets,
    testCaptchaMode: 'off',
    testCaptcha: null,
  })
}

describe('bundled tool templates', () => {
  it('registers the bulk-login template after its local self-test', async () => {
    const root = await workspace()
    const data = await userData()
    const source = join(process.cwd(), 'scripts', 'tool-templates', 'bulk-login')
    const destination = join(root, '.pilot', 'tools', 'bulk-login')
    await mkdir(destination, { recursive: true })
    for (const file of ['tool.json', 'main.js', 'test.js']) {
      await writeFile(
        join(destination, file),
        await readFile(join(source, file), 'utf8'),
        'utf8',
      )
    }

    const registration = await registry(root, data).register('bulk-login')
    expect(registration.tool.approved).toBe(true)
    expect(registration.tool.runtime).toBe('node')
    expect(registration.testOutput).toContain('bulk-login self-test passed')
  })
})

describe('DynamicToolRegistry', () => {
  it('registers a tool only after its self-test passes, then runs it', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)

    const registration = await tools.register('echo')
    expect(registration.tool.approved).toBe(true)
    expect(registration.tool.source).toBe('workspace')
    expect(registration.tool.successCount).toBe(0)

    const result = await tools.run('echo', { name: 'pilot' })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('echo:pilot')

    const listed = await tools.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.successCount).toBe(1)
    expect(listed[0]?.lastRunAt).toBeTruthy()
  })

  it('refuses registration when the self-test fails', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'broken', {}, 'process.exit(3)\n')
    const tools = registry(root, data)

    await expect(tools.register('broken')).rejects.toThrow(/自测失败/)
    const listed = await tools.list()
    expect(listed[0]?.approved).toBe(false)
    await expect(tools.run('broken', {})).rejects.toThrow(/尚未通过自测/)
  })

  it('rejects a manifest that escapes the tool directory', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'escape', { entry: '../outside.js' })
    await writeFile(join(root, '.pilot', 'tools', 'outside.js'), 'process.exit(0)\n', 'utf8')
    const tools = registry(root, data)

    await expect(tools.register('escape')).rejects.toThrow(/跳出工具目录/)
  })

  it('enforces the test-target allowlist at registration', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'remote', { targets: ['https://api.example.test/login'] })

    await expect(registry(root, data).register('remote')).rejects.toThrow(/白名单/)

    const allowed = registry(root, data, ['https://api.example.test'])
    const registration = await allowed.register('remote')
    expect(registration.tool.targets).toEqual(['https://api.example.test/login'])
  })

  it('revokes approval when a tool file changes', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)
    await tools.register('echo')

    await writeFile(join(root, '.pilot', 'tools', 'echo', 'main.js'), `${ENTRY}// changed\n`, 'utf8')
    const listed = await tools.list()
    expect(listed[0]?.approved).toBe(false)
    await expect(tools.run('echo', { name: 'x' })).rejects.toThrow(/尚未通过自测/)
  })

  it('revokes approval when an auxiliary file changes', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    // The entry requires an auxiliary module: the approval hash must cover it,
    // otherwise a byte changed after approval would still execute.
    const dir = join(root, '.pilot', 'tools', 'echo')
    await writeFile(
      join(dir, 'main.js'),
      `const lib = require('./lib.js')\nlet raw = ''\nprocess.stdin.on('data', (chunk) => { raw += chunk })\nprocess.stdin.on('end', () => {\n  const args = JSON.parse(raw || '{}')\n  process.stdout.write(lib.prefix() + String(args.name))\n})\n`,
      'utf8',
    )
    await writeFile(join(dir, 'lib.js'), "exports.prefix = () => 'echo:'\n", 'utf8')
    const tools = registry(root, data)
    await tools.register('echo')
    await expect(tools.run('echo', { name: 'x' })).resolves.toMatchObject({
      ok: true,
      output: 'echo:x',
    })

    await writeFile(join(dir, 'lib.js'), "exports.prefix = () => 'pwned:'\n", 'utf8')
    const listed = await tools.list()
    expect(listed[0]?.approved).toBe(false)
    await expect(tools.run('echo', { name: 'x' })).rejects.toThrow(/尚未通过自测/)
  })

  it('refuses a disabled tool', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)
    await tools.register('echo')

    await tools.setEnabled('workspace', 'echo', false)
    await expect(tools.run('echo', { name: 'x' })).rejects.toThrow(/已停用/)

    await tools.setEnabled('workspace', 'echo', true)
    await expect(tools.run('echo', { name: 'x' })).resolves.toMatchObject({ ok: true })
  })

  it('promotes an approved workspace tool into the global scope', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)
    await tools.register('echo')
    await tools.run('echo', { name: 'seed' })
    await tools.promote('echo')

    // The workspace copy still shadows the global one after promotion.
    expect((await tools.list()).map((tool) => tool.source)).toEqual(['workspace'])
    expect(await readFile(join(data, 'tools', 'global', 'echo', 'tool.json'), 'utf8')).toContain(
      '"echo"',
    )

    await tools.remove('workspace', 'echo')
    const remaining = await tools.list()
    expect(remaining.map((tool) => tool.source)).toEqual(['global'])
    expect(remaining[0]?.approved).toBe(true)
    await expect(tools.run('echo', { name: 'global' })).resolves.toMatchObject({
      ok: true,
      output: 'echo:global',
    })
  })

  it('lets localhost through without configuration but not private hosts', () => {
    expect(isAllowedTestTarget('http://localhost:3000/login', [])).toBe(true)
    expect(isAllowedTestTarget('http://127.0.0.1:8080/', [])).toBe(true)
    expect(isAllowedTestTarget('https://internal.example.test/x', [])).toBe(false)
    expect(
      isAllowedTestTarget('https://internal.example.test/x', ['https://internal.example.test']),
    ).toBe(true)
    expect(isAllowedTestTarget('file:///etc/passwd', [])).toBe(false)
  })
})

describe('DynamicToolRegistry upgrade history', () => {
  const V2_ENTRY = ENTRY.replace("'echo:'", "'echo2:'")

  it('bumps the version and keeps the previous approved snapshot', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)

    const first = await tools.register('echo')
    expect(first.tool.version).toBe(1)
    expect(first.tool.approvedVersion).toBe(1)
    expect(first.tool.versions?.map((item) => item.version)).toEqual([1])

    const dir = join(root, '.pilot', 'tools', 'echo')
    await writeFile(join(dir, 'main.js'), V2_ENTRY, 'utf8')
    const second = await tools.register('echo')
    expect(second.tool.version).toBe(2)
    expect(second.tool.approvedVersion).toBe(2)
    expect(second.tool.versions?.map((item) => item.version)).toEqual([1, 2])
    expect(second.tool.versions?.[1]?.action).toBe('upgrade')

    const manifest = JSON.parse(await readFile(join(dir, 'tool.json'), 'utf8')) as {
      version: number
    }
    expect(manifest.version).toBe(2)
    await expect(tools.run('echo', { name: 'x' })).resolves.toMatchObject({
      ok: true,
      output: 'echo2:x',
    })
  })

  it('rolls back to the previous approved snapshot and re-approves it', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)
    await tools.register('echo')

    await writeFile(join(root, '.pilot', 'tools', 'echo', 'main.js'), V2_ENTRY, 'utf8')
    await tools.register('echo')

    const rolled = await tools.rollback('echo')
    expect(rolled.tool.version).toBe(1)
    expect(rolled.tool.approvedVersion).toBe(1)
    const history = rolled.tool.versions ?? []
    expect(history).toHaveLength(3)
    expect(history[history.length - 1]?.action).toBe('rollback')

    await expect(tools.run('echo', { name: 'x' })).resolves.toMatchObject({
      ok: true,
      output: 'echo:x',
    })
  })

  it('keeps the current version when the restored snapshot fails its test', async () => {
    const root = await workspace()
    const data = await userData()
    const markerTest = `const fs = require('node:fs')\nprocess.exit(fs.existsSync('allow-rollback.txt') ? 0 : 1)\n`
    await createTool(root, 'echo', {}, markerTest)
    await writeFile(join(root, 'allow-rollback.txt'), 'ok', 'utf8')
    const tools = registry(root, data)
    await tools.register('echo')

    const dir = join(root, '.pilot', 'tools', 'echo')
    await rm(join(root, 'allow-rollback.txt'), { force: true })
    await writeFile(join(dir, 'test.js'), PASSING_TEST, 'utf8')
    await writeFile(join(dir, 'main.js'), V2_ENTRY, 'utf8')
    await tools.register('echo')

    await expect(tools.rollback('echo')).rejects.toThrow(/已保留当前版本/)
    const listed = await tools.list()
    expect(listed[0]?.approvedVersion).toBe(2)
    await expect(tools.run('echo', { name: 'x' })).resolves.toMatchObject({
      ok: true,
      output: 'echo2:x',
    })
  })

  it('requires one successful run before becoming a system default', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)
    await tools.register('echo')

    await expect(tools.promote('echo')).rejects.toThrow(/还没有成功运行记录/)
    await tools.promote('echo', { force: true })
    expect(await readFile(join(data, 'tools', 'global', 'echo', 'tool.json'), 'utf8')).toContain(
      'echo',
    )
  })

  it('refuses to promote a tool that hardcodes this workspace path', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    await writeFile(
      join(root, '.pilot', 'tools', 'echo', 'main.js'),
      `const pinned = ${JSON.stringify(join(root, '.pilot'))}\n${ENTRY}`,
      'utf8',
    )
    const tools = registry(root, data)
    await tools.register('echo')
    await tools.run('echo', { name: 'x' })

    await expect(tools.promote('echo')).rejects.toThrow(/不通用/)
  })

  it('refuses to promote a tool whose auxiliary file hardcodes this workspace path', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    // The entry itself stays clean; only the auxiliary module pins the path.
    await writeFile(
      join(root, '.pilot', 'tools', 'echo', 'lib.js'),
      `const pinned = ${JSON.stringify(root)}\n`,
      'utf8',
    )
    const tools = registry(root, data)
    await tools.register('echo')
    await tools.run('echo', { name: 'x' })

    await expect(tools.promote('echo')).rejects.toThrow(/不通用/)
  })

  it('keeps a promoted tool roll-backable after its workspace copy is gone', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)
    await tools.register('echo')
    await tools.run('echo', { name: 'v1' })

    const dir = join(root, '.pilot', 'tools', 'echo')
    await writeFile(join(dir, 'main.js'), V2_ENTRY, 'utf8')
    await tools.register('echo')
    await tools.run('echo', { name: 'v2' })
    await tools.promote('echo')

    // The workspace copy shadows the global one, so remove it first: this is the
    // state after promotion when the workspace tool is cleaned up.
    await rm(dir, { recursive: true, force: true })
    const promoted = (await tools.list()).find((tool) => tool.source === 'global')
    expect(promoted?.approvedVersion).toBe(2)
    expect(promoted?.promotedAt).toBeTruthy()
    expect((promoted?.versions ?? []).map((item) => item.version)).toEqual([1, 2])

    const rolled = await tools.rollback('echo', undefined, 'global')
    expect(rolled.tool.source).toBe('global')
    expect(rolled.tool.approvedVersion).toBe(1)
    await expect(tools.run('echo', { name: 'x' })).resolves.toMatchObject({
      ok: true,
      output: 'echo:x',
    })
  })

  it('surfaces promotion and scope through the agent-facing tools', async () => {
    const root = await workspace()
    const data = await userData()
    await createTool(root, 'echo')
    const tools = registry(root, data)
    await tools.register('echo')
    await tools.run('echo', { name: 'seed' })
    const host: ToolHost = {
      root,
      screenshotDir: root,
      toolRegistry: tools,
      remember: async () => ({ id: 'memory-1' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
    }
    const signal = new AbortController().signal

    const before = await executePilotTool(LIST_TOOLS, {}, host, signal)
    expect(before.output).toContain('this workspace')

    const promoted = await executePilotTool(PROMOTE_TOOL, { name: 'echo' }, host, signal)
    expect(promoted.ok).toBe(true)
    expect(promoted.output).toContain('system-default tool')

    const after = await executePilotTool(LIST_TOOLS, {}, host, signal)
    expect(after.output).toContain('system default')

    await writeFile(join(root, '.pilot', 'tools', 'echo', 'main.js'), V2_ENTRY, 'utf8')
    await tools.register('echo')
    const downgraded = await executePilotTool(ROLLBACK_TOOL, { name: 'echo' }, host, signal)
    expect(downgraded.ok).toBe(true)
    expect(downgraded.metadata?.['version']).toBe(1)
  })
})
