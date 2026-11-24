import { describe, expect, it } from 'vitest'
import {
  executePilotTool,
  pilotTools,
  REVIEW_TOOL_ALLOWLIST,
  SCHEDULE_TASK,
  type ScheduleTaskRequest,
  type ToolHost,
} from '../src/main/agent/tools'
import { matchScheduledTask } from '../src/main/agent/runner'
import { selectExploreTools } from '../src/main/agent/explore'
import { selectSubagentTools } from '../src/main/agent/subagent'
import { toolDescriptionZh } from '../src/shared/tools-catalog'
import type { ScheduledTask } from '../src/shared/types'

const signal = new AbortController().signal

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: '3f2a1b9c-1111-4222-8333-444455556666',
    sessionId: 's1',
    content: '整理今天的待办',
    kind: 'daily',
    timeOfDay: '09:00',
    nextRunAt: '2026-11-22T01:00:00.000Z',
    enabled: true,
    createdAt: '2026-11-21T00:00:00.000Z',
    ...overrides,
  }
}

function fakeHost(tasks: ScheduledTask[] = []): {
  host: ToolHost
  requests: ScheduleTaskRequest[]
} {
  const requests: ScheduleTaskRequest[] = []
  return {
    requests,
    host: {
      root: '.',
      remember: async () => ({ id: 'mem-1' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
      scheduleTasks: async (request) => {
        requests.push(request)
        if (request.action === 'list') return { tasks }
        if (request.action === 'remove') return { removed: request.taskId, tasks: [] }
        if (request.action === 'add') {
          return { task: task({ content: request.input.content }), tasks: [task()] }
        }
        return { task: task({ content: '改过的内容' }), tasks: [task()] }
      },
    },
  }
}

describe('schedule_task tool definition', () => {
  it('is a control tool with a Chinese catalog line', () => {
    const tool = pilotTools.find((entry) => entry.name === SCHEDULE_TASK)
    expect(tool).toBeTruthy()
    expect(tool?.risk).toBe('control')
    expect(tool?.source).toBe('control')
    expect(tool?.inputSchema).toMatchObject({ required: ['action'] })
    expect(toolDescriptionZh(SCHEDULE_TASK)).toContain('定时任务')
  })

  it('is not offered to review, explore or subagent runs', () => {
    // 定时任务会在未来触发真实运行，只读场景和子代理不该拿到这个入口。
    expect(REVIEW_TOOL_ALLOWLIST.has(SCHEDULE_TASK)).toBe(false)
    const everyone = pilotTools
    expect(selectExploreTools(everyone).some((tool) => tool.name === SCHEDULE_TASK)).toBe(false)
    for (const mode of ['general', 'explore', 'toolsmith'] as const) {
      expect(selectSubagentTools(mode).some((tool) => tool.name === SCHEDULE_TASK)).toBe(false)
    }
  })
})

describe('schedule_task actions', () => {
  it('lists the session schedule with a short id and local time', async () => {
    const { host, requests } = fakeHost([task(), task({ id: 'abcdef12-0000-0000-0000-000000000000', enabled: false })])
    const result = await executePilotTool(SCHEDULE_TASK, { action: 'list' }, host, signal)
    expect(requests).toEqual([{ action: 'list' }])
    expect(result.ok).toBe(true)
    expect(result.output).toContain('1. 每天 09:00')
    expect(result.output).toContain('id 3f2a1b9c')
    expect(result.output).toContain('已暂停')
    expect(result.output).toContain('整理今天的待办')
    expect(result.metadata).toEqual({ scheduledTasks: 2 })
  })

  it('says so when the session has no schedule', async () => {
    const { host } = fakeHost([])
    const result = await executePilotTool(SCHEDULE_TASK, { action: 'list' }, host, signal)
    expect(result.output).toBe('本会话没有定时任务。')
  })

  it('adds a one-off task and defaults the delay to 10 minutes', async () => {
    const { host, requests } = fakeHost()
    const result = await executePilotTool(
      SCHEDULE_TASK,
      { action: 'add', content: '  回顾   今天的改动  ', delayMinutes: 30 },
      host,
      signal,
    )
    expect(requests[0]).toEqual({
      action: 'add',
      input: { content: '回顾 今天的改动', kind: 'once', delayMinutes: 30 },
    })
    expect(result.output).toContain('已创建定时任务')
  })

  it('defaults delayMinutes when the model omits it', async () => {
    const { host, requests } = fakeHost()
    await executePilotTool(SCHEDULE_TASK, { action: 'add', content: '跑一次构建' }, host, signal)
    expect(requests[0]).toEqual({
      action: 'add',
      input: { content: '跑一次构建', kind: 'once', delayMinutes: 10 },
    })
  })

  it('adds interval and daily tasks with their own time fields', async () => {
    const { host, requests } = fakeHost()
    await executePilotTool(
      SCHEDULE_TASK,
      { action: 'add', content: '同步进度', kind: 'interval', intervalMinutes: 90 },
      host,
      signal,
    )
    await executePilotTool(
      SCHEDULE_TASK,
      { action: 'add', content: '写晨报', kind: 'daily', timeOfDay: '08:30' },
      host,
      signal,
    )
    expect(requests).toEqual([
      { action: 'add', input: { content: '同步进度', kind: 'interval', intervalMinutes: 90 } },
      { action: 'add', input: { content: '写晨报', kind: 'daily', timeOfDay: '08:30' } },
    ])
  })

  it('passes a daily start date through add and update', async () => {
    const { host, requests } = fakeHost([task()])
    await executePilotTool(
      SCHEDULE_TASK,
      {
        action: 'add',
        content: '每天 20:00 发布小红书',
        kind: 'daily',
        timeOfDay: '20:00',
        startDate: '2026-11-25',
      },
      host,
      signal,
    )
    // 空串是「从今天起」，必须原样透传而不是被当成没传。
    await executePilotTool(
      SCHEDULE_TASK,
      { action: 'update', taskId: '3f2a1b9c', startDate: '' },
      host,
      signal,
    )
    expect(requests).toEqual([
      {
        action: 'add',
        input: { content: '每天 20:00 发布小红书', kind: 'daily', timeOfDay: '20:00', startDate: '2026-11-25' },
      },
      { action: 'update', taskId: '3f2a1b9c', input: { startDate: '' } },
    ])
  })

  it('mentions the start date in the listed schedule', async () => {
    const { host } = fakeHost([task({ startDate: '2026-11-25' })])
    const result = await executePilotTool(SCHEDULE_TASK, { action: 'list' }, host, signal)
    expect(result.output).toContain('每天 09:00（从 2026-11-25 起）')
  })

  it('rejects an empty content and a daily task without a time', async () => {
    const { host, requests } = fakeHost()
    await expect(
      executePilotTool(SCHEDULE_TASK, { action: 'add', content: '   ' }, host, signal),
    ).rejects.toThrow('content is required')
    await expect(
      executePilotTool(SCHEDULE_TASK, { action: 'add', content: '写晨报', kind: 'daily' }, host, signal),
    ).rejects.toThrow('timeOfDay')
    expect(requests).toEqual([])
  })

  it('updates only the fields the model passed', async () => {
    const { host, requests } = fakeHost([task()])
    const result = await executePilotTool(
      SCHEDULE_TASK,
      { action: 'update', taskId: '3f2a1b9c', enabled: false },
      host,
      signal,
    )
    expect(requests[0]).toEqual({
      action: 'update',
      taskId: '3f2a1b9c',
      input: { enabled: false },
    })
    expect(result.output).toContain('已更新定时任务')
  })

  it('refuses an update with nothing to change and one without an id', async () => {
    const { host, requests } = fakeHost([task()])
    await expect(
      executePilotTool(SCHEDULE_TASK, { action: 'update', taskId: '3f2a1b9c' }, host, signal),
    ).rejects.toThrow('Nothing to update')
    await expect(
      executePilotTool(SCHEDULE_TASK, { action: 'remove' }, host, signal),
    ).rejects.toThrow('taskId is required')
    expect(requests).toEqual([])
  })

  it('removes by id and reports the remaining schedule', async () => {
    const { host, requests } = fakeHost([task()])
    const result = await executePilotTool(
      SCHEDULE_TASK,
      { action: 'remove', taskId: '3f2a1b9c-1111-4222-8333-444455556666' },
      host,
      signal,
    )
    expect(requests[0]).toEqual({
      action: 'remove',
      taskId: '3f2a1b9c-1111-4222-8333-444455556666',
    })
    expect(result.output).toContain('已删除定时任务')
    expect(result.metadata).toMatchObject({ removed: '3f2a1b9c-1111-4222-8333-444455556666' })
  })

  it('rejects an unknown action and a host without schedules', async () => {
    const { host } = fakeHost()
    await expect(executePilotTool(SCHEDULE_TASK, { action: 'pause' }, host, signal)).rejects.toThrow(
      'Unknown action',
    )
    const { scheduleTasks: _drop, ...bare } = host
    await expect(executePilotTool(SCHEDULE_TASK, { action: 'list' }, bare, signal)).rejects.toThrow(
      'not available',
    )
  })
})

describe('matchScheduledTask', () => {
  const tasks = [task({ id: '3f2a1b9c-aaaa' }), task({ id: '9e8d7c6b-bbbb' })]

  it('matches the full id and a unique prefix', () => {
    expect(matchScheduledTask(tasks, '3f2a1b9c-aaaa')?.id).toBe('3f2a1b9c-aaaa')
    expect(matchScheduledTask(tasks, '9e8d')?.id).toBe('9e8d7c6b-bbbb')
  })

  it('refuses an empty or ambiguous prefix', () => {
    expect(matchScheduledTask(tasks, '')).toBeUndefined()
    expect(matchScheduledTask(tasks, '3f2a1b9c')).toBe(tasks[0])
    expect(matchScheduledTask(tasks, 'z')).toBeUndefined()
    // 两条任务共享前缀时不能猜。
    expect(matchScheduledTask([task({ id: 'abc-1' }), task({ id: 'abc-2' })], 'abc')).toBeUndefined()
  })
})
