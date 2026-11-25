// 手机端定时任务的协议透传：起始日期从 params 一路走到 store。
// 这层以前只解析 timeOfDay，手机表单里填的 startDate 会被静默丢掉（下次执行仍是今天）。
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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

import { CompanionServer } from '../src/main/companion/server'
import { Store } from '../src/main/store'
import type { AccessLevel } from '../src/main/companion/access-level'
import type { ScheduledTask } from '../src/shared/types'

const cleanups: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function request(
  server: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  access: AccessLevel = 'local',
): Promise<unknown> {
  return (
    server as unknown as {
      handleRequest(
        name: string,
        input: Record<string, unknown>,
        phone: unknown,
        level: AccessLevel,
      ): Promise<unknown>
    }
  ).handleRequest(method, params, {}, access)
}

async function setup(): Promise<{ server: CompanionServer; store: Store; sessionId: string }> {
  const base = await mkdtemp(join(tmpdir(), 'pilot-companion-schedule-'))
  cleanups.push(base)
  userDataDir = join(base, 'user-data')
  const root = join(base, 'projects')
  await mkdir(root, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(root)
  const session = await store.createSession(workspace.path)
  const server = new CompanionServer({
    store,
    runner: {} as never,
    dataDir: join(base, 'companion'),
    assetsDir: base,
    deviceName: 'Test Desktop',
    appVersion: '0.1.0-test',
    billing: { report: () => Promise.reject(new Error('billing is not stubbed')) },
    onStatus: () => undefined,
  })
  return { server, store, sessionId: session.id }
}

describe('the phone\u2019s first day reaches the scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 本地（UTC+8）2026-03-01 08:00：daily 09:30 还没到，所以「不填起始日」= 今天。
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
  })

  it('keeps the start date a phone sent and fires after it, not today', async () => {
    const { server, store, sessionId } = await setup()
    const created = (await request(server, 'schedules.add', {
      sessionId,
      content: '生成周报',
      kind: 'daily',
      timeOfDay: '09:30',
      startDate: '2026-03-05',
    })) as { task: ScheduledTask }

    expect(created.task.startDate).toBe('2026-03-05')
    const nextRun = new Date(created.task.nextRunAt)
    expect(nextRun.getDate()).toBe(5)
    expect(nextRun.getHours()).toBe(9)
    expect(nextRun.getMinutes()).toBe(30)
    expect(store.scheduledTasks(sessionId)[0]?.startDate).toBe('2026-03-05')
  })

  it('still starts today when the phone leaves the field empty', async () => {
    const { server, store, sessionId } = await setup()
    const created = (await request(server, 'schedules.add', {
      sessionId,
      content: '生成日报',
      kind: 'daily',
      timeOfDay: '09:30',
    })) as { task: ScheduledTask }
    expect(created.task.startDate).toBeUndefined()
    expect(new Date(created.task.nextRunAt).getDate()).toBe(1)
    expect(store.scheduledTasks(sessionId)[0]?.startDate).toBeUndefined()
  })

  it('rejects a malformed first day instead of quietly ignoring it', async () => {
    const { server, sessionId } = await setup()
    await expect(
      request(server, 'schedules.add', {
        sessionId,
        content: '生成周报',
        kind: 'daily',
        timeOfDay: '09:30',
        startDate: '2026/03/05',
      }),
    ).rejects.toThrow('起始日期要像')
  })

  it('moves an existing task when the phone only changes the first day', async () => {
    const { server, store, sessionId } = await setup()
    const created = (await request(server, 'schedules.add', {
      sessionId,
      content: '生成周报',
      kind: 'daily',
      timeOfDay: '09:30',
      startDate: '2026-03-02',
    })) as { task: ScheduledTask }

    const updated = (await request(server, 'schedules.update', {
      sessionId,
      taskId: created.task.id,
      startDate: '2026-03-09',
    })) as { task: ScheduledTask }

    expect(updated.task.startDate).toBe('2026-03-09')
    // 只改日期不该丢掉原来的 09:30。
    expect(updated.task.timeOfDay).toBe('09:30')
    expect(new Date(updated.task.nextRunAt).getDate()).toBe(9)
    expect(store.scheduledTasks(sessionId)[0]?.startDate).toBe('2026-03-09')
  })

  it('carries the first day when a todo becomes a scheduled task', async () => {
    const { server, store, sessionId } = await setup()
    const todo = await store.addTodo(sessionId, '发送周报')
    const created = (await request(server, 'todos.toSchedule', {
      sessionId,
      todoId: todo.id,
      kind: 'daily',
      timeOfDay: '09:30',
      startDate: '2026-03-05',
    })) as { task: ScheduledTask }
    expect(created.task.startDate).toBe('2026-03-05')
    expect(new Date(created.task.nextRunAt).getDate()).toBe(5)
  })
})

describe('the phone\u2019s all-schedules overview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
  })

  type AllGroups = {
    groups: Array<{
      sessionId: string
      sessionTitle: string
      workspacePath: string
      missing: boolean
      tasks: ScheduledTask[]
    }>
  }

  it('returns every session\u2019s tasks in one grouped reply', async () => {
    const { server, store, sessionId } = await setup()
    const second = await store.createSession(store.workspaces()[0]!.path)
    await request(server, 'schedules.add', {
      sessionId,
      content: '生成日报',
      kind: 'interval',
      intervalMinutes: 30,
    })
    await request(server, 'schedules.add', {
      sessionId: second.id,
      content: '发送周报',
      kind: 'daily',
      timeOfDay: '09:30',
    })

    const all = (await request(server, 'schedules.listAll', {})) as AllGroups
    expect(all.groups).toHaveLength(2)
    const titles = all.groups.map((group) => group.tasks[0]?.content).sort()
    expect(titles).toEqual(['发送周报', '生成日报'])
    const first = all.groups.find((group) => group.sessionId === sessionId)
    expect(first?.sessionTitle).toBeTruthy()
    expect(first?.workspacePath).toBe(store.workspaces()[0]!.path)
    expect(first?.missing).toBe(false)
  })

  it('keeps tasks whose session was deleted and marks them missing', async () => {
    const { server, store, sessionId } = await setup()
    // 现在删除会话会级联删定时任务，孤儿只能来自旧数据或手改的 state：
    // 直接往内部 state 里塞一条指向不存在会话的任务，重现这种历史数据。
    const state = (store as unknown as { state: { scheduled: ScheduledTask[] } }).state
    state.scheduled.push({
      id: 'orphan-task',
      sessionId: 'deleted-session',
      content: '旧会话里留下的任务',
      kind: 'interval',
      intervalMinutes: 60,
      nextRunAt: '2026-03-01T01:00:00.000Z',
      enabled: true,
      createdAt: '2026-02-01T00:00:00.000Z',
    })
    expect(store.scheduledTasks(sessionId)).toHaveLength(0)

    const all = (await request(server, 'schedules.listAll', {})) as AllGroups
    expect(all.groups).toHaveLength(1)
    expect(all.groups[0]?.missing).toBe(true)
    expect(all.groups[0]?.sessionTitle).toBe('')
    expect(all.groups[0]?.tasks).toHaveLength(1)
  })
})
