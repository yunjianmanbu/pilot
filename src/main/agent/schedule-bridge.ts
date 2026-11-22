import type { ScheduledTask, ScheduledTaskInput } from '../../shared/types'
import type { ScheduleTaskRequest, ScheduleTaskResult } from './tools'

/** store 里定时任务相关的四个方法；单测用一个内存实现顶替。 */
export interface ScheduleTaskStore {
  scheduledTasks(sessionId: string): ScheduledTask[]
  addScheduledTask(sessionId: string, input: ScheduledTaskInput): Promise<ScheduledTask>
  updateScheduledTask(
    sessionId: string,
    taskId: string,
    input: Partial<ScheduledTaskInput> & { enabled?: boolean },
  ): Promise<ScheduledTask>
  removeScheduledTask(sessionId: string, taskId: string): Promise<void>
}

/**
 * 按完整 id 或唯一前缀找一条定时任务。schedule_task 的 list 只打印 8 位短 id，
 * 模型拿这 8 位就能改自己的任务，不必先回显一整行 UUID。前缀有歧义时返回
 * undefined 而不是猜一个。
 */
export function matchScheduledTask(
  tasks: ScheduledTask[],
  taskId: string,
): ScheduledTask | undefined {
  const key = taskId.trim()
  if (!key) return undefined
  const exact = tasks.find((task) => task.id === key)
  if (exact) return exact
  const prefixed = tasks.filter((task) => task.id.startsWith(key))
  return prefixed.length === 1 ? prefixed[0] : undefined
}

/**
 * 把 schedule_task 的四个动作接到本会话的定时任务上。每条任务都绑定
 * sessionId：到点后它是往这个会话里发一条普通用户消息，因此工作区、模型和
 * 审批策略都与用户手打的完全一致。
 *
 * 与渲染进程的「定时任务」面板共用同一份 store 校验，所以间隔下限、\"HH:mm\" 规范化
 * 这些规则两边不会漂移。
 */
export function createScheduleTaskBridge(
  store: ScheduleTaskStore,
  sessionId: string,
  onChange?: () => void,
): (request: ScheduleTaskRequest) => Promise<ScheduleTaskResult> {
  return async (request) => {
    const list = (): ScheduledTask[] => store.scheduledTasks(sessionId)
    if (request.action === 'list') return { tasks: list() }
    if (request.action === 'add') {
      const task = await store.addScheduledTask(sessionId, request.input)
      onChange?.()
      return { task, tasks: list() }
    }
    const match = matchScheduledTask(list(), request.taskId)
    if (!match) throw new Error(`定时任务不存在：${request.taskId}`)
    if (request.action === 'remove') {
      await store.removeScheduledTask(sessionId, match.id)
      onChange?.()
      return { removed: match.id, tasks: list() }
    }
    const task = await store.updateScheduledTask(sessionId, match.id, request.input)
    onChange?.()
    return { task, tasks: list() }
  }
}
