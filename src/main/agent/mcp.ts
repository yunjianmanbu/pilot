import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentToolDefinition, ToolResult } from '../../shared/types'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
}

export interface McpToolSummary {
  server: string
  tool: string
  name: string
  description: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const MAX_SERVERS = 10
const DEFAULT_TIMEOUT = 20_000
const MAX_TOOLS = 200
const MAX_CALL_OUTPUT_CHARS = 200_000
const PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_ARGS = 64
const MAX_ENV = 32

export interface McpServerInput {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  /** Replace an existing server with the same name. Off by default. */
  overwrite?: boolean
}

export interface SavedMcpServer {
  name: string
  /** Workspace-relative path of the written config. */
  path: string
  /** Every server listed after the write. */
  servers: string[]
  overwritten: boolean
}

function singleLine(value: string, label: string, max: number): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} must be a single line.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${label} is too long (limit ${max} characters).`)
  return trimmed
}

function sanitizeName(value: string, maxLength = 32): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxLength)
}

/** Keep MCP tool names under 64 chars without silently merging long names. */
function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const name = sanitizeName(raw, 64)
  if (name.length === raw.length) return name
  const digest = createHash('sha1').update(raw).digest('hex').slice(0, 8)
  return `${name.slice(0, 55)}_${digest}`
}

export async function loadMcpConfig(root: string): Promise<Record<string, McpServerConfig>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(root, '.pilot', 'mcp.json'), 'utf8'))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as Record<string, unknown>
  const servers = record['servers']
  if (!servers || typeof servers !== 'object') return {}
  const result: Record<string, McpServerConfig> = {}
  for (const [name, value] of Object.entries(servers as Record<string, unknown>).slice(0, MAX_SERVERS)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const command = typeof entry['command'] === 'string' ? entry['command'].trim() : ''
    if (!command || command.includes('\0') || command.length > 500) continue
    const args = Array.isArray(entry['args'])
      ? entry['args']
          .filter((item): item is string => typeof item === 'string' && !item.includes('\0'))
          .slice(0, 100)
      : []
    const env: Record<string, string> = {}
    if (entry['env'] && typeof entry['env'] === 'object') {
      for (const [key, raw] of Object.entries(entry['env'] as Record<string, unknown>).slice(0, 50)) {
        if (typeof raw === 'string' && !raw.includes('\0')) env[key] = raw
      }
    }
    const timeoutMs =
      typeof entry['timeoutMs'] === 'number' && Number.isFinite(entry['timeoutMs'])
        ? Math.min(120_000, Math.max(1_000, Math.round(entry['timeoutMs'])))
        : DEFAULT_TIMEOUT
    result[sanitizeName(name)] = {
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof entry['cwd'] === 'string' && entry['cwd'].trim()
        ? { cwd: entry['cwd'].trim() }
        : {}),
      timeoutMs,
    }
  }
  return result
}

/**
 * Add or replace one stdio server in `.pilot/mcp.json`, keeping every other
 * key and server in the file. An existing server and an unparseable file are
 * both refused unless explicitly allowed so a working setup is never lost
 * silently.
 */
export async function saveMcpServer(
  root: string,
  input: McpServerInput,
): Promise<SavedMcpServer> {
  const name = input.name.trim()
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(
      'MCP server name must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ (letters, digits, - and _).',
    )
  }
  const command = singleLine(input.command, 'MCP server command', 500)
  if (!command) throw new Error('MCP server command must be a non-empty string.')
  const rawArgs = input.args ?? []
  if (!Array.isArray(rawArgs)) throw new Error('args must be an array of strings.')
  if (rawArgs.length > MAX_ARGS) throw new Error(`At most ${MAX_ARGS} arguments are supported.`)
  const args = rawArgs.map((arg, index) => {
    if (typeof arg !== 'string') throw new Error(`Argument ${index} must be a string.`)
    return singleLine(arg, `Argument ${index}`, 1_000)
  })
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (!ENV_NAME_PATTERN.test(key)) {
      throw new Error(`Env key ${key} must match ^[A-Za-z_][A-Za-z0-9_]*$.`)
    }
    if (typeof value !== 'string') throw new Error(`Env value for ${key} must be a string.`)
    env[key] = singleLine(value, `Env value for ${key}`, 4_000)
  }
  if (Object.keys(env).length > MAX_ENV) {
    throw new Error(`At most ${MAX_ENV} environment variables are supported.`)
  }
  const timeoutMs = Math.round(
    Math.min(120_000, Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT)),
  )
  const cwd = input.cwd ? singleLine(input.cwd, 'Working directory', 1_000) : ''

  const file = join(root, '.pilot', 'mcp.json')
  let raw: string | null = null
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    raw = null
  }
  let config: Record<string, unknown> = {}
  if (raw && raw.trim()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('.pilot/mcp.json is not valid JSON; fix or delete it before adding a server.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('.pilot/mcp.json must contain a JSON object.')
    }
    config = parsed as Record<string, unknown>
  }
  const currentServers = config['servers']
  const servers: Record<string, unknown> =
    currentServers && typeof currentServers === 'object' && !Array.isArray(currentServers)
      ? { ...(currentServers as Record<string, unknown>) }
      : {}
  const existed = Object.prototype.hasOwnProperty.call(servers, name)
  if (existed && input.overwrite !== true) {
    throw new Error(
      `MCP server ${name} already exists in .pilot/mcp.json. Pass overwrite=true to replace it.`,
    )
  }
  if (!existed && Object.keys(servers).length >= MAX_SERVERS) {
    throw new Error(`.pilot/mcp.json already lists ${MAX_SERVERS} servers; remove one first.`)
  }
  servers[name] = {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    timeoutMs,
  }
  await mkdir(join(root, '.pilot'), { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...config, servers }, null, 2)}\n`, 'utf8')
  return { name, path: '.pilot/mcp.json', servers: Object.keys(servers), overwritten: existed }
}

