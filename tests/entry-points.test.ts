import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectEntryPoints } from '../src/main/agent/checks'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-entry-'))
  cleanups.push(root)
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content)
  }
  return root
}

describe('detectEntryPoints', () => {
  it('names the shell entry point before package scripts', async () => {
    const root = await workspace({
      'run-tests.sh': '#!/bin/sh\nexit 0\n',
      'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }),
    })
    const entries = await detectEntryPoints(root)
    expect(entries[0]).toBe('./run-tests.sh')
    expect(entries.some((entry) => entry.startsWith('npm run test'))).toBe(true)
  })

  it('honours the package manager the lockfile implies', async () => {
    const root = await workspace({
      'pnpm-lock.yaml': '',
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    })
    const entries = await detectEntryPoints(root)
    expect(entries).toEqual(['pnpm test (package.json scripts)'])
  })

  it('reports Makefile and tox.ini when there are no package scripts', async () => {
    const root = await workspace({
      Makefile: 'build:\n\ttrue\n',
      'tox.ini': '[tox]\n',
      'run-tests.py': 'print(1)\n',
    })
    const entries = await detectEntryPoints(root)
    expect(entries).toContain('python3 run-tests.py')
    expect(entries).toContain('make (Makefile)')
    expect(entries).toContain('tox (tox.ini)')
  })

  it('prefers `make test` when the Makefile defines it', async () => {
    const root = await workspace({ Makefile: 'test:\n\ttrue\n' })
    expect(await detectEntryPoints(root)).toEqual(['make test (Makefile)'])
  })

  it('returns nothing for a workspace with no entry point at all', async () => {
    const root = await workspace({ 'README.md': '# nothing to run\n' })
    expect(await detectEntryPoints(root)).toEqual([])
  })

  it('ignores a package.json that does not parse', async () => {
    const root = await workspace({ 'package.json': '{ not json' })
    expect(await detectEntryPoints(root)).toEqual([])
  })
})
