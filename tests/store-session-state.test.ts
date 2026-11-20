import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { normalizeApprovalMode, Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<{ store: Store; sessionId: string; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-store-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  const session = await store.createSession(workspace.path)
  return { store, sessionId: session.id, workspacePath: workspace.path }
}

describe('Store session continuation state', () => {
  it('persists pause metadata and exposes it in the summary', async () => {
    const { store, sessionId } = await setup()
    await store.setPaused(sessionId, '重构登录流程')
    const paused = store.session(sessionId)
    expect(paused?.paused).toBe(true)
    expect(paused?.pauseInstruction).toBe('重构登录流程')
    expect(paused?.canContinue).toBe(true)
    expect(store.sessions(paused!.workspacePath)[0]?.canContinue).toBe(true)

    store.setRunning(sessionId, true)
    expect(store.session(sessionId)?.canContinue).toBe(false)

    store.setRunning(sessionId, false)
    await store.setPaused(sessionId, null)
    expect(store.session(sessionId)?.paused).toBe(false)
    expect(store.session(sessionId)?.canContinue).toBe(false)
  })

  it('shows the live instruction and start time while running', async () => {
    const { store, sessionId } = await setup()
    store.setRunInfo(sessionId, {
      runId: 'run-1',
      instruction: '实现导出功能',
      startedAt: '2026-01-01T00:00:00.000Z',
    })
    const summary = store.sessions(store.session(sessionId)!.workspacePath)[0]
    expect(summary?.runInstruction).toBe('实现导出功能')
    expect(summary?.runStartedAt).toBe('2026-01-01T00:00:00.000Z')
    store.setRunInfo(sessionId, null)
    expect(store.sessions(store.session(sessionId)!.workspacePath)[0]?.runInstruction).toBeUndefined()
  })

  it('persists the compaction summary across a reload', async () => {
    // Without this the summary died with the run: the next turn paid for the
    // same summarizer call over a transcript whose detail was already folded.
    const { store, sessionId } = await setup()
    expect(store.contextSummary(sessionId)).toBeNull()
    await store.setContextSummary(sessionId, '  Goal: 修复登录\nFacts: a.ts:12  ')
    expect(store.contextSummary(sessionId)).toBe('Goal: 修复登录\nFacts: a.ts:12')
    expect(store.session(sessionId)?.summary).toBe('Goal: 修复登录\nFacts: a.ts:12')
    // The summary stays out of SessionSummary: that view goes to the renderer
    // and the compact form is model-facing only. It rides in the index entry
    // instead, which is why the reload below can still answer for it.
    const listed = store.sessions(store.session(sessionId)!.workspacePath)[0]
    expect(listed).toBeDefined()
    await store.flush()

    const reopened = new Store()
    await reopened.load()
    expect(reopened.contextSummary(sessionId)).toBe('Goal: 修复登录\nFacts: a.ts:12')

    await reopened.setContextSummary(sessionId, null)
    expect(reopened.contextSummary(sessionId)).toBeNull()
    await reopened.flush()
    const again = new Store()
    await again.load()
    expect(again.contextSummary(sessionId)).toBeNull()
  })
})

describe('Store todos', () => {
  it('adds, dedupes, edits, sends and clears todos', async () => {
    const { store, sessionId } = await setup()
    const first = await store.addTodo(sessionId, '  写  测试  ', 'phone', 'client-1')
    const duplicate = await store.addTodo(sessionId, '写测试', 'phone', 'client-1')
    expect(duplicate.id).toBe(first.id)
    expect(store.todos(sessionId)).toHaveLength(1)
    expect(store.todos(sessionId)[0]?.text).toBe('写 测试')
    expect(store.session(sessionId)?.todoCount).toBe(1)

    await store.updateTodo(sessionId, first.id, '补上回归测试')
    expect(store.todo(sessionId, first.id)?.text).toBe('补上回归测试')

    await store.markTodoSent(sessionId, first.id, 'run-9')
    expect(store.todo(sessionId, first.id)?.status).toBe('sent')
    expect(store.todo(sessionId, first.id)?.sentRunId).toBe('run-9')
    expect(store.session(sessionId)?.todoCount).toBe(0)
    await expect(store.updateTodo(sessionId, first.id, '再改')).rejects.toThrow()

    await store.clearSentTodos(sessionId)
    expect(store.todos(sessionId)).toHaveLength(0)
  })

  it('rejects blank todo text', async () => {
    const { store, sessionId } = await setup()
    await expect(store.addTodo(sessionId, '   ')).rejects.toThrow()
  })
})

describe('Store run limits', () => {
  it('starts with Claude-sized step and context defaults', async () => {
    const { store } = await setup()
    const settings = store.settings()
    expect(settings.maxSteps).toBe(200)
    expect(settings.maxContextTokens).toBe(1_000_000)
  })

  it('accepts a four-figure step cap and clamps the upper bound', async () => {
    const { store } = await setup()
    const raised = await store.updateSettings({ maxSteps: 800 })
    expect(raised.maxSteps).toBe(800)
    const clamped = await store.updateSettings({ maxSteps: 5_000 })
    expect(clamped.maxSteps).toBe(1_000)
  })

  it('enables auto-continue by default and preserves an explicit opt-out', async () => {
    const { store } = await setup()
    expect(store.settings().autoContinue).toBe(true)
    expect(store.settings().autoContinueLimit).toBe(3)

    await store.updateSettings({ autoContinue: false })
    const reopened = new Store()
    await reopened.load()
    expect(reopened.settings().autoContinue).toBe(false)
  })

  it('enables screenshot vision feedback by default and preserves an opt-out', async () => {
    const { store } = await setup()
    expect(store.settings().screenshotFeedback).toBe(true)
    const updated = await store.updateSettings({ screenshotFeedback: false })
    expect(updated.screenshotFeedback).toBe(false)
    const reopened = new Store()
    await reopened.load()
    expect(reopened.settings().screenshotFeedback).toBe(false)
  })

  it('starts with auto approval and Shell mode enabled', async () => {
    const { store, sessionId } = await setup()
    const settings = store.settings()
    expect(settings.defaultApprovalMode).toBe('auto')
    expect(settings.shellMode).toBe(true)
    expect(settings.shellInterpreter).toBe('auto')
    expect(store.settingsView().shellInterpreterDetail).toBeTruthy()
    expect(store.session(sessionId)?.approvalMode).toBe('auto')
  })

  it('canonicalizes legacy execution modes onto the three supported modes', () => {
    expect(normalizeApprovalMode('auto')).toBe('auto')
    expect(normalizeApprovalMode('manual')).toBe('manual')
    expect(normalizeApprovalMode('ask')).toBe('ask')
    // acceptEdits pre-approved writes, so it becomes full auto.
    expect(normalizeApprovalMode('acceptEdits')).toBe('auto')
    // plan/dontAsk never prompted for mutation, so they become read-only auto.
    expect(normalizeApprovalMode('plan')).toBe('manual')
    expect(normalizeApprovalMode('dontAsk')).toBe('manual')
    expect(normalizeApprovalMode('bogus')).toBe('auto')
  })

  it('accepts the three execution modes in settings updates', async () => {
    const { store } = await setup()
    for (const mode of ['manual', 'ask', 'auto'] as const) {
      const updated = await store.updateSettings({ defaultApprovalMode: mode })
      expect(updated.defaultApprovalMode).toBe(mode)
    }
    const legacy = await store.updateSettings({ defaultApprovalMode: 'plan' })
    expect(legacy.defaultApprovalMode).toBe('manual')
  })

  it('migrates the old Shell-off default once and preserves a later opt-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-store-'))
    cleanups.push(root)
    userDataDir = join(root, 'user-data')
    await mkdir(userDataDir, { recursive: true })
    await writeFile(
      join(userDataDir, 'pilot-state.json'),
      JSON.stringify({
        version: 1,
        settings: { shellMode: false, defaultApprovalMode: 'auto' },
        workspaces: [],
        sessions: [],
        scheduled: [],
        activeWorkspace: null,
        activeSession: null,
      }),
      'utf8',
    )

    const migrated = new Store()
    await migrated.load()
    expect(migrated.settings().shellMode).toBe(true)
    expect(migrated.settings().shellInterpreter).toBe('auto')
    expect(migrated.settings().defaultApprovalMode).toBe('auto')

    await migrated.updateSettings({ shellMode: false, shellInterpreter: 'bash' })
    const reopened = new Store()
    await reopened.load()
    expect(reopened.settings().shellMode).toBe(false)
  })
})

