/**
 * 产出质量评分：指标集、权重动态调优、候选版本与现行版本的优劣判定。
 *
 * 设计约束：
 * - 指标值有两个来源：历史运行记录（确定性统计）和配置的评估模型（只给 reviewScore
 *   与文字结论）。这样分数可复现，模型的判断不会直接改写通过率这类客观事实。
 * - 权重是整数，总和恒为 100，单项限定在 [MIN_WEIGHT, MAX_WEIGHT]。任何来自模型或
 *   旧存储的权重都会经过 `normalizeMetricSet` → `balanceWeights` 归一，所以一次坏提议
 *   不可能让某个维度吃掉全部分数，也不可能让总分变成 0。
 * - 调优是规则化的，每次改动都带一句理由，UI 与提示可以直接展示，避免"权重自己变了"
 *   这种不可解释的行为。
 */
import type {
  QualityCandidate,
  QualityCandidateStatus,
  QualityPublishTarget,
  QualityState,
  RunRecord,
} from './types'

export type QualityMetricId =
  | 'passRate'
  | 'verification'
  | 'toolHealth'
  | 'efficiency'
  | 'satisfaction'
  | 'reviewScore'

export interface QualityMetric {
  id: QualityMetricId
  label: string
  /** Integer share of the total score. */
  weight: number
  /** `records` = computed from run history, `model` = scored by an evaluation model. */
  source: 'records' | 'model'
}

export interface QualityMetricSet {
  version: number
  metrics: QualityMetric[]
  tunedAt?: string
  /** One line per weight change, so a tuned set is never unexplained. */
  notes: string[]
}

export interface QualityScore {
  total: number
  metrics: Array<{ id: QualityMetricId; label: string; weight: number; value: number }>
  /** Metric ids that had no measurement at all; they are excluded from the total. */
  missing: QualityMetricId[]
  at: string
  metricVersion: number
}

export interface QualityComparison {
  better: boolean
  delta: number
  regressions: QualityMetricId[]
  reason: string
}

export const QUALITY_METRIC_LIMITS = {
  weight: { min: 5, max: 40 },
  total: 100,
  /** A candidate must beat the baseline by this much to count as better. */
  minDelta: 3,
  /** A single metric may not drop more than this, however good the total is. */
  maxRegression: 8,
} as const

export const DEFAULT_QUALITY_METRICS: QualityMetric[] = [
  { id: 'passRate', label: '通过率', weight: 25, source: 'records' },
  { id: 'verification', label: '验证覆盖', weight: 20, source: 'records' },
  { id: 'toolHealth', label: '工具健康', weight: 15, source: 'records' },
  { id: 'satisfaction', label: '用户满意', weight: 15, source: 'records' },
  { id: 'reviewScore', label: '评审分', weight: 15, source: 'model' },
  { id: 'efficiency', label: '步数效率', weight: 10, source: 'records' },
]

const DEFAULT_LABELS = new Map<QualityMetricId, string>(
  DEFAULT_QUALITY_METRICS.map((metric) => [metric.id, metric.label]),
)
const DEFAULT_SOURCE = new Map<QualityMetricId, 'records' | 'model'>(
  DEFAULT_QUALITY_METRICS.map((metric) => [metric.id, metric.source]),
)

