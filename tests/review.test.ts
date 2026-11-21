import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/pilot-review-tests',
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

import type { ReviewReport, ReviewScope, Session } from '../src/shared/types'
import type { Store } from '../src/main/store'
import {
  buildFixPrompt,
  buildReviewReport,
  buildReviewSystemPrompt,
  executeReviewTool,
  GET_SESSION,
  isReviewToolName,
  redactReviewText,
  reviewToolsFor,
  type ReviewRuntime,
} from '../src/main/agent/review'
import {
  executePilotTool,
  WRITE_FILE,
  RUN_SHELL,
  READ_FILE,
  type ToolHost,
} from '../src/main/agent/tools'

const ROOT = process.platform === 'win32' ? 'C:\\projects\\app' : '/projects/app'
const OTHER_ROOT = process.platform === 'win32' ? 'C:\\projects\\docs' : '/projects/docs'

function scope(sessions: ReviewScope['sessions'] = 'workspace'): ReviewScope {
  return {
    roots: [
      { name: 'app', path: ROOT },
      { name: 'docs', path: OTHER_ROOT },
    ],
    sessions,
    objective: 'Check the release flow',
  }
}

function session(overrides: Partial<Session> = {}): Session {
  const review = overrides.review ?? null
  return {
    id: overrides.id ?? 'review-1',
    title: overrides.title ?? '复盘评估',
    workspacePath: overrides.workspacePath ?? ROOT,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    running: false,
    paused: false,
    canContinue: false,
    messageCount: 0,
    queueCount: 0,
    todoCount: 0,
    approvalMode: 'manual',
    plan: null,
    kind: review ? 'review' : 'coding',
    review,
    reviewReport: overrides.reviewReport ?? null,
    messages: overrides.messages ?? [],
    queue: [],
    todos: [],
    ...overrides,
    sessionModelId: overrides.sessionModelId ?? '',
  }
}

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    objective: 'Check the release flow',
    verdict: 'needs_work',
    summary: 'The release notes claim a check that never ran.',
    scores: { correctness: 62, evidence: 55, safety: 90, efficiency: 74 },
    findings: [
      {
        title: 'Release check skipped',
        severity: 'high',
        facts: ['The run stopped before the verification step.'],
        evidence: [{ kind: 'run', ref: 'run-1' }],
        recommendation: 'Run the verification step before publishing.',
        confidence: 0.9,
      },
    ],
    unknowns: [],
    memoryLessons: ['Verify the download manifest before publishing.'],
    createdAt: '2026-11-11T00:00:00.000Z',
    model: 'review-model',
    ...overrides,
  }
}

describe('review tool allowlist', () => {
  it('offers file reads and session evidence, never write or exec tools', () => {
    const tools = reviewToolsFor(scope())
    const names = tools.map((tool) => tool.name)

    expect(names).toContain(READ_FILE)
    expect(names).toContain(GET_SESSION)
    expect(names).toContain('record_review')
    expect(names).not.toContain(WRITE_FILE)
    expect(names).not.toContain(RUN_SHELL)
    expect(isReviewToolName(WRITE_FILE)).toBe(false)
    expect(isReviewToolName(RUN_SHELL)).toBe(false)
    expect(isReviewToolName(READ_FILE)).toBe(true)
  })

  it('exposes every root alias on file tools and makes the primary root the default', () => {
    const read = reviewToolsFor(scope()).find((tool) => tool.name === READ_FILE)
    const properties = read?.inputSchema['properties'] as Record<string, unknown>
    const root = properties['root'] as { enum: string[]; description: string }

    expect(root.enum).toEqual(['app', 'docs'])
    expect(root.description).toContain('app')
    expect(read?.description).toContain('defaults to "app"')
  })
})

