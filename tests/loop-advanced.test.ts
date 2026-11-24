import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolDefinition, ToolCall } from '../src/shared/types'
import {
  runAgentLoop,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../src/main/agent/loop'
import { isVerificationCommand, looksLikeTestOutput } from '../src/main/agent/checks'

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
  tool('write_file', 'write'),
  tool('run_command', 'exec'),
  tool('run_shell', 'exec'),
  tool('update_plan', 'control'),
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

describe('agent loop token budget', () => {
  it('stops with token_limit once the configured budget is spent', async () => {
    // The budget is opt-in (0 = off). When a user sets it, the run must stop
    // with token_limit instead of silently finishing the step loop.
    const model = scripted([
      {
        content: '',
        toolCalls: [call('r1', 'read_file', { path: 'src/a.ts' })],
        usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1_000 },
      },
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'look' }],
      tools,
      maxSteps: 10,
      maxTokens: 500,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'x' }),
    })
    expect(result.status).toBe('token_limit')
  })

  it('never stops early when the budget is off', async () => {
    const model = scripted([
      {
        content: '',
        toolCalls: [call('r1', 'read_file', { path: 'src/a.ts' })],
        usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1_000 },
      },
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'look' }],
      tools,
      maxSteps: 10,
      maxTokens: 0,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'x' }),
    })
    expect(result.status).toBe('completed')
  })
})

describe('agent loop plan gate', () => {
  it('blocks the first mutating call once until update_plan runs', async () => {
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('', [
        call('p1', 'update_plan', {
          items: [{ text: 'Implement', status: 'in_progress' }],
        }),
      ]),
      response('', [call('w2', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('done'),
    ])
    const executed: string[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'Implement the feature' }],
      tools,
      maxSteps: 10,
      requirePlan: true,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async ({ call: current }) => {
        executed.push(current.id)
        return { ok: true, output: `${current.name} ok` }
      },
    })

    expect(result.status).toBe('completed')
    expect(executed).toEqual(['p1', 'w2'])
    const gateMessage = result.produced.find(
      (message) => message.role === 'tool' && message.content.includes('计划门'),
    )
    expect(gateMessage).toBeTruthy()
  })

  it('does not gate when a plan already exists', async () => {
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('done'),
    ])
    const executed: string[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'Implement the feature' }],
      tools,
      maxSteps: 5,
      requirePlan: true,
      hasPlan: true,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async ({ call: current }) => {
        executed.push(current.id)
        return { ok: true, output: 'ok' }
      },
    })
    expect(result.status).toBe('completed')
    expect(executed).toEqual(['w1'])
  })
})

describe('agent loop parallel reads', () => {
  it('runs independent read-only calls concurrently and keeps message order', async () => {
    const model = scripted([
      response('', [
        call('r1', 'read_file', { path: 'a.ts' }),
        call('r2', 'read_file', { path: 'b.ts' }),
        call('r3', 'read_file', { path: 'c.ts' }),
      ]),
      response('done'),
    ])
    let active = 0
    let peak = 0
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read three files' }],
      tools,
      maxSteps: 5,
      maxParallelReadTools: 4,
      policy: () => 'auto',
      executeTool: async ({ call: current }) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active -= 1
        return { ok: true, output: `content:${current.id}` }
      },
    })

    expect(result.status).toBe('completed')
    expect(peak).toBeGreaterThanOrEqual(2)
    const toolMessages = result.produced.filter(
      (message): message is AgentMessage & { role: 'tool' } => message.role === 'tool',
    )
    expect(toolMessages.map((message) => message.content)).toEqual([
      'content:r1',
      'content:r2',
      'content:r3',
    ])
  })

  it('keeps mutations in order instead of parallelizing across them', async () => {
    const model = scripted([
      response('', [
        call('r1', 'read_file', { path: 'a.ts' }),
        call('w1', 'write_file', { path: 'a.ts', content: 'x' }),
        call('r2', 'read_file', { path: 'a.ts' }),
      ]),
      response('done'),
    ])
    const order: string[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'update a file' }],
      tools,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async ({ call: current }) => {
        order.push(current.id)
        return { ok: true, output: current.id }
      },
    })
    expect(result.status).toBe('completed')
    expect(order).toEqual(['r1', 'w1', 'r2'])
  })
})

