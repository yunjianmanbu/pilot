import { spawn, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import type { ToolResult } from '../../shared/types'
import { planCommand } from '../workspace'

/**
 * Long-lived processes the agent starts while working on a project (dev
 * servers, watchers, an Electron shell). Every process is:
 * - started through the same deny list / cwd jail as run_command,
 * - capped per run and killed when the run ends,
 * - observed through a bounded output ring buffer, never an unbounded pipe.
 *
 * The manager is intentionally per-run: a continuation starts a fresh one and
 * must restart whatever it still needs. That keeps cleanup deterministic.
 */
const MAX_PROCESSES = 4
const MAX_OUTPUT_CHARS = 64_000
const MAX_START_WAIT_MS = 20_000
const DEFAULT_GRACE_MS = 700

export interface ProcessStartOptions {
  command: string
  args?: string[]
  cwd?: string
  label?: string
  readyPattern?: string
  readyUrl?: string
  port?: number
  waitMs?: number
  env?: Record<string, string>
}

interface Entry {
  id: string
  label: string
  command: string
  args: string[]
  cwd: string
  child: ChildProcess
  pid: number | null
  startedAt: number
  output: string
  running: boolean
  exitCode: number | null
  error: string | null
  ready: boolean
  readyDetail: string | null
}

interface LaunchSpec {
  file: string
  args: string[]
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function safeArgument(value: unknown): string {
  const text = String(value)
  if (text.length > 2_000) throw new Error('Process argument is too long (max 2000 characters)')
  if (/[\0\r\n]/.test(text)) throw new Error('Process arguments may not contain control characters')
  return text
}

/**
 * Extra environment variables for a started process. This is what makes it
 * possible to launch a second Pilot instance (`PILOT_USER_DATA_DIR`) or point
 * an app at a test database. Values are plain strings: no NUL, newline or
 * carriage return, so a value cannot smuggle a second argument through a
 * .cmd shim. Pilot's own API key is removed after the merge and can never be
 * forwarded, no matter what the caller passes.
 */
export function parseProcessEnv(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('env must be an object of string values')
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > 64) throw new Error('env may contain at most 64 variables')
  const result: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`)
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Environment variable ${key} must be a string`)
    }
    const text = String(value)
    if (/[\0\r\n]/.test(text)) {
      throw new Error(`Environment variable ${key} may not contain control characters`)
    }
    if (text.length > 8_000) throw new Error(`Environment variable ${key} is too long (max 8000 characters)`)
    result[key] = text
  }
  return result
}

function quoteCmd(value: string): string {
  // Callers reject embedded double quotes before reaching this point.
  return `"${value}"`
}

function whereAll(command: string): Promise<string[]> {
  return new Promise((resolvePromise) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(command)) {
      resolvePromise([])
      return
    }
    let output = ''
    const child = spawn('where', [command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', () => resolvePromise([]))
    child.on('close', (code) => {
      if (code !== 0) {
        resolvePromise([])
        return
      }
      resolvePromise(
        output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      )
    })
  })
}

/**
 * Windows package-manager launchers are `.cmd` shims, which Node cannot spawn
 * with shell:false. Resolve the shim explicitly and run it through cmd.exe with
 * every argument quoted; arguments containing quotes/control characters were
 * rejected earlier, so this cannot inject a second command.
 */
async function resolveLaunch(command: string, argv: string[]): Promise<LaunchSpec> {
  const bare = !command.includes('/') && !command.includes('\\')
  if (process.platform === 'win32' && bare) {
    const hits = await whereAll(command)
    const shim = hits.find((hit) => /\.(?:cmd|bat)$/i.test(hit))
    if (shim) {
      const line = [shim, ...argv].map(quoteCmd).join(' ')
      return {
        file: process.env['ComSpec'] ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `"${line}"`],
      }
    }
    const exe = hits.find((hit) => /\.exe$/i.test(hit))
    if (exe) return { file: exe, args: argv }
  }
  return { file: command, args: argv }
}

function validateReadyUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('readyUrl must be a valid http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('readyUrl must use http or https')
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
    throw new Error('readyUrl must point at localhost (Pilot only probes local services)')
  }
  return url.toString()
}

function appendOutput(entry: Entry, chunk: Buffer): void {
  entry.output += chunk.toString('utf8')
  if (entry.output.length > MAX_OUTPUT_CHARS) {
    entry.output = entry.output.slice(-MAX_OUTPUT_CHARS)
  }
}