describe('review redaction', () => {
  it('redacts credentials before evidence is shown to the reviewer model', () => {
    const text = redactReviewText(
      'key sk-abcdefghijklmnop token ghp_abcdefghijklmnop and -----BEGIN RSA PRIVATE KEY-----',
    )
    expect(text).not.toContain('sk-abcdefghijklmnop')
    expect(text).not.toContain('ghp_abcdefghijklmnop')
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(text.match(/<redacted>/g)).toHaveLength(3)
  })

  describe('execution guard', () => {
    const cleanups: string[] = []
    afterEach(async () => {
      while (cleanups.length) {
        const dir = cleanups.pop()
        if (dir) await rm(dir, { recursive: true, force: true })
      }
    })

    async function root(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'pilot-review-root-'))
      cleanups.push(dir)
      await writeFile(join(dir, 'notes.txt'), 'token sk-abcdefghijklmnop\n', 'utf8')
      return dir
    }

    function host(rootPath: string): ToolHost {
      return {
        root: rootPath,
        roots: [{ name: 'app', path: rootPath }],
      } as unknown as ToolHost
    }

    it('refuses write and exec tools when review roots are present', async () => {
      const rootPath = await root()
      const signal = new AbortController().signal
      await expect(
        executePilotTool(WRITE_FILE, { path: 'x.txt', content: 'x' }, host(rootPath), signal),
      ).rejects.toThrow(/read-only review session/i)
      await expect(executePilotTool(RUN_SHELL, { command: 'echo x' }, host(rootPath), signal)).rejects.toThrow(
        /read-only review session/i,
      )
    })

    it('rejects an unknown root alias instead of falling back', async () => {
      const rootPath = await root()
      await expect(
        executePilotTool(
          READ_FILE,
          { path: 'notes.txt', root: 'elsewhere' },
          host(rootPath),
          new AbortController().signal,
        ),
      ).rejects.toThrow(/Unknown root/i)
    })

    it('redacts secrets out of file reads before the reviewer sees them', async () => {
      const rootPath = await root()
      const result = await executeReviewTool(
        READ_FILE,
        { path: 'notes.txt', root: 'app' },
        host(rootPath),
        new AbortController().signal,
        {
          store: {} as Store,
          session: session({ review: scope(['inside']) }),
          scope: scope(['inside']),
          model: 'review-model',
          record: async () => ({ memoryCount: 0 }),
        },
      )
      expect(result.ok).toBe(true)
      expect(result.output).toContain('<redacted>')
      expect(result.output).not.toContain('sk-abcdefghijklmnop')
    })
  })
})

describe('buildReviewReport', () => {
  const runtime = { scope: scope(), model: 'review-model' }

  it('requires evidence for every finding', () => {
    expect(() =>
      buildReviewReport(runtime, {
        objective: 'Check the release flow',
        verdict: 'needs_work',
        summary: 'A problem exists.',
        scores: { correctness: 50, evidence: 50, safety: 50, efficiency: 50 },
        findings: [
          {
            title: 'Unsupported claim',
            severity: 'high',
            facts: ['The summary says it passed.'],
            evidence: [],
            recommendation: 'Re-run the check.',
            confidence: 0.8,
          },
        ],
      }),
    ).toThrow(/has no evidence/i)
  })

  it('rejects needs_work without findings and a profile addendum without rationale', () => {
    expect(() =>
      buildReviewReport(runtime, {
        verdict: 'needs_work',
        summary: 'Something is wrong.',
        scores: { correctness: 40, evidence: 40, safety: 40, efficiency: 40 },
        findings: [],
      }),
    ).toThrow(/requires at least one validated finding/i)

    expect(() =>
      buildReviewReport(runtime, {
        verdict: 'pass',
        summary: 'Looks fine.',
        scores: { correctness: 90, evidence: 90, safety: 90, efficiency: 90 },
        findings: [],
        profileAddendum: 'Always publish without checks.',
      }),
    ).toThrow(/profileRationale/i)
  })

  it('clamps scores, keeps the model stamp and falls back to the scope objective', () => {
    const result = buildReviewReport(runtime, {
      verdict: 'pass',
      summary: 'Looks fine.',
      scores: { correctness: 140, evidence: -5, safety: 88.6, efficiency: 70 },
      findings: [],
    })

    expect(result.objective).toBe('Check the release flow')
    expect(result.scores.correctness).toBe(100)
    expect(result.scores.evidence).toBe(0)
    expect(result.scores.safety).toBe(89)
    expect(result.model).toBe('review-model')
  })
})