export function isQualityMetricId(value: unknown): value is QualityMetricId {
  return typeof value === 'string' && DEFAULT_LABELS.has(value as QualityMetricId)
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 把任意整数权重配平成"总和 100、单项受限"的整数分布。
 *
 * 用逐个单位的配额填充而不是等比缩放取整：后者在某个权重特别大时会超出上限，
 * 再截断就会让总和不再是 100（分数区间不再是 0-100，比较阈值全部失真）。
 * 先整体限幅，再按权重大小轮流 +1/-1 直到凑满，最后微调最大项吃掉舍入余量。
 */
export function balanceWeights(inputs: number[]): number[] {
  const { min, max } = QUALITY_METRIC_LIMITS.weight
  const total = QUALITY_METRIC_LIMITS.total
  if (inputs.length === 0) return []
  // 未测量的指标也应保留最小值，避免 0 权重维度被永久钉死。
  let weights = inputs.map((value) => clampInt(value, min, max))

  const reachableMax = weights.length * max
  const reachableMin = weights.length * min
  if (total > reachableMax) {
    return weights.map(() => max)
  }
  if (total < reachableMin) {
    return weights.map(() => min)
  }

  const order = weights
    .map((weight, index) => ({ weight, index }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index)
    .map((entry) => entry.index)

  let guard = 0
  while (guard < total * 2) {
    const sum = weights.reduce((acc, value) => acc + value, 0)
    if (sum === total) break
    const step = sum < total ? 1 : -1
    const candidates = order.filter((index) => {
      const value = weights[index]!
      return step > 0 ? value < max : value > min
    })
    if (candidates.length === 0) break
    for (const index of candidates) {
      const sumNow = weights.reduce((acc, value) => acc + value, 0)
      if (sumNow === total) break
      const current = weights[index]!
      const next = current + step
      if (next > max || next < min) continue
      weights[index] = next
    }
    guard += 1
  }

  // 剩余个位数用最大项吸收，保持总和恒定。
  let sum = weights.reduce((acc, value) => acc + value, 0)
  let cursor = 0
  while (sum !== total && cursor < order.length * (max - min + 1) * 2) {
    const index = order[cursor % order.length]!
    const next = weights[index]! + (sum < total ? 1 : -1)
    if (next <= max && next >= min) {
      weights[index] = next
      sum += sum < total ? 1 : -1
    }
    cursor += 1
  }
  return weights
}

/** 归一化权重并排序成稳定顺序（默认指标顺序在前，未知指标丢弃）。 */
export function normalizeMetrics(
  inputs: Array<{ id: unknown; weight: unknown; label?: unknown }>,
): QualityMetric[] {
  const seen = new Set<QualityMetricId>()
  const picked: QualityMetric[] = []
  for (const input of inputs) {
    if (!isQualityMetricId(input.id)) continue
    if (seen.has(input.id)) continue
    seen.add(input.id)
    const metric: QualityMetric = {
      id: input.id,
      label: DEFAULT_LABELS.get(input.id)!,
      weight: clampInt(
        typeof input.weight === 'number' ? input.weight : 0,
        QUALITY_METRIC_LIMITS.weight.min,
        QUALITY_METRIC_LIMITS.weight.max,
      ),
      source: DEFAULT_SOURCE.get(input.id)!,
    }
    picked.push(metric)
  }
  if (picked.length === 0) picked.push(...DEFAULT_QUALITY_METRICS.map((metric) => ({ ...metric })))

  // 未知指标丢弃后，把缺失的默认指标补回来并给最小权重，保证六维全覆盖。
  for (const fallback of DEFAULT_QUALITY_METRICS) {
    if (seen.has(fallback.id)) continue
    seen.add(fallback.id)
    picked.push({ ...fallback, weight: QUALITY_METRIC_LIMITS.weight.min })
  }

  const balanced = balanceWeights(picked.map((metric) => metric.weight))
  const byId = new Map(picked.map((metric) => [metric.id, metric]))
  return DEFAULT_QUALITY_METRICS.map((fallback) => {
    const metric = byId.get(fallback.id)!
    const index = picked.findIndex((entry) => entry.id === fallback.id)
    return { ...metric, weight: balanced[index] ?? metric.weight }
  })
}

export function defaultMetricSet(): QualityMetricSet {
  return {
    version: 1,
    metrics: DEFAULT_QUALITY_METRICS.map((metric) => ({ ...metric })),
    notes: [],
  }
}

/** 接受任意持久化/模型输入，产出合法指标集。 */
export function normalizeMetricSet(
  input: unknown,
  fallback: QualityMetricSet = defaultMetricSet(),
): QualityMetricSet {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback
  const record = input as Record<string, unknown>
  const raw = Array.isArray(record['metrics']) ? (record['metrics'] as unknown[]) : []
  const metrics = normalizeMetrics(
    raw
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({ id: entry['id'], weight: entry['weight'], label: entry['label'] })),
  )
  const version = clampInt(
    typeof record['version'] === 'number' ? record['version'] : fallback.version,
    1,
    999,
  )
  const notes = Array.isArray(record['notes'])
    ? record['notes']
        .filter((note): note is string => typeof note === 'string')
        .map((note) => note.replace(/\s+/g, ' ').trim().slice(0, 160))
        .filter(Boolean)
        .slice(-8)
    : []
  const tunedAt = typeof record['tunedAt'] === 'string' ? record['tunedAt'] : undefined
  return { version, metrics, notes, ...(tunedAt ? { tunedAt } : {}) }
}

function clampScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, value))
}

