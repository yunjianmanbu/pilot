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

import { EvolutionService, type ProfileJudge } from '../src/main/agent/evolution'
import type { ModelClient, ModelResponse } from '../src/main/agent/loop'
import { Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function fakeClient(responses: string[], fail = false): ModelClient & { calls: number } {
  let index = 0
  const client = {
    calls: 0,
    async complete(): Promise<ModelResponse> {
      client.calls += 1
      if (fail) throw new Error('reviewer endpoint rejected the request')
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

function judge(id: string, model: string, client: ModelClient, external = true): ProfileJudge {
  return { id, label: id, model, external, client }
}

async function setup(): Promise<{ store: Store; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-evolution-judge-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  const session = await store.createSession(workspace.path)
  for (let index = 0; index < 4; index += 1) {
    await store.startRun(workspace.path, {
      id: `run-${index}`,
      sessionId: session.id,
      prompt: `task ${index}`,
      status: 'running',
      startedAt: new Date(Date.now() + index * 1_000).toISOString(),
      steps: 4,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      toolCalls: 2,
      toolErrors: 0,
    })
    await store.finishRun(workspace.path, `run-${index}`, { status: 'completed' })
  }
  return { store, workspacePath: workspace.path }
}

const PROPOSAL = JSON.stringify({
  promptAddendum: 'Read the failing test output before changing the implementation.',
  rationale: 'Recent failures show the same premature-edit pattern.',
})

function verdict(score: number, pass: boolean): string {
  return JSON.stringify({ score, pass, notes: `score ${score}`, risks: [] })
}

/** A measured win: the only verdict that now permits activation. */
function better() {
  return {
    verdict: 'better' as const,
    tasks: 3,
    wins: 3,
    losses: 0,
    ties: 0,
    current: { successRate: 0.6, avgSteps: 8, avgTokens: 1_200 },
    candidate: { successRate: 1, avgSteps: 5, avgTokens: 900 },
    reasons: ['候选版本 3 个任务全部完成，步数更少。'],
    at: new Date().toISOString(),
  }
}

async function draft(store: Store, workspacePath: string): Promise<string> {
  const profile = await store.createProfileDraft(workspacePath, {
    promptAddendum: 'Read the failing test output before changing the implementation.',
    rationale: 'Recent failures show the same premature-edit pattern.',
    source: 'self',
    strategy: {},
    evidence: store.evidence(workspacePath),
  })
  return profile.id
}

describe('multi-judge profile review', () => {
  it('marks a review independent only when external reviewers passed', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [
        judge('qwen', 'qwen-plus', fakeClient([verdict(86, true)])),
        judge('glm', 'glm-4-plus', fakeClient([verdict(81, true)])),
      ],
    )

    const result = await service.review(workspacePath, profileId, {
      comparison: better(),
    })
    const review = result.profile.review

    expect(review).toBeDefined()
    expect(review!.pass).toBe(true)
    expect(review!.independent).toBe(true)
    expect(review!.score).toBe(81)
    expect(review!.model).toBe('qwen-plus + glm-4-plus')
    expect(review!.judges?.map((entry) => entry.score)).toEqual([86, 81])
    expect(review!.judgeErrors).toBeUndefined()
    expect(result.activated).toBe(true)
  })

  it('accepts a verdict whose score and pass arrive as strings', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [
        judge(
          'qwen',
          'Qwen3.8-Max',
          fakeClient([
            '```json\n{"score":"86","pass":"true","notes":"ok","risks":[]}\n```',
          ]),
        ),
      ],
    )

    const result = await service.review(workspacePath, profileId, {
      comparison: better(),
    })

    expect(result.profile.review!.judges?.[0]?.score).toBe(86)
    expect(result.profile.review!.pass).toBe(true)
    expect(result.activated).toBe(true)
  })

  it('blocks activation when any reviewer rejects the profile', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [
        judge('qwen', 'qwen-plus', fakeClient([verdict(90, true)])),
        judge('glm', 'glm-4-plus', fakeClient([verdict(58, false)])),
      ],
    )

    const result = await service.review(workspacePath, profileId)

    expect(result.activated).toBe(false)
    expect(result.profile.review!.pass).toBe(false)
    expect(result.profile.review!.score).toBe(58)
    expect(store.activeProfile(workspacePath)).toBeNull()
  })

  it('blocks activation when a configured reviewer fails and records why', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [
        judge('qwen', 'qwen-plus', fakeClient([verdict(88, true)])),
        judge('glm', 'glm-4-plus', fakeClient([], true)),
      ],
    )

    const result = await service.review(workspacePath, profileId)

    expect(result.activated).toBe(false)
    expect(result.profile.review!.pass).toBe(false)
    expect(result.profile.review!.judgeErrors?.[0]).toContain('glm')
    expect(store.activeProfile(workspacePath)).toBeNull()
  })

  it('falls back to the run model and flags the review as not independent', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const self = fakeClient([verdict(84, true)])
    const service = new EvolutionService(store, () => self, () => 'test-model')

    const result = await service.review(workspacePath, profileId, {
      comparison: better(),
    })

    expect(self.calls).toBe(1)
    expect(result.profile.review!.independent).toBe(false)
    expect(result.profile.review!.judges?.[0]?.id).toBe('default')
    expect(result.profile.review!.risks?.[0]).toContain('还没有配置评估模型')
    expect(result.activated).toBe(true)
  })

  it('suggests another source when every configured judge is same-source', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [judge('qwen', 'qwen-plus', fakeClient([verdict(88, true)]), false)],
    )

    const result = await service.review(workspacePath, profileId, {
      comparison: better(),
    })
    const review = result.profile.review!

    expect(review.independent).toBe(false)
    expect(review.pass).toBe(true)
    expect(review.risks?.[0]).toContain('同源')
    expect(result.activated).toBe(true)
  })

  it('does not activate when the measured benchmark says the candidate is worse', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [judge('qwen', 'qwen-plus', fakeClient([verdict(92, true)]))],
    )

    const result = await service.review(workspacePath, profileId, {
      comparison: {
        verdict: 'worse',
        tasks: 3,
        wins: 0,
        losses: 2,
        ties: 1,
        current: { successRate: 1, avgSteps: 5, avgTokens: 900 },
        candidate: { successRate: 0.33, avgSteps: 9, avgTokens: 1_800 },
        reasons: ['候选版本在 2 个任务上更差，只在 0 个任务上更好。'],
        at: new Date().toISOString(),
      },
    })

    expect(result.activated).toBe(false)
    expect(result.profile.review!.pass).toBe(false)
    expect(result.profile.review!.comparison!.verdict).toBe('worse')
    expect(result.profile.review!.risks).toContain('实测能力下降')
    expect(store.activeProfile(workspacePath)).toBeNull()
  })

  it('does not activate on a passing review when the benchmark found no difference', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [judge('qwen', 'qwen-plus', fakeClient([verdict(88, true)]))],
    )

    const result = await service.review(workspacePath, profileId, {
      comparison: {
        verdict: 'inconclusive',
        tasks: 3,
        wins: 1,
        losses: 1,
        ties: 1,
        current: { successRate: 0.67, avgSteps: 6, avgTokens: 1_000 },
        candidate: { successRate: 0.67, avgSteps: 6, avgTokens: 1_000 },
        reasons: ['差异不足以证明提升。'],
        at: new Date().toISOString(),
      },
    })

    expect(result.activated).toBe(false)
    expect(result.profile.review!.pass).toBe(true)
    expect(result.profile.review!.comparison!.verdict).toBe('inconclusive')
    expect(result.profile.review!.activation?.ready).toBe(false)
    expect(result.profile.review!.activation?.reasons).toContain('实测没有明显优于当前版本')
    expect(store.activeProfile(workspacePath)).toBeNull()
  })

  it('blocks a workspace candidate that deletes a rule without a reason', async () => {
    const { store, workspacePath } = await setup()
    const baseline = await store.createProfileDraft(workspacePath, {
      promptAddendum: "Prefer the repository's existing helper functions.",
      rationale: 'Baseline rule.',
      source: 'self',
    })
    await store.activateProfile(workspacePath, baseline.id)
    const candidate = await store.createProfileDraft(workspacePath, {
      promptAddendum: 'Use descriptive variable names.',
      rationale: 'A proposed rewrite.',
      source: 'self',
    })
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [judge('qwen', 'qwen-plus', fakeClient([verdict(90, true)]))],
    )

    const result = await service.review(workspacePath, candidate.id, {
      comparison: better(),
    })

    expect(result.activated).toBe(false)
    expect(result.profile.review?.pass).toBe(false)
    expect(result.profile.review?.removals?.[0]?.justified).toBe(false)
    expect(result.profile.review?.activation?.reasons).toContain('删除旧规则缺少评审理由')
    expect(store.activeProfile(workspacePath)?.id).toBe(baseline.id)
  })

  it('keeps the activation gate and removal reasons across a reload', async () => {
    const { store, workspacePath } = await setup()
    const baseline = await store.createProfileDraft(workspacePath, {
      promptAddendum: "Prefer the repository's existing helper functions.",
      rationale: 'Baseline rule.',
      source: 'self',
    })
    await store.activateProfile(workspacePath, baseline.id)
    const candidate = await store.createProfileDraft(workspacePath, {
      promptAddendum: 'Use descriptive variable names.',
      rationale: 'A proposed rewrite.',
      source: 'self',
    })
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [judge('qwen', 'qwen-plus', fakeClient([verdict(90, true)]))],
    )
    await service.review(workspacePath, candidate.id, { comparison: better() })

    const reloaded = new Store()
    await reloaded.load()
    const review = reloaded
      .workspaceDetail(workspacePath)
      .profiles.find((entry) => entry.id === candidate.id)?.review

    expect(review?.activation?.ready).toBe(false)
    expect(review?.activation?.reasons).toContain('删除旧规则缺少评审理由')
    expect(review?.removals?.[0]?.justified).toBe(false)
    expect(review?.comparison?.verdict).toBe('better')
    expect(review?.baselineVersion).toBe(baseline.version)
  })

  it('does not activate a passing review without a measured comparison', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await draft(store, workspacePath)
    const service = new EvolutionService(
      store,
      () => fakeClient([PROPOSAL]),
      () => 'test-model',
      () => [judge('qwen', 'qwen-plus', fakeClient([verdict(90, true)]))],
    )

    const result = await service.review(workspacePath, profileId)

    expect(result.activated).toBe(false)
    expect(result.profile.review!.pass).toBe(true)
    expect(result.profile.review!.activation?.ready).toBe(false)
    expect(result.profile.review!.activation?.reasons).toContain(
      '尚未与当前版本完成实测对比',
    )
  })
})

