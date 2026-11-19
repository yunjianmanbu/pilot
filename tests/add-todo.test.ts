import { describe, expect, it } from 'vitest'
import {
  ADD_TODO,
  executePilotTool,
  pilotTools,
  REVIEW_TOOL_ALLOWLIST,
  type ToolHost,
} from '../src/main/agent/tools'
import { selectExploreTools } from '../src/main/agent/explore'
import { selectSubagentTools } from '../src/main/agent/subagent'
import { sanitizeSession } from '../src/main/store-schema'

const signal = new AbortController().signal

function host(added: Array<{ id: string; text: string }> = []): {
  host: ToolHost
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    host: {
      root: '.',
      sandbox: null,
      remember: async () => ({ id: 'mem-1' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
      addTodos: async (items) => {
        calls.push(items)
        if (added.length > 0) return added
        return items.map((text, index) => ({ id: `todo-${index + 1}`, text }))
      },
    },
  }
}

describe('add_todo tool', () => {
  it('is a control tool in the main session only', () => {
    const tool = pilotTools.find((entry) => entry.name === ADD_TODO)
    expect(tool).toBeDefined()
    expect(tool?.risk).toBe('control')
    expect(tool?.source).toBe('control')
    // Read-only review, explore and subagent runs must not gain a session writer.
    expect(REVIEW_TOOL_ALLOWLIST.has(ADD_TODO)).toBe(false)
    expect(selectExploreTools().some((entry) => entry.name === ADD_TODO)).toBe(false)
    expect(selectSubagentTools('general').some((entry) => entry.name === ADD_TODO)).toBe(false)
    expect(selectSubagentTools('explore').some((entry) => entry.name === ADD_TODO)).toBe(false)
    expect(selectSubagentTools('toolsmith').some((entry) => entry.name === ADD_TODO)).toBe(false)
  })

  it('cleans the texts and reports what was added', async () => {
    const { host: toolHost, calls } = host()
    const result = await executePilotTool(
      ADD_TODO,
      { items: ['  fix the   flaky test ', '', 42, 'ship   the docs'] },
      toolHost,
      signal,
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual([['fix the flaky test', 'ship the docs']])
    expect(result.output).toContain('Added 2 todo(s)')
    expect(result.output).toContain('fix the flaky test | ship the docs')
  })

  it('caps a single call at 20 items', async () => {
    const { host: toolHost, calls } = host()
    const items = Array.from({ length: 25 }, (_, index) => `item-${index + 1}`)
    await executePilotTool(ADD_TODO, { items }, toolHost, signal)
    expect(calls[0]).toHaveLength(20)
    expect(calls[0]?.[19]).toBe('item-20')
  })

  it('says so when every item is already pending', async () => {
    const { host: toolHost } = host([])
    const result = await executePilotTool(
      ADD_TODO,
      { items: ['already there'] },
      { ...toolHost, addTodos: async () => [] },
      signal,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('No new todos')
  })

  it('rejects empty input and a session without a todo list', async () => {
    const { host: toolHost } = host()
    await expect(executePilotTool(ADD_TODO, { items: ['  ', ''] }, toolHost, signal)).rejects.toThrow(
      /non-empty/,
    )
    const bare: ToolHost = { ...toolHost, addTodos: undefined }
    await expect(executePilotTool(ADD_TODO, { items: ['x'] }, bare, signal)).rejects.toThrow(
      /not available/,
    )
  })
})

describe('todos with an agent source', () => {
  it('survives session normalisation', () => {
    const session = sanitizeSession({
      id: 'session-1',
      workspacePath: 'E:/code/demo',
      todos: [
        { id: 'a', text: 'from the agent', status: 'pending', source: 'agent' },
        { id: 'b', text: 'from the phone', status: 'pending', source: 'phone' },
        { id: 'c', text: 'unknown source', status: 'pending', source: 'mystery' },
      ],
    })
    expect(session?.todos.map((todo) => todo.source)).toEqual(['agent', 'phone', 'user'])
  })
})
