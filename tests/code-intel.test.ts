import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codeIntelStatus, disposeCodeIntel, runCodeIntel } from '../src/main/agent/code-intel'
import { runCodeIntelTool } from '../src/main/agent/tools/code-intel'
import type { ToolHost } from '../src/main/agent/tools/spec'

const cleanups: string[] = []

afterEach(async () => {
  disposeCodeIntel()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

/**
 * 临时工作区里放两个互相引用的源文件和一个类型错误文件。
 * typescript 本身从本仓库（process.cwd()）解析，所以测试不需要伪造 node_modules。
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-codeintel-'))
  cleanups.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src', 'greet.ts'),
    ['export function greet(name: string): string {', '  return `hi ${name}`', '}', ''].join('\n'),
    'utf8',
  )
  await writeFile(
    join(root, 'src', 'main.ts'),
    [
      "import { greet } from './greet'",
      '',
      'export const first = greet("a")',
      'export const second = greet("b")',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(join(root, 'src', 'broken.ts'), 'const broken: number = "text"\n', 'utf8')
  return root
}

function host(root: string): ToolHost {
  // rootFor() only reads host.roots and host.rootKey; the rest of ToolHost is
  // never touched by the code_intel handler.
  return { root, roots: [] } as unknown as ToolHost
}

describe('runCodeIntel: definition / references', () => {
  it('resolves a symbol in another file to its declaration', async () => {
    const root = await fixture()
    const result = await runCodeIntel(root, {
      action: 'definition',
      path: 'src/main.ts',
      symbol: 'greet',
    })
    expect(result.ok).toBe(true)
    // 声明在 greet.ts:1，而不是 main.ts 的 import 行
    expect(result.output).toContain('src/greet.ts:1')
    expect(result.output).toContain('export function greet')
  })

  it('lists every reference including the declaration file', async () => {
    const root = await fixture()
    const result = await runCodeIntel(root, {
      action: 'references',
      path: 'src/greet.ts',
      symbol: 'greet',
    })
    expect(result.ok).toBe(true)
    expect(result.metadata['count']).toBeGreaterThanOrEqual(3)
    const lines = result.output.split('\n')
    expect(lines.some((line) => line.startsWith('src/greet.ts:1'))).toBe(true)
    // main.ts 里两处调用
    expect(lines.filter((line) => line.startsWith('src/main.ts:')).length).toBeGreaterThanOrEqual(2)
  })

  it('accepts an explicit line/column instead of a symbol', async () => {
    const root = await fixture()
    const result = await runCodeIntel(root, {
      action: 'definition',
      path: 'src/main.ts',
      line: 3,
      column: 22,
    })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('src/greet.ts:1')
  })

  it('reports a symbol that is not in the file instead of guessing', async () => {
    const root = await fixture()
    const result = await runCodeIntel(root, {
      action: 'definition',
      path: 'src/main.ts',
      symbol: 'nopeNotHere',
    })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('nopeNotHere')
  })
})

describe('runCodeIntel: symbols / diagnostics', () => {
  it('finds declarations by name across the workspace', async () => {
    const root = await fixture()
    const result = await runCodeIntel(root, { action: 'symbols', query: 'greet' })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('src/greet.ts:1')
  })

  it('reports type errors with file:line:column and the TS code', async () => {
    const root = await fixture()
    const result = await runCodeIntel(root, { action: 'diagnostics', scope: 'workspace' })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('src/broken.ts:1')
    expect(result.output).toMatch(/TS2322/)
  })

  it('returns a clean result for a file without errors', async () => {
    const root = await fixture()
    const result = await runCodeIntel(root, {
      action: 'diagnostics',
      path: 'src/greet.ts',
      scope: 'file',
    })
    expect(result.ok).toBe(true)
    expect(result.metadata['count']).toBe(0)
  })
})

describe('runCodeIntelTool boundary', () => {
  it('refuses a path outside the workspace', async () => {
    const root = await fixture()
    await expect(
      runCodeIntelTool('code_intel', { action: 'symbols', path: '../outside.ts' }, host(root), new AbortController().signal),
    ).rejects.toThrow(/inside the workspace/)
  })

  it('reports a missing file instead of throwing', async () => {
    const root = await fixture()
    const result = await runCodeIntelTool(
      'code_intel',
      { action: 'definition', path: 'src/missing.ts', symbol: 'x' },
      host(root),
      new AbortController().signal,
    )
    expect(result?.ok).toBe(false)
    expect(result?.output).toContain('src/missing.ts')
  })

  it('returns null for other tool names so the dispatcher keeps looking', async () => {
    const root = await fixture()
    const result = await runCodeIntelTool('read_file', {}, host(root), new AbortController().signal)
    expect(result).toBeNull()
  })

  it('caches one language service per root', async () => {
    const root = await fixture()
    await runCodeIntel(root, { action: 'symbols', query: 'greet' })
    await runCodeIntel(root, { action: 'symbols', query: 'first' })
    const status = codeIntelStatus()
    expect(status.length).toBe(1)
    expect(status[0]?.files).toBeGreaterThanOrEqual(3)
  })
})
