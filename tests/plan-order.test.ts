import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentToolDefinition, ToolCall } from '../src/shared/types'
import { planTools } from '../src/main/agent/tools/plan'
import {
  runAgentLoop,
  type LoopEvent,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../src/main/agent/loop'
import type { StepBudget } from '../src/shared/step-budget'

// 一次发送多条任务时，计划顺序是模型自己定的：拆成多轮时这份顺序由用户在每一轮
// 输入里给出，单轮批量没有这个输入。实测（会话 4572f05c，五条任务）计划落库为
// plan-1…plan-5，与发送编号 1→5 完全一致，也就是模型把「用户输入的先后」当成了
// 「执行的先后」，前置关系被忽略。补的是「先判定依赖」这条纪律，不是让代码替模型
// 排序：依赖是语义判断，用 planItem.text 做启发式重排会把方向判反，而且用户编号
// 常自带优先级，静默改序等于改需求。

function tool(name: string, risk: AgentToolDefinition['risk']): AgentToolDefinition {
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, risk }
}

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
    initial: 10,
    ceiling: 10,
    extension: 0,
    stallAfter: 0,
    taskCount: 1,
    ...overrides,
  }
}

function updatePlanDescription(): string {
  const definition = planTools.find((entry) => entry.name === 'update_plan')
  expect(definition).toBeDefined()
  return definition?.description ?? ''
}

describe('plan ordering discipline', () => {
  it('tells the model to order by dependency in the update_plan description', () => {
    // The description is injected with every request, so it is the one place the
    // rule always reaches the model — unlike a batch-only notice.
    const description = updatePlanDescription()
    expect(description).toContain('Order items by dependency instead of by the order they were asked')
    expect(description).toContain('work that another item must wait for goes first')
  })

  it('keeps the user order as the default so a plan is not silently reordered', () => {
    const description = updatePlanDescription()
    // A plain "reorder by dependency" instruction would let the model shuffle a
    // numbered instruction at will; numbered lists often carry priority.
    expect(description).toContain('independent work keeps the order the user wrote')
    expect(description).toContain('when your order differs from theirs, explain why in goal')
  })

  it('keeps the per-item count advice untouched by the ordering rule', () => {
    // 2-8 stays: it is advice, while the hard valve is PLAN_ITEM_LIMIT. Rewording
    // the limit here is what an earlier round withdrew.
    const description = updatePlanDescription()
    expect(description).toContain('Keep 2-8 items')
    expect(description).not.toContain('Keep 12 items')
  })

  it('repeats the ordering rule in the batch notice, which only a batch run receives', async () => {
    const batchTools = [
      tool('write_file', 'write'),
      tool('update_plan', 'control'),
    ]
    const model = scripted([
      response('', [
        call('p1', 'update_plan', {
          items: [
            { text: 'B', status: 'in_progress' },
            { text: 'A', status: 'pending' },
          ],
        }),
      ]),
      response('done'),
    ])
    const events: LoopEvent[] = []
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '1、A\n2、B' }],
      tools: batchTools,
      maxSteps: 10,
      stepBudget: budget({ taskCount: 2 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: (event: LoopEvent) => {
        events.push(event)
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const notice = model.requests
      .flatMap((request) => request.messages)
      .map((message: AgentMessage) =>
        typeof message.content === 'string' ? message.content : '',
      )
      .find((content) => content.includes('[分批执行]'))
    expect(notice).toBeDefined()
    // Both halves have to be present: "sort by dependency" alone invites a
    // reshuffle of an intentionally ordered instruction.
    expect(notice).toContain('顺序按依赖而不是按收到的编号')
    expect(notice).toContain('互不依赖的保持原顺序')
    expect(notice).toContain('顺序与指令不同就在 goal 里说明原因')
    // The count guard from before must survive next to it.
    expect(notice).toContain('不要合并，也不要额外扩张')
  })

  it('leaves a single-task run without the batch ordering notice', async () => {
    const model = scripted([response('done')])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: '改 A' }],
      tools: [tool('update_plan', 'control')],
      maxSteps: 10,
      stepBudget: budget({ taskCount: 1 }),
      verificationGate: false,
      policy: () => 'auto',
      emit: () => undefined,
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const seen = model.requests
      .flatMap((request) => request.messages)
      .some(
        (message: AgentMessage) =>
          typeof message.content === 'string' && message.content.includes('[分批执行]'),
      )
    expect(seen).toBe(false)
  })
})
