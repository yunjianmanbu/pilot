import type {
  AgentToolDefinition,
  DynamicToolInfo,
  ToolCatalogEntry,
  ToolCatalogSource,
} from './types'

export interface ToolCatalogInput {
  /**
   * Builtin and control tools a run would offer right now. Shell and learning
   * filters are applied by the caller so the catalog matches reality instead of
   * listing every tool that exists in code.
   */
  builtin: AgentToolDefinition[]
  /** Agent-written tools of this workspace, approved or not. */
  dynamic: DynamicToolInfo[]
  /** Server names from `.pilot/mcp.json`; their tools only exist after connect. */
  mcpServers: string[]
  /** MCP is off by default; when off the servers are listed as disabled. */
  mcpEnabled: boolean
}

/**
 * One flat list for the "available tools" preview: builtin, control, MCP and
 * agent-written tools in a single shape. Nothing here reads a secret — MCP env
 * vars never leave the main process, only the server name does.
 */
export function buildToolCatalog(input: ToolCatalogInput): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = []
  for (const tool of input.builtin) {
    const source: ToolCatalogSource = tool.source === 'control' ? 'control' : 'builtin'
    entries.push({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      source,
    })
  }
  for (const server of input.mcpServers) {
    entries.push({
      name: server,
      // The per-tool list only exists after the server connects, so the catalog
      // names the server instead of pretending to know its tools.
      description: input.mcpEnabled
        ? 'MCP server: its own tools are added after the server connects at run start.'
        : 'MCP server: skipped because MCP is turned off in Settings.',
      risk: 'exec',
      source: 'mcp',
      server,
      enabled: input.mcpEnabled,
    })
  }
  for (const tool of input.dynamic) {
    entries.push({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      source: 'dynamic',
      enabled: tool.enabled,
      approved: tool.approved,
      version: tool.version,
      targets: tool.targets,
      inputSchema: tool.inputSchema,
    })
  }
  return entries
}