function tail(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (!trimmed) return '(no output yet)'
  return trimmed.length > maxChars ? `…\n${trimmed.slice(-maxChars)}` : trimmed
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Process already gone.
    }
  }
}

function probe(url: string): Promise<boolean> {
  return fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(1_200),
  })
    .then((response) => response.status < 500)
    .catch(() => false)
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms))
}

export class ProcessManager {
  private readonly entries = new Map<string, Entry>()
  private counter = 0
  private disposed = false

  async start(root: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.disposed) throw new Error('This run has ended; no new processes can be started')
    const running = [...this.entries.values()].filter((entry) => entry.running)
    if (running.length >= MAX_PROCESSES) {
      throw new Error(
        `Already running ${running.length} processes (max ${MAX_PROCESSES}). Stop one with stop_process first: ${running
          .map((entry) => entry.id)
          .join(', ')}`,
      )
    }

    const plan = await planCommand(root, args)
    const argv = (Array.isArray(args['args']) ? args['args'] : []).map(safeArgument)
    const labelInput = typeof args['label'] === 'string' ? args['label'].trim() : ''
    if (labelInput.length > 80) throw new Error('label is too long (max 80 characters)')
    const label = labelInput || `${basename(plan.command)} ${argv.slice(0, 3).join(' ')}`.trim()

    const readyPatternRaw =
      typeof args['readyPattern'] === 'string' ? args['readyPattern'].trim() : ''
    if (readyPatternRaw.length > 200) throw new Error('readyPattern is too long (max 200 characters)')
    let readyPattern: RegExp | null = null
    if (readyPatternRaw) {
      try {
        readyPattern = new RegExp(readyPatternRaw)
      } catch {
        throw new Error('readyPattern is not a valid regular expression')
      }
    }
    const readyUrlRaw = typeof args['readyUrl'] === 'string' ? args['readyUrl'].trim() : ''
    const port = args['port'] === undefined ? null : clampInteger(args['port'], 0, 1, 65_535)
    if (args['port'] !== undefined && (!port || port < 1)) {
      throw new Error('port must be an integer between 1 and 65535')
    }
    const readyUrl = readyUrlRaw
      ? validateReadyUrl(readyUrlRaw)
      : port
        ? `http://127.0.0.1:${port}/`
        : null
    const waitMs = clampInteger(
      args['waitMs'],
      readyPattern || readyUrl ? DEFAULT_GRACE_MS * 6 : DEFAULT_GRACE_MS,
      0,
      MAX_START_WAIT_MS,
    )