/** 加权总分。缺失指标的权重按比例分摊到已有指标，而不是按 0 分计入。 */
export function scoreMetrics(
  set: QualityMetricSet,
  values: Partial<Record<QualityMetricId, number | null | undefined>>,
  at: string = new Date().toISOString(),
): QualityScore {
  const parts: QualityScore['metrics'] = []
  const missing: QualityMetricId[] = []
  for (const metric of set.metrics) {
    const value = clampScore(values[metric.id])
    if (value === null) {
      missing.push(metric.id)
      continue
    }
    parts.push({ id: metric.id, label: metric.label, weight: metric.weight, value })
  }
  const weight = parts.reduce((acc, part) => acc + part.weight, 0)
  const total =
    weight === 0
      ? 0
      : Math.round(
          (parts.reduce((acc, part) => acc + part.value * part.weight, 0) / weight) * 10,
        ) / 10
  return { total, metrics: parts, missing, at, metricVersion: set.version }
}

/** 从运行记录算确定性指标。只有评审分由模型给出，所以这里不包含 reviewScore。 */
export interface QualitySignals {
  values: Partial<Record<QualityMetricId, number | null>>
  samples: Partial<Record<QualityMetricId, number>>
  runs: number
  failures: number
}

export function signalsFromRuns(runs: RunRecord[], opts: { targetSteps?: number } = {}): QualitySignals {
  const targetSteps = Math.max(4, opts.targetSteps ?? 12)
  const usable = runs.filter((run) => run.status !== 'cancelled')
  const finished = usable.filter(
    (run) => run.status !== 'running' && run.status !== 'paused',
  )
  const completed = finished.filter((run) => run.status === 'completed')
  const values: QualitySignals['values'] = {}
  const samples: QualitySignals['samples'] = {}

  if (finished.length > 0) {
    values.passRate = (completed.length / finished.length) * 100
    samples.passRate = finished.length
  }

  const changing = completed.filter((run) => (run.filesChanged ?? 0) > 0)
  if (changing.length > 0) {
    const verified = changing.filter((run) => run.checked === true).length
    values.verification = (verified / changing.length) * 100
    samples.verification = changing.length
  }

  const toolCalls = usable.reduce((acc, run) => acc + run.toolCalls, 0)
  if (toolCalls > 0) {
    const errors = usable.reduce((acc, run) => acc + run.toolErrors, 0)
    values.toolHealth = Math.max(0, 1 - errors / toolCalls) * 100
    samples.toolHealth = toolCalls
  }

  const rated = completed.filter((run) => run.feedback)
  if (rated.length > 0) {
    const positive = rated.filter((run) => run.feedback?.rating === 'up').length
    values.satisfaction = (positive / rated.length) * 100
    samples.satisfaction = rated.length
  }

  if (completed.length > 0) {
    const avgSteps =
      completed.reduce((acc, run) => acc + Math.max(1, run.steps), 0) / completed.length
    values.efficiency = Math.min(100, (targetSteps / Math.max(1, avgSteps)) * 100)
    samples.efficiency = completed.length
  }

  return {
    values,
    samples,
    runs: finished.length,
    failures: finished.length - completed.length,
  }
}

export interface TuneResult {
  set: QualityMetricSet
  changes: string[]
}

