import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import {
  abortWorkspaceUpload,
  appendWorkspaceUpload,
  applyPatch,
  beginWorkspaceUpload,
  finishWorkspaceUpload,
  MAX_FILE_CHUNK_BYTES,
  MAX_UPLOAD_BYTES,
  readFileChunk,
  redactSecretLine,
  resolveExisting,
  runCommand,
  runShell,
  searchFiles,
} from '../src/main/workspace'

const roots: string[] = []

async function makeRoot(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-test-'))
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

describe('redactSecretLine', () => {
  it('redacts recognizable tokens even outside secret-named files', () => {
    const line = 'const key = "sk-abcdefghijklmnopqrstuvwxyz"'
    expect(redactSecretLine(line, 'src/config.ts')).not.toContain('sk-abcdef')
    expect(redactSecretLine(line, 'src/config.ts')).toContain('<redacted>')
  })

  it('redacts whole assignments in .env files', () => {
    expect(redactSecretLine('DEEPSEEK_API_KEY=super-secret', '.env')).toBe(
      'DEEPSEEK_API_KEY=<redacted>',
    )
  })

  it('preserves ordinary source lines', () => {
    const line = 'export const answer = 42'
    expect(redactSecretLine(line, 'src/answer.ts')).toBe(line)
  })
})

describe('applyPatch', () => {
  it('replaces an exact block and returns a diff', async () => {
    const root = await makeRoot({ 'a.ts': 'const one = 1\nconst two = 2\n' })
    const result = await applyPatch(root, {
      path: 'a.ts',
      oldText: 'const two = 2',
      newText: 'const two = 3',
    })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toContain('const two = 3')
    expect(result.diff).toContain('+const two = 3')
  })

  it('rejects an ambiguous anchor unless replaceAll is set', async () => {
    const root = await makeRoot({ 'a.ts': 'x\ny\nx\n' })
    await expect(
      applyPatch(root, { path: 'a.ts', oldText: 'x', newText: 'z' }),
    ).rejects.toThrow(/occurs 2 times/i)
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('x\ny\nx\n')

    await applyPatch(root, { path: 'a.ts', oldText: 'x', newText: 'z', replaceAll: true })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('z\ny\nz\n')
  })

  it('rejects a missing anchor without touching the file', async () => {
    const root = await makeRoot({ 'a.ts': 'hello\n' })
    await expect(
      applyPatch(root, { path: 'a.ts', oldText: 'absent', newText: 'never' }),
    ).rejects.toThrow(/Could not find oldText/i)
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('hello\n')
  })

  it('reports a no-op edit as success when the file already matches', async () => {
    const root = await makeRoot({ 'a.ts': 'hello\n' })
    const result = await applyPatch(root, {
      path: 'a.ts',
      oldText: 'hello',
      newText: 'hello',
    })
    expect(result.metadata?.['noop']).toBe(true)
    expect(result.output).toContain('No changes needed')
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('hello\n')
  })

  it('rejects a path that escapes the workspace', async () => {
    const root = await makeRoot({ 'a.ts': 'hello\n' })
    await expect(
      applyPatch(root, { path: '../outside.ts', oldText: 'hello', newText: 'bye' }),
    ).rejects.toThrow()
  })
})

describe('resolveExisting', () => {
  it('explains a missing path and names the workspace root', async () => {
    const root = await makeRoot()
    await expect(resolveExisting(root, 'missing.ts')).rejects.toThrow(
      /Path does not exist: missing\.ts/,
    )
    await expect(resolveExisting(root, 'missing.ts')).rejects.toThrow(/current workspace/)
  })
})

describe('runCommand', () => {
  it('blocks executable paths that traverse outside the workspace', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    await expect(
      runCommand(root, { command: `..${sep}outside-program`, args: [] }, controller.signal),
    ).rejects.toThrow()
  })

  it('reports a non-zero exit code along with the command output', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    const result = await runCommand(
      root,
      {
        command: 'node',
        args: [
          '-e',
          'process.stdout.write("boom-out"); process.stderr.write("boom-err"); process.exit(3)',
        ],
      },
      controller.signal,
    )
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.error).toContain('Command failed with exit code 3')
    expect(result.output).toContain('boom-out')
    expect(result.output).toContain('boom-err')
  })

  it('describes a command that cannot be started', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    const result = await runCommand(
      root,
      { command: 'pilot-no-such-command-xyz', args: [] },
      controller.signal,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Failed to start/)
  })
})

