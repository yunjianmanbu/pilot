import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
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
import {
  CORE_FILE,
  DERIVED_DIR,
  LEGACY_FILE,
  SEARCH_INDEX_FILE,
  SESSIONS_DIR,
  SESSION_INDEX_FILE,
  SessionStorage,
  messagesFileName,
  shardFileName,
} from '../src/main/session-store'

const cleanups: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

interface Fixture {
  store: Store
  root: string
  dir: string
  workspacePath: string
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-shards-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  return { store, root, dir: userDataDir, workspacePath: workspace.path }
}

function message(id: string, content: string) {
  return {
    id,
    role: 'user' as const,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

describe('sharded session persistence', () => {
  it('writes a core file, a summary index and one shard per session', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessage(session.id, message('message-1', '重构登录流程'))
    await store.flush()

    expect(await names(dir)).toEqual([CORE_FILE, DERIVED_DIR, SESSIONS_DIR].sort())
    expect(await names(join(dir, SESSIONS_DIR))).toEqual(
      [SESSION_INDEX_FILE, shardFileName(session.id), messagesFileName(session.id)].sort(),
    )
    // The transcript lives in the append-only file, not the metadata shard.
    const shard = JSON.parse(await readFile(join(dir, SESSIONS_DIR, shardFileName(session.id)), 'utf8'))
    expect(shard.messages).toBeUndefined()
    const lines = (await readFile(join(dir, SESSIONS_DIR, messagesFileName(session.id)), 'utf8'))
      .trim()
      .split('\n')
    expect(lines).toHaveLength(1)

    const index = JSON.parse(await readFile(join(dir, SESSIONS_DIR, SESSION_INDEX_FILE), 'utf8'))
    expect(index.sessions).toHaveLength(1)
    expect(index.sessions[0].id).toBe(session.id)
    expect(index.sessions[0].messageCount).toBe(1)
    // The index is summaries only: no transcript in the startup read.
    expect(index.sessions[0].messages).toBeUndefined()

    const core = JSON.parse(await readFile(join(dir, CORE_FILE), 'utf8'))
    expect(core.sessions).toBeUndefined()
    expect(core.activeWorkspace).toBe(workspacePath)
  })

  it('lists summaries without reading transcripts off disk', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessage(session.id, message('message-1', '第一条'))
    await store.addMessages(session.id, [message('message-2', '第二条')])
    await store.flush()

    // A shard that cannot be parsed stands in for "never opened".
    await writeFile(join(dir, SESSIONS_DIR, shardFileName(session.id)), '{not json', 'utf8')

    const reopened = new Store()
    await reopened.load()
    const summary = reopened.sessions(workspacePath)[0]
    expect(summary?.id).toBe(session.id)
    expect(summary?.messageCount).toBe(2)
    expect(reopened.session(session.id)?.messages).toEqual([])
  })

  it('does not overwrite a shard it failed to read', async () => {
    const { store, dir, workspacePath } = await setup()
    const kept = await store.createSession(workspacePath)
    const edited = await store.createSession(workspacePath)
    await store.addMessage(kept.id, message('message-1', '保留这条'))
    await store.flush()

    const keptPath = join(dir, SESSIONS_DIR, shardFileName(kept.id))
    const original = await readFile(keptPath, 'utf8')
    await writeFile(keptPath, '{oops', 'utf8')

    const reopened = new Store()
    await reopened.load()
    // Touch the broken session, then edit a different one and save.
    expect(reopened.session(kept.id)?.messages).toEqual([])
    await reopened.addMessage(edited.id, message('message-2', '新的'))
    expect(await readFile(keptPath, 'utf8')).toBe('{oops')
    expect(original).toContain('保留这条')
  })

  it('deletes the shard and the search entry with the session', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessage(session.id, message('message-1', '要删掉的对话'))
    await store.flush()
    expect(await names(join(dir, SESSIONS_DIR))).toContain(shardFileName(session.id))

    await store.deleteSession(session.id)
    await store.flush()

    expect(await names(join(dir, SESSIONS_DIR))).not.toContain(shardFileName(session.id))
    const search = JSON.parse(
      await readFile(join(dir, DERIVED_DIR, SEARCH_INDEX_FILE), 'utf8'),
    )
    expect(search.sessions[session.id]).toBeUndefined()
    expect(store.searchSessions('要删掉的对话')).toHaveLength(0)
  })

  it('rebuilds the search cache from shards after it is deleted', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessage(session.id, message('message-1', '重构登录流程并补测试'))
    await store.flush()
    expect(await names(join(dir, DERIVED_DIR))).toContain(SEARCH_INDEX_FILE)

    await rm(join(dir, DERIVED_DIR), { recursive: true, force: true })

    const reopened = new Store()
    await reopened.load()
    const hits = reopened.searchSessions('登录流程')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.sessionId).toBe(session.id)
    // Rebuilding also refreshes the cache for the next start.
    await reopened.flush()
    expect(await names(join(dir, DERIVED_DIR))).toContain(SEARCH_INDEX_FILE)
  })

  it('searches a session whose transcript is still on disk', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessage(session.id, message('message-1', '只在磁盘上的内容'))
    await store.flush()

    const reopened = new Store()
    await reopened.load()
    await unlink(join(dir, SESSIONS_DIR, shardFileName(session.id)))
    await unlink(join(dir, SESSIONS_DIR, messagesFileName(session.id)))
    const hits = reopened.searchSessions('磁盘')
    expect(hits.map((hit) => hit.sessionId)).toEqual([session.id])
  })

  it('recovers a shard the index does not mention', async () => {
    const { store, dir, workspacePath } = await setup()
    const first = await store.createSession(workspacePath)
    const second = await store.createSession(workspacePath)
    await store.addMessage(first.id, message('message-1', '第一个会话'))
    await store.addMessage(second.id, message('message-2', '第二个会话'))
    await store.flush()

    const indexPath = join(dir, SESSIONS_DIR, SESSION_INDEX_FILE)
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    index.sessions = index.sessions.filter((entry: { id: string }) => entry.id !== first.id)
    await writeFile(indexPath, JSON.stringify(index), 'utf8')

    const reopened = new Store()
    await reopened.load()
    expect(reopened.session(first.id)?.messages).toHaveLength(1)
    expect(reopened.session(second.id)?.messages).toHaveLength(1)
  })

  it('appends new messages without rewriting the transcript', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessage(session.id, message('message-1', '第一条'))
    await store.flush()

    const transcript = join(dir, SESSIONS_DIR, messagesFileName(session.id))
    const first = await readFile(transcript, 'utf8')

    const append = vi.spyOn(SessionStorage.prototype, 'appendSessionMessages')
    const rewrite = vi.spyOn(SessionStorage.prototype, 'writeSessionMessages')
    await store.addMessage(session.id, message('message-2', '第二条'))
    await store.flush()

    expect(rewrite).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledTimes(1)
    const second = await readFile(transcript, 'utf8')
    // The original bytes are untouched: the new message was appended.
    expect(second.startsWith(first)).toBe(true)
    expect(second.trim().split('\n')).toHaveLength(2)
  })

  it('rewrites the transcript after a message is edited', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessages(session.id, [
      message('message-1', '原来'),
      message('message-2', '之后'),
    ])
    await store.flush()

    const rewrite = vi.spyOn(SessionStorage.prototype, 'writeSessionMessages')
    await store.rewriteUserMessage(session.id, 'message-1', '改过', 'run-1')
    await store.flush()

    expect(rewrite).toHaveBeenCalledTimes(1)
    const transcript = join(dir, SESSIONS_DIR, messagesFileName(session.id))
    const lines = (await readFile(transcript, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).content).toBe('改过')
  })

  it('removes the final unanswered instruction from the transcript', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessages(session.id, [
      message('message-1', '已经回复'),
      {
        id: 'message-2',
        role: 'assistant' as const,
        content: '回答',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
      message('message-3', '还没有回复'),
    ])
    await store.flush()

    const rewrite = vi.spyOn(SessionStorage.prototype, 'writeSessionMessages')
    await store.removeUnansweredMessage(session.id, 'message-3')
    await store.flush()

    expect(rewrite).toHaveBeenCalledTimes(1)
    expect(store.session(session.id)?.messages.map((item) => item.id)).toEqual([
      'message-1',
      'message-2',
    ])
    const transcript = join(dir, SESSIONS_DIR, messagesFileName(session.id))
    const lines = (await readFile(transcript, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('refuses to delete an instruction that already has a reply', async () => {
    const { store, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessages(session.id, [
      message('message-1', '指令'),
      {
        id: 'message-2',
        role: 'assistant' as const,
        content: '回答',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ])
    await expect(store.removeUnansweredMessage(session.id, 'message-1')).rejects.toThrow(
      'already has a reply',
    )
  })

  it('migrates an inline version-1 shard into an append-only transcript', async () => {
    const { store, dir, workspacePath } = await setup()
    const session = await store.createSession(workspacePath)
    await store.addMessage(session.id, message('message-1', '内联消息'))
    await store.flush()

    const shardPath = join(dir, SESSIONS_DIR, shardFileName(session.id))
    const transcript = join(dir, SESSIONS_DIR, messagesFileName(session.id))
    const meta = JSON.parse(await readFile(shardPath, 'utf8'))
    await writeFile(
      shardPath,
      JSON.stringify({ ...meta, messages: [message('message-1', '内联消息')] }),
      'utf8',
    )
    await unlink(transcript)

    const reopened = new Store()
    await reopened.load()
    expect(reopened.session(session.id)?.messages.map((entry) => entry.id)).toEqual([
      'message-1',
    ])
    await reopened.addMessage(session.id, message('message-2', '追加消息'))
    await reopened.flush()

    const migrated = JSON.parse(await readFile(shardPath, 'utf8'))
    expect(migrated.messages).toBeUndefined()
    const lines = (await readFile(transcript, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).content).toBe('追加消息')
  })

  it('migrates the legacy single file once and keeps a backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-shards-'))
    cleanups.push(root)
    userDataDir = join(root, 'user-data')
    const workspacePath = join(root, 'ws')
    await mkdir(userDataDir, { recursive: true })
    await writeFile(
      join(userDataDir, LEGACY_FILE),
      JSON.stringify({
        version: 2,
        settings: { shellMode: true, defaultApprovalMode: 'auto' },
        workspaces: [{ path: workspacePath, name: 'ws', runs: [], memory: [] }],
        sessions: [
          {
            id: 'legacy-session',
            title: '旧会话',
            workspacePath,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [message('message-1', '历史消息')],
          },
        ],
        scheduled: [],
        activeWorkspace: workspacePath,
        activeSession: 'legacy-session',
      }),
      'utf8',
    )

    const store = new Store()
    await store.load()
    await store.flush()

    expect(store.session('legacy-session')?.messages).toHaveLength(1)
    expect(await names(join(userDataDir, SESSIONS_DIR))).toContain(
      shardFileName('legacy-session'),
    )
    expect(await names(userDataDir)).toContain(`${LEGACY_FILE}.bak`)
    expect(store.searchSessions('历史消息')).toHaveLength(1)
  })
})

describe('writeJson skips unchanged files', () => {
  it('leaves the file alone when the serialized body is identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-write-skip-'))
    cleanups.push(root)
    const storage = new SessionStorage(root)
    const core = { version: 2, settings: { shellMode: true }, sessions: [] }

    await storage.writeCore(core)
    const first = await stat(storage.corePath)

    // A second save with the same bytes must not open or rename the file.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await storage.writeCore({ ...core, sessions: [] })
    const second = await stat(storage.corePath)
    expect(second.mtimeMs).toBe(first.mtimeMs)
    expect(await names(root)).not.toContain(`${CORE_FILE}.tmp`)

    // A real change still lands on disk.
    await storage.writeCore({ ...core, activeSession: 'other' })
    const third = await stat(storage.corePath)
    expect(third.mtimeMs).not.toBe(first.mtimeMs)
    expect(await storage.readCore()).toMatchObject({ activeSession: 'other' })
  })
})
