import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getLocale: () => 'zh-CN',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { CheckpointService } from '../src/main/checkpoints'
import { Store } from '../src/main/store'
import type { StoredMessage } from '../src/shared/types'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-checkpoints-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(join(workspacePath, 'src'), { recursive: true })
  await writeFile(join(workspacePath, 'src', 'a.txt'), 'original\n', 'utf8')
  await writeFile(join(workspacePath, 'b.txt'), 'second\n', 'utf8')
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  const session = await store.createSession(workspace.path)
  const service = new CheckpointService(userDataDir, store)
  return { root, store, service, session, workspacePath }
}

function message(id: string, content: string): StoredMessage {
  return { id, role: 'user', content, createdAt: new Date().toISOString() }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Blobs currently stored (one file per unique content). */
async function blobFiles(): Promise<string[]> {
  const root = join(userDataDir, 'checkpoints', 'blobs')
  let entries: string[]
  try {
    entries = (await readdir(root, { recursive: true })) as string[]
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const info = await stat(join(root, entry)).catch(() => null)
    if (info?.isFile()) files.push(entry)
  }
  return files
}

async function blobBytes(): Promise<number> {
  const root = join(userDataDir, 'checkpoints', 'blobs')
  let total = 0
  for (const entry of await blobFiles()) {
    const info = await stat(join(root, entry)).catch(() => null)
    if (info?.isFile()) total += info.size
  }
  return total
}

interface PersistedMaintenance {
  version: number
  blobBytes: number
  legacyBytes: number
  lastMaintenanceAt: number
  lastAuditAt: number
  lastTrashSweepAt: number
}

async function readMaintenanceState(): Promise<PersistedMaintenance> {
  return JSON.parse(
    await readFile(join(userDataDir, 'checkpoints', '.maintenance.json'), 'utf8'),
  ) as PersistedMaintenance
}

async function manifestFor(sessionId: string, checkpointId: string) {
  const dir = join(userDataDir, 'checkpoints', sessionId, checkpointId)
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Array<{
    path: string
    size: number
    sha256: string
  }>
}

function blobPathFor(sha256: string): string {
  return join(userDataDir, 'checkpoints', 'blobs', sha256.slice(0, 2), sha256)
}

describe('checkpoint service', () => {
  beforeEach(() => {
    userDataDir = ''
  })

  it('snapshots workspace files and restores them', async () => {
    const { service, session, workspacePath } = await setup()

    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'before edit',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    expect(checkpoint.complete).toBe(true)
    expect(checkpoint.files).toBe(2)
    expect(checkpoint.label).toBe('before edit')

    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed\n', 'utf8')
    await rm(join(workspacePath, 'b.txt'))
    await writeFile(join(workspacePath, 'extra.txt'), 'new file\n', 'utf8')

    const result = await service.restore(session.id, checkpoint.id, 'code')
    expect(result.restoredFiles).toBe(2)
    expect(result.removedFiles).toBe(1)
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe('original\n')
    expect(await readFile(join(workspacePath, 'b.txt'), 'utf8')).toBe('second\n')
    expect(await exists(join(workspacePath, 'extra.txt'))).toBe(false)
  })

  it('keeps ignored build output out of the snapshot but leaves it on disk', async () => {
    const { service, session, workspacePath } = await setup()
    await mkdir(join(workspacePath, 'tmp', 'nested'), { recursive: true })
    await mkdir(join(workspacePath, '.build'), { recursive: true })
    await writeFile(join(workspacePath, 'tmp', 'scratch.log'), 'noise\n')
    await writeFile(join(workspacePath, 'tmp', 'nested', 'more.log'), 'noise\n')
    await writeFile(join(workspacePath, '.build', 'cache.bin'), 'noise\n')

    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'ignore generated output',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
      ignore: ['tmp', '.build'],
    })

    expect(checkpoint.files).toBe(2)
    const manifest = await manifestFor(session.id, checkpoint.id)
    expect(manifest.map((entry) => entry.path).sort()).toEqual(['b.txt', 'src/a.txt'])
    // The exclusion is about the snapshot, not about the workspace.
    expect(await exists(join(workspacePath, 'tmp', 'scratch.log'))).toBe(true)
  })

  it('honours a workspace-rooted pattern and a glob', async () => {
    const { service, session, workspacePath } = await setup()
    await mkdir(join(workspacePath, 'src', 'cache'), { recursive: true })
    await mkdir(join(workspacePath, 'dist-old'), { recursive: true })
    await writeFile(join(workspacePath, 'src', 'cache', 'c.json'), '{}\n')
    await writeFile(join(workspacePath, 'dist-old', 'out.js'), 'x\n')
    await writeFile(join(workspacePath, 'tmp.txt'), 'keep me\n')

    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'rooted + glob',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
      ignore: ['src/cache', 'dist-*'],
    })

    const paths = (await manifestFor(session.id, checkpoint.id)).map((entry) => entry.path)
    expect(paths).toContain('src/a.txt')
    expect(paths).toContain('tmp.txt')
    expect(paths).not.toContain('src/cache/c.json')
    expect(paths).not.toContain('dist-old/out.js')
  })

  it('drops index entries that a newly added pattern now excludes', async () => {
    const { service, session, workspacePath } = await setup()
    await mkdir(join(workspacePath, 'tmp'), { recursive: true })
    await writeFile(join(workspacePath, 'tmp', 'a.log'), 'first\n')

    const before = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'before ignore',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
    })
    expect(before.files).toBe(3)

    const after = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'after ignore',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
      ignore: ['tmp'],
    })
    expect(after.files).toBe(2)
    const paths = (await manifestFor(session.id, after.id)).map((entry) => entry.path)
    expect(paths).not.toContain('tmp/a.log')
  })

  it('excludes .git and node_modules from snapshots', async () => {
    const { service, session, workspacePath } = await setup()
    await mkdir(join(workspacePath, '.git', 'objects'), { recursive: true })
    await mkdir(join(workspacePath, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspacePath, '.git', 'HEAD'), 'ref: main\n')
    await writeFile(join(workspacePath, 'node_modules', 'pkg', 'index.js'), 'x\n')

    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'no vendor',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
    })
    expect(checkpoint.files).toBe(2)
    expect(checkpoint.bytes).toBeGreaterThan(0)
  })

  it('rewinds the conversation without touching files', async () => {
    const { store, service, session, workspacePath } = await setup()
    await store.addMessages(session.id, [message('m1', 'one'), message('m2', 'two')])
    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'two messages',
      messageCount: 2,
      trigger: 'prompt',
      retention: 20,
    })
    await store.addMessages(session.id, [message('m3', 'three'), message('m4', 'four')])
    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed\n', 'utf8')

    const result = await service.restore(session.id, checkpoint.id, 'conversation')
    expect(result.truncatedMessages).toBe(2)
    expect(result.restoredFiles).toBe(0)
    expect(result.session.messages.map((entry) => entry.id)).toEqual(['m1', 'm2'])
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe('changed\n')
  })

  it('deduplicates unchanged files across snapshots', async () => {
    const { service, session, workspacePath } = await setup()
    const snapshot = () =>
      service.create({
        sessionId: session.id,
        workspacePath,
        label: 'dedup',
        messageCount: 0,
        trigger: 'manual',
        retention: 20,
      })

    await snapshot()
    await snapshot()
    // Two files, one blob each; the second snapshot reuses both.
    expect(await blobFiles()).toHaveLength(2)

    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed\n', 'utf8')
    await snapshot()
    expect(await blobFiles()).toHaveLength(3)
  })

  it('reuses indexed hashes, hashes only changed files, and survives a restart', async () => {
    const { store, service, session, workspacePath } = await setup()
    const snapshot = (target = service) =>
      target.create({
        sessionId: session.id,
        workspacePath,
        label: 'incremental',
        messageCount: 0,
        trigger: 'manual',
        retention: 20,
      })

    const first = await snapshot()
    expect(first.hashed).toBe(2)
    expect(first.reused).toBe(0)

    const second = await snapshot()
    expect(second.hashed).toBe(0)
    expect(second.reused).toBe(2)

    // A fresh service loads the persisted index, so even the first snapshot
    // after an app restart avoids re-hashing unchanged content.
    const restarted = new CheckpointService(userDataDir, store)
    const third = await snapshot(restarted)
    expect(third.hashed).toBe(0)
    expect(third.reused).toBe(2)
    restarted.dispose()

    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed-longer\n', 'utf8')
    const fourth = await snapshot()
    expect(fourth.hashed).toBe(1)
    expect(fourth.reused).toBe(1)

    await rm(join(workspacePath, 'b.txt'))
    const fifth = await snapshot()
    expect(fifth.files).toBe(1)
    expect(fifth.reused).toBe(1)
  })

  it('skips media files without marking an otherwise complete snapshot incomplete', async () => {
    const { service, session, workspacePath } = await setup()
    await writeFile(join(workspacePath, 'logo.png'), Buffer.alloc(4_096, 1))
    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'binary',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    expect(checkpoint.complete).toBe(true)
    expect(checkpoint.files).toBe(2)
    expect(checkpoint.skipped).toBe(1)
    const manifest = await manifestFor(session.id, checkpoint.id)
    expect(manifest.some((entry) => entry.path.endsWith('.png'))).toBe(false)
  })

  it('keeps media files that a complete snapshot never captured', async () => {
    const { service, session, workspacePath } = await setup()
    const media = Buffer.alloc(4_096, 7)
    await mkdir(join(workspacePath, 'assets'), { recursive: true })
    await writeFile(join(workspacePath, 'assets', 'logo.png'), media)
    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'before edit',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    expect(checkpoint.complete).toBe(true)
    expect(checkpoint.skipped).toBe(1)

    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed\n', 'utf8')
    await writeFile(join(workspacePath, 'extra.txt'), 'agent output\n', 'utf8')
    const result = await service.restore(session.id, checkpoint.id, 'code')

    expect(result.removedFiles).toBe(1)
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe('original\n')
    expect(await exists(join(workspacePath, 'extra.txt'))).toBe(false)
    // The snapshot never stored the PNG, so restore must leave it untouched
    // instead of treating it as a file created after the snapshot.
    expect(await readFile(join(workspacePath, 'assets', 'logo.png'))).toEqual(media)
  })

  it('refuses to revert a media path that the snapshot never captured', async () => {
    const { service, session, workspacePath } = await setup()
    await writeFile(join(workspacePath, 'logo.png'), Buffer.alloc(4_096, 7))
    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'binary',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    await expect(
      service.revertPaths(session.id, checkpoint.id, ['logo.png']),
    ).rejects.toThrow(/媒体或二进制文件/)
    expect(await exists(join(workspacePath, 'logo.png'))).toBe(true)
  })

  it('refuses to restore a snapshot whose content was tampered with', async () => {
    const { service, session, workspacePath } = await setup()
    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'integrity',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed\n', 'utf8')

    const entry = (await manifestFor(session.id, checkpoint.id)).find(
      (item) => item.path === 'b.txt',
    )
    expect(entry).toBeDefined()
    // Same size, different bytes: only the hash can catch this.
    await writeFile(blobPathFor(entry!.sha256), 'tamper\n', 'utf8')

    await expect(service.restore(session.id, checkpoint.id, 'code')).rejects.toThrow(
      /integrity|damaged/,
    )
    // Nothing may be written when any part of the snapshot is damaged.
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe('changed\n')
    expect(await readFile(join(workspacePath, 'b.txt'), 'utf8')).toBe('second\n')
  })

  it('evicts the oldest snapshots to stay under the global budget', async () => {
    const { service, session, workspacePath } = await setup()
    await rm(join(workspacePath, 'b.txt'))
    const snapshots = []
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(workspacePath, 'src', 'a.txt'), String(index).repeat(100), 'utf8')
      snapshots.push(
        await service.create({
          sessionId: session.id,
          workspacePath,
          label: `budget ${index}`,
          messageCount: 0,
          trigger: 'manual',
          retention: 20,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
    expect(await blobFiles()).toHaveLength(3)

    await service.maintain({ maxBytes: 150, force: true })
    const remaining = await service.list(session.id)
    expect(remaining).toHaveLength(1)
    // The newest snapshot is never evicted.
    expect(remaining[0]?.id).toBe(snapshots[2]?.id)
    expect(await blobFiles()).toHaveLength(1)
  })

  it('keeps the newest snapshot of every session under budget pressure', async () => {
    const { store, service, session, workspacePath } = await setup()
    const second = await store.createSession(workspacePath)
    const created: Record<string, string> = {}
    for (const [key, target] of [
      ['a', session],
      ['b', second],
    ] as const) {
      for (let index = 0; index < 2; index += 1) {
        await writeFile(
          join(workspacePath, 'b.txt'),
          `${key}${index}`.repeat(100),
          'utf8',
        )
        const checkpoint = await service.create({
          sessionId: target.id,
          workspacePath,
          label: `${key}${index}`,
          messageCount: 0,
          trigger: 'manual',
          retention: 20,
        })
        created[`${key}${index}`] = checkpoint.id
        await new Promise((resolve) => setTimeout(resolve, 8))
      }
    }

    await service.maintain({ maxBytes: 150, force: true })
    expect((await service.list(session.id)).map((item) => item.id)).toEqual([created['a1']])
    expect((await service.list(second.id)).map((item) => item.id)).toEqual([created['b1']])
  })

  it('skips the full scan while the persisted estimate is under budget', async () => {
    const { store, service, session, workspacePath } = await setup()
    await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'tracked',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    // Make the state look like a clean shutdown from a while ago, without
    // pushing the audit deadline, so only the budget gate decides.
    const statePath = join(userDataDir, 'checkpoints', '.maintenance.json')
    const persisted = await readMaintenanceState()
    await writeFile(
      statePath,
      JSON.stringify({ ...persisted, lastMaintenanceAt: 0, lastAuditAt: Date.now() }),
      'utf8',
    )

    const restarted = new CheckpointService(userDataDir, store)
    const scanAll = vi.spyOn(
      restarted as unknown as { scanAll: () => Promise<unknown> },
      'scanAll',
    )
    const budget = 10 * 1024 * 1024
    await restarted.maintain({ maxBytes: budget })
    expect(scanAll).not.toHaveBeenCalled()

    // Crossing the budget makes the same call scan and collect orphans.
    await restarted.maintain({ maxBytes: 1 })
    expect(scanAll).toHaveBeenCalled()
    scanAll.mockRestore()
  })

  it('persists incremental blob bytes across a restart without scanning', async () => {
    const { store, service, session, workspacePath } = await setup()
    await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'first',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    const firstBytes = await blobBytes()
    expect((await readMaintenanceState()).blobBytes).toBe(firstBytes)

    const restarted = new CheckpointService(userDataDir, store)
    const scanAll = vi.spyOn(
      restarted as unknown as { scanAll: () => Promise<unknown> },
      'scanAll',
    )
    await writeFile(join(workspacePath, 'src', 'a.txt'), 'unique new content\n', 'utf8')
    await restarted.create({
      sessionId: session.id,
      workspacePath,
      label: 'second',
      messageCount: 1,
      trigger: 'manual',
      retention: 20,
      maxBytes: 10 * 1024 * 1024,
    })

    expect(scanAll).not.toHaveBeenCalled()
    const nextBytes = await blobBytes()
    expect(nextBytes).toBeGreaterThan(firstBytes)
    expect((await readMaintenanceState()).blobBytes).toBe(nextBytes)
    scanAll.mockRestore()
  })

  it('restores a version-1 snapshot that keeps its own files directory', async () => {
    const { service, session, workspacePath } = await setup()
    const content = 'original\n'
    const sha256 = createHash('sha256').update(content).digest('hex')
    const dir = join(userDataDir, 'checkpoints', session.id, 'legacy-checkpoint')
    await mkdir(join(dir, 'files', 'src'), { recursive: true })
    await writeFile(join(dir, 'files', 'src', 'a.txt'), content, 'utf8')
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify([{ path: 'src/a.txt', size: Buffer.byteLength(content), sha256 }]),
      'utf8',
    )
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({
        version: 1,
        id: 'legacy-checkpoint',
        sessionId: session.id,
        workspacePath,
        label: '旧回退点',
        createdAt: '2025-01-01T00:00:00.000Z',
        messageCount: 0,
        files: 1,
        bytes: Buffer.byteLength(content),
        trigger: 'manual',
        complete: true,
        skipped: 0,
      }),
      'utf8',
    )
    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed\n', 'utf8')

    const result = await service.restore(session.id, 'legacy-checkpoint', 'code')
    expect(result.restoredFiles).toBe(1)
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe(content)
    expect((await service.list(session.id)).map((item) => item.id)).toContain(
      'legacy-checkpoint',
    )
  })

  it('sweeps unreferenced blobs but aborts when a manifest is unreadable', async () => {
    const { service, session, workspacePath } = await setup()
    const checkpoint = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'sweep',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    const orphan = join(userDataDir, 'checkpoints', 'blobs', 'ff', 'f'.repeat(64))
    await mkdir(dirname(orphan), { recursive: true })
    await writeFile(orphan, 'orphan', 'utf8')

    // A damaged manifest means the reference set is untrustworthy.
    const manifestPath = join(
      userDataDir,
      'checkpoints',
      session.id,
      checkpoint.id,
      'manifest.json',
    )
    const original = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, '{broken', 'utf8')
    await service.maintain({ maxBytes: 1, force: true })
    expect(await exists(orphan)).toBe(true)
    expect(await blobFiles()).toHaveLength(3)

    // Once the manifest is readable again the orphan is collected.
    await writeFile(manifestPath, original, 'utf8')
    await service.maintain({ maxBytes: 1, force: true })
    expect(await exists(orphan)).toBe(false)
    expect(await blobFiles()).toHaveLength(2)
  })

  it('prunes old snapshots down to the retention limit', async () => {
    const { service, session, workspacePath } = await setup()
    for (let index = 0; index < 6; index += 1) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 8))
      await service.create({
        sessionId: session.id,
        workspacePath,
        label: `snapshot ${index}`,
        messageCount: index,
        trigger: 'manual',
        retention: 5,
      })
    }
    const list = await service.list(session.id)
    // Retention plus the pinned baseline, which outlives the window on purpose.
    expect(list).toHaveLength(6)
    expect(list[0]?.label).toBe('snapshot 5')
    expect(list[list.length - 1]?.label).toBe('snapshot 0')
    expect(list[list.length - 1]?.baseline).toBe(true)
  })

  it('keeps the newest run-start snapshot when shell snapshots exceed retention', async () => {
    const { service, session, workspacePath } = await setup()
    const runStart = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'run start',
      messageCount: 0,
      trigger: 'prompt',
      retention: 6,
    })
    for (let index = 0; index < 10; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 8))
      await service.create({
        sessionId: session.id,
        workspacePath,
        label: `shell ${index}`,
        messageCount: index + 1,
        trigger: 'shell',
        retention: 6,
      })
    }
    const list = await service.list(session.id)
    expect(list).toHaveLength(7)
    expect(list.some((checkpoint) => checkpoint.id === runStart.id)).toBe(true)
    expect(list.map((checkpoint) => checkpoint.label)).toContain('shell 9')
  })

  it('reads the baseline of one file and reverts exactly that path', async () => {
    const { service, session, workspacePath } = await setup()
    const baseline = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'baseline',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
    })
    await new Promise((resolve) => setTimeout(resolve, 8))
    await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'later',
      messageCount: 1,
      trigger: 'prompt',
      retention: 20,
    })
    expect((await service.oldest(session.id))?.id).toBe(baseline.id)

    await writeFile(join(workspacePath, 'src', 'a.txt'), 'changed\n', 'utf8')
    await writeFile(join(workspacePath, 'extra.txt'), 'agent output\n', 'utf8')

    const snapshot = await service.readBaselineFile(session.id, baseline.id, 'src/a.txt')
    expect(snapshot).toEqual({ found: true, content: 'original\n' })
    expect(await service.readBaselineFile(session.id, baseline.id, 'missing.txt')).toEqual({
      found: false,
      content: null,
    })

    const result = await service.revertPaths(session.id, baseline.id, ['src/a.txt', 'extra.txt'])
    expect(result).toEqual({ restored: 1, removed: 1 })
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe('original\n')
    expect(await exists(join(workspacePath, 'extra.txt'))).toBe(false)
    // New files are moved into the revert trash, outside the snapshot tree so
    // that retention can never delete them.
    const trashRoot = join(userDataDir, 'checkpoints', 'trash')
    const batches = await readdir(trashRoot, { withFileTypes: true })
    expect(batches).toHaveLength(1)
    const trash = await readdir(join(trashRoot, batches[0]!.name), { recursive: true })
    expect(trash.some((entry) => entry.split(/[\\/]/).join('/').endsWith('extra.txt'))).toBe(true)
  })

  it('rejects reverting a path that escapes the workspace', async () => {
    const { service, session, workspacePath } = await setup()
    const baseline = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'baseline',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
    })
    await expect(
      service.revertPaths(session.id, baseline.id, ['../outside.txt']),
    ).rejects.toThrow(/Invalid file path|escapes/)
  })

  it('lists newest first and removes a session directory', async () => {
    const { service, session, workspacePath } = await setup()
    const first = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'first',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    await new Promise((resolve) => setTimeout(resolve, 8))
    const second = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'second',
      messageCount: 0,
      trigger: 'manual',
      retention: 20,
    })
    expect((await service.list(session.id)).map((entry) => entry.id)).toEqual([
      second.id,
      first.id,
    ])

    await service.removeSession(session.id)
    expect(await service.list(session.id)).toEqual([])
  })

  // --- trash survives checkpoint eviction --------------------------------

  async function trashFiles(): Promise<string[]> {
    const root = join(userDataDir, 'checkpoints', 'trash')
    let entries: string[]
    try {
      entries = (await readdir(root, { recursive: true })) as string[]
    } catch {
      return []
    }
    const files: string[] = []
    for (const entry of entries) {
      const info = await stat(join(root, entry)).catch(() => null)
      if (info?.isFile()) files.push(entry.split(/[\\/]/).join('/'))
    }
    return files
  }

  it('keeps reverted files on disk after retention and the global budget evict snapshots', async () => {
    const { service, session, workspacePath } = await setup()
    const baseline = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'baseline',
      messageCount: 0,
      trigger: 'prompt',
      retention: 2,
    })
    // A file the agent created after the baseline. Reverting moves it to trash.
    await writeFile(join(workspacePath, 'notes.md'), 'hand written\n', 'utf8')
    const reverted = await service.revertPaths(session.id, baseline.id, ['notes.md'])
    expect(reverted).toEqual({ restored: 0, removed: 1 })
    expect(await exists(join(workspacePath, 'notes.md'))).toBe(false)

    // Push the session well past its retention window and then squeeze the
    // global budget down to a single byte.
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(workspacePath, 'src', 'a.txt'), `v${index}\n`, 'utf8')
      await service.create({
        sessionId: session.id,
        workspacePath,
        label: `churn ${index}`,
        messageCount: index + 1,
        trigger: 'shell',
        retention: 2,
      })
    }
    await service.maintain({ maxBytes: 1, force: true })
    expect((await service.list(session.id)).length).toBeLessThanOrEqual(2)
    await service.maintain({ maxBytes: 1, force: true })

    const trash = await trashFiles()
    expect(trash.some((entry) => entry.endsWith('notes.md'))).toBe(true)
  })

  it('backs up an overwritten file into the trash during a per-file revert', async () => {
    const { service, session, workspacePath } = await setup()
    const baseline = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'baseline',
      messageCount: 0,
      trigger: 'prompt',
      retention: 30,
    })
    await writeFile(join(workspacePath, 'src', 'a.txt'), 'agent edit\n', 'utf8')
    await service.revertPaths(session.id, baseline.id, ['src/a.txt'])
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe('original\n')

    const trash = await trashFiles()
    const backup = trash.find((entry) => entry.endsWith('src/a.txt'))
    expect(backup).toBeTruthy()
    expect(await readFile(join(userDataDir, 'checkpoints', 'trash', backup!), 'utf8')).toBe(
      'agent edit\n',
    )
  })

  // --- restore is undoable ------------------------------------------------

  it('takes a safety snapshot before restoring and can undo the restore', async () => {
    const { service, session, workspacePath } = await setup()
    const target = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'before agent work',
      messageCount: 0,
      trigger: 'prompt',
      retention: 30,
    })

    await writeFile(join(workspacePath, 'src', 'a.txt'), 'agent work\n', 'utf8')
    await writeFile(join(workspacePath, 'generated.ts'), 'export const x = 1\n', 'utf8')

    const result = await service.restore(session.id, target.id, 'code')
    expect(result.restoredFiles).toBe(2)
    expect(result.removedFiles).toBe(1)
    expect(result.safetyCheckpointId).toBeTruthy()
    expect(await exists(join(workspacePath, 'generated.ts'))).toBe(false)

    const safety = (await service.list(session.id)).find(
      (entry) => entry.id === result.safetyCheckpointId,
    )
    expect(safety?.trigger).toBe('prerestore')
    expect(safety?.complete).toBe(true)

    // Undoing the restore puts the agent's work back.
    const undo = await service.restore(session.id, safety!.id, 'code')
    expect(undo.restoredFiles).toBe(3)
    expect(await readFile(join(workspacePath, 'src', 'a.txt'), 'utf8')).toBe('agent work\n')
    expect(await readFile(join(workspacePath, 'generated.ts'), 'utf8')).toBe(
      'export const x = 1\n',
    )
  })

  it('keeps the target snapshot when the safety snapshot hits the retention limit', async () => {
    const { service, session, workspacePath } = await setup()
    const snapshots = []
    for (let index = 0; index < 3; index += 1) {
      snapshots.push(
        await service.create({
          sessionId: session.id,
          workspacePath,
          label: `s${index}`,
          messageCount: index,
          trigger: 'shell',
          retention: 3,
        }),
      )
    }
    const target = snapshots[0]!
    await writeFile(join(workspacePath, 'src', 'a.txt'), 'later\n', 'utf8')
    const result = await service.restore(session.id, target.id, 'code')
    expect(result.safetyCheckpointId).toBeTruthy()
    // The snapshot that was just restored still exists, so the restore is
    // repeatable and the history stays readable.
    const list = await service.list(session.id)
    expect(list.some((entry) => entry.id === target.id)).toBe(true)
  })

  // --- baseline does not drift -------------------------------------------

  it('pins the first snapshot as the baseline across retention churn', async () => {
    const { service, session, workspacePath } = await setup()
    const baseline = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'baseline',
      messageCount: 0,
      trigger: 'prompt',
      retention: 3,
    })
    expect(baseline.baseline).toBe(true)

    for (let index = 0; index < 10; index += 1) {
      await writeFile(join(workspacePath, 'src', 'a.txt'), `v${index}\n`, 'utf8')
      await service.create({
        sessionId: session.id,
        workspacePath,
        label: `churn ${index}`,
        messageCount: index + 1,
        trigger: 'shell',
        retention: 3,
      })
    }

    // Review always compares against the same point, not against whatever is
    // left at the bottom of the retention window.
    const oldest = await service.oldest(session.id)
    expect(oldest?.id).toBe(baseline.id)
    expect(oldest?.label).toBe('baseline')
    expect((await service.list(session.id)).some((entry) => entry.id === baseline.id)).toBe(true)
    // Still usable as a diff source.
    expect(await service.readBaselineFile(session.id, baseline.id, 'src/a.txt')).toEqual({
      found: true,
      content: 'original\n',
    })
  }, 20_000)

  it('falls back to the oldest retained snapshot for sessions without a baseline flag', async () => {
    const { service, session, workspacePath } = await setup()
    const first = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'legacy',
      messageCount: 0,
      trigger: 'prompt',
      retention: 3,
    })
    // Simulate a meta.json written before baselines were recorded.
    const metaPath = join(userDataDir, 'checkpoints', session.id, first.id, 'meta.json')
    const raw = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    delete raw['baseline']
    await writeFile(metaPath, JSON.stringify(raw), 'utf8')

    await new Promise((resolve) => setTimeout(resolve, 8))
    const second = await service.create({
      sessionId: session.id,
      workspacePath,
      label: 'next',
      messageCount: 1,
      trigger: 'shell',
      retention: 3,
    })
    expect((await service.oldest(session.id))?.id).toBe(first.id)
    // The next retention pass heals the flag so it stops sliding.
    const healed = (await service.list(session.id)).find((entry) => entry.id === first.id)
    expect(healed?.baseline).toBe(true)
    expect(second.baseline).toBeUndefined()
  })
})
