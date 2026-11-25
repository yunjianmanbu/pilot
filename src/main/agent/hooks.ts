import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentToolDefinition, ToolCall } from '../../shared/types'
import { runCommand } from '../workspace'
import { evaluateHookRules, loadHookRules, type HookRule } from './hook-rules'

export interface HookCommand {
  /** Tool name to match: one name, `*`, or a `a|b` alternation. */
  tool?: string
  /**
   * Glob (`*` wildcard, case-insensitive) on the call's argument text, so a
   * hook only spawns for the calls it cares about: `"*git commit*"` instead of
   * every shell call. Keeps unrelated tool calls free of process spawns.
   */
  match?: string
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
const MAX_MATCH_CHARS = 200
/**
 * A hook is an auxiliary check, so it gets a shorter budget than a normal
 * command: a hung lint script must not add two minutes to every single tool
 * call. `timeoutMs` in hooks.json still overrides this per hook.
 */
const DEFAULT_TIMEOUT_MS = 60_000

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
    ...(typeof record['match'] === 'string' && record['match'].trim()
      ? { match: record['match'].trim().slice(0, MAX_MATCH_CHARS) }
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

/** One line of the call's argument values, used by `match` globs. */
function argumentText(call: ToolCall): string {
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value))
    else if (Array.isArray(value)) value.forEach(push)
    else if (value && typeof value === 'object') parts.push(JSON.stringify(value))
  }
  for (const value of Object.values(call.arguments ?? {})) push(value)
  return parts.join(' ')
}

function globMatches(pattern: string, text: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  try {
    return new RegExp(source, 'i').test(text)
  } catch {
    return false
  }
}

function matches(hook: HookCommand, call: ToolCall, text: string): boolean {
  if (hook.tool !== undefined && !toolMatches(hook.tool, call.name)) return false
  if (hook.match && !globMatches(hook.match, text)) return false
  return true
}

/** `tool` is one name, `*`, or a `a|b` alternation (same shape as hook matchers). */
function toolMatches(pattern: string, name: string): boolean {
  return pattern
    .split('|')
    .map((part) => part.trim())
    .some((part) => part === '' || part === '*' || part === name)
}

function clip(text: string): string {
  const clean = text.trim()
  return clean.length > MAX_OUTPUT_CHARS ? `${clean.slice(0, MAX_OUTPUT_CHARS)}…` : clean
}

/**
 * Workspace hooks are argv commands, never shell strings, and only run when
 * the user explicitly enables hooks in settings. Enabling hooks trusts the
 * workspace's `.pilot/hooks.json` and its `.pilot/hooks/*.md` rules.
 */
export class HookService {
  private config: HookConfig = { ...EMPTY }
  private rules: HookRule[] = []
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
    this.rules = await loadHookRules(this.root).catch(() => [])
  }

  /** Declarative rules currently in effect, for diagnostics and tests. */
  get activeRules(): HookRule[] {
    return this.rules
  }

  get active(): boolean {
    return (
      this.enabled &&
      (this.config.pre_tool.length > 0 ||
        this.config.post_edit.length > 0 ||
        this.config.stop.length > 0 ||
        this.rules.some((rule) => rule.enabled))
    )
  }

  /**
   * Declarative rules that match a tool call. `bash` rules only see shell
   * calls, `tool` rules see every call, `file` rules see edits.
   */
  private callRules(call: ToolCall, text: string): { warnings: string[]; blocked: string | null } {
    if (!this.enabled || this.rules.length === 0) return { warnings: [], blocked: null }
    const events = ['tool']
    if (call.name === 'run_shell' || call.name === 'run_command') events.push('bash')
    if (call.name === 'write_file' || call.name === 'apply_patch') events.push('file')
    const warnings: string[] = []
    let blocked: string | null = null
    for (const event of events) {
      const outcome = evaluateHookRules(this.rules, event as 'tool' | 'bash' | 'file', text)
      warnings.push(...outcome.warnings)
      if (blocked === null && outcome.blocked) blocked = outcome.blocked
    }
    return { warnings, blocked }
  }

  /** Run matching pre-tool hooks. The first blocking failure stops the call. */
  async beforeTool(
    call: ToolCall,
    _tool: AgentToolDefinition,
    signal: AbortSignal,
  ): Promise<HookOutcome> {
    if (!this.active) return { blocked: false, output: '' }
    const text = argumentText(call)
    const ruled = this.callRules(call, text)
    if (ruled.blocked !== null) {
      return { blocked: true, output: `[rule blocked ${call.name}]\n${ruled.blocked}` }
    }
    const outputs: string[] = [...ruled.warnings]
    for (const hook of this.config.pre_tool) {
      if (!matches(hook, call, text)) continue
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
  async afterEdit(call: ToolCall, signal: AbortSignal): Promise<string | null> {
    if (!this.active || this.config.post_edit.length === 0) return null
    const outputs: string[] = []
    // `file` rules already ran in beforeTool against the same arguments, so
    // they are not evaluated again here; only commands run after the write.
    const text = argumentText(call)
    for (const hook of this.config.post_edit) {
      if (!matches(hook, call, text)) continue
      const result = await this.run(hook, signal)
      if (result.output) {
        outputs.push(
          `[post_edit ${result.ok ? 'ok' : 'failed'}: ${hook.command}]\n${clip(result.output)}`,
        )
      }
    }
    return outputs.length > 0 ? outputs.join('\n') : null
  }

  /**
   * Run stop hooks after the run settles; failures never fail the run.
   * `subject` is the final assistant message, which `event: stop` rules match.
   */
  async stop(signal: AbortSignal, subject = ''): Promise<string | null> {
    if (!this.active) return null
    const outputs: string[] = []
    if (this.rules.length > 0 && subject) {
      const ruled = evaluateHookRules(this.rules, 'stop', subject)
      outputs.push(...ruled.warnings)
    }
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
          timeoutMs: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