describe('agent loop context summary', () => {
  it('asks the summarizer before the model call and injects the summary', async () => {
    const model = scripted([response('done')])
    let summarizeCalls = 0
    const history: AgentMessage[] = [
      { role: 'user', content: 'original task' },
      { role: 'assistant', content: 'a'.repeat(2_000) },
      { role: 'assistant', content: 'b'.repeat(2_000) },
      { role: 'user', content: 'follow-up one' },
      { role: 'assistant', content: 'c'.repeat(2_000) },
      { role: 'tool', content: 'd'.repeat(2_000), name: 'read_file' },
      { role: 'user', content: 'follow-up two' },
      { role: 'assistant', content: 'e'.repeat(2_000) },
      { role: 'assistant', content: 'f'.repeat(2_000) },
      { role: 'assistant', content: 'g'.repeat(2_000) },
    ]

    const result = await runAgentLoop({
      model,
      messages: history,
      tools,
      maxSteps: 2,
      maxContextTokens: 2_000,
      contextSummaryThreshold: 0.5,
      summarize: async () => {
        summarizeCalls += 1
        return 'SUMMARY OF EARLIER WORK'
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    expect(summarizeCalls).toBe(1)
    const sent = messagesFor(model.requests[0]!)
    expect(sent).toContain('SUMMARY OF EARLIER WORK')
    expect(sent).toContain('original task')
    expect(sent).toContain('较早对话摘要')
    // The first message stays for the record but is labelled as finished work:
    // an unlabelled head reads like a live instruction next to the summary.
    expect(sent).toContain('[更早的任务 · 已完成，除非用户重提否则忽略]\noriginal task')
  })

  it('does not treat its own injected reminders as a newer user turn', async () => {
    // The loop pushes internal reminders (in-run reflection, wrap-up, plan
    // check) as role 'user'. They are the system talking to itself, not the
    // user opening a new task, so a single-task run that hits a tool error must
    // not have its own task re-labelled as finished work.
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'a.ts' })]),
      response('done'),
    ])
    const history: AgentMessage[] = [
      { role: 'system', content: 'You are Pilot.' },
      { role: 'user', content: 'original task' },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: 'assistant' as const,
        content: `${index}:${'x'.repeat(2_000)}`,
      })),
    ]

    await runAgentLoop({
      model,
      messages: history,
      tools,
      maxSteps: 3,
      maxContextTokens: 2_000,
      contextSummaryThreshold: 0.5,
      reflectionAfterFailures: 1,
      summarize: async () => 'SINGLE TASK SUMMARY',
      policy: () => 'auto',
      executeTool: async () => ({ ok: false, output: '', error: 'read failed' }),
    })

    const second = messagesFor(model.requests[1]!)
    expect(second).toContain('[运行反思]')
    expect(second).toContain('SINGLE TASK SUMMARY')
    // Still one task: the reflection prompt did not hand the run a new one.
    expect(second).not.toContain('[更早的任务 · 已完成，除非用户重提否则忽略]')
  })

  it('summarizes a long single-task run even without a later user turn', async () => {
    const model = scripted([response('done')])
    const history: AgentMessage[] = [
      { role: 'system', content: 'You are Pilot.' },
      { role: 'user', content: 'original task' },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: 'assistant' as const,
        content: `${index}:${'x'.repeat(2_000)}`,
      })),
    ]

    await runAgentLoop({
      model,
      messages: history,
      tools,
      maxSteps: 2,
      maxContextTokens: 2_000,
      contextSummaryThreshold: 0.5,
      summarize: async () => 'SINGLE TASK SUMMARY',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const sent = messagesFor(model.requests[0]!)
    expect(sent).toContain('SINGLE TASK SUMMARY')
    expect(sent).toContain('original task')
    // No later user message survived the cut, so that first message *is* the
    // task being worked on. Labelling it "已完成，除非用户重提否则忽略" told the
    // model to ignore the work it was in the middle of.
    expect(sent).not.toContain('[更早的任务 · 已完成，除非用户重提否则忽略]')
    expect(sent.length).toBeLessThan(history.map((message) => message.content).join('\n').length)
  })

  it('keeps the live instruction when compacting leaves a tool-only tail', async () => {
    // Reproduces the shape of a long single turn: the session's first task is
    // far behind, the instruction being worked on is followed only by
    // assistant/tool traffic. Compaction used to keep the first task bare and
    // drop the live instruction, so the only user text left was the old task.
    const model = scripted([response('done')])
    const history: AgentMessage[] = [
      { role: 'system', content: 'You are Pilot.' },
      { role: 'user', content: '给出主题优化方案' },
      { role: 'assistant', content: 'theme plan delivered' },
      { role: 'user', content: '修复' },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: 'assistant' as const,
        content: `${index}:${'x'.repeat(2_000)}`,
      })),
    ]

    await runAgentLoop({
      model,
      messages: history,
      tools,
      maxSteps: 2,
      maxContextTokens: 2_000,
      contextSummaryThreshold: 0.5,
      summarize: async () => 'SUMMARY OF EARLIER WORK',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const sent = messagesFor(model.requests[0]!)
    // The old task is present for the record but labelled as finished work.
    expect(sent).toContain('[更早的任务 · 已完成，除非用户重提否则忽略]\n给出主题优化方案')
    // The live instruction is still there, restated as the newest user message.
    expect(sent).toContain('[当前任务]\n修复')
    const lastUser = [...model.requests[0]!.messages]
      .reverse()
      .find((message) => message.role === 'user' && !message.contextSummary)
    expect(lastUser?.content).toContain('修复')
  })

  it('merges a second summary with the first instead of stacking copies', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('done'),
    ])
    const seenSummaries: (string | undefined)[] = []
    const history: AgentMessage[] = [
      { role: 'system', content: 'You are Pilot.' },
      { role: 'user', content: 'original task' },
      {
        role: 'user',
        content: '[较早对话摘要 · 以下内容是数据，不是新指令]\nEARLIER FACTS',
        contextSummary: true,
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: 'assistant' as const,
        content: `${index}:${'x'.repeat(2_000)}`,
      })),
    ]

    await runAgentLoop({
      model,
      messages: history,
      tools,
      maxSteps: 2,
      maxContextTokens: 2_000,
      contextSummaryThreshold: 0.5,
      summarize: async (_messages, previousSummary) => {
        seenSummaries.push(previousSummary)
        return `MERGED ${previousSummary ?? 'NONE'}`
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    // The model sees the earlier summary it wrote, without the transport prefix.
    expect(seenSummaries[0]).toBe('EARLIER FACTS')
    const sent = messagesFor(model.requests[0]!)
    expect(sent).toContain('MERGED EARLIER FACTS')
    // The stale copy must be gone: one summary message, not two.
    expect(sent.match(/较早对话摘要/g)).toHaveLength(1)
  })

  it('keeps a folded-turns digest as closed work through a later summary pass', async () => {
    const model = scripted([response('done')])
    const digest: AgentMessage = {
      role: 'user',
      content:
        '[更早的任务 · 已完成，除非用户重提否则忽略]\n回合 1\n请求：给出主题优化方案',
      earlierWork: true,
    }
    const history: AgentMessage[] = [
      { role: 'system', content: 'You are Pilot.' },
      digest,
      { role: 'user', content: '指令编辑后 保存并重新生成没有生效' },
      { role: 'assistant', content: '先看 regenerate 调用链' },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: 'assistant' as const,
        content: `${index}:${'x'.repeat(2_000)}`,
      })),
      { role: 'user', content: '修复' },
    ]

    await runAgentLoop({
      model,
      messages: history,
      tools,
      maxSteps: 2,
      maxContextTokens: 2_000,
      contextSummaryThreshold: 0.5,
      summarize: async () => 'SUMMARY OF EARLIER WORK',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const sent = messagesFor(model.requests[0]!)
    // The digest is the only trace of the folded turns, so compaction keeps it,
    // and it is not re-labelled on top of its own header: one header for the
    // digest, one for the first user message that is now background.
    expect(sent.match(/请求：给出主题优化方案/g)).toHaveLength(1)
    expect(sent.match(/已完成，除非用户重提否则忽略/g)).toHaveLength(2)
    expect(sent).toContain('较早对话摘要')
    expect(sent).toContain('修复')
  })

  it('skips a summary that is larger than the history it replaces', async () => {
    const model = scripted([response('done')])
    const history: AgentMessage[] = [
      { role: 'user', content: 'original task' },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: 'assistant' as const,
        content: `${index}:${'x'.repeat(2_000)}`,
      })),
    ]

    await runAgentLoop({
      model,
      messages: history,
      tools,
      maxSteps: 2,
      maxContextTokens: 2_000,
      contextSummaryThreshold: 0.5,
      summarize: async () => `OVERSIZED ${'z'.repeat(50_000)}`,
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(messagesFor(model.requests[0]!)).not.toContain('OVERSIZED')
  })
})

