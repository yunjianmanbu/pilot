import type {
  AgentMessage,
  AgentToolDefinition,
  AgentUsage,
  ApprovalDecidedBy,
  RunUsageSample,
  ToolCall,
  ToolResult,
  ToolRisk,
} from '../../../shared/types'

/**
 * Per-step usage samples kept on a run record. Enough to attribute cost to a
 * step, small enough that a 200-run history stays lightweight.
 */
export const MAX_USAGE_SAMPLES = 120

export interface ModelRequest {
  messages: AgentMessage[]
  tools: AgentToolDefinition[]
  signal?: AbortSignal
  temperature?: number
  onTextDelta?: (delta: string) => void | Promise<void>
  onReasoningDelta?: (delta: string) => void | Promise<void>
}

export interface ModelResponse {
  content: string
  toolCalls: ToolCall[]
  reasoning?: string
  usage?: AgentUsage
  finishReason?: string | null
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>
}

export type ToolPolicyDecision = 'auto' | 'ask' | 'deny'

export interface ToolPolicyResult {
  decision: ToolPolicyDecision
  reason?: string
  rule?: string
}

export interface ApprovalRequest {
  call: ToolCall
  tool: AgentToolDefinition
  arguments: Record<string, unknown>
  reason?: string
  rule?: string
}

export interface ApprovalDecision {
  approved: boolean
  reason?: string
  /** 谁做的决定：用户点击、审批超时自动拒绝、运行被中断。审计日志靠它归类。 */
  decidedBy?: ApprovalDecidedBy
}

export interface ToolExecution {
  call: ToolCall
  tool: AgentToolDefinition
  signal: AbortSignal
}

export type LoopEvent =
  | { type: 'step.started'; step: number }
  | { type: 'message.started' }
  | { type: 'message.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | {
      type: 'message.completed'
      content: string
      toolCalls: ToolCall[]
      reasoning: string
      usage: AgentUsage
    }
  | { type: 'tool.call'; call: ToolCall; risk: ToolRisk }
  | {
      type: 'tool.approval_required'
      call: ToolCall
      risk: ToolRisk
      reason?: string
      rule?: string
    }
  | {
      type: 'tool.approval_resolved'
      call: ToolCall
      approved: boolean
      reason?: string
      decidedBy?: ApprovalDecidedBy
    }
  | { type: 'tool.result'; call: ToolCall; result: ToolResult }
  | { type: 'context.compacted'; droppedMessages: number; compactedResults: number; estimatedTokens: number }
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }

export type LoopStatus = 'completed' | 'cancelled' | 'max_steps' | 'token_limit' | 'failed'

