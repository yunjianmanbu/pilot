import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { AgentToolDefinition } from '../../shared/types'
import { resolveExisting } from '../workspace'
import { killWindowsTree } from '../workspace/process-tree'
import { isVerificationCommand } from './checks'
import { truncateMiddle } from './context'

/**
 * Whitelisted verification for delegated subagents.
 *
 * A subagent has no shell: a nested loop never reaches the user's approval
 * flow, so `run_command`/`run_shell` stay out of it. That left every edit it
 * made unproven until the parent re-ran the checks, costing a full extra parent
 * turn per delegation. `run_check` closes that gap without handing over a
 * shell: one program from a fixed list, argv only, no metacharacters, cwd
 * inside the workspace, a per-task budget and a hard timeout.
 */
export const RUN_CHECK = 'run_check'

/** Checks one delegated subagent may run; keeps a nested loop from looping. */
export const MAX_CHECKS_PER_SUBAGENT = 6
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000
export const MAX_CHECK_TIMEOUT_MS = 240_000
/** Floor so a stray small value cannot make every check time out instantly. */
const MIN_CHECK_TIMEOUT_MS = 1_000
/** What one check may put back into the subagent context. */
export const MAX_CHECK_OUTPUT_CHARS = 8_000
/** `&&` segments one check may expand to through a package script. */
const MAX_SCRIPT_SEGMENTS = 3
/** Nested `pnpm run x` inside a script; one level is enough in practice. */
const MAX_SCRIPT_DEPTH = 2

/** Programs a subagent may start. Everything else is refused. */
const SAFE_PROGRAMS = new Set([
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'node',
  'vitest',
  'jest',
  'mocha',
  'tsc',
  'vue-tsc',
  'eslint',
  'stylelint',
  'prettier',
  'biome',
])

/**
 * `node` is only allowed in its check modes: `node --test` runs test files and
 * `node --check` parses one, both of which prove something without running an
 * arbitrary script (`node -e`, `node setup.js` stay refused).
 */
const NODE_CHECK_FLAGS = new Set(['--test', '--check'])

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Tool name → the package that ships the binary, so `tsc` finds `typescript`. */
const BIN_PACKAGES: Record<string, string> = {
  vitest: 'vitest',
  jest: 'jest',
  mocha: 'mocha',
  tsc: 'typescript',
  'vue-tsc': 'vue-tsc',
  eslint: 'eslint',
  stylelint: 'stylelint',
  prettier: 'prettier',
  biome: '@biomejs/biome',
}

/** Package-manager subcommands that can change the workspace or hit the network. */
const BLOCKED_PM_COMMANDS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'remove',
  'rm',
  'uninstall',
  'update',
  'up',
  'upgrade',
  'link',
  'unlink',
  'publish',
  'exec',
  'dlx',
  'create',
  'init',
  'audit',
  'login',
  'logout',
  'patch',
  'prune',
  'import',
  'deploy',
])

/**
 * One argv element. No whitespace, no quotes, no `$`, no `;|&<>`, no
 * backslashes. Flags, relative paths and `key=value` survive; anything a shell
 * would interpret does not.
 */
const SAFE_ARG = /^[A-Za-z0-9@/_.:=+,%*-]+$/
const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/

export interface CheckPlan {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  /** True when the request is a real verification step (test/typecheck/lint). */
  verifies: boolean
}

export type CheckPlanResult = { ok: true; plan: CheckPlan } | { ok: false; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeCwd(value: unknown): string | null {
  if (value === undefined || value === null) return '.'
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!raw) return '.'
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.startsWith('~')) return null
  if (raw.split('/').includes('..')) return null
  return raw
}

function argProblem(arg: string): string | null {
  if (!arg || arg.length > 200) return '参数为空或过长'
  if (!SAFE_ARG.test(arg)) {
    return `参数 ${arg.slice(0, 40)} 含不允许的字符（空格、引号、管道、重定向、$、反斜杠等）`
  }
  if (arg.startsWith('/') || /^[A-Za-z]:/.test(arg)) {
    return `参数 ${arg.slice(0, 40)} 不能是绝对路径`
  }
  if (arg.split('/').includes('..')) return `参数 ${arg.slice(0, 40)} 不能包含 ..`
  return null
}

/**
 * Validate one check request. Pure apart from the optional package.json script
 * list, so the whitelist itself is directly unit-testable.
 *
 * @param scripts script names of the package.json governing `cwd`, when known.
 */