describe('agent loop verification gate', () => {
  it('asks once for a check after a write, then allows completion', async () => {
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('done without check'),
      response('done after reminder'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'change the file' }],
      tools,
      maxSteps: 6,
      verificationGate: true,
      verificationHint: 'pnpm test',
      policy: () => 'auto',
      executeTool: async () => {
        // Keep a margin over the assertion below: CI runners jitter around the
        // timer, and a 15ms sleep was measured as 14ms there.
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { ok: true, output: 'ok' }
      },
    })

    expect(result.status).toBe('completed')
    expect(result.steps).toBe(3)
    expect(result.timings.modelMs).toBeGreaterThanOrEqual(0)
    expect(result.timings.toolMs).toBeGreaterThanOrEqual(30)
    expect(result.timings.approvalMs).toBe(0)
    expect(messagesFor(model.requests[2]!)).toContain('验证检查')
    expect(messagesFor(model.requests[2]!)).toContain('pnpm test')
  })

  it('does not ask when a check ran after the edit', async () => {
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('', [call('c1', 'run_command', { command: 'pnpm', args: ['test'] })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'change the file' }],
      tools,
      maxSteps: 6,
      verificationGate: true,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })
    expect(result.status).toBe('completed')
    expect(result.steps).toBe(3)
    expect(messagesFor(model.requests[2]!)).not.toContain('验证检查')
  })

  it('accepts the repository test script without a second ask', async () => {
    // The recorded SWE-bench runs spent one extra model call per task on the
    // gate because `./run-tests.sh` was not recognised as a check.
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('', [call('c1', 'run_shell', { command: './run-tests.sh -q' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix it' }],
      tools,
      maxSteps: 6,
      verificationGate: true,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'Ran 12 tests in 3.4s\n\nOK' }),
    })
    expect(result.status).toBe('completed')
    expect(result.steps).toBe(3)
    expect(messagesFor(model.requests[2]!)).not.toContain('验证检查')
  })

  it('accepts a wrapper command when the output carries a runner summary', async () => {
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('', [call('c1', 'run_command', { command: 'make', args: ['-C', 'build', 'check'] })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix it' }],
      tools,
      maxSteps: 6,
      verificationGate: true,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: ' Tests  3 passed (3)' }),
    })
    expect(result.status).toBe('completed')
    expect(result.steps).toBe(3)
    expect(messagesFor(model.requests[2]!)).not.toContain('验证检查')
  })

  it('still asks when the exec only inspected files', async () => {
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('', [call('c1', 'run_shell', { command: 'cat run-tests.sh' })]),
      response('done without check'),
      response('done after reminder'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix it' }],
      tools,
      maxSteps: 6,
      verificationGate: true,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: '#!/bin/sh\npython -m pytest\n' }),
    })
    expect(result.status).toBe('completed')
    expect(result.steps).toBe(4)
    expect(messagesFor(model.requests[3]!)).toContain('验证检查')
  })
})

