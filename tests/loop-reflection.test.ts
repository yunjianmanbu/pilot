import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolDefinition, ToolCall } from '../src/shared/types'
import { applyComparison, formatToolFailures, reflectionTranscript } from '../src/main/agent/evolution'
import type { ProfileComparison, ProfileReview, Session } from '../src/shared/types'
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

const tools = [
  tool('read_file', 'read'),
  tool('run_command', 'exec'),
]

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

function messagesFor(request: ModelRequest): string {
  return request.messages.map((message) => message.content).join('\n')
}

describe('in-run reflection on tool failures', () => {
  it('injects a reflection prompt with the actual errors after repeated failures', async () => {
    const model = scripted([
      response('', [
        call('r1', 'read_file', { path: 'a.ts' }),
        call('r2', 'read_file', { path: 'b.ts' }),
      ]),
      response('done'),
    ])

    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read two files' }],
      tools,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async ({ call: current }) => ({
        ok: false,
        output: '',
        error: `ENOENT: ${String(current.arguments['path'])}`,
      }),
    })

    expect(result.status).toBe('completed')
    expect(model.requests).toHaveLength(2)
    const second = messagesFor(model.requests[1]!)
    expect(second).toContain('[运行反思]')
    expect(second).toContain('ENOENT: a.ts')
    expect(second).toContain('ENOENT: b.ts')
    expect(second).toContain('根因假设')
  })

  it('forwards failing command output to the model instead of only the exit code', async () => {
    const model = scripted([
      response('', [call('x1', 'run_command', { command: 'pnpm test' })]),
      response('done'),
    ])

    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'run tests' }],
      tools,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({
        ok: false,
        output: 'FAIL src/a.test.ts: expected 1 to be 2',
        error: 'Command failed with exit code 1',
      }),
    })

    expect(result.status).toBe('completed')
    const toolMessages = result.produced.filter(
      (message): message is AgentMessage & { role: 'tool' } => message.role === 'tool',
    )
    expect(toolMessages[0]?.content).toContain('ERROR: Command failed with exit code 1')
    expect(toolMessages[0]?.content).toContain('FAIL src/a.test.ts: expected 1 to be 2')
    expect(toolMessages[0]?.isError).toBe(true)
    expect(messagesFor(model.requests[1]!)).toContain('FAIL src/a.test.ts')
  })

  it('does not reflect after a single isolated failure', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'missing.ts' })]),
      response('done'),
    ])

    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read a file' }],
      tools,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: false, output: '', error: 'ENOENT: missing.ts' }),
    })

    expect(result.status).toBe('completed')
    expect(messagesFor(model.requests[1]!)).not.toContain('[运行反思]')
  })

  it('stops re-running an identical failing read and tells the model to change approach', async () => {
    const args = { path: 'missing.ts' }
    const model = scripted([
      response('', [call('c1', 'read_file', args)]),
      response('', [call('c2', 'read_file', args)]),
      response('', [call('c3', 'read_file', args)]),
      response('done'),
    ])
    let executions = 0

    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read the file' }],
      tools,
      maxSteps: 8,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => {
        executions += 1
        return { ok: false, output: '', error: 'ENOENT: missing.ts' }
      },
    })

    expect(result.status).toBe('completed')
    expect(executions).toBe(2)
    const toolMessages = result.produced.filter(
      (message): message is AgentMessage & { role: 'tool' } => message.role === 'tool',
    )
    expect(toolMessages).toHaveLength(3)
    expect(toolMessages[2]?.content).toContain('本次不再重复执行')
    expect(toolMessages[2]?.content).toContain('[运行反思]')
    expect(messagesFor(model.requests[2]!)).toContain('[运行反思]')
  })

  it('keeps retrying identical commands because the same test can legitimately fail again', async () => {
    const args = { command: 'pnpm test' }
    const model = scripted([
      response('', [call('e1', 'run_command', args)]),
      response('', [call('e2', 'run_command', args)]),
      response('', [call('e3', 'run_command', args)]),
      response('done'),
    ])
    let executions = 0

    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'run tests' }],
      tools,
      maxSteps: 8,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => {
        executions += 1
        return { ok: false, output: '', error: '1 test failed' }
      },
    })

    expect(result.status).toBe('completed')
    expect(executions).toBe(3)
    expect(messagesFor(model.requests[1]!)).toContain('[运行反思]')
  })

  it('caps the number of reflection prompts per run', async () => {
    const model = scripted([
      response('', [call('a1', 'read_file', { path: 'a' }), call('a2', 'read_file', { path: 'b' })]),
      response('', [call('b1', 'read_file', { path: 'c' }), call('b2', 'read_file', { path: 'd' })]),
      response('', [call('d1', 'read_file', { path: 'e' }), call('d2', 'read_file', { path: 'f' })]),
      response('done'),
    ])

    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read files' }],
      tools,
      maxSteps: 10,
      verificationGate: false,
      maxReflections: 1,
      policy: () => 'auto',
      executeTool: async () => ({ ok: false, output: '', error: 'not found' }),
    })

    // The injected message stays in the transcript, so count false→true
    // transitions instead of raw occurrences.
    let injections = 0
    let seen = false
    for (const request of model.requests) {
      const has = messagesFor(request).includes('[运行反思]')
      if (has && !seen) injections += 1
      seen = has
    }
    expect(injections).toBe(1)
  })
})

