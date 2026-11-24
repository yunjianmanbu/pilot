import type {
  AgentMessage,
  AgentToolDefinition,
  ApprovalMode,
  PermissionRules,
  ReviewScope,
  ToolCall,
} from '../../shared/types'
import type { PersistedSettings } from '../store-schema'
import { autonomyPolicy } from '../../shared/autonomy'
import type { ClassifierInput, ClassifierResult } from './classifier'
import type { ToolPolicyResult } from './loop'
import { evaluatePermission } from './permissions'
import { isReviewToolName } from './review'
import {
  grantCovers,
  READ_EXECUTION_RECORDS,
  READ_SYSTEM_STRATEGY,
  REQUEST_SYSTEM_ACCESS,
  systemAccessPolicy,
  type SystemAccessGrant,
} from './system-access'
import { RUN_SHELL, SUBAGENT } from './tools'

/**
 * One tool call's permission decision: mode + rules + sandbox + grants, with
 * the model classifier consulted only when the rules say "ask the classifier".
 *
 * It is kept apart from the runner because it is a pure decision over its
 * inputs: it never touches run state except through the two hooks below, and
 * every place that has to change what is allowed (deny rules, protected paths,
 * sandbox auto-allow, system-information grants) edits this file and nothing
 * else in the 2.8k-line runner.
 */
export interface ToolPolicyInput {
  tool: AgentToolDefinition
  call: ToolCall
  review: ReviewScope | null
  /** Read per call: a classifier block can switch the run to manual mid-run. */
  approvalMode: () => ApprovalMode
  systemAccess?: SystemAccessGrant
  workspacePath: string
  settings: PersistedSettings
  /** OS sandbox usable and enabled for this run (gates shell auto-allow). */
  sandboxEnabled: boolean
  learningEnabled: boolean
  classify: (query: Omit<ClassifierInput, 'client'>) => Promise<ClassifierResult>
  classifierModel: string
  /** The user's instruction for this run, given to the classifier as intent. */
  prompt: string
  transcript: () => AgentMessage[]
  signal: AbortSignal
  onClassifierAllow: () => void
  onClassifierBlock: () => { consecutive: number; total: number; pause: boolean }
  /** Escalate a run whose classifier keeps blocking: back to ask-each-call. */
  onPauseAllAuto: () => Promise<void>
}

export async function resolveToolPolicy(input: ToolPolicyInput): Promise<ToolPolicyResult> {
  const {
    tool,
    call,
    review,
    systemAccess,
    workspacePath,
    settings,
    sandboxEnabled,
    learningEnabled,
    classify,
    classifierModel,
    prompt,
    transcript,
    signal,
    onClassifierAllow,
    onClassifierBlock,
    onPauseAllAuto,
  } = input
  const approvalMode = input.approvalMode()
  // 完全自主档：设置开着、当前是全部自动、且 token/步数上限达标时才生效。
  // 没生效时 autonomy.active 为 false，下面每个放开点都退回原行为。
  const autonomy = autonomyPolicy({
    fullAutonomy: settings.fullAutonomy,
    approvalMode,
    maxTokens: settings.maxTokens,
    maxSteps: settings.maxSteps,
  })
  if (review) {
    if (!isReviewToolName(call.name) || (tool.risk !== 'read' && tool.risk !== 'control')) {
      return {
        decision: 'deny',
        reason: '复盘会话是只读的：只允许读取允许目录和会话记录，不允许写入、执行或联网。',
      }
    }
    return { decision: 'auto' }
  }
  if (
    call.name === SUBAGENT &&
    call.arguments['mode'] === 'general' &&
    approvalMode !== 'auto'
  ) {
    return {
      decision: 'deny',
      reason: '通用子智能体会在工作区内直接改文件，只允许在全部自动模式下使用。',
    }
  }
  if (call.name === REQUEST_SYSTEM_ACCESS) {
    const decision = systemAccessPolicy(
      approvalMode,
      systemAccess,
      call.arguments ?? {},
      autonomy.active,
    )
    if (decision) return decision
  }
  // 完全自主档下，自视/自检需要的数据不再逐轮申请：给本次运行一份覆盖两个 scope、
  // 跨工作区的授权，仍然是只读、仍随本次运行结束失效，但不再弹卡片。
  let grantSatisfied = false
  if (call.name === READ_EXECUTION_RECORDS || call.name === READ_SYSTEM_STRATEGY) {
    const covered =
      autonomy.autoSystemAccess ||
      grantCovers(
        systemAccess,
        [call.name === READ_EXECUTION_RECORDS ? 'execution_records' : 'system_strategy'],
        call.arguments['workspace'] === 'all',
      )
    if (!covered) {
      return {
        decision: 'deny',
        reason:
          '读取系统信息需要本次运行的授权：请先调用 request_system_access（需要全部工作区时把 workspaces 设为 all），等用户批准后再读取。',
      }
    }
    // The approval already happened for this run; do not ask again in
    // approve-each-call modes. Explicit deny rules still win below.
    grantSatisfied = true
  }
  const verdict = evaluatePermission({
    mode: approvalMode,
    tool,
    call,
    workspacePath,
    rules: settings.permissionRules as PermissionRules,
    trustedCommands: settings.trustedCommands,
    sandboxed: sandboxEnabled && tool.name === RUN_SHELL,
    sandboxAutoAllow: settings.sandboxAutoAllow,
    allowUnattendedBuild: settings.allowUnattendedBuild,
    fullAutonomy: autonomy.active,
    // 只有用户在设置里开启了 shell 隔离，学习探索才接管 shell 的外发限制。
    learningMode: learningEnabled,
    learningIsolateShell: settings.learningShellIsolation === true,
  })
  if (grantSatisfied && verdict.action === 'ask') {
    return { decision: 'auto', reason: '本次运行已获得系统信息授权。' }
  }
  if (verdict.action === 'classify') {
    const classified = await classify({
      model: classifierModel,
      tool: tool.name,
      call,
      workspacePath,
      userRequest: prompt,
      transcript: transcript(),
      signal,
    })
    if (classified.decision === 'allow') {
      onClassifierAllow()
      return {
        decision: 'auto',
        reason: classified.reason,
      }
    }
    if (classified.decision === 'deny') {
      const blocks = onClassifierBlock()
      if (blocks.pause) {
        await onPauseAllAuto()
      }
      return {
        decision: 'deny',
        reason: `权限分类器拦截：${classified.reason}`,
      }
    }
    return {
      decision: 'ask',
      reason: `权限分类器建议确认：${classified.reason}`,
    }
  }
  return {
    decision:
      verdict.action === 'allow'
        ? 'auto'
        : verdict.action === 'deny'
          ? 'deny'
          : 'ask',
    reason: verdict.reason,
    ...(verdict.rule ? { rule: verdict.rule } : {}),
  }
}
