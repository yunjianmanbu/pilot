import { describe, expect, it, vi } from 'vitest'
import {
  createSelfUpdateBridge,
  type SelfUpdateStore,
} from '../src/main/agent/self-update-bridge'
import type { ProfileEvidence, ProfileVersion } from '../src/shared/types'

/** store 的五个方法都记账，用来断言 bridge 只用了它声明的那一面。 */
function fakeStore(
  options: {
    workspaces?: string[]
    runs?: Record<string, Array<{ steps: number; totalTokens: number }>>
    evidence?: Record<string, ProfileEvidence>
  } = {},
): SelfUpdateStore & { calls: string[]; drafts: Array<Record<string, unknown>> } {
  const calls: string[] = []
  const drafts: Array<Record<string, unknown>> = []
  const workspaces = options.workspaces ?? ['/w1']
  const evidenceOf = (path: string): ProfileEvidence =>
    options.evidence?.[path] ?? {
      runs: 0,
      failures: 0,
      avgSteps: 0,
      avgTokens: 0,
      positive: 0,
      negative: 0,
    }
  const profile = (version: number): ProfileVersion =>
    ({ id: `draft-${version}`, version, status: 'draft' }) as ProfileVersion
  return {
    calls,
    drafts,
    workspaces: () => {
      calls.push('workspaces')
      return workspaces.map((path) => ({ path }))
    },
    runs: (path) => {
      calls.push(`runs:${path}`)
      return options.runs?.[path] ?? []
    },
    evidence: (path) => {
      calls.push(`evidence:${path}`)
      return evidenceOf(path)
    },
    async createProfileDraft(path, input) {
      calls.push(`createProfileDraft:${path}`)
      drafts.push(input as unknown as Record<string, unknown>)
      return profile(3)
    },
    async createGlobalProfileDraft(input) {
      calls.push('createGlobalProfileDraft')
      drafts.push(input as unknown as Record<string, unknown>)
      return profile(7)
    },
  }
}

describe('createSelfUpdateBridge', () => {
  it('aggregates global evidence across workspaces and averages the recent runs', async () => {
    const store = fakeStore({
      workspaces: ['/w1', '/w2'],
      runs: {
        '/w1': [
          { steps: 10, totalTokens: 1000 },
          { steps: 20, totalTokens: 3000 },
        ],
        '/w2': [{ steps: 30, totalTokens: 2000 }],
      },
      evidence: {
        '/w1': { runs: 4, failures: 1, avgSteps: 5, avgTokens: 500, positive: 2, negative: 1 },
        '/w2': { runs: 6, failures: 2, avgSteps: 5, avgTokens: 500, positive: 3, negative: 0 },
      },
    })
    const changed = vi.fn()
    const bridge = createSelfUpdateBridge({
      store,
      workspacePath: '/w1',
      onProfileChanged: changed,
      explainDraft: async () => ({ explanation: { headline: 'ok' } as never }),
    })

    const result = await bridge({
      promptAddendum: 'Always verify before claiming done.',
      rationale: 'two failures in /w1',
      scope: 'global',
      maxSteps: 120,
      temperature: 0.3,
    })

    expect(result.version).toBe(7)
    expect(result.explanation).toEqual({ headline: 'ok' })
    expect(changed).toHaveBeenCalledTimes(1)
    const draft = store.drafts[0]!
    expect(draft.source).toBe('self')
    expect(draft.strategy).toEqual({ maxSteps: 120, temperature: 0.3 })
    expect(draft.evidence).toEqual({
      runs: 10,
      failures: 3,
      avgSteps: 20, // (10 + 20 + 30) / 3
      avgTokens: 2000, // (1000 + 3000 + 2000) / 3
      positive: 5,
      negative: 1,
    })
    expect(store.calls.filter((call) => call.startsWith('runs:'))).toEqual(['runs:/w1', 'runs:/w2'])
  })

  it('only looks at the most recent 30 runs per workspace for the averages', async () => {
    const runs = Array.from({ length: 40 }, (_, index) => ({
      steps: index === 39 ? 900 : 1,
      totalTokens: index === 39 ? 90_000 : 1,
    }))
    const store = fakeStore({ runs: { '/w1': runs } })
    const bridge = createSelfUpdateBridge({
      store,
      workspacePath: '/w1',
      onProfileChanged: () => undefined,
      explainDraft: async () => ({}),
    })

    await bridge({ promptAddendum: 'rule', rationale: 'why', scope: 'global' })

    const draft = store.drafts[0]!
    expect(draft.evidence).toMatchObject({ avgSteps: 1, avgTokens: 1 })
  })

  it('writes a workspace draft by default and forwards the stored evidence', async () => {
    const store = fakeStore({
      evidence: {
        '/w1': { runs: 9, failures: 2, avgSteps: 7, avgTokens: 800, positive: 4, negative: 1 },
      },
    })
    const scopes: string[] = []
    const bridge = createSelfUpdateBridge({
      store,
      workspacePath: '/w1',
      onProfileChanged: () => undefined,
      explainDraft: async (scope) => {
        scopes.push(scope)
        return {}
      },
    })

    const result = await bridge({ promptAddendum: 'rule', rationale: 'why' })

    expect(result).toEqual({ version: 3 })
    expect(scopes).toEqual(['workspace'])
    expect(store.drafts[0]).toEqual({
      promptAddendum: 'rule',
      rationale: 'why',
      source: 'self',
      strategy: {},
      evidence: {
        runs: 9,
        failures: 2,
        avgSteps: 7,
        avgTokens: 800,
        positive: 4,
        negative: 1,
      },
    })
    expect(store.calls).toContain('createProfileDraft:/w1')
    expect(store.calls).not.toContain('createGlobalProfileDraft')
  })
})
