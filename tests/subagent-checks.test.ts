import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/main/agent/loop'
import {
  loadScriptNames,
  MAX_CHECKS_PER_SUBAGENT,
  planCheck,
  RUN_CHECK,
  runCheck,
} from '../src/main/agent/subagent-checks'
import { runSubagent } from '../src/main/agent/subagent'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    // A killed check process releases its cwd a moment later on Windows, so the
    // temp directory can still be locked on the first attempt.
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-check-'))
  cleanups.push(root)
  return root
}

/** A fake local dependency: package.json `bin` pointing at a JS script. */
async function fakeBin(
  root: string,
  pkg: string,
  name: string,
  body: string,
): Promise<void> {
  const dir = join(root, 'node_modules', pkg)
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: pkg, version: '1.0.0', bin: { [name]: './bin/cli.cjs' } }),
    'utf8',
  )
  await writeFile(join(dir, 'bin', 'cli.cjs'), body, 'utf8')
}

async function writePackageJson(root: string, scripts: Record<string, string>): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts }), 'utf8')
}

describe('planCheck whitelist', () => {
  it('accepts the narrow checks a project actually needs', () => {
    const scripts = new Set(['typecheck', 'test'])
    for (const input of [
      { command: 'npx', args: ['vitest', 'run', 'tests/a.test.ts'], cwd: 'pilot/pilot' },
      { command: 'npx', args: ['tsc', '-p', 'tsconfig.node.json', '--noEmit'] },
      { command: 'pnpm', args: ['run', 'typecheck'], cwd: 'pilot/pilot' },
      { command: 'pnpm', args: ['test'] },
      { command: 'tsc', args: ['--noEmit'] },
      { command: 'eslint', args: ['src/**/*.ts'] },
    ]) {
      const planned = planCheck(input, scripts)
      expect({ input, ok: planned.ok }).toEqual({ input, ok: true })
    }
  })

  it('refuses arbitrary programs, shell syntax, escapes and dependency changes', () => {
    const refused: Array<Record<string, unknown>> = [
      { command: 'bash', args: ['-lc', 'echo hi'] },
      { command: 'node', args: ['evil.js'] },
      { command: 'curl', args: ['https://example.com'] },
      { command: 'powershell', args: ['-c', 'ls'] },
      { command: 'npx', args: ['some-random-package'] },
      { command: 'npm', args: ['install', 'left-pad'] },
      { command: 'pnpm', args: ['dlx', 'cowsay'] },
      { command: 'pnpm', args: ['publish'] },
      { command: 'npm', args: ['audit'] },
      { command: 'npx', args: ['vitest', 'run', 'a.test.ts', '|', 'tee'] },
      { command: 'npx', args: ['vitest', 'run', 'a.test.ts', '&&', 'rm'] },
      { command: 'npx', args: ['vitest', 'run', '$(whoami)'] },
      { command: 'npx', args: ['vitest', 'run', '../../etc/passwd'] },
      { command: 'npx', args: ['vitest', 'run', '/abs/path.ts'] },
      { command: 'npx', args: ['vitest', 'run', 'a b.ts'] },
      { command: 'npx', args: ['vitest', 'run'], cwd: '../outside' },
      { command: 'npx', args: ['vitest', 'run'], cwd: 'C:/Windows' },
      { command: 'npx', args: ['vitest', 'run'], cwd: '/etc' },
      { command: 'pnpm', args: ['run', 'typecheck', 'and-more'], cwd: 'pilot/pilot' },
      { command: './node_modules/.bin/vitest', args: [] },
      { command: '' },
    ]
    for (const input of refused) {
      const planned = planCheck(input, new Set(['typecheck']))
      expect({ input, ok: planned.ok }).toEqual({ input, ok: false })
    }
  })

  it('rejects a script name the package.json does not define', () => {
    const planned = planCheck({ command: 'pnpm', args: ['run', 'deploy'] }, new Set(['test']))
    expect(planned).toEqual({ ok: false, reason: 'package.json 里没有脚本 deploy' })
    // Without the script list it is a shape check only.
    expect(planCheck({ command: 'pnpm', args: ['run', 'deploy'] }).ok).toBe(true)
  })

  it('allows node only in its check modes', () => {
    expect(planCheck({ command: 'node', args: ['--test', 'test/a.test.mjs'] }).ok).toBe(true)
    expect(planCheck({ command: 'node', args: ['--check', 'src/a.js'] }).ok).toBe(true)
    for (const args of [['-e', 'process.exit(0)'], ['scripts/setup.mjs'], ['--test-runner']]) {
      expect(planCheck({ command: 'node', args }).ok).toBe(false)
    }
  })

  it('marks a check as verification only when it proves something', () => {
    const verify = planCheck({ command: 'npx', args: ['tsc', '--noEmit'] })
    const fmt = planCheck({ command: 'npx', args: ['prettier', '--check', 'src'] })
    expect(verify.ok && verify.plan.verifies).toBe(true)
    expect(fmt.ok && fmt.plan.verifies).toBe(false)
  })

  it('clamps the timeout instead of trusting the model', () => {
    const low = planCheck({ command: 'tsc', args: [], timeoutMs: 1 })
    const high = planCheck({ command: 'tsc', args: [], timeoutMs: 10_000_000 })
    expect(low.ok && low.plan.timeoutMs).toBe(1_000)
    expect(high.ok && high.plan.timeoutMs).toBe(240_000)
  })
})

