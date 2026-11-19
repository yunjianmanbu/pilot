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