/**
 * 动态调优权重。规则刻意简单且单向：
 * - 分数偏低（<60）的维度加权，因为它是当前的质量瓶颈；
 * - 分数稳定偏好（>=85）的维度减权，把注意力让给瓶颈；
 * - 样本不足（<3）的维度压到最小权重，避免用两三条记录决定分数；
 * - 每次改动都写一句理由，并由 `balanceWeights` 收口到总和 100。
 */
export function tuneMetricSet(
  set: QualityMetricSet,
  signals: QualitySignals,
  now: string = new Date().toISOString(),
): TuneResult {
  const changes: string[] = []
  const next = set.metrics.map((metric) => {
    const value = signals.values[metric.id]
    const samples = signals.samples[metric.id] ?? 0
    let weight = metric.weight
    let reason = ''
    if (typeof value !== 'number') {
      // 从未测量：不参与打分，权重在归一后钉到最小值。
      reason = `${metric.label}暂无测量，权重固定为最小`
    } else if (samples < 3) {
      if (weight > QUALITY_METRIC_LIMITS.weight.min) {
        weight = Math.max(QUALITY_METRIC_LIMITS.weight.min, weight - 2)
        reason = `${metric.label}样本仅 ${samples} 条，权重降至 ${weight}`
      }
    } else if (value < 60) {
      weight = Math.min(QUALITY_METRIC_LIMITS.weight.max, weight + 4)
      reason = `${metric.label}为 ${Math.round(value)} 分（<60），加权至 ${weight}`
    } else if (value >= 85) {
      weight = Math.max(QUALITY_METRIC_LIMITS.weight.min, weight - 3)
      reason = `${metric.label}已稳定在 ${Math.round(value)} 分，减权至 ${weight}`
    }
    if (reason) changes.push(reason)
    return { ...metric, weight }
  })

  if (changes.length === 0) return { set, changes }

  const balanced = balanceWeights(next.map((metric) => metric.weight))
  let metrics = next.map((metric, index) => ({ ...metric, weight: balanced[index]! }))

  // 归一化会把减下来的权重再分回去，所以未测量的维度要在归一后再钉一次：
  // 把它多出来的份额逐个转给已测量维度（按权重从大到小，受上限约束）。
  const unpinned = metrics.filter((metric) => typeof signals.values[metric.id] === 'number')
  if (unpinned.length > 0) {
    let excess = 0
    metrics = metrics.map((metric) => {
      if (typeof signals.values[metric.id] === 'number') return metric
      excess += metric.weight - QUALITY_METRIC_LIMITS.weight.min
      return { ...metric, weight: QUALITY_METRIC_LIMITS.weight.min }
    })
    const donors = unpinned
      .map((metric) => metrics.find((entry) => entry.id === metric.id)!)
      .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
    let cursor = 0
    let guard = 0
    while (excess > 0 && guard < QUALITY_METRIC_LIMITS.total * 2) {
      const donor = donors[cursor % donors.length]!
      if (donor.weight < QUALITY_METRIC_LIMITS.weight.max) {
        donor.weight += 1
        excess -= 1
      }
      cursor += 1
      guard += 1
    }
  }

  return {
    set: {
      version: set.version + 1,
      metrics,
      tunedAt: now,
      notes: [...set.notes, ...changes].slice(-8),
    },
    changes,
  }
}

