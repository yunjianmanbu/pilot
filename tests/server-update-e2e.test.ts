import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ServerUpdater, readServerIndex } from '../src/server/update'

/**
 * End-to-end proof that the release script and the updater agree: the manifest
 * `scripts/pack-server-release.mjs` writes is fetched over HTTP, only the file
 * whose hash changed is downloaded, and the install tree ends up on the new
 * version with untouched files intact.
 */
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

const SCRIPT = fileURLToPath(new URL('../../scripts/pack-server-release.mjs', import.meta.url))

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Static file server; records every path it actually serves. */
async function serveDirectory(root: string): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = []
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
    hits.push(path)
    try {
      const data = await readFile(join(root, ...path.split('/').filter(Boolean)))
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(data)
    } catch {
      response.writeHead(404)
      response.end('')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return { url: `http://127.0.0.1:${address.port}/`, hits }
}

describe('server release end to end', () => {
  it('installs a packed release by downloading only the changed file', async () => {
    // 1. What the server already runs: 0.1.0 with three files.
    const installed = await tempDir('pilot-installed-')
    await mkdir(join(installed, 'out', 'server'), { recursive: true })
    await mkdir(join(installed, 'companion'), { recursive: true })
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'pilot-agent', version: '0.1.0' }))
    await writeFile(join(installed, 'out', 'server', 'main.js'), 'OLD SERVER')
    await writeFile(join(installed, 'out', 'server', 'stable.js'), 'UNCHANGED')
    await writeFile(join(installed, 'out', 'server', 'legacy.js'), 'REMOVE ME')
    await writeFile(join(installed, 'companion', 'index.html'), '<html>panel</html>')
    // The index a previous update left behind, so `legacy.js` is known to exist.
    await writeFile(
      join(installed, 'pilot-server.json'),
      JSON.stringify({
        version: '0.1.0',
        files: [
          { path: 'out/server/main.js', size: 10, sha256: '0'.repeat(64) },
          { path: 'out/server/stable.js', size: 9, sha256: '0'.repeat(64) },
          { path: 'out/server/legacy.js', size: 9, sha256: '0'.repeat(64) },
          { path: 'companion/index.html', size: 18, sha256: '0'.repeat(64) },
        ],
      }),
    )

    // 2. What will be published: same tree, one bundle changed, one file gone.
    const published = await tempDir('pilot-published-')
    const source = await tempDir('pilot-source-')
    await mkdir(join(source, 'out', 'server'), { recursive: true })
    await mkdir(join(source, 'companion'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'pilot-agent', version: '0.2.0' }))
    await writeFile(join(source, 'out', 'server', 'main.js'), 'NEW SERVER')
    await writeFile(join(source, 'out', 'server', 'stable.js'), 'UNCHANGED')
    await writeFile(join(source, 'companion', 'index.html'), '<html>panel</html>')

    const serving = await serveDirectory(published)
    const packed = spawnSync(
      process.execPath,
      [SCRIPT, '--root', source, '--out', published, '--base', serving.url],
      { encoding: 'utf8' },
    )
    expect(packed.stderr).toBe('')
    expect(packed.status).toBe(0)

    // 3. Point the updater at the published manifest and upgrade.
    const states: string[] = []
    const updater = new ServerUpdater({
      root: installed,
      currentVersion: '0.1.0',
      manifestUrl: new URL('server.json', serving.url).toString(),
      onChange: (state) => states.push(state.status),
    })
    const state = await updater.runNow()

    expect(state.status).toBe('ready')
    expect(state.message).toContain('0.2.0')
    expect(await readFile(join(installed, 'out', 'server', 'main.js'), 'utf8')).toBe('NEW SERVER')
    expect(await readFile(join(installed, 'out', 'server', 'stable.js'), 'utf8')).toBe('UNCHANGED')
    // Dropped from the release, so it must not stay behind and load as stale code.
    await expect(readFile(join(installed, 'out', 'server', 'legacy.js'), 'utf8')).rejects.toThrow()

    // Only the changed files crossed the wire: the unchanged bundle and panel
    // were never requested, which is what makes this an incremental upgrade.
    const downloads = serving.hits.filter((path) => path !== '/server.json')
    expect(downloads).toEqual(['/out/server/main.js', '/package.json'])
    expect(states).toContain('available')
    expect(states).toContain('ready')

    const index = await readServerIndex(installed)
    // package.json, both server bundles and the panel — but not the file the
    // release dropped.
    expect(index.size).toBe(4)
    expect(index.has('out/server/legacy.js')).toBe(false)
  })

  it('refuses to pack an install tree that is missing the browser desktop build', async () => {
    // 浏览器控制台由 `out/web` 提供；漏了它 `pilot serve` 打开就是 404，但服务
    // 本身能起，所以只能在打包这一步拦住。
    const source = await tempDir('pilot-source-')
    await mkdir(join(source, 'bin'), { recursive: true })
    await mkdir(join(source, 'out', 'server'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'pilot-agent', version: '0.2.0' }))
    await writeFile(join(source, 'bin', 'pilot.js'), '#!/usr/bin/env node\n')
    await writeFile(join(source, 'out', 'server', 'main.js'), 'SERVER')
    const published = await tempDir('pilot-published-')
    const serving = await serveDirectory(published)

    const packed = spawnSync(
      process.execPath,
      [SCRIPT, '--root', source, '--out', published, '--base', serving.url],
      { encoding: 'utf8' },
    )
    expect(packed.status).toBe(1)
    expect(packed.stderr).toContain('out/web')
  })

  it('does nothing when the published version is not newer', async () => {
    const installed = await tempDir('pilot-installed-')
    await writeFile(join(installed, 'package.json'), '{}')
    const published = await tempDir('pilot-published-')
    await writeFile(join(published, 'package.json'), '{"version":"0.1.0"}')
    const serving = await serveDirectory(published)
    const packed = spawnSync(
      process.execPath,
      [SCRIPT, '--root', published, '--out', join(published, 'out'), '--base', serving.url],
      { encoding: 'utf8' },
    )
    expect(packed.status).toBe(0)

    const updater = new ServerUpdater({
      root: installed,
      currentVersion: '0.1.0',
      manifestUrl: new URL('out/server.json', serving.url).toString(),
    })
    const state = await updater.runNow()
    expect(state.status).toBe('up-to-date')
    expect(state.canInstall).toBe(false)
  })
})
