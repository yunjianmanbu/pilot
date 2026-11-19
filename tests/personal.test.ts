import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  contributionChecksum,
  PersonalEvolutionService,
  scanSourceChanges,
  sourceFingerprint,
  stableStringify,
} from '../src/main/personal'

const run = promisify(execFile)
const temporary: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  )
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function workspace(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(path)
  return path
}

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content)
}

async function fixture(): Promise<{ source: string; base: string; data: string }> {
  const root = await workspace('pilot-personal-')
  const source = join(root, 'source')
  const base = join(root, 'base')
  const data = join(root, 'personal')
  await write(base, 'package.json', JSON.stringify({ version: '0.1.24' }))
  await write(source, 'package.json', JSON.stringify({ version: '0.1.24' }))
  await write(base, 'src/main.ts', 'export const greeting = "official"\n')
  await write(source, 'src/main.ts', 'export const greeting = "personal"\n')
  await write(base, 'src/old.ts', 'export const old = true\n')
  await write(source, 'src/new.ts', 'export const added = true\n')
  return { source, base, data }
}

function service(
  source: string,
  base: string,
  data: string,
  endpoint?: string,
  appVersion = '0.1.24',
) {
  return new PersonalEvolutionService({
    sourcePath: source,
    basePath: base,
    baseReadOnly: false,
    dataDir: data,
    appVersion,
    ...(endpoint ? { endpoint } : {}),
  })
}