describe('Store delivered-run evidence', () => {
  it('counts only runs that changed files and ran a check', async () => {
    const { store, workspacePath, sessionId } = await setup()
    const make = async (
      id: string,
      patch: { filesChanged?: number; checked?: boolean; status?: 'completed' | 'failed' } = {},
    ) => {
      await store.startRun(workspacePath, {
        id,
        sessionId,
        prompt: `task ${id}`,
        status: 'running',
        startedAt: new Date().toISOString(),
        steps: 3,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        toolCalls: 2,
        toolErrors: 0,
      })
      await store.finishRun(workspacePath, id, {
        status: patch.status ?? 'completed',
        filesChanged: patch.filesChanged,
        checked: patch.checked,
      })
    }

    await make('verified', { filesChanged: 2, checked: true })
    await make('unchecked', { filesChanged: 1, checked: false })
    await make('check-only', { checked: true })
    await make('no-meta')

    const evidence = store.evidence(workspacePath)
    expect(evidence.runs).toBe(4)
    expect(evidence.verified).toBe(1)
  })
})

describe('Store plan snapshots', () => {
  it('keeps the per-turn plan attached to the final answer across reloads', async () => {
    const { store, sessionId } = await setup()
    const plan = {
      goal: '修复登录',
      updatedAt: '2026-01-01T00:00:00.000Z',
      items: [
        { id: 'plan-1', text: '定位问题', status: 'done' as const },
        { id: 'plan-2', text: '补充测试', status: 'pending' as const },
      ],
    }
    await store.addMessages(sessionId, [
      {
        id: 'message-plan',
        role: 'assistant',
        content: '已完成。',
        createdAt: '2026-01-01T00:00:00.000Z',
        runId: 'run-1',
        plan,
      },
    ])

    const reopened = new Store()
    await reopened.load()
    const message = reopened
      .session(sessionId)
      ?.messages.find((entry) => entry.id === 'message-plan')
    expect(message?.plan?.goal).toBe('修复登录')
    expect(message?.plan?.items.map((item) => item.status)).toEqual(['done', 'pending'])
  })

  it('drops malformed plan snapshots instead of breaking the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-store-'))
    cleanups.push(root)
    userDataDir = join(root, 'user-data')
    await mkdir(userDataDir, { recursive: true })
    await writeFile(
      join(userDataDir, 'pilot-state.json'),
      JSON.stringify({
        version: 1,
        settings: { shellMode: true, defaultApprovalMode: 'auto' },
        workspaces: [{ path: join(root, 'ws'), name: 'ws', sessions: [] }],
        sessions: [
          {
            id: 'session-1',
            title: '测试',
            workspacePath: join(root, 'ws'),
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [
              {
                id: 'm-1',
                role: 'assistant',
                content: '完成',
                createdAt: '2026-01-01T00:00:00.000Z',
                plan: { items: [] },
              },
            ],
          },
        ],
        scheduled: [],
        activeWorkspace: null,
        activeSession: null,
      }),
      'utf8',
    )

    const reopened = new Store()
    await reopened.load()
    const message = reopened.session('session-1')?.messages[0]
    expect(message?.content).toBe('完成')
    expect(message?.plan).toBeUndefined()
  })
})

describe('Store forkSession', () => {
  it('copies history with fresh ids but drops queue, todos and pause state', async () => {
    const { store, sessionId } = await setup()
    await store.addMessage(sessionId, {
      id: 'message-1',
      role: 'user',
      content: '实现搜索',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await store.setQueue(sessionId, [
      { id: 'queued-1', content: '接着做', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    await store.addTodo(sessionId, '补充测试')
    await store.setPaused(sessionId, '实现搜索')

    const source = store.session(sessionId)!
    const fork = await store.forkSession(sessionId)
    expect(fork.id).not.toBe(source.id)
    expect(fork.title).toContain('副本')
    expect(fork.messages).toHaveLength(1)
    expect(fork.messages[0]?.content).toBe('实现搜索')
    expect(fork.messages[0]?.id).not.toBe('message-1')
    expect(fork.queue).toEqual([])
    expect(fork.todos).toEqual([])
    expect(fork.paused).toBe(false)
    expect(fork.canContinue).toBe(false)
    expect(fork.pauseInstruction).toBeUndefined()
  })
})
