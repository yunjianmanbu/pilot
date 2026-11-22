// One-shot commands, shell lines and git helpers.
// Split out of src/main/workspace.ts; statements are moved verbatim.
import { spawn, type ChildProcess } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { ShellInterpreter } from '../../shared/types'
import {
  mediaFileUrlFor,
  mediaDirUrlFor,
  mediaUrlFor,
  dirOf,
  isTextKind,
  previewKindOf,
  type PreviewKind,
} from '../../shared/media'
import { ephemeralDirSegment, looksEphemeralDirPath } from '../../shared/checkpoint-ignore'
import { buildSandboxPlan } from '../sandbox'
import { gitBashLoginEnvironment, resolveShellLaunch } from '../shell'
import { diskSpace, diskWarning } from '../system-info'
import { assertInside, MAX_COMMAND_OUTPUT_BYTES, resolveExisting, workspaceRoot } from './shared'

export interface CommandOutput {
  ok: boolean
  output: string
  error?: string
  exitCode: number | null
  durationMs: number
  metadata: Record<string, unknown>
}

export function truncateOutput(text: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= MAX_COMMAND_OUTPUT_BYTES) return { text, truncated: false }
  const headBytes = Math.floor(MAX_COMMAND_OUTPUT_BYTES * 0.65)
  const tailBytes = Math.floor(MAX_COMMAND_OUTPUT_BYTES * 0.25)
  const head = buffer.subarray(0, headBytes).toString('utf8')
  const tail = buffer.subarray(buffer.length - tailBytes).toString('utf8')
  return {
    text: `${head}\n…（output truncated: ${buffer.length - headBytes - tailBytes} bytes omitted; tail kept）…\n${tail}`,
    truncated: true,
  }
}

export const DENY_COMMANDS = new Set([
  'mkfs',
  'mkfs.ext4',
  'fdisk',
  'diskpart',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
])

export function exitCodeHint(exitCode: number | null): string | null {
  switch (exitCode) {
    case 126:
      return 'found but not executable'
    case 127:
      return 'command not found; check that it is installed and on PATH'
    case 130:
      return 'interrupted'
    case 137:
      return 'killed, often by a timeout or memory limit'
    case 143:
      return 'terminated by SIGTERM'
    case 9009:
      return 'command not found (Windows cmd); check that it is installed and on PATH'
    default:
      return null
  }
}

export function commandFailureMessage(exitCode: number | null): string {
  if (exitCode === null) return 'Command was terminated before it reported an exit code (signal or crash)'
  const hint = exitCodeHint(exitCode)
  return `Command failed with exit code ${exitCode}${hint ? ` (${hint})` : ''}`
}

export function timeoutFailureMessage(timeoutMs: number): string {
  return `Command timed out after ${timeoutMs}ms (partial output included). Raise timeoutMs (max 600000) or split the command into smaller steps.`
}

export interface PlannedCommand {
  /** Program name or workspace-relative executable path. */
  command: string
  argv: string[]
  cwd: string
  /** Real workspace root, used for the PILOT_WORKSPACE environment variable. */
  base: string
}

/**
 * Validate a `run_command`-shaped request and resolve its workspace-jailed
 * cwd/executable. Shared by one-shot commands and managed long-lived
 * processes so both obey the same deny list and path checks.
 */
export async function planCommand(
  root: string,
  args: Record<string, unknown>,
): Promise<PlannedCommand> {
  const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
  if (!command || command.includes('\0')) throw new Error('command must be a non-empty string')
  const name = basename(command).toLowerCase()
  if (DENY_COMMANDS.has(name)) throw new Error(`Command "${name}" is blocked by Pilot`)
  const rawArgs = Array.isArray(args['args']) ? args['args'] : []
  const argv = rawArgs.map((item) => String(item))
  const base = await workspaceRoot(root)
  const cwdInput = typeof args['cwd'] === 'string' ? args['cwd'] : '.'
  const cwd = await resolveExisting(root, cwdInput)
  const cwdInfo = await stat(cwd)
  if (!cwdInfo.isDirectory()) throw new Error('cwd is not a directory')
  assertInside(base, cwd)

  // Bare program names are resolved through PATH. Anything with a separator is
  // a filesystem path, so it must resolve inside the workspace (including
  // through symlinks). This blocks "../../evil" style escapes.
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const candidate = isAbsolute(command) ? command : resolve(cwd, command)
    assertInside(base, candidate)
    const real = await realpath(candidate).catch(() => null)
    if (real) assertInside(base, real)
    else throw new Error('Command executable was not found')
  }
  return { command, argv, cwd, base }
}