describe('judge provider settings', () => {
  it('stores a per-provider key and exposes only a hint', async () => {
    const { store } = await setup()
    const view = await store.updateSettings({
      judgeProviders: [
        {
          label: '通义千问',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          model: 'qwen-plus',
          apiKey: 'sk-qwen-secret',
        },
      ],
    })

    expect(view.judgeProviders).toHaveLength(1)
    const saved = view.judgeProviders[0]!
    expect(saved.hasKey).toBe(true)
    expect(saved.keyHint).toBe('••••cret')
    expect(JSON.stringify(view)).not.toContain('sk-qwen-secret')
    const target = store.judgeTargets()[0]!
    expect(target.apiKey).toBe('sk-qwen-secret')
    expect(target.model).toBe('qwen-plus')
  })

  it('keeps a stored key on an empty string and clears it on null', async () => {
    const { store } = await setup()
    const created = await store.updateSettings({
      judgeProviders: [
        { baseUrl: 'https://api.example.com/v1', model: 'judge-a', apiKey: 'sk-first' },
      ],
    })
    const id = created.judgeProviders[0]!.id

    await store.updateSettings({
      judgeProviders: [{ id, baseUrl: 'https://api.example.com/v1', model: 'judge-b', apiKey: '' }],
    })
    expect(store.judgeTargets()[0]?.apiKey).toBe('sk-first')
    expect(store.judgeTargets()[0]?.model).toBe('judge-b')

    await store.updateSettings({
      judgeProviders: [{ id, baseUrl: 'https://api.example.com/v1', model: 'judge-b', apiKey: null }],
    })
    expect(store.judgeTargets()).toEqual([])
    expect(store.settingsView().judgeProviders[0]?.hasKey).toBe(false)
  })

  it('rejects an endpoint that is not http(s) and skips disabled providers', async () => {
    const { store } = await setup()
    await expect(
      store.updateSettings({
        judgeProviders: [{ baseUrl: 'file:///c:/secrets', model: 'judge-a', apiKey: 'sk-a' }],
      }),
    ).rejects.toThrow()

    await store.updateSettings({
      judgeProviders: [
        { baseUrl: 'https://api.example.com/v1', model: 'judge-a', apiKey: 'sk-a' },
        {
          baseUrl: 'https://other.example.com/v1',
          model: 'judge-b',
          apiKey: 'sk-b',
          enabled: false,
        },
      ],
    })
    expect(store.judgeTargets()).toHaveLength(1)
    expect(store.judgeTargets()[0]?.model).toBe('judge-a')
  })
})
