import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { projectMap, searchFiles } from '../src/main/workspace'

const roots: string[] = []

async function makeRoot(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-map-'))
  roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('projectMap', () => {
  it('summarizes structure, manifests, entry points and tests in one pass', async () => {
    const root = await makeRoot({
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.2.3',
        main: 'src/index.ts',
        scripts: { build: 'tsc', test: 'vitest' },
      }),
      'tsconfig.json': '{}',
      'README.md': '# demo',
      'src/index.ts': 'export const demo = 1\n',
      'src/util.ts': 'export const util = 2\n',
      'tests/app.test.ts': 'test("app", () => {})\n',
      'node_modules/dep/index.js': 'module.exports = {}\n',
    })

    const { output, metadata } = await projectMap(root)

    expect(metadata['files']).toBe(6)
    expect(metadata['directories']).toBe(2)
    expect(metadata['manifests']).toBe(1)
    expect(metadata['truncated']).toBe(false)
    expect(output).toContain('Files: 6')
    expect(output).toContain('Test files: 1')
    expect(output).toContain('package.json — demo@1.2.3')
    expect(output).toContain('scripts: build, test')
    expect(output).toContain('Key source files:')
    expect(output).toContain('src/index.ts')
    expect(output).toContain('src/util.ts')
    expect(output).not.toContain('tests/app.test.ts')
    expect(output).toContain('tests')
    expect(output).toContain('README.md')
    // Ignored directories never contribute to the counts or the tree.
    expect(output).not.toContain('node_modules')
  })

  it('reports when the file cap stopped the walk', async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 120; index += 1) files[`src/f${index}.ts`] = 'x'
    const root = await makeRoot(files)

    const { output, metadata } = await projectMap(root, { maxFiles: 100 })
    expect(metadata['truncated']).toBe(true)
    expect(metadata['files']).toBe(100)
    expect(output).toContain('stopped at 100 files')
  })

  it('reports when the depth cap stopped descending', async () => {
    const root = await makeRoot({ 'a/b/c/deep.ts': 'x' })

    const { output, metadata } = await projectMap(root, { depth: 1 })
    expect(metadata['depthTruncated']).toBe(true)
    expect(metadata['files']).toBe(0)
    expect(output).toContain('stopped descending at depth 1')
  })

  it('rejects a file path', async () => {
    const root = await makeRoot({ 'a.ts': 'x' })
    await expect(projectMap(root, { path: 'a.ts' })).rejects.toThrow('path must be a directory')
  })
})

describe('searchFiles on a file path', () => {
  it('searches only that file instead of failing with ENOTDIR', async () => {
    const root = await makeRoot({
      'a.ts': 'const needle = 1\n',
      'b.ts': 'const needle = 2\n',
    })

    const { output, metadata } = await searchFiles(root, { query: 'needle', path: 'a.ts' })
    expect(metadata['matches']).toBe(1)
    expect(output).toContain('a.ts:1:')
    expect(output).not.toContain('b.ts')
  })
})