export async function runCommand(
  root: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CommandOutput> {
  const { command, argv, cwd, base } = await planCommand(root, args)
  const timeoutMs = Math.min(600_000, Math.max(1_000, Number(args['timeoutMs'] ?? 120_000) || 120_000))
  const startedAt = Date.now()
  // Cheap statfs before every command: a nearly full volume explains an
  // ENOSPC that would otherwise surface only midway through a long build.
  const disk = await diskSpace(base)

  return new Promise<CommandOutput>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    const child = spawn(command, argv, {
      cwd,
      env: { ...process.env, PILOT_WORKSPACE: base },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
      const warning = diskWarning(disk)
      const { text, truncated } = truncateOutput(
        warning ? `${combined || '(no output)'}\n\n${warning}` : combined || '(no output)',
      )
      const failure =
        error ??
        (timedOut
          ? timeoutFailureMessage(timeoutMs)
          : aborted
            ? 'Run cancelled'
            : exitCode !== 0
              ? commandFailureMessage(exitCode)
              : undefined)
      const failed = Boolean(failure) || exitCode !== 0 || exitCode === null
      resolvePromise({
        ok: !failed,
        output: text,
        ...(failure ? { error: failure } : {}),
        exitCode,
        durationMs: Date.now() - startedAt,
        metadata: {
          command,
          args: argv,
          exitCode,
          timedOut,
          aborted,
          truncated,
          diskFreeBytes: disk.freeBytes,
        },
      })
    }

    const killTree = (): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      killTree()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_COMMAND_OUTPUT_BYTES * 3) stdout = stdout.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_COMMAND_OUTPUT_BYTES * 3) stderr = stderr.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
    })
    child.on('error', (error) =>
      finish(null, `Failed to start "${command}" (working directory: ${cwd}): ${error.message}`),
    )
    child.on('close', (code) => finish(code))
  })
}

/**
 * Run a full shell command line inside the workspace. This intentionally
 * supports pipes, redirects, chaining and environment expansion, so it can
 * reach outside the workspace. It is only exposed when the user enables
 * shell mode, and the agent loop is required to ask for approval per call.
 */
