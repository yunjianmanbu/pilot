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

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

/** One store, one project, and two model resources with keys. */
async function setup(): Promise<{ store: Store; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-session-model-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  await mkdir(userDataDir, { recursive: true })
  const workspace = join(root, 'project')
  await mkdir(workspace, { recursive: true })
  const store = new Store()
  await store.load()
  await store.addWorkspace(workspace, { activate: false })
  await store.updateSettings({
    modelResources: [
      {
        id: 'primary',
        label: '主模型',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        enabled: true,
        apiKey: 'sk-personal',
      },
      {
        id: 'second',
        label: '备用模型',
        baseUrl: 'https://api.example.com',
        model: 'other-model',
        enabled: true,
        apiKey: 'sk-other',
      },
    ],
    sessionModelId: 'primary',
  })
  store.setActiveWorkspace(workspace)
  return { store, workspace }
}

describe('per-task session model', () => {
  it('lets one task pin a model that beats the global choice', async () => {
    const { store, workspace } = await setup()
    const task = await store.createSession(workspace)
    const other = await store.createSession(workspace)

    await store.setSessionModel(task.id, 'second')

    expect(store.sessionModelTarget(task.id)?.model).toBe('other-model')
    // A sibling task without its own choice keeps following the global model.
    expect(store.sessionModelTarget(other.id)?.model).toBe('deepseek-chat')
    expect(store.sessionModelTarget()?.model).toBe('deepseek-chat')
  })

  it('carries the choice on summaries and survives a reload', async () => {
    const { store, workspace } = await setup()
    const task = await store.createSession(workspace)
    await store.setSessionModel(task.id, 'second')

    expect(store.session(task.id)?.sessionModelId).toBe('second')
    expect(store.sessions(workspace)[0]?.sessionModelId).toBe('second')

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.session(task.id)?.sessionModelId).toBe('second')
    expect(reloaded.sessionModelTarget(task.id)?.model).toBe('other-model')
  })

  it('clears back to the inherited model instead of keeping a ghost id', async () => {
    const { store, workspace } = await setup()
    const task = await store.createSession(workspace)
    await store.setSessionModel(task.id, 'second')
    await store.setSessionModel(task.id, '')

    expect(store.session(task.id)?.sessionModelId).toBe('')
    expect(store.sessionModelTarget(task.id)?.model).toBe('deepseek-chat')
  })

  it('rejects unknown model ids and unknown sessions', async () => {
    const { store, workspace } = await setup()
    const task = await store.createSession(workspace)
    await expect(store.setSessionModel(task.id, 'missing')).rejects.toThrow('指定的模型不存在')
    await expect(store.setSessionModel('missing', 'primary')).rejects.toThrow('Session not found')
  })

  it('keeps the pinned model on a fork and falls back when the resource is removed', async () => {
    const { store, workspace } = await setup()
    const task = await store.createSession(workspace)
    await store.setSessionModel(task.id, 'second')

    const fork = await store.forkSession(task.id)
    expect(fork.sessionModelId).toBe('second')

    // Deleting the resource must not leave the task pointing at a ghost id.
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
          apiKey: 'sk-personal',
        },
      ],
    })
    expect(store.sessionModelTarget(task.id)?.model).toBe('deepseek-chat')
  })
})
