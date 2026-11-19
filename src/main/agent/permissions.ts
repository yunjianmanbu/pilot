import { isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentToolDefinition,
  ApprovalMode,
  PermissionRules,
  ToolCall,
} from '../../shared/types'
import { detectUploadVector } from './learning'

export type PermissionAction = 'allow' | 'ask' | 'deny' | 'classify'

export interface PermissionVerdict {
  action: PermissionAction
  reason: string
  source: 'rule' | 'mode' | 'protected' | 'sandbox'
  rule?: string
}

export interface PermissionInput {
  mode: ApprovalMode
  tool: AgentToolDefinition
  call: ToolCall
  workspacePath: string
  rules: PermissionRules
  /** True when the command will execute inside an OS sandbox. */
  sandboxed: boolean
  /** Auto-approve commands that are actually confined by the sandbox. */
  sandboxAutoAllow: boolean
  /** Exact command lines the user chose to always allow. */
  trustedCommands?: string[]
  /**
   * User-enabled exemption for unattended personal builds. Only `auto` mode
   * honours it; every manual mode still asks or denies.
   */
  allowUnattendedBuild?: boolean
  /**
   * 学习探索已开启：带上传意图的 shell 命令一律拒绝，
   * 让「产物不出域、不上传互联网」在权限层生效。
   */
  learningMode?: boolean
  /**
   * 用户在设置里同时开启了“学习探索期间让 shell 断网”。只有这个开关打开时，
   * 学习模式才会接管 shell 的联网与外发；默认关，任务会话按常规审批运行。
   */
  learningIsolateShell?: boolean
}

type RuleDecision = 'allow' | 'ask' | 'deny'

interface ParsedRule {
  raw: string
  tool: string
  specifier: string | null
  decision: RuleDecision
}

const READ_TOOL_NAMES = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'get_file_info',
  'git_status',
  'git_diff',
  'git_log',
  'repo_map',
])
const EDIT_TOOL_NAMES = new Set(['write_file', 'apply_patch'])
const SHELL_TOOL_NAMES = new Set(['run_shell', 'run_command'])
const FILE_TOOL_NAMES = new Set([...READ_TOOL_NAMES, ...EDIT_TOOL_NAMES])

const TOOL_ALIASES: Record<string, Set<string>> = {
  Bash: SHELL_TOOL_NAMES,
  Read: READ_TOOL_NAMES,
  Edit: EDIT_TOOL_NAMES,
  Write: new Set(['write_file']),
}

/** Configuration files an agent must not rewrite even with an allow rule. */
const PROTECTED_PATHS = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.claude(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
  /(^|\/)\.pilot(\/|$)/i,
  /(^|\/)\.bashrc$/i,
  /(^|\/)\.zshrc$/i,
  /(^|\/)\.bash_profile$/i,
  /(^|\/)\.profile$/i,
  /(^|\/)\.config\/fish\/config\.fish$/i,
]

const READ_ONLY_COMMANDS = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'which',
  'where',
  'whoami',
  'hostname',
  'echo',
  'tree',
])

const ACCEPT_EDIT_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'mv', 'cp'])

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function comparePath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Glob with `*`, `?` and `**`; command patterns also treat `:*` as `*`. */
export function globToRegExp(glob: string, pathMode = true): RegExp {
  const normalized = glob.replace(/:([*])/g, '$1')
  let output = '^'
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (pathMode && normalized[index + 2] === '/') {
          output += '(?:.*/)?'
          index += 2
        } else {
          output += '.*'
          index += 1
        }
      } else {
        output += pathMode ? '[^/]*' : '.*'
      }
    } else if (char === '?') {
      output += pathMode ? '[^/]' : '.'
    } else {
      output += escapeRegExp(char ?? '')
    }
  }
  return new RegExp(`${output}$`, process.platform === 'win32' ? 'i' : '')
}

function parseRule(raw: string, decision: RuleDecision): ParsedRule | null {
  const text = raw.trim()
  if (!text) return null
  const open = text.indexOf('(')
  if (open === -1) {
    return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(text)
      ? { raw: text, tool: text, specifier: null, decision }
      : null
  }
  if (!text.endsWith(')')) return null
  const tool = text.slice(0, open).trim()
  const specifier = text.slice(open + 1, -1).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(tool) || !specifier) return null
  return { raw: text, tool, specifier, decision }
}

