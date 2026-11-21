import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelClient, ModelRequest, ModelResponse } from '../src/main/agent/loop'
import {
  parseVerificationSuggestions,
  runSubagent,
  selectSubagentTools,
  SUBAGENT_GENERAL_NAMES,
  SUBAGENT_READ_NAMES,
  SUBAGENT_TOOLSMITH_NAMES,
} from '../src/main/agent/subagent'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function scripted(responses: ModelResponse[]): ModelClient & { requests: ModelRequest[] } {
  let index = 0
  const client = {
    requests: [] as ModelRequest[],
    async complete(request: ModelRequest): Promise<ModelResponse> {
      client.requests.push(request)
      const next = responses[index]
      index += 1
      return next ?? { content: 'done', toolCalls: [] }
    },
  }
  return client
}

describe('subagent thinking language', () => {
  it('passes the app language to the system prompt so thinking follows the UI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-subagent-'))
    cleanups.push(root)
    const model = scripted([{ content: 'nothing to do', toolCalls: [] }])

    await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'explore',
      task: 'look around',
      locale: 'en',
    })

    const system = model.requests[0]?.messages[0]?.content ?? ''
    expect(system).toContain('reasoning/thinking block in English')
  })
})

describe('subagent tools', () => {
  it('keeps explore read-only and gives general mode edits without exec', () => {
    const explore = selectSubagentTools('explore').map((tool) => tool.name)
    const general = selectSubagentTools('general').map((tool) => tool.name)
    expect(explore.sort()).toEqual([...SUBAGENT_READ_NAMES].sort())
    expect(general.sort()).toEqual([...SUBAGENT_GENERAL_NAMES].sort())
    expect(general).toContain('write_file')
    expect(general).toContain('apply_patch')
    expect(general).not.toContain('run_command')
    expect(general).not.toContain('run_shell')
    expect(general).not.toContain('subagent')

    const toolsmith = selectSubagentTools('toolsmith').map((tool) => tool.name)
    expect(toolsmith.sort()).toEqual([...SUBAGENT_TOOLSMITH_NAMES].sort())
    expect(toolsmith).toContain('write_file')
    expect(toolsmith).not.toContain('run_command')
    expect(toolsmith).not.toContain('register_tool')
  })
})

describe('parseVerificationSuggestions', () => {
  it('caps at three checks and rejects absolute or escaping paths', () => {
    const { checks, rejected } = parseVerificationSuggestions(
      [
        'VERIFY| a | . | ok',
        'VERIFY| b | pilot/pilot | ok',
        'VERIFY| c | ./x/ | ok',
        'VERIFY| d | . | ok',
        'VERIFY| /usr/bin/rm | . | ok',
        'VERIFY| node x.mjs | C:/tmp | ok',
      ].join('\n'),
    )
    expect(checks.map((check) => check.command)).toEqual(['a', 'b', 'c'])
    expect(checks[1]?.cwd).toBe('pilot/pilot')
    expect(checks[2]?.cwd).toBe('x')
    expect(rejected).toBe(3)
  })

  it('drops lines that rely on shell semantics', () => {
    const { checks, rejected } = parseVerificationSuggestions(
      [
        'VERIFY| pnpm test -- --run tests/a.test.ts && rm -rf build | . | exit 0',
        'VERIFY| ls | grep x | . | exit 0',
        'VERIFY| echo $(whoami) | . | exit 0',
        'VERIFY| npm run typecheck | . |',
      ].join('\n'),
    )
    expect(checks.map((check) => check.command)).toEqual(['npm run typecheck'])
    expect(checks[0]?.expect).toBe('退出码 0')
    expect(rejected).toBe(3)
  })
})