describe('cost folded into the review record', () => {
  const review: ProfileReview = {
    score: 91,
    pass: true,
    notes: 'rules read well',
    risks: [],
    at: '2026-01-01T00:00:00.000Z',
    model: 'reviewer-model',
    independent: true,
  }

  const comparison = (verdict: ProfileComparison['verdict']): ProfileComparison => ({
    verdict,
    tasks: 3,
    wins: 2,
    losses: 0,
    ties: 1,
    current: { successRate: 0.3, avgSteps: 6, avgTokens: 1_000, avgMs: 1_000 },
    candidate: { successRate: 0.9, avgSteps: 6, avgTokens: 2_900, avgMs: 3_500 },
    reasons: ['实测结论'],
    at: '2026-01-01T00:00:00.000Z',
  })

  it('quotes the measured cost so the card is not only about scores', () => {
    const folded = applyComparison(review, comparison('inconclusive'))
    expect(folded.notes).toContain('成本/时长')
    expect(folded.notes).toContain('2.9 倍')
    expect(folded.risks).toContain('成本或时长明显上升')
  })

  it('keeps a clear win free of cost risk even when it is more expensive', () => {
    const folded = applyComparison(review, comparison('better'))
    expect(folded.pass).toBe(true)
    expect(folded.risks).not.toContain('成本或时长明显上升')
  })
})

describe('reflection evidence digest', () => {
  it('formats failed tool messages and strips the ERROR prefix', () => {
    const digest = formatToolFailures([
      { role: 'assistant', content: 'trying' },
      { role: 'tool', name: 'run_command', content: 'ERROR: exit code 1', isError: true },
      { role: 'tool', name: 'read_file', content: 'ok' },
      { role: 'tool', name: 'read_file', content: 'ERROR: ENOENT: nope.ts', isError: true },
      { role: 'tool', name: 'run_shell', content: 'ERROR: failed with sk-abcdefghijklmnop', isError: true },
    ])

    expect(digest).toContain('1. run_command → exit code 1')
    expect(digest).toContain('2. read_file → ENOENT: nope.ts')
    expect(digest).toContain('3. run_shell → failed with <redacted>')
    expect(digest).not.toContain('ok')
    expect(digest).not.toContain('sk-abcdefghijklmnop')
  })
})

describe('reflection transcript attribution', () => {
  it('does not present a loop-written reminder as a user request', () => {
    const session = {
      messages: [
        { role: 'user', content: '修一下登录按钮' },
        { role: 'user', content: '[运行反思] 先暂停执行，复盘后再继续。', internal: true },
        { role: 'assistant', content: '好的，先看登录页。' },
      ],
    } as unknown as Session

    const transcript = reflectionTranscript(session)
    expect(transcript).toContain('USER: 修一下登录按钮')
    expect(transcript).toContain('INTERNAL: [运行反思]')
    expect(transcript).not.toContain('USER: [运行反思]')
  })
})
