import { describe, expect, it } from 'vitest'
import type { Plan, StoredMessage } from '../src/shared/types'
import { buildTranscript, processParts, recentProcessParts } from '../src/renderer/src/ui'

function plan(): Plan {
  return {
    goal: '修复登录',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [
      { id: 'plan-1', text: '定位问题', status: 'done' },
      { id: 'plan-2', text: '补充测试', status: 'pending' },
    ],
  }
}

function assistant(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: '已完成。',
    createdAt: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    ...overrides,
  }
}

describe('execution process window', () => {
  function longRun(): ReturnType<typeof buildTranscript> {
    const toolCalls = Array.from({ length: 4 }, (_, index) => ({
      id: `call-${index}`,
      name: 'read_file',
      arguments: { path: `f${index}.ts` },
    }))
    return buildTranscript([
      assistant({ id: 'a1', content: '', reasoning: '先看目录', toolCalls: toolCalls.slice(0, 2) }),
      assistant({ id: 'a2', content: '继续读文件', reasoning: '再看实现', toolCalls: toolCalls.slice(2) }),
    ])
  }

  it('keeps reasoning, notes and tool calls in one chronological order', () => {
    const process = longRun().find((block) => block.kind === 'process')
    if (!process || process.kind !== 'process') throw new Error('missing process block')
    expect(processParts(process).map((part) => part.kind)).toEqual([
      'reasoning',
      'tool',
      'tool',
      'reasoning',
      'note',
      'tool',
      'tool',
    ])
  })

  it('collapses to the five newest steps and reports how many were hidden', () => {
    const process = longRun().find((block) => block.kind === 'process')
    if (!process || process.kind !== 'process') throw new Error('missing process block')
    const { parts, hidden } = recentProcessParts(process, 5)
    expect(hidden).toBe(2)
    expect(parts).toHaveLength(5)
    expect(parts.map((part) => part.key)).toEqual(
      processParts(process).slice(-5).map((part) => part.key),
    )
  })

  it('shows everything when the run has fewer steps than the window', () => {
    const blocks = buildTranscript([
      assistant({
        id: 'short',
        content: '',
        toolCalls: [{ id: 'only-call', name: 'git_status', arguments: {} }],
      }),
    ])
    const process = blocks.find((block) => block.kind === 'process')
    if (!process || process.kind !== 'process') throw new Error('missing process block')
    const { parts, hidden } = recentProcessParts(process, 5)
    expect(hidden).toBe(0)
    expect(parts).toHaveLength(1)
  })
})

describe('buildTranscript plan snapshots', () => {
  it('carries the turn plan through to the rendered assistant answer', () => {
    const blocks = buildTranscript([assistant({ plan: plan() })])
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    expect(block?.kind).toBe('assistant')
    expect(block?.kind === 'assistant' ? block.plan?.goal : undefined).toBe('修复登录')
  })

  it('leaves answers without a plan unchanged', () => {
    const blocks = buildTranscript([assistant()])
    expect(blocks[0]?.kind).toBe('assistant')
    expect(blocks[0]?.kind === 'assistant' ? blocks[0].plan : null).toBeUndefined()
  })

  it('does not attach the plan to the collapsed process block', () => {
    const blocks = buildTranscript([
      assistant({
        id: 'tool-turn',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
        plan: plan(),
      }),
      assistant({ id: 'answer', content: '完成', plan: plan() }),
    ])
    const process = blocks.find((block) => block.kind === 'process')
    const answer = blocks.find((block) => block.kind === 'assistant')
    expect(process ? Object.hasOwn(process, 'plan') : false).toBe(false)
    expect(answer?.kind === 'assistant' ? answer.plan?.items.length : undefined).toBe(2)
  })
})
