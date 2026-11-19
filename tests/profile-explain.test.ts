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

import { EvolutionService } from '../src/main/agent/evolution'
import { Store } from '../src/main/store'
import type { ModelClient, ModelResponse } from '../src/main/agent/loop'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

/** Replays a fixed list of replies and records the prompts it received. */
function fakeClient(replies: Array<string | Error>): ModelClient & {
  calls: number
  system: string[]
  user: string[]
} {
  let index = 0
  const client = {
    calls: 0,
    system: [] as string[],
    user: [] as string[],
    async complete(input: {
      messages: Array<{ role: string; content: string }>
    }): Promise<ModelResponse> {
      client.calls += 1
      const system = input.messages.find((message) => message.role === 'system')
      const user = input.messages.find((message) => message.role === 'user')
      if (system) client.system.push(system.content)
      if (user) client.user.push(user.content)
      const reply = replies[Math.min(index, replies.length - 1)] ?? '{}'
      index += 1
      if (reply instanceof Error) throw reply
      return {
        content: reply,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }
    },
  }
  return client
}

async function setup(): Promise<{ store: Store; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-profile-explain-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  return { store, workspacePath: workspace.path }
}

const OLD_RULES = [
  '1. 根目录读取失败时先列目录再定位子项目。',
  '2. 每次改动后运行最相关的测试并报告结果。',
].join('\n')
const NEW_RULES = [
  OLD_RULES,
  '3. 交付前用一句话说明未验证项。',
].join('\n')

const SENTENCE = {
  headline: '改完经常不告诉你去验什么就跑下一个任务',
  changes: ['每完成一次改动，会先跑最相关的检查，再用一句话说清哪些没验证。'],
  impact: '你不用再追问改完到底验过没有。',
  risks: ['检查会多花一点时间，长任务会慢一些。'],
  recommend: 'enable',
  reason: '这条规则来自最近失败的记录，风险很小。',
}

/** Create the active baseline plus a draft that defaults to it. */
async function seed(store: Store, workspacePath: string) {
  const baseline = await store.createProfileDraft(workspacePath, {
    promptAddendum: OLD_RULES,
    rationale: '早期证据。',
    source: 'user',
  })
  await store.activateProfile(workspacePath, baseline.id)
  const draft = await store.createProfileDraft(workspacePath, {
    promptAddendum: NEW_RULES,
    rationale: '两次交付没有说明验证情况。',
    source: 'self',
  })
  return { baseline, draft }
}

describe('EvolutionService.explain', () => {
  it('stores the model plain-language summary on the draft', async () => {
    const { store, workspacePath } = await setup()
    const { baseline, draft } = await seed(store, workspacePath)
    const model = fakeClient([JSON.stringify(SENTENCE)])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'deepseek-flash',
    )

    const result = await service.explain('workspace', workspacePath, draft.id)

    expect(result.explanation?.headline).toBe(SENTENCE.headline)
    expect(result.explanation?.recommend).toBe('enable')
    expect(result.explanation?.changes).toHaveLength(1)
    expect(result.explanation?.model).toBe('deepseek-flash')
    // The prompt must describe the change against the running version.
    expect(model.user[0]).toContain(`v${baseline.version}`)
    expect(model.user[0]).toContain('交付前用一句话说明未验证项')
    expect(model.system[0]).toContain('everyday Simplified Chinese')
    // Persisted, so the panel does not need to re-ask.
    expect(store.workspaceDetail(workspacePath).profiles.find((item) => item.id === draft.id)?.explanation?.headline).toBe(
      SENTENCE.headline,
    )
  })

  it('falls back to a mechanical summary when the model fails', async () => {
    const { store, workspacePath } = await setup()
    const { draft } = await seed(store, workspacePath)
    const model = fakeClient([new Error('fetch failed')])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'deepseek-flash',
    )

    const result = await service.explain('workspace', workspacePath, draft.id)

    expect(result.explanation?.recommend).toBe('observe')
    expect(result.explanation?.headline).toContain('新增 1 条')
    expect(result.explanation?.model).toBeUndefined()
  })

  it('falls back when the model answers without usable fields', async () => {
    const { store, workspacePath } = await setup()
    const { draft } = await seed(store, workspacePath)
    const model = fakeClient(['not json at all'])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'deepseek-flash',
    )

    const result = await service.explain('workspace', workspacePath, draft.id)
    expect(result.explanation?.recommend).toBe('observe')
    expect(result.explanation?.changes.length).toBeGreaterThan(0)
  })

  it('marks a draft without review as unproven in the fallback impact', async () => {
    const { store, workspacePath } = await setup()
    const { draft } = await seed(store, workspacePath)
    const model = fakeClient([new Error('timeout')])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'deepseek-flash',
    )

    const result = await service.explain('workspace', workspacePath, draft.id)
    expect(result.explanation?.impact).toContain('没有证据')
  })

  it('keeps the explanation through a store reload', async () => {
    const { store, workspacePath } = await setup()
    const { draft } = await seed(store, workspacePath)
    const model = fakeClient([JSON.stringify(SENTENCE)])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'deepseek-flash',
    )
    await service.explain('workspace', workspacePath, draft.id)

    const reloaded = new Store()
    await reloaded.load()
    const profile = reloaded.workspaceDetail(workspacePath).profiles.find((item) => item.id === draft.id)
    expect(profile?.explanation?.headline).toBe(SENTENCE.headline)
    expect(profile?.explanation?.risks).toHaveLength(1)
  })

  it('rejects an unknown profile', async () => {
    const { store, workspacePath } = await setup()
    const model = fakeClient([JSON.stringify(SENTENCE)])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'deepseek-flash',
    )
    await expect(service.explain('workspace', workspacePath, 'missing')).rejects.toThrow()
    expect(model.calls).toBe(0)
  })

  it('explains a global draft against the active global profile', async () => {
    const { store, workspacePath } = await setup()
    await seed(store, workspacePath)
    const globalBaseline = await store.createGlobalProfileDraft({
      promptAddendum: OLD_RULES,
      rationale: '跨项目证据。',
      source: 'promoted',
    })
    await store.activateGlobalProfile(globalBaseline.id)
    const globalDraft = await store.createGlobalProfileDraft({
      promptAddendum: NEW_RULES,
      rationale: '跨项目证据。',
      source: 'promoted',
    })
    const model = fakeClient([JSON.stringify(SENTENCE)])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'deepseek-flash',
    )

    const result = await service.explain('global', workspacePath, globalDraft.id)
    expect(result.explanation?.headline).toBe(SENTENCE.headline)
    expect(model.user[0]).toContain('all projects on this computer')
    expect(store.globalProfile(globalDraft.id)?.explanation?.headline).toBe(SENTENCE.headline)
    // The active global profile must not be touched.
    expect(store.activeGlobalProfile()?.id).toBe(globalBaseline.id)
  })
})
