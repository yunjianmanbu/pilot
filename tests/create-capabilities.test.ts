import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSkillMarkdown,
  SkillsService,
  writeSkill,
  type CreateSkillInput,
} from '../src/main/agent/skills'
import { loadMcpConfig, McpService, saveMcpServer } from '../src/main/agent/mcp'
import {
  CREATE_MCP_SERVER,
  CREATE_SKILL,
  executePilotTool,
  pilotTools,
  USE_SKILL,
  type ToolHost,
} from '../src/main/agent/tools'
import type { AgentToolDefinition, ToolCall } from '../src/shared/types'
import { runAgentLoop, type ModelClient, type ModelRequest, type ModelResponse } from '../src/main/agent/loop'

const cleanups: string[] = []
const children: McpService[] = []
const signal = new AbortController().signal

afterEach(async () => {
  for (const service of children.splice(0)) await service.dispose()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-create-'))
  cleanups.push(root)
  return root
}

const MOCK_SERVER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n') }
rl.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }] } })
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
`

function host(overrides: Partial<ToolHost> = {}): ToolHost {
  return {
    root: 'ignored',
    remember: async () => ({ id: 'x' }),
    updatePlan: () => undefined,
    proposeSelfUpdate: async () => ({ version: 1 }),
    ...overrides,
  } as ToolHost
}

describe('create_skill tool', () => {
  it('is offered to the model as a write tool that does not arm the verification gate', () => {
    const skill = pilotTools.find((tool) => tool.name === CREATE_SKILL)
    expect(skill).toBeDefined()
    expect(skill?.risk).toBe('write')
    expect(skill?.noVerification).toBe(true)
    expect(Object.keys(skill?.inputSchema['properties'] as object)).toEqual(
      expect.arrayContaining(['name', 'description', 'body', 'whenToUse', 'overwrite']),
    )
    const mcpTool = pilotTools.find((tool) => tool.name === CREATE_MCP_SERVER)
    expect(mcpTool?.risk).toBe('write')
    expect(mcpTool?.noVerification).toBe(true)
  })

  it('writes SKILL.md and makes the skill readable in the same session', async () => {
    const root = await workspace()
    const skills = new SkillsService(root)
    expect(await skills.load()).toEqual([])

    const result = await executePilotTool(
      CREATE_SKILL,
      {
        name: 'release-desktop',
        description: 'Build and publish the Windows installer',
        whenToUse: 'when the user asks to release the desktop app',
        body: '## Steps\n\n1. Run `pnpm package:win`.\n2. Upload the installer.',
      },
      host({
        root,
        createSkill: async (input: CreateSkillInput) => {
          const created = await writeSkill(root, input)
          await skills.reload()
          return created
        },
        useSkill: async (name) => skills.read(name)?.body ?? null,
      }),
      signal,
    )

    expect(result.ok).toBe(true)
    expect(result.output).toContain('.pilot/skills/release-desktop/SKILL.md')
    expect(await skills.load()).toHaveLength(1)
    expect(skills.read('release-desktop')?.whenToUse).toBe(
      'when the user asks to release the desktop app',
    )

    const loaded = await executePilotTool(
      USE_SKILL,
      { name: 'release-desktop' },
      host({ root, useSkill: async (name) => skills.read(name)?.body ?? null }),
      signal,
    )
    expect(loaded.output).toContain('pnpm package:win')

    const raw = await readFile(join(root, '.pilot', 'skills', 'release-desktop', 'SKILL.md'), 'utf8')
    expect(raw.startsWith('---\nname: release-desktop\n')).toBe(true)
  })

  it('refuses a bad name, an empty body and a silent overwrite', async () => {
    const root = await workspace()
    await expect(
      writeSkill(root, { name: '../escape', description: 'x', body: 'y' }),
    ).rejects.toThrow(/Skill name must match/)
    await expect(
      writeSkill(root, { name: 'ok', description: 'x', body: '   ' }),
    ).rejects.toThrow(/body must be a non-empty/)
    await expect(
      writeSkill(root, { name: 'ok', description: '   ', body: 'y' }),
    ).rejects.toThrow(/description must be a non-empty/)
    await writeSkill(root, { name: 'ok', description: 'first', body: 'one' })
    await expect(
      writeSkill(root, { name: 'ok', description: 'second', body: 'two' }),
    ).rejects.toThrow(/already exists/)
    const replaced = await writeSkill(root, {
      name: 'ok',
      description: 'second',
      body: 'two',
      overwrite: true,
    })
    expect(replaced.overwritten).toBe(true)
  })

  it('builds frontmatter that the parser reads back, even with a multiline description', async () => {
    const text = buildSkillMarkdown({
      name: 'lint',
      description: 'Run\nthe   linter',
      body: '# Lint\n\nRun `pnpm lint`.',
    })
    const root = await workspace()
    await mkdir(join(root, '.pilot', 'skills', 'lint'), { recursive: true })
    await writeFile(join(root, '.pilot', 'skills', 'lint', 'SKILL.md'), text, 'utf8')
    const list = await new SkillsService(root).load()
    expect(list).toEqual([
      { name: 'lint', description: 'Run the linter' },
    ])
  })
})

describe('create_mcp_server tool', () => {
  it('writes a new server, keeps existing entries and connects it', async () => {
    const root = await workspace()
    await mkdir(join(root, '.pilot'), { recursive: true })
    await writeFile(
      join(root, '.pilot', 'mcp.json'),
      JSON.stringify({ servers: { keep: { command: 'node', args: ['keep.cjs'] } }, extra: 1 }),
      'utf8',
    )
    const script = join(root, 'mock.cjs')
    await writeFile(script, MOCK_SERVER, 'utf8')

    const saved = await saveMcpServer(root, {
      name: 'mock',
      command: process.execPath,
      args: [script],
      env: { MOCK_TOKEN: 'abc' },
      timeoutMs: 5_000,
    })
    expect(saved).toMatchObject({ name: 'mock', path: '.pilot/mcp.json', overwritten: false })
    expect(saved.servers.sort()).toEqual(['keep', 'mock'])

    const written = JSON.parse(await readFile(join(root, '.pilot', 'mcp.json'), 'utf8'))
    expect(written.extra).toBe(1)
    expect(written.servers.keep.command).toBe('node')
    expect(written.servers.mock).toMatchObject({
      command: process.execPath,
      args: [script],
      env: { MOCK_TOKEN: 'abc' },
      timeoutMs: 5_000,
    })

    const service = new McpService()
    children.push(service)
    const tools = await service.connectServer(root, 'mock')
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__mock__echo'])
    expect(service.has('mcp__mock__echo')).toBe(true)
  })

  it('exposes the new server tools through the tool call, without echoing env values', async () => {
    const root = await workspace()
    const script = join(root, 'mock.cjs')
    await writeFile(script, MOCK_SERVER, 'utf8')
    const service = new McpService()
    children.push(service)

    const result = await executePilotTool(
      CREATE_MCP_SERVER,
      {
        name: 'mock',
        command: process.execPath,
        args: [script],
        env: { MOCK_TOKEN: 'super-secret' },
        timeoutMs: 5000,
      },
      host({
        root,
        createMcpServer: async (input) => {
          const saved = await saveMcpServer(root, input)
          const added = await service.connectServer(root, saved.name)
          return { ...saved, enabled: true, tools: added.map((tool) => tool.name) }
        },
      }),
      signal,
    )

    expect(result.ok).toBe(true)
    expect(result.output).toContain('已添加 MCP 服务 mock')
    expect(result.output).toContain('mcp__mock__echo')
    expect(result.output).toContain('MOCK_TOKEN')
    expect(result.output).not.toContain('super-secret')
  })

  it('refuses an unsafe config: bad name, bad env key, duplicate name, unparseable JSON', async () => {
    const root = await workspace()
    await expect(
      saveMcpServer(root, { name: 'bad name', command: 'node' }),
    ).rejects.toThrow(/MCP server name must match/)
    await expect(
      saveMcpServer(root, { name: 'ok', command: '  ' }),
    ).rejects.toThrow(/command must be a non-empty/)
    await expect(
      saveMcpServer(root, { name: 'ok', command: 'node', env: { 'BAD-KEY': 'x' } }),
    ).rejects.toThrow(/Env key BAD-KEY/)

    await saveMcpServer(root, { name: 'ok', command: 'node' })
    await expect(saveMcpServer(root, { name: 'ok', command: 'other' })).rejects.toThrow(
      /already exists/,
    )
    const replaced = await saveMcpServer(root, {
      name: 'ok',
      command: 'other',
      overwrite: true,
    })
    expect(replaced.overwritten).toBe(true)

    await mkdir(join(root, '.pilot'), { recursive: true })
    await writeFile(join(root, '.pilot', 'mcp.json'), '{ not json', 'utf8')
    await expect(saveMcpServer(root, { name: 'second', command: 'node' })).rejects.toThrow(
      /not valid JSON/,
    )
  })

  it('keeps the config readable by loadMcpConfig after a write', async () => {
    const root = await workspace()
    await saveMcpServer(root, { name: 'a', command: 'node', args: ['a.cjs'], timeoutMs: 3_000 })
    await saveMcpServer(root, { name: 'b', command: 'node', args: ['b.cjs'] })
    const config = await loadMcpConfig(root)
    expect(Object.keys(config).sort()).toEqual(['a', 'b'])
    expect(config['a']).toMatchObject({ command: 'node', args: ['a.cjs'], timeoutMs: 3_000 })
    expect(config['b']?.timeoutMs).toBe(20_000)
  })
})

describe('run loop tool refresh', () => {
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

  it('offers a tool that appeared mid-run from the next step on', async () => {
    const base = [tool('read_file', 'read'), tool('update_plan', 'control')]
    const gained = [...base, tool('mcp__late__echo', 'exec')]
    let pulled = 0
    const model = scripted([
      response('', [call('c1', 'read_file', { path: 'a' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: base,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      pullTools: () => {
        pulled += 1
        return pulled >= 2 ? gained : base
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    const namesPerStep = model.requests.map((request: ModelRequest) =>
      request.tools.map((definition: AgentToolDefinition) => definition.name),
    )
    expect(namesPerStep[0]).not.toContain('mcp__late__echo')
    expect(namesPerStep[1]).toContain('mcp__late__echo')
  })

  it('notices a tool swap that keeps the count identical', async () => {
    const base = [tool('read_file', 'read'), tool('update_plan', 'control')]
    const before = [...base, tool('mcp__a__old', 'exec')]
    const after = [...base, tool('mcp__b__new', 'exec')]
    let pulled = 0
    const model = scripted([
      response('', [call('c1', 'read_file', { path: 'a' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: before,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      pullTools: () => {
        pulled += 1
        return pulled >= 2 ? after : before
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(result.status).toBe('completed')
    const namesPerStep = model.requests.map((request: ModelRequest) =>
      request.tools.map((definition: AgentToolDefinition) => definition.name),
    )
    expect(namesPerStep[0]).toContain('mcp__a__old')
    expect(namesPerStep[1]).toContain('mcp__b__new')
    expect(namesPerStep[1]).not.toContain('mcp__a__old')
  })

  it('appends new tools behind the ones already offered', async () => {
    const base = [tool('read_file', 'read'), tool('update_plan', 'control')]
    // The pulled list is reordered on purpose: a wholesale replacement would
    // move `update_plan` in front of `read_file` and lose the cached prefix.
    const gained = [
      tool('update_plan', 'control'),
      tool('read_file', 'read'),
      tool('mcp__late__echo', 'exec'),
      tool('mcp__late__ping', 'exec'),
    ]
    let pulled = 0
    const model = scripted([
      response('', [call('c1', 'read_file', { path: 'a' })]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: base,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      pullTools: () => {
        pulled += 1
        return pulled >= 2 ? gained : base
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const first = model.requests[0]!.tools
    const second = model.requests[1]!.tools
    expect(second.map((definition: AgentToolDefinition) => definition.name)).toEqual([
      'read_file',
      'update_plan',
      'mcp__late__echo',
      'mcp__late__ping',
    ])
    // The already-sent definitions keep their index and identity, so only the
    // appended tail is a cache miss.
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second[0]!).toBe(first[0]!)
    expect(second[1]!).toBe(first[1]!)
  })

  it('keeps the same tool array when the name set did not change', async () => {
    const base = [tool('read_file', 'read'), tool('update_plan', 'control')]
    let pulled = 0
    const model = scripted([
      response('', [call('c1', 'read_file', { path: 'a' })]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: base,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      // A fresh array of equivalent definitions each step, the shape an MCP
      // server list takes when nothing actually changed.
      pullTools: () => {
        pulled += 1
        return pulled >= 2 ? base.map((definition) => ({ ...definition })) : base
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    expect(model.requests[1]!.tools).toBe(model.requests[0]!.tools)
  })

  it('takes the new array when a tool disappears', async () => {
    const base = [tool('read_file', 'read'), tool('update_plan', 'control')]
    const withMcp = [...base, tool('mcp__gone__echo', 'exec')]
    let pulled = 0
    const model = scripted([
      response('', [call('c1', 'read_file', { path: 'a' })]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'go' }],
      tools: withMcp,
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      pullTools: () => {
        pulled += 1
        return pulled >= 2 ? base : withMcp
      },
      executeTool: async () => ({ ok: true, output: 'ok' }),
    })

    const names = model.requests[1]!.tools.map(
      (definition: AgentToolDefinition) => definition.name,
    )
    expect(names).toEqual(['read_file', 'update_plan'])
  })

  it('does not arm the verification gate for tools marked noVerification', async () => {
    const docs: AgentToolDefinition[] = [
      { ...tool('create_skill', 'write'), noVerification: true },
      tool('update_plan', 'control'),
    ]
    const model = scripted([
      response('', [call('c1', 'create_skill', { path: '.pilot/skills/x/SKILL.md' })]),
      response('done'),
    ])
    const result = await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'save a skill' }],
      tools: docs,
      maxSteps: 5,
      policy: () => 'auto',
      executeTool: async () => ({ ok: true, output: 'created', risk: 'write' }),
    })

    expect(result.status).toBe('completed')
    const prompted = model.requests
      .slice(1)
      .some((request: ModelRequest) =>
        request.messages.some((message) => message.content.includes('[验证检查]')),
      )
    expect(prompted).toBe(false)
  })
})

describe('run loop entry point hint', () => {
  function tool(name: string): AgentToolDefinition {
    return { name, description: name, inputSchema: { type: 'object', properties: {} }, risk: 'exec' }
  }
  function response(content: string, toolCalls: ToolCall[] = []): ModelResponse {
    return { content, toolCalls, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
  }
  function scripted(responses: ModelResponse[]): ModelClient & { requests: ModelRequest[] } {
    let index = 0
    const client = {
      requests: [] as ModelRequest[],
      async complete(request: ModelRequest): Promise<ModelResponse> {
        // The loop mutates one live `messages` array, so keep a per-step copy:
        // otherwise every recorded request shows the transcript as it is at the
        // end of the run and the assertions below would compare against it.
        client.requests.push({
          ...request,
          messages: request.messages.map((message) => ({ ...message })),
        })
        const next = responses[index]
        index += 1
        return next ?? response('done')
      },
    }
    return client
  }
  /** A workspace that ships both a run-tests.sh and package.json scripts. */
  async function project(): Promise<string> {
    const root = await workspace()
    await writeFile(join(root, 'run-tests.sh'), '#!/bin/sh\nexit 0\n')
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .', build: 'vite build' } }),
    )
    return root
  }
  function toolMessage(model: ModelClient & { requests: ModelRequest[] }, step: number) {
    const messages = model.requests[step]?.messages ?? []
    return messages.filter((message) => message.role === 'tool').at(-1)?.content ?? ''
  }

  it('names the project entry points when a command is not found', async () => {
    const root = await project()
    const model = scripted([
      response('', [{ id: 'c1', name: 'run_command', arguments: { command: 'python' } }]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'run the tests' }],
      tools: [tool('run_command')],
      maxSteps: 5,
      verificationGate: false,
      workspaceRoot: root,
      policy: () => 'auto',
      executeTool: async () => ({
        ok: false,
        output: '',
        error: 'Command failed with exit code 127 (command not found; check that it is installed and on PATH)',
        metadata: { exitCode: 127 },
      }),
    })

    const message = toolMessage(model, 1)
    // The failure itself is untouched: the hint is appended, nothing replaced.
    expect(message).toContain('ERROR: Command failed with exit code 127')
    expect(message).toContain('本项目可用入口：')
    expect(message).toContain('./run-tests.sh')
    expect(message).toContain('npm run test')
    expect(message).not.toContain('工具链不在 PATH')
  })

  it('adds the PATH line on the second not-found failure', async () => {
    const root = await project()
    const model = scripted([
      response('', [{ id: 'c1', name: 'run_command', arguments: { command: 'python', args: ['a'] } }]),
      response('', [{ id: 'c2', name: 'run_command', arguments: { command: 'python', args: ['b'] } }]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'run the tests' }],
      tools: [tool('run_command')],
      maxSteps: 6,
      verificationGate: false,
      workspaceRoot: root,
      policy: () => 'auto',
      executeTool: async () => ({
        ok: false,
        output: '',
        error: 'Command failed with exit code 9009 (command not found (Windows cmd))',
        metadata: { exitCode: 9009 },
      }),
    })

    const first = toolMessage(model, 1)
    const second = toolMessage(model, 2)
    expect(first).toContain('本项目可用入口：')
    expect(first).not.toContain('工具链不在 PATH')
    expect(second).toContain('本项目可用入口：')
    expect(second).toContain('工具链不在 PATH')
  })

  it('stays silent for ordinary failures and unknown workspaces', async () => {
    const root = await project()
    const model = scripted([
      response('', [{ id: 'c1', name: 'run_command', arguments: { command: 'npm', args: ['test'] } }]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'run the tests' }],
      tools: [tool('run_command')],
      maxSteps: 5,
      verificationGate: false,
      workspaceRoot: root,
      policy: () => 'auto',
      // Exit code 1 is a real test failure, not a missing toolchain: the hint
      // would be noise and would bury the actual error.
      executeTool: async () => ({
        ok: false,
        output: 'AssertionError: expected 2 to be 3',
        error: 'Command failed with exit code 1',
        metadata: { exitCode: 1 },
      }),
    })
    expect(toolMessage(model, 1)).not.toContain('本项目可用入口：')

    const noRoot = scripted([
      response('', [{ id: 'c2', name: 'run_command', arguments: { command: 'python' } }]),
      response('done'),
    ])
    await runAgentLoop({
      model: noRoot,
      messages: [{ role: 'user', content: 'run the tests' }],
      tools: [tool('run_command')],
      maxSteps: 5,
      verificationGate: false,
      policy: () => 'auto',
      executeTool: async () => ({
        ok: false,
        output: '',
        error: 'Command failed with exit code 127',
        metadata: { exitCode: 127 },
      }),
    })
    expect(toolMessage(noRoot, 1)).not.toContain('本项目可用入口：')
  })

  it('detects spawn ENOENT, which reports no exit code', async () => {
    const root = await project()
    const model = scripted([
      response('', [{ id: 'c1', name: 'run_command', arguments: { command: 'pytest' } }]),
      response('done'),
    ])
    await runAgentLoop({
      model,
      messages: [{ role: 'user', content: 'run the tests' }],
      tools: [tool('run_command')],
      maxSteps: 5,
      verificationGate: false,
      workspaceRoot: root,
      policy: () => 'auto',
      executeTool: async () => ({
        ok: false,
        output: '',
        error: 'Failed to start "pytest" (working directory: /tmp/x): spawn pytest ENOENT',
        metadata: { exitCode: null },
      }),
    })
    expect(toolMessage(model, 1)).toContain('本项目可用入口：')
  })
})
