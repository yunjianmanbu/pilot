import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureGlobalInstructions,
  loadGlobalInstructions,
  loadProjectInstructions,
  loadProjectInstructionsDetailed,
} from '../src/main/instructions'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-instructions-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('loadProjectInstructions', () => {
  it('reports a truncated or unreadable file instead of dropping it silently', async () => {
    const root = await makeRoot()
    // One byte over the 24 KB cap: the model would otherwise get a silently
    // shortened rule file and never know a rule was cut off.
    await writeFile(join(root, 'AGENTS.md'), `# Rules\n${'x'.repeat(24 * 1024)}\n`, 'utf8')
    const { files, issues } = await loadProjectInstructionsDetailed(root)
    expect(files).toHaveLength(1)
    expect(files[0]?.truncated).toBe(true)
    expect(issues.truncated.map((entry) => entry.name)).toEqual(['AGENTS.md'])
    expect(issues.unreadable).toEqual([])
  })

  it('stays quiet when the instruction files are simply absent', async () => {
    const root = await makeRoot()
    const { files, issues } = await loadProjectInstructionsDetailed(root)
    expect(files).toEqual([])
    expect(issues.truncated).toEqual([])
    expect(issues.unreadable).toEqual([])
  })

  it('names a file that exists but cannot be read', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    await writeFile(join(outside, 'AGENTS.md'), '# outside\n', 'utf8')
    // A symlink leaving the workspace is refused by the jail; the run must say
    // so rather than behave as if the repo had no rules at all.
    await symlink(join(outside, 'AGENTS.md'), join(root, 'AGENTS.md'))
    const { files, issues } = await loadProjectInstructionsDetailed(root)
    expect(files).toEqual([])
    expect(issues.unreadable.map((entry) => entry.name)).toEqual(['AGENTS.md'])
  })
  it('loads PILOT.md and AGENTS.md in order', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'PILOT.md'), 'Use pnpm. Run pnpm test first.\n', 'utf8')
    await writeFile(join(root, 'AGENTS.md'), 'Never touch generated files.\n', 'utf8')
    const files = await loadProjectInstructions(root)
    expect(files.map((file) => file.name)).toEqual(['PILOT.md', 'AGENTS.md'])
    expect(files[0]?.content).toContain('pnpm test')
    expect(files[1]?.content).toContain('generated')
    expect(files.every((file) => file.truncated === false)).toBe(true)
  })

  it('ignores missing and empty files', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'PILOT.md'), '   \n', 'utf8')
    expect(await loadProjectInstructions(root)).toEqual([])
  })

  it('strips a UTF-8 BOM and caps oversized files', async () => {
    const root = await makeRoot()
    const body = 'x'.repeat(30 * 1024)
    await writeFile(join(root, 'PILOT.md'), `﻿${body}`, 'utf8')
    const files = await loadProjectInstructions(root)
    expect(files).toHaveLength(1)
    expect(files[0]?.content.startsWith('﻿')).toBe(false)
    expect(files[0]?.content.length).toBeLessThanOrEqual(30 * 1024)
    expect(files[0]?.truncated).toBe(true)
  })

  it('does not follow a symlinked instruction file outside the workspace', async () => {
    const root = await makeRoot()
    const outside = await makeRoot()
    const secret = join(outside, 'secret.md')
    await writeFile(secret, 'do not load this', 'utf8')
    try {
      await symlink(secret, join(root, 'PILOT.md'), 'file')
    } catch {
      // Creating symlinks can require privileges on Windows; skip in that case.
      return
    }
    expect(await loadProjectInstructions(root)).toEqual([])
  })
})

describe('loadGlobalInstructions', () => {
  it('loads the user-level PILOT.md with a global label', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'PILOT.md'), 'Answer in Chinese. Prefer narrow tests.\n', 'utf8')
    const files = await loadGlobalInstructions(root)
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('PILOT.md (global)')
    expect(files[0]?.content).toContain('narrow tests')
  })

  it('ignores a missing or empty user-level file', async () => {
    const root = await makeRoot()
    expect(await loadGlobalInstructions(root)).toEqual([])
    expect(await loadGlobalInstructions('')).toEqual([])
    await writeFile(join(root, 'PILOT.md'), ' \n', 'utf8')
    expect(await loadGlobalInstructions(root)).toEqual([])
  })

  it('creates a safe template once and never overwrites user edits', async () => {
    const root = await makeRoot()
    const path = await ensureGlobalInstructions(root)
    expect(path).toBe(join(root, 'PILOT.md'))
    const template = await readFile(path, 'utf8')
    expect(template).toContain('Pilot 全局指令')
    await writeFile(path, 'Keep my rule.\n', 'utf8')
    await ensureGlobalInstructions(root)
    expect(await readFile(path, 'utf8')).toBe('Keep my rule.\n')
  })
})
