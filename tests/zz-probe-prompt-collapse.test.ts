/**
 * 探针：prompt 快照之后的第一条 shell 快照，会不会把 prompt 快照改名成 shell？
 * Windows 上 watcher 一直在报事件，dirty 非空，复用门槛进不去，所以本地一直是绿的。
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

class FakeWatcher extends EventEmitter {
  closed = false
  constructor(private readonly listener: (event: string, filename: string | null) => void) {
    super()
  }
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

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getLocale: () => 'zh-CN' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('nope')
    },
    decryptString: () => {
      throw new Error('nope')
    },
  },
}))

import { CheckpointService } from '../src/main/checkpoints'
import { Store } from '../src/main/store'

const cleanups: string[] = []
afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('probe: prompt snapshot must survive a following shell snapshot', () => {
  it('does not relabel the prompt snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-probe-prompt-'))
    cleanups.push(root)
    userDataDir = join(root, 'user-data')
    const workspacePath = join(root, 'workspace')
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(join(workspacePath, 'src', 'a.txt'), 'original\n', 'utf8')
    const store = new Store()
    await store.load()
    const workspace = await store.addWorkspace(workspacePath)
    const session = await store.createSession(workspace.path)
    const service = new CheckpointService(userDataDir, store)
    try {
      const runStart = await service.create({
        sessionId: session.id,
        workspacePath,
        label: 'run start',
        messageCount: 0,
        trigger: 'prompt',
        retention: 6,
      })
      const shell = await service.create({
        sessionId: session.id,
        workspacePath,
        label: 'shell 0',
        messageCount: 1,
        trigger: 'shell',
        retention: 6,
      })
      console.log('runStart:', runStart.id.slice(0, 8), 'shell:', shell.id.slice(0, 8))
      const list = await service.list(session.id)
      console.log('list:', list.length, JSON.stringify(list.map((entry) => entry.label)))
      expect(shell.id).not.toBe(runStart.id)
      expect(list).toHaveLength(2)
    } finally {
      service.dispose()
    }
  }, 30_000)
})