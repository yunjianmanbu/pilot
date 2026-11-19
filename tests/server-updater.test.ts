import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ServerUpdater,
  applyStagedUpdate,
  normalizeReleasePath,
  parseServerRelease,
  planServerUpdate,
  readServerIndex,
  scanLocalServerState,
  sha256Of,
  stageServerUpdate,
  type ServerRelease,
  type UpdateFetch,
} from '../src/server/update'

const HOSTS = new Set(['download.medpilot.cc'])
const roots: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-srv-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  while (roots.length) await rm(roots.pop() as string, { recursive: true, force: true })
})

function file(path: string, content: string) {
  return { path, size: Buffer.byteLength(content), sha256: sha256Of(content) }
}

function release(files: ReturnType<typeof file>[], version = '0.2.0'): ServerRelease {
  return {
    version,
    channel: 'stable',
    date: '2026-11-15',
    notes: '',
    base: 'https://download.medpilot.cc/pilot/server/0.2.0/',
    files,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
  }
}

/** Serve an in-memory file map and record which URLs were requested. */
function serveFiles(map: Record<string, string>): { fetch: UpdateFetch; hits: string[] } {
  const hits: string[] = []
  const fetchImpl: UpdateFetch = async (url) => {
    hits.push(url)
    const key = Object.keys(map).find((entry) => url.endsWith(entry))
    if (!key) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    const body = map[key] as string
    return {
      ok: true,
      status: 200,
      text: async () => body,
      arrayBuffer: async () => {
        // Return exactly the body bytes; a Buffer's backing pool is larger.
        const bytes = Buffer.from(body)
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
    }
  }
  return { fetch: fetchImpl, hits }
}

describe('server release manifest', () => {
  it('accepts a well formed manifest and normalises the base URL', () => {
    const parsed = parseServerRelease(
      {
        version: 'v0.2.0',
        base: 'https://download.medpilot.cc/pilot/server/0.2.0',
        files: [file('out/server/main.js', 'code')],
      },
      HOSTS,
    )
    expect(parsed.version).toBe('0.2.0')
    expect(parsed.base).toBe('https://download.medpilot.cc/pilot/server/0.2.0/')
    expect(parsed.files).toHaveLength(1)
    expect(parsed.channel).toBe('stable')
  })

  it('refuses paths that would escape the install root', () => {
    for (const path of ['../evil.js', '/etc/passwd', 'a/../../b.js', 'C:/windows/x.js', 'a//b.js']) {
      expect(() => normalizeReleasePath(path)).toThrow()
    }
  })

  it('rejects an untrusted download host instead of following it', () => {
    expect(() =>
      parseServerRelease(
        {
          version: '0.2.0',
          base: 'https://evil.example.com/x/',
          files: [file('a.js', 'a')],
        },
        HOSTS,
      ),
    ).toThrow()
  })

  it('reports the bad field rather than failing silently', () => {
    expect(() => parseServerRelease({ version: '0.2.0', base: 'https://download.medpilot.cc/a/', files: [] }, HOSTS)).toThrow(
      /没有列出任何文件/,
    )
    expect(() =>
      parseServerRelease(
        {
          version: '0.2.0',
          base: 'https://download.medpilot.cc/a/',
          files: [{ path: 'a.js', size: 1, sha256: 'nope' }],
        },
        HOSTS,
      ),
    ).toThrow(/SHA-256/)
    expect(() =>
      parseServerRelease(
        {
          version: '0.2.0',
          base: 'https://download.medpilot.cc/a/',
          files: [file('a.js', 'a'), file('a.js', 'a')],
        },
        HOSTS,
      ),
    ).toThrow(/重复/)
  })
})

describe('incremental plan', () => {
  it('downloads only files whose hash changed', () => {
    const next = release([file('a.js', 'A2'), file('b.js', 'B'), file('c.js', 'C')])
    const local = new Map([
      ['a.js', { size: 2, sha256: sha256Of('A1') }],
      ['b.js', { size: 1, sha256: sha256Of('B') }],
      ['c.js', { size: 1, sha256: sha256Of('C') }],
      ['gone.js', { size: 4, sha256: sha256Of('GONE') }],
    ])
    const plan = planServerUpdate(next, local)
    expect(plan.download.map((entry) => entry.path)).toEqual(['a.js'])
    expect(plan.unchanged).toEqual(['b.js', 'c.js'])
    expect(plan.removed).toEqual(['gone.js'])
    expect(plan.downloadBytes).toBe(2)
    expect(plan.unchangedBytes).toBe(2)
  })

  it('treats a same-size file with a different hash as changed', () => {
    const plan = planServerUpdate(
      release([file('a.js', 'AB')]),
      new Map([['a.js', { size: 2, sha256: sha256Of('AC') }]]),
    )
    expect(plan.download).toHaveLength(1)
  })

  it('hashes local files but skips ones whose size already differs', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'a.js'), 'A2')
    await writeFile(join(root, 'out', 'b.js'), 'B')
    const state = await scanLocalServerState(root, [file('out/a.js', 'A2'), file('out/b.js', 'BB')])
    expect(state.get('out/a.js')?.sha256).toBe(sha256Of('A2'))
    expect(state.has('out/b.js')).toBe(false)
  })
})

