import type { AgentToolDefinition } from '../../shared/types'
import type { ToolHost } from './tools/spec'
import { REVIEW_TOOL_ALLOWLIST, RUN_SHELL, RUN_SHELL_DESCRIPTION, LEARNING_RESEARCH, LEARNING_LOG, READ_FILE, LIST_DIRECTORY, SEARCH_FILES, GET_FILE_INFO, PROJECT_MAP } from './tools/spec'
import { runFileTool, fileTools } from './tools/files'
import { runCodeIntelTool, codeIntelTools } from './tools/code-intel'
import { runShellTool, shellTools } from './tools/shell'
import { runScreenTool, screenTools } from './tools/screen'
import { runToolsmithTool, toolsmithTools } from './tools/toolsmith'
import { runGitTool, gitTools } from './tools/git'
import { runDelegateTool, runLearningTool, delegateTools, learningTools } from './tools/delegate'
import { runPlanTool, planTools } from './tools/plan'
import type { ToolResult } from '../../shared/types'
import { systemAccessTools } from './system-access'

export * from './tools/spec'
export { formatLearningSummary, withReferenceRoots } from './tools/host'

/**
 * Every builtin tool, in the order the model sees them. Each domain keeps its
 * definitions next to the code that executes them.
 */
export const pilotTools: AgentToolDefinition[] = [
  ...fileTools,
  ...codeIntelTools,
  ...shellTools,
  ...screenTools,
  ...toolsmithTools,
  ...gitTools,
  ...delegateTools,
  ...planTools,
  ...learningTools,
  ...systemAccessTools,
];

/**
 * Tell the model which interpreter `run_shell` actually uses. The label comes
 * from shellInterpreterLabel(), so the tool description and the system prompt
 * never disagree about the shell.
 */
export function withShellDescription(
  tools: AgentToolDefinition[],
  shellLabel: string | undefined,
): AgentToolDefinition[] {
  if (!shellLabel) return tools
  return tools.map((tool) =>
    tool.name === RUN_SHELL
      ? {
          ...tool,
          description: `${RUN_SHELL_DESCRIPTION} The shell on this machine is ${shellLabel}. Write commands for that shell; when it is bash, use POSIX commands and do not wrap them in powershell.exe or cmd /c unless bash has no equivalent tool.`,
        }
      : tool,
  )
}

/** 学习探索关闭时，从工具列表里抹掉两个学习工具。 */
export function filterLearningTools(
  tools: AgentToolDefinition[],
  enabled: boolean,
): AgentToolDefinition[] {
  if (enabled) return tools
  return tools.filter((tool) => tool.name !== LEARNING_RESEARCH && tool.name !== LEARNING_LOG)
}

/** 完全自主档下可以接受工作区外绝对路径的读类工具。 */
const OPEN_READ_TOOLS = new Set([
  READ_FILE,
  LIST_DIRECTORY,
  SEARCH_FILES,
  GET_FILE_INFO,
  PROJECT_MAP,
])

/**
 * 完全自主档生效时给读类工具补一句实话：路径可以是工作区外的绝对路径。
 * 不生效时原描述保持不变，所以普通会话仍按工作区相对路径理解参数。
 */
export function withAutonomyAccess(
  tools: AgentToolDefinition[],
  fullAutonomy: boolean,
): AgentToolDefinition[] {
  if (!fullAutonomy) return tools
  return tools.map((tool) =>
    OPEN_READ_TOOLS.has(tool.name)
      ? {
          ...tool,
          description: `${tool.description} FULL-AUTONOMY MODE: path may also be an absolute path outside the workspace; credential, private-key, browser-session and password-store paths stay denied.`,
        }
      : tool,
  )
}

const TOOL_HANDLERS = [
  runFileTool,
  runCodeIntelTool,
  runShellTool,
  runScreenTool,
  runToolsmithTool,
  runGitTool,
  runDelegateTool,
  runLearningTool,
  runPlanTool,
];

/**
 * Execute one builtin tool. Each domain handler returns null when the name is
 * not its own, so adding a tool never touches this dispatcher.
 */
export async function executePilotTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (host.roots && host.roots.length > 0 && !REVIEW_TOOL_ALLOWLIST.has(name)) {
    throw new Error(`Tool ${name} is not available in a read-only review session`)
  }
  for (const handler of TOOL_HANDLERS) {
    const result = await handler(name, args, host, signal)
    if (result) return result
  }
  return { ok: false, output: "", error: `Unknown tool: ${name}` }
}