export interface LoopOptions {
  model: ModelClient
  messages: AgentMessage[]
  tools: AgentToolDefinition[]
  maxSteps?: number
  /** Cumulative prompt+completion token budget; 0 disables. */
  maxTokens?: number
  /** Per-call prompt budget; 0 disables context fitting. */
  maxContextTokens?: number
  keepRecentToolResults?: number
  maxToolOutputChars?: number
  temperature?: number
  signal?: AbortSignal
  emit?: (event: LoopEvent) => void | Promise<void>
  pullMessages?: () => Promise<AgentMessage[]>
  policy?: (
    tool: AgentToolDefinition,
    call: ToolCall,
  ) => ToolPolicyDecision | ToolPolicyResult | Promise<ToolPolicyDecision | ToolPolicyResult>
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  executeTool: (execution: ToolExecution) => Promise<ToolResult>
  /**
   * Require a plan before the first mutating call. The gate is soft: it blocks
   * at most one call and tells the model to call update_plan, then retries are
   * allowed even if the model decides a plan is unnecessary.
   */
  requirePlan?: boolean
  /** Tool name that creates/updates the plan. Defaults to `update_plan`. */
  planToolName?: string
  /** A plan carried over from an earlier run counts as already planned. */
  hasPlan?: boolean
  /**
   * Late-bound tool list, called at the start of every step. Used when a run
   * can gain tools while it is in progress (for example MCP tools after the
   * agent adds a server); the model sees the new definitions on its next step.
   */
  pullTools?: () => AgentToolDefinition[] | Promise<AgentToolDefinition[]>
  /** Inject a plan-check reminder after this many steps without a plan update. 0 disables. */
  planReminderEvery?: number
  /**
   * Step at which to ask the model to stop investigating and answer with what
   * it has. Used for read-only analysis, where an over-long search is worse
   * than an honest answer with explicit gaps. 0 disables.
   */
  wrapUpAt?: number
  /**
   * Ask once for a budget wrap-up shortly before the step cap: finish the
   * current verification, then report 已完成 / 未完成 / 下一步. Unlike `wrapUpAt`
   * (read-only analysis: stop searching and answer), this is for normal work and
   * turns a hard `max_steps` stop into a planned close. Default off.
   */
  budgetWrapUp?: boolean
  /** Run independent read-only calls concurrently, capped at this size (default 4). */
  maxParallelReadTools?: number
  /**
   * Attach screenshots returned by a tool to the model as image observations.
   * Default true; off for endpoints that reject image content parts.
   */
  screenshotFeedback?: boolean
  /** Ask once for a verification command when files changed but no check ran. */
  verificationGate?: boolean
  /** Concrete check commands suggested by the verification gate. */
  verificationHint?: string
  /**
   * Workspace root, used to name the project's own entry points when a command
   * fails with "not found". Without it the hint stays off; the failure itself
   * is never altered either way.
   */
  workspaceRoot?: string
  /**
   * Inject an in-run reflection prompt after this many failed tool calls
   * (default 2). 0 disables it.
   */
  reflectionAfterFailures?: number
  /** Maximum in-run reflection prompts per run (default 2). */
  maxReflections?: number
  /**
   * Mention the toolsmith workflow once when repeated failures suggest a
   * reusable capability is missing. Disabled for review and subagent runs.
   */
  toolsmith?: boolean
  /**
   * Stop re-executing a read-only tool call that already failed this many
   * times with the same name and arguments (default 2). 0 disables the guard.
   * Exec and write calls are exempt so legitimate re-runs still work.
   */
  maxRepeatedFailures?: number
  /**
   * Optional summary callback used by higher layers for model-written
   * compaction. Receives the transcript plus the previous summary (if this run
   * already compacted once) so the new summary can merge instead of replacing.
   * The third argument is how the callback reports what the summarizer itself
   * billed: that request is a real model call and must count against the run's
   * token budget instead of being invisible.
   */
  summarize?: (
    messages: AgentMessage[],
    previousSummary?: string,
    onUsage?: (usage: AgentUsage) => void,
  ) => Promise<string | null>
  /** Fraction of the context budget that triggers summarization (default 0.75). */
  contextSummaryThreshold?: number
  /** Optional pre-tool hook. A blocked outcome prevents execution. */
  preTool?: (
    call: ToolCall,
    tool: AgentToolDefinition,
  ) => Promise<{ blocked?: boolean; output?: string } | void>
  /** Optional post-edit hook; output is appended to the tool result. */
  postEdit?: (
    call: ToolCall,
    tool: AgentToolDefinition,
    result: ToolResult,
  ) => Promise<string | null | void>
}

export interface AgentTimings {
  /** Time spent inside model requests, including retries. */
  modelMs: number
  /** Sum of tool execution durations (parallel calls overlap in wall time). */
  toolMs: number
  /** Time the run waited for a human approval decision. */
  approvalMs: number
  /** Time spent writing a context summary. */
  summarizeMs: number
}

export interface LoopResult {
  status: LoopStatus
  content: string
  steps: number
  usage: AgentUsage
  /** One sample per model call, oldest first; capped at MAX_USAGE_SAMPLES. */
  usageSteps: RunUsageSample[]
  produced: AgentMessage[]
  /** Files changed through write tools, as reported by their arguments. */
  filesChanged: number
  /** True when a verification-like command succeeded after the last change. */
  checked: boolean
  timings: AgentTimings
  /**
   * Last model-written compaction summary, so the caller can persist it and
   * the next run does not have to re-derive the same conclusions from a
   * transcript whose detail is already folded away.
   */
  summary?: string
  /** Summarizer calls that returned nothing usable this run. */
  summarizeFailures: number
  error?: { code: string; message: string }
}

