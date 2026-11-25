import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentToolDefinition, ToolCall } from '../src/shared/types'
import { HookService, loadHookConfig } from '../src/main/agent/hooks'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

const tool: AgentToolDefinition = {
  name: 'write_file',
  description: 'write',
  inputSchema: { type: 'object', properties: {} },
  risk: 'write',
}

const call: ToolCall = { id: '1', name: 'write_file', arguments: { path: 'a.txt' } }

async function workspaceWithHooks(config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-hooks-'))
  cleanups.push(root)
  await mkdir(join(root, '.pilot'), { recursive: true })
  await writeFile(join(root, '.pilot', 'hooks.json'), JSON.stringify(config), 'utf8')
  return root
}

describe('loadHookConfig', () => {
  it('sanitizes invalid commands and clamps timeouts', async () => {
    const root = await workspaceWithHooks({
      pre_tool: [
        { tool: 'write_file', command: 'node', args: ['-e', '0'], timeoutMs: 1 },
        { command: '' },
        { command: 'node', args: [1, 'ok'] },
      ],
      post_edit: 'not-an-array',
    })
    const config = await loadHookConfig(root)
    expect(config.pre_tool).toHaveLength(2)
    expect(config.pre_tool[0]?.timeoutMs).toBe(1_000)
    expect(config.pre_tool[1]?.args).toEqual(['ok'])
    expect(config.post_edit).toEqual([])
  })

  it('returns an empty config when the file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-hooks-'))
    cleanups.push(root)
    await expect(loadHookConfig(root)).resolves.toEqual({
      pre_tool: [],
      post_edit: [],
      stop: [],
    })
  })
  it('keeps the match glob and drops an oversized one', async () => {
    const root = await workspaceWithHooks({
      pre_tool: [
        { tool: 'run_shell', match: '*git commit*', command: 'node' },
        { match: 'x'.repeat(260), command: 'node' },
      ],
    })
    const config = await loadHookConfig(root)
    expect(config.pre_tool[0]?.match).toBe('*git commit*')
    expect(config.pre_tool[1]?.match).toHaveLength(200)
  })
})

describe('HookService', () => {
  it('does nothing when hooks are disabled', async () => {
    const root = await workspaceWithHooks({
      pre_tool: [{ command: 'node', args: ['-e', 'process.exit(1)'] }],
    })
    const service = new HookService(root, false)
    await service.load()
    const outcome = await service.beforeTool(call, tool, new AbortController().signal)
    expect(outcome.blocked).toBe(false)
  })

  it('blocks a pre_tool call when the hook fails', async () => {
    const root = await workspaceWithHooks({
      pre_tool: [
        {
          tool: 'write_file',
          command: 'node',
          args: ['-e', "console.error('no writes today'); process.exit(2)"],
        },
      ],
    })
    const service = new HookService(root, true)
    await service.load()
    const outcome = await service.beforeTool(call, tool, new AbortController().signal)
    expect(outcome.blocked).toBe(true)
    expect(outcome.output).toContain('no writes today')
  })

  it('ignores hooks for other tools', async () => {
    const root = await workspaceWithHooks({
      pre_tool: [{ tool: 'run_shell', command: 'node', args: ['-e', 'process.exit(2)'] }],
    })
    const service = new HookService(root, true)
    await service.load()
    await expect(
      service.beforeTool(call, tool, new AbortController().signal),
    ).resolves.toEqual({ blocked: false, output: '' })
  })

  it('runs a hook only when the call arguments match its glob', async () => {
    const root = await workspaceWithHooks({
      pre_tool: [
        {
          tool: 'run_shell',
          match: '*git commit*',
          command: 'node',
          args: ['-e', "console.error('run the tests first'); process.exit(2)"],
        },
      ],
    })
    const service = new HookService(root, true)
    await service.load()
    const signal = new AbortController().signal
    const shell: AgentToolDefinition = {
      name: 'run_shell',
      description: 'shell',
      inputSchema: { type: 'object', properties: {} },
      risk: 'exec',
    }
    const commit: ToolCall = {
      id: '2',
      name: 'run_shell',
      arguments: { command: 'git', args: ['commit', '-m', 'x'] },
    }
    const blocked = await service.beforeTool(commit, shell, signal)
    expect(blocked.blocked).toBe(true)
    expect(blocked.output).toContain('run the tests first')

    const status: ToolCall = {
      id: '3',
      name: 'run_shell',
      arguments: { command: 'git', args: ['status'] },
    }
    await expect(service.beforeTool(status, shell, signal)).resolves.toEqual({
      blocked: false,
      output: '',
    })
  })

  it('runs post_edit hooks only for the tools they name', async () => {
    const root = await workspaceWithHooks({
      post_edit: [
        { tool: 'write_file|apply_patch', command: 'node', args: ['-e', "console.log('linted')"] },
      ],
    })
    const service = new HookService(root, true)
    await service.load()
    const signal = new AbortController().signal
    expect(await service.afterEdit(call, signal)).toContain('linted')
    const other: ToolCall = { id: '4', name: 'create_skill', arguments: { name: 'x' } }
    expect(await service.afterEdit(other, signal)).toBeNull()
  })

  it('returns post_edit and stop output', async () => {
    const root = await workspaceWithHooks({
      post_edit: [{ command: 'node', args: ['-e', "console.log('formatted')"] }],
      stop: [{ command: 'node', args: ['-e', "console.log('finished')"] }],
    })
    const service = new HookService(root, true)
    await service.load()
    const signal = new AbortController().signal
    expect(await service.afterEdit(call, signal)).toContain('formatted')
    expect(await service.stop(signal)).toContain('finished')
  })
})