export async function runShell(
  root: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  sandbox?: { network: boolean } | null,
  shellInterpreter: ShellInterpreter = 'auto',
): Promise<CommandOutput> {
  const command = typeof args['command'] === 'string' ? args['command'].trim() : ''
  if (!command || command.includes('\0')) throw new Error('command must be a non-empty string')
  const base = await workspaceRoot(root)
  const cwdInput = typeof args['cwd'] === 'string' ? args['cwd'] : '.'
  const cwd = await resolveExisting(root, cwdInput)
  const cwdInfo = await stat(cwd)
  if (!cwdInfo.isDirectory()) throw new Error('cwd is not a directory')
  assertInside(base, cwd)

  const timeoutMs = Math.min(600_000, Math.max(1_000, Number(args['timeoutMs'] ?? 120_000) || 120_000))
  const sandboxPlan = sandbox
    ? await buildSandboxPlan({
        workspacePath: base,
        cwd,
        command,
        network: sandbox.network,
      })
    : null
  if (sandbox && !sandboxPlan) {
    throw new Error(
      'The OS sandbox was requested but is not available. Refusing to run the command unsandboxed.',
    )
  }
  // Sandbox plans bring their own bash; only resolve an interpreter when the
  // command runs directly on the host.
  const launch = sandboxPlan ? null : resolveShellLaunch(shellInterpreter, command)
  const startedAt = Date.now()
  const disk = await diskSpace(base)

  const env: NodeJS.ProcessEnv = { ...process.env }
  // Git Bash commands no longer run as login shells. Merge the login
  // environment captured once at startup so PATH and other profile additions
  // still apply without paying the profile cost on every command.
  if (launch?.label === 'Git Bash' && process.platform === 'win32') {
    const loginEnv = await gitBashLoginEnvironment(launch.file)
    if (loginEnv) Object.assign(env, loginEnv)
  }
  // BASH_ENV/ENV would make every non-interactive shell source a startup file
  // again, defeating the cached environment.
  delete env['BASH_ENV']
  delete env['ENV']
  env['PILOT_WORKSPACE'] = base
  // Never expose Pilot's own key material to shell commands; project-level
  // variables such as DEEPSEEK_API_KEY remain available for legitimate builds.
  delete env['PILOT_API_KEY']

  return new Promise<CommandOutput>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let forceTimer: NodeJS.Timeout | null = null
    let drainTimer: NodeJS.Timeout | null = null
    let child: ChildProcess
    try {
      child = sandboxPlan
        ? spawn(sandboxPlan.file, sandboxPlan.args, {
            cwd: sandboxPlan.cwd,
            env,
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn(launch!.file, launch!.args, {
            cwd,
            env,
            shell: launch!.shell,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
    } catch (error) {
      resolvePromise({
        ok: false,
        output: '',
        error: `Failed to start shell (working directory: ${cwd}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        metadata: {
          command,
          shell: sandboxPlan?.backend ?? launch?.label ?? 'shell',
          sandbox: sandboxPlan?.display ?? null,
          exitCode: null,
        },
      })
      return
    }

    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      if (drainTimer) clearTimeout(drainTimer)
      signal.removeEventListener('abort', onAbort)
      const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
      const warning = diskWarning(disk)
      const { text, truncated } = truncateOutput(
        warning ? `${combined || '(no output)'}\n\n${warning}` : combined || '(no output)',
      )
      const failure =
        error ??
        (timedOut
          ? timeoutFailureMessage(timeoutMs)
          : aborted
            ? 'Run cancelled'
            : exitCode !== 0
              ? commandFailureMessage(exitCode)
              : undefined)
      const failed = Boolean(failure) || exitCode !== 0 || exitCode === null
      resolvePromise({
        ok: !failed,
        output: text,
        ...(failure ? { error: failure } : {}),
        exitCode,
        durationMs: Date.now() - startedAt,
        metadata: {
          command,
          shell: sandboxPlan?.backend ?? launch?.label ?? 'shell',
          sandbox: sandboxPlan?.display ?? null,
          exitCode,
          timedOut,
          aborted,
          truncated,
          diskFreeBytes: disk.freeBytes,
        },
      })
    }

    const killTree = (): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        // Absolute path: the login environment merged into `env` may not
        // include System32, and spawn() resolves against PATH.
        const taskkill = process.env['SystemRoot']
          ? join(process.env['SystemRoot'], 'System32', 'taskkill.exe')
          : 'taskkill'
        const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // The process is already gone.
          }
        })
        // A launcher process may have exited while its real child lives on.
        // Kill the direct child too; the force timer below guarantees the
        // tool call settles even if the tree cannot be reached.
        try {
          child.kill('SIGKILL')
        } catch {
          // The process is already gone.
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }

    /**
     * A timed-out or cancelled command must never leave the agent waiting
     * forever. Give the kill a short grace period, then settle the tool call
     * even if some descendant still holds the stdout/stderr pipes open.
     */
    const forceFinishAfterKill = (): void => {
      if (settled || forceTimer) return
      forceTimer = setTimeout(() => finish(null), 3_000)
      forceTimer.unref?.()
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
      forceFinishAfterKill()
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      killTree()
      forceFinishAfterKill()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_COMMAND_OUTPUT_BYTES * 3) {
        stdout = stdout.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > MAX_COMMAND_OUTPUT_BYTES * 3) {
        stderr = stderr.slice(-MAX_COMMAND_OUTPUT_BYTES * 3)
      }
    })
    child.on('error', (error) =>
      finish(null, `Failed to start shell (working directory: ${cwd}): ${error.message}`),
    )
    // `exit` fires when the shell itself is done. `close` waits for every
    // stdio pipe to close, which a background child can hold open forever
    // (e.g. `server &`). The shell's exit is the command's completion; drain
    // the pipes briefly, then settle instead of hanging the whole agent run.
    child.on('exit', (code) => {
      if (settled) return
      drainTimer = setTimeout(() => finish(code), 500)
      drainTimer.unref?.()
    })
    child.on('close', (code) => finish(code))
  })
}

export async function runGit(
  root: string,
  args: string[],
  signal: AbortSignal,
): Promise<CommandOutput> {
  return runCommand(root, { command: 'git', args, timeoutMs: 30_000 }, signal)
}

export async function gitStatus(root: string, signal: AbortSignal): Promise<string> {
  const branch = await runGit(root, ['branch', '--show-current'], signal)
  const status = await runGit(root, ['status', '--porcelain=v1', '-b'], signal)
  return `${branch.output}\n${status.output}`.trim()
}

export async function gitDiff(
  root: string,
  options: { path?: string; staged?: boolean; stat?: boolean },
  signal: AbortSignal,
): Promise<string> {
  const args = ['diff', '--no-color']
  if (options.staged) args.push('--cached')
  if (options.stat) args.push('--stat')
  if (options.path) args.push('--', String(options.path))
  const result = await runGit(root, args, signal)
  return result.output
}

export async function gitLog(
  root: string,
  options: { limit?: number; path?: string },
  signal: AbortSignal,
): Promise<string> {
  const args = ['log', `-${Math.min(50, Math.max(1, Number(options.limit ?? 20) || 20))}`, '--date=short', '--pretty=format:%h %ad %an: %s']
  if (options.path) args.push('--', String(options.path))
  const result = await runGit(root, args, signal)
  return result.output
}