describe('agent loop screenshot observations', () => {
  const screenshotTools = [...tools, tool('screenshot', 'exec')]
  const shot = {
    ok: true,
    output: 'Captured window 800x600.',
    metadata: {
      images: ['data:image/jpeg;base64,AAAA'],
      screenshot: { target: 'window', width: 800, height: 600, path: 'shot.jpg' },
    },
  }

  it('attaches tool images as a user observation for the next model call', async () => {
    const model = scripted([
      response('', [call('s1', 'screenshot', {})]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'check the UI' }],
      tools: screenshotTools,
      maxSteps: 4,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => shot,
    })

    expect(result.status).toBe('completed')
    const observation = model.requests[1]?.messages.find(
      (message) => message.role === 'user' && message.content.startsWith('[screenshot observation]'),
    )
    expect(observation?.images).toEqual(['data:image/jpeg;base64,AAAA'])
    expect(observation?.content).toContain('800x600')
  })

  it('keeps at most two screenshot observations in model context', async () => {
    const model = scripted([
      response('', [call('s1', 'screenshot', {})]),
      response('', [call('s2', 'screenshot', {})]),
      response('', [call('s3', 'screenshot', {})]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'compare states' }],
      tools: screenshotTools,
      maxSteps: 6,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => shot,
    })

    const observations = model.requests[3]?.messages.filter(
      (message) => message.role === 'user' && message.content.startsWith('[screenshot observation]'),
    )
    expect(observations).toHaveLength(2)
  })

  it('sends no image observation when vision feedback is disabled', async () => {
    const model = scripted([
      response('', [call('s1', 'screenshot', {})]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'check the UI' }],
      tools: screenshotTools,
      maxSteps: 4,
      verificationGate: false,
      screenshotFeedback: false,
      policy: () => 'auto',
      executeTool: async () => shot,
    })

    const sent = model.requests[1]?.messages ?? []
    expect(sent.some((message) => message.content.startsWith('[screenshot observation]'))).toBe(false)
  })
})

