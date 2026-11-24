/**
 * Regression: the benchmark harness must be able to touch its own fixture.
 *
 * Every history entry in the field showed `0 wins / 0 losses / N ties` with
 * `successRate: 0` on both sides, because the loop resolved each write and exec
 * call to `ask` and no approval handler exists inside a benchmark run. Every
 * task failed for a reason unrelated to the profile, so the activation gate —
 * which requires a measured improvement — could never open. These tests pin the
 * policy that keeps the measurement real.
 */
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBenchmarkTaskRunner } from '../src/main/agent/benchmark-runner'
import type { ModelRequest, ModelResponse } from '../src/main/agent/loop'
import type { BenchmarkTask } from '../src/main/agent/profile-benchmark'

const TASK: BenchmarkTask = { id: 'noop', prompt: 'Touch the fixture.', difficulty: 'L0' }

function scripted(
  calls: { name: string; arguments: Record<string, unknown> }[],
): { client: { complete(request: ModelRequest): Promise<ModelResponse> }; requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  let turn = 0
  return {
    requests,
    client: {
      async complete(request) {
        requests.push(request)
        const call = calls[turn]
        turn += 1
        if (!call) return { content: 'done', toolCalls: [] }
        return {
          content: '',
          toolCalls: [{ id: `call-${turn}`, name: call.name, arguments: call.arguments }],
        }
      },
    },
  }
}

async function runWith(calls: { name: string; arguments: Record<string, unknown> }[]) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-bench-policy-'))
  const workspacePath = join(root, 'run')
  await mkdir(workspacePath, { recursive: true })
  const { client, requests } = scripted(calls)
  const runner = createBenchmarkTaskRunner({ client, addendumFor: () => '', shellMode: true })
  const result = await runner({ task: TASK, variant: 'current', workspacePath })
  const toolResults = requests
    .flatMap((request) => request.messages)
    .filter((message) => message.role === 'tool')
    .map((message) => message.content ?? '')
  await rm(root, { recursive: true, force: true })
  return { result, toolResults }
}

describe('benchmark tool policy', () => {
  it('lets a write tool reach the fixture instead of demanding approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-bench-write-'))
    const workspacePath = join(root, 'run')
    await mkdir(workspacePath, { recursive: true })
    try {
      const { client, requests } = scripted([
        { name: 'write_file', arguments: { path: 'notes.md', content: '# written by the benchmark\n' } },
      ])
      const runner = createBenchmarkTaskRunner({ client, addendumFor: () => '', shellMode: true })
      await runner({ task: TASK, variant: 'current', workspacePath })
      const written = await readFile(join(workspacePath, 'notes.md'), 'utf8')
      expect(written).toContain('written by the benchmark')
      const errors = requests
        .flatMap((request) => request.messages)
        .filter((message) => message.role === 'tool' && message.isError)
      expect(errors).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets exec run, because a profile that teaches narrow commands must be measurable', async () => {
    const { result, toolResults } = await runWith([
      { name: 'run_shell', arguments: { command: 'echo BENCH_EXEC_OK' } },
    ])
    expect(result.ok).toBe(true)
    expect(toolResults.join('\n')).toContain('BENCH_EXEC_OK')
    expect(toolResults.join('\n')).not.toContain('no approval handler')
  })
})
