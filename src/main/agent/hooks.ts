import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentToolDefinition, ToolCall } from '../../shared/types'
import { runCommand } from '../workspace'

export interface HookCommand {
  /** Tool name to match, or "*" for every tool. pre_tool only. */
  tool?: string
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
  /** pre_tool: a non-zero exit blocks the call unless this is false. */
  block?: boolean
}

export interface HookConfig {
  pre_tool: HookCommand[]
  post_edit: HookCommand[]
  stop: HookCommand[]
}

export interface HookOutcome {
  blocked: boolean
  output: string
}

const EMPTY: HookConfig = { pre_tool: [], post_edit: [], stop: [] }
const MAX_HOOKS = 50
const MAX_OUTPUT_CHARS = 4_000

function sanitizeCommand(value: unknown): HookCommand | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const command = typeof record['command'] === 'string' ? record['command'].trim() : ''
  if (!command || command.length > 500 || command.includes('\0')) return null
  const args = Array.isArray(record['args'])
    ? record['args']
        .filter((item): item is string => typeof item === 'string' && !item.includes('\0'))
        .slice(0, 100)
    : []
  return {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(typeof record['tool'] === 'string' && record['tool'].trim()
      ? { tool: record['tool'].trim().slice(0, 100) }
      : {}),
    ...(typeof record['cwd'] === 'string' && record['cwd'].trim()
      ? { cwd: record['cwd'].trim() }
      : {}),
    ...(typeof record['timeoutMs'] === 'number' && Number.isFinite(record['timeoutMs'])
      ? { timeoutMs: Math.min(600_000, Math.max(1_000, Math.round(record['timeoutMs']))) }
      : {}),
    ...(record['block'] === false ? { block: false } : {}),
  }
}

function sanitizeList(value: unknown): HookCommand[] {
  if (!Array.isArray(value)) return []
  return value
    .map(sanitizeCommand)
    .filter((hook): hook is HookCommand => hook !== null)
    .slice(0, MAX_HOOKS)
}

export async function loadHookConfig(root: string): Promise<HookConfig> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(root, '.pilot', 'hooks.json'), 'utf8'))
  } catch {
    return { ...EMPTY }
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY }
  const record = parsed as Record<string, unknown>
  return {
    pre_tool: sanitizeList(record['pre_tool']),
    post_edit: sanitizeList(record['post_edit']),
    stop: sanitizeList(record['stop']),
  }
}

function matches(hook: HookCommand, toolName: string): boolean {
  return hook.tool === undefined || hook.tool === '*' || hook.tool === toolName
}

function clip(text: string): string {
  const clean = text.trim()
  return clean.length > MAX_OUTPUT_CHARS ? `${clean.slice(0, MAX_OUTPUT_CHARS)}…` : clean
}

/**
 * Workspace hooks are argv commands, never shell strings, and only run when
 * the user explicitly enables hooks in settings. Enabling hooks trusts the
 * workspace's `.pilot/hooks.json`.
 */
export class HookService {
  private config: HookConfig = { ...EMPTY }
  private loaded = false

  constructor(
    private readonly root: string,
    private readonly enabled: boolean,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.enabled) return
    this.config = await loadHookConfig(this.root)
  }

  get active(): boolean {
    return (
      this.enabled &&
      (this.config.pre_tool.length > 0 ||
        this.config.post_edit.length > 0 ||
        this.config.stop.length > 0)
    )
  }

  /** Run matching pre-tool hooks. The first blocking failure stops the call. */
  async beforeTool(
    call: ToolCall,
    tool: AgentToolDefinition,
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    if (!this.active) return { blocked: false, output: '' }
    const outputs: string[] = []
    for (const hook of this.config.pre_tool) {
      if (!matches(hook, tool.name)) continue
      const result = await this.run(hook, signal)
      if (result.output) outputs.push(result.output)
      if (!result.ok && hook.block !== false) {
        return {
          blocked: true,
          output: `[pre_tool hook failed: ${hook.command}]\n${clip(result.output)}`,
        }
      }
    }
    return { blocked: false, output: outputs.join('\n') }
  }

  /** Run post-edit hooks and return their combined output for the tool result. */
  async afterEdit(_call: ToolCall, signal: AbortSignal): Promise<string | null> {
    if (!this.active || this.config.post_edit.length === 0) return null
    const outputs: string[] = []
    for (const hook of this.config.post_edit) {
      const result = await this.run(hook, signal)
      if (result.output) {
        outputs.push(`[post_edit ${result.ok ? 'ok' : 'failed'}: ${hook.command}]\n${clip(result.output)}`)
      }
    }
    return outputs.length > 0 ? outputs.join('\n') : null
  }

  /** Run stop hooks after the run settles; failures never fail the run. */
  async stop(signal: AbortSignal): Promise<string | null> {
    if (!this.active || this.config.stop.length === 0) return null
    const outputs: string[] = []
    for (const hook of this.config.stop) {
      const result = await this.run(hook, signal)
      if (result.output) {
        outputs.push(`[stop ${result.ok ? 'ok' : 'failed'}: ${hook.command}]\n${clip(result.output)}`)
      }
    }
    return outputs.length > 0 ? outputs.join('\n') : null
  }

  private async run(
    hook: HookCommand,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; output: string }> {
    try {
      const result = await runCommand(
        this.root,
        {
          command: hook.command,
          ...(hook.args ? { args: hook.args } : {}),
          ...(hook.cwd ? { cwd: hook.cwd } : {}),
          ...(hook.timeoutMs ? { timeoutMs: hook.timeoutMs } : {}),
        },
        signal,
      )
      return { ok: result.ok, output: result.output }
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