describe('runShell', () => {
  it('runs a shell command line with redirection inside the workspace', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    const result = await runShell(
      root,
      { command: 'echo shell-ok > shell-output.txt' },
      controller.signal,
    )
    expect(result.ok).toBe(true)
    expect(result.metadata?.shell).toBeTruthy()
    expect(await readFile(join(root, 'shell-output.txt'), 'utf8')).toContain('shell-ok')
  })

  it('reports a failing shell command with its output and exit code', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    const result = await runShell(root, { command: 'echo shell-broke && exit 7' }, controller.signal)
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(7)
    expect(result.error).toContain('Command failed with exit code 7')
    expect(result.output).toContain('shell-broke')
  })

  it('rejects empty commands and working directories outside the workspace', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    await expect(runShell(root, { command: '   ' }, controller.signal)).rejects.toThrow(
      'non-empty',
    )
    await expect(
      runShell(root, { command: 'echo ok', cwd: '..' }, controller.signal),
    ).rejects.toThrow()
  })

  it('settles when the shell exits even if a background child holds the pipes open', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    const startedAt = Date.now()
    const result = await runShell(
      root,
      { command: 'sleep 5 & echo shell-background-ok' },
      controller.signal,
    )
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('shell-background-ok')
  })

  it('times out and settles even when the command does not exit on its own', async () => {
    const root = await makeRoot()
    const controller = new AbortController()
    const startedAt = Date.now()
    const result = await runShell(root, { command: 'sleep 30', timeoutMs: 1_000 }, controller.signal)
    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(result.ok).toBe(false)
    expect(result.metadata?.timedOut).toBe(true)
    expect(result.error).toContain('timed out')
  })
})

describe('readFileChunk', () => {
  it('returns base64 chunks with offset, size and eof', async () => {
    const root = await makeRoot({ 'doc.bin': 'abcdefghij' })
    const first = await readFileChunk(root, 'doc.bin', 0, 4)
    expect(first).toMatchObject({ offset: 0, size: 10, eof: false, name: 'doc.bin' })
    expect(Buffer.from(first.data, 'base64').toString('utf8')).toBe('abcd')

    const second = await readFileChunk(root, 'doc.bin', 4, 100)
    expect(Buffer.from(second.data, 'base64').toString('utf8')).toBe('efghij')
    expect(second).toMatchObject({ offset: 4, size: 10, eof: true })
  })

  it('clamps oversized chunks and returns eof past the end', async () => {
    const root = await makeRoot({ 'big.bin': 'x'.repeat(MAX_FILE_CHUNK_BYTES + 50) })
    const chunk = await readFileChunk(root, 'big.bin', 0, MAX_FILE_CHUNK_BYTES * 10)
    expect(Buffer.byteLength(chunk.data, 'base64')).toBe(MAX_FILE_CHUNK_BYTES)
    expect(chunk.eof).toBe(false)

    const past = await readFileChunk(root, 'big.bin', chunk.size + 10, 16)
    expect(past.data).toBe('')
    expect(past.eof).toBe(true)
  })

  it('keeps the workspace jail and rejects directories', async () => {
    const root = await makeRoot({ 'a.txt': 'a' })
    await expect(readFileChunk(root, '../outside.txt', 0, 8)).rejects.toThrow()
    await expect(readFileChunk(root, '.', 0, 8)).rejects.toThrow('not a file')
  })
})

describe('searchFiles glob semantics', () => {
  const tree = {
    'root-file.ts': 'const needle = 1\n',
    'src/deep/main.ts': 'const needle = 2\n',
    'src/other.js': 'const needle = 3\n',
  }

  it('matches a bare filename pattern at any depth', async () => {
    const root = await makeRoot(tree)
    const result = await searchFiles(root, { query: 'needle', glob: '*.ts' })
    expect(result.metadata.matches).toBe(2)
    expect(result.output).toContain('root-file.ts')
    expect(result.output).toContain('src/deep/main.ts')
    expect(result.output).not.toContain('other.js')
  })

  it('expands brace alternation across directories', async () => {
    const root = await makeRoot(tree)
    const result = await searchFiles(root, { query: 'needle', glob: '*.{js,vue}' })
    expect(result.metadata.matches).toBe(1)
    expect(result.output).toContain('src/other.js')
  })

  it('treats a leading ./ as relative to the search root', async () => {
    const root = await makeRoot(tree)
    const result = await searchFiles(root, { query: 'needle', glob: './src/**/*.ts' })
    expect(result.metadata.matches).toBe(1)
    expect(result.output).toContain('src/deep/main.ts')
  })

  it('keeps an explicit directory prefix anchored', async () => {
    const root = await makeRoot(tree)
    const result = await searchFiles(root, { query: 'needle', glob: 'src/**/*.ts' })
    expect(result.metadata.matches).toBe(1)
    expect(result.output).toContain('src/deep/main.ts')
    expect(result.output).not.toContain('root-file.ts')
  })

  it('explains when the glob excluded every file', async () => {
    const root = await makeRoot(tree)
    const result = await searchFiles(root, { query: 'needle', glob: '*.rs' })
    expect(result.metadata.matches).toBe(0)
    expect(result.output).toContain('selected no file paths')
  })
})