describe('staged update', () => {
  it('downloads only the delta, verifies it and swaps it in', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'out', 'server'), { recursive: true })
    await writeFile(join(root, 'out', 'server', 'main.js'), 'OLD')
    await writeFile(join(root, 'out', 'server', 'keep.js'), 'KEEP')
    await writeFile(join(root, 'out', 'server', 'drop.js'), 'DROP')
    // Record what the previous install shipped so `drop.js` is seen as removed.
    await writeFile(
      join(root, 'pilot-server.json'),
      JSON.stringify({
        version: '0.1.0',
        files: [file('out/server/main.js', 'OLD'), file('out/server/keep.js', 'KEEP'), file('out/server/drop.js', 'DROP')],
      }),
    )

    const next = release([
      file('out/server/main.js', 'NEW'),
      file('out/server/keep.js', 'KEEP'),
    ])
    const local = await scanLocalServerState(root, next.files)
    const plan = planServerUpdate(next, local)
    expect(plan.download.map((entry) => entry.path)).toEqual(['out/server/main.js'])
    expect(plan.removed).toEqual(['out/server/drop.js'])

    const remote = serveFiles({ 'main.js': 'NEW' })
    const progress: number[] = []
    const staged = await stageServerUpdate({
      root,
      release: next,
      plan,
      fetch: remote.fetch,
      allowedHosts: HOSTS,
      onProgress: ({ transferred }) => progress.push(transferred),
    })
    // One request: the unchanged file is never fetched.
    expect(remote.hits).toEqual(['https://download.medpilot.cc/pilot/server/0.2.0/out/server/main.js'])
    expect(progress.at(-1)).toBe(3)

    const result = await applyStagedUpdate(staged)
    expect(result.applied).toBe(1)
    expect(result.removed).toBe(1)
    expect(await readFile(join(root, 'out', 'server', 'main.js'), 'utf8')).toBe('NEW')
    expect(await readFile(join(root, 'out', 'server', 'keep.js'), 'utf8')).toBe('KEEP')
    await expect(readFile(join(root, 'out', 'server', 'drop.js'), 'utf8')).rejects.toThrow()
    const index = await readServerIndex(root)
    expect(index.get('out/server/main.js')?.sha256).toBe(sha256Of('NEW'))
    expect(index.has('out/server/drop.js')).toBe(false)
  })

  it('rejects a payload whose hash does not match and leaves the tree untouched', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'main.js'), 'OLD')
    const next = release([file('out/main.js', 'NEW')])
    const remote = serveFiles({ 'main.js': 'NEX' })
    await expect(
      stageServerUpdate({ root, release: next, plan: planServerUpdate(next, new Map()), fetch: remote.fetch }),
    ).rejects.toThrow(/校验失败/)
    expect(await readFile(join(root, 'out', 'main.js'), 'utf8')).toBe('OLD')
  })

  it('refuses a download whose size does not match the manifest', async () => {
    const root = await tempRoot()
    const next = release([file('out/main.js', 'NEW')])
    const remote = serveFiles({ 'main.js': 'NEWER' })
    await expect(
      stageServerUpdate({ root, release: next, plan: planServerUpdate(next, new Map()), fetch: remote.fetch }),
    ).rejects.toThrow(/大小不符/)
  })

  it('rolls the tree back when moving a staged file fails', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'main.js'), 'OLD')
    const next = release([file('out/main.js', 'NEW')])
    const staged = await stageServerUpdate({
      root,
      release: next,
      plan: planServerUpdate(next, new Map()),
      fetch: serveFiles({ 'main.js': 'NEW' }).fetch,
    })
    // Remove the staged payload so the swap fails after the backup was made.
    await rm(staged.stagingDir, { recursive: true, force: true })
    await expect(applyStagedUpdate(staged)).rejects.toThrow()
    expect(await readFile(join(root, 'out', 'main.js'), 'utf8')).toBe('OLD')
  })
})

describe('ServerUpdater', () => {
  const manifest = {
    version: '0.2.0',
    base: 'https://download.medpilot.cc/pilot/server/0.2.0/',
    files: [file('out/server/main.js', 'NEW')],
  }

  function manifestFetch(body: unknown, extra: Record<string, string> = {}): UpdateFetch {
    const files = serveFiles(extra).fetch
    return async (url) => {
      if (url.endsWith('server.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(body),
          arrayBuffer: async () => new ArrayBuffer(0),
        }
      }
      return files(url)
    }
  }

  it('reports up-to-date without offering an install', async () => {
    const updater = new ServerUpdater({
      root: await tempRoot(),
      currentVersion: '0.2.0',
      fetch: manifestFetch(manifest),
    })
    const state = await updater.check()
    expect(state.status).toBe('up-to-date')
    expect(state.canInstall).toBe(false)
  })

  it('checks, downloads the delta and installs', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'out', 'server'), { recursive: true })
    await writeFile(join(root, 'out', 'server', 'main.js'), 'OLD')
    const states: string[] = []
    const updater = new ServerUpdater({
      root,
      currentVersion: '0.1.0',
      fetch: manifestFetch(manifest, { 'main.js': 'NEW' }),
      onChange: (state) => states.push(state.status),
    })
    const state = await updater.runNow()
    expect(state.status).toBe('ready')
    expect(state.message).toContain('0.2.0')
    expect(await readFile(join(root, 'out', 'server', 'main.js'), 'utf8')).toBe('NEW')
    expect(states).toContain('available')
    expect(states).toContain('downloading')
    expect(states).toContain('installing')
  })

  it('surfaces a bad manifest as an error instead of throwing', async () => {
    const updater = new ServerUpdater({
      root: await tempRoot(),
      currentVersion: '0.1.0',
      fetch: manifestFetch({ version: '0.2.0', base: 'https://evil.example.com/', files: [] }),
    })
    const state = await updater.check()
    expect(state.status).toBe('error')
    expect(state.canInstall).toBe(false)
  })
})
