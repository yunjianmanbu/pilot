/**
 * Token pricing and cost estimation for the model the saved key belongs to.
 *
 * The provider reports the authoritative *balance* over HTTP (see
 * `main/billing.ts`); it does not expose per-key spend, so the cost of local
 * runs is estimated here from the token counts Pilot already records on every
 * `RunRecord`.
 *
 * Prices are US dollars per one million tokens at the provider's **peak**
 * rate. DeepSeek halves every rate outside peak hours, and each run carries the
 * time it started, so a run is priced at the rate that applied when it ran.
 *
 * This module must stay dependency-free and live in `src/shared`: the renderer
 * imports the same table, and renderer code must never pull in main-process
 * (Node-only) modules.
 */

import type { AgentUsage, ModelUsageRow, ModelUsageSummary } from './types'

/** USD per 1M tokens at peak rate. */
export interface ModelPrice {
  /** Prompt tokens served from the context cache. */
  cacheHit: number
  /** Prompt tokens that missed the cache. */
  cacheMiss: number
  /** Completion (output) tokens. */
  output: number
}

/** Where the numbers below came from, so the UI can label the estimate. */
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing'

/** Date the table was transcribed from the provider's pricing page. */
export const PRICE_UPDATED_AT = '2026-11-13'

/**
 * Reference rate (CNY per USD) used only to *display* the estimate in RMB.
 *
 * The provider bills in US dollars and the price table above stays in dollars,
 * so this rate never touches the recorded numbers: it is a pinned constant, not
 * a live feed, because the app must show the same figure offline and the
 * estimate is already labelled as approximate. Refresh it together with the
 * price table.
 */
export const USD_CNY_RATE = 7.1

/** Currency to show the cost estimate in: USD for English, RMB otherwise. */
export type CostCurrency = 'CNY' | 'USD'

/**
 * Only English gets dollars: any other or unknown value (including the default
 * Chinese UI) shows yuan, so a missing locale never silently switches currency.
 */
export function costCurrencyFor(locale: string | null | undefined): CostCurrency {
  return String(locale ?? '').trim().toLowerCase().startsWith('en') ? 'USD' : 'CNY'
}

/** Convert a USD estimate into the display currency (null stays null). */
export function convertCost(
  usd: number | null,
  currency: CostCurrency = 'CNY',
): number | null {
  if (usd === null || !Number.isFinite(usd)) return null
  return currency === 'CNY' ? usd * USD_CNY_RATE : usd
}

/**
 * Money text for an estimate: `¥0.00852`, `$0.00432`, `¥3.20`; `—` when the
 * model has no price entry. Cents stay visible for tiny amounts, and whole
 * units are rounded to two decimals in both currencies.
 */
export function formatCostAmount(
  usd: number | null,
  currency: CostCurrency = 'CNY',
): string {
  const value = convertCost(usd, currency)
  const symbol = currency === 'CNY' ? '¥' : '$'
  if (value === null) return '—'
  if (value === 0) return `${symbol}0`
  const abs = Math.abs(value)
  if (abs < 0.01) return `${symbol}${value.toFixed(5)}`
  if (abs < 1) return `${symbol}${value.toFixed(4)}`
  return `${symbol}${value.toFixed(2)}`
}

/**
 * Peak windows, in UTC, from the pricing page footnote: Monday through Friday
 * 01:00-04:00 and 06:00-10:00, excluding Chinese public holidays (which the
 * estimate treats as peak — it can only round the other way).
 */
const PEAK_WINDOWS: Array<[number, number]> = [
  [1, 4],
  [6, 10],
]

