/**
 * A `ModelClient` that replays a fixed list of tool calls.
 *
 * Two jobs, both about trust in the harness rather than about model quality:
 *
 * 1. `--mock` proves the whole pipeline (workspace setup → agent loop → tool
 *    execution → test command → scoring) works on a machine with no API key and
 *    no network, so a broken harness is never mistaken for a weak model.
 * 2. The smoke suite deliberately contains one task the script can solve and one
 *    it cannot, so a report that cannot express "unresolved" fails loudly.
 *
 * A mock run never produces a score that means anything about the agent.
 */
import type { ModelClient, ModelRequest, ModelResponse } from '../agent/loop'
import type { MockStep } from './tasks'

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

export class ScriptedClient implements ModelClient {
  private index = 0
  private readonly steps: MockStep[]

  constructor(steps: MockStep[]) {
    this.steps = [...steps]
  }

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const step = this.steps[this.index]
    if (!step) {
      return { content: '已完成。', toolCalls: [], usage: { ...ZERO_USAGE }, finishReason: 'stop' }
    }
    this.index += 1
    return {
      content: '',
      toolCalls: [{ id: `mock_call_${this.index}`, name: step.tool, arguments: step.arguments }],
      usage: { ...ZERO_USAGE },
      finishReason: 'tool_calls',
    }
  }
}
