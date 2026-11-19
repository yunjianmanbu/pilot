import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMcpConfig, McpService } from '../src/main/agent/mcp'

const cleanups: string[] = []
const children: McpService[] = []

afterEach(async () => {
  for (const service of children.splice(0)) await service.dispose()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

const SERVER_SCRIPT = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
rl.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + message.params.arguments.text }] } })
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})
`

async function workspaceWithMcp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-mcp-'))
  cleanups.push(root)
  await mkdir(join(root, '.pilot'), { recursive: true })
  const script = join(root, 'mock-mcp.cjs')
  await writeFile(script, SERVER_SCRIPT, 'utf8')
  await writeFile(
    join(root, '.pilot', 'mcp.json'),
    JSON.stringify({
      servers: {
        mock: { command: process.execPath, args: [script], timeoutMs: 5_000 },
      },
    }),
    'utf8',
  )
  return root
}

describe('loadMcpConfig', () => {
  it('sanitizes server names and drops invalid entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-mcp-'))
    cleanups.push(root)
    await mkdir(join(root, '.pilot'), { recursive: true })
    await writeFile(
      join(root, '.pilot', 'mcp.json'),
      JSON.stringify({
        servers: {
          'my server': { command: 'node', args: [1, 'ok'], env: { TOKEN: 'x' }, timeoutMs: 1 },
          broken: { command: '' },
        },
      }),
      'utf8',
    )
    const config = await loadMcpConfig(root)
    expect(Object.keys(config)).toEqual(['my_server'])
    expect(config['my_server']).toMatchObject({
      command: 'node',
      args: ['ok'],
      env: { TOKEN: 'x' },
      timeoutMs: 1_000,
    })
  })
})

describe('McpService', () => {
  it('connects, lists tools and calls one over stdio', async () => {
    const root = await workspaceWithMcp()
    const service = new McpService()
    children.push(service)
    await service.connect(root)

    expect(service.connectionErrors()).toEqual([])
    const tools = service.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      name: 'mcp__mock__echo',
      risk: 'exec',
      alwaysAsk: true,
      source: 'mcp',
    })
    expect(service.has('mcp__mock__echo')).toBe(true)

    const result = await service.call('mcp__mock__echo', { text: 'hello' })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('echo:hello')
  })

  it('records a connection error and exposes no tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-mcp-'))
    cleanups.push(root)
    await mkdir(join(root, '.pilot'), { recursive: true })
    await writeFile(
      join(root, '.pilot', 'mcp.json'),
      JSON.stringify({
        servers: { broken: { command: 'pilot-definitely-missing-command', timeoutMs: 2_000 } },
      }),
      'utf8',
    )
    const service = new McpService()
    children.push(service)
    await service.connect(root)
    expect(service.listTools()).toEqual([])
    expect(service.connectionErrors()).toHaveLength(1)
  })
})