const FLASH: ModelPrice = { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
const PRO: ModelPrice = { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }

/**
 * Model name (lower-cased) to price. Legacy names are listed because the
 * provider's changelog states which current model each one now serves, and
 * that model's price applies to the request.
 */
const PRICES: Record<string, ModelPrice> = {
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-flash-vision-exp': FLASH,
  // deepseek-chat / deepseek-reasoner are the non-thinking / thinking modes of
  // V4-Flash, per the provider's model changelog.
  'deepseek-chat': FLASH,
  'deepseek-reasoner': FLASH,
  'deepseek-v4-pro': PRO,
  'deepseek-v4-pro-preview': PRO,
}

export function priceForModel(model: string | null | undefined): ModelPrice | null {
  const key = (model ?? '').trim().toLowerCase()
  if (!key) return null
  return PRICES[key] ?? null
}

/** True inside a peak window, when the provider charges the full rate. */
export function isPeakTime(at: Date): boolean {
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/** Peak rate multiplier for a moment in time (off-peak is half price). */
export function rateMultiplier(at: Date): number {
  return isPeakTime(at) ? 1 : 0.5
}

export interface UsageTokens {
  promptTokens: number
  completionTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/**
 * Prompt tokens split by billing rate. Records written before Pilot tracked
 * the cache split are billed entirely at the miss rate, which is the
 * conservative (higher) reading of the same usage.
 */
export function cacheSplit(usage: UsageTokens): { hit: number; miss: number } {
  const prompt = Math.max(0, usage.promptTokens || 0)
  const hit = Math.max(0, usage.cacheHitTokens || 0)
  if (usage.cacheMissTokens === undefined && hit === 0) return { hit: 0, miss: prompt }
  const miss =
    usage.cacheMissTokens === undefined
      ? Math.max(0, prompt - hit)
      : Math.max(0, usage.cacheMissTokens)
  return { hit, miss }
}

/** Cost of one run in USD, or null when the model has no price entry. */
export function costOfUsage(
  model: string | null | undefined,
  usage: UsageTokens,
  at: Date,
): number | null {
  const price = priceForModel(model)
  if (!price) return null
  const { hit, miss } = cacheSplit(usage)
  const multiplier = rateMultiplier(at)
  const cost =
    (hit * price.cacheHit +
      miss * price.cacheMiss +
      Math.max(0, usage.completionTokens || 0) * price.output) /
    1_000_000
  return cost * multiplier
}

/** A run as far as billing is concerned: token counts, model and start time. */
export interface BillingRun {
  model?: string
  startedAt: string
  promptTokens: number
  completionTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/**
 * Aggregate runs per model. Runs without a recorded model (written before
 * 0.1.30) are grouped under an empty name so the caller can label them.
 */
export function summarizeUsage(runs: BillingRun[]): ModelUsageSummary {
  const rows = new Map<string, ModelUsageRow>()
  for (const run of runs) {
    const model = (run.model ?? '').trim()
    const key = model.toLowerCase()
    const row =
      rows.get(key) ??
      ({
        model,
        runs: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        estimatedCostUsd: null,
      } satisfies ModelUsageRow)
    const split = cacheSplit(run)
    row.runs += 1
    row.promptTokens += Math.max(0, run.promptTokens || 0)
    row.completionTokens += Math.max(0, run.completionTokens || 0)
    row.cacheHitTokens += split.hit
    row.cacheMissTokens += split.miss
    const cost = costOfUsage(model, run, new Date(run.startedAt))
    if (cost !== null) row.estimatedCostUsd = (row.estimatedCostUsd ?? 0) + cost
    rows.set(key, row)
  }

  const ordered = [...rows.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens))
  const summary: ModelUsageSummary = {
    rows: ordered,
    runs: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    estimatedCostUsd: ordered.some((row) => row.estimatedCostUsd !== null) ? 0 : null,
    unpricedModels: [],
  }
  for (const row of ordered) {
    summary.runs += row.runs
    summary.promptTokens += row.promptTokens
    summary.completionTokens += row.completionTokens
    summary.cacheHitTokens += row.cacheHitTokens
    summary.cacheMissTokens += row.cacheMissTokens
    if (row.estimatedCostUsd === null) summary.unpricedModels.push(row.model)
    else if (summary.estimatedCostUsd !== null) summary.estimatedCostUsd += row.estimatedCostUsd
  }
  return summary
}

/** Total tokens an agent loop reported, including the cache split. */
export function withCacheUsage(usage: AgentUsage | undefined): UsageTokens {
  return {
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    cacheHitTokens: usage?.cacheHitTokens,
    cacheMissTokens: usage?.cacheMissTokens,
  }
}
