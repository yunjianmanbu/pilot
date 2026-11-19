import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekClient } from '../src/main/agent/model'

afterEach(() => {
  vi.unstubAllGlobals()
})

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function client(model = 'glm-5.3'): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    model,
    maxOutputTokens: 8_192,
    temperature: 0.1,
  })
}

describe('model streaming', () => {
  it('parses CRLF-separated SSE events and streams reasoning deltas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\r\n\r\n',
          'data: {"choices":[{"delta":{"content":"{\\"score\\":88}"},"finish_reason":"stop"}]}\r\n\r\n',
          'data: [DONE]\r\n\r\n',
        ]),
      ),
    )
    const reasoning: string[] = []
    const text: string[] = []
    const response = await client().complete({
      messages: [{ role: 'user', content: 'grade this' }],
      tools: [],
      onReasoningDelta: (delta) => {
        reasoning.push(delta)
      },
      onTextDelta: (delta) => {
        text.push(delta)
      },
    })
    expect(reasoning).toEqual(['thinking'])
    expect(text).toEqual(['{"score":88}'])
    expect(response.content).toBe('{"score":88}')
    expect(response.reasoning).toBe('thinking')
  })

  it('accepts the reasoning alias used by some providers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    )
    const reasoning: string[] = []
    const response = await client('qwen3.8-max').complete({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onReasoningDelta: (delta) => {
        reasoning.push(delta)
      },
    })
    expect(reasoning).toEqual(['pondering'])
    expect(response.content).toBe('ok')
  })
})
