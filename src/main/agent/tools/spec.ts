// 工具名常量、共享 JSON schema、宿主与请求类型，以及复盘会话的工具白名单。
// 这里不含执行逻辑：域文件从本文件取常量与类型，主 barrel 负责组装。
import type { DynamicToolInfo, PlanItem, ProfileExplanation, ReviewRoot, ScheduledTask, ScheduledTaskInput, ShellInterpreter, ToolResult } from '../../../shared/types'
import type { RegisterToolResult } from '../toolsmith'
import type { ProcessManager } from '../processes'
import type { LearningPolicy, LearningSourceRecord, LearningSummary } from '../learning'

export const READ_FILE = 'read_file'
export const WRITE_FILE = 'write_file'
export const APPLY_PATCH = 'apply_patch'
export const LIST_DIRECTORY = 'list_directory'
export const PROJECT_MAP = 'project_map'
export const SEARCH_FILES = 'search_files'
export const GET_FILE_INFO = 'get_file_info'
export const RUN_COMMAND = 'run_command'
export const RUN_SHELL = 'run_shell'
export const START_PROCESS = 'start_process'
export const READ_PROCESS_OUTPUT = 'read_process_output'
export const STOP_PROCESS = 'stop_process'
export const LIST_PROCESSES = 'list_processes'
export const SCREENSHOT = 'screenshot'
export const LIST_WINDOWS = 'list_windows'
export const APP_TARGETS = 'app_targets'
export const APP_CONTROL = 'app_control'
export const DRIVE_PROBE = 'drive_probe'
export const DRIVE_RECIPES = 'drive_recipes'
export const DRIVE_RUN = 'drive_run'
export const RUN_E2E = 'run_e2e'
export const LIST_TOOLS = 'list_tools'
export const REGISTER_TOOL = 'register_tool'
export const RUN_TOOL = 'run_tool'
export const ROLLBACK_TOOL = 'rollback_tool'
export const PROMOTE_TOOL = 'promote_tool'
export const GIT_STATUS = 'git_status'
export const GIT_DIFF = 'git_diff'
export const GIT_LOG = 'git_log'
export const EXPLORE = 'explore'
export const SUBAGENT = 'subagent'
export const USE_SKILL = 'use_skill'
export const CREATE_SKILL = 'create_skill'
export const CREATE_MCP_SERVER = 'create_mcp_server'
export const REMEMBER = 'remember'
export const UPDATE_PLAN = 'update_plan'
export const ADD_TODO = 'add_todo'
export const SCHEDULE_TASK = 'schedule_task'
export const PROPOSE_SELF_UPDATE = 'propose_self_update'
export const LEARNING_RESEARCH = 'learning_research'
export const LEARNING_LOG = 'learning_log'

export const RUN_SHELL_DESCRIPTION =
  'Run one non-interactive shell command line inside the workspace. Supports pipes, redirects, chaining and environment variables, unlike run_command. Because an unsandboxed shell can reach outside the workspace, every unsandboxed call requires explicit approval even in auto mode. When the user has enabled the OS sandbox and it is available, the command runs with the workspace writable, the rest of the filesystem read-only, and network controlled by settings. Prefer run_command for simple program invocations. Never start long-lived or interactive processes (servers, REPLs, watch modes, headless browsers, app previews) here, with or without a trailing `&`: a background child can hold the output pipe open and stall the run until the timeout. Use start_process for those. Every call has a 120000 ms default timeout (max 600000 ms); give network probes their own deadline, such as `curl --max-time 5`.'

