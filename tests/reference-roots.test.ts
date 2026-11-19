import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  executePilotTool,
  READ_FILE,
  WRITE_FILE,
  withReferenceRoots,
  pilotTools,
  type ToolHost,
} from '../src/main/agent/tools'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    await rm(cleanups.pop() as string, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-reference-'))
  cleanups.push(dir)
  return dir
}

function host(root: string, referenceRoots?: ToolHost['referenceRoots']): ToolHost {
  return {
    root,
    ...(referenceRoots ? { referenceRoots } : {}),
    remember: async () => ({ id: 'memory-1' }),
    updatePlan: () => undefined,
    proposeSelfUpdate: async () => ({ version: 1 }),
  }
}

describe('referenced workspaces', () => {
  it('lets read tools open files from a referenced project by alias', async () => {
    const current = await tempDir()
    const other = await tempDir()
    await writeFile(join(other, 'notes.txt'), 'hello from the other project')

    const result = await executePilotTool(
      READ_FILE,
      { path: 'notes.txt', root: 'other' },
      host(current, [{ name: 'other', path: other }]),
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('hello from the other project')
  })

  it('still refuses files outside the current workspace without an alias', async () => {
    const current = await tempDir()
    const other = await tempDir()
    await writeFile(join(other, 'notes.txt'), 'secret')

    await expect(
      executePilotTool(
        READ_FILE,
        { path: join(other, 'notes.txt') },
        host(current, [{ name: 'other', path: other }]),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/workspace-relative|Only/i)
  })

  it('never routes writes into a referenced project', async () => {
    const current = await tempDir()
    const other = await tempDir()

    const result = await executePilotTool(
      WRITE_FILE,
      { path: 'created.txt', content: 'x', root: 'other' },
      host(current, [{ name: 'other', path: other }]),
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    // The extra root argument is ignored by write tools: the file lands in the
    // current workspace, leaving the referenced project untouched.
    await expect(
      executePilotTool(
        READ_FILE,
        { path: 'created.txt' },
        host(current),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ok: true })
  })

  it('adds the root selector to read tools only', () => {
    const tools = withReferenceRoots(pilotTools, [{ name: 'other', path: '/tmp/other' }])
    const read = tools.find((tool) => tool.name === READ_FILE)
    const write = tools.find((tool) => tool.name === WRITE_FILE)
    expect(read?.inputSchema['properties']).toMatchObject({
      root: { type: 'string', enum: ['other'] },
    })
    expect(write?.inputSchema['properties']).not.toHaveProperty('root')
  })
})
