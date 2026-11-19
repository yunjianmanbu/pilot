import type { QueuedTask } from '../../shared/types'

export type QueueMoveDirection = 'up' | 'down'

/**
 * Move one queued task one slot up or down and return the new queue.
 *
 * The queue is the order the tasks will run in, so reordering is a plain array
 * move. An unknown task id or a move past either end returns the original array
 * unchanged, which lets callers treat "already first/last" as a no-op instead of
 * an error.
 */
export function moveQueuedTask(
  queue: QueuedTask[],
  taskId: string,
  direction: QueueMoveDirection,
): QueuedTask[] {
  if (!Array.isArray(queue) || queue.length < 2) return queue
  const index = queue.findIndex((item) => item && item.id === taskId)
  if (index < 0) return queue
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= queue.length) return queue
  const moved = queue[index]
  if (!moved) return queue
  const next = queue.slice()
  next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

/** True when `queue` and `next` hold the same task ids in the same order. */
export function sameQueueOrder(queue: QueuedTask[], next: QueuedTask[]): boolean {
  if (queue === next) return true
  if (queue.length !== next.length) return false
  return queue.every((item, index) => item.id === next[index]?.id)
}
