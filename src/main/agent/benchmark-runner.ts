/**
 * Wire the paired benchmark to the real agent loop.
 *
 * The only difference between the two variants is the profile text appended to
 * the system prompt. Model, tools, limits and workspace setup are identical, so
 * a measured difference is attributable to the profile.
 *
 * The tool set mirrors production, `run_shell` included. Hiding the shell would
 * punish any profile that teaches piped/narrow commands (`grep | head`, `&&`
 * chains) for a capability the harness removed — a profile measured as worse
 * for a reason production never sees. Both variants get the same shell, so the
 * paired comparison stays attributable.
 */
import {
  APPLY_PATCH,
  GET_FILE_INFO,
  LIST_DIRECTORY,
  PROJECT_MAP,
  READ_FILE,
  RUN_COMMAND,
  RUN_SHELL,
  SEARCH_FILES,
  UPDATE_PLAN,
  WRITE_FILE,
  executePilotTool,
  pilotTools,
  withShellDescription,
  type ToolHost,
} from './tools'
import { shellInterpreterLabel } from '../shell'
import { buildSystemPrompt } from './prompt'
import { runAgentLoop, type ModelClient } from './loop'
import type { AgentToolDefinition, ProfileVersion, ShellInterpreter } from '../../shared/types'
import type { TaskRunner } from './profile-benchmark'

/** Production tool set minus processes, GUI driving and network: file work plus one shell. */
const BENCHMARK_TOOLS = new Set([
  READ_FILE,
  WRITE_FILE,
  APPLY_PATCH,
  LIST_DIRECTORY,
  PROJECT_MAP,
  SEARCH_FILES,
  GET_FILE_INFO,
  RUN_COMMAND,
  RUN_SHELL,
  UPDATE_PLAN,
])

export interface BenchmarkRunnerOptions {
  client: ModelClient
  /** Workspace addendum text for each variant; empty string means "no profile". */
  addendumFor: (variant: 'current' | 'candidate') => string
  /**
   * Global-layer addendum for each variant. A global benchmark holds the
   * workspace layer empty so the measured difference comes from the global
   * change alone.
   */
  globalAddendumFor?: (variant: 'current' | 'candidate') => string
  maxSteps?: number
  maxTokens?: number
  /**
   * Give the benchmark the same shell access production gets. Defaults to on;
   * pass `false` for the old file-tools-only comparison.
   */
  shellMode?: boolean
  /** Interpreter for run_shell; `auto` (the default) detects Git Bash / WSL / cmd. */
  shellInterpreter?: ShellInterpreter
  signal?: AbortSignal
  /** Called for every sample so the UI can show progress. */
  onRun?: (info: { taskId: string; variant: 'current' | 'candidate' }) => void
}

function profileOf(addendum: string, label: string): ProfileVersion | null {
  if (!addendum.trim()) return null
  return {
    id: `benchmark-${label}`,
    version: 0,
    promptAddendum: addendum,
    strategy: {},
    rationale: 'benchmark variant',
    source: 'user',
    evidence: { runs: 0, failures: 0, avgSteps: 0, avgTokens: 0, positive: 0, negative: 0 },
    status: 'draft',
    createdAt: new Date().toISOString(),
  }
}

export function createBenchmarkTaskRunner(options: BenchmarkRunnerOptions): TaskRunner {
  const shellMode = options.shellMode !== false
  const shellLabel = shellMode
    ? shellInterpreterLabel(options.shellInterpreter ?? 'auto')
    : undefined
  const tools = withShellDescription(
    pilotTools.filter(
      (tool) => BENCHMARK_TOOLS.has(tool.name) && (shellMode || tool.name !== RUN_SHELL),
    ),
    shellLabel,
  )
  return async ({ task, variant, workspacePath }) => {
    options.onRun?.({ taskId: task.id, variant })
    const system = buildSystemPrompt({
      root: workspacePath,
      topLevel: '',
      memory: [],
      profile: profileOf(options.addendumFor(variant), variant),
      globalProfile: options.globalAddendumFor
        ? profileOf(options.globalAddendumFor(variant), `global-${variant}`)
        : null,
      plan: null,
      selfUpdate: false,
      shellMode,
      ...(shellLabel ? { shellInterpreter: shellLabel } : {}),
      approvalMode: 'auto',
    })
    const controller = new AbortController()
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal
    const host: ToolHost = {
      root: workspacePath,
      shellEnabled: shellMode,
      ...(shellMode ? { shellInterpreter: options.shellInterpreter ?? 'auto' } : {}),
      remember: async () => ({ id: '' }),
      updatePlan: () => {},
      proposeSelfUpdate: async (input) =>
        ({ id: `unused-${input.rationale.length}`, status: 'draft' }) as never,
    }
    const result = await runAgentLoop({
      model: options.client,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: task.prompt },
      ],
      tools: tools as AgentToolDefinition[],
      maxSteps: options.maxSteps ?? 24,
      maxTokens: options.maxTokens ?? 120_000,
      temperature: 0.2,
      signal,
      /*
       * The benchmark workspace is a throwaway temp directory holding one
       * fixture, the tool set is fixed above and no user is present. Without a
       * policy, the loop resolves every write and exec call to `ask`; with no
       * approval handler attached it refunds the call with
       * "Approval is required, but no approval handler is connected". Every task
       * then failed on both sides, every comparison became a 0-0-N tie, and the
       * activation gate could never open — the whole feature measured nothing.
       * Auto here is not a relaxation of the user's approval mode: it is the
       * only way a measured run can touch the fixture at all.
       */
      policy: () => 'auto',
      executeTool: (execution) =>
        executePilotTool(execution.call.name, execution.call.arguments, host, signal),
    })
    return {
      ok: result.status === 'completed',
      steps: result.steps,
      tokens: result.usage.totalTokens,
      output: result.content,
    }
  }
}
