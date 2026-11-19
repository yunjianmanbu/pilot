import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ShellInterpreter } from '../shared/types'

export interface ShellLaunch {
  file: string
  args: string[]
  /** Passed to spawn(): a command interpreter string, or false for direct exec. */
  shell: boolean | string
  /** Short label included in tool metadata. */
  label: string
}

export interface ShellEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Git Bash (MSYS2), never the WSL launcher in System32. */
  bashPath: string | null
  wslAvailable: boolean
  /** False when `wslAvailable` has not been probed yet (Git Bash was found). */
  wslProbed?: boolean
}

export interface ShellInterpreterStatus {
  effective: 'bash' | 'wsl' | 'cmd' | 'posix' | 'missing'
  detail: string
}

function pathExists(file: string): boolean {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}

function isGitBashPath(candidate: string): boolean {
  // C:\Windows\System32\bash.exe is the old WSL launcher, not Git Bash.
  return !/[\\/]windows[\\/]system32[\\/]bash\.exe$/i.test(candidate)
}

function candidateBashPaths(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = []
  const programDirs = [env['ProgramW6432'], env['ProgramFiles'], env['ProgramFiles(x86)']]
  for (const dir of programDirs) {
    if (!dir) continue
    // Git's `bin/bash.exe` is a small launcher that starts the real MSYS
    // binary in `usr/bin`. Spawning the launcher makes ChildProcess.pid point
    // at a process that exits immediately, so timeouts cannot kill the actual
    // shell tree. Prefer the real binary; the login environment merged by
    // runShell supplies the MSYS PATH it needs.
    paths.push(join(dir, 'Git', 'usr', 'bin', 'bash.exe'))
    paths.push(join(dir, 'Git', 'bin', 'bash.exe'))
  }
  const localAppData = env['LOCALAPPDATA']
  if (localAppData) {
    paths.push(join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'))
    paths.push(join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'))
  }
  const userProfile = env['USERPROFILE']
  if (userProfile) {
    paths.push(join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'))
    paths.push(join(userProfile, 'scoop', 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'))
  }
  return paths
}

function runWhere(target: string, env: NodeJS.ProcessEnv): string[] {
  const where = env['SystemRoot'] ? join(env['SystemRoot'], 'System32', 'where.exe') : 'where.exe'
  try {
    const result = spawnSync(where, [target], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
      env,
    })
    if (result.error || result.status !== 0) return []
    return String(result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function findBash(env: NodeJS.ProcessEnv): string | null {
  for (const candidate of candidateBashPaths(env)) {
    if (pathExists(candidate)) return candidate
  }
  for (const candidate of runWhere('bash.exe', env)) {
    if (isGitBashPath(candidate) && pathExists(candidate)) return candidate
  }
  return null
}

function hasWslDistro(env: NodeJS.ProcessEnv): boolean {
  const systemRoot = env['SystemRoot'] || 'C:\\Windows'
  const systemWsl = join(systemRoot, 'System32', 'wsl.exe')
  const wsl = pathExists(systemWsl)
    ? systemWsl
    : runWhere('wsl.exe', env).find((candidate) => pathExists(candidate))
  if (!wsl) return false
  try {
    const result = spawnSync(wsl, ['--list', '--quiet'], {
      encoding: 'utf8',
      timeout: 2_500,
      windowsHide: true,
      env,
    })
    if (result.error || result.status !== 0) return false
    // wsl.exe emits UTF-16LE; stripping NUL bytes leaves readable names.
    return String(result.stdout ?? '').replace(/\0/g, '').trim().length > 0
  } catch {
    return false
  }
}

let cachedEnvironment: ShellEnvironment | null = null

/** Detection is cached: settings are read on every renderer bootstrap. */
export function shellEnvironment(): ShellEnvironment {
  if (cachedEnvironment) return cachedEnvironment
  if (process.platform !== 'win32') {
    cachedEnvironment = {
      platform: process.platform,
      env: process.env,
      bashPath: null,
      wslAvailable: false,
    }
    return cachedEnvironment
  }
  const bashPath = findBash(process.env)
  cachedEnvironment = {
    platform: process.platform,
    env: process.env,
    bashPath,
    // Presence of wsl.exe is not enough: without a distro, `wsl.exe -e bash`
    // fails on every command. With Git Bash available, WSL is never the
    // automatic choice, so skip the slow probe until someone asks for it.
    wslAvailable: bashPath ? false : hasWslDistro(process.env),
    wslProbed: bashPath ? false : true,
  }
  return cachedEnvironment
}

/**
 * Probe WSL on demand. A test-provided environment (no `wslProbed` field) is
 * treated as already probed, so unit tests never touch the real machine.
 */
function ensureWsl(environment: ShellEnvironment): boolean {
  if (environment.platform !== 'win32') return false
  if (environment.wslProbed !== false) return environment.wslAvailable
  environment.wslAvailable = hasWslDistro(environment.env)
  environment.wslProbed = true
  return environment.wslAvailable
}

/** Test seam; production uses the process environment. */
export function resetShellEnvironmentCache(): void {
  cachedEnvironment = null
  loginEnvironmentCache.clear()
}

/**
 * Variables that are per-process bookkeeping rather than profile output.
 * Copying them into a new shell would pin the old cwd or re-enter the login
 * startup files, which is exactly the cost this cache exists to avoid.
 */
const LOGIN_ENV_SKIP = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD', 'BASH_ENV', 'ENV'])
/** Values larger than this are almost always serialized blobs, not PATH-like data. */
const MAX_LOGIN_ENV_VALUE_CHARS = 64 * 1024

/**
 * Parse `env -0` output. Startup scripts occasionally print a banner on stdout
 * before the first entry, so an entry is accepted only when a line inside it
 * looks like `NAME=value`.
 */
export function parseLoginEnvironment(raw: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {}
  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const match = /(?:^|\r?\n)([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(entry)
    if (!match) continue
    const key = match[1]!
    if (LOGIN_ENV_SKIP.has(key) || key.startsWith('PILOT_') || key.startsWith('BASH_FUNC_')) {
      continue
    }
    const value = match[2] ?? ''
    if (value.length > MAX_LOGIN_ENV_VALUE_CHARS) continue
    parsed[key] = value
  }
  return parsed
}

// Keyed by bash path so a test override or a different install is not served a
// stale environment. A null result is cached too: retrying a broken profile on
// every command would pay the startup cost without ever succeeding.
const loginEnvironmentCache = new Map<string, Promise<NodeJS.ProcessEnv | null>>()

/**
 * Capture the environment produced by Git Bash's login startup files once. The
 * old code ran every command through `bash -lc`, which re-ran /etc/profile and
 * ~/.bashrc each time (~1.8s on Windows). Commands now use `bash -c` with this
 * environment merged in, so PATH additions from those files still apply.
 */
export function gitBashLoginEnvironment(bashPath: string): Promise<NodeJS.ProcessEnv | null> {
  const cached = loginEnvironmentCache.get(bashPath)
  if (cached) return cached
  const pending = new Promise<NodeJS.ProcessEnv | null>((resolve) => {
    let settled = false
    let output = ''
    const finish = (value: NodeJS.ProcessEnv | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(bashPath, ['-lc', 'env -0'], {
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      finish(null)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may already have exited.
      }
      finish(null)
    }, 5_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      // Keep only recent output if a profile is unusually chatty.
      if (output.length > 2_000_000) output = output.slice(-1_000_000)
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const parsed = code === 0 ? parseLoginEnvironment(output) : null
      finish(parsed && Object.keys(parsed).length > 0 ? parsed : null)
    })
  })
  loginEnvironmentCache.set(bashPath, pending)
  return pending
}

/**
 * Start the profile capture during app startup so the first command is fast.
 * Deferred: shell detection itself can probe the filesystem, and window
 * creation must not wait for it.
 */
export function warmShellProfile(): void {
  setImmediate(() => {
    try {
      const environment = shellEnvironment()
      if (environment.platform !== 'win32' || !environment.bashPath) return
      void gitBashLoginEnvironment(environment.bashPath)
    } catch {
      // Startup prewarming is best-effort; commands still work without it.
    }
  })
}

function cmdLaunch(env: NodeJS.ProcessEnv, command: string): ShellLaunch {
  const shellPath = env['ComSpec'] || 'cmd.exe'
  return {
    // Keep the previous behavior: let Node wrap the command in cmd.exe.
    file: command,
    args: [],
    shell: shellPath,
    label: basename(shellPath),
  }
}

function bashLaunch(bashPath: string, command: string): ShellLaunch {
  return {
    file: bashPath,
    // Non-login: the login environment is captured once and merged by the
    // caller, avoiding a ~1.8s profile run for every command.
    args: ['-c', command],
    shell: false,
    label: 'Git Bash',
  }
}

function wslLaunch(command: string): ShellLaunch {
  return {
    file: 'wsl.exe',
    args: ['-e', 'bash', '-lc', command],
    shell: false,
    label: 'WSL bash',
  }
}

/**
 * Pick the interpreter and argument shape for one command. `auto` prefers Git
 * Bash because it understands Windows workspace paths directly; WSL is the
 * fallback before cmd.exe.
 */
export function resolveShellLaunch(
  interpreter: ShellInterpreter,
  command: string,
  environment: ShellEnvironment = shellEnvironment(),
): ShellLaunch {
  const { env, platform } = environment
  if (platform !== 'win32') {
    const shellPath = env['SHELL'] || '/bin/sh'
    // Unchanged POSIX behavior: Node runs `<shell> -c <command>`.
    return { file: command, args: [], shell: shellPath, label: basename(shellPath) }
  }
  if (interpreter === 'cmd') return cmdLaunch(env, command)
  if (interpreter === 'bash') {
    if (!environment.bashPath) {
      throw new Error(
        'Git Bash was not found. Install Git for Windows, choose auto, or switch the shell interpreter to cmd.',
      )
    }
    return bashLaunch(environment.bashPath, command)
  }
  if (interpreter === 'wsl') {
    if (!ensureWsl(environment)) {
      throw new Error(
        'WSL is not available (wsl.exe or a Linux distribution was not found). Install WSL, choose auto, or switch the shell interpreter to cmd.',
      )
    }
    return wslLaunch(command)
  }
  if (environment.bashPath) return bashLaunch(environment.bashPath, command)
  if (ensureWsl(environment)) return wslLaunch(command)
  return cmdLaunch(env, command)
}

/** Short English label injected into the system prompt so the model matches syntax. */
export function shellInterpreterLabel(
  interpreter: ShellInterpreter,
  environment: ShellEnvironment = shellEnvironment(),
): string {
  const status = shellInterpreterStatus(interpreter, environment)
  switch (status.effective) {
    case 'bash':
      return 'Git Bash (POSIX bash syntax: $VAR, forward-slash paths)'
    case 'wsl':
      return 'WSL bash (POSIX bash syntax; workspace paths are mapped by WSL)'
    case 'cmd':
      return 'cmd.exe (use %VAR% for environment variables and cmd built-ins)'
    case 'posix':
      return '$SHELL (POSIX syntax)'
    default:
      return ''
  }
}

export function shellInterpreterStatus(
  interpreter: ShellInterpreter,
  environment: ShellEnvironment = shellEnvironment(),
): ShellInterpreterStatus {
  if (environment.platform !== 'win32') {
    const shellPath = environment.env['SHELL'] || '/bin/sh'
    return {
      effective: 'posix',
      detail: `非 Windows 系统使用 $SHELL（${shellPath}），此选项不影响执行。`,
    }
  }
  const bash = environment.bashPath
  if (interpreter === 'cmd') {
    return {
      effective: 'cmd',
      detail: `使用 ${environment.env['ComSpec'] || 'cmd.exe'} 执行。支持管道、重定向和 %VAR% 变量，兼容 .bat/.cmd。`,
    }
  }
  if (interpreter === 'bash') {
    return bash
      ? { effective: 'bash', detail: `使用 Git Bash：${bash}` }
      : {
          effective: 'missing',
          detail: '未找到 Git Bash。请安装 Git for Windows，或改为「自动 / cmd」。',
        }
  }
  if (interpreter === 'wsl') {
    return ensureWsl(environment)
      ? {
          effective: 'wsl',
          detail: '使用 wsl.exe -e bash -lc 执行；工作区路径由 WSL 自动映射。',
        }
      : {
          effective: 'missing',
          detail: '未检测到可用的 WSL 发行版（或 wsl.exe 不存在）。请安装 WSL，或改为「自动 / cmd」。',
        }
  }
  if (bash) {
    return { effective: 'bash', detail: `自动选择 Git Bash：${bash}` }
  }
  if (ensureWsl(environment)) {
    return {
      effective: 'wsl',
      detail: '未找到 Git Bash，自动改用 WSL 中的 bash；需要已安装可用的 Linux 发行版。',
    }
  }
  return {
    effective: 'cmd',
    detail: '未找到 Git Bash 或 WSL，自动使用 cmd.exe。命令仍按 cmd 语法执行。',
  }
}
