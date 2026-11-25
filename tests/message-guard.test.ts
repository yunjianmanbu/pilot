import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, ToolCall } from '../src/shared/types'
import {
  MISSING_TOOL_RESULT_TEXT,
  isEmptyAssistant,
  pairToolResults,
} from '../src/main/agent/message-guard'
import { DeepSeekClient, ModelError, isFatalProviderError } from '../src/main/agent/model'

afterEach(() => {
  vi.unstubAllGlobals()
})

function call(id: string, name = 'read_file'): ToolCall {
  return { id, name, arguments: { path: 'src/a.ts' } }
}

function assistantWith(calls: ToolCall[], content = ''): AgentMessage {
  return { role: 'assistant', content, toolCalls: calls }
}

function toolResult(id: string): AgentMessage {
  return { role: 'tool', toolCallId: id, name: 'read_file', content: 'ok' }
}

/** Every tool call id in the transcript, in order, once per assistant turn. */
function requestedIds(messages: AgentMessage[]): string[] {
  return messages.flatMap((message) => (message.toolCalls ?? []).map((entry) => entry.id))
}

function answeredIds(messages: AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'tool' && message.toolCallId)
    .map((message) => message.toolCallId as string)
}

describe('pairToolResults', () => {
  it('leaves a correctly paired history untouched', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'read it' },
      assistantWith([call('a1'), call('a2')]),
      toolResult('a1'),
      toolResult('a2'),
    ]
    const result = pairToolResults(history)
    expect(result.patched).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.messages).toBe(history)
  })

  it('adds a synthetic error result after compaction kept the call but cut the result', () => {
    // What compaction produces: the assistant turn survives, one of its two
    // results is rewritten away, so the request would be rejected with 400.
    const compacted: AgentMessage[] = [
      { role: 'user', content: 'read both' },
      assistantWith([call('a1'), call('a2')]),
      toolResult('a2'),
    ]
    const result = pairToolResults(compacted)
    expect(result.patched).toBe(1)
    expect(result.dropped).toBe(0)
    expect(answeredIds(result.messages).sort()).toEqual(['a1', 'a2'])
    const injected = result.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'a1',
    )
    expect(injected?.content).toBe(MISSING_TOOL_RESULT_TEXT)
    expect(injected?.isError).toBe(true)
    // The repair is not allowed to mutate the stored history.
    expect(answeredIds(compacted)).toEqual(['a2'])
  })

  it('moves a real result back in front of the message that displaced it', () => {
    // Compaction kept the result but pushed it behind a later user message. The
    // id is answered, so an "answered at all" check passes, yet the provider
    // still rejects the request. The real output must survive the repair.
    const displaced: AgentMessage[] = [
      { role: 'user', content: 'read it' },
      assistantWith([call('e1')]),
      { role: 'user', content: '继续' },
      { role: 'tool', toolCallId: 'e1', name: 'read_file', content: 'real output' },
    ]
    const result = pairToolResults(displaced)
    expect(result.patched).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ])
    expect(result.messages[2]?.content).toBe('real output')
  })

  it('moves a displaced result past a second assistant turn', () => {
    const displaced: AgentMessage[] = [
      assistantWith([call('f1')]),
      assistantWith([call('f2')]),
      toolResult('f2'),
      toolResult('f1'),
    ]
    const result = pairToolResults(displaced)
    expect(result.patched).toBe(0)
    expect(result.messages.map((message) => message.toolCallId)).toEqual([
      undefined,
      'f1',
      undefined,
      'f2',
    ])
  })

  it('pairs an interrupted run that persisted the calls and no results', () => {    const interrupted: AgentMessage[] = [
      { role: 'user', content: 'do three things' },
      assistantWith([call('b1'), call('b2'), call('b3')]),
      { role: 'user', content: '从上次中断的地方继续完成当前任务' },
    ]
    const result = pairToolResults(interrupted)
    expect(result.patched).toBe(3)
    expect(answeredIds(result.messages)).toEqual(['b1', 'b2', 'b3'])
    // Each synthetic result sits between the assistant turn and the next user
    // message: providers require the results to follow the call directly.
    const indexes = ['b1', 'b2', 'b3'].map((id) =>
      result.messages.findIndex((message) => message.toolCallId === id),
    )
    expect(indexes).toEqual([2, 3, 4])
    expect(result.messages[5]?.role).toBe('user')
  })

  it('drops an orphan tool result whose call is gone, and results with no id', () => {
    const orphaned: AgentMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', toolCallId: 'gone', name: 'read_file', content: 'stale' },
      { role: 'tool', name: 'read_file', content: 'no id at all' },
      assistantWith([call('c1')]),
      toolResult('c1'),
    ]
    const result = pairToolResults(orphaned)
    expect(result.dropped).toBe(2)
    expect(result.patched).toBe(0)
    expect(answeredIds(result.messages)).toEqual(['c1'])
  })

  it('still drops an empty assistant turn that a provider would reject', () => {
    const empty: AgentMessage = { role: 'assistant', content: '   ' }
    expect(isEmptyAssistant(empty)).toBe(true)
    const result = pairToolResults([{ role: 'user', content: 'hi' }, empty])
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.role).toBe('user')
  })
})

describe('request body after a broken history', () => {
  function stubFetch() {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
                    'data: [DONE]\n\n',
                ),
              )
              controller.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }),
    )
    return bodies
  }

  it('sends one tool message per tool_call id even when the history lost one', async () => {
    const bodies = stubFetch()
    const client = new DeepSeekClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'glm-5.3',
      maxOutputTokens: 1_024,
      temperature: 0.1,
    })
    await client.complete({
      messages: [
        { role: 'user', content: 'read both' },
        assistantWith([call('d1'), call('d2')]),
        toolResult('d2'),
      ],
      tools: [],
    })
    const sent = (bodies[0]?.messages ?? []) as Array<{
      role: string
      tool_call_id?: string
      tool_calls?: Array<{ id: string }>
    }>
    const requested = sent.flatMap((message) => (message.tool_calls ?? []).map((c) => c.id))
    const answered = sent.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    expect(requested).toEqual(['d1', 'd2'])
    expect([...answered].sort()).toEqual(['d1', 'd2'])
  })
})

describe('isFatalProviderError', () => {
  it('treats key, balance and model-permission failures as fatal', () => {
    expect(isFatalProviderError(new ModelError('x', 401))).toBe(true)
    expect(isFatalProviderError(new ModelError('x', 402))).toBe(true)
    expect(isFatalProviderError(new ModelError('x', 403))).toBe(true)
    expect(
      isFatalProviderError('Qwen request failed (403): Access to model denied for this account'),
    ).toBe(true)
    expect(isFatalProviderError('glm reports insufficient balance (402)')).toBe(true)
    expect(isFatalProviderError('DeepSeek request failed (400): model does not exist')).toBe(true)
  })

  it('leaves retryable failures alone', () => {
    expect(isFatalProviderError(new ModelError('rate limit', 429))).toBe(false)
    expect(isFatalProviderError(new ModelError('server error', 503))).toBe(false)
    expect(isFatalProviderError(new ModelError('socket closed'))).toBe(false)
    expect(isFatalProviderError(new TypeError('fetch failed'))).toBe(false)
    expect(isFatalProviderError('从上次中断的地方继续')).toBe(false)
    expect(isFatalProviderError(undefined)).toBe(false)
  })
})
