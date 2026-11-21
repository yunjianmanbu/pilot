import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''
const cleanups: string[] = []

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

import { createScheduleTaskBridge } from '../src/main/agent/schedule-bridge'
import { executePilotTool, SCHEDULE_TASK, type ToolHost } from '../src/main/agent/tools'
import { Store } from '../src/main/store'

const signal = new AbortController().signal

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

/** 这一组走真实 Store：验证 schedule_task → bridge → store 的字段与落盘语义一致。 */
async function setup(): Promise<{
  store: Store
  sessionId: string
  workspacePath: string
  changes: () => number
  host: ToolHost
}> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-schedule-bridge-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  const session = await store.createSession(workspace.path)
  let changes = 0
  const host: ToolHost = {
    root: workspacePath,
    remember: async () => ({ id: 'mem-1' }),
    updatePlan: () => undefined,
    proposeSelfUpdate: async () => ({ version: 1 }),
    scheduleTasks: createScheduleTaskBridge(store, session.id, () => {
      changes += 1
    }),
  }
  return { store, sessionId: session.id, workspacePath, changes: () => changes, host }
}

describe('schedule_task over a real store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T08:00:00.000Z'))
  })

  it('creates a task that lands in the session schedule', async () => {
    const { store, sessionId, changes, host } = await setup()
    const result = await executePilotTool(
      SCHEDULE_TASK,
      { action: 'add', content: '  整理   今天的待办  ', delayMinutes: 25 },
      host,
      signal,
    )

    const tasks = store.scheduledTasks(sessionId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      content: '整理 今天的待办',
      kind: 'once',
      enabled: true,
      sessionId,
      nextRunAt: '2026-03-01T08:25:00.000Z',
    })
    expect(result.output).toContain('已创建定时任务')
    expect(result.output).toContain('整理 今天的待办')
    expect(changes()).toBe(1)
  })

  it('lists, pauses and deletes by the short id it printed', async () => {
    const { store, sessionId, changes, host } = await setup()
    await executePilotTool(
      SCHEDULE_TASK,
      { action: 'add', content: '每天写晨报', kind: 'daily', timeOfDay: '09:00' },
      host,
      signal,
    )
    const created = store.scheduledTasks(sessionId)[0]
    if (!created) throw new Error('task was not created')
    const shortId = created.id.slice(0, 8)

    const listed = await executePilotTool(SCHEDULE_TASK, { action: 'list' }, host, signal)
    expect(listed.output).toContain(`id ${shortId}`)
    expect(listed.output).toContain('每天 09:00')

    await executePilotTool(
      SCHEDULE_TASK,
      { action: 'update', taskId: shortId, enabled: false },
      host,
      signal,
    )
    expect(store.scheduledTasks(sessionId)[0]).toMatchObject({ enabled: false, kind: 'daily' })

    const removed = await executePilotTool(
      SCHEDULE_TASK,
      { action: 'remove', taskId: shortId },
      host,
      signal,
    )
    expect(store.scheduledTasks(sessionId)).toHaveLength(0)
    expect(removed.output).toContain('已删除定时任务')
    expect(changes()).toBe(3)
  })

  it('only touches the session it belongs to', async () => {
    const { store, sessionId, workspacePath, host } = await setup()
    const other = await store.createSession(workspacePath)
    await executePilotTool(SCHEDULE_TASK, { action: 'add', content: '只在另一个会话' }, host, signal)

    expect(store.scheduledTasks(sessionId)).toHaveLength(1)
    expect(store.scheduledTasks(other.id)).toHaveLength(0)

    const created = store.scheduledTasks(sessionId)[0]
    if (!created) throw new Error('task was not created')
    const otherBridge = createScheduleTaskBridge(store, other.id)
    await expect(otherBridge({ action: 'remove', taskId: created.id })).rejects.toThrow(
      '定时任务不存在',
    )
  })
})
