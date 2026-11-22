import type {
  EvolutionCycle,
  EvolutionPolicy,
  ProfileEvidence,
  ProfileExplanation,
  ProfileStrategy,
  RunRecord,
  Session,
} from '../../../shared/types'
import { isUserTaskTurn } from '../context'

const MAX_EVIDENCE_RUNS = 40

export function scrub(text: string, limit: number): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/**
 * Compact, secret-scrubbed digest of failed tool calls. Reflection is grounded
 * in the actual error text instead of a vague "toolErrors: N" count.
 */
export function formatToolFailures(
  messages: Array<{ role: string; name?: string; content: string; isError?: boolean }>,
  limit = 8,
): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'tool' || !message.isError) continue
    const detail = scrub(message.content.replace(/^ERROR:\s*/i, ''), 240)
    lines.push(`${message.name || 'tool'} → ${detail || '(no error text)'}`)
  }
  if (lines.length === 0) return '(none)'
  return lines
    .slice(-limit)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n')
}

export function runEvidence(run: RunRecord, index: number): string {
  const parts = [
    `${index + 1}. [${run.status}] ${scrub(run.prompt, 220) || '(no prompt)'}`,
    `steps=${run.steps}`,
    `tokens=${run.totalTokens}`,
    `tools=${run.toolCalls}`,
    `toolErrors=${run.toolErrors}`,
    `changed=${run.filesChanged ?? 0}`,
    `checked=${run.checked === true ? 'yes' : 'no'}`,
  ]
  if (run.feedback) {
    parts.push(`feedback=${run.feedback.rating}${run.feedback.note ? `(${scrub(run.feedback.note, 200)})` : ''}`)
  }
  if (run.error) parts.push(`error=${scrub(run.error, 200)}`)
  return parts.join(' | ')
}

export function evidenceText(runs: RunRecord[]): string {
  if (runs.length === 0) return '(no runs yet)'
  return runs.slice(0, MAX_EVIDENCE_RUNS).map(runEvidence).join('\n')
}

export function normalizeStrategy(value: Record<string, unknown>): ProfileStrategy {
  const strategy: ProfileStrategy = {}
  if (typeof value['maxSteps'] === 'number' && value['maxSteps'] >= 20 && value['maxSteps'] <= 500) {
    strategy.maxSteps = Math.round(value['maxSteps'])
  }
  if (
    typeof value['temperature'] === 'number' &&
    value['temperature'] >= 0 &&
    value['temperature'] <= 1
  ) {
    strategy.temperature = Math.round(value['temperature'] * 100) / 100
  }
  return strategy
}

/**
 * Lenient reader for the model's plain-language fields. Returns undefined when
 * the essentials are missing so callers can fall back to a generated summary
 * instead of showing half a card.
 */
export function parseExplanation(value: unknown, model: string): ProfileExplanation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const headline = typeof record['headline'] === 'string' ? record['headline'].trim() : ''
  const impact = typeof record['impact'] === 'string' ? record['impact'].trim() : ''
  if (!headline || !impact) return undefined
  const list = (input: unknown, cap: number): string[] =>
    Array.isArray(input)
      ? input
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, cap)
      : []
  return {
    headline: headline.slice(0, 300),
    changes: list(record['changes'], 8).map((item) => item.slice(0, 400)),
    impact: impact.slice(0, 600),
    risks: list(record['risks'], 6).map((item) => item.slice(0, 400)),
    recommend: record['recommend'] === 'observe' ? 'observe' : 'enable',
    reason: typeof record['reason'] === 'string' ? record['reason'].trim().slice(0, 600) : '',
    model,
    at: new Date().toISOString(),
  }
}

export function policyForPrompt(policy: EvolutionPolicy): string {
  return JSON.stringify({
    autoApply: policy.autoApply,
    minRuns: policy.minRuns,
    reviewScore: policy.reviewScore,
    cooldownRuns: policy.cooldownRuns,
    evidenceRuns: policy.evidenceRuns,
    watchRuns: policy.watchRuns,
    regressionDelta: policy.regressionDelta,
    metaEvery: policy.metaEvery,
    focus: policy.focus,
  })
}

export function isFailedRun(run: RunRecord): boolean {
  return run.status === 'failed' || run.status === 'interrupted' || run.status === 'max_steps'
}

export function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

export function cycleSummary(cycles: EvolutionCycle[]): string {
  if (cycles.length === 0) return '(no cycles yet)'
  const completed = cycles.filter((cycle) => cycle.status === 'completed').length
  const rejected = cycles.filter((cycle) => cycle.status === 'rejected').length
  const failed = cycles.filter((cycle) => cycle.status === 'failed').length
  const activated = cycles.filter((cycle) => cycle.activated).length
  const rollbacks = cycles.filter((cycle) => cycle.trigger === 'watch').length
  const scores = cycles
    .map((cycle) => cycle.score)
    .filter((score): score is number => typeof score === 'number')
  const avgScore = scores.length
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : 'n/a'
  return `cycles=${cycles.length}, completed=${completed}, rejected=${rejected}, failed=${failed}, activated=${activated}, autoRollbacks=${rollbacks}, avgReviewScore=${avgScore}`
}

export function recentCycleLines(cycles: EvolutionCycle[], limit = 8): string {
  if (cycles.length === 0) return '(none)'
  return cycles
    .slice(0, limit)
    .map((cycle) => {
      const score = typeof cycle.score === 'number' ? `score=${cycle.score}` : 'score=n/a'
      return `- [${cycle.trigger}/${cycle.status}] ${score}, activated=${cycle.activated}, ${scrub(cycle.summary, 240)}`
    })
    .join('\n')
}

export function hasChinese(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x3400 && code <= 0x9fff) return true
  }
  return false
}

export function reflectionTranscript(session: Session): string {
  const parts: string[] = []
  for (const message of session.messages) {
    if (message.role === 'user') {
      // The loop writes continuation prompts, run reminders and turn digests
      // as user turns. Reflecting on them as `USER:` teaches the profile that
      // Pilot asked itself to do things, so they are labelled separately.
      if (!message.content.trim()) continue
      if (isUserTaskTurn(message)) parts.push(`USER: ${scrub(message.content, 1_500)}`)
      else parts.push(`INTERNAL: ${scrub(message.content, 500)}`)
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.trim()) parts.push(`ASSISTANT: ${scrub(message.content, 2_000)}`)
      for (const call of message.toolCalls ?? []) {
        const args = scrub(JSON.stringify(call.arguments ?? {}), 300)
        parts.push(`TOOL CALL ${call.name} ${args}`)
      }
      continue
    }
    if (message.role === 'tool') {
      const status = message.isError ? 'ERROR' : 'OK'
      parts.push(`TOOL ${message.name ?? ''} ${status}: ${scrub(message.content, 600)}`)
    }
  }
  return parts.join('\n')
}

export function evidenceSummary(evidence: ProfileEvidence): string {
  return `${evidence.runs} runs · ${evidence.failures} failures · ${evidence.verified ?? 0} verified · ${evidence.avgSteps} avg steps · ${evidence.avgTokens} avg tokens · +${evidence.positive}/-${evidence.negative} feedback`
}
