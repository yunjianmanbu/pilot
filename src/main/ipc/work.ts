// 待办、计划任务、待办队列与快捷命令。
// 由 index.ts 的 registerIpc 机械搬出：只把 handle 换成 ctx.handle，其余语句逐字保留。
import type { IpcContext } from '../ipc-context'
import type { QuickCommandInput, ScheduledTaskInput, TodoPriority } from '../../shared/types'

export function registerWorkIpc(ctx: IpcContext): void {

  ctx.handle('pilot:queue-remove', (sessionId: string, taskId: string) =>
    ctx.runner.removeQueueItem(sessionId, taskId),
  )

  ctx.handle('pilot:queue-insert', (sessionId: string, taskId: string) =>
    ctx.runner.insertQueueItem(sessionId, taskId),
  )

  ctx.handle('pilot:queue-update', (sessionId: string, taskId: string, content: string) =>
    ctx.runner.updateQueueItem(sessionId, taskId, content),
  )

  ctx.handle('pilot:queue-to-todo', (sessionId: string, taskId: string) =>
    ctx.runner.convertQueueItemToTodo(sessionId, taskId),
  )

  ctx.handle('pilot:quick-commands-list', () => ctx.store.quickCommands())

  ctx.handle('pilot:quick-commands-save', (items: QuickCommandInput[]) =>
    ctx.store.saveQuickCommands(items),
  )

  ctx.handle('pilot:scheduled-list', (sessionId: string) => ctx.store.scheduledTasks(sessionId))

  ctx.handle('pilot:scheduled-all', () => ctx.store.allScheduledTaskGroups())

  ctx.handle(
    'pilot:scheduled-add',
    async (sessionId: string, input: ScheduledTaskInput) => {
      const task = await ctx.store.addScheduledTask(sessionId, input)
      ctx.emitScheduled(sessionId)
      return task
    },
  )

  ctx.handle(
    'pilot:scheduled-update',
    async (
      sessionId: string,
      taskId: string,
      input: Partial<ScheduledTaskInput> & { enabled?: boolean },
    ) => {
      const task = await ctx.store.updateScheduledTask(sessionId, taskId, input)
      ctx.emitScheduled(sessionId)
      return task
    },
  )

  ctx.handle('pilot:scheduled-remove', async (sessionId: string, taskId: string) => {
    await ctx.store.removeScheduledTask(sessionId, taskId)
    ctx.emitScheduled(sessionId)
  })

  ctx.handle('pilot:todos-list', (sessionId: string) => ctx.store.todos(sessionId))

  ctx.handle('pilot:todos-all', () => ctx.store.allTodos())

  ctx.handle(
    'pilot:todo-add',
    async (sessionId: string, text: string, clientId?: string, priority?: TodoPriority) => {
      const todo = await ctx.store.addTodo(sessionId, text, 'user', clientId, priority)
      ctx.emitTodos(sessionId)
      return todo
    },
  )

  ctx.handle(
    'pilot:todo-update',
    async (sessionId: string, todoId: string, text: string, priority?: TodoPriority) => {
      const todo = await ctx.store.updateTodo(sessionId, todoId, text, priority)
      ctx.emitTodos(sessionId)
      return todo
    },
  )

  ctx.handle(
    'pilot:todo-priority',
    async (sessionId: string, todoId: string, priority: TodoPriority) => {
      const todo = await ctx.store.setTodoPriority(sessionId, todoId, priority)
      ctx.emitTodos(sessionId)
      return todo
    },
  )

  ctx.handle('pilot:todo-remove', async (sessionId: string, todoId: string) => {
    await ctx.store.removeTodo(sessionId, todoId)
    ctx.emitTodos(sessionId)
  })

  ctx.handle('pilot:todos-clear-sent', async (sessionId: string) => {
    await ctx.store.clearSentTodos(sessionId)
    ctx.emitTodos(sessionId)
  })

  ctx.handle('pilot:todo-send', async (sessionId: string, todoId: string) => {
    const todo = ctx.store.todo(sessionId, todoId)
    if (!todo) throw new Error('待办不存在')
    if (todo.status === 'sent') throw new Error('该待办已发送')
    const result = await ctx.runner.sendMessage(sessionId, todo.text, 'queue')
    const updated = await ctx.store.markTodoSent(
      sessionId,
      todoId,
      ctx.runner.activeRun(sessionId)?.runId,
    )
    ctx.emitTodos(sessionId)
    return { ...result, todo: updated ?? todo }
  })

  ctx.handle('pilot:todos-send-all', async (sessionId: string) => {
    const pending = ctx.store
      .todos(sessionId)
      .filter((todo) => todo.status === 'pending')
      .reverse()
    let sent = 0
    let failed = 0
    for (const todo of pending) {
      try {
        await ctx.runner.sendMessage(sessionId, todo.text, 'queue')
        await ctx.store.markTodoSent(sessionId, todo.id, ctx.runner.activeRun(sessionId)?.runId)
        sent += 1
      } catch {
        failed += 1
      }
    }
    ctx.emitTodos(sessionId)
    return { sent, failed }
  })


  ctx.handle(
    'pilot:todo-to-schedule',
    async (sessionId: string, todoId: string, input: ScheduledTaskInput) => {
      const task = await ctx.store.convertTodoToSchedule(sessionId, todoId, input)
      ctx.emitScheduled(sessionId)
      ctx.emitTodos(sessionId)
      return task
    },
  )

  ctx.handle('pilot:scheduled-to-todo', async (sessionId: string, taskId: string) => {
    const todo = await ctx.store.convertScheduledTaskToTodo(sessionId, taskId)
    ctx.emitScheduled(sessionId)
    ctx.emitTodos(sessionId)
    return todo
  })
}
