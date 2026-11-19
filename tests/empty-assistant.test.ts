import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekClient } from '../src/main/agent/model'
import {
  runAgentLoop,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../src/main/agent/loop'
import type { AgentMessage, AgentToolDefinition } from '../src/shared/types'

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

function okStream(content = 'ok'): Response {
  return sseResponse([
    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}},"finish_reason":"stop"}]}\n\n`,
    'data: [DONE]\n\n',
  ])
}

function client(): DeepSeekClient {
  return new DeepSeekClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    model: 'glm-5.3',
    maxOutputTokens: 8_192,
    temperature: 0.1,
  })
}

async function capturedMessages(messages: AgentMessage[]): Promise<unknown[]> {
  const bodies: Array<{ messages: unknown[] }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return okStream()
    }),
  )
  await client().complete({ messages, tools: [] })
  return bodies[0]?.messages ?? []
}

describe('empty assistant messages', () => {
  it('are never sent to the provider', async () => {
    // A reasoning-only turn used to be persisted as content: '' and then sent
    // as {"role":"assistant","content":null}, which DeepSeek rejects with
    // "Invalid assistant message: content, tool_calls or reasoning_content
    // must be set" — poisoning every later turn of that session.
    const sent = (await capturedMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', reasoning: 'only thinking' },
      { role: 'user', content: 'continue' },
    ])) as Array<Record<string, unknown>>

    expect(sent).toHaveLength(3)
    expect(sent.some((message) => message['role'] === 'assistant')).toBe(false)
  })

  it('drop the tool result that was attached to them', async () => {
    const sent = (await capturedMessages([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphan output', toolCallId: 'call-1' },
    ])) as Array<Record<string, unknown>>

    expect(sent).toHaveLength(1)
    expect(sent[0]?.['role']).toBe('user')
  })

  it('keep a tool result whose assistant turn is still sent', async () => {
    const sent = (await capturedMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: {} }],
      },
      { role: 'tool', content: 'file body', toolCallId: 'call-1' },
    ])) as Array<Record<string, unknown>>

    expect(sent).toHaveLength(3)
    expect(sent[2]?.['role']).toBe('tool')
  })

  it('are not written into the run history by the agent loop', async () => {
    const responses: ModelResponse[] = [
      { content: '', toolCalls: [], reasoning: 'reasoning only' },
      { content: 'done', toolCalls: [] },
    ]
    let index = 0
    const model: ModelClient = {
      async complete(_request: ModelRequest): Promise<ModelResponse> {
        const next = responses[index]
        index += 1
        return next ?? { content: 'done', toolCalls: [] }
      },
    }
    const tool: AgentToolDefinition = {
      name: 'read_file',
      description: 'read_file',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
    }
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'do it' }],
      tools: [tool],
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const emptyAssistant = result.produced.filter(
      (message) =>
        message.role === 'assistant' &&
        !message.content.trim() &&
        (message.toolCalls?.length ?? 0) === 0,
    )
    expect(emptyAssistant).toHaveLength(0)
  })

  it('ask once more instead of ending the run with an empty answer', async () => {
    const responses: ModelResponse[] = [
      { content: '', toolCalls: [], reasoning: 'reasoning only' },
      { content: 'the answer', toolCalls: [] },
    ]
    const requests: ModelRequest[] = []
    let index = 0
    const model: ModelClient = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request)
        const next = responses[index]
        index += 1
        return next ?? { content: 'the answer', toolCalls: [] }
      },
    }
    const tool: AgentToolDefinition = {
      name: 'read_file',
      description: 'read_file',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
    }
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'do it' }],
      tools: [tool],
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(requests).toHaveLength(2)
    expect(
      requests[1]?.messages.some((message) => message.content.includes('no visible text')),
    ).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.content).toBe('the answer')
  })
})
