import { describe, expect, it } from 'vitest'
import { insertMustQueue, shouldPromoteQueue } from '../src/main/agent/queue-policy'

/**
 * 排队语义是「当前任务结束后自动开始」。这四个用例把「什么叫结束」钉住：
 * 用户按了暂停或停止的那一轮不算结束，队列必须原地等，否则暂停后点「继续」
 * 只会撞上「任务还在运行」。
 */
describe('shouldPromoteQueue', () => {
  it('a completed run starts the queue', () => {
    expect(
      shouldPromoteQueue({
        finalStatus: 'completed',
        continued: false,
        pausedByUser: false,
        stoppedByUser: false,
      }),
    ).toBe(true)
  })

  it('a paused run keeps the queue waiting', () => {
    expect(
      shouldPromoteQueue({
        finalStatus: 'paused',
        continued: false,
        pausedByUser: true,
        stoppedByUser: false,
      }),
    ).toBe(false)
  })

  it('a pause that lands inside the finish window still blocks the queue', () => {
    // 模型刚答完、状态已经算 completed，但用户确实按了暂停：队列不能推上来。
    expect(
      shouldPromoteQueue({
        finalStatus: 'completed',
        continued: false,
        pausedByUser: true,
        stoppedByUser: false,
      }),
    ).toBe(false)
  })

  it('a user stop keeps the queue waiting', () => {
    expect(
      shouldPromoteQueue({
        finalStatus: 'cancelled',
        continued: false,
        pausedByUser: false,
        stoppedByUser: true,
      }),
    ).toBe(false)
  })

  it('an auto-continue wins over the queue', () => {
    expect(
      shouldPromoteQueue({
        finalStatus: 'failed',
        continued: true,
        pausedByUser: false,
        stoppedByUser: false,
      }),
    ).toBe(false)
  })
})

/**
 * 「插入」只能进一个还活着的 run。暂停/停止后的这一轮只剩收尾，再插就把消息
 * 一起丢掉了——必须降级成排队。
 */
describe('insertMustQueue', () => {
  it('a running task accepts an inserted message', () => {
    expect(insertMustQueue({ paused: false, stoppedByUser: false })).toBe(false)
  })

  it('a paused run queues the message instead', () => {
    expect(insertMustQueue({ paused: true, stoppedByUser: false })).toBe(true)
  })

  it('a stopped run queues the message instead', () => {
    expect(insertMustQueue({ paused: false, stoppedByUser: true })).toBe(true)
  })

  it('no live run means there is nothing to insert into', () => {
    expect(insertMustQueue(undefined)).toBe(false)
  })
})
