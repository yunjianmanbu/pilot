import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../src/shared/types'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/main/agent/loop'
import { summarizeConversation, transcriptExcerpt } from '../src/main/agent/summarize'

describe('summarizeConversation', () => {
  it('includes tool calls and results in the excerpt but not system prompts', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'SECRET SYSTEM PROMPT' },
      { role: 'user', content: 'Fix the login bug' },
      {
        role: 'assistant',
        content: 'Checking',
        toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'src/login.ts' } }],
      },
      { role: 'tool', name: 'read_file', content: 'export function login() {}' },
    ]
    const excerpt = transcriptExcerpt(messages)
    expect(excerpt).toContain('Fix the login bug')
    expect(excerpt).toContain('read_file')
    expect(excerpt).toContain('src/login.ts')
    expect(excerpt).not.toContain('SECRET SYSTEM PROMPT')
  })

  it('labels a loop-injected reminder apart from a real user turn', () => {
    // Both are role 'user', but only one is a task the user asked for. The
    // summarizer is told to write Goal from the last USER line, so an
    // unlabelled reminder becomes the goal of the summary.
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Fix the login bug' },
      { role: 'user', content: '[运行反思] pause and review the failure', internal: true },
    ]
    const excerpt = transcriptExcerpt(messages)
    expect(excerpt).toContain('USER: Fix the login bug')
    expect(excerpt).toContain('RUNTIME: [运行反思]')
    expect(excerpt).not.toContain('USER: [运行反思]')
  })

  it('returns a trimmed model-written summary', async () => {
    const requests: ModelRequest[] = []
    const client: ModelClient = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request)
        return { content: '  Goal: fix login\nNext: run tests  ', toolCalls: [] }
      },
    }
    const summary = await summarizeConversation(client, [
      { role: 'user', content: 'Fix login' },
      { role: 'assistant', content: 'Working on it' },
    ])
    expect(summary).toBe('Goal: fix login\nNext: run tests')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toEqual([])
  })

  it('asks for the newest task as Goal and older tasks as closed work', async () => {
    const requests: ModelRequest[] = []
    const client: ModelClient = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request)
        return { content: 'Goal: newest\nClosed earlier tasks: first', toolCalls: [] }
      },
    }
    await summarizeConversation(client, [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'doing the first task' },
      { role: 'user', content: 'newest task' },
    ])
    const system = requests[0]?.messages[0]?.content ?? ''
    const instruction = requests[0]?.messages.at(-1)?.content ?? ''
    // The summary used to declare "the user's task and any later corrections"
    // as Goal, so re-injecting it after the session moved on re-promoted the
    // first instruction of the session to "the task".
    expect(system).toContain('Goal: the newest user task only')
    expect(system).toContain('Closed earlier tasks')
    expect(system).not.toContain("Goal: the user's task and any later corrections")
    expect(instruction).toContain('The transcript\'s last user message is the current task')
  })

  it('tells a merged summary to demote a Goal the newer turns replaced', async () => {
    const requests: ModelRequest[] = []
    const client: ModelClient = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request)
        return { content: 'Goal: keep going', toolCalls: [] }
      },
    }
    await summarizeConversation(
      client,
      [
        { role: 'user', content: 'Keep going' },
        { role: 'assistant', content: 'Reading the router' },
      ],
      undefined,
      'Goal: fix login',
    )
    const instruction = requests[0]?.messages.at(-1)?.content ?? ''
    expect(instruction).toContain('move it to Closed earlier tasks')
  })

  it('merges the previous summary instead of dropping it', async () => {
    const requests: ModelRequest[] = []
    const client: ModelClient = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        requests.push(request)
        return { content: 'Goal: fix login\nFacts: src/login.ts uses bcrypt', toolCalls: [] }
      },
    }
    const summary = await summarizeConversation(
      client,
      [
        { role: 'user', content: "Keep going" },
        { role: 'assistant', content: 'Reading the router' },
      ],
      undefined,
      'Goal: fix login\nFacts: src/login.ts uses bcrypt',
    )
    const prompt = requests[0]?.messages.at(-1)?.content ?? ''
    expect(prompt).toContain('<earlier-summary>')
    expect(prompt).toContain('src/login.ts uses bcrypt')
    expect(prompt).toContain('one consolidated summary')
    expect(summary).toContain('bcrypt')
  })

  it('returns null when the model call fails', async () => {
    const client: ModelClient = {
      async complete(): Promise<ModelResponse> {
        throw new Error('network down')
      },
    }
    await expect(
      summarizeConversation(client, [{ role: 'user', content: 'Fix login' }]),
    ).resolves.toBeNull()
  })
})
