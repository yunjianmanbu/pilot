/**
 * Snapshot scan strategy: which files a snapshot walks, when it may trust the
 * watcher's dirty set instead of walking, and how a dead watcher recovers.
 *
 * `node:fs`'s `watch` is mocked so the failure modes (error event, unattributable
 * event, dirty overflow) can be triggered deterministically instead of waiting
 * for a real platform failure, and so a change can be made *without* a watcher
 * event — which is the only way to observe whether a snapshot walked.
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getLocale: () => 'zh-CN' },
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

/** Fake recursive watchers, one per `watch()` call. */
class FakeWatcher extends EventEmitter {
  closed = false
  constructor(private readonly listener: (event: string, filename: string | null) => void) {
    super()
  }

  /** Deliver a real filesystem event to the callback `watch()` was given. */
  fire(event: string, filename: string | null): void {
    this.listener(event, filename)
  }

  close(): void {
    this.closed = true
    this.emit('close')
  }
}

const watchers: FakeWatcher[] = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: (
      _path: string,
      _options: unknown,
      listener: (event: string, filename: string | null) => void,
    ) => {
      const watcher = new FakeWatcher(listener)
      watchers.push(watcher)
      return watcher as unknown as import('node:fs').FSWatcher
    },
  }
})

import { CheckpointService } from '../src/main/checkpoints'
import { Store } from '../src/main/store'

const cleanups: string[] = []

beforeEach(() => {
  userDataDir = ''
  watchers.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pilot-watch-'))
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
  const snapshot = (ignore: string[] = []) =>
    service.create({
      sessionId: session.id,
      workspacePath,
      label: 'snap',
      messageCount: 0,
      trigger: 'prompt',
      retention: 20,
      ignore,
    })
  return { store, service, session, workspacePath, snapshot }
}

async function manifestPaths(sessionId: string, checkpointId: string): Promise<string[]> {
  const dir = join(userDataDir, 'checkpoints', sessionId, checkpointId)
  const raw = await readFile(join(dir, 'manifest.json'), 'utf8')
  return (JSON.parse(raw) as Array<{ path: string }>).map((entry) => entry.path)
}

describe('checkpoint watcher self-heal', () => {
  it('keeps snapshots correct when the watcher dies, and retries it with backoff', async () => {
    const { service, session, workspacePath, snapshot } = await setup()
    try {
      const first = await snapshot()
      expect(watchers).toHaveLength(1)
      expect(first.files).toBe(2)

      // The platform reported a failure the watcher could not attribute.
      watchers[0]!.emit('error', new Error('EMFILE'))

      // A file changes while the watcher is dead and nothing reports it; the
      // snapshot after the failure must still be complete because it cannot
      // trust the dirty set.
      await writeFile(join(workspacePath, 'c.txt'), 'third\n', 'utf8')
      const second = await snapshot()
      expect(second.files).toBe(3)
      expect(second.complete).toBe(true)
      // The dead watcher is closed instead of being leaked.
      expect(watchers[0]!.closed).toBe(true)
      // One immediate retry is allowed…
      expect(watchers).toHaveLength(2)

      // …then the next attempt within the backoff window is skipped.
      watchers[1]!.emit('error', new Error('EMFILE'))
      await snapshot()
      expect(watchers).toHaveLength(2)
      await snapshot()
      expect(watchers).toHaveLength(2)

      // Once the backoff has elapsed the watcher is re-attached.
      vi.advanceTimersByTime(20_000)
      await snapshot()
      expect(watchers).toHaveLength(3)

      // And a healthy watcher is not re-attached on every snapshot.
      await snapshot()
      await snapshot()
      expect(watchers).toHaveLength(3)

      expect((await manifestPaths(session.id, second.id)).sort()).toEqual([
        'b.txt',
        'c.txt',
        'src/a.txt',
      ])
    } finally {
      service.dispose()
    }
  })

  it('gives up after the retry budget instead of re-attaching forever', async () => {
    const { service, snapshot } = await setup()
    try {
      await snapshot()
      // Every attach fails immediately; each pass through the backoff allows
      // one more attempt until the budget is spent.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = watchers.length
        if (current === 0) break
        watchers[current - 1]!.emit('error', new Error('EMFILE'))
        vi.advanceTimersByTime(11 * 60_000)
        await snapshot()
      }
      // Bounded: the budget is 12 attempts, so we never see dozens of attaches.
      expect(watchers.length).toBeLessThanOrEqual(13)
      // The workspace keeps working on the full-walk path.
      const last = await snapshot()
      expect(last.complete).toBe(true)
    } finally {
      service.dispose()
    }
  })

  it('stops trusting the dirty set after an unattributable event', async () => {
    const { service, workspacePath, snapshot } = await setup()
    try {
      await snapshot()
      // A null filename means the platform lost attribution: the collected
      // paths are incomplete, so they must be discarded, not applied.
      await writeFile(join(workspacePath, 'c.txt'), 'third\n', 'utf8')
      watchers[0]!.fire('change', null)
      const after = await snapshot()
      expect(after.files).toBe(3)
      expect(after.complete).toBe(true)
    } finally {
      service.dispose()
    }
  })

  it('does not attach a watcher when watching is disabled', async () => {
    const { store, service, session, workspacePath } = await setup()
    const disabled = new CheckpointService(userDataDir, store, { watch: false })
    try {
      const checkpoint = await disabled.create({
        sessionId: session.id,
        workspacePath,
        label: 'no watch',
        messageCount: 0,
        trigger: 'prompt',
        retention: 20,
      })
      expect(checkpoint.files).toBe(2)
      expect(watchers).toHaveLength(0)
      const statInfo = await stat(join(workspacePath, 'b.txt'))
      expect(statInfo.isFile()).toBe(true)
    } finally {
      disabled.dispose()
      service.dispose()
    }
  })
})

