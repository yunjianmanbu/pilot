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
