import { describe, expect, it } from 'vitest'
import { moveQueuedTask, sameQueueOrder } from '../src/main/agent/queue-order'
import type { QueuedTask } from '../src/shared/types'

function task(id: string): QueuedTask {
  return { id, content: `task ${id}`, createdAt: '2026-01-01T00:00:00.000Z' }
}

function queue(...ids: string[]): QueuedTask[] {
  return ids.map(task)
}

describe('moveQueuedTask', () => {
  it('moves a task one slot up', () => {
    const next = moveQueuedTask(queue('a', 'b', 'c'), 'c', 'up')
    expect(next.map((item) => item.id)).toEqual(['a', 'c', 'b'])
  })

  it('moves a task one slot down', () => {
    const next = moveQueuedTask(queue('a', 'b', 'c'), 'a', 'down')
    expect(next.map((item) => item.id)).toEqual(['b', 'a', 'c'])
  })

  it('leaves the queue alone at either end', () => {
    const rows = queue('a', 'b')
    expect(moveQueuedTask(rows, 'a', 'up')).toBe(rows)
    expect(moveQueuedTask(rows, 'b', 'down')).toBe(rows)
  })

  it('leaves the queue alone for an unknown id or a single task', () => {
    const rows = queue('a')
    expect(moveQueuedTask(rows, 'zzz', 'down')).toBe(rows)
    expect(moveQueuedTask(rows, 'a', 'down')).toBe(rows)
    expect(moveQueuedTask([], 'a', 'up')).toEqual([])
  })

  it('does not mutate the input queue', () => {
    const rows = queue('a', 'b', 'c')
    moveQueuedTask(rows, 'b', 'up')
    expect(rows.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('sameQueueOrder', () => {
  it('compares ids in order, not object identity', () => {
    expect(sameQueueOrder(queue('a', 'b'), queue('a', 'b'))).toBe(true)
    expect(sameQueueOrder(queue('a', 'b'), queue('b', 'a'))).toBe(false)
    expect(sameQueueOrder(queue('a'), queue('a', 'b'))).toBe(false)
  })
})