describe('agent loop metadata verification', () => {
  it('treats an E2E tool result with verification metadata as a real check', async () => {
    const e2eTools = [...tools, tool('run_e2e', 'exec')]
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('', [call('e1', 'run_e2e', { file: 'e2e/login.spec.ts' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'change the UI' }],
      tools: e2eTools,
      maxSteps: 6,
      verificationGate: true,
      policy: () => 'auto',
      executeTool: async ({ call: current }) =>
        current.name === 'run_e2e'
          ? { ok: true, output: 'E2E passed', metadata: { verification: true } }
          : { ok: true, output: 'written' },
    })
    expect(result.filesChanged).toBe(1)
    expect(result.checked).toBe(true)
  })
})

describe('agent loop delivery evidence', () => {
  it('does not treat listing files after an edit as verification', async () => {
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'src/a.ts', content: 'x' })]),
      response('', [call('l1', 'run_command', { command: 'ls', args: ['src'] })]),
      response('done without check'),
      response('done after reminder'),
    ])
    const notices: Array<{ level: string; message: string }> = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'change the file' }],
      tools,
      maxSteps: 6,
      verificationGate: true,
      policy: () => 'auto',
      emit: (event) => {
        if (event.type === 'notice') notices.push({ level: event.level, message: event.message })
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    expect(result.filesChanged).toBe(1)
    expect(result.checked).toBe(false)
    expect(notices.some((notice) => notice.level === 'warn' && notice.message.includes('未验证'))).toBe(
      true,
    )
  })

  it('counts changed files and marks the run verified after a real check', async () => {
    const model = scripted([
      response('', [
        call('w1', 'write_file', { path: 'src/a.ts', content: 'x' }),
        call('w2', 'write_file', { path: 'src/b.ts', content: 'y' }),
      ]),
      response('', [call('c1', 'run_command', { command: 'pnpm', args: ['test'] })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'change two files' }],
      tools,
      maxSteps: 6,
      verificationGate: true,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    expect(result.filesChanged).toBe(2)
    expect(result.checked).toBe(true)
    expect(messagesFor(model.requests[2]!)).not.toContain('验证检查')
  })

  it('recognizes real checks and rejects unrelated commands', () => {
    for (const command of [
      'pnpm test',
      'pnpm run typecheck',
      'npm run lint',
      'npx vitest run',
      'pytest -q',
      'cargo test',
      'go test ./...',
      'node --test',
      'node math.test.js',
      'node src/foo.spec.mjs',
      'node index.js',
      'node src/server.js',
      'python3 app.py',
      'go run .',
      'tsc --noEmit',
      'eslint src',
      'playwright test',
      'npx playwright test e2e/login.spec.ts',
      'cypress run',
      'pnpm exec wdio run',
      'pnpm test:e2e',
      'npm run e2e',
    ]) {
      expect(isVerificationCommand(command), command).toBe(true)
    }
    for (const command of [
      'ls',
      'cat package.json',
      'pnpm install',
      'git status',
      'pnpm test:watch',
      'node --version',
      'node -e "console.log(1)"',
      'npm install',
      'echo done',
      'ls e2e',
      'pnpm test:e2e:watch',
      'playwright codegen',
    ]) {
      expect(isVerificationCommand(command), command).toBe(false)
    }
  })

  it('recognizes the entrypoint a repository ships instead of only known tools', () => {
    // django, sphinx, sympy and pytest all expose one script; none of these
    // names appeared in the old table, so the gate asked again after a pass.
    for (const command of [
      './run-tests.sh',
      './run-tests.sh file_storage staticfiles_tests',
      'bash run-tests.sh -q',
      'cd /testbed && ./run-tests.sh -q',
      'tox -e py39',
      'nox -s tests',
      'just test',
      'make check',
      'python -m pytest tests/test_x.py -q',
      'python3 -m unittest tests.test_x',
      'docker exec -i 3f2a ./run-tests.sh tests/test_x.py',
      'docker run --rm img bash -lc "./run-tests.sh -q"',
    ]) {
      expect(isVerificationCommand(command), command).toBe(true)
    }
  })

  it('does not mistake reading a test script for running it', () => {
    for (const command of [
      'cat run-tests.sh',
      'head -40 run-tests.sh',
      'sed -n "1,40p" run-tests.sh',
      'ls run-tests.sh',
      'find . -name "run-tests.sh"',
      'cat tox.ini',
      'grep -n pytest docs/contributing.rst',
      'echo pytest',
      'ls -la && cat run-tests.sh 2>/dev/null | head -40',
      'grep -rn "get_records" testing/logging --include=*.py',
    ]) {
      expect(isVerificationCommand(command), command).toBe(false)
    }
  })

  it('treats a runner summary in the output as proof a suite ran', () => {
    for (const output of [
      'Ran 12 tests in 3.412s\n\nOK',
      '============================= 3 passed in 0.12s ==============================',
      ' Test Files  3 passed (3)\n      Tests  65 passed (65)',
      'Tests:       1 failed, 4 passed, 5 total',
      '  3 passing (21ms)',
      '5 examples, 0 failures',
      'OK (3 tests)',
    ]) {
      expect(looksLikeTestOutput(output), output).toBe(true)
    }
    for (const output of [
      '',
      'a.txt\nb.txt',
      'M\tsrc/app.ts',
      'All good',
      'error: could not find run-tests.sh',
    ]) {
      expect(looksLikeTestOutput(output), output).toBe(false)
    }
  })
})