describe('runSubagent', () => {
  it('edits a file in general mode and reports the changed path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-subagent-'))
    cleanups.push(root)
    const model = scripted([
      {
        content: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            arguments: { path: 'note.txt', content: 'hello from subagent' },
          },
        ],
      },
      { content: 'Created note.txt with the requested text.', toolCalls: [] },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'general',
      task: 'Create note.txt',
    })

    expect(result.changedPaths).toEqual(['note.txt'])
    expect(result.summary).toContain('note.txt')
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('hello from subagent')
    expect(model.requests[1]?.tools.map((tool) => tool.name)).not.toContain('run_command')
  })

  it('refuses to rewrite protected config paths in general mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-subagent-'))
    cleanups.push(root)
    const model = scripted([
      {
        content: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            arguments: { path: '.pilot/hooks.json', content: '{}' },
          },
        ],
      },
      { content: 'Blocked.', toolCalls: [] },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'general',
      task: 'Rewrite hooks config',
    })

    expect(result.changedPaths).toEqual([])
    const toolMessage = model.requests[1]?.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'w1',
    )
    expect(toolMessage?.content).toContain('子智能体不能修改这个路径')
    await expect(readFile(join(root, '.pilot', 'hooks.json'), 'utf8')).rejects.toThrow()
  })

  it('limits toolsmith writes to .pilot/tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-subagent-'))
    cleanups.push(root)
    const model = scripted([
      {
        content: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            arguments: { path: '.pilot/tools/echo/main.js', content: 'process.exit(0)\n' },
          },
          {
            id: 'w2',
            name: 'write_file',
            arguments: { path: 'src/evil.js', content: 'process.exit(0)\n' },
          },
        ],
      },
      { content: 'Created the tool entry; the outside write was rejected.', toolCalls: [] },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'toolsmith',
      task: 'Write a tool',
    })

    expect(await readFile(join(root, '.pilot', 'tools', 'echo', 'main.js'), 'utf8')).toContain(
      'process.exit',
    )
    await expect(readFile(join(root, 'src', 'evil.js'), 'utf8')).rejects.toThrow()
    expect(result.changedPaths).toEqual(['.pilot/tools/echo/main.js'])
    const blocked = model.requests[1]?.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'w2',
    )
    expect(blocked?.content).toContain('工具匠只能写 .pilot/tools')
  })

  it('refuses write tools in explore mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-subagent-'))
    cleanups.push(root)
    const model = scripted([
      {
        content: '',
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            arguments: { path: 'note.txt', content: 'nope' },
          },
        ],
      },
      { content: 'Could not write.', toolCalls: [] },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'explore',
      task: 'Write note.txt',
    })

    expect(result.changedPaths).toEqual([])
    await expect(readFile(join(root, 'note.txt'), 'utf8')).rejects.toThrow()
  })

  it('hands the parent a runnable check list instead of claiming the edit works', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-subagent-'))
    cleanups.push(root)
    const model = scripted([
      {
        content: [
          'Edited src/a.ts.',
          'VERIFY| npx tsc -p tsconfig.json --noEmit | . | 退出码 0',
          'VERIFY| pnpm test -- --run tests/a.test.ts && rm -rf build | . | exit 0',
        ].join('\n'),
        toolCalls: [],
      },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'general',
      task: 'Edit src/a.ts',
    })

    const block = result.summary.split('父级下一步')[1] ?? ''
    expect(block).toContain('1. cwd=. · 命令 npx tsc -p tsconfig.json --noEmit')
    expect(block).not.toContain('rm -rf')
    expect(block).toContain('丢弃')
    expect(result.changedPaths).toEqual([])
  })

  it('does not hand verification chores to an explore result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-subagent-'))
    cleanups.push(root)
    const model = scripted([
      {
        content: 'Found it in src/a.ts:12.\nVERIFY| npm test | . | exit 0',
        toolCalls: [],
      },
    ])

    const result = await runSubagent({
      client: model,
      workspacePath: root,
      mode: 'explore',
      task: 'Where is the parser?',
    })

    expect(result.summary).toContain('src/a.ts:12')
    expect(result.summary).not.toContain('父级下一步')
    expect(result.summary).not.toContain('还没有被任何测试')
  })
})
