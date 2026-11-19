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

import { Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<{ store: Store; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-schedule-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  const store = new Store()
  await store.load()
  const workspace = await store.addWorkspace(workspacePath)
  const session = await store.createSession(workspace.path)
  return { store, sessionId: session.id }
}

describe('Store scheduled tasks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T08:00:00.000Z'))
  })

  it('schedules once, interval and daily tasks', async () => {
    const { store, sessionId } = await setup()

    const once = await store.addScheduledTask(sessionId, {
      content: '  检查  构建  ',
      kind: 'once',
      delayMinutes: 15,
    })
    expect(once.content).toBe('检查 构建')
    expect(once.enabled).toBe(true)
    expect(Date.parse(once.nextRunAt) - Date.now()).toBe(15 * 60_000)

    const interval = await store.addScheduledTask(sessionId, {
      content: '轮询部署状态',
      kind: 'interval',
      intervalMinutes: 45,
    })
    expect(interval.intervalMinutes).toBe(45)
    expect(Date.parse(interval.nextRunAt) - Date.now()).toBe(45 * 60_000)

    const daily = await store.addScheduledTask(sessionId, {
      content: '生成日报',
      kind: 'daily',
      timeOfDay: '09:30',
    })
    expect(daily.timeOfDay).toBe('09:30')
    const nextDaily = new Date(daily.nextRunAt)
    expect(nextDaily.getHours()).toBe(9)
    expect(nextDaily.getMinutes()).toBe(30)
    expect(nextDaily.getTime()).toBeGreaterThan(Date.now())

    expect(store.scheduledTasks(sessionId).map((task) => task.id)).toEqual([
      once.id,
      interval.id,
      daily.id,
    ])
  })

  it('rejects invalid content and daily times', async () => {
    const { store, sessionId } = await setup()

    await expect(
      store.addScheduledTask(sessionId, {
        content: '   ',
        kind: 'once',
        delayMinutes: 10,
      }),
    ).rejects.toThrow('不能为空')

    await expect(
      store.addScheduledTask(sessionId, {
        content: '日报',
        kind: 'daily',
        timeOfDay: '9:30',
      }),
    ).rejects.toThrow('每天执行的时间')
  })

  it('marks due tasks, disables once tasks and advances recurring tasks', async () => {
    const { store, sessionId } = await setup()
    const once = await store.addScheduledTask(sessionId, {
      content: '一次性检查',
      kind: 'once',
      delayMinutes: 5,
    })
    const interval = await store.addScheduledTask(sessionId, {
      content: '周期检查',
      kind: 'interval',
      intervalMinutes: 30,
    })

    expect(store.dueScheduledTasks()).toHaveLength(0)
    const later = Date.now() + 31 * 60_000
    expect(store.dueScheduledTasks(later).map((task) => task.id).sort()).toEqual(
      [once.id, interval.id].sort(),
    )

    const completedOnce = await store.completeScheduledRun(once.id, 'queued')
    expect(completedOnce?.enabled).toBe(false)
    expect(completedOnce?.lastStatus).toBe('queued')
    expect(store.dueScheduledTasks(later).map((task) => task.id)).toEqual([interval.id])

    const completedInterval = await store.completeScheduledRun(interval.id, 'failed', '队列已满')
    expect(completedInterval?.enabled).toBe(true)
    expect(completedInterval?.lastStatus).toBe('failed')
    expect(completedInterval?.lastError).toBe('队列已满')
    expect(Date.parse(completedInterval!.nextRunAt)).toBe(Date.now() + 30 * 60_000)
  })

  it('re-enabling an expired once task moves it into the future', async () => {
    const { store, sessionId } = await setup()
    const once = await store.addScheduledTask(sessionId, {
      content: '补跑检查',
      kind: 'once',
      delayMinutes: 5,
    })
    await store.updateScheduledTask(sessionId, once.id, { enabled: false })
    vi.setSystemTime(new Date('2026-03-01T09:00:00.000Z'))

    const enabled = await store.updateScheduledTask(sessionId, once.id, { enabled: true })
    expect(enabled.enabled).toBe(true)
    expect(Date.parse(enabled.nextRunAt)).toBe(Date.now() + 10 * 60_000)
  })

  it('converts a pending todo into a scheduled task and removes the todo', async () => {
    const { store, sessionId } = await setup()
    const todo = await store.addTodo(sessionId, '  每天早上检查构建  ', 'user')

    const task = await store.convertTodoToSchedule(sessionId, todo.id, {
      content: '',
      kind: 'daily',
      timeOfDay: '08:30',
    })
    expect(task.content).toBe('每天早上检查构建')
    expect(task.kind).toBe('daily')
    expect(store.todos(sessionId)).toHaveLength(0)

    const missing = await store
      .convertTodoToSchedule(sessionId, todo.id, { content: '', kind: 'once' })
      .catch((error: Error) => error)
    expect(missing).toBeInstanceOf(Error)
  })

  it('converts a scheduled task back into a pending todo', async () => {
    const { store, sessionId } = await setup()
    const task = await store.addScheduledTask(sessionId, {
      content: '巡检部署状态',
      kind: 'interval',
      intervalMinutes: 30,
    })

    const todo = await store.convertScheduledTaskToTodo(sessionId, task.id)
    expect(todo.text).toBe('巡检部署状态')
    expect(todo.status).toBe('pending')
    expect(store.scheduledTasks(sessionId)).toHaveLength(0)
    expect(store.todos(sessionId).map((item) => item.id)).toEqual([todo.id])
  })

  it('refuses to convert an already sent todo', async () => {
    const { store, sessionId } = await setup()
    const todo = await store.addTodo(sessionId, '已发送的待办', 'user')
    await store.markTodoSent(sessionId, todo.id)

    await expect(
      store.convertTodoToSchedule(sessionId, todo.id, { content: '', kind: 'once' }),
    ).rejects.toThrow('已发送的待办')
  })

  it('removes scheduled tasks together with their session', async () => {
    const { store, sessionId } = await setup()
    await store.addScheduledTask(sessionId, {
      content: '过期任务',
      kind: 'interval',
      intervalMinutes: 60,
    })
    expect(store.allScheduledTasks()).toHaveLength(1)

    await store.deleteSession(sessionId)
    expect(store.allScheduledTasks()).toHaveLength(0)
    expect(store.scheduledTasks(sessionId)).toHaveLength(0)
  })

  it('clamps auto-continue and approval timeout settings', async () => {
    const { store } = await setup()
    const view = await store.updateSettings({
      autoContinue: true,
      autoContinueLimit: 42,
      approvalTimeoutSec: -10,
      shellMode: true,
    })
    expect(view.autoContinue).toBe(true)
    expect(view.autoContinueLimit).toBe(10)
    expect(view.approvalTimeoutSec).toBe(0)
    expect(view.shellMode).toBe(true)

    const narrowed = await store.updateSettings({ approvalTimeoutSec: 9_999 })
    expect(narrowed.approvalTimeoutSec).toBe(3_600)
  })
})
