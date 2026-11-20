import { describe, expect, it } from 'vitest'
import { toAgentMessage } from '../src/main/agent/runner'
import { collapseCompletedTurns, isUserTaskTurn } from '../src/main/agent/context'
import type { StoredMessage } from '../src/shared/types'

function stored(over: Partial<StoredMessage> & Pick<StoredMessage, 'role' | 'content'>): StoredMessage {
  return { id: 'm', createdAt: '2026-01-01T00:00:00.000Z', ...over }
}

const CONTINUE = '从上次中断的地方继续完成当前任务。先检查工作区当前状态，不要重复已完成的工作。'

describe('replayed continuation prompts', () => {
  it('keeps control messages marked as internal on the way back into the model', () => {
    const message = toAgentMessage(stored({ role: 'user', content: CONTINUE, control: true }))
    expect(message.internal).toBe(true)
    // The whole point of the mark: a resume prompt the system wrote must not
    // read as a task the user opened.
    expect(isUserTaskTurn(message)).toBe(false)
  })

  it('still treats a real user instruction as a task', () => {
    expect(isUserTaskTurn(toAgentMessage(stored({ role: 'user', content: '修一下登录' })))).toBe(
      true,
    )
  })

  it('does not let an auto-resume close the task it was resuming', () => {
    const replayed = collapseCompletedTurns([
      toAgentMessage(stored({ role: 'user', content: '五项 UI 改造', id: 'u1' })),
      toAgentMessage(stored({ role: 'assistant', content: 'done' })),
      toAgentMessage(stored({ role: 'user', content: CONTINUE, control: true, id: 'u2' })),
    ])
    // One open task: the resume prompt continues it instead of opening a second
    // one that would demote the real request to closed work.
    expect(replayed.collapsedTurns).toBe(0)
    expect(replayed.messages[0]?.content).toContain('五项 UI 改造')
  })
})