import type { RunStatus } from './types'

/**
 * What a failed run's error means for the next step. Created because the
 * recovery bar said the same sentence ("从上次中断的地方继续") for a wrong API
 * key, a network drop and an exhausted step budget, and 28% of runs ended on
 * that line with no hint about which one had happened.
 *
 * Single source of truth for the provider-failure wording as well: the agent
 * loop uses `fatalProviderText` to stop auto-continue on errors that replaying
 * cannot fix, the renderer uses the same function through `classifyRunFailure`
 * to say what to change. Two regexes would drift apart.
 */
export type RunFailureKind =
  /** Wrong key, empty balance, unavailable model: user must change a setting. */
  | 'config'
  /** The step budget ran out; the work that is left is in the plan. */
  | 'budget'
  /** Network drop, provider 5xx, timeout: retrying is reasonable. */
  | 'network'
  /** Anything else, including runs that were interrupted by the user. */
  | 'unknown'

/** Provider statuses that no amount of retrying changes. */
export const FATAL_PROVIDER_STATUS: ReadonlySet<number> = new Set([401, 402, 403])

/**
 * Wording for the same class of failures when a relay or an OpenAI-compatible
 * endpoint answers 200/400 while the account or the model id is the problem.
 * Deliberately narrow: `fetch failed`, timeouts and 429 are retryable.
 */
export const FATAL_PROVIDER_PATTERN =
  /insufficient balance|model denied|access to model|not have access to (?:the )?model|model not found|no such model|model (?:id )?does not exist|rejected the api key|invalid api key|incorrect api key|unauthorized/i

/** Network-class wording: retryable, so it must never match the fatal test. */
const RETRYABLE_PATTERN =
  /fetch failed|network|socket hang up|econnreset|econnrefused|etimedout|eai_again|enotfound|timeout|timed out|aborted|service unavailable|bad gateway|gateway timeout/i

/** The status `friendlyHttpError` writes into the text: `… failed (403): …`. */
const STATUS_IN_TEXT = /\(([1-9][0-9]{2})\)/

/**
 * True when the wording says the account, key or model id is the problem.
 * Only the first `(NNN)` counts: a long message that merely quotes some other
 * status later stays retryable, which is the safe direction.
 */
export function fatalProviderText(text: string | null | undefined): boolean {
  if (!text) return false
  if (FATAL_PROVIDER_PATTERN.test(text)) return true
  const status = Number(STATUS_IN_TEXT.exec(text)?.[1] ?? 0)
  return FATAL_PROVIDER_STATUS.has(status)
}

/**
 * Which setting a `config` failure asks the user to change. A 28%-of-runs
 * failure rate with one generic recovery line was the original complaint; the
 * bar could say *what* was wrong but not *what to do*, so the same three
 * sentences were retyped in the agent loop's notice.
 */
export type FailureAction = 'key' | 'balance' | 'model' | 'config'

/**
 * The single Chinese wording for each action. The renderer translates it
 * through `t()`; the agent loop puts it straight into the notice. Keeping one
 * table means a new provider status only has to be classified once.
 */
export const FAILURE_ACTION_TEXT: Record<FailureAction, string> = {
  key: '在设置里换一个有效的 API Key，然后继续。',
  balance: '账户余额不足，充值后再继续；重试不会改变结果。',
  model: '账号无权使用这个模型，在设置里换模型或申请权限后再继续。',
  config: '检查模型名称、API Key 与账户余额，改好后再继续。',
}

/**
 * Narrow a fatal failure to the setting to fix, or `null` when replaying may
 * still work. Only consulted for `config`-class text, so a 429 or a timeout
 * never turns into "change your API key".
 */
export function failureAction(error?: string | null): FailureAction | null {
  if (!fatalProviderText(error)) return null
  const text = error ?? ''
  const status = Number(STATUS_IN_TEXT.exec(text)?.[1] ?? 0)
  if (status === 401) return 'key'
  if (status === 402) return 'balance'
  if (status === 403) return 'model'
  if (/rejected the api key|invalid api key|incorrect api key|unauthorized/i.test(text)) {
    return 'key'
  }
  if (/insufficient balance/i.test(text)) return 'balance'
  if (/model denied|access to model|not have access to (?:the )?model/i.test(text)) return 'model'
  // 400 + "model does not exist" and anything else the fatal test caught: the
  // user still has to check the model name and the key, so give the generic fix.
  return 'config'
}

/**
 * Classify one finished run so the UI can name the cause and the action.
 *
 * Order matters: a fatal provider error is reported as `config` even when the
 * run also hit the step cap, because the cap was a consequence of retrying a
 * request that could never succeed. An explicit step-limit status outranks the
 * network test (`max_steps` runs usually end on a normal response).
 */
export function classifyRunFailure(
  status: RunStatus | null | undefined,
  error?: string | null,
): RunFailureKind {
  if (fatalProviderText(error)) return 'config'
  if (status === 'max_steps') return 'budget'
  if (status === 'failed' && error && RETRYABLE_PATTERN.test(error)) return 'network'
  return 'unknown'
}
