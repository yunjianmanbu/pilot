import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolDefinition, ToolCall } from '../src/shared/types'
import {
  runAgentLoop,
  type LoopEvent,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../src/main/agent/loop'
import { MAX_VERIFICATION_REMINDERS, type StepBudget } from '../src/shared/step-budget'

function tool(name: string, risk: AgentToolDefinition['risk']): AgentToolDefinition {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, risk }
}

const tools = [tool('read_file', 'read'), tool('update_plan', 'control')]

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

function budget(overrides: Partial<StepBudget> = {}): StepBudget {
  return {
    initial: 2,
    ceiling: 6,
    extension: 2,
    stallAfter: 0,
    taskCount: 1,
    ...overrides,
  }
}

describe('run loop dynamic step budget', () => {
  it('extends the allowance past the initial budget while evidence keeps arriving', async () => {
    const steps = ['a', 'b', 'c', 'd', 'e']
    const model = scripted([
      ...steps.map((path) => response('', [call(`c-${path}`, 'read_file', { path })])),
      response('all read'),
    ])
    const events: LoopEvent[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'inspect five files' }],
      tools,
      maxSteps: 2,
      stepBudget: budget({ initial: 2, ceiling: 6, extension: 2, stallAfter: 0 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async (execution) => ({
        ok: true,
        output: `content of ${String(execution.call.arguments['path'])}`,
      }),
    })

    expect(result.status).toBe('completed')
    expect(result.steps).toBe(6)
    const extensions = events.filter(
      (event) => event.type === 'notice' && event.message.includes('步数预算自动延展'),
    )
    expect(extensions.length).toBeGreaterThanOrEqual(2)
  })

  it('stops before the ceiling once the run repeats itself', async () => {
    const model = scripted([
      response('', [call('c1', 'read_file', { path: 'same' })]),
      response('', [call('c2', 'read_file', { path: 'same' })]),
      response('', [call('c3', 'read_file', { path: 'same' })]),
      response('stalled out'),
    ])
    const events: LoopEvent[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'read the same file over and over' }],
      tools,
      maxSteps: 4,
      stepBudget: budget({ initial: 6, ceiling: 12, extension: 2, stallAfter: 2 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'unchanged content' }),
    })

    expect(result.status).toBe('completed')
    expect(result.steps).toBeLessThan(5)
    const stallNotice = events.find(
      (event) => event.type === 'notice' && event.message.includes('没有新证据'),
    )
    expect(stallNotice).toBeDefined()
    const told = model.requests.some((request: ModelRequest) =>
      request.messages.some(
        (message: AgentMessage) =>
          typeof message.content === 'string' && message.content.includes('[停滞检测]'),
      ),
    )
    expect(told).toBe(true)
  })

  it('asks a multi-task instruction to work one item at a time', async () => {
    const model = scripted([response('done')])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、做 A\n2、做 B\n3、做 C' }],
      tools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 3 }),
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const first = model.requests[0]?.messages ?? []
    const guidance = first.find(
      (message: AgentMessage) =>
        typeof message.content === 'string' && message.content.includes('[分批执行]'),
    )
    expect(guidance).toBeDefined()
    expect(String(guidance?.content)).toContain('3 个独立任务')
  })

  it('leaves a single-task run without the batching guidance', async () => {
    const model = scripted([response('done')])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'rename one function' }],
      tools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 1 }),
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const first = model.requests[0]?.messages ?? []
    expect(
      first.some(
        (message: AgentMessage) =>
          typeof message.content === 'string' && message.content.includes('[分批执行]'),
      ),
    ).toBe(false)
  })

  it('re-arms the verification gate for each task item in a batch', async () => {
    const batchTools = [
      tool('write_file', 'write'),
      tool('run_command', 'exec'),
      tool('update_plan', 'control'),
    ]
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'a.ts' })]),
      response('first item done, moving on'),
      response('', [call('c1', 'run_command', { command: 'npx', args: ['vitest', 'run'] })]),
      response('', [call('w2', 'write_file', { path: 'b.ts' })]),
      response('second item done'),
      response('', [call('c2', 'run_command', { command: 'npx', args: ['vitest', 'run'] })]),
      response('all done'),
    ])
    const events: LoopEvent[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、改 A\n2、改 B' }],
      tools: batchTools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 2 }),
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    expect(result.checked).toBe(true)
    // Count the emitted reminders, not the requests: an internal message stays in
    // the transcript, so every later request would also "contain" it.
    const asks = events.filter(
      (event) => event.type === 'notice' && event.message.includes('已提醒模型运行检查'),
    )
    expect(asks.length).toBe(2)
  })

  it('keeps a single verification reminder for a one-item request', async () => {
    const batchTools = [tool('write_file', 'write'), tool('update_plan', 'control')]
    const model = scripted([
      response('', [call('w1', 'write_file', { path: 'a.ts' })]),
      response('done once'),
      response('done twice'),
    ])
    const events: LoopEvent[] = []
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '改 A' }],
      tools: batchTools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 1 }),
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const asks = events.filter(
      (event) => event.type === 'notice' && event.message.includes('已提醒模型运行检查'),
    )
    expect(asks.length).toBe(1)
  })

  it('caps verification reminders for a large batch instead of asking once per item', async () => {
    const batchTools = [
      tool('write_file', 'write'),
      tool('run_command', 'exec'),
      tool('update_plan', 'control'),
    ]
    // Six edits, each followed by an answer before any check ran. One reminder
    // per item would spend six extra model requests on the same question; the
    // per-item behaviour stays for realistic batches and stops scaling with the
    // size of the instruction.
    const model = scripted(
      Array.from({ length: MAX_VERIFICATION_REMINDERS + 1 }, (_, index) => [
        response('', [call(`w${index}`, 'write_file', { path: `f${index}.ts` })]),
        response(`item ${index + 1} done`),
      ]).flat(),
    )
    const events: LoopEvent[] = []
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、A\n2、B\n3、C\n4、D\n5、E\n6、F' }],
      tools: batchTools,
      maxSteps: 60,
      stepBudget: budget({ initial: 60, ceiling: 60, extension: 0, stallAfter: 0, taskCount: 6 }),
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const asks = events.filter(
      (event) => event.type === 'notice' && event.message.includes('已提醒模型运行检查'),
    )
    expect(asks.length).toBe(MAX_VERIFICATION_REMINDERS)
  })

  it('asks for missing plan items when the plan covers fewer tasks than the instruction', async () => {
    const model = scripted([
      response('', [
        call('p1', 'update_plan', {
          items: [
            { text: '任务 A', status: 'in_progress' },
            { text: '任务 B', status: 'pending' },
          ],
        }),
      ]),
      // Two items for a three-task instruction: asked to list every task.
      response('', [
        call('p2', 'update_plan', {
          items: [
            { text: '任务 A', status: 'done' },
            { text: '任务 B', status: 'pending' },
            { text: '任务 C', status: 'pending' },
          ],
        }),
      ]),
      response('done'),
    ])
    const events: LoopEvent[] = []
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、A\n2、B\n3、C' }],
      tools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 3 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'Plan updated' }),
    })

    const told = model.requests.some((request: ModelRequest) =>
      request.messages.some(
        (message: AgentMessage) =>
          typeof message.content === 'string' && message.content.includes('[分项计划]'),
      ),
    )
    expect(told).toBe(true)
    expect(
      events.some(
        (event) => event.type === 'notice' && event.message.includes('少于指令里的任务数'),
      ),
    ).toBe(true)
  })

  it('asks once for a per-item close-out while plan items are still open', async () => {
    const model = scripted([
      response('', [
        call('p1', 'update_plan', {
          items: [
            { text: '任务 A', status: 'in_progress' },
            { text: '任务 B', status: 'pending' },
          ],
        }),
      ]),
      // Answers after finishing only the first item: splitting into two turns
      // would have produced a second answer for task B instead of dropping it.
      response('A 已改好'),
      response('', [
        call('p2', 'update_plan', {
          items: [
            { text: '任务 A', status: 'done' },
            { text: '任务 B', status: 'done' },
          ],
        }),
      ]),
      response('A 已改好（已跑单测）；B 已改好（已跑单测）'),
    ])
    const events: LoopEvent[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、改 A\n2、改 B' }],
      tools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 2 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    const told = model.requests.some((request: ModelRequest) =>
      request.messages.some(
        (message: AgentMessage) =>
          typeof message.content === 'string' && message.content.includes('[分项收口]'),
      ),
    )
    expect(told).toBe(true)
    // Both counts are named: a plan that lists fewer items than the instruction
    // hides untracked tasks, and the close-out used to mention only the open ones.
    const named = model.requests.some((request: ModelRequest) =>
      request.messages.some(
        (message: AgentMessage) =>
          typeof message.content === 'string' &&
          message.content.includes('本轮共 2 项任务，计划列了 2 项'),
      ),
    )
    expect(named).toBe(true)
    // Asked exactly once, so a model that never updates its plan cannot loop.
    expect(
      events.filter((event) => event.type === 'notice' && event.message.includes('项未收口'))
        .length,
    ).toBe(1)
  })

  it('asks the model to rotate items before one task eats the whole budget', async () => {
    const model = scripted([
      response('', [
        call('p1', 'update_plan', {
          items: [
            { text: '任务 A', status: 'in_progress' },
            { text: '任务 B', status: 'pending' },
            { text: '任务 C', status: 'pending' },
          ],
        }),
      ]),
      response('', [call('r1', 'read_file', { path: 'a' })]),
      response('', [
        call('p2', 'update_plan', {
          items: [
            { text: '任务 A', status: 'done' },
            { text: '任务 B', status: 'done' },
            { text: '任务 C', status: 'done' },
          ],
        }),
      ]),
      response('三项都做完了'),
    ])
    const events: LoopEvent[] = []
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、A\n2、B\n3、C' }],
      tools,
      maxSteps: 9,
      stepBudget: budget({ initial: 9, ceiling: 9, extension: 0, stallAfter: 0, taskCount: 3 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const told = model.requests.some((request: ModelRequest) =>
      request.messages.some(
        (message: AgentMessage) =>
          typeof message.content === 'string' && message.content.includes('[分项轮转]'),
      ),
    )
    expect(told).toBe(true)
    expect(
      events.filter(
        (event) => event.type === 'notice' && event.message.includes('立即轮转到下一项'),
      ).length,
    ).toBe(1)
  })

  it('stops asking after the close-out allowance and reports what is still open', async () => {
    // A model that never updates its plan must not be able to loop: the asks are
    // capped, and the unfinished items become a visible warning instead of a
    // silent "everything is done".
    const model = scripted([
      response('', [
        call('p1', 'update_plan', {
          items: [
            { text: '任务 A', status: 'in_progress' },
            { text: '任务 B', status: 'pending' },
          ],
        }),
      ]),
      response('A 已改好'),
      response('A 已改好'),
      response('都做完了'),
      response('都做完了'),
    ])
    const events: LoopEvent[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、改 A\n2、改 B' }],
      tools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 2 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    // One ask per task, then it gives up asking.
    expect(
      events.filter((event) => event.type === 'notice' && event.message.includes('项未收口')).length,
    ).toBe(2)
    expect(
      events.filter(
        (event) => event.type === 'notice' && event.message.includes('仍未收口'),
      ).length,
    ).toBe(1)
  })

  it('does not ask for a per-item close-out on a single-task run', async () => {
    const model = scripted([
      response('', [call('p1', 'update_plan', { items: [{ text: '改 A', status: 'in_progress' }] })]),
      response('done'),
    ])
    const events: LoopEvent[] = []
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '改 A' }],
      tools,
      maxSteps: 10,
      stepBudget: budget({ initial: 10, ceiling: 10, extension: 0, stallAfter: 0, taskCount: 1 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    expect(
      events.some(
        (event) =>
          event.type === 'notice' &&
          (event.message.includes('项未收口') ||
            event.message.includes('少于指令里的任务数') ||
            event.message.includes('立即轮转到下一项')),
      ),
    ).toBe(false)
  })

  it('keeps the legacy fixed cap when no step budget is supplied', async () => {    const model = scripted([
      response('', [call('c1', 'read_file', { path: 'a' })]),
      response('', [call('c2', 'read_file', { path: 'b' })]),
      response('', [call('c3', 'read_file', { path: 'c' })]),
      response('never reached'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'keep going' }],
      tools,
      maxSteps: 2,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    // Two model calls only: without a budget the static cap still truncates.
    expect(result.status).toBe('max_steps')
    expect(model.requests.length).toBe(2)
    expect(result.steps).toBeGreaterThanOrEqual(2)
  })

  it('repeats the rotation ask each time an item really finishes', async () => {
    // 一项做完之后，剩余预算要覆盖的项少了一个、但那几项仍然一步没动，所以提醒必须
    // 能再来一次；上限仍是 min(任务数, 3)，只在未完成项数**确实下降**时才再发。
    const requests: ModelRequest[] = []
    const notices: string[] = []
    let turn = 0
    const model: ModelClient = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request)
        turn += 1
        if (turn === 1) {
          return response('', [
            call('p1', 'update_plan', {
              items: [
                { text: '任务 A', status: 'in_progress' },
                { text: '任务 B', status: 'pending' },
                { text: '任务 C', status: 'pending' },
              ],
            }),
          ])
        }
        if (turn === 8) {
          return response('', [
            call('p2', 'update_plan', {
              items: [
                { text: '任务 A', status: 'done' },
                { text: '任务 B', status: 'in_progress' },
                { text: '任务 C', status: 'pending' },
              ],
            }),
          ])
        }
        if (turn >= 40) return response('三项已处理完')
        return response('', [call(`r${turn}`, 'read_file', { path: `f${turn}` })])
      },
    }

    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、A\n2、B\n3、C' }],
      tools,
      maxSteps: 40,
      stepBudget: budget({ initial: 40, ceiling: 40, extension: 0, stallAfter: 0, taskCount: 3 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        if (event.type === 'notice') notices.push(event.message)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    // 第 5 步：3 项未完成、剩 35 步 < 3×12；第 17 步：A 已 done、2 项未完成、剩 23 步 < 2×12。
    expect(notices.filter((message) => message.includes('还有 3 项未完成'))).toHaveLength(1)
    expect(notices.filter((message) => message.includes('还有 2 项未完成'))).toHaveLength(1)
    expect(notices.filter((message) => message.includes('立即轮转到下一项'))).toHaveLength(2)
    // 提醒本身留在对话历史里，所以后续每条请求都能看到；真正要防止的是每步重复
    // **新增**一条，这一点由上面的 notice 计数与 requests 的步数上限保证。
    expect(requests.length).toBeLessThanOrEqual(40)
  })

  it('does not repeat the rotation ask while no item finishes', async () => {
    // 同一份计划一直不动时，重复发同一条提醒没有任何新信息，只会挤掉上下文。
    const notices: string[] = []
    let turn = 0
    const model: ModelClient = {
      async complete(): Promise<ModelResponse> {
        turn += 1
        if (turn === 1) {
          return response('', [
            call('p1', 'update_plan', {
              items: [
                { text: '任务 A', status: 'in_progress' },
                { text: '任务 B', status: 'pending' },
                { text: '任务 C', status: 'pending' },
              ],
            }),
          ])
        }
        if (turn >= 40) return response('做完了当前项')
        return response('', [call(`r${turn}`, 'read_file', { path: `f${turn}` })])
      },
    }

    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、A\n2、B\n3、C' }],
      tools,
      maxSteps: 40,
      stepBudget: budget({ initial: 40, ceiling: 40, extension: 0, stallAfter: 0, taskCount: 3 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        if (event.type === 'notice') notices.push(event.message)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(notices.filter((message) => message.includes('立即轮转到下一项'))).toHaveLength(1)
  })
})
