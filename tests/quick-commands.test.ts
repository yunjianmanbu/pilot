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

import { MAX_QUICK_COMMANDS, Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<Store> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-quick-commands-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  await mkdir(userDataDir, { recursive: true })
  const store = new Store()
  await store.load()
  return store
}

describe('quick commands', () => {
  it('starts uncustomized so the built-in prompts stay localized', async () => {
    const store = await setup()
    expect(store.quickCommands()).toBeNull()
  })

  it('trims, dedupes and caps the saved list', async () => {
    const store = await setup()
    const saved = await store.saveQuickCommands([
      { content: '  运行测试  ' },
      { content: '运行测试' },
      { content: '   ' },
      ...Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) => ({
        content: `指令 ${index}`,
      })),
    ])

    expect(saved).toHaveLength(MAX_QUICK_COMMANDS)
    expect(saved[0]).toEqual({ content: '运行测试', id: expect.any(String) })
    expect(new Set(saved.map((command) => command.id)).size).toBe(saved.length)
    expect(store.quickCommands()).toEqual(saved)
  })

  it('keeps existing ids across edits and generates ids for new rows', async () => {
    const store = await setup()
    const [first] = await store.saveQuickCommands([{ content: '原来那条' }])
    const saved = await store.saveQuickCommands([
      { id: first!.id, content: '改过的那条' },
      { content: '新加的一条' },
    ])

    expect(saved[0]?.id).toBe(first!.id)
    expect(saved[0]?.content).toBe('改过的那条')
    expect(saved[1]?.id).toBeTruthy()
  })

  it('persists a customized list, including an explicitly empty one', async () => {
    const store = await setup()
    await store.saveQuickCommands([{ content: '保留我' }])

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.quickCommands()?.map((command) => command.content)).toEqual(['保留我'])

    await reloaded.saveQuickCommands([])
    const emptied = new Store()
    await emptied.load()
    expect(emptied.quickCommands()).toEqual([])
  })
})