export const DRIVE_STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    do: {
      type: 'string',
      enum: [
        'evaluate',
        'click',
        'type',
        'press',
        'wait',
        'screenshot',
        'console',
        'assertText',
        'assertValue',
        'http',
        'cli',
        'uia',
        'adb',
        'tool',
      ],
    },
    description: { type: 'string', description: 'What this step checks or does; shown in the report.' },
    selector: { type: 'string', description: 'CSS selector (cdp) or element selector.' },
    nth: { type: 'number', description: 'Zero-based selector match index.' },
    text: { type: 'string', description: 'Text to type, or text to assert.' },
    clear: { type: 'boolean', description: 'cdp type: replace the current value.' },
    key: { type: 'string', description: 'cdp press: Enter, Tab, Escape, Arrow*, etc.' },
    expression: { type: 'string', description: 'cdp evaluate expression, or a wait condition.' },
    timeoutMs: { type: 'number', description: 'Per-step timeout in milliseconds.' },
    durationMs: { type: 'number', description: 'cdp console listen duration.' },
    label: { type: 'string', description: 'screenshot label used in the file name.' },
    method: { type: 'string', description: 'http method, default GET.' },
    url: { type: 'string', description: 'http url; defaults to the url hint.' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    body: { type: 'string', description: 'http request body.' },
    expectStatus: { type: 'number', description: 'http expected status code.' },
    expectBody: { type: 'string', description: 'http body must contain this text.' },
    expectText: { type: 'string', description: 'Expected text for assert/tool/cli steps.' },
    command: { type: 'string', description: 'cli: program to run.' },
    args: { type: 'array', items: { type: 'string' }, description: 'cli arguments.' },
    expectExit: { type: 'number', description: 'cli expected exit code, default 0.' },
    expectOutput: { type: 'string', description: 'cli output must contain this text.' },
    tool: { type: 'string', description: 'tool: registered dynamic tool name.' },
    toolArgs: { type: 'object', description: 'tool: arguments object.' },
    uiaAction: { type: 'string', enum: ['read', 'invoke', 'setText'] },
    name: { type: 'string', description: 'uia: exact accessibility name.' },
    automationId: {
      type: 'string',
      description: 'uia: target by AutomationId (from the read output) when a control has no accessible name.',
    },
    value: { type: 'string', description: 'uia setText value, or assertValue expected value.' },
    windowTitle: { type: 'string', description: 'uia/screenshot target window title.' },
    adbAction: { type: 'string', enum: ['dump', 'tap', 'text', 'shell'] },
    x: { type: 'number', description: 'adb tap x.' },
    y: { type: 'number', description: 'adb tap y.' },
    serial: { type: 'string', description: 'adb device serial.' },
    shell: { type: 'string', description: 'adb shell command.' },
  },
  required: ['do'],
  additionalProperties: false,
}

export interface PlanUpdate {
  goal: string
  items: PlanItem[]
}

export interface ExploreRequest {
  task: string
  path?: string
  maxSteps?: number
}

export interface SubagentRequest extends ExploreRequest {
  mode: 'explore' | 'general' | 'toolsmith'
}

export interface CreateSkillRequest {
  name: string
  description: string
  whenToUse?: string
  body: string
  overwrite?: boolean
}

export interface CreatedSkill {
  name: string
  path: string
  overwritten: boolean
}

export interface CreateMcpServerRequest {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  overwrite?: boolean
  enable?: boolean
}

export interface CreatedMcpServer {
  name: string
  path: string
  servers: string[]
  overwritten: boolean
  enabled: boolean
  /** Tool names exposed by the server, empty when it exposes none or failed. */
  tools: string[]
  error?: string
}

/**
 * 对话里管理定时任务的请求。动作与渲染进程的定时面板走同一份 store 校验，
 * 所以最小间隔、"HH:mm" 规范化等规则两边完全一致。
 */
export type ScheduleTaskRequest =
  | { action: 'list' }
  | { action: 'add'; input: ScheduledTaskInput }
  | {
      action: 'update'
      taskId: string
      input: Partial<ScheduledTaskInput> & { enabled?: boolean }
    }
  | { action: 'remove'; taskId: string }

export interface ScheduleTaskResult {
  /** The task that was created or updated. */
  task?: ScheduledTask
  /** The id that was deleted, when action=remove. */
  removed?: string
  /** The session's schedule after the change, so the answer can quote it. */
  tasks: ScheduledTask[]
}