function ruleMatchesTool(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true
  return TOOL_ALIASES[ruleTool]?.has(toolName) ?? false
}

function toolPath(args: Record<string, unknown>): string | null {
  return typeof args['path'] === 'string' ? normalizePath(args['path']) : null
}

export function commandLine(args: Record<string, unknown>): string {
  const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
  const extra = Array.isArray(args['args']) ? args['args'].map(String).join(' ') : ''
  return `${command}${extra ? ` ${extra}` : ''}`.trim()
}

function normalizeRulePath(specifier: string, workspacePath: string): string {
  const normalized = normalizePath(specifier)
  if (!isAbsolute(normalized)) return normalized
  const rel = relative(workspacePath, resolve(normalized))
  return rel.startsWith('..') ? normalized : normalizePath(rel)
}

function ruleMatchesSpecifier(
  toolName: string,
  specifier: string,
  args: Record<string, unknown>,
  workspacePath: string,
): boolean {
  if (SHELL_TOOL_NAMES.has(toolName)) {
    return globToRegExp(specifier, false).test(commandLine(args))
  }
  if (FILE_TOOL_NAMES.has(toolName)) {
    const path = toolPath(args)
    if (path === null) return false
    const wanted = normalizeRulePath(specifier, workspacePath)
    return globToRegExp(wanted, true).test(comparePath(path))
  }
  return false
}

function broadExecAllow(rule: ParsedRule, toolName: string): boolean {
  if (!SHELL_TOOL_NAMES.has(toolName) || !rule.specifier) return false
  const spec = rule.specifier
  // Claude drops broad Bash allow rules when entering auto mode: they cannot
  // survive a meaningful classifier review.
  return spec === '*' || /^[A-Za-z0-9_.-]+\*$/.test(spec)
}

function isProtectedWrite(toolName: string, args: Record<string, unknown>): boolean {
  if (!EDIT_TOOL_NAMES.has(toolName)) return false
  const path = toolPath(args)
  if (!path) return false
  return PROTECTED_PATHS.some((pattern) => pattern.test(path))
}

const PROTECTED_COMMAND =
  /(?:^|[\s/\\])\.(?:git|claude|pilot)(?:[/\\\s]|$)|(?:^|[\s/\\])\.mcp\.json(?:[\s]|$)|(?:^|[\s/\\])\.(?:bashrc|zshrc|bash_profile|profile)(?:[\s]|$)|\.config[/\\]fish[/\\]config\.fish/i

/** Sandbox auto-approval must not cover commands aimed at protected config. */
function mentionsProtectedPath(command: string): boolean {
  return PROTECTED_COMMAND.test(command)
}

/** Script names that turn editable source into a runnable build. */
const BUILD_SCRIPT_NAMES = new Set([
  'self-build',
  'electron-builder',
  'package:dir',
  'package:win',
  'package:mac',
  'package:linux',
  'package:source',
])

const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'npx', 'pnpx', 'yarn', 'bun', 'bunx'])
const PACKAGE_RUNNERS = new Set(['run', 'run-script', 'exec', 'dlx', 'x', '--run'])
/** Package-manager options whose following token is a value, not a script. */
const PACKAGE_OPTIONS_WITH_VALUE = new Set([
  '--filter',
  '-F',
  '--dir',
  '-C',
  '--prefix',
  '--cwd',
  '--workspace',
  '-w',
])

const RELEASE_APP_PATH = /release-selfdev[\\/][^\s"'|;&]*pilot(?:\.exe)?(?=$|[\s"'|;&])/i

/**
 * Split a command line into simple commands on `&&`, `||`, `;`, `|`,
 * redirections, subshell parentheses and newlines, honouring quotes. Returns
 * null when the line cannot be parsed (unclosed quote or a nested command
 * substitution), so callers can fall back to a conservative text check.
 */
function splitCommandSegments(command: string): string[][] | null {
  const segments: string[][] = []
  let tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  const flushToken = (): void => {
    if (current) {
      tokens.push(current)
      current = ''
    }
  }
  const flushSegment = (): void => {
    flushToken()
    if (tokens.length > 0) segments.push(tokens)
    tokens = []
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && /["\\$`]/.test(command[index + 1] ?? '')) escaped = true
      else current += char
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    // A nested command substitution hides another command line; do not guess.
    if (char === '`' || (char === '$' && command[index + 1] === '(')) return null
    if (/\s/.test(char)) {
      flushToken()
      continue
    }
    if (
      char === '&' ||
      char === '|' ||
      char === ';' ||
      char === '>' ||
      char === '<' ||
      char === '(' ||
      char === ')'
    ) {
      flushSegment()
      continue
    }
    current += char
  }
  if (escaped || quote) return null
  flushSegment()
  return segments
}

function executableBase(token: string): string {
  return basename(token).replace(/\.(?:cmd|exe|bat|ps1)$/i, '')
}

/** Skip leading `VAR=value` assignments and transparent command wrappers. */
function commandStart(tokens: string[]): number {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1
      continue
    }
    if (['env', 'command', 'exec', 'nohup', 'time', 'nice'].includes(executableBase(token))) {
      index += 1
      continue
    }
    break
  }
  return index
}

