import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
  desktopCapturer: {
    getSources: async () => [],
  },
}))

import {
  buildE2EArgs,
  detectE2E,
  runE2E,
  summarizeE2E,
  type E2EPlan,
} from '../src/main/agent/e2e'

const roots: string[] = []

async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-e2e-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const playwrightPlan: E2EPlan = {
  kind: 'playwright',
  runner: 'Playwright',
  command: 'node',
  args: ['node_modules/@playwright/test/cli.js', 'test'],
  script: null,
}

describe('detectE2E', () => {
  it('prefers the locally installed Playwright CLI', async () => {
    const root = await makeRoot({
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'node_modules/@playwright/test/cli.js': '// fake cli',
    })
    const plan = await detectE2E(root)
    expect(plan?.kind).toBe('playwright')
    expect(plan?.command).toBe('node')
    expect(plan?.args).toEqual(['node_modules/@playwright/test/cli.js', 'test'])
  })

  it('detects Cypress and WebdriverIO local entry points', async () => {
    const cypress = await makeRoot({
      'package.json': '{}',
      'node_modules/cypress/bin/cypress': '// fake',
    })
    expect((await detectE2E(cypress))?.kind).toBe('cypress')

    const wdio = await makeRoot({
      'package.json': '{}',
      'node_modules/@wdio/cli/bin/wdio.js': '// fake',
    })
    expect((await detectE2E(wdio))?.kind).toBe('wdio')
  })

  it('falls back to the project E2E script with its package manager', async () => {
    const root = await makeRoot({
      'package.json': JSON.stringify({ scripts: { 'test:e2e': 'node e2e/run.js' } }),
      'pnpm-lock.yaml': '',
    })
    const plan = await detectE2E(root)
    expect(plan?.kind).toBe('script')
    expect(plan?.command).toBe('pnpm')
    expect(plan?.args).toEqual(['run', 'test:e2e'])
    expect(plan?.script).toBe('test:e2e')
  })

  it('returns null when the project has no E2E setup', async () => {
    const root = await makeRoot({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) })
    expect(await detectE2E(root)).toBeNull()
  })
})

describe('buildE2EArgs', () => {
  it('runs one spec, stops early and uses the line reporter for Playwright', () => {
    const built = buildE2EArgs(playwrightPlan, {
      file: 'e2e/login.spec.ts',
      grep: 'logs in',
      project: 'chromium',
      maxFailures: 3,
    })
    expect(built.args).toEqual([
      'node_modules/@playwright/test/cli.js',
      'test',
      'e2e/login.spec.ts',
      '--max-failures=3',
      '--reporter=line',
      '--grep=logs in',
      '--project=chromium',
    ])
    expect(built.notes).toEqual([])
  })

  it('rejects absolute or escaping spec paths', () => {
    expect(() => buildE2EArgs(playwrightPlan, { file: '../secret.spec.ts' })).toThrow()
    expect(() => buildE2EArgs(playwrightPlan, { file: 'C:/tmp/x.spec.ts' })).toThrow()
    expect(() => buildE2EArgs(playwrightPlan, { file: '--ui' })).toThrow()
  })

  it('does not pretend a package script accepts Pilot filters', () => {
    const scriptPlan: E2EPlan = {
      kind: 'script',
      runner: 'package script "e2e"',
      command: 'pnpm',
      args: ['run', 'e2e'],
      script: 'e2e',
    }
    expect(() => buildE2EArgs(scriptPlan, { file: 'e2e/login.spec.ts' })).toThrow(/does not accept/)
    expect(buildE2EArgs(scriptPlan, {}).args).toEqual(['run', 'e2e'])
  })
})

describe('runE2E', () => {
  const options = { sandbox: null, shellInterpreter: 'auto' as const, shellEnabled: true }

  it('executes the detected local CLI, parses a failing run and marks it as verification', async () => {
    const root = await makeRoot({
      'package.json': '{}',
      'node_modules/@playwright/test/cli.js': [
        "const fs = require('fs')",
        "fs.mkdirSync('test-results/login', { recursive: true })",
        "fs.writeFileSync('test-results/login/test-failed-1.png', 'fake png')",
        "console.log('  ✘  1 [chromium] › login works')",
        "console.log('  Error: expect(received).toBe(expected)')",
        "console.log('  Expected: 200')",
        "console.log('  Received: 401')",
        "console.log('  1 failed')",
        'process.exit(1)',
      ].join('\n'),
    })
    const result = await runE2E(root, {}, AbortSignal.timeout(30_000), options)
    expect(result.ok).toBe(false)
    expect(result.metadata?.['verification']).toBe(true)
    expect(result.output).toContain('E2E: Playwright')
    expect(result.output).toContain('Received: 401')
    const e2e = result.metadata?.['e2e'] as Record<string, unknown>
    expect(e2e['kind']).toBe('playwright')
    expect((e2e['counts'] as string[]).join(' ')).toContain('1 failed')
  }, 30_000)

  it('returns ok for a passing narrow spec', async () => {
    const root = await makeRoot({
      'package.json': '{}',
      'node_modules/@playwright/test/cli.js': "console.log('  2 passed (0.4s)'); process.exit(0)",
    })
    const result = await runE2E(
      root,
      { file: 'e2e/login.spec.ts', maxFailures: 2 },
      AbortSignal.timeout(30_000),
      options,
    )
    expect(result.ok).toBe(true)
    expect(result.metadata?.['verification']).toBe(true)
    expect(result.output).toContain('2 passed')
    expect(result.output).toContain('e2e/login.spec.ts')
  }, 30_000)
})

describe('summarizeE2E', () => {
  it('extracts counts and failure lines from a Playwright line report', () => {
    const summary = summarizeE2E(
      [
        '\u001b[31m  ✘  1 [chromium] › e2e/login.spec.ts:12:3 › login works\u001b[39m',
        '  Error: expect(received).toBe(expected)',
        '  Expected: 200',
        '  Received: 401',
        '  1 failed',
        '  2 passed (3.1s)',
      ].join('\n'),
    )
    expect(summary.counts).toContain('1 failed')
    expect(summary.counts).toContain('2 passed')
    expect(summary.failures.some((line) => line.includes('login works'))).toBe(true)
    expect(summary.failures.some((line) => line.includes('Received: 401'))).toBe(true)
    expect(summary.installHint).toBeNull()
  })

  it('explains missing browser binaries instead of installing them', () => {
    const summary = summarizeE2E(
      "Executable doesn't exist at C:\\cache\\chromium\\chrome.exe. Please run `npx playwright install`.",
    )
    expect(summary.installHint).toContain('never installs browsers')
  })
})
