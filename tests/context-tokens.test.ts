import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../src/shared/types'
import { estimateTokens, messageTokens, transcriptUsage } from '../src/renderer/src/tokens'

describe('renderer token estimate', () => {
  it('counts ASCII and CJK separately without any model call', () => {
    expect(estimateTokens('')).toBe(0)
    // 36 ASCII characters at 3.6 chars per token.
    expect(estimateTokens('a'.repeat(36))).toBe(10)
    // CJK is close to one token per character, weighted slightly above one.
    expect(estimateTokens('中文')).toBe(3)
  })

  it('includes tool calls in a message estimate', () => {
    const withCall: AgentMessage = {
      role: 'assistant',
      content: 'Reading',
      toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'src/app.ts' } }],
    }
    expect(messageTokens(withCall)).toBeGreaterThan(messageTokens({ role: 'assistant', content: 'Reading' }))
  })

  it('sums the transcript and the answer still streaming', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Fix the login bug' },
      { role: 'assistant', content: 'Checking the router' },
    ]
    const settled = transcriptUsage(messages)
    const streaming = transcriptUsage(messages, 'Now reading src/login.ts')
    expect(settled.messages).toBe(2)
    expect(settled.tokens).toBe(
      estimateTokens('Fix the login bug') +
        estimateTokens('Checking the router') +
        8,
    )
    expect(streaming.tokens).toBe(settled.tokens + estimateTokens('Now reading src/login.ts'))
  })
})
