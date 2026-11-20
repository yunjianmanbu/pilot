import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolDefinition, ToolCall } from '../src/shared/types'
import { COMPACTED_MARKER } from '../src/main/agent/context'
import {
  runAgentLoop,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../src/main/agent/loop'

function tool(name: string, risk: AgentToolDefinition['risk']): AgentToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    risk,
  }
}

const tools = [tool('read_file', 'read')]

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args }
}

function response(content: string, toolCalls: ToolCall[] = []): ModelResponse {
  return { content, toolCalls, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
}

function scripted(responses: ModelResponse[]): ModelClient & { requests: ModelRequest[] } {
  let index = 0
  const client = {
    requests: [] as ModelRequest[],
    async complete(request: ModelRequest): Promise<ModelResponse> {
      client.requests.push(request)
      const next = responses[index]
      index += 1
      return next ?? response('done')
    },
  }
  return client
}

function history(previousContent: string, isError = false): AgentMessage[] {
  return [
    { role: 'user', content: 'look at a.ts' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [call('old1', 'read_file', { path: 'a.ts' })],
    },
    {
      role: 'tool',
      name: 'read_file',
      toolCallId: 'old1',
      content: previousContent,
      isError,
    },
    { role: 'assistant', content: 'a.ts has two lines' },
    { role: 'user', content: 'check it again' },
  ]
}

function producedToolMessage(
  produced: AgentMessage[],
  toolCallId: string,
): (AgentMessage & { role: 'tool' }) | undefined {
  return produced.find(
    (message): message is AgentMessage & { role: 'tool' } =>
      message.role === 'tool' && message.toolCallId === toolCallId,
  )
}

async function run(previousContent: string, output: string, isError = false) {
  const model = scripted([
    response('', [call('new1', 'read_file', { path: 'a.ts' })]),
    response('done'),
  ])
  let executions = 0
  const result = await runAgentLoop({
    model,
    messages: history(previousContent, isError),
    tools,
    maxSteps: 5,
    verificationGate: false,
    policy: () => 'auto',
    executeTool: async () => {
      executions += 1
      return {
        ok: true,
        output,
        metadata: {},
      }
    },
  })
  return { model, result, executions }
}

describe('same-run read dedupe visibility', () => {
  it('does not point at a read result that already left the working set', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'a.ts' })]),
      response('', [
        call('r2', 'read_file', { path: 'b.ts' }),
        call('r3', 'read_file', { path: 'c.ts' }),
      ]),
      response('', [call('r4', 'read_file', { path: 'a.ts' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read a.ts twice' }],
      tools,
      maxSteps: 6,
      // Two newer tool results push the first read out of the working set, so
      // "use the result above" would point at content that is no longer sent.
      keepRecentToolResults: 2,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async ({ call: current }) => ({ ok: true, output: `${current.id}: a.ts` }),
    })

    const duplicate = producedToolMessage(result.produced, 'r4')
    expect(duplicate?.content).not.toContain('[重复读取已省略]')
    expect(duplicate?.content).toContain('r4: a.ts')
  })

  it('still reuses an identical read while its result is visible', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'a.ts' })]),
      response('', [call('r2', 'read_file', { path: 'a.ts' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read a.ts twice' }],
      tools,
      maxSteps: 6,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async ({ call: current }) => ({ ok: true, output: `${current.id}: a.ts` }),
    })

    expect(producedToolMessage(result.produced, 'r2')?.content).toContain('[重复读取已省略]')
  })
})

describe('cross-run read dedupe', () => {
  it('reuses an earlier identical read instead of sending the same content twice', async () => {
    const content = 'const one = 1\nconst two = 2\n'
    const { model, result, executions } = await run(content, content)

    // The file is still read so the comparison is against the real file system.
    expect(executions).toBe(1)
    const toolMessage = producedToolMessage(result.produced, 'new1')
    expect(toolMessage?.content).toContain('[重复读取已省略]')
    expect(toolMessage?.content).toContain('old1')
    expect(toolMessage?.content).not.toContain('const one = 1')
    expect(model.requests[1]?.messages.map((message) => message.content).join('\n')).toContain(
      '[重复读取已省略]',
    )
  })

  it('returns the fresh output when the file changed between runs', async () => {
    const content = 'const one = 1\n'
    const { result } = await run(content, 'const one = 2\n')

    const toolMessage = producedToolMessage(result.produced, 'new1')
    expect(toolMessage?.content).toContain('const one = 2')
    expect(toolMessage?.content).not.toContain('[重复读取已省略]')
  })

  it('does not reuse a prior result that was already compacted', async () => {
    const content = 'const one = 1\n'
    const { result, executions } = await run(`${COMPACTED_MARKER}\n${content}`, content)

    expect(executions).toBe(1)
    const toolMessage = producedToolMessage(result.produced, 'new1')
    expect(toolMessage?.content).toContain('const one = 1')
    expect(toolMessage?.content).not.toContain('[重复读取已省略]')
  })

  it('does not reuse a prior read that failed', async () => {
    const content = 'const one = 1\n'
    const { result } = await run(content, content, true)

    const toolMessage = producedToolMessage(result.produced, 'new1')
    expect(toolMessage?.content).toContain('const one = 1')
    expect(toolMessage?.content).not.toContain('[重复读取已省略]')
  })
})
