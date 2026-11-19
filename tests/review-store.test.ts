import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

import type { ReviewReport } from '../src/shared/types'
import { Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<{ store: Store; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-review-store-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  return { store, workspacePath: workspace.path }
}

function report(): ReviewReport {
  return {
    objective: 'Check the release flow',
    verdict: 'needs_work',
    summary: 'The manifest check was skipped.',
    scores: { correctness: 60, evidence: 70, safety: 90, efficiency: 80 },
    findings: [
      {
        title: 'Skipped manifest check',
        severity: 'high',
        facts: ['The run ended before verification.'],
        evidence: [{ kind: 'run', ref: 'run-1' }],
        recommendation: 'Run the manifest check before publishing.',
        confidence: 0.9,
      },
    ],
    unknowns: [],
    memoryLessons: ['Verify the manifest before publishing.'],
    createdAt: '2026-11-11T00:00:00.000Z',
    model: 'review-model',
  }
}

describe('Store review sessions', () => {
  it('creates a read-only review session and persists its scope', async () => {
    const { store, workspacePath } = await setup()
    const session = await store.createSession(workspacePath, {
      kind: 'review',
      title: '复盘：发布流程',
      review: {
        roots: [{ name: 'app', path: workspacePath }],
        sessions: 'workspace',
        objective: 'Check the release flow',
      },
    })

    expect(session.kind).toBe('review')
    expect(session.approvalMode).toBe('manual')
    expect(session.reviewReport).toBeNull()
    expect(session.review).toMatchObject({
      sessions: 'workspace',
      objective: 'Check the release flow',
      roots: [{ name: 'app', path: workspacePath }],
    })
    expect(store.sessions(workspacePath)[0]).toMatchObject({
      kind: 'review',
      review: session.review,
      reviewReport: null,
    })
  })

  it('requires at least one absolute root', async () => {
    const { store, workspacePath } = await setup()
    await expect(
      store.createSession(workspacePath, { kind: 'review', review: { roots: [], sessions: 'workspace' } }),
    ).rejects.toThrow(/at least one allowed root/i)
    await expect(
      store.createSession(workspacePath, {
        kind: 'review',
        review: { roots: [{ name: 'bad', path: 'relative/path' }], sessions: 'workspace' },
      }),
    ).rejects.toThrow(/at least one allowed root/i)
  })

  it('stores the report only on review sessions and reloads it', async () => {
    const { store, workspacePath } = await setup()
    const review = await store.createSession(workspacePath, {
      kind: 'review',
      review: { roots: [{ name: 'app', path: workspacePath }], sessions: 'workspace' },
    })
    const coding = await store.createSession(workspacePath)

    await expect(store.setReviewReport(coding.id, report())).rejects.toThrow(/only review sessions/i)
    await store.setReviewReport(review.id, report())

    const saved = store.session(review.id)?.reviewReport
    expect(saved?.verdict).toBe('needs_work')
    expect(saved?.findings[0]?.evidence).toEqual([{ kind: 'run', ref: 'run-1' }])

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.session(review.id)?.reviewReport?.summary).toBe('The manifest check was skipped.')
    expect(reloaded.session(review.id)?.kind).toBe('review')
    expect(reloaded.session(coding.id)?.reviewReport).toBeNull()
  })
})

describe('Store profile review persistence', () => {
  it('keeps judge verdicts, independence and the measured comparison across a reload', async () => {
    const { store, workspacePath } = await setup()
    const draft = await store.createProfileDraft(workspacePath, {
      promptAddendum: '先跑测试再改代码。',
      rationale: '两次运行都跳过了验证。',
      source: 'self',
    })
    await store.setProfileReview(workspacePath, draft.id, {
      score: 88,
      pass: true,
      notes: '候选 2 胜 / 0 负 / 1 平',
      risks: [],
      at: '2026-11-14T00:00:00.000Z',
      model: 'qwen/qwen-plus',
      independent: true,
      judges: [
        {
          id: 'qwen',
          label: 'qwen',
          model: 'qwen-plus',
          external: true,
          score: 88,
          pass: true,
          notes: '规则没有引入额外工具调用。',
          risks: [],
        },
      ],
      comparison: {
        verdict: 'better',
        tasks: 3,
        wins: 2,
        losses: 0,
        ties: 1,
        current: { successRate: 0.67, avgSteps: 7, avgTokens: 1_240 },
        candidate: { successRate: 1, avgSteps: 5, avgTokens: 930, avgJudgeScore: 88 },
        reasons: ['通过率 67% → 100%'],
        at: '2026-11-14T00:00:00.000Z',
        judges: ['qwen/qwen-plus'],
        judgeErrors: ['glm/glm-4-plus: 超过 120 秒未响应'],
      },
    })

    const reloaded = new Store()
    await reloaded.load()
    const review = reloaded.workspaceDetail(workspacePath).profiles[0]?.review
    expect(review?.independent).toBe(true)
    expect(review?.judges?.[0]?.external).toBe(true)
    expect(review?.comparison?.verdict).toBe('better')
    expect(review?.comparison?.candidate.avgJudgeScore).toBe(88)
    expect(review?.comparison?.judgeErrors).toEqual(['glm/glm-4-plus: 超过 120 秒未响应'])
  })

  it('drops a stored comparison whose verdict was tampered with', async () => {
    const { store, workspacePath } = await setup()
    const draft = await store.createProfileDraft(workspacePath, {
      promptAddendum: '改完代码后跑一次测试。',
      rationale: '需要验证。',
      source: 'self',
    })
    await store.setProfileReview(workspacePath, draft.id, {
      score: 90,
      pass: true,
      notes: 'ok',
      risks: [],
      at: '2026-11-14T00:00:00.000Z',
      model: 'qwen/qwen-plus',
      comparison: {
        verdict: 'better',
        tasks: 3,
        wins: 3,
        losses: 0,
        ties: 0,
        current: { successRate: 0, avgSteps: 9, avgTokens: 100 },
        candidate: { successRate: 1, avgSteps: 4, avgTokens: 90 },
        reasons: [],
        at: '2026-11-14T00:00:00.000Z',
      },
    })

    // Simulate a hand-edited store file that claims an unknown verdict.
    const file = join(userDataDir, 'pilot-core.json')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    raw.workspaces[0].profiles[0].review.comparison.verdict = 'fabulous'
    await writeFile(file, JSON.stringify(raw), 'utf8')

    const reloaded = new Store()
    await reloaded.load()
    const review = reloaded.workspaceDetail(workspacePath).profiles[0]?.review
    expect(review?.score).toBe(90)
    expect(review?.comparison).toBeUndefined()
  })
})
