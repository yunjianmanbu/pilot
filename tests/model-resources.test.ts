import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

async function setup(): Promise<{ store: Store; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-model-resources-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  await mkdir(userDataDir, { recursive: true })
  const store = new Store()
  await store.load()
  return { store, root }
}

describe('unified model resources', () => {
  it('starts with one session resource and no evaluators', async () => {
    const { store } = await setup()
    const view = store.modelSettingsView()
    expect(view.resources).toHaveLength(1)
    expect(view.resources[0]?.id).toBe(view.sessionModelId)
    expect(view.evaluationModelIds).toEqual([])
    expect(view.reviewModelId).toBe('')
    expect(store.evaluationTargets()).toEqual([])
  })

  it('stores a tag per resource and keeps it across reloads', async () => {
    const { store } = await setup()
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          tag: '个人',
          enabled: true,
          apiKey: 'sk-primary',
        },
        {
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          tag: '公司A',
          enabled: true,
          apiKey: 'sk-qwen',
        },
      ],
    })
    expect(store.modelSettingsView().resources.map((resource) => resource.tag)).toEqual([
      '个人',
      '公司A',
    ])

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.modelSettingsView().resources.map((resource) => resource.tag)).toEqual([
      '个人',
      '公司A',
    ])
  })

  it('rejects a tag longer than four characters at the contract boundary', async () => {
    const { store } = await setup()
    await expect(
      store.updateSettings({
        modelResources: [
          {
            id: 'primary',
            label: '主模型',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-chat',
            tag: '公司甲乙丙丁戊',
            enabled: true,
          },
        ],
      }),
    ).rejects.toThrow('模型标签最多 4 个字。')
  })

  it('creates resources, selects first and second evaluators, and persists them', async () => {
    const { store } = await setup()
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
          apiKey: 'sk-primary',
        },
        {
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          enabled: true,
          apiKey: 'sk-qwen',
        },
        {
          label: '智谱',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-4-plus',
          enabled: true,
          apiKey: 'sk-glm',
        },
      ],
    })
    const created = store.modelSettingsView()
    expect(created.resources).toHaveLength(3)
    expect(created.resources.every((resource) => resource.hasKey)).toBe(true)
    expect(created.resources.map((resource) => resource.keyHint)).toEqual([
      '••••mary',
      '••••qwen',
      '••••-glm',
    ])
    const qwen = created.resources.find((resource) => resource.model === 'qwen-plus')!
    const glm = created.resources.find((resource) => resource.model === 'glm-4-plus')!

    await store.updateSettings({
      sessionModelId: 'primary',
      evaluationModelIds: [qwen.id, glm.id],
    })
    expect(store.modelSettingsView().evaluationModelIds).toEqual([qwen.id, glm.id])
    expect(store.evaluationTargets().map((target) => target.model)).toEqual([
      'qwen-plus',
      'glm-4-plus',
    ])
    expect(store.settingsView().judgeProviders.map((judge) => judge.model)).toEqual([
      'qwen-plus',
      'glm-4-plus',
    ])

    const reloaded = new Store()
    await reloaded.load()
    const after = reloaded.modelSettingsView()
    expect(after.sessionModelId).toBe('primary')
    expect(after.evaluationModelIds).toEqual([qwen.id, glm.id])
    expect(reloaded.evaluationTargets().map((target) => target.apiKey)).toEqual([
      'sk-qwen',
      'sk-glm',
    ])
  })

  it('migrates a legacy primary endpoint and reviewer rows into resources once', async () => {
    const { root } = await setup()
    const key = (value: string) => Buffer.from(value, 'utf8').toString('base64')
    await writeFile(
      join(root, 'user-data', 'pilot-core.json'),
      JSON.stringify({
        settings: {
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKeyCipher: key('sk-legacy-main'),
          apiKeyPlain: true,
          judgeProviders: [
            {
              id: 'judge-qwen',
              label: '通义千问',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              model: 'qwen-plus',
              enabled: true,
              keyCipher: key('sk-legacy-qwen'),
              keyPlain: true,
            },
            {
              id: 'judge-glm',
              label: '智谱',
              baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
              model: 'glm-4-plus',
              enabled: false,
              keyCipher: key('sk-legacy-glm'),
              keyPlain: true,
            },
          ],
        },
      }),
      'utf8',
    )
    const store = new Store()
    await store.load()
    const view = store.modelSettingsView()
    expect(view.resources.map((resource) => resource.model)).toEqual([
      'deepseek-chat',
      'qwen-plus',
      'glm-4-plus',
    ])
    expect(view.sessionModelId).toBe('primary')
    // Only enabled legacy reviewers become evaluation models.
    expect(view.evaluationModelIds).toEqual(['judge-qwen'])
    expect(store.sessionModelTarget()?.apiKey).toBe('sk-legacy-main')
    expect(store.evaluationTargets().map((target) => target.model)).toEqual(['qwen-plus'])

    // The migration is idempotent: a saved store already has resources.
    await store.save()
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.modelSettingsView().resources).toHaveLength(3)
    expect(reloaded.modelSettingsView().evaluationModelIds).toEqual(['judge-qwen'])
  })

  it('keeps one resource key when another is cleared or edited', async () => {
    const { store } = await setup()
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
          apiKey: 'sk-primary',
        },
        {
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          enabled: true,
          apiKey: 'sk-qwen',
        },
      ],
    })
    const created = store.modelSettingsView()
    const qwen = created.resources.find((resource) => resource.model === 'qwen-plus')!
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
        },
        {
          id: qwen.id,
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-max',
          enabled: true,
          apiKey: null,
        },
      ],
    })
    const view = store.modelSettingsView()
    expect(view.resources[0]?.hasKey).toBe(true)
    expect(view.resources[1]?.hasKey).toBe(false)
    expect(view.resources[1]?.model).toBe('qwen-max')
  })

  it('rejects a missing session resource and duplicate evaluators', async () => {
    const { store } = await setup()
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
        },
        {
          id: 'judge-qwen',
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          enabled: true,
        },
      ],
    })
    await expect(
      store.updateSettings({ sessionModelId: 'missing-resource' }),
    ).rejects.toThrow('会话模型必须选择一个已配置的模型资源。')
    await store.updateSettings({
      sessionModelId: 'primary',
      evaluationModelIds: ['judge-qwen', 'judge-qwen'],
    })
    expect(store.modelSettingsView().evaluationModelIds).toEqual(['judge-qwen'])
  })

  it('drops disabled evaluators and refuses a disabled session or review model', async () => {
    const { store } = await setup()
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
        },
        {
          id: 'judge-qwen',
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          enabled: false,
          apiKey: 'sk-qwen',
        },
      ],
      sessionModelId: 'primary',
      evaluationModelIds: ['judge-qwen'],
    })
    expect(store.modelSettingsView().evaluationModelIds).toEqual(['judge-qwen'])
    expect(store.evaluationTargets()).toEqual([])
    await expect(
      store.updateSettings({ sessionModelId: 'judge-qwen' }),
    ).rejects.toThrow('会话模型不能使用已停用的模型资源。')
    await expect(
      store.updateSettings({ reviewModelId: 'judge-qwen' }),
    ).rejects.toThrow('复盘模型不能使用已停用的模型资源。')
  })

  it('clears a review selection without resurrecting the old model name', async () => {
    const { store } = await setup()
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
          apiKey: 'sk-main',
        },
        {
          id: 'judge-qwen',
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          enabled: true,
          apiKey: 'sk-qwen',
        },
      ],
      reviewModelId: 'judge-qwen',
    })
    expect(store.settingsView().reviewModel).toBe('qwen-plus')
    await store.updateSettings({ reviewModelId: '' })
    expect(store.settingsView().reviewModel).toBe('')
    expect(store.reviewModelTarget()?.model).toBe('deepseek-chat')

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.modelSettingsView().reviewModelId).toBe('')
    expect(reloaded.settingsView().reviewModel).toBe('')
  })

  it('lists every resource in billing with the session resource first', async () => {
    const { store } = await setup()
    await store.updateSettings({
      modelResources: [
        {
          id: 'primary',
          label: '主模型',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          enabled: true,
          apiKey: 'sk-main',
        },
        {
          id: 'judge-qwen',
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          enabled: true,
          apiKey: 'sk-qwen',
        },
      ],
      sessionModelId: 'judge-qwen',
    })
    const accounts = store.billingAccounts()
    expect(accounts.map((account) => account.id)).toEqual(['judge-qwen', 'primary'])
    expect(accounts.map((account) => account.role)).toEqual(['primary', 'judge'])
  })
})