export interface ToolHost {
  root: string
  /**
   * Extra read-only roots available to a review session. Read and git tools
   * accept a `root` alias; write and exec tools are refused when this is set.
   */
  roots?: ReviewRoot[]
  /**
   * Other project workspaces the user referenced in this session. Unlike
   * `roots`, these do not restrict the tool set: the primary workspace keeps
   * every tool, and read tools merely gain aliases for the references.
   */
  referenceRoots?: ReviewRoot[]
  /** Present when run_shell must execute inside the OS sandbox. */
  sandbox?: { network: boolean } | null
  /** Windows interpreter for run_shell; `auto` detects Git Bash / WSL / cmd. */
  shellInterpreter?: ShellInterpreter
  /**
   * 自主探索学习的运行时上下文。只有用户在设置里打开学习探索时才存在；
   * 缺失表示该功能关闭，学习类工具也不会出现在工具列表里。
   */
  learning?: {
    policy: LearningPolicy
    research: (url: string) => Promise<LearningSourceRecord>
    log: (entry: {
      kind: 'task' | 'outcome'
      title?: string
      goal?: string
      sourceId?: string
      taskId?: string
      verdict?: 'approved' | 'rejected' | 'pending'
      quality?: number
      note?: string
    }) => Promise<LearningSummary>
  }
  /** False when the user disabled Shell mode; run_e2e then refuses script runners. */
  shellEnabled?: boolean
  /** Per-run manager for long-lived processes; absent in review sessions. */
  processes?: ProcessManager
  /** Registry of agent-written tools; absent in review and nested subagents. */
  toolRegistry?: {
    list(): Promise<DynamicToolInfo[]>
    register(name: string): Promise<RegisterToolResult>
    rollback(name: string, version?: unknown, scope?: unknown): Promise<RegisterToolResult>
    promote(name: string, options?: { force?: boolean }): Promise<DynamicToolInfo[]>
    run(name: string, args: Record<string, unknown>): Promise<ToolResult>
  }
  /** Capture a screenshot and return it as a ToolResult with image metadata. */
  screenshot?(request: {
    target?: 'window' | 'screen'
    windowTitle?: string
    windowId?: string
    label?: string
    maxWidth?: number
  }): Promise<ToolResult>
  /** List capturable windows with stable desktopCapturer ids. */
  listWindows?(): Promise<Array<{ id: string; title: string }>>
  /** Directory for screenshots taken through app_control. */
  screenshotDir?: string
  remember(content: string, reason?: string): Promise<{ id: string }>
  updatePlan(update: PlanUpdate): void
  /** Append texts to this session's todo list; returns the items actually added. */
  addTodos?(items: string[]): Promise<Array<{ id: string; text: string }>>
  /** Manage this session's scheduled tasks; absent outside a normal session run. */
  scheduleTasks?(request: ScheduleTaskRequest): Promise<ScheduleTaskResult>
  proposeSelfUpdate(input: {
    promptAddendum: string
    rationale: string
    scope?: 'workspace' | 'global'
    maxSteps?: number
    temperature?: number
  }): Promise<{
    version: number
    /**
     * Plain-language summary of the draft, when one could be produced. It is
     * what the user should be told; the rule text is not.
     */
    explanation?: ProfileExplanation
  }>
  explore?(request: ExploreRequest, signal: AbortSignal): Promise<string>
  subagent?(request: SubagentRequest, signal: AbortSignal): Promise<string>
  useSkill?(name: string): Promise<string | null>
  /** Create a workspace skill; the runner reloads the list so use_skill finds it. */
  createSkill?(input: CreateSkillRequest): Promise<CreatedSkill>
  /** Add a stdio MCP server config and connect it for this session. */
  createMcpServer?(input: CreateMcpServerRequest): Promise<CreatedMcpServer>
}

export const REVIEW_READ_TOOLS = new Set([
  LIST_DIRECTORY,
  PROJECT_MAP,
  READ_FILE,
  GET_FILE_INFO,
  SEARCH_FILES,
  GIT_STATUS,
  GIT_DIFF,
  GIT_LOG,
])

/** Tools a review session may execute; everything else is denied twice. */
export const REVIEW_TOOL_ALLOWLIST = new Set([...REVIEW_READ_TOOLS, UPDATE_PLAN])