export function planCheck(
  input: Record<string, unknown>,
  scripts?: ReadonlySet<string>,
): CheckPlanResult {
  const rawCommand = typeof input['command'] === 'string' ? input['command'].trim() : ''
  if (!rawCommand) return { ok: false, reason: 'command 必须是非空字符串' }
  if (/[\\/:\s]/.test(rawCommand)) {
    return { ok: false, reason: 'command 只接受程序名，不接受路径或 shell 片段' }
  }
  const command = rawCommand.toLowerCase()
  if (!SAFE_PROGRAMS.has(command)) {
    return {
      ok: false,
      reason: `${command} 不在校验白名单内（只允许测试、类型检查、lint 与项目脚本）`,
    }
  }

  const rawArgs = input['args'] === undefined ? [] : input['args']
  if (!Array.isArray(rawArgs)) return { ok: false, reason: 'args 必须是字符串数组' }
  if (rawArgs.length > 16) return { ok: false, reason: '一次校验最多 16 个参数' }
  const args: string[] = []
  for (const item of rawArgs) {
    const arg = typeof item === 'string' ? item : String(item)
    const problem = argProblem(arg)
    if (problem) return { ok: false, reason: problem }
    args.push(arg)
  }

  if (PACKAGE_MANAGERS.has(command)) {
    const head = (args[0] ?? '').toLowerCase()
    if (!head) return { ok: false, reason: `${command} 需要 test 或 run <script>` }
    if (BLOCKED_PM_COMMANDS.has(head)) {
      return { ok: false, reason: `${command} ${head} 会改动依赖或对外发布，子智能体不允许` }
    }
    if (head === 'test') {
      // The package.json `test` script; resolved through the file, not a shell.
    } else if (head === 'run') {
      const script = args[1]
      if (!script) return { ok: false, reason: `${command} run 需要脚本名` }
      if (!SCRIPT_NAME.test(script)) return { ok: false, reason: '脚本名含不允许的字符' }
      if (scripts && !scripts.has(script)) {
        return { ok: false, reason: `package.json 里没有脚本 ${script}` }
      }
      if (args.length > 2) {
        return { ok: false, reason: '子智能体不支持给项目脚本追加参数，请直接调用对应的工具' }
      }
    } else {
      return { ok: false, reason: `${command} 只允许 run <script> 或 test` }
    }
  } else if (command === 'npx') {
    const bin = args[0]
    if (!bin) return { ok: false, reason: 'npx 需要工具名，例如 npx vitest run tests/a.test.ts' }
    if (!BIN_PACKAGES[bin]) {
      return { ok: false, reason: `npx ${bin} 不在白名单内（npx 不能用来下载或运行任意包）` }
    }
  } else if (command === 'node') {
    const flag = args[0]
    if (!flag || !NODE_CHECK_FLAGS.has(flag)) {
      return { ok: false, reason: 'node 只允许 --test（跑测试文件）或 --check（只检查语法）' }
    }
  }

  const cwd = normalizeCwd(input['cwd'])
  if (cwd === null) return { ok: false, reason: 'cwd 必须是工作区内的相对路径' }

  const timeoutInput = Number(input['timeoutMs'])
  const timeoutMs =
    Number.isFinite(timeoutInput) && timeoutInput > 0
      ? Math.min(MAX_CHECK_TIMEOUT_MS, Math.max(MIN_CHECK_TIMEOUT_MS, Math.round(timeoutInput)))
      : DEFAULT_CHECK_TIMEOUT_MS

  return {
    ok: true,
    plan: {
      command,
      args,
      cwd,
      timeoutMs,
      verifies: isVerificationCommand([command, ...args].join(' ')),
    },
  }
}

/** Script names of the package.json that governs `cwd`, for the `run` guard. */
export async function loadScriptNames(root: string, cwd: string): Promise<Set<string>> {
  const scripts = await loadScripts(root, cwd)
  return new Set(Object.keys(scripts))
}

async function loadScripts(root: string, cwd: string): Promise<Record<string, string>> {
  const file = join(root, cwd === '.' ? '' : cwd, 'package.json')
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!isPlainObject(parsed)) return {}
    const scripts = parsed['scripts']
    if (!isPlainObject(scripts)) return {}
    const result: Record<string, string> = {}
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value === 'string') result[name] = value
    }
    return result
  } catch {
    return {}
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Tokenize one package script. Quotes group; a shell metacharacter outside
 * quotes means the script cannot run without a shell, so it is refused instead
 * of half-executed.
 */
function tokenizeScript(text: string): { tokens: string[] } | { problem: string } {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    if ('|<>;&`$(){}\\'.includes(char)) {
      return { problem: `脚本里含 shell 语法 ${char}，无法无 shell 执行` }
    }
    current += char
    started = true
  }
  if (quote) return { problem: '脚本里的引号没有闭合' }
  if (started || current) tokens.push(current)
  return { tokens }
}

