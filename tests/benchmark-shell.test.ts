/**
 * The benchmark must expose the same shell production exposes, otherwise a
 * profile that teaches piped/narrow commands is punished for a capability the
 * harness hid. These tests pin the tool list and the prompt branch, so a future
 * "tighten the benchmark" edit has to be deliberate.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBenchmarkTaskRunner } from '../src/main/agent/benchmark-runner'
import type { ModelRequest, ModelResponse } from '../src/main/agent/loop'
import type { BenchmarkTask } from '../src/main/agent/profile-benchmark'

const TASK: BenchmarkTask = { id: 'noop', prompt: 'Say done.', difficulty: 'L0' }

function recorder(): { client: { complete(request: ModelRequest): Promise<ModelResponse> }; requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    client: {
      async complete(request) {
        requests.push(request)
        return { content: 'done', toolCalls: [] }
      },
    },
  }
}

function systemOf(request: ModelRequest): string {
  return request.messages.map((message) => message.content ?? '').join('\n')
}

async function runOnce(options: { shellMode?: boolean; shellInterpreter?: 'auto' | 'bash' | 'cmd' | 'wsl' }) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'pilot-bench-shell-'))
  try {
    const { client, requests } = recorder()
    const runner = createBenchmarkTaskRunner({
      client,
      addendumFor: () => '',
      ...options,
    })
    const result = await runner({ task: TASK, variant: 'current', workspacePath })
    return { result, request: requests[0]! }
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

describe('benchmark shell access', () => {
  it('offers run_shell by default and says so in the prompt', async () => {
    const { request } = await runOnce({})
    const names = request.tools.map((tool) => tool.name)
    expect(names).toContain('run_shell')
    expect(names).toContain('run_command')
    expect(systemOf(request)).toContain('run_shell is enabled')
    // Unsandboxed is the honest label: a benchmark workspace has no OS sandbox.
    expect(systemOf(request)).toContain('UNSANDBOXED SHELL')
  })

  it('hides run_shell when shellMode is off', async () => {
    const { request } = await runOnce({ shellMode: false })
    expect(request.tools.map((tool) => tool.name)).not.toContain('run_shell')
    expect(systemOf(request)).not.toContain('run_shell is enabled')
    expect(systemOf(request)).toContain('commands run without a shell')
  })

  it('names the interpreter it will use, like production does', async () => {
    const { request } = await runOnce({ shellInterpreter: 'auto' })
    const shell = request.tools.find((tool) => tool.name === 'run_shell')
    expect(shell?.description).toContain('shell on this machine is')
  })
})
