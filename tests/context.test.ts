import { describe, expect, it } from 'vitest'
import {
  compactToolResults,
  COMPACTED_MARKER,
  estimateTokens,
  fitMessages,
  messagesTokens,
  trimMessages,
  truncateMiddle,
} from '../src/main/agent/context'
import type { AgentMessage } from '../src/shared/types'

function toolMessage(content: string): AgentMessage {
  return { role: 'tool', content, toolCallId: 'call-1', name: 'read_file' }
}

describe('token estimation', () => {
  it('charges CJK characters more than ASCII', () => {
    expect(estimateTokens('中文'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)))
  })

  it('counts tool call arguments', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/index.ts' } }],
    }
    expect(estimateTokens('')).toBe(0)
    expect(messagesTokens([message])).toBeGreaterThan(4)
  })
})

describe('compactToolResults', () => {
  it('keeps recent tool results verbatim and elides older ones', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      toolMessage(`result-${index}\n${'x'.repeat(2_000)}`),
    )
    const result = compactToolResults(messages, { keepRecentToolResults: 2 })
    expect(result.compacted).toBe(8)
    expect(result.savedChars).toBeGreaterThan(0)
    const compacted = result.messages[0]!
    expect(compacted.content.startsWith(COMPACTED_MARKER)).toBe(true)
    expect(compacted.content).toContain('result-0')
    expect(result.messages[8]).toBe(messages[8])
    expect(result.messages[9]).toBe(messages[9])
  })

  it('names the source so the model can decide whether to re-read', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } }],
      },
      { ...toolMessage(`old-read\n${'x'.repeat(2_000)}`), toolCallId: 'call-1' },
      ...Array.from({ length: 3 }, (_, index) => toolMessage(`recent-${index}\n${'y'.repeat(2_000)}`)),
    ]
    const result = compactToolResults(messages, { keepRecentToolResults: 1 })
    expect(result.compacted).toBeGreaterThan(0)
    expect(result.messages[1]?.content).toContain('[来源] read_file src/a.ts')
    expect(result.messages[1]?.content).toContain('需要完整内容时请重新读取')
  })

  it('is idempotent for already compacted output', () => {
    const first = compactToolResults(
      Array.from({ length: 4 }, () => toolMessage('y'.repeat(2_000))),
      { keepRecentToolResults: 1 },
    )
    const second = compactToolResults(first.messages, { keepRecentToolResults: 1 })
    expect(second.compacted).toBe(0)
  })
})

describe('trimMessages', () => {
  it('cuts only at user boundaries and carries the original task forward', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'A'.repeat(4_000) },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'B'.repeat(1_000) },
      { role: 'assistant', content: 'second answer' },
    ]
    const result = trimMessages(messages, 800, 1)
    expect(result.droppedMessages).toBe(2)
    expect(result.messages[0]?.role).toBe('system')
    expect(result.messages[1]?.role).toBe('user')
    expect(result.messages[1]?.content).toContain('[原始任务]')
    expect(result.messages[1]?.content).toContain('[当前任务]')
    expect(result.estimatedTokens).toBeLessThanOrEqual(800)
  })

  it('leaves a transcript below budget untouched', () => {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hello' }]
    const result = trimMessages(messages, 10_000)
    expect(result.messages).toBe(messages)
    expect(result.droppedMessages).toBe(0)
  })
})

describe('fitMessages', () => {
  it('compacts before dropping turns', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'task' })
    for (let index = 0; index < 12; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
    }
    messages.push({ role: 'user', content: 'follow up' })
    const before = messagesTokens(messages)
    const fitted = fitMessages(messages, Math.floor(before / 2))
    expect(fitted.compacted).toBeGreaterThan(0)
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(Math.floor(before / 2))
  })

  it('leaves a transcript that already fits verbatim so the prefix keeps hitting', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'task' })
    for (let index = 0; index < 12; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
    }
    const fitted = fitMessages(messages, messagesTokens(messages) * 2)
    expect(fitted.compacted).toBe(0)
    expect(fitted.messages).toBe(messages)
    expect(fitted.droppedMessages).toBe(0)
  })

  it('treats compactAbove: 0 as the old compact-on-every-step behaviour', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'task' })
    for (let index = 0; index < 12; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
    }
    const fitted = fitMessages(messages, messagesTokens(messages) * 2, { compactAbove: 0 })
    expect(fitted.compacted).toBeGreaterThan(0)
  })
})

describe('truncateMiddle', () => {
  it('keeps both the head and the failure-bearing tail', () => {
    const text = `HEAD${'m'.repeat(2_000)}TAIL`
    const result = truncateMiddle(text, 500)
    expect(result.startsWith('HEAD')).toBe(true)
    expect(result.endsWith('TAIL')).toBe(true)
    expect(result).toContain('已截断')
  })

  it('returns short text unchanged', () => {
    expect(truncateMiddle('short', 100)).toBe('short')
  })
})