interface Step {
  command: string
  args: string[]
  display: string
  /** Extra environment for this step (for example ELECTRON_RUN_AS_NODE). */
  env?: Record<string, string>
}

function pathDirs(): string[] {
  return (process.env['PATH'] ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean)
}

/**
 * Node runtime for tool entry scripts. In Electron `process.execPath` is the
 * app binary, so a real `node` on PATH is preferred; the Electron fallback sets
 * ELECTRON_RUN_AS_NODE so the script does not open a window.
 */
async function nodeRuntime(): Promise<{ command: string; env: Record<string, string> }> {
  if (!process.versions.electron) return { command: process.execPath, env: {} }
  for (const dir of pathDirs()) {
    const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    if (await exists(candidate)) return { command: candidate, env: {} }
  }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/** Search node_modules from `cwd` up to the workspace root, like Node does. */
function moduleDirs(root: string, cwd: string): string[] {
  const stop = resolve(root)
  const dirs: string[] = []
  let current = resolve(root, cwd === '.' ? '' : cwd)
  for (;;) {
    dirs.push(join(current, 'node_modules'))
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current || !parent.startsWith(stop)) break
    current = parent
  }
  const rootModules = join(stop, 'node_modules')
  if (!dirs.includes(rootModules)) dirs.push(rootModules)
  return dirs
}

async function resolveBin(
  root: string,
  cwd: string,
  tool: string,
): Promise<{ step: Step } | { problem: string }> {
  const pkg = BIN_PACKAGES[tool]
  if (!pkg) return { problem: `${tool} 不在白名单内` }
  for (const modules of moduleDirs(root, cwd)) {
    const manifest = join(modules, pkg, 'package.json')
    if (!(await exists(manifest))) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(manifest, 'utf8'))
    } catch {
      continue
    }
    if (!isPlainObject(parsed)) continue
    const bin = parsed['bin']
    let entry: string | null = null
    if (typeof bin === 'string') entry = bin
    else if (isPlainObject(bin)) {
      const named = bin[tool]
      if (typeof named === 'string') entry = named
      else {
        const first = Object.values(bin).find((value) => typeof value === 'string')
        if (typeof first === 'string') entry = first
      }
    }
    if (!entry) continue
    const file = resolve(dirname(manifest), entry)
    if (!(await exists(file))) continue
    // npm bin entries are either a native/.cmd shim or a JS file with a
    // shebang and often no extension (`typescript/bin/tsc`, `vitest/vitest.mjs`).
    // Everything that is not obviously an executable goes through node.
    const native = /\.(?:exe|cmd|bat|com)$/i.test(file)
    const runtime = native ? null : await nodeRuntime()
    return {
      step: {
        command: native ? file : (runtime?.command ?? process.execPath),
        args: native ? [] : [file],
        env: native ? {} : (runtime?.env ?? {}),
        display: `${tool} (${relative(root, file).replace(/\\/g, '/') || file})`,
      },
    }
  }
  return {
    problem: `在 node_modules 里找不到 ${tool}（依赖 ${pkg}）。先确认依赖已安装，或改用工作区里已有的检查。`,
  }
}

