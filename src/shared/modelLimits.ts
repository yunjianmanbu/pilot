/**
 * Per-model context and output ceilings.
 *
 * Mirrors the budget maths of the retired Manbu Agent platform (its
 * `agent-runner.service.ts`, removed from this workspace): the transcript
 * budget is derived from the model's own window minus a safety margin and a
 * reserve for the completion, and a subagent is capped at half the window
 * because it re-sends its transcript on every step. The settings value is the
 * user's ask; the effective budget is
 * that ask capped by the model ceiling, so an oversized request becomes a
 * smaller prompt instead of a hard 400.
 *
 * This module must stay dependency-free and live in `src/shared`: the renderer
 * settings dialog imports the same table, and renderer code must never pull in
 * main-process (Node-only) modules.
 */
export interface ModelLimits {
  contextTokens: number
  outputTokens: number
}

/** Claude Opus / Sonnet (1M context, 64K output). */
export const CLAUDE_LIMITS: ModelLimits = { contextTokens: 1_000_000, outputTokens: 64_000 }

/** Unknown OpenAI-compatible endpoint: assume the common 200K / 8K envelope. */
export const FALLBACK_LIMITS: ModelLimits = { contextTokens: 200_000, outputTokens: 8_192 }

/** Prompt headroom kept for tokenizer drift and provider-side preambles. */
export const CONTEXT_SAFETY_TOKENS = 8_000

/** Headroom kept for the completion, which shares the same window. */
export const OUTPUT_RESERVE_TOKENS = 4_000

/** Never size a prompt below this: one turn still needs to fit. */
export const MIN_CONTEXT_TOKENS = 4_000

/** Subagents never go below this, otherwise they stop mid-read. */
export const MIN_SUBAGENT_CONTEXT_TOKENS = 8_000

/**
 * Bounds accepted for the persisted setting. These are the widest values any
 * supported model can take, not a per-model ceiling: the per-model clamp runs at
 * the request boundary (`effectiveContextTokens` / `effectiveOutputTokens`) so
 * an existing setting keeps working after the model is switched.
 */
export const SETTING_CONTEXT_MIN = 8_000
export const SETTING_CONTEXT_MAX = 1_000_000
export const SETTING_OUTPUT_MIN = 512
export const SETTING_OUTPUT_MAX = 64_000

/** Fresh-install defaults: the widest window, clamped per model at request time. */
export const DEFAULT_CONTEXT_TOKENS = SETTING_CONTEXT_MAX
export const DEFAULT_OUTPUT_TOKENS = 8_192

const MODEL_TABLE: ReadonlyArray<{ pattern: RegExp; limits: ModelLimits }> = [
  { pattern: /claude|anthropic/i, limits: CLAUDE_LIMITS },
  { pattern: /gemini/i, limits: { contextTokens: 1_000_000, outputTokens: 32_000 } },
  { pattern: /gpt-5|gpt-4\.1|gpt-4o|o3|o4/i, limits: { contextTokens: 1_000_000, outputTokens: 32_000 } },
  // deepseek-reasoner accepts a much larger completion than deepseek-chat.
  { pattern: /deepseek-(reasoner|r1)/i, limits: { contextTokens: 128_000, outputTokens: 64_000 } },
  { pattern: /deepseek/i, limits: { contextTokens: 128_000, outputTokens: 8_192 } },
  // Qwen3.8-Max and GLM-5.3 both expose a 1M window with a large completion
  // budget. Keep the completion cap conservative so a thinking model cannot
  // spend the whole answer budget on reasoning.
  { pattern: /qwen|glm/i, limits: { contextTokens: 1_000_000, outputTokens: 32_000 } },
]

export function modelLimits(model: string | null | undefined): ModelLimits {
  const name = (model ?? '').trim()
  if (!name) return FALLBACK_LIMITS
  for (const entry of MODEL_TABLE) {
    if (entry.pattern.test(name)) return entry.limits
  }
  return FALLBACK_LIMITS
}

/**
 * Largest prompt the model can take: its window minus the completion reserve
 * and the safety margin.
 */
export function contextCeiling(model: string | null | undefined): number {
  const window = modelLimits(model).contextTokens
  return Math.max(MIN_CONTEXT_TOKENS, window - CONTEXT_SAFETY_TOKENS - OUTPUT_RESERVE_TOKENS)
}

/**
 * Prompt budget for a run: the configured ask, capped by the model ceiling and
 * floored at a value that still leaves room for one turn.
 */
export function effectiveContextTokens(
  configured: number,
  model: string | null | undefined,
): number {
  const ceiling = contextCeiling(model)
  if (!Number.isFinite(configured) || configured <= 0) return ceiling
  return Math.max(MIN_CONTEXT_TOKENS, Math.min(Math.round(configured), ceiling))
}

/**
 * Prompt budget for a subagent: bounded readers get half the window (capped by
 * the main budget) so a parallel investigation stays cheaper than the main run.
 */
export function subagentContextTokens(
  configured: number,
  model: string | null | undefined,
): number {
  const halfWindow = Math.floor(modelLimits(model).contextTokens * 0.5)
  return Math.max(
    MIN_SUBAGENT_CONTEXT_TOKENS,
    Math.min(effectiveContextTokens(configured, model), halfWindow),
  )
}

/**
 * `max_tokens` for a completion. Zero keeps the existing "omit the field and
 * let the provider pick its default" behaviour.
 */
export function effectiveOutputTokens(
  configured: number,
  model: string | null | undefined,
): number {
  if (!Number.isFinite(configured) || configured <= 0) return 0
  return Math.max(256, Math.min(Math.round(configured), modelLimits(model).outputTokens))
}