/** 候选版本与现行版本比较。没有基线时只记录，不宣称更优。 */
export function compareQuality(
  baseline: QualityScore | null,
  candidate: QualityScore,
  opts: { minDelta?: number; maxRegression?: number } = {},
): QualityComparison {
  const minDelta = opts.minDelta ?? QUALITY_METRIC_LIMITS.minDelta
  const maxRegression = opts.maxRegression ?? QUALITY_METRIC_LIMITS.maxRegression
  if (!baseline) {
    return {
      better: false,
      delta: 0,
      regressions: [],
      reason: `无基线分数，本次 ${candidate.total} 分作为基线记录`,
    }
  }
  const before = new Map(baseline.metrics.map((metric) => [metric.id, metric]))
  const regressions: QualityMetricId[] = []
  const drops: string[] = []
  for (const metric of candidate.metrics) {
    const previous = before.get(metric.id)
    if (!previous) continue
    const drop = previous.value - metric.value
    if (drop > maxRegression) {
      regressions.push(metric.id)
      drops.push(`${metric.label} ${Math.round(previous.value)}→${Math.round(metric.value)}`)
    }
  }
  const delta = Math.round((candidate.total - baseline.total) * 10) / 10
  if (regressions.length > 0) {
    return {
      better: false,
      delta,
      regressions,
      reason: `总分变化 ${delta >= 0 ? '+' : ''}${delta}，但${drops.join('、')} 回退超过 ${maxRegression} 分`,
    }
  }
  if (delta < minDelta) {
    return {
      better: false,
      delta,
      regressions,
      reason: `总分 ${candidate.total} vs 基线 ${baseline.total}，提升 ${delta} 未达 ${minDelta} 分阈值`,
    }
  }
  return {
    better: true,
    delta,
    regressions,
    reason: `总分 ${baseline.total} → ${candidate.total}（+${delta}），且没有单项回退超过 ${maxRegression} 分`,
  }
}

/** 给系统提示用的一小段指标摘要（学习模式据此挑任务）。 */
export function qualityPromptBlock(
  set: QualityMetricSet,
  baseline: QualityScore | null,
  pending: number,
): string {
  const lines = [`- 当前指标集 v${set.version}（权重总和 100）：`]
  for (const metric of set.metrics) {
    const measured = baseline?.metrics.find((entry) => entry.id === metric.id)
    lines.push(
      `  - ${metric.label}（权重 ${metric.weight}）：${
        measured ? `${Math.round(measured.value)} 分` : '暂无测量'
      }`,
    )
  }
  lines.push(
    `- 现行版本质量分：${baseline ? `${baseline.total} 分` : '尚未建立基线'}；待授权候选：${pending} 个`,
  )
  if (baseline) {
    const weakest = [...baseline.metrics].sort((left, right) => left.value - right.value)[0]
    if (weakest && weakest.value < 70) {
      lines.push(`- 最弱项是「${weakest.label}」（${Math.round(weakest.value)} 分），探索任务应优先针对它取证与改进。`)
    }
  }
  if (set.notes.length > 0) lines.push(`- 最近一次权重调优：${set.notes.slice(-1)[0]}`)
  return lines.join('\n')
}

export const QUALITY_PUBLISH_TARGETS: QualityPublishTarget[] = [
  'none',
  'package:dir',
  'package:win',
  'package:mac',
  'package:linux',
]

/** 发布目标只接受白名单值；未知/被篡改的值一律回落 `none`（不发布）。 */
export function normalizeQualityPublishTarget(value: unknown): QualityPublishTarget {
  return typeof value === 'string' && (QUALITY_PUBLISH_TARGETS as string[]).includes(value)
    ? (value as QualityPublishTarget)
    : 'none'
}

const CANDIDATE_STATUSES: QualityCandidateStatus[] = [
  'recorded',
  'awaiting_user',
  'approved',
  'rejected',
  'publishing',
  'published',
  'failed',
]

function sanitizeScore(input: unknown): QualityScore | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const total = typeof record['total'] === 'number' && Number.isFinite(record['total'])
    ? Math.min(100, Math.max(0, record['total']))
    : null
  if (total === null) return null
  const metrics = Array.isArray(record['metrics'])
    ? (record['metrics'] as unknown[])
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null
          const item = entry as Record<string, unknown>
          if (!isQualityMetricId(item['id'])) return null
          const value = clampScore(item['value'])
          if (value === null) return null
          const weight = clampInt(
            typeof item['weight'] === 'number' ? item['weight'] : 0,
            QUALITY_METRIC_LIMITS.weight.min,
            QUALITY_METRIC_LIMITS.weight.max,
          )
          return {
            id: item['id'],
            label: DEFAULT_LABELS.get(item['id'])!,
            weight,
            value,
          }
        })
        .filter((entry): entry is QualityScore['metrics'][number] => Boolean(entry))
    : []
  if (metrics.length === 0) return null
  return {
    total,
    metrics,
    missing: [],
    at: typeof record['at'] === 'string' ? record['at'] : new Date().toISOString(),
    metricVersion:
      typeof record['metricVersion'] === 'number' ? Math.max(1, Math.round(record['metricVersion'])) : 1,
  }
}