/** Expand a plan into concrete, shell-free steps. */
async function resolveSteps(
  root: string,
  plan: CheckPlan,
  depth = 0,
): Promise<{ steps: Step[] } | { problem: string }> {
  const { command, args } = plan
  if (PACKAGE_MANAGERS.has(command)) {
    const scriptName = (args[0] ?? '').toLowerCase() === 'test' ? 'test' : (args[1] ?? '')
    const scripts = await loadScripts(root, plan.cwd)
    const body = scripts[scriptName]
    if (body === undefined) return { problem: `package.json 里没有脚本 ${scriptName}` }
    if (depth >= MAX_SCRIPT_DEPTH) return { problem: `脚本 ${scriptName} 嵌套层数过多` }
    const segments: Step[] = []
    for (const segment of body.split('&&')) {
      const trimmed = segment.trim()
      if (!trimmed) continue
      const tokenized = tokenizeScript(trimmed)
      if ('problem' in tokenized) return { problem: `${scriptName}: ${tokenized.problem}` }
      const [program, ...rest] = tokenized.tokens
      if (!program) continue
      const lower = program.toLowerCase()
      if (!SAFE_PROGRAMS.has(lower)) {
        return { problem: `脚本 ${scriptName} 调用了白名单外的程序 ${program}` }
      }
      const nested = await resolveSteps(
        root,
        { ...plan, command: lower, args: rest.map((item) => item.replace(/^\.\//, '')) },
        depth + 1,
      )
      if ('problem' in nested) return nested
      segments.push(...nested.steps)
      if (segments.length > MAX_SCRIPT_SEGMENTS) {
        return { problem: `脚本 ${scriptName} 展开超过 ${MAX_SCRIPT_SEGMENTS} 步` }
      }
    }
    if (segments.length === 0) return { problem: `脚本 ${scriptName} 是空的` }
    return { steps: segments }
  }

  if (command === 'npx') {
    const tool = args[0] ?? ''
    const resolvedBin = await resolveBin(root, plan.cwd, tool)
    if ('problem' in resolvedBin) return resolvedBin
    const rest = args.slice(1)
    return {
      steps: [
        {
          command: resolvedBin.step.command,
          args: [...resolvedBin.step.args, ...rest],
          display: [tool, ...rest].join(' '),
          ...(resolvedBin.step.env ? { env: resolvedBin.step.env } : {}),
        },
      ],
    }
  }

  if (command === 'node') {
    const runtime = await nodeRuntime()
    return {
      steps: [
        {
          command: runtime.command,
          args,
          env: runtime.env,
          display: ['node', ...args].join(' '),
        },
      ],
    }
  }

  const resolvedBin = await resolveBin(root, plan.cwd, command)
  if ('problem' in resolvedBin) return resolvedBin
  return {
    steps: [
      {
        command: resolvedBin.step.command,
        args: [...resolvedBin.step.args, ...args],
        display: [command, ...args].join(' '),
        ...(resolvedBin.step.env ? { env: resolvedBin.step.env } : {}),
      },
    ],
  }
}

export interface CheckOutcome {
  ok: boolean
  output: string
  error?: string
  exitCode: number | null
  durationMs: number
  command: string
  /** True when this run counted as a verification step. */
  verifies: boolean
}

/** Per-stream capture window: the head shows what started, the tail shows why it failed. */
const STREAM_HEAD_CHARS = 120_000
const STREAM_TAIL_CHARS = 120_000

/**
 * Keep both ends of one stream. A test run prints thousands of lines; the
 * failure summary is always at the end, so dropping everything after a fixed
 * head would hide exactly the line that matters.
 */
function appendBounded(
  buffer: { head: string; tail: string; dropped: number },
  chunk: string,
): void {
  if (buffer.head.length < STREAM_HEAD_CHARS) {
    const room = STREAM_HEAD_CHARS - buffer.head.length
    buffer.head += chunk.slice(0, room)
    chunk = chunk.slice(room)
  }
  if (!chunk) return
  buffer.tail += chunk
  if (buffer.tail.length > STREAM_TAIL_CHARS) {
    const overflow = buffer.tail.length - STREAM_TAIL_CHARS
    buffer.dropped += overflow
    buffer.tail = buffer.tail.slice(overflow)
  }
}

function readBounded(buffer: { head: string; tail: string; dropped: number }): string {
  const text = buffer.head + buffer.tail
  if (buffer.dropped === 0) return text.trimEnd()
  return `${buffer.head}\n…（中间 ${buffer.dropped} 字符已省略）…\n${buffer.tail}`.trimEnd()
}

interface SpawnResult {
  code: number | null
  output: string
  timedOut: boolean
}

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    // 不带 `/T /F`：校验命令里也可能拉起 Office，见 workspace/process-tree.ts。
    killWindowsTree(pid)
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The child may already be gone; nothing to escalate to.
  }
}

function spawnStep(
  step: Step,
  options: {
    cwd: string
    root: string
    timeoutMs: number
    env: Record<string, string>
    signal?: AbortSignal
  },
): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const stdout = { head: '', tail: '', dropped: 0 }
    const stderr = { head: '', tail: '', dropped: 0 }
    let settled = false
    let stopped = false
    const child = spawn(step.command, step.args, {
      cwd: options.cwd,
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        ComSpec: process.env['ComSpec'] ?? '',
        PATHEXT: process.env['PATHEXT'] ?? '',
        TEMP: process.env['TEMP'] ?? '',
        TMP: process.env['TMP'] ?? '',
        HOME: process.env['HOME'] ?? '',
        PILOT_WORKSPACE: options.root,
        ...options.env,
      },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        code: stopped ? null : code,
        output: [readBounded(stdout), readBounded(stderr)].filter(Boolean).join('\n'),
        timedOut: stopped,
      })
    }
    const onAbort = (): void => {
      stopped = true
      killTree(child.pid)
      setTimeout(() => finish(null), 1_500)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      // Bounded: a runaway test run must not flood the process memory.
      appendBounded(stdout, chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      appendBounded(stderr, chunk.toString('utf8'))
    })
    child.on('error', (error) => {
      appendBounded(stderr, error.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
    const timer = setTimeout(() => {
      stopped = true
      killTree(child.pid)
      setTimeout(() => finish(null), 1_500)
    }, Math.max(MIN_CHECK_TIMEOUT_MS, Math.round(options.timeoutMs)))
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Run one whitelisted check. No shell is ever involved: each step is an argv
 * pair, cwd is jailed to the workspace, output is trimmed to what the subagent
 * can use, and the whole check shares one timeout budget.
 */
export async function runCheck(
  root: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal; scripts?: ReadonlySet<string> } = {},
): Promise<CheckOutcome> {
  const startedAt = Date.now()
  const requested = typeof input['command'] === 'string' ? input['command'].trim() : ''
  const planned = planCheck(input, options.scripts)
  if (!planned.ok) {
    return {
      ok: false,
      output: '',
      error: planned.reason,
      exitCode: null,
      durationMs: 0,
      command: requested,
      verifies: false,
    }
  }
  const { plan } = planned
  const label = [plan.command, ...plan.args].join(' ')

  let cwd: string
  try {
    cwd = await resolveExisting(root, plan.cwd)
  } catch (error) {
    return {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
      exitCode: null,
      durationMs: Date.now() - startedAt,
      command: label,
      verifies: plan.verifies,
    }
  }

  const resolved = await resolveSteps(root, plan)
  if ('problem' in resolved) {
    return {
      ok: false,
      output: '',
      error: resolved.problem,
      exitCode: null,
      durationMs: Date.now() - startedAt,
      command: label,
      verifies: plan.verifies,
    }
  }

  const chunks: string[] = []
  let ok = true
  let exitCode: number | null = null
  let error: string | undefined
  const deadline = startedAt + plan.timeoutMs
  for (const [index, step] of resolved.steps.entries()) {
    const remaining = deadline - Date.now()
    if (remaining <= 200) {
      ok = false
      error = `校验超过 ${Math.round(plan.timeoutMs / 1000)} 秒预算，已停止`
      break
    }
    const result = await spawnStep(step, {
      cwd,
      root,
      timeoutMs: remaining,
      env: step.env ?? {},
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const heading =
      resolved.steps.length > 1 ? `$ ${step.display}\n` : ''
    if (result.output) chunks.push(`${heading}${result.output}`)
    else if (result.timedOut) chunks.push(`${heading}(超时或被取消，没有输出)`)
    exitCode = result.code
    if (result.timedOut) {
      ok = false
      error = `校验超时（${Math.round(plan.timeoutMs / 1000)} 秒）后被终止`
      break
    }
    if (result.code !== 0) {
      ok = false
      error = `命令 ${step.display} 退出码 ${result.code}`
      break
    }
    if (index < resolved.steps.length - 1) {
      // Sequential `&&` semantics: a failure above stops the chain.
    }
  }

  const body = chunks.filter(Boolean).join('\n\n') || '(no output)'
  return {
    ok,
    output: truncateMiddle(body, MAX_CHECK_OUTPUT_CHARS),
    ...(error ? { error } : {}),
    exitCode,
    durationMs: Date.now() - startedAt,
    command: `${label}${plan.cwd === '.' ? '' : ` (cwd=${plan.cwd})`}`,
    verifies: plan.verifies,
  }
}

export const runCheckTool: AgentToolDefinition = {
  name: RUN_CHECK,
  description:
    'Run ONE whitelisted verification command inside the workspace: a test runner (npx vitest run <file>), a type checker (npx tsc -p <cfg> --noEmit), a linter, `node --test <file>`, or a package.json script (pnpm run typecheck). argv only, no shell: no pipes, redirects, quoting or chaining. cwd is workspace-relative. Use it right after your edit to prove it, and quote the result in your summary. Installing, publishing and arbitrary programs are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Program name only: npx, npm, pnpm, yarn, bun, vitest, tsc, eslint, ...',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments, one per element, e.g. ["vitest","run","tests/a.test.ts"].',
      },
      cwd: { type: 'string', description: 'Workspace-relative directory; defaults to the root.' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 120000, max 240000).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  risk: 'exec',
  source: 'builtin',
}