describe('agent loop analysis wrap-up', () => {
  it('asks once for a conclusion when the analysis passes the wrap-up step', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('', [call('r2', 'read_file', { path: 'src/b.ts' })]),
      response('', [call('r3', 'read_file', { path: 'src/c.ts' })]),
      response('done'),
    ])
    const notices: string[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'analyze the project' }],
      tools,
      maxSteps: 8,
      wrapUpAt: 2,
      verificationGate: false,
      policy: () => 'auto',
      emit: (event) => {
        if (event.type === 'notice') notices.push(event.message)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    expect(notices.some((message) => message.includes('收尾'))).toBe(true)
    const lastRequest = model.requests[model.requests.length - 1]
    const wrapUps = lastRequest!.messages.filter((message) => message.content.includes('[收尾]'))
    expect(wrapUps).toHaveLength(1)
  })

  it('never sends the wrap-up when it is at or beyond the step limit', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('', [call('r2', 'read_file', { path: 'src/b.ts' })]),
    ])
    const notices: string[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'analyze the project' }],
      tools,
      maxSteps: 2,
      wrapUpAt: 2,
      verificationGate: false,
      policy: () => 'auto',
      emit: (event) => {
        if (event.type === 'notice') notices.push(event.message)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('max_steps')
    expect(notices.some((message) => message.includes('收尾'))).toBe(false)
  })
})

