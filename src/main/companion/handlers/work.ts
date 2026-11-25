// 待办与定时任务：todos / schedules（含两者互转）。
// 由 server.ts 的 handleRequest switch 按域拆出；协议文案与错误提示保持原样。
import { isTodoPriority } from '../../../shared/todos'
import { requireString } from '../helpers'
import type { AccessLevel } from '../access-level'
import type { CompanionServer } from '../server'
import type { StoredPhone } from '../types'

/** schedules.listAll 的分组形状：与桌面端 ScheduledTaskGroup 一致，外加 missing 标记。 */
interface ScheduledTaskGroupPayload {
  sessionId: string
  sessionTitle: string
  workspacePath: string
  sessionUpdatedAt: string
  missing: boolean
  tasks: ReturnType<CompanionServer['options']['store']['allScheduledTasks']>
}

export async function handleWorkRequest(
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  phone: StoredPhone,
  _access: AccessLevel = 'paired',
): Promise<unknown> {
  switch (method) {
    case 'schedules.list': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      return { tasks: host.options.store.scheduledTasks(sessionId) }
    }
    case 'schedules.listAll': {
      // 手机首页「全部定时任务」：一次拿回所有会话的定时任务。
      // 不复用 store.allScheduledTaskGroups()，因为它会静默丢掉会话已删除的任务，
      // 而「查看全部」恰恰要让人看到这些没人清理的任务。会话查不到时标题留空，
      // 由手机端显示成「已删除的会话」，并禁止点进会话。
      const store = host.options.store
      const sessions = new Map<string, { title: string; workspacePath: string; updatedAt: string }>()
      for (const workspace of store.workspaces()) {
        for (const session of store.sessions(workspace.path)) {
          sessions.set(session.id, {
            title: session.title,
            workspacePath: session.workspacePath,
            updatedAt: session.updatedAt,
          })
        }
      }
      const groups = new Map<string, ScheduledTaskGroupPayload>()
      for (const task of store.allScheduledTasks()) {
        const session = sessions.get(task.sessionId)
        const group = groups.get(task.sessionId) ?? {
          sessionId: task.sessionId,
          sessionTitle: session?.title ?? '',
          workspacePath: session?.workspacePath ?? '',
          sessionUpdatedAt: session?.updatedAt ?? '',
          missing: !session,
          tasks: [],
        }
        group.tasks.push(task)
        groups.set(task.sessionId, group)
      }
      return { groups: [...groups.values()] }
    }
    case 'schedules.add': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const input = host.scheduleInput(params, true)
      if (!input.content || !input.kind) throw new Error('定时任务参数不完整')
      const task = await host.options.store.addScheduledTask(sessionId, {
        content: input.content,
        kind: input.kind,
        ...(input.delayMinutes !== undefined ? { delayMinutes: input.delayMinutes } : {}),
        ...(input.intervalMinutes !== undefined
          ? { intervalMinutes: input.intervalMinutes }
          : {}),
        ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      })
      host.emitScheduled(sessionId)
      return { task }
    }
    case 'schedules.update': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '定时任务', 80)
      const input = host.scheduleInput(params, false)
      const task = await host.options.store.updateScheduledTask(sessionId, taskId, input)
      host.emitScheduled(sessionId)
      return { task }
    }
    case 'schedules.remove': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '定时任务', 80)
      await host.options.store.removeScheduledTask(sessionId, taskId)
      host.emitScheduled(sessionId)
      return { ok: true }
    }
    case 'todos.list': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      return { todos: host.options.store.todos(sessionId) }
    }
    case 'todos.add': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const text = requireString(params['text'], '待办', 4_000)
      const clientId =
        typeof params['clientId'] === 'string' ? params['clientId'].slice(0, 120) : undefined
      const priority = isTodoPriority(params['priority']) ? params['priority'] : undefined
      const todo = await host.options.store.addTodo(
        sessionId,
        text,
        'phone',
        clientId,
        priority,
      )
      host.emitTodos(sessionId)
      return { todo }
    }
    case 'todos.update': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const todoId = requireString(params['todoId'], '待办', 80)
      const text = requireString(params['text'], '待办', 4_000)
      const priority = isTodoPriority(params['priority']) ? params['priority'] : undefined
      const todo = await host.options.store.updateTodo(sessionId, todoId, text, priority)
      host.emitTodos(sessionId)
      return { todo }
    }
    case 'todos.priority': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const todoId = requireString(params['todoId'], '待办', 80)
      if (!isTodoPriority(params['priority'])) throw new Error('优先级不合法')
      const todo = await host.options.store.setTodoPriority(
        sessionId,
        todoId,
        params['priority'],
      )
      host.emitTodos(sessionId)
      return { todo }
    }
    case 'todos.remove': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const todoId = requireString(params['todoId'], '待办', 80)
      await host.options.store.removeTodo(sessionId, todoId)
      host.emitTodos(sessionId)
      return { ok: true }
    }
    case 'todos.clearSent': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      await host.options.store.clearSentTodos(sessionId)
      host.emitTodos(sessionId)
      return { ok: true }
    }
    case 'todos.send': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const todoId = requireString(params['todoId'], '待办', 80)
      const todo = host.options.store.todo(sessionId, todoId)
      if (!todo) throw new Error('待办不存在')
      if (todo.status === 'sent') throw new Error('该待办已发送')
      const result = await host.options.runner.sendMessage(sessionId, todo.text, 'queue')
      const updated = await host.options.store.markTodoSent(
        sessionId,
        todoId,
        host.options.runner.activeRun(sessionId)?.runId,
      )
      host.emitTodos(sessionId)
      return { ...result, todo: updated ?? todo }
    }
    case 'todos.sendAll': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const pending = host.options.store
        .todos(sessionId)
        .filter((todo) => todo.status === 'pending')
        .reverse()
      let sent = 0
      let failed = 0
      for (const todo of pending) {
        try {
          await host.options.runner.sendMessage(sessionId, todo.text, 'queue')
          await host.options.store.markTodoSent(
            sessionId,
            todo.id,
            host.options.runner.activeRun(sessionId)?.runId,
          )
          sent += 1
        } catch {
          failed += 1
        }
      }
      host.emitTodos(sessionId)
      return { sent, failed }
    }
    case 'todos.toSchedule': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const todoId = requireString(params['todoId'], '待办', 80)
      const input = host.scheduleInput(params, false)
      const task = await host.options.store.convertTodoToSchedule(sessionId, todoId, {
        content: input.content ?? '',
        kind: input.kind ?? 'once',
        ...(input.delayMinutes !== undefined ? { delayMinutes: input.delayMinutes } : {}),
        ...(input.intervalMinutes !== undefined
          ? { intervalMinutes: input.intervalMinutes }
          : {}),
        ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      })
      host.emitTodos(sessionId)
      host.emitScheduled(sessionId)
      return { task }
    }
    case 'schedules.toTodo': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '定时任务', 80)
      const todo = await host.options.store.convertScheduledTaskToTodo(sessionId, taskId)
      host.emitTodos(sessionId)
      host.emitScheduled(sessionId)
      return { todo }
    }
    default:
      throw new Error(`手机端不支持该操作：${method}`)
  }
}