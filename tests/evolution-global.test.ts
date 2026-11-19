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

function fakeClient(responses: string[]): ModelClient & { calls: number } {
  let index = 0
  const client = {
    calls: 0,
    async complete(): Promise<ModelResponse> {
      client.calls += 1
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
  const root = await mkdtemp(join(tmpdir(), 'pilot-evolution-global-'))
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

async function addWorkspaceProfile(
  store: Store,
  workspacePath: string,
): Promise<string> {
  const profile = await store.createProfileDraft(workspacePath, {
    promptAddendum: 'Run pnpm test before committing in the acme-web repository.',
    rationale: 'The acme-web repository uses pnpm and has failed commits without tests.',
    source: 'user',
  })
  return profile.id
}

describe('global evolution profiles', () => {
  it('stores, activates, rolls back and deletes global profiles', async () => {
    const { store, workspacePath } = await setup()
    const first = await store.createGlobalProfileDraft({
      promptAddendum: 'Run the narrowest relevant check after every code change.',
      rationale: 'Cross-project evidence shows verification prevents regressions.',
      source: 'promoted',
    })
    expect(first.scope).toBe('global')
    expect(first.status).toBe('draft')

    const detail = store.workspaceDetail(workspacePath)
    expect(detail.globalProfiles).toHaveLength(1)
    expect(detail.activeGlobalProfile).toBeNull()

    await store.setGlobalProfileReview(first.id, {
      score: 82,
      pass: true,
      notes: 'Grounded and safe.',
      risks: [],
      at: new Date().toISOString(),
      model: 'reviewer',
    })
    const activated = await store.activateGlobalProfile(first.id)
    expect(activated.status).toBe('active')
    expect(store.activeGlobalProfile()?.id).toBe(first.id)

    const second = await store.createGlobalProfileDraft({
      promptAddendum: 'Prefer a targeted test over the whole suite when only one module changed.',
      rationale: 'Faster feedback across workspaces.',
      source: 'promoted',
    })
    await store.activateGlobalProfile(second.id)
    expect(store.globalProfile(first.id)?.status).toBe('retired')
    expect(store.activeGlobalProfile()?.id).toBe(second.id)

    const rolledBack = await store.rollbackGlobalProfile()
    expect(rolledBack?.id).toBe(first.id)
    expect(store.activeGlobalProfile()?.id).toBe(first.id)

    await store.deleteGlobalProfile(second.id)
    expect(store.globalProfile(second.id)).toBeUndefined()
    await expect(store.deleteGlobalProfile(first.id)).rejects.toThrow()
  })

  it('persists global profiles and returns them in workspace detail after reload', async () => {
    const { store, workspacePath } = await setup()
    const profile = await store.createGlobalProfileDraft({
      promptAddendum: 'Ask before running a destructive command in any workspace.',
      rationale: 'Cross-workspace safety evidence.',
      source: 'promoted',
    })
    await store.activateGlobalProfile(profile.id)

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.activeGlobalProfile()?.promptAddendum).toContain('destructive')
    const detail = reloaded.workspaceDetail(workspacePath)
    expect(detail.activeGlobalProfile?.id).toBe(profile.id)
    expect(detail.globalProfiles.map((entry) => entry.id)).toContain(profile.id)
  })
})

describe('promotion and independent global review', () => {
  it('generalizes a workspace profile into a global candidate', async () => {
    const { store, workspacePath } = await setup()
    const profileId = await addWorkspaceProfile(store, workspacePath)
    const model = fakeClient([
      JSON.stringify({
        promptAddendum:
          "Run the project's own test command before committing. If none is documented, ask.",
        rationale: 'Generalized from repeated verification evidence across workspaces.',
        maxSteps: 120,
      }),
    ])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'test-model',
    )

    const draft = await service.promote(workspacePath, profileId)
    expect(draft.scope).toBe('global')
    expect(draft.source).toBe('promoted')
    expect(draft.status).toBe('draft')
    expect(draft.promptAddendum).toContain("project's own test command")
    expect(draft.strategy.maxSteps).toBe(120)
    expect(draft.evidence.runs).toBeGreaterThanOrEqual(4)
    expect(store.activeGlobalProfile()).toBeNull()
    expect(model.calls).toBe(1)
  })

  it('requires every global rule deletion to carry a reviewer reason', async () => {
    const { store } = await setup()
    const baseline = await store.createGlobalProfileDraft({
      promptAddendum: "Prefer the repository's existing helper functions.",
      rationale: 'Baseline rule.',
      source: 'promoted',
    })
    await store.activateGlobalProfile(baseline.id)
    const candidate = await store.createGlobalProfileDraft({
      promptAddendum: 'Use descriptive variable names.',
      rationale: 'A proposed rewrite.',
      source: 'promoted',
    })
    const model = fakeClient([
      JSON.stringify({ score: 90, pass: true, notes: 'Clean rewrite.', risks: [] }),
    ])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'reviewer-model',
      () => [],
      async () => ({
        verdict: 'better',
        tasks: 3,
        wins: 3,
        losses: 0,
        ties: 0,
        current: { successRate: 0.6, avgSteps: 8, avgTokens: 1_200 },
        candidate: { successRate: 1, avgSteps: 5, avgTokens: 900 },
        reasons: ['候选版本全部完成。'],
        at: new Date().toISOString(),
        candidateId: candidate.id,
        currentId: baseline.id,
      }),
    )

    const result = await service.reviewGlobal(candidate.id)

    expect(result.profile.review?.pass).toBe(false)
    expect(result.profile.review?.removals?.[0]?.justified).toBe(false)
    expect(result.profile.review?.activation?.ready).toBe(false)
    expect(result.profile.review?.activation?.reasons).toContain('删除旧规则缺少评审理由')
    expect(store.activeGlobalProfile()?.id).toBe(baseline.id)
  })

  it('never lets a reviewed reason remove a safety or approval rule', async () => {
    const { store } = await setup()
    const baseline = await store.createGlobalProfileDraft({
      promptAddendum: 'Always require explicit approval before destructive commands.',
      rationale: 'Baseline safety rule.',
      source: 'promoted',
    })
    await store.activateGlobalProfile(baseline.id)
    const candidate = await store.createGlobalProfileDraft({
      promptAddendum: 'Prefer the smallest change that fixes the failing test.',
      rationale: 'A proposed rewrite.',
      source: 'promoted',
    })
    const model = fakeClient([
      JSON.stringify({
        score: 95,
        pass: true,
        notes: 'The tool layer enforces approval already.',
        risks: [],
        removals: [
          {
            rule: 'Always require explicit approval before destructive commands.',
            justified: true,
            reason: 'The tool layer already enforces approval.',
          },
        ],
      }),
    ])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'reviewer-model',
      () => [],
      async () => ({
        verdict: 'better',
        tasks: 3,
        wins: 3,
        losses: 0,
        ties: 0,
        current: { successRate: 0.6, avgSteps: 8, avgTokens: 1_200 },
        candidate: { successRate: 1, avgSteps: 5, avgTokens: 900 },
        reasons: ['候选版本全部完成。'],
        at: new Date().toISOString(),
        candidateId: candidate.id,
        currentId: baseline.id,
      }),
    )

    const result = await service.reviewGlobal(candidate.id)

    expect(result.profile.review?.pass).toBe(false)
    expect(result.profile.review?.activation?.ready).toBe(false)
    expect(
      result.profile.review?.risks.some((risk) => risk.includes('不能删除安全')),
    ).toBe(true)
    expect(store.activeGlobalProfile()?.id).toBe(baseline.id)
  })

  it('records a passing global review without activating the profile', async () => {
    const { store } = await setup()
    const draft = await store.createGlobalProfileDraft({
      promptAddendum: 'Read the actual error before retrying a failed tool call.',
      rationale: 'Cross-workspace evidence.',
      source: 'promoted',
    })
    const model = fakeClient([
      JSON.stringify({ score: 88, pass: true, notes: 'Concrete and safe.', risks: [] }),
    ])
    const service = new EvolutionService(
      store,
      () => model,
      () => 'reviewer-model',
    )

    const result = await service.reviewGlobal(draft.id)
    expect(result.activated).toBe(false)
    expect(result.profile.status).toBe('draft')
    expect(result.profile.review?.pass).toBe(true)
    expect(store.activeGlobalProfile()).toBeNull()

    const activated = await store.activateGlobalProfile(draft.id)
    expect(activated.status).toBe('active')
    // This review runs the real built-in suite (twice per task, one node process
    // per check), so its cost grows with the suite and cannot use the 5s default.
  }, 60_000)
})