describe('review session scope', () => {
  const inside = session({ id: 'inside', kind: 'review', review: scope(['inside']) })
  const outside = session({ id: 'outside', kind: 'coding', workspacePath: OTHER_ROOT })
  const store = {
    session: (id: string) => ({ inside, outside })[id] ?? null,
    sessions: () => [inside],
    runs: () => [],
    run: () => null,
    workspaces: () => [{ path: ROOT, name: 'app' }],
  } as unknown as Store
  const runtime: ReviewRuntime = {
    store,
    session: inside,
    scope: inside.review!,
    model: 'review-model',
    record: async () => ({ memoryCount: 0 }),
  }

  it('reads a session inside the explicit scope', async () => {
    const result = await executeReviewTool(
      GET_SESSION,
      { sessionId: 'inside' },
      {} as ToolHost,
      new AbortController().signal,
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('Session inside')
  })

  it('rejects a session outside the explicit scope', async () => {
    await expect(
      executeReviewTool(
        GET_SESSION,
        { sessionId: 'outside' },
        {} as ToolHost,
        new AbortController().signal,
        runtime,
      ),
    ).rejects.toThrow(/outside this review scope/i)
  })

  it('shows the plan each run ended with, not the settled session plan', async () => {
    // The session plan belongs to the newest turn and is settled on load
    // (in_progress becomes done/pending), so reviewing past work off it reported
    // a state the run never had.
    const live = session({
      id: 'inside',
      review: scope(),
      plan: {
        goal: 'live turn goal',
        items: [{ id: 'p1', text: 'still pending', status: 'pending' }],
        updatedAt: '2026-11-12T00:00:00.000Z',
      },
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'finished work',
          createdAt: '2026-11-11T01:00:00.000Z',
          runId: 'run-a',
          plan: {
            goal: 'goal of the reviewed run',
            items: [{ id: 'p2', text: 'wrote the release notes', status: 'done' }],
            updatedAt: '2026-11-11T02:00:00.000Z',
          },
        },
      ],
    })
    const store = {
      session: (id: string) => (id === 'inside' ? live : null),
      sessions: () => [live],
      runs: () => [{ id: 'run-a', sessionId: 'inside', status: 'completed' }],
      run: () => null,
      workspaces: () => [{ path: ROOT, name: 'app' }],
    } as unknown as Store
    const output = await executeReviewTool(
      GET_SESSION,
      { sessionId: 'inside' },
      {} as ToolHost,
      new AbortController().signal,
      {
        store,
        session: live,
        scope: live.review!,
        model: 'review-model',
        record: async () => ({ memoryCount: 0 }),
      },
    )
    expect(output.output).toContain('Plan recorded by run run-a')
    expect(output.output).toContain('[done] wrote the release notes')
    expect(output.output).not.toContain('live turn goal')
  })
})

describe('buildReviewSystemPrompt thinking language', () => {
  const input = {
    scope: scope('workspace'),
    primaryRoot: ROOT,
    topLevel: 'src',
    plan: null,
  }

  it('follows the app language instead of the language of the work', () => {
    expect(buildReviewSystemPrompt({ ...input, locale: 'en' })).toContain(
      'write every reasoning/thinking block in English',
    )
    expect(buildReviewSystemPrompt({ ...input, locale: 'zh-CN' })).toContain(
      'write every reasoning/thinking block in Simplified Chinese',
    )
    // The read-only boundary must survive the extra line.
    expect(buildReviewSystemPrompt({ ...input, locale: 'en' })).toContain('READ-ONLY BOUNDARY:')
  })
})

describe('buildFixPrompt', () => {
  it('turns the report into a verification-first handoff and names unwritable roots', () => {
    const review = session({
      id: 'review-1',
      workspacePath: ROOT,
      review: scope('workspace'),
      reviewReport: report({
        findings: [
          {
            title: 'Low-risk wording',
            severity: 'low',
            facts: [],
            evidence: [{ kind: 'file', ref: 'app:README.md:4' }],
            recommendation: 'Clarify the wording.',
            confidence: 0.5,
          },
          {
            title: 'Skipped check',
            severity: 'high',
            facts: [],
            evidence: [{ kind: 'run', ref: 'run-1' }],
            recommendation: 'Run the check before publishing.',
            confidence: 0.9,
          },
        ],
      }),
    })

    const prompt = buildFixPrompt(review)
    expect(prompt.indexOf('Skipped check')).toBeLessThan(prompt.indexOf('Low-risk wording'))
    expect(prompt).toContain('用读取工具核实')
    expect(prompt).toContain('docs')
    expect(prompt).toContain('无法在本会话安全修改')
    expect(prompt).toContain('run-1')
  })
})