describe('personal source diff', () => {
  it('finds added, modified and deleted files by content hash', async () => {
    const { source, base } = await fixture()
    const changes = await scanSourceChanges(source, base)
    expect(changes.map((file) => [file.path, file.status])).toEqual([
      ['src/main.ts', 'modified'],
      ['src/new.ts', 'added'],
      ['src/old.ts', 'deleted'],
    ])
    expect(changes[0]?.beforeSha256).not.toBe(changes[0]?.afterSha256)
  })

  it('saves a version and restores exactly the files it recorded', async () => {
    const { source, base, data } = await fixture()
    const personal = service(source, base, data)
    const version = await personal.saveVersion({ name: '我的版本', note: '更主动' })

    expect(version.files).toHaveLength(3)
    expect((await personal.state()).versions[0]?.name).toBe('我的版本')

    await write(source, 'src/main.ts', 'export const greeting = "later"\n')
    await write(source, 'src/later.ts', 'export const later = true\n')
    await personal.restoreVersion(version.id)

    expect(await readFile(join(source, 'src/main.ts'), 'utf8')).toContain('personal')
    expect(await readFile(join(source, 'src/new.ts'), 'utf8')).toContain('added')
    await expect(readFile(join(source, 'src/old.ts'), 'utf8')).rejects.toThrow()
    // Files added after the snapshot are intentionally left alone.
    expect(await readFile(join(source, 'src/later.ts'), 'utf8')).toContain('later')
  })

  it('fingerprints stable source content and ignores build or secret folders', async () => {
    const { source } = await fixture()
    const first = await sourceFingerprint(source)
    expect(await sourceFingerprint(source)).toBe(first)
    await write(source, 'node_modules/ignored.ts', 'ignored')
    await write(source, 'release-selfdev/Pilot-x/build-info.json', '{}')
    await write(source, '.env', 'SECRET=1')
    expect(await sourceFingerprint(source)).toBe(first)
    await write(source, 'src/new.ts', 'export const added = "changed"\n')
    expect(await sourceFingerprint(source)).not.toBe(first)
  })

  it('links only a build whose source fingerprint matches the saved tree', async () => {
    const { source, base, data } = await fixture()
    const personal = service(source, base, data)
    const matching = await sourceFingerprint(source)
    const staleDir = join(source, 'release-selfdev', 'Pilot-0.1.24-stale')
    const freshDir = join(source, 'release-selfdev', 'Pilot-0.1.24-fresh')
    await write(staleDir, 'build-info.json', JSON.stringify({ sourceHash: 'not-this-tree' }))
    await write(
      freshDir,
      'build-info.json',
      JSON.stringify({ sourceHash: matching, builtAt: '2026-01-01T00:00:00.000Z' }),
    )
    const version = await personal.saveVersion({ name: '有关联构建' })
    expect(version.buildPath).toBe(freshDir)
    expect(version.builtAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('refuses to save an empty diff', async () => {
    const { source, base, data } = await fixture()
    await write(source, 'src/main.ts', 'export const greeting = "official"\n')
    await rm(join(source, 'src/new.ts'))
    await write(source, 'src/old.ts', 'export const old = true\n')
    await expect(service(source, base, data).saveVersion({ name: '空版本' })).rejects.toThrow(
      '没有差异',
    )
  })
})

describe('contribution bundles', () => {
  it('exports a checksummed bundle and records it in state', async () => {
    const { source, base, data } = await fixture()
    const personal = service(source, base, data)
    const version = await personal.saveVersion({ name: '我的版本', note: '更主动' })
    const record = await personal.submitVersion(version.id, '让 Pilot 先读测试再改代码', {
      policyVersion: 2,
      cycles: ['一轮完成'],
    })

    expect(record.status).toBe('ready')
    expect(record.bytes).toBeGreaterThan(0)
    const raw = await readFile(record.path, 'utf8')
    const bundle = JSON.parse(raw) as Record<string, unknown>
    expect(bundle['format']).toBe('pilot-contribution/v1')
    const { checksum, ...payload } = bundle
    expect(checksum).toBe(contributionChecksum(payload))
    expect(stableStringify(payload)).toContain('src/main.ts')
    const state = await personal.state()
    expect(state.contributions[0]?.id).toBe(record.id)
  })

  it('rejects a source file that appears to contain a credential', async () => {
    const { source, base, data } = await fixture()
    await write(source, 'src/key.ts', 'export const key = "sk-abcdefghijklmnopqrstuvwx"\n')
    const personal = service(source, base, data)
    const version = await personal.saveVersion({ name: '含密钥' })
    await expect(personal.submitVersion(version.id, '尝试提交')).rejects.toThrow('密钥')
  })

  it('allows an obvious test fixture while still blocking source credentials', async () => {
    const { source, base, data } = await fixture()
    await write(
      source,
      'tests/fake-key.test.ts',
      'export const fixture = "sk-abcdefghijklmnopqrstuvwx"\n',
    )
    const personal = service(source, base, data)
    const version = await personal.saveVersion({ name: '含测试夹具' })
    const record = await personal.submitVersion(version.id, '测试夹具不是真实密钥')
    expect(record.status).toBe('ready')
  })

  it('uploads to a configured endpoint and keeps a local copy', async () => {
    let received = ''
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received = Buffer.concat(chunks).toString('utf8')
        response.writeHead(202, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server has no port')
    const endpoint = `http://127.0.0.1:${address.port}/contributions`

    const { source, base, data } = await fixture()
    const personal = service(source, base, data, endpoint)
    const version = await personal.saveVersion({ name: '可提交' })
    const record = await personal.submitVersion(version.id, '改进错误处理')

    expect(record.status).toBe('uploaded')
    expect(JSON.parse(received).id).toBe(record.id)
    expect(await readFile(record.path, 'utf8')).toContain('pilot-contribution/v1')
  })

  it('marks a non-HTTPS remote endpoint as failed but keeps the bundle', async () => {
    const { source, base, data } = await fixture()
    const personal = service(source, base, data, 'http://example.com/contributions')
    const version = await personal.saveVersion({ name: '失败也要保留' })
    const record = await personal.submitVersion(version.id, '测试上传限制')
    expect(record.status).toBe('failed')
    expect(record.error).toContain('HTTPS')
    expect(await readFile(record.path, 'utf8')).toContain('pilot-contribution/v1')
  })
})

describe('official contribution importer', () => {
  it('applies a verified bundle into an official-like tree', async () => {
    const { source, base, data } = await fixture()
    const personal = service(source, base, data)
    const version = await personal.saveVersion({ name: '官方候选', note: '可合并' })
    const record = await personal.submitVersion(version.id, '请合并这个改进')

    const official = await workspace('pilot-official-')
    await write(official, 'package.json', JSON.stringify({ version: '0.1.24' }))
    await write(official, 'src/main.ts', 'export const greeting = "official"\n')
    await write(official, 'src/old.ts', 'export const old = true\n')

    const script = resolve(__dirname, '..', '..', 'scripts', 'contribution-review.mjs')
    const inspect = await run(process.execPath, [script, 'inspect', record.path, '--root', official])
    expect(inspect.stdout).toContain('检查通过')

    const applied = await run(process.execPath, [
      script,
      'apply',
      record.path,
      '--yes',
      '--root',
      official,
    ])
    expect(applied.stdout).toContain('已应用')
    expect(await readFile(join(official, 'src/main.ts'), 'utf8')).toContain('personal')
    expect(await readFile(join(official, 'src/new.ts'), 'utf8')).toContain('added')
    await expect(readFile(join(official, 'src/old.ts'), 'utf8')).rejects.toThrow()
  })

  it('does not trust a bundle that marks a text file as binary to hide a secret', async () => {
    const official = await workspace('pilot-official-secret-')
    await write(official, 'package.json', JSON.stringify({ version: '0.1.24' }))
    const content = 'export const leaked = "sk-abcdefghijklmnopqrstuvwx"\n'
    const payload = {
      format: 'pilot-contribution/v1',
      id: 'forged',
      createdAt: new Date().toISOString(),
      note: 'forged bundle',
      fork: { id: 'fork', name: 'fork', baseVersion: '0.1.24' },
      version: { id: 'v', name: 'forged', note: 'forged', baseVersion: '0.1.24' },
      appVersion: '0.1.24',
      files: [
        {
          path: 'src/leak.ts',
          status: 'added',
          beforeSha256: null,
          afterSha256: createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content),
          text: false,
          contentBase64: Buffer.from(content).toString('base64'),
        },
      ],
    }
    const bundle = { ...payload, checksum: contributionChecksum(payload) }
    const bundlePath = join(official, 'forged.pilot.json')
    await writeFile(bundlePath, JSON.stringify(bundle))

    const script = resolve(__dirname, '..', '..', 'scripts', 'contribution-review.mjs')
    await expect(
      run(process.execPath, [script, 'inspect', bundlePath, '--root', official]),
    ).rejects.toThrow(/secret/)
  })

  it('refuses to apply when the official base changed after submission', async () => {
    const { source, base, data } = await fixture()
    const personal = service(source, base, data)
    const version = await personal.saveVersion({ name: '冲突候选' })
    const record = await personal.submitVersion(version.id, '会产生冲突')

    const official = await workspace('pilot-official-conflict-')
    await write(official, 'package.json', JSON.stringify({ version: '0.1.24' }))
    await write(official, 'src/main.ts', 'export const greeting = "changed upstream"\n')
    await write(official, 'src/old.ts', 'export const old = true\n')

    const script = resolve(__dirname, '..', '..', 'scripts', 'contribution-review.mjs')
    await expect(
      run(process.execPath, [script, 'apply', record.path, '--yes', '--root', official]),
    ).rejects.toThrow(/refusing to apply|base hash mismatch/)
  })
})

async function upgradeFixture(): Promise<{
  source: string
  base: string
  next: string
  data: string
}> {
  const root = await workspace('pilot-upgrade-')
  const source = join(root, 'source')
  const base = join(root, 'base')
  const next = join(root, 'next')
  const data = join(root, 'personal')
  const oldPackage = JSON.stringify({ version: '0.1.24' })
  const newPackage = JSON.stringify({ version: '0.1.25' })
  await write(base, 'package.json', oldPackage)
  await write(source, 'package.json', oldPackage)
  await write(next, 'package.json', newPackage)

  await write(base, 'src/merge.ts', 'line one\nline two\nline three\n')
  await write(source, 'src/merge.ts', 'line one changed\nline two\nline three\n')
  await write(next, 'src/merge.ts', 'line one\nline two\nline three changed\n')
  for (const root of [base, source, next]) await write(root, 'src/keep.ts', 'keep\n')
  await write(base, 'src/removed.ts', 'gone\n')
  await write(source, 'src/removed.ts', 'gone\n')
  await write(source, 'src/user.ts', 'user\n')
  await write(next, 'src/official.ts', 'official\n')
  return { source, base, next, data }
}

describe('official upgrade merge', () => {
  it('rebases personal edits onto the new official baseline', async () => {
    const { source, base, next, data } = await upgradeFixture()
    const before = await service(source, base, data).state()
    expect(before.upgrade).toEqual({
      available: false,
      fromVersion: '0.1.24',
      toVersion: '0.1.24',
      requiresManual: false,
    })

    const upgraded = service(source, next, data, undefined, '0.1.25')
    expect((await upgraded.state()).upgrade).toEqual({
      available: true,
      fromVersion: '0.1.24',
      toVersion: '0.1.25',
      requiresManual: false,
    })
    const plan = await upgraded.prepareUpgrade()
    expect(plan.counts).toEqual({ upstream: 3, kept: 1, merged: 1, conflicts: 0 })
    expect(plan.requiresManual).toBe(false)
    // Saving against a moved baseline would record official edits as personal ones.
    await expect(upgraded.saveVersion({ name: '不应保存' })).rejects.toThrow('请先合并官方更新')

    const result = await upgraded.applyUpgrade()
    expect(result.conflicts).toHaveLength(0)
    expect(result.merged).toBe(1)
    const merged = await readFile(join(source, 'src/merge.ts'), 'utf8')
    expect(merged).toContain('line one changed')
    expect(merged).toContain('line three changed')
    expect(await readFile(join(source, 'src/official.ts'), 'utf8')).toBe('official\n')
    expect(await readFile(join(source, 'src/user.ts'), 'utf8')).toBe('user\n')
    await expect(readFile(join(source, 'src/removed.ts'), 'utf8')).rejects.toThrow()
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version).toBe('0.1.25')
    expect(await readFile(join(result.backupPath, 'backup.json'), 'utf8')).toContain(
      'src/merge.ts',
    )

    const after = await upgraded.state()
    expect(after.upgrade.available).toBe(false)
    expect(after.baseVersion).toBe('0.1.25')
  })

  it('writes conflict markers when both sides changed the same lines', async () => {
    const root = await workspace('pilot-upgrade-conflict-')
    const source = join(root, 'source')
    const base = join(root, 'base')
    const next = join(root, 'next')
    const data = join(root, 'personal')
    const oldPackage = JSON.stringify({ version: '0.1.24' })
    await write(base, 'package.json', oldPackage)
    await write(source, 'package.json', oldPackage)
    await write(next, 'package.json', JSON.stringify({ version: '0.1.25' }))
    await write(base, 'src/conflict.ts', 'a\nb\nc\n')
    await write(source, 'src/conflict.ts', 'a\nuser\nc\n')
    await write(next, 'src/conflict.ts', 'a\nofficial\nc\n')

    const upgraded = service(source, next, data, undefined, '0.1.25')
    await service(source, base, data).state()
    const plan = await upgraded.prepareUpgrade()
    expect(plan.conflicts).toEqual([{ path: 'src/conflict.ts', reason: 'both-modified' }])
    expect(plan.counts.conflicts).toBe(1)

    const result = await upgraded.applyUpgrade()
    expect(result.conflicts).toHaveLength(1)
    const text = await readFile(join(source, 'src/conflict.ts'), 'utf8')
    expect(text).toContain('<<<<<<< 我的版本')
    expect(text).toContain('user')
    expect(text).toContain('=======')
    expect(text).toContain('official')
    expect(text).toContain('>>>>>>> 官方 v0.1.25')
    expect((await upgraded.state()).upgrade.available).toBe(false)
  })

  it('leaves the merge unverified when dependencies are missing', async () => {
    const { source, base, next, data } = await upgradeFixture()
    await service(source, base, data).state()
    const upgraded = service(source, next, data, undefined, '0.1.25')
    await upgraded.applyUpgrade()
    expect((await upgraded.state()).lastUpgrade?.validation).toBe('pending')

    const report = await upgraded.validateUpgrade()
    expect(report.validation).toBe('skipped')
    expect(report.message).toContain('依赖')
    expect((await upgraded.state()).lastUpgrade?.validation).toBe('skipped')
  })

  it('rolls the merge back to the pre-merge source and baseline', async () => {
    const { source, base, next, data } = await upgradeFixture()
    await service(source, base, data).state()
    const upgraded = service(source, next, data, undefined, '0.1.25')
    await upgraded.applyUpgrade()
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version).toBe('0.1.25')
    expect(await readFile(join(source, 'src/official.ts'), 'utf8')).toBe('official\n')

    await upgraded.rollbackUpgrade()

    expect(await readFile(join(source, 'src/merge.ts'), 'utf8')).toBe(
      'line one changed\nline two\nline three\n',
    )
    expect(await readFile(join(source, 'src/user.ts'), 'utf8')).toBe('user\n')
    await expect(readFile(join(source, 'src/official.ts'), 'utf8')).rejects.toThrow()
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version).toBe('0.1.24')

    const state = await upgraded.state()
    expect(state.baseVersion).toBe('0.1.24')
    expect(state.upgrade.available).toBe(true)
    expect(state.lastUpgrade).toBeUndefined()
    await expect(upgraded.rollbackUpgrade()).rejects.toThrow('没有可以撤销的升级合并')
  })

  it('falls back to manual migration when the old baseline was never captured', async () => {
    const { source, base, next, data } = await upgradeFixture()
    await service(source, base, data).state()
    await rm(join(data, 'bases'), { recursive: true, force: true })

    const upgraded = service(source, next, data, undefined, '0.1.25')
    expect((await upgraded.state()).upgrade.requiresManual).toBe(true)
    const fingerprintBefore = await sourceFingerprint(source)
    const plan = await upgraded.prepareUpgrade()
    expect(plan.requiresManual).toBe(true)
    expect(plan.officialCopyPath).toBe('.pilot-upgrade/official')
    expect(await readFile(join(source, '.pilot-upgrade', 'official', 'package.json'), 'utf8')).toContain(
      '0.1.25',
    )
    // The reference copy must not count as a personal change or a build input.
    expect(await sourceFingerprint(source)).toBe(fingerprintBefore)
    await expect(upgraded.applyUpgrade()).rejects.toThrow('手动迁移')
  })
})