describe('agent loop budget wrap-up', () => {
  it('asks once to close out with done/left/next before the step cap', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('', [call('r2', 'read_file', { path: 'src/b.ts' })]),
      response('', [call('r3', 'read_file', { path: 'src/c.ts' })]),
      response('', [call('r4', 'read_file', { path: 'src/d.ts' })]),
      response('', [call('r5', 'read_file', { path: 'src/e.ts' })]),
      response('done'),
    ])
    const notices: string[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix the failing test' }],
      tools,
      maxSteps: 6,
      budgetWrapUp: true,
      verificationGate: false,
      policy: () => 'auto',
      emit: (event) => {
        if (event.type === 'notice') notices.push(event.message)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    expect(notices.some((message) => message.includes('收尾'))).toBe(true)
    const lastRequest = model.requests[model.requests.length - 1]
    const wrapUps = lastRequest!.messages.filter((message) =>
      message.content.includes('[步数预算]'),
    )
    expect(wrapUps).toHaveLength(1)
    // The prompt has to say what to report, otherwise the run still ends with a
    // bare "step limit reached" and the next attempt starts over.
    expect(wrapUps[0]!.content).toContain('已完成')
    expect(wrapUps[0]!.content).toContain('未完成')
    expect(wrapUps[0]!.content).toContain('下一步')
  })

  it('stays off when the option is not set', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('', [call('r2', 'read_file', { path: 'src/b.ts' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix the failing test' }],
      tools,
      maxSteps: 6,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })
    expect(result.status).toBe('completed')
    expect(messagesFor(model.requests[model.requests.length - 1]!)).not.toContain('[步数预算]')
  })

  it('skips the budget wrap-up for a cap too small to leave room', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('', [call('r2', 'read_file', { path: 'src/b.ts' })]),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix the failing test' }],
      tools,
      maxSteps: 2,
      budgetWrapUp: true,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })
    expect(result.status).toBe('max_steps')
    expect(messagesFor(model.requests[model.requests.length - 1]!)).not.toContain('[步数预算]')
  })

  it('keeps the analysis wrap-up alone when both could fire', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('', [call('r2', 'read_file', { path: 'src/b.ts' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'analyze the project' }],
      tools,
      maxSteps: 8,
      wrapUpAt: 2,
      budgetWrapUp: true,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })
    expect(result.status).toBe('completed')
    const body = messagesFor(model.requests[model.requests.length - 1]!)
    expect(body).toContain('[收尾]')
    expect(body).not.toContain('[步数预算]')
  })

  it('asks once to close out when the token budget is nearly spent', async () => {
    // 92% of long runs compacted and 581 万 token per workspace means the token
    // cap can arrive before the step cap, cutting the answer off mid-sentence.
    // One warning at 85% turns that into a planned close-out.
    const model = scripted([
      {
        content: '',
        toolCalls: [call('r1', 'read_file', { path: 'src/a.ts' })],
        usage: { promptTokens: 800, completionTokens: 100, totalTokens: 900 },
      },
      response('done'),
    ])
    const notices: string[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix the failing test' }],
      tools,
      maxSteps: 8,
      maxTokens: 1_000,
      budgetWrapUp: true,
      verificationGate: false,
      policy: () => 'auto',
      emit: (event) => {
        if (event.type === 'notice') notices.push(event.message)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    const lastRequest = model.requests[model.requests.length - 1]
    const tokenWraps = lastRequest!.messages.filter((message) =>
      message.content.includes('[额度预算]'),
    )
    expect(tokenWraps).toHaveLength(1)
    expect(tokenWraps[0]!.content).toContain('已完成')
    expect(tokenWraps[0]!.content).toContain('未完成')
    expect(tokenWraps[0]!.content).toContain('下一步')
    // The notice has to show the numbers, otherwise "nearly out of budget" is
    // indistinguishable from every other warning in the transcript.
    expect(notices.some((message) => message.includes('900/1000 token'))).toBe(true)
  })

  it('sends one close-out when both the token and step budgets are close', async () => {
    // Both warnings ask for the same report; paying for two extra messages on a
    // run that is already short on budget is exactly the cost this is fixing.
    const model = scripted([
      {
        content: '',
        toolCalls: [call('r1', 'read_file', { path: 'src/a.ts' })],
        usage: { promptTokens: 800, completionTokens: 100, totalTokens: 900 },
      },
      response('', [call('r2', 'read_file', { path: 'src/b.ts' })]),
      response('', [call('r3', 'read_file', { path: 'src/c.ts' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix the failing test' }],
      tools,
      maxSteps: 6,
      maxTokens: 1_000,
      budgetWrapUp: true,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    const body = messagesFor(model.requests[model.requests.length - 1]!)
    expect(body.split('[额度预算]')).toHaveLength(2)
    expect(body).not.toContain('[步数预算]')
  })

  it('stays off without the option even past 85% of the token budget', async () => {
    const model = scripted([
      {
        content: '',
        toolCalls: [call('r1', 'read_file', { path: 'src/a.ts' })],
        usage: { promptTokens: 800, completionTokens: 100, totalTokens: 900 },
      },
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'fix the failing test' }],
      tools,
      maxSteps: 8,
      maxTokens: 1_000,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })
    expect(result.status).toBe('completed')
    expect(messagesFor(model.requests[model.requests.length - 1]!)).not.toContain('[额度预算]')
  })
})

describe('per-step usage telemetry', () => {
  it('records one sample per model call with the prompt footprint that call sent', async () => {
    const model = scripted([
      response('', [call('r1', 'read_file', { path: 'src/a.ts' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'look at src/a.ts' }],
      tools,
      maxSteps: 4,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'file body '.repeat(50) }),
    })

    expect(result.status).toBe('completed')
    expect(result.usageSteps).toHaveLength(model.requests.length)
    expect(result.usageSteps.map((sample) => sample.step)).toEqual([1, 2])
    expect(result.usageSteps[0]!.promptTokens).toBe(10)
    // The second call carries the tool result, so its footprint is larger.
    expect(result.usageSteps[1]!.contextTokens).toBeGreaterThan(
      result.usageSteps[0]!.contextTokens,
    )
  })
})