describe('runCheck execution', () => {
  it('runs a whitelisted tool through node without a shell and keeps its output', async () => {
    const root = await workspace()
    await fakeBin(
      root,
      'prettier',
      'prettier',
      "console.log('prettier ran: ' + process.argv.slice(2).join(','))\n",
    )
    const result = await runCheck(root, {
      command: 'npx',
      args: ['prettier', '--check', 'src'],
    })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('prettier ran: --check,src')
    expect(result.exitCode).toBe(0)
    expect(result.verifies).toBe(false)
    expect(result.command).toContain('npx prettier --check src')
  })

  it('returns the failing output and exit code instead of a bare failure', async () => {
    const root = await workspace()
    await fakeBin(
      root,
      'eslint',
      'eslint',
      "console.error('src/a.ts: 3 errors')\nprocess.exit(2)\n",
    )
    const result = await runCheck(root, { command: 'npx', args: ['eslint', 'src'] })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('src/a.ts: 3 errors')
    expect(result.error).toContain('退出码 2')
  })

  it('refuses a program that is not installed instead of falling back to a shell', async () => {
    const root = await workspace()
    const result = await runCheck(root, { command: 'npx', args: ['vitest', 'run'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('node_modules 里找不到 vitest')
  })

  it('expands a package.json script without a shell and stops at the first failure', async () => {
    const root = await workspace()
    await writePackageJson(root, { typecheck: 'tsc -p a.json --noEmit && tsc -p b.json' })
    await fakeBin(
      root,
      'typescript',
      'tsc',
      [
        "const cfg = process.argv[process.argv.indexOf('-p') + 1] || 'none'",
        "console.log('tsc ' + cfg)",
        "if (cfg === 'b.json') process.exit(1)",
      ].join('\n'),
    )
    const result = await runCheck(root, { command: 'pnpm', args: ['run', 'typecheck'] })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('tsc a.json')
    expect(result.output).toContain('tsc b.json')
    expect(result.verifies).toBe(true)
  })

  it('runs node --test directly, without a package manager', async () => {
    const root = await workspace()
    await mkdir(join(root, 'test'), { recursive: true })
    await writeFile(
      join(root, 'test', 'a.test.mjs'),
      "import { test } from 'node:test'\nimport assert from 'node:assert'\ntest('ok', () => assert.equal(1, 1))\n",
      'utf8',
    )
    const result = await runCheck(root, { command: 'node', args: ['--test', 'test/a.test.mjs'] })
    expect(result.ok).toBe(true)
    expect(result.verifies).toBe(true)
  }, 60_000)

  it('refuses a project script that hides a pipe behind the package manager', async () => {
    const root = await workspace()
    await writePackageJson(root, { test: 'vitest run | tee out.txt' })
    await fakeBin(root, 'vitest', 'vitest', "console.log('should not run')\n")
    const result = await runCheck(root, { command: 'pnpm', args: ['test'] })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('shell 语法')
    expect(result.output).not.toContain('should not run')
  })

  it('kills a check that exceeds its timeout budget', async () => {
    const root = await workspace()
    await fakeBin(root, 'vitest', 'vitest', 'setTimeout(() => {}, 60000)\n')
    const result = await runCheck(root, {
      command: 'npx',
      args: ['vitest', 'run'],
      timeoutMs: 1_000,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('超时')
    expect(result.durationMs).toBeLessThan(20_000)
  }, 40_000)

  it('caps what one check may put back into the context', async () => {
    const root = await workspace()
    await fakeBin(
      root,
      'vitest',
      'vitest',
      "console.log('head')\nfor (let i = 0; i < 20000; i += 1) console.log('noise ' + i)\nconsole.log('tail')\n",
    )
    const result = await runCheck(root, { command: 'npx', args: ['vitest', 'run'] })
    expect(result.ok).toBe(true)
    expect(result.output.length).toBeLessThan(12_000)
    expect(result.output).toContain('head')
    expect(result.output).toContain('tail')
  })

  it('reads script names from the package.json governing the cwd', async () => {
    const root = await workspace()
    await mkdir(join(root, 'pkg'), { recursive: true })
    await writeFile(
      join(root, 'pkg', 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
      'utf8',
    )
    expect([...(await loadScriptNames(root, 'pkg'))]).toEqual(['test'])
    expect((await loadScriptNames(root, '.')).size).toBe(0)
  })
})

function scripted(responses: ModelResponse[]): ModelClient & { requests: ModelRequest[] } {
  let index = 0
  const client = {
    requests: [] as ModelRequest[],
    async complete(request: ModelRequest): Promise<ModelResponse> {
      client.requests.push(request)
      const next = responses[index]
      index += 1
      return next ?? { content: 'done', toolCalls: [] }
    },
  }
  return client
}

describe('run_check inside a subagent', () => {
  it('is offered to general mode only, and disappears with the shell setting', async () => {
    const root = await workspace()
    const general = scripted([{ content: 'ok', toolCalls: [] }])
    await runSubagent({
      client: general,
      workspacePath: root,
      mode: 'general',
      task: 'look around',
    })
    const generalTools = general.requests[0]?.tools.map((tool) => tool.name) ?? []
    expect(generalTools).toContain(RUN_CHECK)
    expect(generalTools).not.toContain('run_command')
    expect(generalTools).not.toContain('run_shell')

    const explore = scripted([{ content: 'ok', toolCalls: [] }])
    await runSubagent({
      client: explore,
      workspacePath: root,
      mode: 'explore',
      task: 'look around',
    })
    expect(explore.requests[0]?.tools.map((tool) => tool.name)).not.toContain(RUN_CHECK)

    const toolsmith = scripted([{ content: 'ok', toolCalls: [] }])
    await runSubagent({
      client: toolsmith,
      workspacePath: root,
      mode: 'toolsmith',
      task: 'write a tool',
    })
    expect(toolsmith.requests[0]?.tools.map((tool) => tool.name)).not.toContain(RUN_CHECK)

    const shellOff = scripted([{ content: 'ok', toolCalls: [] }])
    await runSubagent({
      client: shellOff,
      workspacePath: root,
      mode: 'general',
      task: 'look around',
      shellEnabled: false,
    })
    expect(shellOff.requests[0]?.tools.map((tool) => tool.name)).not.toContain(RUN_CHECK)
    expect(shellOff.requests[0]?.messages[0]?.content).toContain('You cannot run')
  })

  it('proves its own edit and says so, instead of handing the check back', async () => {
    const root = await workspace()
    await fakeBin(root, 'vitest', 'vitest', "console.log('1 passed')\n")
    const model = scripted([
      {
        content: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            arguments: { path: 'src/a.ts', content: 'export const a = 1\n' },
          },
        ],
      },
      {
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: RUN_CHECK,
            arguments: { command: 'npx', args: ['vitest', 'run', 'tests/a.test.ts'] },
          },
        ],
      },
      {
        content: 'Changed src/a.ts.\nVERIFY| npx vitest run tests/a.test.ts | . | 1 passed',
        toolCalls: [],
      },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'general',
      task: 'Add a constant',
    })

    const toolMessages = model.requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
    expect(toolMessages.some((text) => text.includes('1 passed'))).toBe(true)
    expect(result.summary).toContain('子智能体已自行运行校验（1/1 通过）')
    expect(result.summary).toContain('父级可选复核')
    expect(result.summary).not.toContain('子智能体没有跑校验')
    expect(result.changedPaths).toEqual(['src/a.ts'])
  })

  it('reports a failed check as unproven so the parent does not ship it', async () => {
    const root = await workspace()
    await fakeBin(root, 'vitest', 'vitest', "console.error('1 failed')\nprocess.exit(1)\n")
    const model = scripted([
      {
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: RUN_CHECK,
            arguments: { command: 'npx', args: ['vitest', 'run'] },
          },
        ],
      },
      { content: 'Ran the test; it fails.', toolCalls: [] },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'general',
      task: 'Check something',
    })

    expect(result.summary).toContain('仍有失败（0/1 通过）')
    expect(result.summary).toContain('改动尚未被证明')
  })

  it('stops a subagent that tries to loop on checks', async () => {
    const root = await workspace()
    await fakeBin(root, 'prettier', 'prettier', "console.log('ok')\n")
    const call = (id: string): ModelResponse => ({
      content: '',
      toolCalls: [
        { id, name: RUN_CHECK, arguments: { command: 'npx', args: ['prettier', '--check'] } },
      ],
    })
    const responses = Array.from({ length: MAX_CHECKS_PER_SUBAGENT + 1 }, (_, index) =>
      call(`c${index}`),
    )
    responses.push({ content: 'Enough.', toolCalls: [] })

    const model = scripted(responses)
    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'general',
      task: 'Loop',
      maxSteps: 12,
    })

    const toolMessages = model.requests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool')
      .map((message) => message.content)
    expect(toolMessages.some((text) => text.includes('达到上限'))).toBe(true)
    expect(result.summary).toContain(`子智能体已自行运行校验（${MAX_CHECKS_PER_SUBAGENT}`)
  })
})
