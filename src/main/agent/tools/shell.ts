// 进程与命令执行工具：一次性命令、shell、长驻进程。
// 工具定义与执行放在一起：改一个工具只动这一个文件。
import type { AgentToolDefinition, ToolResult } from '../../../shared/types'
import { runCommand, runShell } from '../../workspace'
import { RUN_COMMAND, RUN_SHELL, START_PROCESS, READ_PROCESS_OUTPUT, STOP_PROCESS, LIST_PROCESSES, RUN_SHELL_DESCRIPTION } from './spec'
import type { ToolHost } from './spec'

export const shellTools: AgentToolDefinition[] = [
{
    name: RUN_COMMAND,
    description:
      'Run a program inside the workspace without a shell. Pass argv separately, for example command "npm", args ["test"]. cwd defaults to the workspace root. Prefer the narrowest check that proves your change (one test file, tsc, a linter) over a full suite.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name or path inside the workspace.' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string', description: 'Relative working directory.' },
        timeoutMs: { type: 'number', description: 'Default 120000, max 600000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: RUN_SHELL,
    description: RUN_SHELL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Complete command line, for example "npm test -- --run" or "git diff | head -80".',
        },
        cwd: { type: 'string', description: 'Relative working directory inside the workspace.' },
        timeoutMs: { type: 'number', description: 'Default 120000, max 600000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
    alwaysAsk: true,
  },
{
    name: START_PROCESS,
    description:
      'Start a long-lived program in the workspace (dev server, watcher, Electron shell, app preview) and keep it running across later tool calls. The process is jailed to the workspace, capped at 4 per run, and killed when the run ends. Pass readyPattern (regex matched against output), readyUrl, or port (localhost HTTP probe) to wait until the app is actually serving. Pass env for extra environment variables: use it to give an app a test database or to launch a second Pilot with its own PILOT_USER_DATA_DIR. Pilot always removes its own PILOT_API_KEY from the child environment. When you add --remote-debugging-port to a Chromium/Electron app, app_targets and app_control can then inspect and drive it. Use run_command for one-shot commands; do not use this for tests or builds. Returns a processId used by read_process_output and stop_process.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name or workspace-relative path.' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string', description: 'Relative working directory; defaults to the workspace root.' },
        label: { type: 'string', description: 'Short human-readable name for this process.' },
        readyPattern: {
          type: 'string',
          description: 'Regular expression; startup is considered ready when output matches.',
        },
        readyUrl: {
          type: 'string',
          description: 'Localhost http(s) URL to probe until it responds.',
        },
        port: { type: 'number', description: 'Localhost port to probe until it accepts HTTP.' },
        waitMs: {
          type: 'number',
          description: 'How long to wait for readiness or an early crash, 0-20000. Default 4200 when a signal is given.',
        },
        env: {
          type: 'object',
          description:
            'Extra environment variables for the child process. Keys must be valid variable names; values are strings. PILOT_API_KEY is always removed.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: READ_PROCESS_OUTPUT,
    description:
      'Read the most recent output of a process started with start_process. Returns running/exited status, pid, uptime and the last tailLines lines (default 120). Read it after the app has been running or after a request to check for runtime errors.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Process id from start_process, e.g. proc-1.' },
        tailLines: { type: 'number', description: 'Lines of recent output, 1-1000.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: STOP_PROCESS,
    description:
      'Stop a process started with start_process, including its child process tree. Returns the final output. Always stop servers you started once you no longer need them; the run also stops every remaining process automatically.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: LIST_PROCESSES,
    description: 'List processes started in this run, with status and command line.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    source: 'builtin',
  },
]

/** 进程与命令执行工具：一次性命令、shell、长驻进程。 返回 null 表示本域没有这个工具。 */
export async function runShellTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult | null> {
  if (name === RUN_COMMAND) {
  {
        const result = await runCommand(host.root, args, signal)
        return {
          ok: result.ok,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          metadata: result.metadata,
        }
      }
  }
  if (name === RUN_SHELL) {
  {
        const result = await runShell(
          host.root,
          args,
          signal,
          host.sandbox ?? null,
          host.shellInterpreter ?? 'auto',
        )
        return {
          ok: result.ok,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          metadata: result.metadata,
        }
      }
  }
  if (name === START_PROCESS) {
  {
        if (!host.processes) throw new Error('Long-lived processes are not available in this context')
        return host.processes.start(host.root, args)
      }
  }
  if (name === READ_PROCESS_OUTPUT) {
  {
        if (!host.processes) throw new Error('Long-lived processes are not available in this context')
        return host.processes.read(args)
      }
  }
  if (name === STOP_PROCESS) {
  {
        if (!host.processes) throw new Error('Long-lived processes are not available in this context')
        return host.processes.stop(args)
      }
  }
  if (name === LIST_PROCESSES) {
  {
        if (!host.processes) throw new Error('Long-lived processes are not available in this context')
        return host.processes.list()
      }
  }
  return null
}
