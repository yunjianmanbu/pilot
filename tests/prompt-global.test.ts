import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/main/agent/prompt'
import { summarizeLearning } from '../src/main/agent/learning'
import type { ProfileVersion } from '../src/shared/types'

function profile(version: number, addendum: string): ProfileVersion {
  return {
    id: `profile-${version}`,
    version,
    status: 'active',
    promptAddendum: addendum,
    strategy: {},
    rationale: 'test',
    source: 'promoted',
    scope: 'global',
    evidence: {
      runs: 4,
      failures: 0,
      avgSteps: 3,
      avgTokens: 100,
      positive: 1,
      negative: 0,
    },
    createdAt: new Date().toISOString(),
  }
}

describe('buildSystemPrompt global layers', () => {
  it('injects user-level instructions and the global profile before the workspace profile', () => {
    const prompt = buildSystemPrompt({
      root: 'E:\\work\\acme',
      topLevel: 'src',
      memory: [],
      profile: profile(2, 'Workspace rule: use pnpm in this repository.'),
      globalProfile: profile(1, 'Global rule: verify the narrowest check after edits.'),
      globalInstructions: [{ name: 'PILOT.md (global)', content: 'Answer in Chinese.' }],
      plan: null,
      selfUpdate: false,
    })

    const globalInstructionsAt = prompt.indexOf('Answer in Chinese.')
    const globalProfileAt = prompt.indexOf('Global rule: verify the narrowest check')
    const workspaceProfileAt = prompt.indexOf('Workspace rule: use pnpm')
    expect(globalInstructionsAt).toBeGreaterThan(0)
    expect(globalProfileAt).toBeGreaterThan(globalInstructionsAt)
    expect(workspaceProfileAt).toBeGreaterThan(globalProfileAt)
    expect(prompt).toContain('Global operating profile v1')
    expect(prompt).toContain('Workspace operating profile v2')
  })
})

describe('buildSystemPrompt turn boundary', () => {
  it('closes earlier turns so only the newest user message is worked on', () => {
    const text = buildSystemPrompt({
      root: 'E:\\work\\acme',
      topLevel: 'src',
      memory: [],
      profile: null,
      plan: null,
      selfUpdate: false,
    })
    expect(text).toContain('Only the newest user message is the task for this turn')
    expect(text).toContain('Earlier turns are closed')
    expect(text).toContain('never resume them, repeat their findings')
    expect(text).toContain('ask before continuing it')
    // A rule alone did not stop the drift: the model still followed older work
    // that dominated the prompt. Naming the request up front and re-checking it
    // per tool call is where the drift becomes visible.
    expect(text).toContain("Name this turn's request in one line at the start of the answer")
    expect(text).toContain('before each tool call check that the call serves it')
  })

  it('lets a continuation turn carry on the open task instead', () => {
    const text = buildSystemPrompt({
      root: 'E:\\work\\acme',
      topLevel: 'src',
      memory: [],
      profile: null,
      plan: null,
      selfUpdate: false,
      continuation: true,
    })
    // A resume or plan carry-on exists to finish the previous task, so sending
    // "never resume them" with it contradicted its own reason to run.
    expect(text).not.toContain('never resume them')
    expect(text).toContain('This turn is an explicit continuation')
    expect(text).toContain('Work that belongs to a different, finished task is still closed')
  })
})

describe('buildSystemPrompt memory age', () => {
  const base = {
    root: 'E:\\work\\acme',
    topLevel: 'src',
    profile: null,
    plan: null,
    selfUpdate: false,
  }

  it('marks old entries with their age so they are re-verified, not trusted', () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const text = buildSystemPrompt({
      ...base,
      memory: [
        {
          id: 'm1',
          content: '根目录没有 tsconfig.json',
          source: 'reflection',
          category: 'negative',
          createdAt: old,
        },
      ],
    })
    expect(text).toContain('[negative/reflection · 90 天前]')
    expect(text).toContain('Verify it against the workspace before acting on it')
  })

  it('leaves a fresh entry unmarked', () => {
    const text = buildSystemPrompt({
      ...base,
      memory: [
        {
          id: 'm2',
          content: '脚本入口在 pilot/scripts',
          source: 'agent',
          category: 'fact',
          createdAt: new Date().toISOString(),
        },
      ],
    })
    expect(text).toContain('[fact/agent] 脚本入口在 pilot/scripts')
  })
})

describe('buildSystemPrompt analysis gate', () => {
  const base = {
    root: 'E:\\work\\acme',
    topLevel: 'src',
    memory: [],
    profile: null,
    plan: null,
    selfUpdate: false,
  }

  it('sends the read-only analysis rules only on an analysis turn', () => {
    const analysis = buildSystemPrompt({ ...base, analysis: true })
    const change = buildSystemPrompt({ ...base, analysis: false })
    expect(analysis).toContain('Read-only analysis')
    expect(analysis).toContain('Do not edit files')
    expect(analysis).toContain('Target at most about 20 tool calls')
    // A change request used to receive "Do not edit files" as well, which is
    // how a one-line edit request came back as a code report.
    expect(change).not.toContain('Do not edit files')
    expect(change).not.toContain('Target at most about 20 tool calls')
    expect(change).toContain('Request type comes from the newest user message alone')
  })
})