    const launch = await resolveLaunch(plan.command, argv)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...parseProcessEnv(args['env']),
      PILOT_WORKSPACE: plan.base,
    }
    delete env['PILOT_API_KEY']
    const child = spawn(launch.file, launch.args, {
      cwd: plan.cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.counter += 1
    const entry: Entry = {
      id: `proc-${this.counter}`,
      label,
      command: plan.command,
      args: argv,
      cwd: plan.cwd,
      child,
      pid: child.pid ?? null,
      startedAt: Date.now(),
      output: '',
      running: true,
      exitCode: null,
      error: null,
      ready: false,
      readyDetail: null,
    }
    this.entries.set(entry.id, entry)

    child.stdout?.on('data', (chunk: Buffer) => appendOutput(entry, chunk))
    child.stderr?.on('data', (chunk: Buffer) => appendOutput(entry, chunk))
    child.on('error', (error) => {
      entry.running = false
      entry.error = error.message
    })
    child.on('close', (code) => {
      entry.running = false
      entry.exitCode = code
    })

    const deadline = Date.now() + waitMs
    let lastProbe = 0
    while (waitMs > 0 && Date.now() < deadline) {
      if (!entry.running) break
      if (readyPattern?.test(entry.output)) {
        entry.ready = true
        entry.readyDetail = `readyPattern matched: ${readyPatternRaw}`
        break
      }
      if (readyUrl && Date.now() - lastProbe >= 400) {
        lastProbe = Date.now()
        if (await probe(readyUrl)) {
          entry.ready = true
          entry.readyDetail = `ready URL responded: ${readyUrl}`
          break
        }
      }
      await delay(200)
    }

    if (!entry.running && entry.exitCode !== 0) {
      return {
        ok: false,
        output: tail(entry.output, 8_000),
        error: entry.error
          ? `Process failed to start: ${entry.error}`
          : `Process exited immediately with code ${entry.exitCode}. Use a long-running command for start_process; use run_command for one-shot work.`,
        metadata: this.metadata(entry),
      }
    }
    if (entry.error) {
      return {
        ok: false,
        output: tail(entry.output, 8_000),
        error: `Process failed to start: ${entry.error}`,
        metadata: this.metadata(entry),
      }
    }

    const status = entry.ready
      ? `ready (${entry.readyDetail})`
      : entry.running
        ? readyUrl || readyPattern
          ? 'running, but the readiness signal did not appear before the wait expired'
          : 'running'
        : `exited with code ${entry.exitCode ?? 'unknown'}`
    return {
      ok: true,
      output: [
        `Started ${entry.id}${entry.label ? ` (${entry.label})` : ''}`,
        `pid: ${entry.pid ?? 'unknown'} · cwd: ${entry.cwd}`,
        `command: ${plan.command} ${argv.join(' ')}`.trimEnd(),
        `status: ${status}`,
        '',
        tail(entry.output, 8_000),
      ].join('\n'),
      metadata: this.metadata(entry),
    }
  }

  read(args: Record<string, unknown>): ToolResult {
    const entry = this.require(args['id'])
    const tailLines = clampInteger(args['tailLines'], 120, 1, 1_000)
    const lines = entry.output.replace(/\r\n/g, '\n').split('\n')
    const body = lines.slice(-tailLines).join('\n')
    const status = entry.running
      ? 'running'
      : `exited with code ${entry.exitCode ?? 'unknown'}${entry.error ? ` (${entry.error})` : ''}`
    return {
      ok: true,
      output: [
        `${entry.id}${entry.label ? ` (${entry.label})` : ''} · ${status}${entry.ready ? ' · ready' : ''}`,
        `pid: ${entry.pid ?? 'unknown'} · uptime: ${Math.round((Date.now() - entry.startedAt) / 1000)}s`,
        '',
        tail(body, 12_000),
      ].join('\n'),
      metadata: this.metadata(entry),
    }
  }

  list(): ToolResult {
    const entries = [...this.entries.values()]
    if (entries.length === 0) {
      return { ok: true, output: 'No processes have been started in this run.' }
    }
    return {
      ok: true,
      output: entries
        .map((entry) => {
          const status = entry.running
            ? 'running'
            : `exited ${entry.exitCode ?? 'unknown'}${entry.error ? ` (${entry.error})` : ''}`
          return `${entry.id} · ${status} · ${entry.command} ${entry.args.join(' ')} · cwd ${entry.cwd}`
        })
        .join('\n'),
    }
  }

  async stop(args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.require(args['id'])
    if (!entry.running) {
      return {
        ok: true,
        output: `${entry.id} already exited with code ${entry.exitCode ?? 'unknown'}.\n\n${tail(entry.output, 6_000)}`,
        metadata: this.metadata(entry),
      }
    }
    killTree(entry.child)
    const deadline = Date.now() + 2_000
    while (entry.running && Date.now() < deadline) await delay(100)
    if (entry.running) {
      // taskkill is asynchronous; report the truth rather than claiming success.
      return {
        ok: false,
        output: tail(entry.output, 6_000),
        error: `${entry.id} is still running after the stop request (pid ${entry.pid ?? 'unknown'}).`,
        metadata: this.metadata(entry),
      }
    }
    return {
      ok: true,
      output: `Stopped ${entry.id} (exit code ${entry.exitCode ?? 'unknown'}).\n\n${tail(entry.output, 6_000)}`,
      metadata: this.metadata(entry),
    }
  }

  async stopAll(): Promise<void> {
    this.disposed = true
    const running = [...this.entries.values()].filter((entry) => entry.running)
    for (const entry of running) killTree(entry.child)
    const deadline = Date.now() + 2_000
    while (running.some((entry) => entry.running) && Date.now() < deadline) {
      await delay(100)
    }
    this.entries.clear()
  }

  private require(id: unknown): Entry {
    const key = typeof id === 'string' ? id.trim() : ''
    const entry = key ? this.entries.get(key) : undefined
    if (!entry) {
      const known = [...this.entries.keys()].join(', ') || 'none'
      throw new Error(`Unknown process id "${key || '(missing)'}". Known ids: ${known}`)
    }
    return entry
  }

  private metadata(entry: Entry): Record<string, unknown> {
    return {
      processId: entry.id,
      pid: entry.pid,
      running: entry.running,
      ready: entry.ready,
      exitCode: entry.exitCode,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
    }
  }
}
