import type { TodoItem, TodoPriority } from './types'

/** 优先级的固定顺序：面板和手机端都靠它排序与循环切换。 */
export const TODO_PRIORITIES: TodoPriority[] = ['high', 'normal', 'low']

/** 老数据没有优先级字段，一律按 normal 处理，不做数据迁移。 */
export function normalizeTodoPriority(value: unknown): TodoPriority {
  return value === 'high' || value === 'low' ? value : 'normal'
}

/** 调用方可能传任意字符串，统一收敛成合法优先级。 */
export function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === 'string' && (TODO_PRIORITIES as string[]).includes(value)
}

/** 下一个优先级，用于「点一下切换」而不必开菜单。 */
export function nextTodoPriority(value: unknown): TodoPriority {
  const current = normalizeTodoPriority(value)
  const index = TODO_PRIORITIES.indexOf(current)
  return TODO_PRIORITIES[(index + 1) % TODO_PRIORITIES.length] ?? 'normal'
}

/** 高优先级在前，同优先级保持原有的插入顺序（stable sort）。 */
export function sortTodos(todos: TodoItem[]): TodoItem[] {
  const weight: Record<TodoPriority, number> = { high: 0, normal: 1, low: 2 }
  return [...todos].sort(
    (a, b) => weight[normalizeTodoPriority(a.priority)] - weight[normalizeTodoPriority(b.priority)],
  )
}