describe('buildSystemPrompt thinking language', () => {
  const base = {
    root: 'E:\\work\\acme',
    topLevel: 'src',
    memory: [],
    profile: null,
    plan: null,
    selfUpdate: false,
  }

  it('pins the thinking language to the app language, not to the user language', () => {
    const chinese = buildSystemPrompt({ ...base, locale: 'zh-CN' })
    expect(chinese).toContain('Thinking is different')
    expect(chinese).toContain('written in Simplified Chinese, the language the app UI and system use')
    // The answer still follows whoever is writing; thinking is the part that
    // changes with the system language.
    expect(chinese).toContain('Answer in the language the user writes in')

    const english = buildSystemPrompt({ ...base, locale: 'en' })
    expect(english).toContain('written in English, the language the app UI and system use')
    expect(english).not.toContain('written in Simplified Chinese')
  })

  it('keeps identifiers untranslated inside a thinking block', () => {
    const text = buildSystemPrompt({ ...base, locale: 'en' })
    expect(text).toContain('Keep code, paths, commands, identifiers and quoted text exactly as written')
  })
})

describe('buildSystemPrompt learning mode', () => {
  const base = {
    root: 'E:\\work\\acme',
    topLevel: 'src',
    memory: [],
    profile: null,
    plan: null,
    selfUpdate: false,
  }

  it('tells the model it may only read allowlisted hosts and nothing may leave', () => {
    const summary = summarizeLearning([
      { at: '2026-01-01T00:00:00.000Z', kind: 'source', id: 's1', host: 'nodejs.org' },
      { at: '2026-01-01T00:01:00.000Z', kind: 'task', id: 't1', title: 'A' },
    ])
    const text = buildSystemPrompt({ ...base, learning: { hosts: ['nodejs.org'], summary } })
    expect(text).toContain('Autonomous learning mode is ON')
    expect(text).toContain('read-only GET/HEAD')
    expect(text).toContain('Nothing leaves the workspace')
    expect(text).toContain('never mark your own work approved')
    expect(text).toContain('sources 1, tasks 1')
    expect(text).toContain('Focus for this iteration')
    expect(text).not.toContain('Autonomous learning exploration is OFF')
  })

  it('keeps task-session networking out of the learning rules', () => {
    const summary = summarizeLearning([])
    const text = buildSystemPrompt({ ...base, learning: { hosts: ['nodejs.org'], summary } })
    expect(text).toContain('constrains learning_research only')
    expect(text).toContain('keeps normal networking')
    expect(text).toContain('as part of learning exploration')
    expect(text).not.toContain('shell sandbox has no network')
  })

  it('names the shell cut only when the user isolated it', () => {
    const summary = summarizeLearning([])
    const text = buildSystemPrompt({
      ...base,
      learning: { hosts: ['nodejs.org'], summary, shellNetwork: false },
    })
    expect(text).toContain('run_shell has no network')
  })

  it('says the mode is off without forbidding task networking', () => {
    const text = buildSystemPrompt(base)
    expect(text).toContain('Autonomous learning exploration is OFF')
    expect(text).toContain('This does not restrict networking')
    expect(text).not.toContain('Autonomous learning mode is ON')
  })
})

describe('buildSystemPrompt delegation', () => {
  function prompt(): string {
    return buildSystemPrompt({
      root: 'E:\\work\\acme',
      topLevel: 'src',
      memory: [],
      profile: null,
      plan: null,
      selfUpdate: false,
    })
  }

  it('delegates wide discovery and keeps known-file lookups local', () => {
    const text = prompt()
    expect(text).toContain('Use the explore tool when')
    expect(text).toContain('isolated context')
    expect(text).toContain('Do not delegate a lookup whose file you already know')
  })

  it('adds the analysis-specific discovery rule only on an analysis turn', () => {
    // These two lines are part of the read-only analysis block, which a change
    // request no longer receives; the general delegation rule above covers it.
    expect(prompt()).not.toContain('hand one narrow scope to explore')
    const analysis = buildSystemPrompt({
      root: 'E:\\work\\acme',
      topLevel: 'src',
      memory: [],
      profile: null,
      plan: null,
      selfUpdate: false,
      analysis: true,
    })
    expect(analysis).toContain('hand one narrow scope to explore')
    expect(analysis).toContain('once you know the module, read it directly')
  })

  it('treats a subagent summary as a lead and keeps unproven work in the parent', () => {
    const text = prompt()
    expect(text).toContain('Treat a subagent summary as a lead, not as verified truth')
    expect(text).toContain('may run whitelisted checks itself (run_check)')
    expect(text).toContain('still unproven until you run a check')
  })
})

describe('buildSystemPrompt completion contract', () => {
  function prompt(): string {
    return buildSystemPrompt({
      root: 'E:\\work\\acme',
      topLevel: 'src',
      memory: [],
      profile: null,
      plan: null,
      selfUpdate: false,
    })
  }

  it('separates questions from change requests and specifies the final shape', () => {
    const text = prompt()
    expect(text).toContain('Completion contract:')
    expect(text).toContain('A question needs a direct answer')
    expect(text).toContain('A change request needs the change, not a proposal')
    expect(text).toContain('Result (what changed and which files)')
    expect(text).toContain('Verification (the commands actually run and their outcome)')
    expect(text).toContain('How to use')
    expect(text).toContain('Unverified or risks')
    expect(text).toContain('No preamble, progress narration')
  })

  it('keeps safety rules as invariants instead of a long rule list', () => {
    const text = prompt()
    expect(text).toContain('Operating invariants')
    expect(text).not.toContain('Operating rules:')
    expect(text).toContain('Never try to work around a denial')
    expect(text).toContain('name the exact step, the boundary')
  })
})