function isBuildSegment(tokens: string[]): boolean {
  const start = commandStart(tokens)
  if (start >= tokens.length) return false
  const name = executableBase(tokens[start] ?? '')
  const args = tokens.slice(start + 1)

  // electron-builder itself, directly or through a path such as
  // node_modules/.bin/electron-builder.
  if (name === 'electron-builder') return true

  if (name === 'node' || name === 'nodejs') {
    if (args[0] === '--run' && BUILD_SCRIPT_NAMES.has(args[1] ?? '')) return true
    return args.some((arg) => {
      const path = normalizePath(arg)
      return (
        /(?:^|\/)scripts\/self-build\.mjs$/i.test(path) ||
        /(?:^|\/)node_modules\/electron-builder\/(?:cli|out\/cli)\.(?:js|cjs|mjs)$/i.test(path)
      )
    })
  }

  if (!PACKAGE_MANAGERS.has(name)) return false
  let runner = name === 'npx' || name === 'pnpx' || name === 'bunx'
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg === '--') continue
    if (PACKAGE_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1
      continue
    }
    if (arg.startsWith('-')) continue
    if (!runner) {
      if (PACKAGE_RUNNERS.has(arg)) {
        runner = true
        continue
      }
      // pnpm/yarn can run a script by bare name. Only the first positional
      // token is a script; later tokens are its arguments (e.g. a grep
      // pattern that happens to contain "electron-builder").
      return BUILD_SCRIPT_NAMES.has(arg)
    }
    return BUILD_SCRIPT_NAMES.has(arg)
  }
  return false
}

