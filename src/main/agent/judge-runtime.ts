/**
 * Watchdog for evaluation-model requests.
 *
 * Qwen3.8-Max and GLM-5.3 stream a long reasoning phase before the short JSON
 * verdict. A fixed total timeout treats that thinking as a hang and throws the
 * verdict away even though the model is still working. The watchdog therefore
 * measures *silence*: as long as the endpoint keeps streaming text or
 * reasoning, the request may continue, up to an absolute ceiling that still
 * protects a review from a truly dead connection.
 */
import type { AgentUsage, JudgeUsage } from '../../shared/types'
import type { ModelClient, ModelRequest, ModelResponse } from './loop'

/** No new characters for this long means the endpoint has stalled. */
export const JUDGE_IDLE_TIMEOUT_MS = 120_000

/**
 * A reasoning model may queue before its first token. This first-token grace is
 * longer than the idle window, so a cold start is not mistaken for a hang.
 */
export const JUDGE_FIRST_TOKEN_TIMEOUT_MS = 240_000

/** Absolute ceiling: one endpoint that keeps dribbling text cannot run forever. */
export const JUDGE_TOTAL_TIMEOUT_MS = 600_000

export interface JudgeWatchdog {
  idleMs?: number
  firstTokenMs?: number
  totalMs?: number
}

function seconds(ms: number): number {
  return Math.round(ms / 1_000)
}

/**
 * Explain why a response could not be parsed. Thinking tokens are separate
 * from `content`, so "empty content with reasoning" is a different failure
 * from a malformed object and needs a different message.
 */
export function unparsedResponseReason(response: ModelResponse): string {
  const content = response.content.trim()
  const reasoning = (response.reasoning ?? '').trim()
  if (response.finishReason === 'length') {
    return content
      ? 'JSON 在输出上限处被截断'
      : `思考占满了输出上限，没有留下 JSON（思考 ${reasoning.length} 字）`
  }
  if (!content) {
    return reasoning
      ? `只返回了思考内容，没有给出 JSON 结论（思考 ${reasoning.length} 字）`
      : '返回内容为空'
  }
  return '返回内容里没有可解析的 JSON'
}

/**
 * Run one completion with an inactivity watchdog. Deltas from either channel
 * count as activity, and an external abort signal is forwarded so cancelling
 * the review also stops the HTTP request.
 */
export async function completeWithWatchdog(
  client: ModelClient,
  request: ModelRequest,
  watchdog: JudgeWatchdog = {},
): Promise<ModelResponse> {
  const idleMs = Math.max(1_000, watchdog.idleMs ?? JUDGE_IDLE_TIMEOUT_MS)
  const firstTokenMs = Math.max(idleMs, watchdog.firstTokenMs ?? JUDGE_FIRST_TOKEN_TIMEOUT_MS)
  const totalMs = Math.max(firstTokenMs, watchdog.totalMs ?? JUDGE_TOTAL_TIMEOUT_MS)

  const controller = new AbortController()
  const external = request.signal
  const forwardAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', forwardAbort, { once: true })
  }

  const startedAt = Date.now()
  let lastActivity = startedAt
  let sawActivity = false
  let stoppedReason = ''

  const timer = setInterval(() => {
    if (controller.signal.aborted) return
    const now = Date.now()
    if (now - startedAt >= totalMs) {
      stoppedReason = `本次评估超过 ${seconds(totalMs)} 秒`
      controller.abort()
      return
    }
    const limit = sawActivity ? idleMs : firstTokenMs
    if (now - lastActivity >= limit) {
      stoppedReason = `超过 ${seconds(limit)} 秒没有收到新内容`
      controller.abort()
    }
  }, 1_000)
  // A pending watchdog must not keep the process alive on shutdown.
  timer.unref?.()

  const touch = (): void => {
    sawActivity = true
    lastActivity = Date.now()
  }

  try {
    return await client.complete({
      ...request,
      signal: controller.signal,
      onTextDelta: async (delta) => {
        touch()
        await request.onTextDelta?.(delta)
      },
      onReasoningDelta: async (delta) => {
        touch()
        await request.onReasoningDelta?.(delta)
      },
    })
  } catch (error) {
    if (stoppedReason) throw new Error(`${stoppedReason}，已停止等待`)
    throw error
  } finally {
    clearInterval(timer)
    external?.removeEventListener('abort', forwardAbort)
  }
}

/** A zeroed accumulator, so a caller always reports numbers instead of `undefined`. */
export function emptyJudgeUsage(): JudgeUsage {
  return { input: 0, output: 0, cacheHit: 0, calls: 0 }
}

/**
 * Fold one judge response's reported usage into `target`.
 *
 * `calls` counts the request even when the endpoint streams no usage block, so
 * a silent provider reads as "N requests, 0 counted tokens" instead of looking
 * like it was never consulted. Mutates and returns `target`; safe to call from
 * parallel judge requests because the fold is synchronous between awaits.
 */
export function addJudgeUsage(target: JudgeUsage, usage: AgentUsage | undefined): JudgeUsage {
  target.calls += 1
  if (!usage) return target
  target.input += usage.promptTokens ?? 0
  target.output += usage.completionTokens ?? 0
  target.cacheHit += usage.cacheHitTokens ?? 0
  return target
}

/**
 * Restore a persisted usage block. Numbers are clamped to non-negative
 * integers so a hand-edited store cannot show a negative bill; a block with no
 * calls at all is dropped rather than recorded as free.
 */
export function sanitizeJudgeUsage(value: unknown): JudgeUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const pick = (key: string): number => {
    const number = raw[key]
    return typeof number === 'number' && Number.isFinite(number) && number > 0
      ? Math.min(Math.round(number), 1_000_000_000)
      : 0
  }
  const calls = pick('calls')
  if (calls === 0) return undefined
  return { input: pick('input'), output: pick('output'), cacheHit: pick('cacheHit'), calls }
}
