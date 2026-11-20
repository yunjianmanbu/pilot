import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

import { Store } from '../src/main/store'
import { MEMORY_ENTRY_MAX_CHARS } from '../src/shared/memory'
import { selectMemories } from '../src/main/agent/memory'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<{ store: Store; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-memory-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  return { store, workspacePath: workspace.path }
}

describe('Store project memory', () => {
  it('infers a category and starts the counters at zero', async () => {
    const { store, workspacePath } = await setup()
    const entry = await store.addMemory(workspacePath, '根目录没有 tsconfig.json', 'reflection')
    expect(entry.category).toBe('negative')
    expect(entry.reinforced).toBe(0)
    expect(entry.injected).toBe(0)
    expect(entry.lastUsedAt).toBeTruthy()
  })

  it('honours an explicit category over inference', async () => {
    const { store, workspacePath } = await setup()
    const entry = await store.addMemory(
      workspacePath,
      'pnpm typecheck 覆盖两个 tsconfig',
      'agent',
      undefined,
      'verification',
    )
    expect(entry.category).toBe('verification')
  })

  it('keeps a single entry short enough for the prompt budget', async () => {
    const { store, workspacePath } = await setup()
    const entry = await store.addMemory(workspacePath, 'x'.repeat(2_000), 'user')
    expect(entry.content.length).toBe(MEMORY_ENTRY_MAX_CHARS)
  })

  it('counts a re-derived lesson instead of storing it twice', async () => {
    const { store, workspacePath } = await setup()
    const first = await store.addMemory(workspacePath, '必须在 pilot/pilot 下跑 tsc', 'reflection')
    const second = await store.addMemory(workspacePath, '必须在 pilot/pilot 下跑 tsc', 'reflection')
    expect(second.id).toBe(first.id)
    expect(store.memory(workspacePath)).toHaveLength(1)
    expect(store.memory(workspacePath)[0]?.reinforced).toBe(1)
  })

  it('records injections so ranking can see what is actually used', async () => {
    const { store, workspacePath } = await setup()
    const entry = await store.addMemory(workspacePath, 'addMemory 在 store.ts', 'agent')
    await store.noteMemoryInjected(workspacePath, [entry.id])
    await store.noteMemoryInjected(workspacePath, [entry.id])
    // Unknown ids must not create entries or throw.
    await store.noteMemoryInjected(workspacePath, ['missing'])
    const stored = store.memory(workspacePath)[0]
    expect(stored?.injected).toBe(2)
    expect(store.memory(workspacePath)).toHaveLength(1)
  })

  it('survives a reload with its category and counters intact', async () => {
    const { store, workspacePath } = await setup()
    const entry = await store.addMemory(workspacePath, 'App.vue 与 styles.css 色值必须同步', 'agent')
    await store.noteMemoryInjected(workspacePath, [entry.id])
    await store.addMemory(workspacePath, 'App.vue 与 styles.css 色值必须同步', 'agent')

    const reloaded = new Store()
    await reloaded.load()
    const stored = reloaded.memory(workspacePath)[0]
    expect(stored?.category).toBe('invariant')
    expect(stored?.injected).toBe(1)
    expect(stored?.reinforced).toBe(1)
    expect(selectMemories(reloaded.memory(workspacePath))).toHaveLength(1)
  })

  it('rejects secrets and empty content', async () => {
    const { store, workspacePath } = await setup()
    await expect(store.addMemory(workspacePath, '   ', 'user')).rejects.toThrow()
    await expect(
      store.addMemory(workspacePath, 'sk-abcdefghijklmnopqrstuvwxyz012345', 'user'),
    ).rejects.toThrow()
  })
})