/** 丢弃一个损坏或旧格式的候选，而不是让整个面板报错。 */
export function sanitizeCandidate(input: unknown): QualityCandidate | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['workspacePath'] !== 'string') return null
  const score = sanitizeScore(record['score'])
  if (!score) return null
  const status =
    typeof record['status'] === 'string' && (CANDIDATE_STATUSES as string[]).includes(record['status'])
      ? (record['status'] as QualityCandidateStatus)
      : 'recorded'
  const comparisonRaw =
    record['comparison'] && typeof record['comparison'] === 'object'
      ? (record['comparison'] as Record<string, unknown>)
      : {}
  const evidenceRaw =
    record['evidence'] && typeof record['evidence'] === 'object'
      ? (record['evidence'] as Record<string, unknown>)
      : {}
  return {
    id: record['id'],
    workspacePath: record['workspacePath'],
    version: typeof record['version'] === 'number' ? Math.max(1, Math.round(record['version'])) : 1,
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date().toISOString(),
    metricVersion: score.metricVersion,
    score,
    baseline: sanitizeScore(record['baseline']),
    comparison: {
      better: comparisonRaw['better'] === true,
      delta:
        typeof comparisonRaw['delta'] === 'number' && Number.isFinite(comparisonRaw['delta'])
          ? comparisonRaw['delta']
          : 0,
      regressions: Array.isArray(comparisonRaw['regressions'])
        ? (comparisonRaw['regressions'] as unknown[]).filter(isQualityMetricId)
        : [],
      reason: typeof comparisonRaw['reason'] === 'string' ? comparisonRaw['reason'].slice(0, 400) : '',
    },
    verdict: typeof record['verdict'] === 'string' ? record['verdict'].slice(0, 2_000) : '',
    evidence: {
      runs: typeof evidenceRaw['runs'] === 'number' ? evidenceRaw['runs'] : 0,
      failures: typeof evidenceRaw['failures'] === 'number' ? evidenceRaw['failures'] : 0,
      source: typeof evidenceRaw['source'] === 'string' ? evidenceRaw['source'].slice(0, 40) : 'records',
      samples: {},
    },
    status,
    ...(typeof record['decidedAt'] === 'string' ? { decidedAt: record['decidedAt'] } : {}),
    ...(typeof record['publishTarget'] === 'string'
      ? { publishTarget: record['publishTarget'].slice(0, 40) }
      : {}),
    ...(typeof record['publishedAt'] === 'string' ? { publishedAt: record['publishedAt'] } : {}),
    log: Array.isArray(record['log'])
      ? (record['log'] as unknown[])
          .filter((line): line is string => typeof line === 'string')
          .map((line) => line.slice(0, 300))
          .slice(-40)
      : [],
    ...(typeof record['failure'] === 'string' ? { failure: record['failure'].slice(0, 500) } : {}),
  }
}

export function emptyQualityState(): QualityState {
  return { metricSet: defaultMetricSet(), baseline: null, candidates: [] }
}

/** 存储层入口：任何旧/坏数据都得到合法的质量状态。 */
export function sanitizeQualityState(input: unknown): QualityState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptyQualityState()
  const record = input as Record<string, unknown>
  const candidates = Array.isArray(record['candidates'])
    ? (record['candidates'] as unknown[])
        .map(sanitizeCandidate)
        .filter((entry): entry is QualityCandidate => Boolean(entry))
        .slice(0, 40)
    : []
  return {
    metricSet: normalizeMetricSet(record['metricSet']),
    baseline: sanitizeScore(record['baseline']),
    candidates,
  }
}

/** 质量角标数：需要用户做决定的候选数（现已由顶栏三点菜单的产出质量项承载）。 */
export function bellCount(state: QualityState): number {
  return state.candidates.filter(
    (candidate) => candidate.status === 'awaiting_user' || candidate.status === 'approved',
  ).length
}