describe('readFileChunk binary safety', () => {

  it('round-trips bytes that are not valid UTF-8', async () => {
    const root = await makeRoot()
    const bytes = Buffer.from([0, 255, 1, 128, 10, 0, 254])
    await writeFile(join(root, 'x.bin'), bytes)
    const chunk = await readFileChunk(root, 'x.bin', 0, 100)
    expect(Buffer.from(chunk.data, 'base64')).toEqual(bytes)
    expect(chunk.eof).toBe(true)
  })
})

describe('phone uploads', () => {
  it('writes chunked bytes into the workspace and removes the temp file', async () => {
    const root = await makeRoot()
    const bytes = Buffer.from('hello 工作区\n'.repeat(50), 'utf8')
    const plan = await beginWorkspaceUpload(root, 'uploads', 'notes.txt', bytes.length, 'upload1234')
    expect(plan.path).toBe('uploads/notes.txt')
    await appendWorkspaceUpload(plan.tempPath, bytes.subarray(0, 100))
    await appendWorkspaceUpload(plan.tempPath, bytes.subarray(100))
    const finished = await finishWorkspaceUpload(root, plan.tempPath, 'notes.txt', bytes.length)
    expect(finished).toMatchObject({ path: 'uploads/notes.txt', name: 'notes.txt', size: bytes.length })
    expect(await readFile(join(root, 'uploads', 'notes.txt'))).toEqual(bytes)
    await expect(readFile(plan.tempPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never overwrites an existing file, it picks a numbered name', async () => {
    const root = await makeRoot({ 'uploads/report.pdf': 'old' })
    const plan = await beginWorkspaceUpload(root, 'uploads', 'report.pdf', 3, 'upload1234')
    await appendWorkspaceUpload(plan.tempPath, Buffer.from('new'))
    const finished = await finishWorkspaceUpload(root, plan.tempPath, 'report.pdf', 3)
    expect(finished.path).toBe('uploads/report (1).pdf')
    expect(await readFile(join(root, 'uploads', 'report.pdf'), 'utf8')).toBe('old')
    expect(await readFile(join(root, 'uploads', 'report (1).pdf'), 'utf8')).toBe('new')
  })

  it('rejects traversal, separators, reserved names and oversized uploads', async () => {
    const root = await makeRoot()
    await expect(
      beginWorkspaceUpload(root, '../outside', 'a.txt', 1, 'upload1234'),
    ).rejects.toThrow(/跳出工作区|escapes/i)
    await expect(
      beginWorkspaceUpload(root, 'uploads', '../a.txt', 1, 'upload1234'),
    ).rejects.toThrow(/分隔符/)
    await expect(
      beginWorkspaceUpload(root, 'uploads', 'con.txt', 1, 'upload1234'),
    ).rejects.toThrow(/保留/)
    await expect(
      beginWorkspaceUpload(root, 'uploads', 'big.bin', MAX_UPLOAD_BYTES + 1, 'upload1234'),
    ).rejects.toThrow(/100 MB/)
  })

  it('refuses to finish when the received size is incomplete', async () => {
    const root = await makeRoot()
    const plan = await beginWorkspaceUpload(root, 'uploads', 'part.bin', 10, 'upload1234')
    await appendWorkspaceUpload(plan.tempPath, Buffer.from('short'))
    await expect(
      finishWorkspaceUpload(root, plan.tempPath, 'part.bin', 10),
    ).rejects.toThrow(/不完整/)
    await abortWorkspaceUpload(plan.tempPath)
  })
})