describe('shell snapshot reuse', () => {
  /**
   * `beforeShell` fires before every command. On a workspace with no changes
   * that used to mean a walk per command; the snapshot can simply be relabelled,
   * because the tree it captured is still exactly what is on disk.
   */
  it('relabels the previous shell snapshot when nothing changed', async () => {
    const { service, session, workspacePath } = await setup()
    const create = (label: string, trigger: 'prompt' | 'shell') =>
      service.create({
        sessionId: session.id,
        workspacePath,
        label,
        messageCount: 0,
        trigger,
        retention: 20,
      })
    try {
      // The first snapshot establishes the index; reuse needs a fresh index.
      await create('run start', 'prompt')
      const first = await create('Shell 前：npm test', 'shell')
      const second = await create('Shell 前：npm run build', 'shell')
      expect(second.id).toBe(first.id)
      expect(second.label).toBe('Shell 前：npm run build')
      expect(watchers).toHaveLength(1)

      // A reported change makes the cached tree stale, so a new snapshot appears.
      await writeFile(join(workspacePath, 'c.txt'), 'third\n', 'utf8')
      watchers[0]!.fire('change', 'c.txt')
      const third = await create('Shell 前：npm run lint', 'shell')
      expect(third.id).not.toBe(first.id)
      expect(third.files).toBe(3)

      // `prompt` snapshots are never collapsed: they mark a boundary the user
      // asked for.
      const prompt = await create('after review', 'prompt')
      expect(prompt.id).not.toBe(third.id)
    } finally {
      service.dispose()
    }
  })

  it('does not reuse a shell snapshot whose meta file is gone', async () => {
    const { service, session, workspacePath } = await setup()
    const create = (label: string) =>
      service.create({
        sessionId: session.id,
        workspacePath,
        label,
        messageCount: 0,
        trigger: 'shell',
        retention: 6,
      })
    try {
      const first = await create('Shell 前：one')
      // Retention and work-budget eviction both delete a checkpoint directory
      // without telling the running session. Reusing its id would hand the user
      // a rollback point that no longer exists.
      await rm(join(userDataDir, 'checkpoints', session.id, first.id), {
        recursive: true,
        force: true,
      })
      const next = await create('Shell 前：two')
      expect(next.id).not.toBe(first.id)
      expect(next.complete).toBe(true)
      expect(next.files).toBe(2)
    } finally {
      service.dispose()
    }
  })
})

describe('checkpoint fast-path threshold', () => {
  /**
   * The threshold decides whether a snapshot may trust the watcher instead of
   * walking. A silent change (no watcher event) is the observable difference:
   * the fast path cannot see it, a full walk can.
   */
  it('counts snapshottable files, not raw files, when deciding to walk', async () => {
    const { store, service, session, workspacePath } = await setup()
    // 40 generated files plus 2 real ones. The old check compared the raw count
    // (42) against the threshold and would have trusted the watcher forever.
    await mkdir(join(workspacePath, 'tmp'), { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(workspacePath, 'tmp', `noise-${index}.log`), 'x\n')
    }
    const scoped = new CheckpointService(userDataDir, store, { fastPathMinFiles: 10 })
    try {
      const snapshot = () =>
        scoped.create({
          sessionId: session.id,
          workspacePath,
          label: 'snap',
          messageCount: 0,
          trigger: 'prompt',
          retention: 20,
          ignore: ['tmp'],
        })
      const first = await snapshot()
      expect(first.files).toBe(2)

      // Written without a watcher event: only a real walk can find it.
      await writeFile(join(workspacePath, 'c.txt'), 'third\n', 'utf8')
      const second = await snapshot()
      expect(second.files).toBe(3)
    } finally {
      scoped.dispose()
      service.dispose()
    }
  })

  it('trusts the watcher once enough snapshottable files make a walk expensive', async () => {
    const { store, service, session, workspacePath } = await setup()
    const scoped = new CheckpointService(userDataDir, store, { fastPathMinFiles: 1 })
    try {
      const snapshot = () =>
        scoped.create({
          sessionId: session.id,
          workspacePath,
          label: 'snap',
          messageCount: 0,
          trigger: 'prompt',
          retention: 20,
        })
      expect((await snapshot()).files).toBe(2)

      // The watcher is healthy and the workspace is above the threshold, so the
      // second snapshot takes the dirty-set path and misses this silent write.
      await writeFile(join(workspacePath, 'c.txt'), 'third\n', 'utf8')
      expect((await snapshot()).files).toBe(2)

      // A reported change is picked up, which proves the fast path is live and
      // not just walking every time.
      await writeFile(join(workspacePath, 'c.txt'), 'third\n', 'utf8')
      watchers[0]!.fire('change', 'c.txt')
      expect((await snapshot()).files).toBe(3)
    } finally {
      scoped.dispose()
      service.dispose()
    }
  })
})