function isReleaseLaunchSegment(tokens: string[]): boolean {
  const start = commandStart(tokens)
  if (start >= tokens.length) return false
  const original = tokens[start] ?? ''
  const name = executableBase(original)

  // Executing the produced binary directly.
  if (/pilot(?:\.exe)?$/i.test(original) && RELEASE_APP_PATH.test(original)) return true

  const args = tokens.slice(start + 1)
  if (['start', 'start-process', 'open', 'xdg-open', 'explorer'].includes(name)) {
    return args.some((arg) => RELEASE_APP_PATH.test(arg))
  }
  // cmd /c start ..., powershell -Command "Start-Process ..."
  if (['cmd', 'powershell', 'pwsh', 'sh', 'bash'].includes(name)) {
    const launches = args.some((arg) =>
      /(?:^|[\s"'])(?:start|start-process|open|xdg-open|explorer)\b/i.test(arg),
    )
    return launches && args.some((arg) => RELEASE_APP_PATH.test(arg))
  }
  return false
}

/**
 * Conservative fallback when the line cannot be tokenised. Only patterns that
 * name a build script or an explicit launcher are considered; merely reading a
 * file called electron-builder.yml must never match.
 */
function looseSelfEvolutionText(text: string): boolean {
  if (/\bnode(?:\.exe)?\b[^|;&]*\bscripts[\\/]+self-build\.mjs\b/i.test(text)) return true
  if (
    /\b(?:pnpm|npm|npx|yarn|bun)(?:\.cmd)?\b\s+(?:run\s+)?(?:self-build|package:(?:dir|win|mac|linux|source))\b/i.test(
      text,
    )
  ) {
    return true
  }
  if (/\b(?:pnpm|npm|npx|yarn|bun)(?:\.cmd)?\b[^|;&]*\b(?:exec|dlx)\s+electron-builder\b/i.test(text)) {
    return true
  }
  return /\b(?:start|Start-Process|open|xdg-open)\b[^|;&]*release-selfdev\b/i.test(text)
}

/**
 * Building or launching a personal build turns editable source into a new
 * executable. The agent may edit that source, so this step is the last point
 * where the official, unmodified host can ask a human. Kept deliberately
 * narrow: ordinary `pnpm build` / `pnpm test` stay automatic, and so does
 * inspecting a file whose name contains "electron-builder".
 */
export function isSelfEvolutionBuildCommand(command: string): boolean {
  const text = command.trim()
  if (!text) return false
  const segments = splitCommandSegments(text)
  if (!segments) return looseSelfEvolutionText(text)
  return segments.some((tokens) => isBuildSegment(tokens) || isReleaseLaunchSegment(tokens))
}

function shellTokens(command: string): string[] | null {
  if (/[|&;<>()`$\r\n]/.test(command)) return null
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char ?? '')) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    if (char === '\\') {
      index += 1
      current += command[index] ?? ''
      continue
    }
    current += char
  }
  if (quote) return null
  if (current) tokens.push(current)
  return tokens.length > 0 ? tokens : null
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

function gitSubcommand(tokens: string[]): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.startsWith('-')) continue
    return token.toLowerCase()
  }
  return null
}

const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'branch',
  'remote',
  'describe',
  'tag',
])

function isReadOnlyArgv(tokens: string[]): boolean {
  const executable = basename(tokens[0] ?? '')
  if (!executable) return false
  // Some otherwise read-only commands can write through an output option.
  if (tokens.some((token) => token === '-o' || /^--output(=|$)/.test(token))) return false
  if (executable === 'git') {
    const sub = gitSubcommand(tokens)
    if (!sub || !READ_ONLY_GIT.has(sub)) return false
    // Options that write files, run helpers/config or open a pager can turn a
    // read-only git subcommand into arbitrary execution or out-of-workspace IO.
    if (
      tokens.some(
        (token) =>
          /^(--output|--ext-diff|--textconv|--exec-path|--config-env|--git-dir|--work-tree)(=|$)/.test(
            token,
          ) ||
          token === '-c',
      )
    ) {
      return false
    }
    if (sub === 'branch') {
      const rest = tokens.slice(2)
      return rest.every(
        (token) => /^(?:-[arvl]+|--(?:all|remotes|verbose|list|show-current))$/.test(token),
      )
    }
    if (sub === 'tag') {
      const rest = tokens.slice(2)
      return rest.length === 0 || (rest.length === 1 && /^(?:-l|--list)$/.test(rest[0] ?? ''))
    }
    if (sub === 'remote') {
      const rest = tokens.slice(2)
      return rest.length === 0 || (rest.length === 1 && /^(?:-v|--verbose)$/.test(rest[0] ?? ''))
    }
    return true
  }
  if (executable === 'node' || executable === 'npm' || executable === 'pnpm') {
    return tokens.slice(1).every((token) => token === '--version' || token === '-v')
  }
  if (executable === 'grep' || executable === 'rg') {
    // grep/rg can execute helpers; only allow the plain search forms.
    return !tokens.some((token) => /^(?:-e|--exec|-P|--pre)$|^--pre=/.test(token))
  }
  if (executable === 'sed') {
    return sedArguments(tokens, false) !== null
  }
  return READ_ONLY_COMMANDS.has(executable)
}

export function isReadOnlyShellCommand(command: string): boolean {
  const tokens = shellTokens(command)
  return tokens ? isReadOnlyArgv(tokens) : false
}

function pathInsideWorkspace(token: string, workspacePath: string): boolean {
  if (!token || token.startsWith('-') || /^https?:/i.test(token)) return true
  if (token.startsWith('~') || isAbsolute(token) || /^[A-Za-z]:[\\/]/.test(token)) return false
  if (token === '..' || token.startsWith('../') || token.includes('/../')) return false
  const target = resolve(workspacePath, token)
  const rel = relative(workspacePath, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** True for a sed script/address token, as opposed to a file path. */
function isSedExpression(token: string): boolean {
  // s/foo/bar/, s|foo|bar|g, y/a/b/ — the delimiter must be punctuation,
  // otherwise a path such as secret/../../outside could be mistaken for a script.
  if (/^[sy][^A-Za-z0-9\s](?:.*)[^A-Za-z0-9\s][gpi0-9]*$/.test(token)) return true
  // Addresses such as 1d, 1,5p, /pattern/d
  if (/^[0-9,$]+[dps]$/.test(token)) return true
  if (/^\/[^/]*\/[dps]$/.test(token)) return true
  return false
}

/**
 * Validate sed invocations. The first non-option argument is a script, so a
 * token such as `w/tmp/out` must be rejected instead of being treated as a
 * relative file path. -f/--file and --expression= are rejected because they
 * hide an arbitrary script; only explicit, parseable expressions are allowed.
 */
function sedArguments(
  tokens: string[],
  allowInPlace: boolean,
): { files: string[] } | null {
  let scriptSeen = false
  const files: string[] = []
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '--') {
      files.push(...tokens.slice(index + 1))
      break
    }
    if (token.startsWith('-')) {
      if (/^(?:--in-place|--file)|^-[if]/.test(token)) {
        if (allowInPlace && /^(?:--in-place|-[i])/.test(token)) continue
        return null
      }
      if (token === '-e') {
        const script = tokens[index + 1]
        index += 1
        if (!script || !isSedExpression(script)) return null
        scriptSeen = true
        continue
      }
      if (token.startsWith('--expression=')) {
        const script = token.slice('--expression='.length)
        if (!isSedExpression(script)) return null
        scriptSeen = true
        continue
      }
      continue
    }
    if (!scriptSeen) {
      if (!isSedExpression(token)) return null
      scriptSeen = true
      continue
    }
    files.push(token)
  }
  return scriptSeen ? { files } : null
}

/**
 * AcceptEdits mirrors Claude's fixed set of workspace filesystem commands:
 * mkdir, touch, rm, mv, cp and sed. The command must contain no shell
 * metacharacters and every path-like argument must stay in the workspace.
 */
export function isSafeWorkspaceFileCommand(command: string, workspacePath: string): boolean {
  const tokens = shellTokens(command)
  if (!tokens) return false
  const executable = basename(tokens[0] ?? '')
  if (!ACCEPT_EDIT_COMMANDS.has(executable) && executable !== 'sed') return false
  if (executable === 'sed') {
    const parsed = sedArguments(tokens, true)
    if (!parsed) return false
    return parsed.files.every((token) => pathInsideWorkspace(token, workspacePath))
  }
  for (const token of tokens.slice(1)) {
    if (token === '--') continue
    if (token.startsWith('-')) {
      // Options can smuggle paths (--target-directory=/tmp). Reject any option
      // that carries path syntax rather than trying to enumerate safe flags.
      if (/[/\\]|\.\.|^~/.test(token)) return false
      continue
    }
    if (!pathInsideWorkspace(token, workspacePath)) return false
  }
  if (executable === 'rm' && tokens.some((token) => token === '.' || token === '*' || token === '/')) {
    return false
  }
  return true
}

function modeVerdict(
  input: PermissionInput,
): PermissionVerdict {
  const { mode, tool, call, workspacePath, sandboxed, sandboxAutoAllow } = input
  const args = call.arguments ?? {}
  const readLike = tool.risk === 'read' || tool.risk === 'control'
  const command = commandLine(args)

  if (readLike) {
    return { action: 'allow', source: 'mode', reason: '只读或控制类工具' }
  }

  if (mode === 'plan') {
    if (command && isReadOnlyShellCommand(command)) {
      return { action: 'allow', source: 'mode', reason: '计划模式允许只读探索命令' }
    }
    return {
      action: 'deny',
      source: 'mode',
      reason: '计划模式只允许只读探索；请先给出计划并切换模式再执行。',
    }
  }

  if (mode === 'dontAsk') {
    return {
      action: 'deny',
      source: 'mode',
      reason: '“不要询问”模式只运行只读操作和显式允许规则。',
    }
  }

  const isShell = tool.name === 'run_shell'

  if (
    sandboxed &&
    sandboxAutoAllow &&
    tool.risk === 'exec' &&
    !mentionsProtectedPath(command)
  ) {
    return {
      action: 'allow',
      source: 'sandbox',
      reason: '命令将在操作系统沙箱内运行（工作区外只读）。',
    }
  }

  if (isShell) {
    // Unsandboxed shell can reach outside the workspace, so the manual modes
    // keep the explicit per-call approval boundary unless a narrow allow rule
    // or the sandbox matched first. 全部自动 returns before this point.
    return {
      action: 'ask',
      source: 'mode',
      reason: '完整 shell 不受工作区路径限制，需要逐次确认。',
    }
  }

  if (command && isReadOnlyShellCommand(command)) {
    return { action: 'allow', source: 'mode', reason: '只读命令' }
  }

  if (command && mode === 'acceptEdits' && isSafeWorkspaceFileCommand(command, workspacePath)) {
    return { action: 'allow', source: 'mode', reason: '工作区内的文件操作' }
  }

  if (tool.risk === 'write') {
    if (mode === 'auto' || mode === 'acceptEdits') {
      return { action: 'allow', source: 'mode', reason: '工作区内的文件编辑' }
    }
    return { action: 'ask', source: 'mode', reason: '文件编辑需要确认' }
  }

  if (tool.risk === 'exec') {
    if (mode === 'auto') {
      return {
        action: 'classify',
        source: 'mode',
        reason: '自动模式会先让权限分类器审查这条命令。',
      }
    }
    return { action: 'ask', source: 'mode', reason: '执行命令需要确认' }
  }

  return { action: 'ask', source: 'mode', reason: '该操作需要确认' }
}

function firstMatchingRule(
  decision: RuleDecision,
  input: PermissionInput,
): ParsedRule | null {
  const { tool, call, workspacePath, rules, mode } = input
  const args = call.arguments ?? {}
  for (const raw of rules[decision]) {
    const parsed = parseRule(raw, decision)
    if (!parsed) continue
    if (!ruleMatchesTool(parsed.tool, tool.name)) continue
    if (
      parsed.specifier !== null &&
      !ruleMatchesSpecifier(tool.name, parsed.specifier, args, workspacePath)
    ) {
      continue
    }
    if (decision === 'allow' && mode === 'auto' && broadExecAllow(parsed, tool.name)) {
      continue
    }
    return parsed
  }
  return null
}

function ruleVerdict(parsed: ParsedRule, decision: RuleDecision): PermissionVerdict {
  return {
    action: decision,
    source: 'rule',
    rule: parsed.raw,
    reason:
      decision === 'deny'
        ? `命中拒绝规则 ${parsed.raw}`
        : decision === 'ask'
          ? `命中询问规则 ${parsed.raw}`
          : `命中允许规则 ${parsed.raw}`,
  }
}

export function evaluatePermission(input: PermissionInput): PermissionVerdict {
  const { tool, call, mode } = input
  const args = call.arguments ?? {}

  // 学习探索期间，若用户确实开启了 shell 隔离，任何带上传意图的 shell 命令都是硬拒绝：
  // 先于模式与规则判断，所以“全部自动”模式也无法把它放行。默认未隔离时，
  // 学习模式不接管 shell：外发命令和普通任务一样走模式与规则审批。
  if (
    input.learningMode === true &&
    input.learningIsolateShell === true &&
    SHELL_TOOL_NAMES.has(tool.name)
  ) {
    const uploadCommand = commandLine(args)
    const upload = uploadCommand ? detectUploadVector(uploadCommand) : null
    if (upload) {
      return {
        action: 'deny',
        source: 'protected',
        reason: `学习探索期间禁止把内容发往域外（${upload.hint}）。产物只留在工作区，不上传、不提交。`,
      }
    }
  }

  const readLike = tool.risk === 'read' || tool.risk === 'control'

  if (isProtectedWrite(tool.name, args)) {
    return {
      action: 'deny',
      source: 'protected',
      reason: '这是受保护的配置文件路径（.git、.claude、.mcp.json、shell 配置等），不允许智能体改写。',
    }
  }

  // Explicit deny rules are absolute and cannot be overridden by a mode.
  const denied = firstMatchingRule('deny', input)
  if (denied) return ruleVerdict(denied, 'deny')

  // Shell commands can also target protected config paths. Read-only inspection
  // stays available; anything that may mutate them is refused in every mode.
  const command = commandLine(args)
  if (command && mentionsProtectedPath(command) && !isReadOnlyShellCommand(command)) {
    return {
      action: 'deny',
      source: 'protected',
      reason: '命令指向受保护的配置文件路径（.git、.claude、.mcp.json、shell 配置等），任何模式都不允许改写。',
    }
  }

  // Self-evolution packaging is the one exec path that always needs a human:
  // it compiles source the agent can edit into a runnable program. Explicit
  // allow rules and the sandbox do not bypass this confirmation.
  if (command && isSelfEvolutionBuildCommand(command)) {
    if (mode === 'plan' || mode === 'dontAsk') {
      return {
        action: 'deny',
        source: 'protected',
        reason:
          '构建个人实验版会从可修改的源码生成可执行文件，需要你亲自确认；当前模式不能询问。',
      }
    }
    // The user can opt into unattended builds for 全部自动 sessions. It is an
    // explicit setting, off by default, and never applies to a manual mode:
    // this step is the last human gate between editable source and a runnable
    // program.
    if (mode === 'auto' && input.allowUnattendedBuild === true) {
      return {
        action: 'allow',
        source: 'mode',
        reason:
          '已在设置中允许无人值守构建：全部自动模式直接执行，构建产物仍写入 release-selfdev。',
      }
    }
    return {
      action: 'ask',
      source: 'protected',
      reason:
        '构建个人实验版会从可修改的源码生成新的可执行文件，需要你亲自确认。可在设置中开启「允许无人值守的个人构建」后不再询问。',
    }
  }

  // 全部自动：所有工具直接执行，但仍受上面的受保护路径与拒绝规则约束。
  if (mode === 'auto') {
    return {
      action: 'allow',
      source: 'mode',
      reason: '全部自动模式：工具直接执行。',
    }
  }

  // A remembered command is an exact, user-granted approval. This check runs
  // after the protected-path, deny-rule and self-evolution checks, so those
  // boundaries still win; plan mode stays read-only and never consumes it.
  if (
    mode !== 'plan' &&
    command &&
    SHELL_TOOL_NAMES.has(tool.name) &&
    (input.trustedCommands ?? []).includes(command)
  ) {
    return {
      action: 'allow',
      source: 'rule',
      reason: '这是你之前选择「始终允许」的命令。',
    }
  }

  // MCP tools run code from an external server. Ask first in the two manual
  // modes; dontAsk/plan cannot prompt, so they deny.
  if (tool.source === 'mcp') {
    if (mode === 'plan' || mode === 'dontAsk') {
      return {
        action: 'deny',
        source: 'mode',
        reason: 'MCP 工具需要逐次确认，当前模式不允许询问。',
      }
    }
    return {
      action: 'ask',
      source: 'mode',
      reason: 'MCP 工具需要逐次确认。',
    }
  }

  // 逐条审批：计划/记忆等控制类工具保持自动，其余每次调用都询问。
  if (mode === 'ask') {
    if (tool.risk === 'control') {
      return { action: 'allow', source: 'mode', reason: '控制类工具' }
    }
    return {
      action: 'ask',
      source: 'mode',
      reason: '逐条审批模式：这次工具调用需要确认。',
    }
  }

  const asked = firstMatchingRule('ask', input)

  // Plan mode is read-only even if an allow or ask rule matches a mutating
  // tool. Read-only commands are still allowed by the mode itself.
  if (mode === 'plan' && !readLike) {
    const command = commandLine(args)
    if (command && isReadOnlyShellCommand(command)) {
      return { action: 'allow', source: 'mode', reason: '计划模式允许只读探索命令' }
    }
    return {
      action: 'deny',
      source: 'mode',
      reason: '计划模式只允许只读探索；请先给出计划并切换模式再执行。',
    }
  }

  // dontAsk never prompts: an ask rule becomes a denial, and only explicit
  // allow rules (plus read-only operations) survive.
  if (mode === 'dontAsk') {
    if (asked) return { action: 'deny', source: 'rule', rule: asked.raw, reason: `“不要询问”模式下询问规则 ${asked.raw} 转为拒绝` }
    const allowed = firstMatchingRule('allow', input)
    if (allowed) return ruleVerdict(allowed, 'allow')
    return modeVerdict(input)
  }

  if (asked) return ruleVerdict(asked, 'ask')
  const allowed = firstMatchingRule('allow', input)
  if (allowed) return ruleVerdict(allowed, 'allow')

  return modeVerdict(input)
}

/** Explain broad rules that are ignored in auto mode, for the settings UI. */
export function ignoredAutoAllowRules(rules: PermissionRules): string[] {
  return rules.allow.filter((raw) => {
    const parsed = parseRule(raw, 'allow')
    return (
      parsed !== null &&
      SHELL_TOOL_NAMES.has(parsed.tool === 'Bash' ? 'run_shell' : parsed.tool) &&
      parsed.specifier !== null &&
      broadExecAllow(parsed, parsed.tool === 'Bash' ? 'run_shell' : parsed.tool)
    )
  })
}

