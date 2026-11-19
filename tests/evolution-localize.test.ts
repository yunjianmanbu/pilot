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

function fakeClient(responses: string[]): ModelClient & { calls: number; system: string[] } {
  let index = 0
  const system: string[] = []
  const client = {
    calls: 0,
    system,
    async complete(input: { messages: Array<{ role: string; content: string }> }): Promise<ModelResponse> {
      client.calls += 1
      const first = input.messages.find((message) => message.role === 'system')
      if (first) system.push(first.content)
      const content = responses[Math.min(index, responses.length - 1)] ?? '{}'
      index += 1
      return {
        content,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }
    },
  }
  return client
}

async function setup(): Promise<{ store: Store; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-evolution-localize-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  return { store, workspacePath: workspace.path }
}

const ENGLISH_RULES = 'Run the narrowest relevant test before committing; never bypass the approval gate.'
const ENGLISH_RATIONALE = 'Runs that verified before committing had fewer failures.'

describe('profile localization', () => {
  it('creates a Chinese workspace draft and leaves the active version untouched', async () => {
    const { store, workspacePath } = await setup()
    const source = await store.createProfileDraft(workspacePath, {
      promptAddendum: ENGLISH_RULES,
      rationale: ENGLISH_RATIONALE,
      source: 'user',
      strategy: { maxSteps: 120 },
      evidence: { runs: 6, failures: 1, avgSteps: 4, avgTokens: 900, positive: 2, negative: 0 },
    })
    const model = fakeClient([
      JSON.stringify({
        promptAddendum: '提交前运行最相关的测试；不要绕过审批。',
        rationale: '提交前做过验证的运行失败更少。',
      }),
    ])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'translator',
    )

    const draft = await service.localize('workspace', workspacePath, source.id)
    expect(draft.id).not.toBe(source.id)
    expect(draft.version).toBe(source.version + 1)
    expect(draft.status).toBe('draft')
    expect(draft.promptAddendum).toContain('最相关的测试')
    expect(draft.rationale).toContain('失败更少')
    expect(draft.source).toBe('user')
    expect(draft.strategy.maxSteps).toBe(120)
    expect(draft.evidence.runs).toBe(6)
    expect(store.activeProfile(workspacePath)).toBeNull()
    expect(store.workspaceDetail(workspacePath).profiles).toHaveLength(2)
    expect(model.calls).toBe(1)
    expect(model.system[0]).toContain('Simplified Chinese')
  })

  it('creates a Chinese global draft without enabling it', async () => {
    const { store } = await setup()
    const source = await store.createGlobalProfileDraft({
      promptAddendum: ENGLISH_RULES,
      rationale: ENGLISH_RATIONALE,
      source: 'promoted',
    })
    const model = fakeClient([
      JSON.stringify({
        promptAddendum: '提交前运行最相关的测试；不要绕过审批。',
        rationale: '跨项目证据显示验证能减少失败。',
      }),
    ])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'translator',
    )

    const draft = await service.localize('global', '', source.id)
    expect(draft.scope).toBe('global')
    expect(draft.status).toBe('draft')
    expect(draft.promptAddendum).toContain('最相关的测试')
    expect(draft.source).toBe('promoted')
    expect(store.activeGlobalProfile()).toBeNull()
  })

  it('rejects a translation that is not Chinese', async () => {
    const { store, workspacePath } = await setup()
    const source = await store.createProfileDraft(workspacePath, {
      promptAddendum: ENGLISH_RULES,
      rationale: ENGLISH_RATIONALE,
      source: 'user',
    })
    const model = fakeClient([
      JSON.stringify({ promptAddendum: ENGLISH_RULES, rationale: 'Same text again.' }),
    ])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'translator',
    )

    await expect(service.localize('workspace', workspacePath, source.id)).rejects.toThrow()
  })

  it('does not translate an already Chinese profile', async () => {
    const { store, workspacePath } = await setup()
    const source = await store.createProfileDraft(workspacePath, {
      promptAddendum: '提交前运行最相关的测试。',
      rationale: '证据显示这样更稳。',
      source: 'user',
    })
    const model = fakeClient([JSON.stringify({ promptAddendum: 'x', rationale: 'y' })])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'translator',
    )

    await expect(service.localize('workspace', workspacePath, source.id)).rejects.toThrow()
    expect(model.calls).toBe(0)
  })
})