class McpClient {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private stderr = ''
  private closed = false
  private exited = false
  private exitWaiters: Array<() => void> = []

  constructor(
    private readonly server: string,
    private readonly config: McpServerConfig,
    cwd: string,
  ) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd ?? cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000)
    })
    this.child.on('exit', (code) => this.onExit(code))
    this.child.on('error', (error) => this.failAll(error))
  }

  async initialize(): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'pilot', version: '0.1.14' },
      },
      this.timeout(2),
    )
    this.notify('notifications/initialized', {})
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const tools: Array<{ name: string; description: string; inputSchema: unknown }> = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = (await this.request(
        'tools/list',
        cursor ? { cursor } : {},
        this.timeout(1),
      )) as { tools?: unknown; nextCursor?: unknown }
      const items = Array.isArray(result?.tools) ? result.tools : []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const tool = item as Record<string, unknown>
        if (typeof tool['name'] !== 'string' || !tool['name']) continue
        tools.push({
          name: tool['name'],
          description: typeof tool['description'] === 'string' ? tool['description'] : '',
          inputSchema: tool['inputSchema'] ?? { type: 'object', properties: {} },
        })
        if (tools.length >= MAX_TOOLS) return tools
      }
      if (typeof result?.nextCursor !== 'string' || !result.nextCursor) break
      cursor = result.nextCursor
    }
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = (await this.request(
      'tools/call',
      { name, arguments: args },
      this.timeout(4),
    )) as {
      content?: unknown
      isError?: unknown
      structuredContent?: unknown
    }
    const parts: string[] = []
    let outputChars = 0
    const push = (text: string): void => {
      if (outputChars >= MAX_CALL_OUTPUT_CHARS) return
      const clipped = text.slice(0, MAX_CALL_OUTPUT_CHARS - outputChars)
      parts.push(clipped)
      outputChars += clipped.length
    }
    if (Array.isArray(result?.content)) {
      for (const item of result.content.slice(0, 100)) {
        if (!item || typeof item !== 'object') continue
        const block = item as Record<string, unknown>
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          push(block['text'])
        } else if (block['type'] === 'resource' && typeof block['resource'] === 'object') {
          const resource = block['resource'] as Record<string, unknown>
          if (typeof resource['text'] === 'string') push(resource['text'])
        } else {
          push(JSON.stringify(block))
        }
      }
    }
    if (result?.structuredContent !== undefined) {
      push(JSON.stringify(result.structuredContent, null, 2))
    }
    const ok = result?.isError !== true
    return {
      ok,
      output: parts.join('\n') || '(no output)',
      ...(ok ? {} : { error: 'MCP tool reported an error' }),
    }
  }

  async dispose(): Promise<void> {
    if (this.closed && this.exited) return
    this.closed = true
    this.failAll(new Error(`MCP server ${this.server} closed`))
    if (!this.exited) {
      const exited = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000)
        this.exitWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      try {
        this.child.kill()
      } catch {
        // Best effort.
      }
      await exited
    }
  }

  private timeout(multiplier: number): number {
    return Math.min(120_000, (this.config.timeoutMs ?? DEFAULT_TIMEOUT) * multiplier)
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`MCP server ${this.server} is closed`))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${this.server} ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch {
      // Notifications are best-effort.
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (!message || typeof message !== 'object') continue
      const record = message as Record<string, unknown>
      if (typeof record['id'] !== 'number') continue
      const pending = this.pending.get(record['id'])
      if (!pending) continue
      this.pending.delete(record['id'])
      clearTimeout(pending.timer)
      if (record['error']) {
        const error = record['error'] as Record<string, unknown>
        pending.reject(
          new Error(
            typeof error['message'] === 'string' ? String(error['message']) : 'MCP request failed',
          ),
        )
      } else {
        pending.resolve(record['result'])
      }
    }
  }

  private onExit(code: number | null): void {
    this.closed = true
    this.exited = true
    for (const waiter of this.exitWaiters.splice(0)) waiter()
    const detail = this.stderr.trim()
    this.failAll(
      new Error(
        `MCP server ${this.server} exited (${code ?? 'unknown'})${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      ),
    )
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

/**
 * Minimal stdio MCP client. Servers come from `.pilot/mcp.json` and only run
 * when the user enables MCP in settings. Every exposed tool is marked exec +
 * alwaysAsk, so a connected server cannot bypass the per-call approval gate.
 */
export class McpService {
  private clients = new Map<string, McpClient>()
  private tools = new Map<string, { server: string; client: McpClient; tool: string }>()
  private definitions: AgentToolDefinition[] = []
  private errors: string[] = []

  async connect(root: string): Promise<void> {
    const config = await loadMcpConfig(root)
    for (const [server, serverConfig] of Object.entries(config)) {
      const client = new McpClient(server, serverConfig, root)
      try {
        await client.initialize()
        const tools = await client.listTools()
        if (tools.length === 0) {
          await client.dispose()
          continue
        }
        this.clients.set(server, client)
        this.register(server, client, tools)
      } catch (error) {
        this.errors.push(
          `${server}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
        )
        await client.dispose()
      }
    }
  }

  /**
   * Connect one configured server and return the tools it exposed. Used when
   * the agent adds a server while a run is in progress: a failure is thrown so
   * the tool result can report it instead of silently exposing nothing.
   */
  async connectServer(root: string, server: string): Promise<AgentToolDefinition[]> {
    const existing = this.clients.get(server)
    if (existing) {
      const stale = [...this.tools.entries()]
        .filter(([, entry]) => entry.server === server)
        .map(([name]) => name)
      for (const name of stale) this.tools.delete(name)
      if (stale.length > 0) {
        this.definitions = this.definitions.filter((definition) => !stale.includes(definition.name))
      }
      this.clients.delete(server)
      await existing.dispose().catch(() => undefined)
    }
    const config = await loadMcpConfig(root)
    const serverConfig = config[server]
    if (!serverConfig) {
      throw new Error(`MCP server ${server} is not configured in .pilot/mcp.json`)
    }
    const client = new McpClient(server, serverConfig, root)
    try {
      await client.initialize()
      const tools = await client.listTools()
      if (tools.length === 0) {
        await client.dispose()
        return []
      }
      this.clients.set(server, client)
      return this.register(server, client, tools)
    } catch (error) {
      await client.dispose().catch(() => undefined)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private register(
    server: string,
    client: McpClient,
    tools: Array<{ name: string; description: string; inputSchema: unknown }>,
  ): AgentToolDefinition[] {
    const added: AgentToolDefinition[] = []
    for (const tool of tools) {
      const name = mcpToolName(server, tool.name)
      if (this.tools.has(name)) continue
      this.tools.set(name, { server, client, tool: tool.name })
      const definition: AgentToolDefinition = {
        name,
        description: `[MCP ${server}] ${tool.description || tool.name}`.slice(0, 1_000),
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
        risk: 'exec',
        alwaysAsk: true,
        source: 'mcp',
      }
      this.definitions.push(definition)
      added.push(definition)
    }
    return added
  }

  listTools(): AgentToolDefinition[] {
    return [...this.definitions]
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name)
    if (!entry) return { ok: false, output: '', error: `Unknown MCP tool: ${name}` }
    try {
      const result = await entry.client.callTool(entry.tool, args)
      result.risk = 'exec'
      return result
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: `MCP ${entry.server}/${entry.tool}: ${error instanceof Error ? error.message : String(error)}`,
        risk: 'exec',
      }
    }
  }

  connectionErrors(): string[] {
    return [...this.errors]
  }

  async dispose(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map((client) => client.dispose()))
  }
}
